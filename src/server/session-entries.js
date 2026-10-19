const assert = require('node:assert/strict');
const { isQuestionTool } = require('./events');
const { isPullRequestShellTool } = require('./pull-request-utils');

const COMPACT_THRESHOLD = 2000;
const COMPACT_INTERVAL = 1000;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const RETAINED_FIELDS = [
  'questions', 'decisionResolution', 'codexDefinition', 'codexWaitDefinition',
  'codexWaitRunId', 'codexWaitStatus', 'codexResult', 'codexRunId', 'codexAudit',
  'backgroundTaskId', 'backgroundOutputTaskId', 'stoppedTaskId', 'resolvedModel',
  'backgroundTaskEnds', 'agentDefinition', 'codexAgentDefinition', 'isInterrupt',
];

function isQuestionEntry({ event }) {
  return isQuestionTool(event.provider, event.tool_name) || Boolean(event.questions || event.decisionResolution);
}

function later(left, right) {
  return !right || left.event.hookAt > right.event.hookAt ||
    (left.event.hookAt === right.event.hookAt && left.sequence > right.sequence);
}

function buildIndex(entries) {
  const index = { questions: [], creates: new Set(), refreshes: new Set(), lifecycleAt: -Infinity, promptAt: -Infinity };
  for (const entry of entries) updateIndex(index, entry);
  return index;
}

function updateIndex(index, entry) {
  const { event } = entry;
  if (isQuestionEntry(entry)) index.questions.push(entry);
  if (event.hook_event_name === 'PreToolUse' && isPullRequestShellTool(event.tool_name) && event.tool_use_id) {
    if (event.ghPrCreateCommand === true) index.creates.add(event.tool_use_id);
    if (event.refreshPullRequestsCommand === true) index.refreshes.add(event.tool_use_id);
  }
  if (!event.agent_id) {
    if (event.hook_event_name === 'UserPromptSubmit') index.promptAt = Math.max(index.promptAt, event.hookAt);
    if (['SessionStart', 'UserPromptSubmit', 'Stop'].includes(event.hook_event_name)) {
      index.lifecycleAt = Math.max(index.lifecycleAt, event.hookAt);
    }
  }
}

class SessionEntries {
  constructor(verify = false) {
    this.records = new Map();
    this.verify = verify;
  }

  get(sessionId) { return this.records.get(sessionId)?.entries; }
  has(sessionId) { return this.records.has(sessionId); }
  delete(sessionId) { return this.records.delete(sessionId); }
  *values() {
    for (const record of this.records.values()) yield record.entries;
  }
  *[Symbol.iterator]() {
    for (const [id, record] of this.records) yield [id, record.entries];
  }

  replace(sessionId, entries) {
    this.records.set(sessionId, {
      entries: [...entries], index: buildIndex(entries),
      full: this.verify ? [...entries] : null, nextCompactAt: COMPACT_THRESHOLD,
    });
  }

  push(sessionId, entry) {
    if (!this.has(sessionId)) this.replace(sessionId, []);
    const record = this.records.get(sessionId);
    record.entries.push(entry);
    record.full?.push(entry);
    updateIndex(record.index, entry);
    if (record.entries.length > record.nextCompactAt) {
      this.compact(record);
      record.nextCompactAt = Math.max(COMPACT_THRESHOLD, record.entries.length + COMPACT_INTERVAL);
    }
    if (this.verify) assert.deepStrictEqual(record.index, buildIndex(record.full));
    return record.entries;
  }

  full(sessionId) { return this.records.get(sessionId)?.full; }

  questions(sessionId) {
    const record = this.records.get(sessionId);
    if (!record) return [];
    if (this.verify) assert.deepStrictEqual(record.index.questions, record.full.filter(isQuestionEntry));
    return record.index.questions;
  }

  wasCommand(sessionId, toolUseId, kind) {
    const record = this.records.get(sessionId);
    const found = Boolean(toolUseId && record?.index[kind].has(toolUseId));
    if (this.verify && record) {
      const field = kind === 'creates' ? 'ghPrCreateCommand' : 'refreshPullRequestsCommand';
      assert.equal(found, Boolean(toolUseId && record.full.some(({ event }) =>
        event.hook_event_name === 'PreToolUse' && isPullRequestShellTool(event.tool_name) &&
        event.tool_use_id === toolUseId && event[field] === true)));
    }
    return found;
  }

  lifecycle(sessionId) {
    const record = this.records.get(sessionId);
    const index = record?.index || { lifecycleAt: -Infinity, promptAt: -Infinity };
    if (this.verify && record) {
      let lifecycleAt = -Infinity;
      let promptAt = -Infinity;
      for (const { event } of record.full) {
        if (event.agent_id) continue;
        if (event.hook_event_name === 'UserPromptSubmit') promptAt = Math.max(promptAt, event.hookAt);
        if (['SessionStart', 'UserPromptSubmit', 'Stop'].includes(event.hook_event_name)) {
          lifecycleAt = Math.max(lifecycleAt, event.hookAt);
        }
      }
      assert.deepStrictEqual([index.lifecycleAt, index.promptAt], [lifecycleAt, promptAt]);
    }
    return { lastLifecycleAt: index.lifecycleAt, lastPromptAt: index.promptAt };
  }

  delegate(sessionId, parentSessionId) {
    const first = this.get(sessionId)[0];
    first.event.delegatedFrom = parentSessionId;
    this.replace(sessionId, [first]);
  }

  compact(record) {
    const keep = new Set([record.entries[0]]);
    const boundaries = new Map();
    const latestPre = new Map();
    const firstAgent = new Map();
    const identities = new Map();
    const calls = new Map();
    const permissions = [];
    let latestEntry;
    for (const entry of record.entries) {
      const { event } = entry;
      const agent = event.agent_id || '';
      if (later(entry, latestEntry)) latestEntry = entry;
      for (const field of ['product', 'sessionName', 'model', 'cwd']) {
        const key = field === 'model' ? `${field}:${agent}` : field;
        if (event[field] && later(entry, identities.get(key))) identities.set(key, entry);
      }
      if (agent && (!firstAgent.has(agent) || later(firstAgent.get(agent), entry))) firstAgent.set(agent, entry);
      if ((!agent && ['Stop', 'UserPromptSubmit'].includes(event.hook_event_name)) ||
        (agent && event.hook_event_name === 'SubagentStop')) {
        boundaries.set(agent, Math.max(boundaries.get(agent) ?? -Infinity, event.hookAt));
      }
      if (agent && event.hook_event_name === 'PreToolUse' && later(entry, latestPre.get(agent))) latestPre.set(agent, entry);
      if (event.hook_event_name === 'PermissionRequest' || event.hook_event_name === 'Notification') permissions.push(entry);
      if (!TOOL_EVENTS.has(event.hook_event_name) || !event.tool_use_id || isQuestionEntry(entry) ||
        ['Agent', 'TaskStop'].includes(event.tool_name) || RETAINED_FIELDS.some((field) => Boolean(event[field]))) keep.add(entry);
      if (TOOL_EVENTS.has(event.hook_event_name) && event.tool_use_id) {
        let call = calls.get(event.tool_use_id);
        if (!call) calls.set(event.tool_use_id, call = []);
        call.push(entry);
      }
    }
    keep.add(latestEntry);
    for (const entry of [...firstAgent.values(), ...latestPre.values(), ...identities.values()]) keep.add(entry);
    for (const call of calls.values()) {
      const paired = call.some(({ event }) => event.hook_event_name === 'PreToolUse') &&
        call.some(({ event }) => event.hook_event_name !== 'PreToolUse');
      // 許可待ちの対象はその時点の実行中ツールから決まるため、通知をまたぐ呼び出しは残す。
      const spansPermission = permissions.some(({ event: permission }) =>
        call.some(({ event }) => (event.agent_id || '') === (permission.agent_id || '') && event.hookAt <= permission.hookAt) &&
        call.some(({ event }) => event.hookAt >= permission.hookAt));
      const sameInvocation = call.every(({ event }) => event.tool_name === call[0].event.tool_name &&
        (event.agent_id || '') === (call[0].event.agent_id || ''));
      if (!paired || !sameInvocation || spansPermission || call.some((entry) => keep.has(entry) ||
        !(entry.event.hookAt < (boundaries.get(entry.event.agent_id || '') ?? -Infinity)))) {
        for (const entry of call) keep.add(entry);
      }
    }
    record.entries = record.entries.filter((entry) => keep.has(entry));
  }
}

module.exports = { SessionEntries };
