const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionSource, pageContext } = require('./support/page-context');

const product = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
const limit = Number(product.match(/const MAX_NATIVE_PENDING_REQUESTS = (\d+);/)?.[1]);
const stopConfirmationLimit = Number(product.match(/const MAX_OWNED_EXECUTION_STOP_CONFIRMATIONS = (\d+);/)?.[1]);
const requestFields = ['launchRef', 'executionId', 'sessionId', 'expectedContextId', 'expectedOwnerGeneration', 'stopRevision'];

function owner(overrides = {}) {
  return {
    launchRef: 'launch-a', executionId: 'execution-a', sessionId: 'session-a', expectedContextId: 'context-a',
    expectedOwnerGeneration: 2, stopRevision: 0, processState: 'running', canStop: true, stopConfirmed: false,
    hold: { reason: null, retainedRequestCount: 4, remainingRequestCount: limit - 4, limit },
    ...overrides,
  };
}

function target(overrides = {}) {
  return {
    launchRef: 'launch-a', executionId: 'execution-a', sessionId: 'session-a', origin: 'standalone',
    status: 'working', nativeTurnId: 'turn-a', identity: { provider: 'codex', nativeId: 'thread-a' },
    ...overrides,
  };
}

function harness(state, postUiAction = async () => ({ status: 200, ok: true, json: async () => ({}) })) {
  const draft = { text: '保持する指示', targetLaunchRef: 'launch-a', mode: 'steer' };
  const sandbox = {
    MAX_NATIVE_PENDING_REQUESTS: limit,
    MAX_OWNED_EXECUTION_STOP_CONFIRMATIONS: stopConfirmationLimit,
    OWNED_EXECUTION_PROCESS_STATES: new Set(['not_started', 'starting', 'running', 'stopping', 'stopped', 'stop_unconfirmed', 'disconnected', 'quarantined', 'failed']),
    ownedExecutionStopConfirmations: new Map(),
    ownedExecutionStopInFlight: new Set(),
    ownedExecutionStopErrors: new Map(),
    ownedExecutionStopUnverified: new Map(),
    ownedExecutionStopConfirmed: new Map(),
    lastState: state,
    instructionDrafts: new Map([['session-a', draft]]),
    liveStatus: { textContent: '' },
    postUiAction,
    render() {},
    refresh: async () => {},
    showWriteError() {},
  };
  const names = [
    'validScopedInstructionId', 'normalizeOwnedExecution', 'ownedExecutionStopKey', 'ownedExecutionCandidatesForTarget', 'ownedExecutionGate',
    'instructionTargetMode', 'instructionModeForTarget', 'instructionTargetsForSession', 'ownedExecutionCardsForSession',
    'ownedExecutionStopRequest', 'sameOwnedExecutionStopRequest', 'sameOwnedExecutionStopIdentity', 'ownedExecutionForLaunch', 'adoptOwnedExecution',
    'reconcileOwnedExecutionStopState', 'ownedExecutionCanStop', 'ownedExecutionResponseMatchesRequest', 'ownedExecutionGateReason', 'instructionTargetWaitingNotice',
    'openOwnedExecutionStopConfirmation', 'cancelOwnedExecutionStopConfirmation', 'runOwnedExecutionStop',
  ];
  const context = pageContext(product, sandbox);
  const sources = names.map((name) => functionSource(product, name));
  assert.ok(sources.every(Boolean));
  vm.runInContext(sources.join('\n'), context);
  return { context, draft, state };
}

function readyState(execution = owner(), runTarget = target()) {
  return {
    ownedExecutionDiagnostics: { status: 'ready' },
    ownedExecutions: [execution],
    instructionTargets: [runTarget],
    sessions: [{ session_id: 'session-a', instructions: [] }],
  };
}

test('owned execution DTO validation rejects inconsistent capacity and unknown fields', () => {
  const { context } = harness(readyState());
  assert.ok(context.normalizeOwnedExecution(owner()));
  assert.equal(context.normalizeOwnedExecution(owner({ hold: { reason: 'capacity', retainedRequestCount: limit, remainingRequestCount: 0, limit } })).hold.reason, 'capacity');
  assert.ok(context.normalizeOwnedExecution(owner({ hold: { reason: null, retainedRequestCount: limit, remainingRequestCount: 0, limit } })));
  assert.ok(context.normalizeOwnedExecution(owner({ hold: { reason: 'unknown', retainedRequestCount: limit, remainingRequestCount: 0, limit } })));
  assert.equal(context.normalizeOwnedExecution({ ...owner(), unexpected: true }), null);
});

test('unavailable or missing owned execution state fails closed for stop and instruction delivery', () => {
  const runTarget = target();
  const unavailable = harness({ ownedExecutionDiagnostics: { status: 'unavailable' }, ownedExecutions: [], instructionTargets: [runTarget] });
  assert.equal(unavailable.context.ownedExecutionCanStop(unavailable.state, null), false);
  assert.equal(unavailable.context.instructionTargetMode(runTarget, 'steer', unavailable.state), false);
  const missing = harness({ ownedExecutionDiagnostics: { status: 'ready' }, instructionTargets: [runTarget] });
  assert.equal(missing.context.instructionTargetMode(runTarget, 'steer', missing.state), false);
  const missingDiagnostics = harness({ instructionTargets: [runTarget] });
  assert.equal(missingDiagnostics.context.ownedExecutionGate(missingDiagnostics.state, runTarget).state, 'unknown');
  assert.equal(missingDiagnostics.context.instructionTargetMode(runTarget, 'steer', missingDiagnostics.state), false);
});

test('a failed execution blocks delivery but remains stoppable when the API allows it', () => {
  const runTarget = target({ status: 'working' });
  const failed = owner({ processState: 'failed', canStop: true });
  const { context, state } = harness(readyState(failed, runTarget));
  assert.equal(context.ownedExecutionGate(state, runTarget).state, 'unknown');
  assert.equal(context.instructionTargetMode(runTarget, 'steer', state), false);
  assert.equal(context.ownedExecutionCanStop(state, failed), true);
  assert.equal(context.ownedExecutionCardsForSession(state, 'session-a')[0].gate.state, 'unknown');
});

test('a confirmed stop reason takes precedence over an unverified instruction target', () => {
  const runTarget = target({ status: 'unverified', nativeTurnId: null });
  const stopped = owner({ processState: 'stopped', canStop: false, stopConfirmed: true, stopRevision: 1 });
  const { context, state } = harness(readyState(stopped, runTarget));
  assert.equal(context.ownedExecutionGate(state, runTarget).state, 'stopped');
  assert.match(context.instructionTargetWaitingNotice(runTarget, state), /停止を確認済みです/);
  assert.doesNotMatch(context.instructionTargetWaitingNotice(runTarget, state), /実行状態を確認できない/);
});

test('a session groups native question and approval counts into one execution card', () => {
  const runTarget = target({
    status: 'waiting', nativeTurnId: null,
    nativeWaiting: [{ kind: 'question', count: 127 }, { kind: 'approval', count: 1 }],
  });
  const execution = owner({ hold: { reason: 'capacity', retainedRequestCount: limit, remainingRequestCount: 0, limit } });
  const { context, state } = harness(readyState(execution, runTarget));
  const cards = context.ownedExecutionCardsForSession(state, 'session-a');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].gate.state, 'capacity');
});

test('confirmation captures its six identity fields and closes when the target changes', () => {
  const state = readyState();
  const { context } = harness(state);
  assert.equal(context.openOwnedExecutionStopConfirmation('launch-a', 'session-a', state), true);
  assert.deepEqual(JSON.parse(JSON.stringify([...context.ownedExecutionStopConfirmations.entries()][0][1])), {
    launchRef: 'launch-a', executionId: 'execution-a', sessionId: 'session-a', expectedContextId: 'context-a',
    expectedOwnerGeneration: 2, stopRevision: 0,
  });
  state.ownedExecutions[0] = owner({ stopRevision: 1 });
  context.reconcileOwnedExecutionStopState(state);
  assert.equal(context.ownedExecutionStopConfirmations.has('launch-a'), false);
  assert.match(context.ownedExecutionStopErrors.get('launch-a'), /状態が変わりました/);
});

test('stop sends exactly the captured fields and keeps drafts blocked after an unconfirmed result', async () => {
  const posts = [];
  const state = readyState();
  const returnedOwner = owner({ processState: 'stop_unconfirmed', canStop: true, stopRevision: 1 });
  const { context, draft } = harness(state, async (url, body) => {
    posts.push({ url, body: JSON.parse(JSON.stringify(body)) });
    return { status: 200, ok: true, json: async () => ({ status: 'stop_unconfirmed', ownedExecution: returnedOwner }) };
  });
  context.openOwnedExecutionStopConfirmation('launch-a', 'session-a', state);
  await context.runOwnedExecutionStop({ dataset: { ownedExecutionStopConfirm: 'launch-a', ownedExecutionStopSession: 'session-a' } });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/executions/stop');
  assert.deepEqual(Object.keys(posts[0].body), requestFields);
  assert.deepEqual(posts[0].body, {
    launchRef: 'launch-a', executionId: 'execution-a', sessionId: 'session-a', expectedContextId: 'context-a',
    expectedOwnerGeneration: 2, stopRevision: 0,
  });
  assert.equal(draft.text, '保持する指示');
  assert.equal(context.instructionTargetMode(state.instructionTargets[0], 'steer', state), false);
  assert.equal(context.ownedExecutionStopUnverified.has('launch-a'), true);
});

test('a confirmed stop stays blocked when a stale running snapshot arrives afterward', async () => {
  const state = readyState();
  const stopped = owner({ processState: 'stopped', canStop: false, stopConfirmed: true, stopRevision: 1 });
  const { context } = harness(state, async () => ({
    status: 200, ok: true, json: async () => ({ status: 'stop_confirmed', ownedExecution: stopped }),
  }));
  context.refresh = async () => { state.ownedExecutions = [owner()]; };
  context.openOwnedExecutionStopConfirmation('launch-a', 'session-a', state);
  await context.runOwnedExecutionStop({ dataset: { ownedExecutionStopConfirm: 'launch-a', ownedExecutionStopSession: 'session-a' } });

  assert.equal(context.ownedExecutionGate(state, state.instructionTargets[0]).state, 'stopped');
  assert.equal(context.instructionTargetMode(state.instructionTargets[0], 'steer', state), false);
  assert.equal(context.ownedExecutionCanStop(state, state.ownedExecutions[0]), false);
  const card = context.ownedExecutionCardsForSession(state, 'session-a');
  assert.equal(card.length, 1);
  assert.equal(card[0].gate.state, 'stopped');
});

test('the confirmation latch limit blocks new stop requests without discarding confirmed stops', () => {
  const state = readyState();
  const { context } = harness(state);
  for (let index = 0; index < stopConfirmationLimit; index += 1) {
    context.ownedExecutionStopConfirmed.set(`prior-${index}`, true);
  }
  assert.equal(context.ownedExecutionCanStop(state, state.ownedExecutions[0]), false);
  assert.equal(context.ownedExecutionStopConfirmed.size, stopConfirmationLimit);
});

test('stale stop response adopts current state without retrying the old request', async () => {
  const posts = [];
  const state = readyState();
  const current = owner({ stopRevision: 1 });
  const { context } = harness(state, async (url, body) => {
    posts.push(body);
    return { status: 409, ok: false, json: async () => ({ error: 'stale_owned_execution', ownedExecution: current }) };
  });
  context.openOwnedExecutionStopConfirmation('launch-a', 'session-a', state);
  await context.runOwnedExecutionStop({ dataset: { ownedExecutionStopConfirm: 'launch-a', ownedExecutionStopSession: 'session-a' } });
  assert.equal(posts.length, 1);
  assert.equal(state.ownedExecutions[0].stopRevision, 1);
  assert.equal(context.ownedExecutionStopUnverified.has('launch-a'), true);
  assert.equal(context.ownedExecutionGate(state, state.instructionTargets[0]).state, 'unconfirmed');
});

test('a stale response for another execution cannot clear the old execution hold', async () => {
  const state = readyState();
  const otherExecution = owner({ executionId: 'execution-b', processState: 'stopped', stopConfirmed: false, stopRevision: 1 });
  const { context } = harness(state, async () => ({
    status: 409, ok: false, json: async () => ({ error: 'stale_owned_execution', ownedExecution: otherExecution }),
  }));
  context.openOwnedExecutionStopConfirmation('launch-a', 'session-a', state);
  await context.runOwnedExecutionStop({ dataset: { ownedExecutionStopConfirm: 'launch-a', ownedExecutionStopSession: 'session-a' } });
  state.ownedExecutions = [owner()];
  context.reconcileOwnedExecutionStopState(state);

  assert.equal(context.ownedExecutionStopUnverified.has('launch-a'), true);
  assert.equal(context.ownedExecutionGate(state, state.instructionTargets[0]).state, 'unconfirmed');
});
