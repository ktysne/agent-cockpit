const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionSource, pageContext } = require('./support/page-context');

const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');
const product = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');

function alternativeHarness(postUiAction) {
  const identity = {
    provider: 'codex', nativeIdKind: 'thread', hostId: 'host-a', homeScopeId: 'home-a', nativeId: 'thread-a',
  };
  const old = {
    deliveryAttemptId: 'old-attempt', logicalMessageId: 'message-a', revision: 0, launchRef: 'launch-a',
    sessionId: 'session-a', executionId: 'period-a', registrationExecutionId: 'execution-a',
    origin: 'standalone', state: 'available', mode: 'start', createdAt: 100,
  };
  const state = { sessions: [{ session_id: 'session-a', instructions: [old] }] };
  const draft = { text: '固定した代替本文', deliveryAttemptId: 'new-attempt' };
  const alternatives = new Map([['old-attempt', draft]]);
  const previews = new Map();
  const persisted = [];
  let context;
  const sandbox = {
    instructionAlternatives: alternatives,
    instructionAlternativeInFlight: new Set(),
    instructionAlternativeDiscardConfirmations: new Set(),
    instructionErrors: new Map(),
    instructionNotices: new Map(),
    instructionAlternativeRetryState: () => ({ allowed: true, reason: null, target: { identity } }),
    instructionIds: () => ({ deliveryAttemptId: 'unused', logicalMessageId: 'unused' }),
    instructionErrorText: code => String(code || 'failed'),
    persistInstructionAlternativeRequests: () => {
      persisted.push([...alternatives].filter(([, value]) => value.pendingRequest).map(([, value]) => value.pendingRequest));
      return true;
    },
    rememberInstructionPreview: (instruction, text) => {
      previews.set(instruction.deliveryAttemptId, text);
      return true;
    },
    postUiAction: (...args) => postUiAction(context, ...args),
    refresh: async () => {},
    render() {},
    showWriteError() {},
    liveStatus: { textContent: '' },
    lastState: state,
    instructionPreviews: previews,
    MAX_INSTRUCTION_TEXT_BYTES: 65536,
    MAX_PENDING_INSTRUCTION_ALTERNATIVES: 64,
  };
  context = pageContext(product, sandbox);
  const names = [
    'findInstructionRecord', 'sameInstructionIdentity', 'instructionTextByteLength', 'validScopedInstructionId',
    'normalizeInstructionAlternativeRequest', 'instructionAlternativeResultMatches', 'instructionResponse',
    'runInstructionAlternative',
  ];
  const sources = names.map((name) => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);
  return { context, alternatives, draft, identity, old, previews, persisted, state };
}

function attachInstructionStorage(harness, storage) {
  harness.context.INSTRUCTION_PREVIEW_STORAGE_KEY = 'instruction-preview';
  harness.context.INSTRUCTION_ALTERNATIVE_STORAGE_KEY = 'instruction-alternative';
  harness.context.INSTRUCTION_MODES = new Set(['steer', 'start', 'next-user-input']);
  harness.context.sessionStorage = storage;
  const sources = ['persistInstructionAlternativeRequests', 'persistInstructionPreviews', 'rememberInstructionPreview']
    .map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), harness.context);
}

function instructionStorage() {
  const values = new Map();
  let previewFailure = null;
  return {
    values,
    setPreviewFailure(value) { previewFailure = value; },
    getItem(key) {
      if (key === 'instruction-preview' && previewFailure === 'mismatch') return 'different-value';
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (key === 'instruction-preview' && previewFailure === 'throw') throw new Error('storage full');
      values.set(key, key === 'instruction-preview' && previewFailure === 'mismatch' ? 'different-value' : String(value));
    },
    removeItem(key) { values.delete(key); },
  };
}

function evaluateAlternativeRetryState({ diagnostics, target, old, created }) {
  const identity = { provider: 'codex', nativeIdKind: 'thread', hostId: 'host-a', homeScopeId: 'home-a', nativeId: 'thread-a' };
  const request = {
    oldDeliveryAttemptId: 'old-attempt', newDeliveryAttemptId: 'new-attempt', launchRef: 'launch-a',
    sessionId: 'session-a', executionId: 'period-a', registrationExecutionId: 'execution-a',
    logicalMessageId: 'logical-a', revision: 1, text: '固定した本文', mode: 'next-user-input', expectedTurnId: null,
  };
  const oldRecord = {
    deliveryAttemptId: 'old-attempt', launchRef: 'launch-a', executionId: 'period-a',
    registrationExecutionId: 'execution-a', logicalMessageId: 'logical-a', revision: 0,
    origin: 'standalone', state: 'superseded_before_send', identity, ...old,
  };
  const createdRecord = {
    deliveryAttemptId: 'new-attempt', launchRef: 'launch-a', executionId: 'period-a',
    registrationExecutionId: 'execution-a', logicalMessageId: 'logical-a', revision: 1,
    origin: 'standalone', mode: 'next-user-input', state: 'unavailable',
    heldReason: 'instruction_delivery_missing', identity, ...created,
  };
  const targetRecord = {
    launchRef: 'launch-a', sessionId: 'session-a', executionId: 'execution-a', origin: 'standalone',
    status: 'stopped', identity, ...target,
  };
  const state = {
    sessions: [{ session_id: 'session-a', instructions: [oldRecord, createdRecord] }],
    instructionTargets: [targetRecord],
    instructionDiagnostics: { service: 'blocked', blocked: true, errorCode: 'instruction_delivery_missing', targets: 'available', ...diagnostics },
  };
  const names = ['findInstructionRecord', 'sameInstructionIdentity', 'instructionTargetFor', 'instructionTargetMode',
    'instructionAlternativeRetryState'];
  const sources = names.map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  const context = vm.createContext({});
  vm.runInContext(sources.join('\n'), context);
  return context.instructionAlternativeRetryState(state, request);
}

function composerContext(session, draft = {}) {
  const ui = {
    hideFinished: true,
    instructionDrafts: draft,
    instructionNotices: {},
    instructionRecords: [],
  };
  const context = pageContext(mock, {
    ui,
    DATA: { integrations: { instructions: true } },
    commonQuestionsOf: item => item.commonQuestions || [],
    isFinishedCommonQuestion: question => question.cancelled || question.deliveryState === 'applied',
    isActiveDecision: decision => decision.kind === 'waiting' || decision.kind === 'provisional',
    instructionCard: () => '',
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
  });
  for (const name of ['isFinishedInstructionRecord', 'instructionRecordsForSession', 'instructionTargetAvailability', 'instructionModeText', 'instructionComposer']) {
    const source = functionSource(mock, name);
    assert.ok(source, `${name} source`);
    vm.runInContext(source, context);
  }
  return { context, ui, product: { id: 'product-a' }, session };
}

test('mock instruction composer is nested in each session work region in both display modes', () => {
  const sessionBlock = functionSource(mock, 'sessionBlock');
  const renderProductMode = functionSource(mock, 'renderProductMode');
  const renderKindMode = functionSource(mock, 'renderKindMode');
  assert.match(sessionBlock, /now:[\s\S]*instructionComposer\(p, session\)/);
  assert.doesNotMatch(renderProductMode, /instructionComposer\(p\)/);
  assert.match(renderKindMode, /mainRow\(p, session, true\)[\s\S]*instructionComposer\(p, session\)/);
});

test('mock composer is hidden when instructions are not configured and starts an interrupted session', () => {
  const session = { id: 'session-a', title: 'Session A', status: 'interrupted', perms: [], decisions: [], commonQuestions: [] };
  const { context, product } = composerContext(session);
  assert.equal(context.instructionTargetAvailability(session).mode, 'start');
  assert.match(context.instructionComposer(product, session), /data-instruction-session="session-a"/);
  context.DATA.integrations.instructions = false;
  assert.equal(context.instructionComposer(product, session), '');
  assert.equal(context.instructionTargetAvailability(session).mode, '');
});

test('mock composer requires explicit target and mode selections and holds while session work is pending', () => {
  const session = { id: 'session-a', title: 'Session A', status: 'busy', perms: [], decisions: [], commonQuestions: [] };
  const { context, ui, product } = composerContext(session);
  const initial = context.instructionComposer(product, session);
  assert.match(initial, /role="region" aria-label="指示の保存と送信"/);
  assert.match(initial, /<h4>指示を保存して届ける<\/h4>/);
  assert.match(initial, /<option value="" selected>実行を選択してください<\/option>/);
  assert.match(initial, /<option value="" selected>指示の種類を選択してください<\/option>/);
  assert.match(initial, /<select data-instruction-mode="session-a" disabled>/);
  assert.match(initial, /data-instruction-save="session-a" disabled/);

  ui.instructionDrafts['session-a'] = { targetSessionId: 'session-a', mode: '', text: '次へ進む' };
  const targetSelected = context.instructionComposer(product, session);
  assert.match(targetSelected, /<option value="steer" >実行中へ伝える<\/option>/);
  assert.match(targetSelected, /data-instruction-save="session-a" disabled/);

  ui.instructionDrafts['session-a'].mode = 'steer';
  const explicitChoice = context.instructionComposer(product, session);
  assert.match(explicitChoice, /data-instruction-save="session-a"(?:[^>]*)>指示を保存する<\/button>/);
  assert.doesNotMatch(explicitChoice, /data-instruction-save="session-a" disabled/);

  session.perms = [{ id: 'permission-a' }];
  const permissionHold = context.instructionComposer(product, session);
  assert.match(permissionHold, /質問・許可・判断待ちがあるため、指示を保留中です。/);
  assert.doesNotMatch(permissionHold, /value="steer"/);
  assert.match(permissionHold, /data-instruction-save="session-a" disabled/);
});

test('stopped mock session with an open question cannot select a start instruction', () => {
  const session = {
    id: 'session-waiting', title: 'Session waiting', status: 'wait', perms: [], decisions: [],
    commonQuestions: [{ internalQuestionId: 'question-a', cancelled: false, deliveryState: null }],
  };
  const { context, product } = composerContext(session);
  const html = context.instructionComposer(product, session);
  assert.match(html, /質問・許可・判断待ちがあるため、指示を保留中です。/);
  assert.doesNotMatch(html, /value="start"/);
  assert.match(html, /data-instruction-mode="session-waiting" disabled/);
});

test('mock preview recovery keeps the saved instruction and body until local storage succeeds', () => {
  const id = 'mock-instruction-preview-recovery';
  const body = '確認が必要な既存指示本文';
  const record = { deliveryAttemptId: id, sessionId: 'session-a', mode: 'steer', createdAt: 100, state: 'available' };
  const ui = {
    instructionRecords: [record], instructionPreviewRecoveries: { [id]: body }, instructionPreviews: {},
    instructionNotices: {}, instructionAlternatives: {}, hideFinished: true,
  };
  const errors = new Map();
  const writes = [false, true];
  const context = pageContext(mock, {
    ui,
    instructionPreviewRecoveryErrors: errors,
    allSessions: () => [{ id: 'session-a', title: 'Session A' }],
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
    absoluteTimeLabel: () => '作成時刻',
    instructionModeText: () => '実行中へ伝える',
    instructionStateText: () => '指示を保存しました。送信前です。',
    isFinishedInstructionRecord: item => ['applied', 'cancelled_before_send', 'superseded_before_send'].includes(item.state),
    instructionTargetAvailability: () => ({ mode: 'steer' }),
    save: () => writes.shift(),
    MAX_PENDING_INSTRUCTION_PREVIEWS: 64,
  });
  const names = [
    'registerMockInstructionPreviewRecovery', 'instructionPreviewText', 'saveMockInstructionPreviewRecovery',
    'instructionPreviewRecoveryPanel', 'instructionCard',
  ];
  const sources = names.map(name => functionSource(mock, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);

  assert.match(context.instructionPreviewRecoveryPanel(), /保存済みの指示本文/);
  assert.match(context.instructionPreviewRecoveryPanel(), new RegExp(body));
  const render = functionSource(mock, 'render');
  assert.ok(render);
  assert.match(render, /instructionPreviewRecoveryPanel\(\)/);
  assert.match(render, /insertAdjacentHTML\('afterbegin', previewRecovery\)/);
  assert.match(render, /active\?\.dataset\?\.instructionPreviewRecovery/);
  assert.match(functionSource(mock, 'instructionCard'), /<h4 tabindex="-1">/);
  const pendingCard = context.instructionCard({ id: 'session-a', title: 'Session A' }, record);
  assert.match(pendingCard, /data-instruction-action="send"[^>]*disabled/);
  assert.match(pendingCard, /data-instruction-action="cancel"/);
  assert.equal(context.instructionPreviewText(record), null);

  assert.equal(context.saveMockInstructionPreviewRecovery(id), false);
  assert.equal(ui.instructionPreviewRecoveries[id], body);
  assert.equal(Object.hasOwn(ui.instructionPreviews, id), false);
  assert.equal(ui.instructionRecords[0], record);
  assert.match(errors.get(id), /本文は保持しています/);

  assert.equal(context.saveMockInstructionPreviewRecovery(id), true);
  assert.equal(Object.hasOwn(ui.instructionPreviewRecoveries, id), false);
  assert.equal(ui.instructionPreviews[id], body);
  assert.equal(ui.instructionRecords[0], record);
  assert.equal(record.text, undefined);
  assert.equal(context.instructionPreviewRecoveryPanel(), '');
  assert.equal(context.instructionPreviewText(record), body);
  assert.match(context.instructionCard({ id: 'session-a', title: 'Session A' }, record), /送信内容/);
  const recoveredCard = context.instructionCard({ id: 'session-a', title: 'Session A' }, record);
  assert.match(recoveredCard, /data-instruction-action="send" data-instruction-id="mock-instruction-preview-recovery">/);
  assert.match(recoveredCard, /data-instruction-action="cancel"/);
  assert.equal(errors.has(id), false);
});

test('mock preview recovery enforces the 64-item pending limit', () => {
  const recoveries = Object.fromEntries(Array.from({ length: 64 }, (_, index) => ['pending-' + index, '本文']));
  const context = pageContext(mock, { ui: { instructionPreviewRecoveries: recoveries }, MAX_PENDING_INSTRUCTION_PREVIEWS: 64 });
  const source = functionSource(mock, 'registerMockInstructionPreviewRecovery');
  assert.ok(source);
  vm.runInContext(source, context);
  assert.equal(context.registerMockInstructionPreviewRecovery('overflow', '本文'), false);
  assert.equal(Object.keys(recoveries).length, 64);
});

test('lost alternative response retries the same frozen request and adds preview only after a matching response', async () => {
  const calls = [];
  const alternative = {
    deliveryAttemptId: 'new-attempt', logicalMessageId: 'message-a', revision: 1,
    launchRef: 'launch-a', sessionId: 'session-a', executionId: 'period-a',
    origin: 'standalone', state: 'available', mode: 'next-user-input',
    identity: { provider: 'codex', nativeIdKind: 'thread', hostId: 'host-a', homeScopeId: 'home-a', nativeId: 'thread-a' },
    createdAt: 200,
  };
  const harness = alternativeHarness(async (context, url, body) => {
    calls.push({ url, body: JSON.parse(JSON.stringify(body)) });
    if (calls.length === 1) {
      context.lastState = { sessions: [{ session_id: 'session-a', instructions: [
        { ...harness.old, state: 'superseded_before_send', ownerSessionId: 'session-a' },
        { ...alternative, registrationExecutionId: 'execution-a', ownerSessionId: 'session-a' },
      ] }] };
      throw new Error('response lost after service commit');
    }
    return { ok: true, json: async () => ({ outcome: 'existing', instruction: alternative }) };
  });
  const form = { dataset: { instructionAlternativeForm: 'old-attempt', instructionSession: 'session-a', instructionExecution: 'execution-a' }, elements: [] };
  await harness.context.runInstructionAlternative(form);

  assert.equal(calls.length, 1);
  assert.equal(harness.previews.size, 0);
  const pending = harness.alternatives.get('old-attempt').pendingRequest;
  assert.equal(Object.isFrozen(pending), true);
  assert.equal(pending.text, '固定した代替本文');
  await harness.context.runInstructionAlternative('old-attempt');

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(harness.previews.get('new-attempt'), '固定した代替本文');
  assert.equal(harness.alternatives.has('old-attempt'), false);
});

test('alternative response mismatch keeps the fixed body and never exposes it as a saved preview', async () => {
  let calls = 0;
  const harness = alternativeHarness(async () => {
    calls += 1;
    return { ok: true, json: async () => ({ outcome: 'created', instruction: {
      deliveryAttemptId: 'different-attempt', logicalMessageId: 'message-a', revision: 1,
      launchRef: 'launch-a', sessionId: 'session-a', executionId: 'period-a',
      origin: 'standalone', state: 'available', mode: 'next-user-input',
      identity: { provider: 'codex', nativeIdKind: 'thread', hostId: 'host-a', homeScopeId: 'home-a', nativeId: 'thread-a' },
      createdAt: 200,
    } }) };
  });
  const form = { dataset: { instructionAlternativeForm: 'old-attempt', instructionSession: 'session-a', instructionExecution: 'execution-a' }, elements: [] };
  await harness.context.runInstructionAlternative(form);

  assert.equal(calls, 1);
  assert.equal(harness.previews.size, 0);
  assert.equal(harness.alternatives.get('old-attempt').pendingRequest.text, '固定した代替本文');
});

test('invalid UTF-8 input and a full recovery queue remain editable without a request', async () => {
  const invalid = alternativeHarness(async () => { throw new Error('must not post'); });
  invalid.draft.text = '\ud800';
  const form = { dataset: { instructionAlternativeForm: 'old-attempt', instructionSession: 'session-a', instructionExecution: 'execution-a' }, elements: [] };
  await invalid.context.runInstructionAlternative(form);
  assert.equal(invalid.context.instructionTextByteLength('\ud800'), null);
  assert.equal(invalid.draft.text, '\ud800');
  assert.equal(invalid.draft.pendingRequest, undefined);
  assert.equal(invalid.persisted.length, 0);

  const full = alternativeHarness(async () => { throw new Error('must not post'); });
  for (let index = 0; index < 64; index += 1) {
    full.alternatives.set(`pending-${index}`, { pendingRequest: { text: 'already saved' } });
  }
  await full.context.runInstructionAlternative(form);
  assert.equal(full.draft.text, '固定した代替本文');
  assert.equal(full.draft.pendingRequest, undefined);
  assert.equal(full.persisted.length, 0);
});

test('代替要求をタブに保存できない場合はPOSTせず本文を保つ', async () => {
  let posts = 0;
  const harness = alternativeHarness(async () => {
    posts += 1;
    throw new Error('保存に失敗した要求は送信しない');
  });
  harness.context.persistInstructionAlternativeRequests = () => false;
  const form = { dataset: { instructionAlternativeForm: 'old-attempt', instructionSession: 'session-a', instructionExecution: 'execution-a' }, elements: [] };
  await harness.context.runInstructionAlternative(form);

  assert.equal(posts, 0);
  assert.equal(harness.draft.text, '固定した代替本文');
  assert.equal(harness.draft.pendingRequest, undefined);
});


test('missing delivery recovery retries only an exact blocked checkpoint projection', () => {
  const allowed = evaluateAlternativeRetryState({});
  assert.equal(allowed.allowed, true);

  const ready = evaluateAlternativeRetryState({
    diagnostics: { service: 'ready', blocked: false, errorCode: null },
    created: { state: 'available', heldReason: null },
  });
  assert.equal(ready.allowed, true);

  const rejectedCases = [
    { diagnostics: { errorCode: 'instruction_journal_blocked' } },
    { diagnostics: { targets: 'unavailable' } },
    { created: { heldReason: 'instruction_dispatch_unavailable' } },
    { created: { logicalMessageId: 'other-logical-id' } },
    { created: { revision: 2 } },
    { created: { mode: 'start' } },
    { created: { identity: { provider: 'codex', nativeIdKind: 'thread', hostId: 'host-a', homeScopeId: 'home-a', nativeId: 'other-thread' } } },
    { old: { state: 'available' } },
    { old: { revision: -1 } },
    { target: { status: 'waiting' } },
    { target: { executionId: 'other-execution' } },
  ];
  for (const overrides of rejectedCases) {
    assert.equal(evaluateAlternativeRetryState(overrides).allowed, false, JSON.stringify(overrides));
  }
});

test('preview storage failure keeps the fixed alternative request through reload and retries the same body', async () => {
  for (const failure of ['throw', 'mismatch']) {
    const calls = [];
    const alternative = {
      deliveryAttemptId: 'new-attempt', logicalMessageId: 'message-a', revision: 1,
      launchRef: 'launch-a', sessionId: 'session-a', executionId: 'period-a',
      origin: 'standalone', state: 'available', mode: 'next-user-input',
      identity: { provider: 'codex', nativeIdKind: 'thread', hostId: 'host-a', homeScopeId: 'home-a', nativeId: 'thread-a' },
      createdAt: 200,
    };
    const harness = alternativeHarness(async (_context, url, body) => {
      calls.push({ url, body: JSON.parse(JSON.stringify(body)) });
      return { ok: true, json: async () => ({ outcome: 'existing', instruction: alternative }) };
    });
    const storage = instructionStorage();
    storage.setPreviewFailure(failure);
    attachInstructionStorage(harness, storage);
    const form = { dataset: { instructionAlternativeForm: 'old-attempt', instructionSession: 'session-a', instructionExecution: 'execution-a' }, elements: [] };

    await harness.context.runInstructionAlternative(form);
    assert.equal(calls.length, 1);
    assert.equal(harness.alternatives.get('old-attempt').pendingRequest.text, '固定した代替本文');
    assert.equal(harness.previews.has('new-attempt'), false);
    assert.match(harness.context.instructionErrors.get('alternative:old-attempt'), /サーバーへの保存は確認済みですが、このタブへの本文保存が未完了です/);

    const persisted = JSON.parse(storage.getItem('instruction-alternative'));
    const restored = harness.context.normalizeInstructionAlternativeRequest('old-attempt', persisted['old-attempt']);
    assert.equal(restored.text, '固定した代替本文');
    harness.alternatives.clear();
    harness.alternatives.set('old-attempt', {
      open: true, text: restored.text, deliveryAttemptId: restored.newDeliveryAttemptId, pendingRequest: restored,
    });
    harness.previews.clear();
    storage.setPreviewFailure(null);

    await harness.context.runInstructionAlternative('old-attempt');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(harness.alternatives.has('old-attempt'), false);
    assert.equal(JSON.parse(storage.getItem('instruction-preview'))['new-attempt'].text, '固定した代替本文');
    assert.equal(storage.getItem('instruction-alternative'), null);
  }
});

test('通常指示の成功後は本文だけをローカル復旧し、新しい下書きを残す', async () => {
  const storage = instructionStorage();
  storage.setPreviewFailure('throw');
  const draft = { targetLaunchRef: 'launch-a', mode: 'steer', text: '通常の指示', deliveryAttemptId: 'stable-attempt', logicalMessageId: 'stable-logical' };
  const instructionDrafts = new Map([['session-a', draft]]);
  const instructionPreviews = new Map();
  const instructionPreviewSavePending = new Map();
  const target = {
    launchRef: 'launch-a', sessionId: 'session-a', executionId: 'execution-a', origin: 'standalone',
    status: 'working', nativeTurnId: 'turn-a',
  };
  const state = { instructionTargets: [target] };
  const posts = [];
  const errors = new Map();
  const notices = new Map();
  const context = pageContext(product, {
    INSTRUCTION_PREVIEW_STORAGE_KEY: 'instruction-preview',
    INSTRUCTION_MODES: new Set(['steer', 'start', 'next-user-input']),
    MAX_PENDING_INSTRUCTION_PREVIEWS: 64,
    instructionPreviewSavePending,
    instructionDrafts,
    instructionInFlight: new Set(),
    instructionErrors: errors,
    instructionNotices: notices,
    instructionPreviews,
    lastState: state,
    liveStatus: { textContent: '' },
    postUiAction: async (url, body) => {
      posts.push({ url, body: JSON.parse(JSON.stringify(body)) });
      return { ok: true, json: async () => ({ outcome: 'created', instruction: {
        deliveryAttemptId: body.delivery_attempt_id, launchRef: body.launch_ref, mode: body.mode,
        revision: body.revision, sessionId: body.session_id, createdAt: 10,
      } }) };
    },
    refresh: async () => {},
    render() {},
    showWriteError() {},
  });
  const names = [
    'validScopedInstructionId', 'instructionDraftFor', 'instructionTargetFor', 'instructionTargetMode',
    'instructionResponse', 'instructionErrorText', 'persistInstructionPreviews', 'rememberInstructionPreview',
    'reserveInstructionPreviewSave', 'completeInstructionPreviewSave', 'releaseInstructionPreviewSave',
    'retryInstructionPreviewSave', 'runInstructionPreviewSaveRetry', 'runInstructionCreate',
  ];
  const sources = names.map((name) => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  context.sessionStorage = storage;
  vm.runInContext(sources.join('\n'), context);
  const form = { dataset: { instructionSession: 'session-a' }, elements: [] };

  await context.runInstructionCreate(form);
  assert.equal(posts.length, 1);
  assert.equal(draft.text, '');
  assert.equal(draft.deliveryAttemptId, null);
  assert.equal(draft.logicalMessageId, null);
  assert.equal(instructionPreviews.has('stable-attempt'), false);
  assert.equal(instructionPreviewSavePending.get('stable-attempt').text, '通常の指示');
  assert.equal(instructionPreviewSavePending.get('stable-attempt').phase, 'pending');

  draft.text = '新しく入力した指示';
  draft.deliveryAttemptId = null;
  draft.logicalMessageId = null;
  draft.mode = 'start';
  target.status = 'stopped';
  target.nativeTurnId = null;
  storage.setPreviewFailure(null);
  await context.runInstructionPreviewSaveRetry('stable-attempt');
  assert.equal(posts.length, 1);
  assert.equal(instructionPreviewSavePending.has('stable-attempt'), false);
  assert.equal(JSON.parse(storage.getItem('instruction-preview'))['stable-attempt'].text, '通常の指示');
  assert.equal(instructionPreviews.get('stable-attempt').mode, 'steer');
  assert.equal(draft.text, '新しく入力した指示');
  assert.equal(draft.mode, 'start');

  for (let index = 0; index < 64; index += 1) {
    instructionPreviewSavePending.set('occupied-' + index, { phase: 'pending', text: 'held' });
  }
  draft.text = '容量超過時も保持する';
  draft.deliveryAttemptId = 'capacity-attempt';
  draft.logicalMessageId = 'capacity-message';
  await context.runInstructionCreate(form);
  assert.equal(posts.length, 1);
  assert.equal(draft.text, '容量超過時も保持する');
  assert.match(errors.get('session-a'), /64 件まで/);
});

test('後続回答のプレビュー復旧は質問・対象・方式が変わっても同じ回答からのPOSTを重ねない', async () => {
  const storage = instructionStorage();
  storage.setPreviewFailure('mismatch');
  const question = {
    internalQuestionId: 'question-a',
    lateAnswerRefs: [{ index: 2, digest: 'digest-a' }],
  };
  const lastState = { sessions: [{ session_id: 'session-a', commonQuestions: [question] }] };
  const instructionPreviewSavePending = new Map();
  const instructionPreviews = new Map();
  const instructionErrors = new Map();
  const instructionNotices = new Map();
  const posts = [];
  const context = pageContext(product, {
    INSTRUCTION_PREVIEW_STORAGE_KEY: 'instruction-preview',
    INSTRUCTION_MODES: new Set(['steer', 'start', 'next-user-input']),
    MAX_PENDING_INSTRUCTION_PREVIEWS: 64,
    instructionPreviewSavePending,
    instructionPreviews,
    instructionErrors,
    instructionNotices,
    instructionInFlight: new Set(),
    commonQuestionSubmittedDrafts: new Map([['question-draft', { answers: [] }]]),
    commonQuestionKey: () => 'question-draft',
    commonQuestionErrors: new Map(),
    lateAnswerDigest: async () => 'digest-a',
    formatLateAnswerPreview: () => '固定した後続回答本文',
    lastState,
    liveStatus: { textContent: '' },
    postUiAction: async (url, body) => {
      posts.push({ url, body: JSON.parse(JSON.stringify(body)) });
      return { ok: true, json: async () => ({ outcome: 'created', instruction: {
        deliveryAttemptId: 'late-attempt', launchRef: 'launch-a', mode: body.mode, revision: 0,
        sessionId: body.session_id, executionId: 'period-a', createdAt: 20,
      } }) };
    },
    instructionErrorText: code => String(code || 'failed'),
    refresh: async () => {},
    render() {},
    showWriteError() {},
  });
  const names = [
    'validScopedInstructionId', 'persistInstructionPreviews', 'rememberInstructionPreview',
    'reserveInstructionPreviewSave', 'completeInstructionPreviewSave', 'releaseInstructionPreviewSave',
    'pendingInstructionPreviewForLateKey', 'retryInstructionPreviewSave', 'runInstructionPreviewSaveRetry',
    'instructionResponse', 'runLateInstruction',
  ];
  const sources = names.map((name) => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  context.sessionStorage = storage;
  vm.runInContext(sources.join('\n'), context);
  const button = { dataset: {
    lateQuestionId: 'question-a', lateIndex: '2', lateDigest: 'digest-a',
    sessionId: 'session-a', instructionExecution: 'execution-a', lateMode: 'steer', lateExpectedTurn: 'turn-a',
  }, disabled: false };

  await context.runLateInstruction(button);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.mode, 'steer');
  assert.equal(instructionPreviewSavePending.get('late-attempt').text, '固定した後続回答本文');
  assert.equal(instructionErrors.has('late:question-a:2:digest-a'), true);

  lastState.sessions = [];
  button.dataset.lateMode = 'start';
  button.dataset.lateExpectedTurn = '';
  storage.setPreviewFailure(null);
  await context.runLateInstruction(button);
  assert.equal(posts.length, 1);
  assert.equal(instructionPreviewSavePending.has('late-attempt'), false);
  assert.equal(instructionErrors.has('late:question-a:2:digest-a'), false);
  assert.equal(JSON.parse(storage.getItem('instruction-preview'))['late-attempt'].text, '固定した後続回答本文');
});
test('本文確認の再描画と復旧完了後に同じ指示または安定したcontrolへフォーカスを戻す', () => {
  const helper = functionSource(product, 'restoreInstructionPreviewRecoveryFocus');
  const card = functionSource(product, 'instructionCard');
  assert.ok(helper);
  assert.match(card, /title\.dataset\.instructionPreviewTitle = instruction\.deliveryAttemptId/);
  assert.match(card, /title\.tabIndex = -1/);
  let replacedWith = null;
  let focused = null;
  let selection = null;
  let retryVisible = true;
  let titleVisible = true;
  let recoveryHeadingVisible = true;
  const activeTextarea = {
    focus() { focused = this; },
    setSelectionRange(start, end) { selection = [start, end]; },
  };
  const replacement = { replaceWith(node) { replacedWith = node; } };
  const retryButton = { focus() { focused = this; } };
  const title = { focus() { focused = this; } };
  const recoveryHeading = { focus() { focused = this; } };
  const modeButton = { focus() { focused = this; } };
  const root = {
    querySelector(selector) {
      if (selector === '[data-instruction-preview-recovery-text="attempt-a"]') return replacement;
      if (selector === '[data-instruction-preview-retry="attempt-a"]') return retryVisible ? retryButton : null;
      if (selector === '[data-instruction-preview-title="attempt-a"]') return titleVisible ? title : null;
      if (selector === '[data-instruction-preview-recovery-heading]') return recoveryHeadingVisible ? recoveryHeading : null;
      return null;
    },
  };
  const document = { querySelector: () => modeButton };
  const context = vm.createContext({ root, document, displayPreferences: { mode: 'product' }, CSS: { escape: value => value } });
  vm.runInContext(helper, context);

  context.restoreInstructionPreviewRecoveryFocus({
    kind: 'instruction-preview-text', id: 'attempt-a', start: 1, end: 3,
  }, activeTextarea);
  assert.equal(replacedWith, activeTextarea);
  assert.equal(focused, activeTextarea);
  assert.deepEqual(selection, [1, 3]);

  context.restoreInstructionPreviewRecoveryFocus({ kind: 'instruction-preview-retry', id: 'attempt-a' });
  assert.equal(focused, retryButton);

  retryVisible = false;
  context.restoreInstructionPreviewRecoveryFocus({ kind: 'instruction-preview-retry', id: 'attempt-a' });
  assert.equal(focused, title);

  titleVisible = false;
  recoveryHeadingVisible = false;
  context.restoreInstructionPreviewRecoveryFocus({ kind: 'instruction-preview-retry', id: 'attempt-a' });
  assert.equal(focused, modeButton);
});

test('mock retains an alternative request when the final local state write fails', () => {
  const request = {
    oldDeliveryAttemptId: 'old-attempt', newDeliveryAttemptId: 'new-attempt',
    sessionId: 'session-a', text: '固定したモック本文', mode: 'next-user-input',
  };
  const saved = { text: request.text, pendingRequest: request, error: null };
  const ui = { instructionAlternatives: { 'old-attempt': saved }, instructionNotices: {} };
  const writes = [false, true];
  let applies = 0;
  const context = pageContext(mock, {
    ui,
    allSessions: () => [{ id: 'session-a' }],
    applyMockInstructionAlternative: () => { applies += 1; return true; },
    save: () => writes.shift(),
  });
  const source = functionSource(mock, 'commitMockInstructionAlternative');
  assert.ok(source);
  vm.runInContext(source, context);

  assert.equal(context.commitMockInstructionAlternative('old-attempt', request, saved), false);
  assert.equal(ui.instructionAlternatives['old-attempt'].pendingRequest, request);
  assert.match(ui.instructionAlternatives['old-attempt'].error, /要求本文を保持しています/);
  assert.equal(ui.instructionNotices['session-a'], undefined);

  assert.equal(context.commitMockInstructionAlternative('old-attempt', request, ui.instructionAlternatives['old-attempt']), true);
  assert.equal(ui.instructionAlternatives['old-attempt'], undefined);
  assert.match(ui.instructionNotices['session-a'], /送信前に内容を確認/);
  assert.equal(applies, 2);
});

test('poll rerenders keep alternative confirmation focus on the same control when it remains present', () => {
  for (const [source, usesCss] of [[product, true], [mock, false]]) {
    const helper = functionSource(source, 'restoreInstructionAlternativeFocus');
    assert.ok(helper);
    for (const scenario of [
      { kind: 'instruction-alt-discard-ask', selector: '[data-instruction-alternative-discard-ask="old-attempt"]' },
      { kind: 'instruction-alt-discard-ask', selector: '[data-instruction-alternative-discard="old-attempt"]' },
      { kind: 'instruction-alt-discard-dismiss', selector: '[data-instruction-alternative-discard-dismiss="old-attempt"]' },
      { kind: 'instruction-alt-discard-dismiss', selector: '[data-instruction-alternative-discard-ask="old-attempt"]' },
    ]) {
      let focused = null;
      const control = { disabled: false, focus() { focused = this; } };
      const root = { querySelector: selector => selector === scenario.selector ? control : null };
      const context = vm.createContext({ root, CSS: { escape: value => value }, esc: value => String(value) });
      vm.runInContext(helper, context);
      const focusData = JSON.stringify({ kind: scenario.kind, id: 'old-attempt' });
      if (usesCss) vm.runInContext(`restoreInstructionAlternativeFocus(${focusData})`, context);
      else vm.runInContext(`restoreInstructionAlternativeFocus(root, ${focusData})`, context);
      assert.equal(focused, control, `${source === product ? 'product' : 'mock'} ${scenario.kind} ${scenario.selector}`);
    }
  }
});
