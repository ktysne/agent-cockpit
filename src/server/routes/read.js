const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { SECURITY_HEADERS, jsonResponse, textResponse, escapeHtmlAttribute } = require('../http-helpers');
const { APP_NAME } = require('../server-constants');
const { codexAgentScriptPaths } = require('../identity');

const STATE_CACHE_MAX_AGE_MS = 30_000;
const UI_VERSION_CHECK_INTERVAL_MS = 5_000;
const INTEGRATION_CHECK_INTERVAL_MS = 10_000;

function createReadRoutes(ctx) {
  const { state, away, routing, dev, claudeHome, userHome, pullRequestTracker, codexAgentScriptExists, crossReviewToolExists, webPath, perf } = ctx;
  let cachedUiFileStamp = null;
  let uiVersion = null;
  const bootId = crypto.randomUUID();
  let generation = 0;
  let cachedState = null;
  const nowMs = ctx.stateCacheNow || Date.now;

  function externalCache(load, ttlMs) {
    let value;
    let expiresAt = 0;
    let version;
    let pending = null;
    // 確認中に版が進んでも待ち直さない。進んだ版は指紋に入るので、次の取得で確認し直す。
    return async () => {
      if (pending) return pending;
      if (nowMs() < expiresAt && version === state.version) return value;
      const startedVersion = state.version;
      pending = (async () => {
        value = await load();
        version = startedVersion;
        expiresAt = nowMs() + ttlMs;
        return value;
      })().finally(() => { pending = null; });
      return pending;
    };
  }

  async function currentUiVersion() {
    try {
      const stat = await fs.stat(webPath);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stamp !== cachedUiFileStamp) {
        const content = await fs.readFile(webPath);
        uiVersion = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
        cachedUiFileStamp = stamp;
      }
    } catch {}
    return uiVersion;
  }

  const checkUiVersion = externalCache(currentUiVersion, UI_VERSION_CHECK_INTERVAL_MS);
  let integrations = { codexAgent: false, crossReview: false };
  const checkIntegrations = externalCache(async () => {
    let codexAgent = false;
    for (const scriptPath of codexAgentScriptPaths(claudeHome, userHome)) {
      if (await codexAgentScriptExists(scriptPath) === true) {
        codexAgent = true;
        break;
      }
    }
    let crossReview = false;
    for (const cwd of state.knownCwds()) {
      if (await crossReviewToolExists(cwd) === true) {
        crossReview = true;
        break;
      }
    }
    integrations = { codexAgent, crossReview };
    return integrations;
  }, INTEGRATION_CHECK_INTERVAL_MS);

  function fingerprint() {
    return JSON.stringify([state.version, pullRequestTracker?.inFlightSignature?.() || '',
      away.snapshot(), routing.snapshot(), ctx.updateChecker?.snapshot() || null, uiVersion, integrations]);
  }

  function generateState(now) {
    const deadline = { at: Infinity, propose(ms) { if (ms > now) this.at = Math.min(this.at, ms); } };
    const snapshot = state.snapshot();
    const pullRequests = pullRequestTracker?.snapshot(deadline) || [];
    const awayState = away.snapshot(deadline);
    const sinceSeen = state.snapshotSinceSeen(snapshot.sessions, pullRequests, now, awayState.periods, deadline);
    // 既読の初期化が版を進めるため、本文と指紋の版は生成後に確定する。
    snapshot.version = state.version;
    snapshot.generatedAt = state.generatedAt;
    const sessions = snapshot.sessions.map((session) => {
      const seenAt = session.product && sinceSeen.seenAtByProduct[session.product.key];
      const seenMilliseconds = Date.parse(seenAt || '');
      return {
        ...session,
        decisions: session.decisions.map((decision) => ({
          ...decision,
          isNew: Number.isFinite(seenMilliseconds) && Date.parse(decision.createdAt) > seenMilliseconds,
        })),
      };
    });
    return { body: JSON.stringify({ ...snapshot, sessions, pullRequests, sinceSeen: sinceSeen.sinceSeen,
      away: awayState, update: ctx.updateChecker?.snapshot() || null, appVersion: ctx.appVersion,
      routing: routing.snapshot(), integrations, uiVersion }), fingerprint: fingerprint(),
      expiresAt: Math.min(deadline.at, now + STATE_CACHE_MAX_AGE_MS) };
  }

  function handleHealth({ response, info }) {
    jsonResponse(response, 200, { app: APP_NAME, pid: info.pid, startedAt: info.startedAt });
  }

  async function handleState({ request, response }) {
    await Promise.all([checkUiVersion(), checkIntegrations()]);
    await away.prune?.([...state.seenAtByProduct.values()], nowMs());
    const now = nowMs();
    let reusable = cachedState && cachedState.fingerprint === fingerprint() && now < cachedState.expiresAt;
    let generated;
    if (reusable && process.env.AGENT_COCKPIT_VERIFY_STATE_CACHE === '1') {
      generated = generateState(now);
      if (generated.body !== cachedState.body) {
        void ctx.diagnostics?.record('warn', 'server', 'state.cache.mismatch', {
          etag: cachedState.etag, version: state.version,
        });
        reusable = false;
      }
    }
    if (reusable) perf?.count('stateCacheHit');
    else cachedState = { ...(generated || generateState(now)), etag: `"${bootId}-${++generation}"` };
    const unchanged = request.headers['if-none-match'] === cachedState.etag;
    response.writeHead(unchanged ? 304 : 200, {
      ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', etag: cachedState.etag,
    });
    response.end(unchanged ? undefined : cachedState.body);
  }

  function handleTrayState({ response }) {
    const snapshot = state.snapshot();
    const permissionKeys = [];
    const decisionKeys = [];
    for (const session of snapshot.sessions) {
      for (const wait of session.permissionWaits) {
        permissionKeys.push(`${session.session_id}|${wait.agent_id}|${wait.startedAt}`);
      }
      for (const decision of session.decisions) {
        const hasEffectiveAnswer = decision.answer?.sentAt && !decision.answer.ignoredAt;
        if (decision.state === 'waiting' && !hasEffectiveAnswer) {
          decisionKeys.push(`${session.session_id}|${decision.id}`);
        }
      }
    }
    jsonResponse(response, 200, {
      permissionKeys,
      decisionKeys,
      awayEnabled: away.snapshot().enabled === true,
    });
  }

  function handleContext({ response, params }) {
    jsonResponse(response, 200, {
      ...away.snapshot(), ...state.planSummary(params[1]), importAppTasks: state.getDisplayPreferences().importAppTasks,
    });
  }

  function handleDevFields({ response }) {
    if (!dev) {
      textResponse(response, 404, 'Not Found');
      return;
    }
    jsonResponse(response, 200, state.devFields());
  }

  async function handleIndex({ request, response, info }) {
    try {
      let beforeStat = null;
      try {
        beforeStat = await fs.stat(webPath);
      } catch {}
      const content = await fs.readFile(webPath);
      let afterStat = null;
      try {
        afterStat = await fs.stat(webPath);
      } catch {}
      uiVersion = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
      const sameFile = beforeStat && afterStat && beforeStat.mtimeMs === afterStat.mtimeMs && beforeStat.size === afterStat.size && content.length === afterStat.size;
      cachedUiFileStamp = sameFile ? `${afterStat.mtimeMs}:${afterStat.size}` : null;
      const template = content.toString('utf8');
      const html = template.replace(
        '<meta name="cockpit-secret" content="">',
        `<meta name="cockpit-secret" content="${escapeHtmlAttribute(info.uiSecret)}">`,
      ).replace(
        '<meta name="cockpit-ui-version" content="">',
        `<meta name="cockpit-ui-version" content="${uiVersion}">`,
      );
      textResponse(response, 200, html, 'text/html; charset=utf-8');
    } catch (error) {
      request?.setDiagnosticError?.(error);
      textResponse(response, 500, 'Dashboard unavailable');
    }
  }

  const measuredHandleState = perf ? (request) => perf.measureAsync('state', () => handleState(request)) : handleState;
  return { handleHealth, handleState: measuredHandleState, handleTrayState, handleContext, handleDevFields, handleIndex };
}

module.exports = { createReadRoutes };
