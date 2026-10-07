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
