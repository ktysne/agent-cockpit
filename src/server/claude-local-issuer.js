'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProviderRegistrationAdapter } = require('./provider-registration');
const { listLiveSessionFiles } = require('./session-files');

const EVIDENCE_SOURCE = 'claude-local-lineage';
const EVIDENCE_METHOD = 'declared-ppid-session-file';
const EVIDENCE_CAPABILITIES = Object.freeze(['declared-lineage']);
const MCP_CONTEXT_PREFIX = 'claude-mcp:';
const HOOK_CONTEXT_ID = 'claude-hooks';

const REASON_PARENT_UNVERIFIED = 'claude_parent_unverified';
const REASON_SESSION_MISMATCH = 'claude_session_mismatch';
const REASON_SESSIONS_UNREADABLE = 'claude_sessions_unreadable';
const REASON_REGISTRATION_FAILED = 'claude_registration_failed';
const REASON_CONTEXT_INVALID = 'claude_context_invalid';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function safeAgentId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function homeScopeSource(claudeHome) {
  try {
    return fs.realpathSync.native(claudeHome);
  } catch {
    return path.resolve(claudeHome);
  }
}

function copyWriter(writer) {
  return { token: writer.token, identity: { ...writer.identity }, contextId: writer.contextId, executionId: writer.executionId };
}

function rejection(reason) {
  return { ok: false, reason };
}

/**
 * 申告された親プロセスの pid を Claude のセッションファイルと照合し、登録核の期間と writer を発行する。
 * 証拠は認証ではなく、同じ利用者の範囲での偶発的な取り違えを防ぐためのものである。
 */
function createClaudeLocalIssuer({
  registry,
  authority,
  claudeHome,
  listSessionFiles = listLiveSessionFiles,
  hostname = os.hostname,
  log = () => {},
} = {}) {
  if (!registry || !authority || typeof claudeHome !== 'string' || claudeHome.length === 0) {
    throw new TypeError('claude local issuer requires a registry, an authority, and a Claude home');
  }
  const adapter = createProviderRegistrationAdapter('claude', registry, authority);
  const hostId = sha256Hex(String(typeof hostname === 'function' ? hostname() : hostname));

  // 鍵は親の Claude の (pid, procStart)。pid が再利用されても procStart が変わるので別の期間になる。
  const periods = new Map();
  const seenIdentities = new Set();
  const endedStartCounts = new Map();
  // 一覧の読み始めの通し番号。期間の作成より前に読み始めた一覧は、その期間の不在の証拠にしない。
  let listingSeq = 0;

  function periodKey(file) {
    return JSON.stringify([file.pid, file.procStart]);
  }

  function endPeriod(key, why) {
    const period = periods.get(key);
    if (!period) return;
    periods.delete(key);
    endedStartCounts.set(period.startBase, period.startCount + 1);
    authority.end(period.executionId);
    log(`claude period ended: ${why} pid=${period.pid}`);
  }

  function applyListing(files, seq) {
    for (const [key, period] of [...periods]) {
      if (seq <= period.createdAfterSeq) continue;
      const file = files.find((item) => item.pid === period.pid && item.procStart === period.procStart);
      if (!file) endPeriod(key, 'process gone');
      else if (file.session_id !== period.nativeId) endPeriod(key, 'session changed');
    }
  }

  function createPeriod(file) {
    const nativeIdentity = {
      nativeIdKind: 'session',
      hostId,
      homeScopeId: sha256Hex(homeScopeSource(claudeHome)),
      nativeId: file.session_id,
    };
    const identityKey = JSON.stringify(nativeIdentity);
    const startBase = sha256Hex(JSON.stringify([file.pid, file.procStart, file.session_id]));
    const startCount = endedStartCounts.get(startBase) || 0;
    const startId = startCount === 0 ? startBase : sha256Hex(`${startBase}:${startCount}`);
    const evidence = {
      evidenceId: `${EVIDENCE_SOURCE}:${startId}`,
      source: EVIDENCE_SOURCE,
      method: EVIDENCE_METHOD,
      capabilities: [...EVIDENCE_CAPABILITIES],
    };
    const register = (resume) => adapter.register(nativeIdentity, evidence, {
      startId,
      resume,
      ...(resume ? {} : { projectionId: file.session_id }),
    });
    let resume = seenIdentities.has(identityKey);
    let registration;
    try {
      try {
        registration = register(resume);
      } catch (error) {
        if (resume || error?.code !== 'resume_required') throw error;
        resume = true;
        registration = register(true);
      }
    } catch (error) {
      log(`claude registration failed: ${typeof error?.code === 'string' ? error.code : 'error'}`);
      return null;
    }
    seenIdentities.add(identityKey);
    const period = {
      pid: file.pid,
      procStart: file.procStart,
      nativeId: file.session_id,
      identity: { provider: 'claude', ...nativeIdentity },
      conversationId: registration.conversationId,
      executionId: registration.executionId,
      projectionId: registration.sessionId,
      startBase,
      startCount,
      createdAfterSeq: listingSeq,
      hookWriter: null,
    };
    periods.set(periodKey(file), period);
    return period;
  }

  // 親が条件に合うときだけ、その期間(未登録なら登録して)を返す。
  // 既存の期間より前に読み始めた一覧がセッションの変更を示しても、古い一覧とみなして期間を終えない。
  async function resolvePeriod(ppid, expectedSessionId, canRetry = true) {
    if (!isPositiveInteger(ppid)) return rejection(REASON_PARENT_UNVERIFIED);
    const seq = ++listingSeq;
    let files;
    try {
      files = await listSessionFiles(claudeHome);
    } catch {
      files = null;
    }
    if (!Array.isArray(files)) return rejection(REASON_SESSIONS_UNREADABLE);
    applyListing(files, seq);
    const matches = files.filter((file) => file.pid === ppid);
    const file = matches.length === 1 ? matches[0] : null;
    if (!file || typeof file.session_id !== 'string' || file.session_id.length === 0 ||
        typeof file.procStart !== 'string' || file.procStart.length === 0) {
      return rejection(REASON_PARENT_UNVERIFIED);
    }
    if (expectedSessionId !== undefined && expectedSessionId !== file.session_id) {
      return rejection(REASON_SESSION_MISMATCH);
    }
    let period = periods.get(periodKey(file));
    if (period && period.nativeId !== file.session_id) {
      if (seq <= period.createdAfterSeq) {
        return canRetry ? resolvePeriod(ppid, expectedSessionId, false) : rejection(REASON_SESSION_MISMATCH);
      }
      endPeriod(periodKey(file), 'session changed');
      period = null;
    }
    if (!period) period = createPeriod(file);
    if (!period) return rejection(REASON_REGISTRATION_FAILED);
    return { ok: true, period };
  }

  function bind(period, contextId, evidenceTag) {
    try {
      return authority.bindWriter(period.executionId, {
        identity: period.identity,
        contextId,
        evidence: {
          evidenceId: `${EVIDENCE_SOURCE}:${evidenceTag}:${period.executionId}`,
          source: EVIDENCE_SOURCE,
          method: EVIDENCE_METHOD,
          capabilities: [...EVIDENCE_CAPABILITIES],
        },
      });
    } catch (error) {
      log(`claude writer binding failed: ${typeof error?.code === 'string' ? error.code : 'error'}`);
      return null;
    }
  }

  function reject(source, ppid, reason) {
    log(`claude writer rejected: source=${source} reason=${reason} ppid=${Number.isInteger(ppid) ? ppid : 'invalid'}`);
    return rejection(reason);
  }

  return Object.freeze({
    /** MCP サーバーの起動時と、書き込みが writer の失効で拒否されたときの照合。 */
    async attestMcp({ ppid, contextPid } = {}) {
      if (!isPositiveInteger(contextPid)) return reject('mcp', ppid, REASON_CONTEXT_INVALID);
      const resolved = await resolvePeriod(ppid);
      if (!resolved.ok) return reject('mcp', ppid, resolved.reason);
      const writer = bind(resolved.period, `${MCP_CONTEXT_PREFIX}${contextPid}`, `mcp:${contextPid}`);
      if (!writer) return reject('mcp', ppid, REASON_REGISTRATION_FAILED);
      return { ok: true, writer: copyWriter(writer) };
    },

    /** フックの要求ごとの照合。通ったら、その期間のフック用 writer と、表示に使う sessionId を返す。 */
    async attachHookWriter({ ppid, sessionId } = {}) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return reject('hook', ppid, REASON_SESSION_MISMATCH);
      const resolved = await resolvePeriod(ppid, sessionId);
      if (!resolved.ok) return reject('hook', ppid, resolved.reason);
      const { period } = resolved;
      if (!period.hookWriter) period.hookWriter = bind(period, HOOK_CONTEXT_ID, 'hook');
      if (!period.hookWriter) return reject('hook', ppid, REASON_REGISTRATION_FAILED);
      return { ok: true, writer: copyWriter(period.hookWriter), sessionId: period.projectionId };
    },

    /** 一覧を読み始める前に呼び、syncSessionFiles へ渡す。 */
    beginListing() {
      listingSeq += 1;
      return listingSeq;
    },

    /** 定期の読み直し。読めたときだけ呼ぶ。消えた親の期間と、別のセッションに変わった期間を終える。 */
    syncSessionFiles(files, listingToken = ++listingSeq) {
      if (!Array.isArray(files)) return;
      applyListing(files, listingToken);
    },

    resolveActorCorrelation({ provider, registration, event } = {}) {
      if (provider !== 'claude') return { status: 'unavailable' };
      const period = [...periods.values()].find((item) => item.executionId === registration?.executionId);
      const agentId = event?.agent_id;
      if (!period || period.conversationId !== registration.conversationId ||
          period.projectionId !== registration.sessionId || !safeAgentId(agentId)) {
        return { status: 'unverified' };
      }
      return {
        status: 'verified',
        binding: {
          conversationId: period.conversationId,
          executionId: period.executionId,
          sessionId: period.projectionId,
          identity: { ...period.identity },
        },
        actor: { kind: 'agent', id: agentId },
      };
    },

    /**
     * MCP の書き込みの前に、writer の期間の親が今の一覧に同じ sessionId で残っているかを確かめ、変わっていれば期間を終える。
     * 一覧を読めないときは何もせず、登録核の照合に任せる。
     */
    async revalidateWriter(writer) {
      const period = typeof writer?.executionId === 'string'
        ? [...periods.values()].find((item) => item.executionId === writer.executionId)
        : null;
      if (!period) return;
      const seq = ++listingSeq;
      let files;
      try {
        files = await listSessionFiles(claudeHome);
      } catch {
        return;
      }
      if (Array.isArray(files)) applyListing(files, seq);
    },

    /** native の sessionId から、今 active の期間の表示用 sessionId を返す。無ければ null。 */
    activeProjectionFor({ sessionId, pid } = {}) {
      const period = [...periods.values()].find((item) => item.nativeId === sessionId &&
        (pid === undefined || item.pid === pid));
      return period ? period.projectionId : null;
    },

    /** 画面に出す sessionId の期間が、今 active かどうか。 */
    isActiveSession(sessionId) {
      return typeof sessionId === 'string' &&
        [...periods.values()].some((period) => period.projectionId === sessionId);
    },
  });
}

module.exports = { createClaudeLocalIssuer };
