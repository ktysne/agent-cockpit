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

test('通常指示はプレビュー永続化を確認するまで入力と安定IDを保持する', async () => {
  const storage = instructionStorage();
  storage.setPreviewFailure('throw');
  const draft = { targetLaunchRef: 'launch-a', mode: 'steer', text: '通常の指示', deliveryAttemptId: 'stable-attempt', logicalMessageId: 'stable-logical' };
  const instructionDrafts = new Map([['session-a', draft]]);
  const target = {
    launchRef: 'launch-a', sessionId: 'session-a', executionId: 'execution-a', origin: 'standalone',
    status: 'working', nativeTurnId: 'turn-a',
  };
  const state = { instructionTargets: [target] };
  const posts = [];
  const context = pageContext(product, {
    INSTRUCTION_PREVIEW_STORAGE_KEY: 'instruction-preview', INSTRUCTION_MODES: new Set(['steer', 'start', 'next-user-input']),
    instructionDrafts,
    instructionInFlight: new Set(), instructionErrors: new Map(), instructionNotices: new Map(), instructionPreviews: new Map(),
    lastState: state, liveStatus: { textContent: '' },
    postUiAction: async (url, body) => {
      posts.push({ url, body: JSON.parse(JSON.stringify(body)) });
      return { ok: true, json: async () => ({ outcome: 'existing', instruction: {
        deliveryAttemptId: body.delivery_attempt_id, launchRef: body.launch_ref, mode: body.mode, revision: body.revision,
      } }) };
    },
    refresh: async () => {}, render() {}, showWriteError() {},
  });
  context.sessionStorage = storage;
  const sources = ['validScopedInstructionId', 'instructionDraftFor', 'instructionTargetFor', 'instructionTargetMode',
    'instructionResponse', 'persistInstructionPreviews', 'rememberInstructionPreview', 'runInstructionCreate']
    .map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);
  const form = { dataset: { instructionSession: 'session-a' }, elements: [] };

  await context.runInstructionCreate(form);
  assert.equal(posts.length, 1);
  assert.equal(draft.text, '通常の指示');
  assert.equal(draft.deliveryAttemptId, 'stable-attempt');
  assert.equal(draft.logicalMessageId, 'stable-logical');
  assert.equal(context.instructionPreviews.has('stable-attempt'), false);
  assert.match(context.instructionNotices.get('session-a'), /サーバーへの保存は確認済みですが、このタブへの本文保存が未完了です/);

  storage.setPreviewFailure(null);
  await context.runInstructionCreate(form);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1], posts[0]);
  assert.equal(draft.text, '');
  assert.equal(draft.deliveryAttemptId, null);
  assert.equal(draft.logicalMessageId, null);
  assert.equal(JSON.parse(storage.getItem('instruction-preview'))['stable-attempt'].text, '通常の指示');
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
