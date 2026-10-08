const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { jsonResponse, textResponse, escapeHtmlAttribute } = require('../http-helpers');
const { APP_NAME } = require('../server-constants');
const { codexAgentScriptPaths } = require('../identity');

function createReadRoutes(ctx) {
  const { state, away, routing, dev, claudeHome, userHome, pullRequestTracker, codexAgentScriptExists, crossReviewToolExists, webPath } = ctx;
  let cachedUiFileStamp = null;
  let uiVersion = null;

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

  function handleHealth({ response, info }) {
    jsonResponse(response, 200, { app: APP_NAME, pid: info.pid, startedAt: info.startedAt });
  }

  async function handleState({ response }) {
    const snapshot = state.snapshot();
    const pullRequests = pullRequestTracker?.snapshot() || [];
    const now = Date.now();
    const awayState = away.snapshot();
    const sinceSeen = state.snapshotSinceSeen(snapshot.sessions, pullRequests, now, awayState.periods);
    // 版と時刻は中身と同じ同期処理の中で確定する。後で待つと、待つ間の更新の版が古い中身に付く。
    snapshot.version = state.version;
    snapshot.generatedAt = state.generatedAt;
    void away.prune?.([...state.seenAtByProduct.values()], now);
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
    const uiVersion = await currentUiVersion();
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
    jsonResponse(response, 200, { ...snapshot, sessions, pullRequests, sinceSeen: sinceSeen.sinceSeen, away: away.snapshot(), routing: routing.snapshot(), integrations: { codexAgent, crossReview }, uiVersion });
  }

  function handleContext({ response, params }) {
    jsonResponse(response, 200, { ...away.snapshot(), ...state.planSummary(params[1]) });
  }

  function handleDevFields({ response }) {
    if (!dev) {
      textResponse(response, 404, 'Not Found');
      return;
    }
    jsonResponse(response, 200, state.devFields());
  }

  async function handleIndex({ response, info }) {
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
    } catch {
      textResponse(response, 500, 'Dashboard unavailable');
    }
  }

  return { handleHealth, handleState, handleContext, handleDevFields, handleIndex };
}

module.exports = { createReadRoutes };
