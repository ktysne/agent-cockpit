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
    allSessions: () => [session],
    MAX_NATIVE_PENDING_REQUESTS: Number(mock.match(/const MAX_NATIVE_PENDING_REQUESTS = (\d+);/)?.[1]),
    DATA: { integrations: { instructions: true } },
    commonQuestionsOf: item => item.commonQuestions || [],
    isFinishedCommonQuestion: question => question.cancelled || question.deliveryState === 'applied',
    isActiveDecision: decision => decision.kind === 'waiting' || decision.kind === 'provisional',
    instructionCard: () => '',
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
  });
  for (const name of ['isFinishedInstructionRecord', 'instructionRecordsForSession', 'instructionTargetAvailability',
    'instructionDraftBinding', 'sameInstructionDraftBinding', 'instructionDraftCanSave', 'rebindInstructionDraft',
    'instructionModeText', 'instructionComposer']) {
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
  assert.match(context.instructionComposer(product, session), /data-instruction-create-form="session-a"/);
  context.DATA.integrations.instructions = false;
  assert.equal(context.instructionComposer(product, session), '');
  assert.equal(context.instructionTargetAvailability(session).mode, '');
});

test('mock composer fixes the target and derives the mode while retaining drafts across pending work', () => {
  const session = { id: 'session-a', title: 'Session A', status: 'busy', perms: [], decisions: [], commonQuestions: [] };
  const { context, ui, product } = composerContext(session);
  const initial = context.instructionComposer(product, session);
  assert.match(initial, /role="region" aria-label="指示の保存と送信"/);
  assert.match(initial, /<article class="decision" data-instruction-composer><div class="dhead"><span class="dtitle">追加指示/);
  assert.match(initial, /data-instruction-create-form="session-a"[\s\S]*?class="answer-foot"[\s\S]*?下書き（未送信）/);
  assert.match(initial, /現在の宛先: Session A · 作業中 · 送信方法: 実行中へ伝える/);
  assert.doesNotMatch(initial, /<select/);
  assert.doesNotMatch(initial, /指示の種類を選択/);
  assert.match(initial, /data-instruction-save="session-a" disabled/);

  ui.instructionDrafts['session-a'] = { targetSessionId: 'session-a', mode: '', text: '次へ進む' };
  const targetSelected = context.instructionComposer(product, session);
  assert.match(targetSelected, /現在の宛先: Session A · 作業中 · 送信方法: 実行中へ伝える/);
  assert.match(targetSelected, /data-instruction-rebind="session-a"/);
  assert.match(targetSelected, /data-instruction-save="session-a" disabled/);

  assert.equal(context.rebindInstructionDraft('session-a'), true);
  const rebound = context.instructionComposer(product, session);
  assert.match(rebound, /data-instruction-save="session-a"(?:[^>]*)>指示を保存する<\/button>/);
  assert.doesNotMatch(rebound, /data-instruction-save="session-a" disabled/);
  assert.equal(ui.instructionDrafts['session-a'].text, '次へ進む');

  session.perms = [{ id: 'permission-a' }];
  const permissionHold = context.instructionComposer(product, session);
  assert.match(permissionHold, /質問・許可・判断待ちがあるため、指示を保留中です。/);
  assert.doesNotMatch(permissionHold, /<select/);
  assert.match(permissionHold, /<textarea[^>]*>次へ進む<\/textarea>/);
  assert.match(permissionHold, /data-instruction-save="session-a" disabled/);
});

test('mock draft that observed a state change stays held after returning to the old state until explicit rebind', () => {
  const session = { id: 'session-aba', title: 'Session ABA', status: 'busy', executionId: 'exec-a', nativeTurnId: 'turn-a', perms: [], decisions: [], commonQuestions: [] };
  const { context, ui, product } = composerContext(session, {
    'session-aba': { targetSessionId: 'session-aba', mode: 'steer', text: '保持する本文' },
  });
  const draft = ui.instructionDrafts['session-aba'];
  draft.binding = context.instructionDraftBinding(session, 'steer');
  assert.match(context.instructionComposer(product, session), /data-instruction-save="session-aba"/);
  assert.equal(draft.needsRebind, undefined);

  session.status = 'wait';
  context.instructionComposer(product, session);
  assert.equal(draft.needsRebind, true);
  assert.equal(context.instructionDraftCanSave(session, draft), false);

  session.status = 'busy';
  session.nativeTurnId = 'turn-a';
  const returned = context.instructionComposer(product, session);
  assert.match(returned, /data-instruction-rebind="session-aba"/);
  assert.match(returned, /data-instruction-save="session-aba" disabled/);
  assert.equal(context.instructionDraftCanSave(session, draft), false);
  assert.equal(context.rebindInstructionDraft('session-aba'), true);
  assert.equal(draft.needsRebind, false);
  assert.equal(draft.text, '保持する本文');
  assert.equal(context.instructionDraftCanSave(session, draft), true);
});

test('stopped mock session with an open question cannot select a start instruction', () => {
  const session = {
    id: 'session-waiting', title: 'Session waiting', status: 'wait', perms: [], decisions: [],
    commonQuestions: [{ internalQuestionId: 'question-a', cancelled: false, deliveryState: null }],
  };
  const { context, product } = composerContext(session);
  const html = context.instructionComposer(product, session);
  assert.match(html, /質問・許可・判断待ちがあるため、指示を保留中です。/);
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /data-instruction-save="session-waiting" disabled/);
});

test('native waiting target explains the hold accessibly while preserving the instruction draft', () => {
  const draft = { targetLaunchRef: 'launch-wait', mode: 'steer', text: 'この下書きを保持する' };
  const target = {
    launchRef: 'launch-wait', sessionId: 'session-wait', executionId: 'period-wait',
    identity: { nativeId: 'native-thread' }, origin: 'standalone', status: 'waiting',
    nativeTurnId: 'native-turn', reason: 'native_request_pending',
    nativeWaiting: [{ kind: 'question', count: 1 }, { kind: 'approval', count: 1 }],
  };
  const nodes = [];
  const element = (tagName, className = '', text = '') => {
    const children = [];
    const node = {
      tagName, className, textContent: String(text ?? ''), children, childNodes: children, dataset: {}, attributes: {},
      append(...items) { children.push(...items); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener() {},
    };
    nodes.push(node);
    return node;
  };
  const context = pageContext(product, {
    instructionDraftFor: () => draft,
    instructionDrafts: new Map([['session-wait', draft]]),
    MAX_NATIVE_PENDING_REQUESTS: Number(product.match(/const MAX_NATIVE_PENDING_REQUESTS = (\d+);/)?.[1]),
    instructionTargetsForSession: () => [target],
    instructionErrors: new Map(),
    instructionNotices: new Map(),
    instructionInFlight: new Set(),
    element,
  });
  const sources = ['instructionComposer', 'instructionTargetMode', 'instructionModeForTarget', 'instructionBindingForTarget',
    'sameInstructionBinding', 'instructionDraftTargetFor', 'instructionDraftMatchesTarget', 'instructionDraftRebindTarget',
    'instructionDraftFor', 'instructionTargetsForSession', 'instructionTargetName', 'instructionTargetWaitingSummary',
    'instructionTargetStatusText', 'instructionTargetWaitingNotice', 'instructionModeLabel']
    .map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);

  context.instructionComposer({ session_id: 'session-wait', instructions: [] }, {
    session_id: 'session-wait', instructions: [],
    instructionTargets: [target],
    instructionDiagnostics: { service: 'ready', targets: 'available', blocked: false },
  });
  const textarea = nodes.find(node => node.tagName === 'textarea');
  const selects = nodes.filter(node => node.tagName === 'select');
  const reason = nodes.find(node => node.className.includes('instruction-reason') && /質問 1 件/.test(node.textContent));
  const save = nodes.find(node => node.tagName === 'button' && node.textContent === '指示を保存する');

  assert.equal(textarea.value, 'この下書きを保持する');
  assert.equal(textarea.disabled, false);
  assert.match(reason.textContent, /質問 1 件、許可 1 件/);
  assert.match(reason.textContent, /追加の指示は保留されています。入力内容は保持されます。/);
  assert.equal(selects.length, 0);
  assert.equal(save.disabled, true);
  assert.equal(context.instructionTargetMode(target, 'start'), false);
  assert.equal(context.instructionTargetMode(target, 'steer'), false);
  assert.doesNotMatch(nodes.map(node => node.textContent).join(' '), /回答する|許可する/);

  target.status = 'unverified';
  target.reason = 'instruction_target_unverified';
  context.instructionComposer({ session_id: 'session-wait', instructions: [] }, {
    session_id: 'session-wait', instructions: [],
    instructionTargets: [target],
    instructionDiagnostics: { service: 'ready', targets: 'available', blocked: false },
  });
  const unverifiedReason = nodes.filter(node => node.className.includes('instruction-reason')).at(-2);
  const unverifiedTextarea = nodes.filter(node => node.tagName === 'textarea').at(-1);
  assert.match(unverifiedReason.textContent, /宛先または実行状態が変わりました。下書きは保持し、対象を確認できるまで保存を保留しています。/);
  assert.doesNotMatch(unverifiedReason.textContent, /instruction_target_unverified/);
  assert.equal(unverifiedTextarea.value, 'この下書きを保持する');
  assert.equal(unverifiedTextarea.disabled, false);
});

test('multiple instruction targets stay unselected until the developer explicitly chooses one', () => {
  const nodes = [];
  const element = (tagName, className = '', text = '') => {
    const children = [];
    const node = {
      tagName, className, textContent: String(text ?? ''), children, childNodes: children, dataset: {}, attributes: {},
      append(...items) { children.push(...items); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener() {},
    };
    nodes.push(node);
    return node;
  };
  const draft = { targetLaunchRef: '', mode: '', text: '候補を選べない間も保持する' };
  const targets = [
    { launchRef: 'launch-a', sessionId: 'session-a', executionId: 'exec-a', origin: 'standalone', status: 'working', nativeTurnId: 'turn-a' },
    { launchRef: 'launch-b', sessionId: 'session-a', executionId: 'exec-b', origin: 'standalone', status: 'stopped' },
  ];
  const context = pageContext(product, {
    instructionDraftFor: () => draft,
    instructionDrafts: new Map([['session-a', draft]]),
    instructionTargetsForSession: () => targets,
    instructionErrors: new Map(), instructionNotices: new Map(), instructionInFlight: new Set(), element,
  });
  const sources = ['instructionComposer', 'instructionTargetMode', 'instructionModeForTarget', 'instructionBindingForTarget',
    'sameInstructionBinding', 'instructionDraftTargetFor', 'instructionDraftMatchesTarget', 'instructionDraftRebindTarget',
    'instructionDraftFor', 'instructionTargetName', 'instructionTargetStatusText', 'instructionModeLabel', 'instructionTargetWaitingNotice']
    .map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);
  context.instructionComposer({ session_id: 'session-a', instructions: [] }, {
    session_id: 'session-a', instructions: [], instructionDiagnostics: { service: 'ready', blocked: false, targets: 'available' },
  });

  assert.equal(draft.targetLaunchRef, '');
  assert.equal(draft.binding, undefined);
  assert.match(nodes.map(node => node.textContent).join(' '), /候補 2 件/);
  const targetOptions = nodes.filter(node => node.dataset.instructionTargetSelect === 'session-a');
  assert.equal(targetOptions.length, 2);
  assert.equal(targetOptions.filter(node => node.checked).length, 0);
  assert.equal(targetOptions.some(node => node.value === 'launch-a'), true);
  assert.equal(targetOptions.some(node => node.value === 'launch-b'), true);
  assert.equal(nodes.some(node => node.dataset.instructionRebind), false);
  assert.equal(nodes.find(node => node.tagName === 'button' && node.textContent === '指示を保存する')?.disabled, true);
});

test('an explicit multi-target choice binds and saves only the selected launch', async () => {
  const storage = instructionStorage();
  const targets = [
    { launchRef: 'launch-a', sessionId: 'session-a', executionId: 'exec-a', origin: 'standalone', status: 'working', nativeTurnId: 'turn-a' },
    { launchRef: 'launch-b', sessionId: 'session-a', executionId: 'exec-b', origin: 'standalone', status: 'working', nativeTurnId: 'turn-b' },
  ];
  const state = { instructionTargets: targets, instructionDiagnostics: { service: 'ready', targets: 'available', blocked: false } };
  const draft = { targetLaunchRef: '', mode: '', text: '' };
  const instructionDrafts = new Map([['session-a', draft]]);
  const instructionPreviewSavePending = new Map();
  const instructionPreviews = new Map();
  const nodes = [];
  const element = (tagName, className = '', text = '') => {
    const children = [];
    const node = {
      tagName, className, textContent: String(text ?? ''), children, childNodes: children, dataset: {}, attributes: {},
      append(...items) { children.push(...items); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener() {},
    };
    nodes.push(node);
    return node;
  };
  const posts = [];
  let changeHandler;
  let rerenders = 0;
  const context = pageContext(product, {
    INSTRUCTION_PREVIEW_STORAGE_KEY: 'instruction-preview',
    INSTRUCTION_MODES: new Set(['steer', 'start', 'next-user-input']),
    MAX_PENDING_INSTRUCTION_PREVIEWS: 64,
    instructionDrafts,
    instructionInFlight: new Set(),
    instructionErrors: new Map(),
    instructionNotices: new Map(),
    instructionPreviewSavePending,
    instructionPreviews,
    lastState: state,
    liveStatus: { textContent: '' },
    element,
    document: { addEventListener: (name, handler) => { if (name === 'change') changeHandler = handler; } },
    render: () => { rerenders += 1; },
    postUiAction: async (url, body) => {
      posts.push({ url, body: JSON.parse(JSON.stringify(body)) });
      return { ok: true, json: async () => ({ outcome: 'created', instruction: {
        deliveryAttemptId: body.delivery_attempt_id, launchRef: body.launch_ref, mode: body.mode,
        revision: body.revision, sessionId: body.session_id, createdAt: 10,
      } }) };
    },
    refresh: async () => {}, showWriteError() {},
  });
  const names = [
    'instructionIds', 'validScopedInstructionId', 'instructionDraftFor', 'instructionComposer', 'instructionTargetsForSession',
    'instructionTargetMode', 'instructionModeForTarget', 'instructionBindingForTarget', 'sameInstructionBinding',
    'instructionDraftTargetFor', 'instructionDraftMatchesTarget', 'instructionDraftRebindTarget', 'selectInstructionDraftTarget',
    'instructionTargetName', 'instructionTargetStatusText', 'instructionTargetWaitingSummary', 'instructionTargetWaitingNotice',
    'instructionModeLabel', 'instructionResponse', 'instructionErrorText', 'persistInstructionPreviews', 'rememberInstructionPreview',
    'reserveInstructionPreviewSave', 'completeInstructionPreviewSave', 'releaseInstructionPreviewSave',
    'retryInstructionPreviewSave', 'runInstructionPreviewSaveRetry', 'runInstructionCreate',
  ];
  const sources = names.map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  const changeSource = product.match(/document\.addEventListener\('change', \(event\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(changeSource);
  context.sessionStorage = storage;
  vm.runInContext(`${sources.join('\n')}\n${changeSource}`, context);

  context.instructionComposer({ session_id: 'session-a', instructions: [] }, state);
  const targetRadio = nodes.find(node => node.dataset.instructionTargetSelect === 'session-a' && node.value === 'launch-b');
  assert.ok(targetRadio);
  const targetEvent = { closest: selector => selector === '[data-instruction-target-select]' ? targetRadio : null };
  changeHandler({ target: targetEvent });
  assert.equal(rerenders, 1);
  assert.equal(draft.targetLaunchRef, 'launch-b');
  assert.equal(draft.binding.executionId, 'exec-b');
  draft.text = '選んだ実行だけに保存する';
  const session = { session_id: 'session-a', instructions: [] };
  nodes.length = 0;
  context.instructionComposer(session, state);
  const checked = nodes.filter(node => node.dataset.instructionTargetSelect === 'session-a' && node.checked);
  assert.equal(checked.length, 1);
  assert.equal(checked[0].value, 'launch-b');
  const save = nodes.find(node => node.tagName === 'button' && node.textContent === '指示を保存する');
  assert.equal(save.disabled, false);

  await context.runInstructionCreate({ dataset: { instructionSession: 'session-a' }, elements: [] });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/instructions/create');
  assert.equal(posts[0].body.launch_ref, 'launch-b');
  assert.equal(posts[0].body.execution_id, 'exec-b');
});

test('changing a populated multi-target draft requires confirmation and candidate additions keep its selection', () => {
  const targets = [
    { launchRef: 'launch-a', sessionId: 'session-a', executionId: 'exec-a', origin: 'standalone', status: 'working', nativeTurnId: 'turn-a' },
    { launchRef: 'launch-b', sessionId: 'session-a', executionId: 'exec-b', origin: 'standalone', status: 'working', nativeTurnId: 'turn-b' },
  ];
  const state = { instructionTargets: targets, instructionDiagnostics: { service: 'ready', targets: 'available', blocked: false } };
  const draft = {
    targetLaunchRef: 'launch-a', mode: 'steer', text: '宛先を変えても本文を保つ',
    binding: { launchRef: 'launch-a', executionId: 'exec-a', origin: 'standalone', status: 'working', nativeTurnId: 'turn-a', mode: 'steer' },
  };
  const context = pageContext(product, {
    instructionDraftFor: () => draft,
    instructionDrafts: new Map([['session-a', draft]]),
    instructionInFlight: new Set(), instructionErrors: new Map(), instructionNotices: new Map(),
  });
  const names = ['instructionDraftFor', 'instructionTargetsForSession', 'instructionModeForTarget', 'instructionTargetMode',
    'instructionBindingForTarget', 'sameInstructionBinding', 'instructionDraftTargetFor', 'instructionDraftMatchesTarget',
    'instructionDraftRebindTarget', 'selectInstructionDraftTarget', 'rebindInstructionDraft'];
  const sources = names.map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);

  assert.equal(context.selectInstructionDraftTarget('session-a', 'launch-b', state), true);
  assert.equal(draft.targetLaunchRef, 'launch-b');
  assert.equal(draft.needsRebind, true);
  assert.equal(draft.text, '宛先を変えても本文を保つ');
  assert.equal(draft.binding.launchRef, 'launch-a');
  assert.equal(context.rebindInstructionDraft('session-a', state), true);
  assert.equal(draft.binding.launchRef, 'launch-b');
  assert.equal(draft.needsRebind, false);

  targets.push({ launchRef: 'launch-c', sessionId: 'session-a', executionId: 'exec-c', origin: 'standalone', status: 'working', nativeTurnId: 'turn-c' });
  assert.equal(context.instructionDraftTargetFor(state, 'session-a', draft).launchRef, 'launch-b');
  assert.equal(draft.targetLaunchRef, 'launch-b');
});

test('a selected native-waiting target remains visible but cannot be saved', async () => {
  const waiting = { launchRef: 'launch-wait', sessionId: 'session-a', executionId: 'exec-wait', origin: 'standalone', status: 'waiting', nativeWaiting: [{ kind: 'question', count: 1 }] };
  const ready = { launchRef: 'launch-ready', sessionId: 'session-a', executionId: 'exec-ready', origin: 'standalone', status: 'working', nativeTurnId: 'turn-ready' };
  const state = { instructionTargets: [waiting, ready], instructionDiagnostics: { service: 'ready', targets: 'available', blocked: false } };
  const draft = { targetLaunchRef: '', mode: '', text: '' };
  const nodes = [];
  const element = (tagName, className = '', text = '') => {
    const children = [];
    const node = {
      tagName, className, textContent: String(text ?? ''), children, childNodes: children, dataset: {}, attributes: {},
      append(...items) { children.push(...items); }, setAttribute(name, value) { this.attributes[name] = String(value); }, addEventListener() {},
    };
    nodes.push(node);
    return node;
  };
  const posts = [];
  const context = pageContext(product, {
    MAX_NATIVE_PENDING_REQUESTS: Number(product.match(/const MAX_NATIVE_PENDING_REQUESTS = (\d+);/)?.[1]),
    instructionDraftFor: () => draft, instructionDrafts: new Map([['session-a', draft]]),
    instructionInFlight: new Set(), instructionErrors: new Map(), instructionNotices: new Map(), element,
    lastState: state,
    instructionTargetWaitingSummary: () => '質問 1 件',
    postUiAction: async (...args) => posts.push(args),
  });
  const names = ['instructionComposer', 'instructionDraftFor', 'instructionTargetsForSession', 'instructionTargetMode',
    'instructionModeForTarget', 'instructionBindingForTarget', 'sameInstructionBinding', 'instructionDraftTargetFor',
    'instructionDraftMatchesTarget', 'instructionDraftRebindTarget', 'instructionTargetName', 'instructionTargetStatusText',
    'instructionTargetWaitingSummary', 'instructionTargetWaitingNotice', 'instructionModeLabel', 'selectInstructionDraftTarget',
    'updateInstructionSave', 'runInstructionCreate'];
  const sources = names.map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);
  assert.equal(context.selectInstructionDraftTarget('session-a', 'launch-wait', state), true);
  draft.text = '待機中は送らない';
  context.instructionComposer({ session_id: 'session-a', instructions: [] }, state);
  assert.equal(nodes.some(node => node.checked && node.value === 'launch-wait'), true);
  const save = nodes.find(node => node.tagName === 'button' && node.textContent === '指示を保存する');
  assert.equal(save.disabled, true);
  await context.runInstructionCreate({ dataset: { instructionSession: 'session-a' }, elements: [] });
  assert.equal(posts.length, 0);
});

test('normal snapshots make a hidden instruction draft sticky through A to B to A', () => {
  const target = { launchRef: 'launch-a', sessionId: 'session-a', executionId: 'exec-a', origin: 'standalone', status: 'working', nativeTurnId: 'turn-a' };
  const state = { instructionTargets: [target], instructionDiagnostics: { service: 'ready', targets: 'available', blocked: false } };
  const draft = {
    targetLaunchRef: 'launch-a', mode: 'steer', text: '折り畳み中も保持する',
    binding: { launchRef: 'launch-a', executionId: 'exec-a', origin: 'standalone', status: 'working', nativeTurnId: 'turn-a', mode: 'steer' },
  };
  const context = pageContext(product, { instructionDrafts: new Map([['session-a', draft]]) });
  const names = ['instructionTargetsForSession', 'instructionModeForTarget', 'instructionBindingForTarget', 'sameInstructionBinding',
    'instructionDraftTargetFor', 'instructionDraftMatchesTarget', 'observeInstructionDraftBindings'];
  const sources = names.map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);

  context.observeInstructionDraftBindings(state);
  assert.equal(draft.needsRebind, undefined);
  target.status = 'waiting';
  context.observeInstructionDraftBindings(state);
  assert.equal(draft.needsRebind, true);
  target.status = 'working';
  target.nativeTurnId = 'turn-a';
  context.observeInstructionDraftBindings(state);
  assert.equal(draft.needsRebind, true);
});

test('a disappeared multi-target selection is not replaced when the old launch returns', () => {
  const targets = [
    { launchRef: 'launch-a', sessionId: 'session-a', executionId: 'exec-a', origin: 'standalone', status: 'working', nativeTurnId: 'turn-a' },
    { launchRef: 'launch-b', sessionId: 'session-a', executionId: 'exec-b', origin: 'standalone', status: 'working', nativeTurnId: 'turn-b' },
    { launchRef: 'launch-c', sessionId: 'session-a', executionId: 'exec-c', origin: 'standalone', status: 'working', nativeTurnId: 'turn-c' },
  ];
  const state = { instructionTargets: targets, instructionDiagnostics: { service: 'ready', targets: 'available', blocked: false } };
  const draft = {
    targetLaunchRef: 'launch-a', mode: 'steer', text: '対象が消えても保持する',
    binding: { launchRef: 'launch-a', executionId: 'exec-a', origin: 'standalone', status: 'working', nativeTurnId: 'turn-a', mode: 'steer' },
  };
  const nodes = [];
  const element = (tagName, className = '', text = '') => {
    const children = [];
    const node = {
      tagName, className, textContent: String(text ?? ''), children, childNodes: children, dataset: {}, attributes: {},
      append(...items) { children.push(...items); }, setAttribute(name, value) { this.attributes[name] = String(value); }, addEventListener() {},
    };
    nodes.push(node);
    return node;
  };
  const context = pageContext(product, {
    instructionDraftFor: () => draft, instructionDrafts: new Map([['session-a', draft]]),
    instructionInFlight: new Set(), instructionErrors: new Map(), instructionNotices: new Map(), element,
    MAX_NATIVE_PENDING_REQUESTS: Number(product.match(/const MAX_NATIVE_PENDING_REQUESTS = (\d+);/)?.[1]),
  });
  const names = ['instructionComposer', 'instructionDraftFor', 'instructionTargetsForSession', 'instructionTargetMode',
    'instructionModeForTarget', 'instructionBindingForTarget', 'sameInstructionBinding', 'instructionDraftTargetFor',
    'instructionDraftMatchesTarget', 'instructionDraftRebindTarget', 'observeInstructionDraftBindings',
    'instructionTargetName', 'instructionTargetStatusText', 'instructionTargetWaitingSummary', 'instructionTargetWaitingNotice',
    'instructionModeLabel'];
  const sources = names.map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);

  context.observeInstructionDraftBindings(state);
  state.instructionTargets = [targets[1], targets[2]];
  context.observeInstructionDraftBindings(state);
  assert.equal(draft.needsRebind, true);
  nodes.length = 0;
  context.instructionComposer({ session_id: 'session-a', instructions: [] }, state);
  assert.equal(draft.targetLaunchRef, 'launch-a');
  assert.equal(nodes.filter(node => node.dataset.instructionTargetSelect && node.checked).length, 0);
  assert.equal(nodes.find(node => node.tagName === 'button' && node.textContent === '指示を保存する').disabled, true);

  state.instructionTargets = [targets[0], targets[1], targets[2]];
  context.observeInstructionDraftBindings(state);
  nodes.length = 0;
  context.instructionComposer({ session_id: 'session-a', instructions: [] }, state);
  assert.equal(draft.needsRebind, true);
  assert.equal(nodes.filter(node => node.dataset.instructionTargetSelect && node.checked).length, 1);
  assert.equal(nodes.find(node => node.tagName === 'button' && node.textContent === '指示を保存する').disabled, true);
});

test('product draft rebind requires one safe current target and preserves its text', () => {
  const draft = { targetLaunchRef: 'launch-a', mode: 'steer', text: '保留していた本文' };
  const target = {
    launchRef: 'launch-a', sessionId: 'session-a', executionId: 'exec-a', origin: 'standalone',
    status: 'waiting', nativeWaiting: [{ kind: 'question', count: 1 }],
  };
  const state = { instructionTargets: [target], instructionDiagnostics: { service: 'ready', blocked: false, targets: 'available' } };
  const context = pageContext(product, {
    instructionDraftFor: () => draft,
    instructionDrafts: new Map([['session-a', draft]]),
    instructionInFlight: new Set(), instructionErrors: new Map(), instructionNotices: new Map(),
  });
  const names = ['instructionTargetsForSession', 'instructionModeForTarget', 'instructionTargetMode',
    'instructionBindingForTarget', 'instructionDraftFor', 'instructionDraftTargetFor', 'instructionDraftRebindTarget', 'rebindInstructionDraft'];
  const sources = names.map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);

  assert.equal(context.rebindInstructionDraft('session-a', state), false);
  target.status = 'working';
  target.nativeTurnId = 'turn-a';
  assert.equal(context.rebindInstructionDraft('session-a', state), true);
  assert.equal(draft.targetLaunchRef, 'launch-a');
  assert.equal(draft.mode, 'steer');
  assert.equal(draft.binding.executionId, 'exec-a');
  assert.equal(draft.binding.nativeTurnId, 'turn-a');
  assert.equal(draft.text, '保留していた本文');

  draft.deliveryAttemptId = 'uncertain-save';
  target.executionId = 'exec-b';
  assert.equal(context.rebindInstructionDraft('session-a', state), false);
  assert.equal(draft.text, '保留していた本文');
});

test('product draft observed through waiting, unverified, and multiple targets stays held across ABA until confirmed', async () => {
  const target = {
    launchRef: 'launch-a', sessionId: 'session-a', executionId: 'exec-a', origin: 'standalone',
    status: 'working', nativeTurnId: 'turn-a',
  };
  const secondTarget = {
    launchRef: 'launch-b', sessionId: 'session-a', executionId: 'exec-b', origin: 'standalone',
    status: 'working', nativeTurnId: 'turn-b',
  };
  const state = {
    instructionTargets: [target],
    instructionDiagnostics: { service: 'ready', blocked: false, targets: 'available' },
  };
  const session = { session_id: 'session-a', instructions: [] };
  const draft = { targetLaunchRef: 'launch-a', mode: 'steer', text: '保持する本文' };
  const nodes = [];
  const element = (tagName, className = '', text = '') => {
    const children = [];
    const node = {
      tagName, className, textContent: String(text ?? ''), children, childNodes: children, dataset: {}, attributes: {},
      append(...items) { children.push(...items); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener() {},
    };
    nodes.push(node);
    return node;
  };
  const posts = [];
  const context = pageContext(product, {
    instructionDraftFor: () => draft,
    instructionDrafts: new Map([['session-a', draft]]),
    instructionInFlight: new Set(), instructionErrors: new Map(), instructionNotices: new Map(),
    instructionPreviewSavePending: new Map(), instructionAlternatives: new Map(),
    MAX_NATIVE_PENDING_REQUESTS: Number(product.match(/const MAX_NATIVE_PENDING_REQUESTS = (\d+);/)?.[1]),
    postUiAction: (...args) => { posts.push(args); },
    element,
  });
  const names = [
    'instructionDraftFor', 'instructionTargetsForSession', 'instructionTargetMode', 'instructionModeForTarget', 'instructionBindingForTarget',
    'instructionDraftTargetFor', 'instructionDraftMatchesTarget', 'instructionDraftRebindTarget',
    'sameInstructionBinding', 'instructionDraftTargetFor', 'instructionDraftMatchesTarget', 'instructionDraftRebindTarget',
    'instructionTargetName', 'instructionTargetStatusText', 'instructionTargetWaitingSummary',
    'instructionTargetWaitingNotice', 'instructionModeLabel', 'instructionComposer', 'rebindInstructionDraft', 'runInstructionCreate',
  ];
  const sources = names.map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);
  draft.binding = context.instructionBindingForTarget(target, 'steer');

  const render = () => {
    nodes.length = 0;
    context.instructionComposer(session, state);
  };
  render();
  assert.equal(draft.needsRebind, undefined);

  target.status = 'waiting';
  target.nativeWaiting = [{ kind: 'question', count: 1 }];
  render();
  target.status = 'unverified';
  target.nativeWaiting = [];
  render();
  state.instructionTargets.push(secondTarget);
  render();
  assert.equal(draft.needsRebind, true);
  assert.equal(nodes.some(node => node.dataset.instructionRebind), false);

  state.instructionTargets = [target];
  target.status = 'working';
  target.nativeTurnId = 'turn-a';
  delete target.nativeWaiting;
  render();
  const save = nodes.find(node => node.tagName === 'button' && node.textContent === '指示を保存する');
  const form = nodes.find(node => node.tagName === 'form');
  assert.equal(save.disabled, true);
  assert.equal(nodes.some(node => node.dataset.instructionRebind === 'session-a'), true);
  await context.runInstructionCreate(form);
  assert.equal(posts.length, 0);

  assert.equal(context.rebindInstructionDraft('session-a', state), true);
  assert.equal(draft.needsRebind, false);
  assert.equal(draft.text, '保持する本文');
  render();
  assert.equal(nodes.find(node => node.tagName === 'button' && node.textContent === '指示を保存する').disabled, false);
});

test('saved instruction card explains native waiting while preserving missing-content and send holds', () => {
  const nodes = [];
  const element = (tagName, className = '', text = '') => {
    const children = [];
    const node = {
      tagName, className, textContent: String(text ?? ''), children, childNodes: children, dataset: {}, attributes: {},
      append(...items) { children.push(...items); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
    };
    nodes.push(node);
    return node;
  };
  const target = {
    launchRef: 'launch-wait', sessionId: 'session-a', executionId: 'execution-a', origin: 'standalone',
    status: 'waiting', nativeTurnId: 'turn-a',
    nativeWaiting: [{ kind: 'question', count: 1 }, { kind: 'approval', count: 1 }],
  };
  const context = pageContext(product, {
    MAX_NATIVE_PENDING_REQUESTS: Number(product.match(/const MAX_NATIVE_PENDING_REQUESTS = (\d+);/)?.[1]),
    absoluteTimeLabel: () => '作成時刻',
    element,
    instructionAlternatives: new Map(),
    instructionAlternativeInFlight: new Set(),
    instructionErrors: new Map(),
    instructionInFlight: new Set(),
    instructionModeLabel: () => '実行中へ伝える',
    instructionPreviewFor: () => null,
    instructionReasonLabel: reason => String(reason),
    instructionStateLabel: () => '保存済みです。送信前です。',
    instructionTargetName: () => 'Codex',
    isFinishedInstruction: () => false,
  });
  const sources = ['instructionTargetFor', 'instructionTargetMode', 'instructionTargetWaitingSummary',
    'instructionTargetWaitingNotice', 'instructionCard'].map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);

  const card = context.instructionCard({ session_id: 'session-a' }, {
    instructionDiagnostics: { service: 'ready', blocked: false },
    instructionTargets: [target],
  }, {
    deliveryAttemptId: 'attempt-a', launchRef: target.launchRef, registrationExecutionId: target.executionId,
    executionState: 'active', origin: 'standalone', mode: 'steer', state: 'available', createdAt: 1,
  });
  const cardText = [card, ...card.children, ...card.children.flatMap(child => child.children || [])]
    .map(node => node.textContent).join(' ');
  const reasons = card.children.filter(node => node.className.includes('instruction-reason')).map(node => node.textContent);
  const send = card.children.flatMap(node => node.children || []).find(node => node.dataset.instructionAction === 'send');

  assert.doesNotMatch(reasons.join(' '), /質問 1 件、許可 1 件/);
  assert.doesNotMatch(reasons.join(' '), /Codex の質問 1 件、許可 1 件待ちです/);
  assert.match(cardText, /このタブで内容を確認できないため送信できません。作成したタブで開いてください。/);
  assert.equal(send.disabled, true);
  assert.doesNotMatch(cardText, /native_request_pending|回答する|許可する/);
});

test('unconfigured instruction integration hides composers and recovery panels without clearing pending data', () => {
  const pendingPreview = new Map([['attempt-a', { phase: 'pending', text: '保持する本文', instruction: {} }]]);
  const pendingAlternative = new Map([['attempt-b', { pendingRequest: { text: '別の本文' } }]]);
  const context = pageContext(product, {
    instructionPreviewSavePending: pendingPreview,
    instructionAlternatives: pendingAlternative,
  });
  const names = ['instructionPreviewRecoveryPanel', 'instructionAlternativeRecoveryPanel', 'instructionComposer'];
  const sources = names.map(name => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);

  const state = { instructionDiagnostics: { configuration: 'unconfigured' } };
  assert.equal(context.instructionComposer({}, state), null);
  assert.equal(context.instructionPreviewRecoveryPanel(state), null);
  assert.equal(context.instructionAlternativeRecoveryPanel(state), null);
  assert.equal(pendingPreview.size, 1);
  assert.equal(pendingAlternative.size, 1);
});

test('mock Codex native question and approval wait keeps the draft and blocks instruction send', () => {
  const session = {
    id: 'session-native-wait', title: 'Codex native wait', status: 'busy', perms: [], decisions: [], commonQuestions: [],
    nativeInstructionWaiting: [{ kind: 'question', count: 1 }, { kind: 'approval', count: 2 }],
  };
  const { context, ui, product } = composerContext(session);
  ui.instructionDrafts['session-native-wait'] = { targetSessionId: 'session-native-wait', mode: 'steer', text: '保持する下書き' };

  const html = context.instructionComposer(product, session);

  assert.match(html, /Codex の質問 1 件、許可 2 件待ちです。追加の指示は保留されています。入力内容は保持されます。/);
  assert.match(html, /<textarea[^>]*>保持する下書き<\/textarea>/);
  assert.doesNotMatch(html, /value="steer"/);
  assert.match(html, /data-instruction-save="session-native-wait" disabled/);
  assert.doesNotMatch(html, /回答する|許可する/);
});

test('mock saved instruction stays unsendable during native waiting without duplicating the composer notice', () => {
  const session = {
    id: 'session-native-wait', title: 'Codex native wait', status: 'busy', perms: [], decisions: [], commonQuestions: [],
    nativeInstructionWaiting: [{ kind: 'question', count: 1 }],
  };
  const record = {
    deliveryAttemptId: 'attempt-a', executionId: session.id, sessionId: session.id, origin: 'standalone',
    mode: 'steer', state: 'available', createdAt: 1, text: '保存済みの本文',
  };
  const ui = { instructionPreviewRecoveries: {}, instructionPreviews: {}, instructionAlternatives: {} };
  const context = pageContext(mock, {
    ui, DATA: { integrations: { instructions: true } }, MAX_NATIVE_PENDING_REQUESTS: 16,
    instructionModeText: mode => mode, instructionStateText: () => '保存済みです。送信前です。',
    absoluteTimeLabel: () => '作成時刻',
    isFinishedInstructionRecord: () => false,
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
  });
  const sources = ['instructionTargetAvailability', 'instructionPreviewText', 'canSendSavedInstruction', 'instructionCard']
    .map(name => functionSource(mock, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);

  const html = context.instructionCard(session, record);
  assert.match(html, /data-instruction-action="send"[^>]*disabled/);
  assert.doesNotMatch(html, /質問 1 件待ちです/);
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
    'registerMockInstructionPreviewRecovery', 'instructionPreviewText', 'canSendSavedInstruction',
    'saveMockInstructionPreviewRecovery', 'instructionPreviewRecoveryPanel', 'instructionCard',
  ];
  const sources = names.map(name => functionSource(mock, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);

  assert.match(context.instructionPreviewRecoveryPanel(), /保存済みの指示本文/);
  assert.match(context.instructionPreviewRecoveryPanel(), new RegExp(body));
  assert.match(context.instructionPreviewRecoveryPanel(), /<section class="instruction-recovery"[^>]*>[\s\S]*<article class="decision"/);
  assert.match(context.instructionPreviewRecoveryPanel(), /class="decision-summary instruction-preview"[\s\S]*class="answer-foot"/);
  assert.doesNotMatch(context.instructionPreviewRecoveryPanel(), /class="instruction-card|class="instruction-actions/);
  const render = functionSource(mock, 'render');
  assert.ok(render);
  assert.match(render, /instructionPreviewRecoveryPanel\(\)/);
  assert.match(render, /insertAdjacentHTML\('afterbegin', previewRecovery\)/);
  assert.match(render, /active\?\.dataset\?\.instructionPreviewRecovery/);
  assert.match(functionSource(mock, 'instructionCard'), /class="dtitle" tabindex="-1"/);
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
  assert.match(recoveredCard, /data-instruction-action="send" data-instruction-id="mock-instruction-preview-recovery"\s*>/);
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
  const target = {
    launchRef: 'launch-a', sessionId: 'session-a', executionId: 'execution-a', origin: 'standalone',
    status: 'working', nativeTurnId: 'turn-a',
  };
  const draft = {
    targetLaunchRef: 'launch-a', mode: 'steer', text: '通常の指示', deliveryAttemptId: 'stable-attempt', logicalMessageId: 'stable-logical',
    binding: { launchRef: target.launchRef, executionId: target.executionId, origin: target.origin, status: target.status, nativeTurnId: target.nativeTurnId, mode: 'steer' },
  };
  const instructionDrafts = new Map([['session-a', draft]]);
  const instructionPreviews = new Map();
  const instructionPreviewSavePending = new Map();
  const state = { instructionTargets: [target], instructionDiagnostics: { service: 'ready', blocked: false, targets: 'available' } };
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
    'validScopedInstructionId', 'instructionDraftFor', 'instructionTargetFor', 'instructionTargetsForSession', 'instructionDraftTargetFor',
    'instructionTargetMode', 'instructionModeForTarget', 'instructionBindingForTarget', 'sameInstructionBinding',
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
  draft.binding = { launchRef: target.launchRef, executionId: target.executionId, origin: target.origin, status: 'stopped', nativeTurnId: null, mode: 'start' };
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
