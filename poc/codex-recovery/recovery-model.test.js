'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RecoveryModel, validateCheckpoint } = require('./recovery-model');

function makeBinding(overrides = {}) {
  return {
    provider: 'codex',
    hostId: 'host-1',
    homeScope: 'home-1',
    threadId: 'thread-1',
    launchId: 'launch-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 'session-1', agentId: 'agent-1', toolUseId: 'tool-1' },
    ...overrides,
  };
}

function register(model, binding = makeBinding()) {
  assert.equal(model.registerBinding(binding).accepted, true);
  return binding;
}

function makeDelivery(overrides = {}) {
  return {
    requestId: 'request-1',
    deliveryId: null,
    state: 'registered',
    target: 'existing_turn',
    targetTurnId: 'turn-1',
    questionId: null,
    payload: { text: 'continue the registered task' },
    acceptedTurnId: null,
    appliedEvidence: null,
    ...overrides,
  };
}

function currentProof(binding, overrides = {}) {
  return {
    source: 'current_loaded',
    identity: {
      provider: binding.provider,
      hostId: binding.hostId,
      homeScope: binding.homeScope,
      threadId: binding.threadId,
    },
    threadState: 'active',
    activeTurnId: 'turn-1',
    endObserved: false,
    waitingForQuestion: false,
    waitingForApproval: false,
    ...overrides,
  };
}

function reconcile(model, binding, proof = currentProof(binding), bridge = { registered: true, binding, runState: 'active' }) {
  return model.reconcileCurrent({ binding, currentBridgeRegistration: bridge, currentNativeProof: proof });
}

test('登録されたmainとchildの完全な親識別をcheckpointへ保持する', () => {
  const model = new RecoveryModel();
  const main = makeBinding({ launchId: 'main-launch', runId: 'main-run', attemptId: 'main-attempt',
    parent: { provider: 'claude', sessionId: 'session-main', toolUseId: 'tool-main' } });
  const child = makeBinding({ launchId: 'child-launch', runId: 'child-run', attemptId: 'child-attempt',
    parent: { provider: 'claude', sessionId: 'session-main', agentId: 'agent-child', toolUseId: 'tool-child' } });
  assert.equal(model.registerBinding(main).accepted, true);
  assert.equal(model.registerBinding(child).accepted, true);
  const checkpoint = model.checkpoint();
  assert.equal(checkpoint.bindings.length, 2);
  const childRow = checkpoint.bindings.find((row) => row.binding.launchId === 'child-launch');
  assert.equal(childRow.binding.parent.provider, 'claude');
  assert.equal(childRow.binding.parent.agentId, 'agent-child');
});

test('同じbinding登録は冪等で異なる親やattemptの上書きを拒否する', () => {
  const model = new RecoveryModel();
  const binding = makeBinding();
  assert.equal(model.registerBinding(binding).accepted, true);
  assert.equal(model.registerBinding({ ...binding, parent: { ...binding.parent } }).reason, 'duplicate_binding');
  assert.equal(model.registerBinding({ ...binding, parent: { ...binding.parent, toolUseId: 'other-tool' } }).reason,
    'binding_conflict');
  assert.equal(model.registerBinding({ ...binding, attemptId: 'attempt-2' }).reason, 'registered');
});

test('standaloneはparentなしを許可しdelegatedは親識別を要求する', () => {
  const model = new RecoveryModel();
  assert.equal(model.registerBinding(makeBinding({ origin: 'standalone', parent: null })).accepted, true);
  assert.equal(model.registerBinding(makeBinding({ threadId: 'thread-2', origin: 'delegated', parent: null })).reason,
    'invalid_binding');
});

test('bindingは不正な識別子や余分なフィールドを拒否する', () => {
  const model = new RecoveryModel();
  assert.equal(model.registerBinding(makeBinding({ hostId: 'Bearer abcdefghijklmnop' })).reason, 'invalid_binding');
  assert.equal(model.registerBinding({ ...makeBinding(), cwd: 'C:/workspace' }).reason, 'invalid_binding');
});

test('credentialや環境情報を含む台帳データを拒否する', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  assert.equal(model.upsertPlan({ binding, plan: { planId: 'plan-1', state: 'active', data: { token: 'sk-abcdefghijk' } } }).accepted,
    false);
  assert.equal(model.upsertQuestion({ binding, question: { questionId: 'question-1', state: 'pending',
    data: { environment: { CLAUDE_CODE_MESSAGING_TOKEN: 'hidden' } } } }).accepted, false);
  assert.equal(model.upsertPlan({ binding, plan: { planId: 'plan-token', state: 'active', data: { token: 'opaque-value' } } }).accepted,
    false);
  assert.equal(model.upsertPlan({ binding, plan: { planId: 'plan-2', state: 'active', data: { pid: 42 } } }).accepted, false);
});

test('checkpointはplain JSONを複製し呼び出し側の変更から内部状態を隔離する', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  model.upsertPlan({ binding, plan: { planId: 'plan-1', state: 'active', data: { summary: 'saved plan' } } });
  const checkpoint = model.checkpoint();
  checkpoint.bindings[0].plans[0].data.summary = 'caller mutation';
  assert.equal(model.project().rows[0].plans[0].data.summary, 'saved plan');
  assert.equal(Object.getPrototypeOf(model.checkpoint()), Object.prototype);
});

test('restoreは実行中状態をunknownへ移し回答や終端を復活させない', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  const activeBinding = register(model, makeBinding({ hostId: 'host-active', homeScope: 'home-active',
    threadId: 'thread-active', launchId: 'launch-active', runId: 'run-active', attemptId: 'attempt-active' }));
  model.ingestEvent({ binding, stream: 'bridge', generation: 1, ordinal: 1, eventId: 'run-start',
    recordType: 'run', record: { state: 'active' } });
  model.upsertPlan({ binding, plan: { planId: 'plan-1', state: 'active', data: { summary: 'plan' } } });
  model.upsertQuestion({ binding, question: { questionId: 'question-1', state: 'pending', data: { prompt: 'Choose' } } });
  model.upsertDelivery({ binding, delivery: makeDelivery({ state: 'sending', deliveryId: 'delivery-1' }) });
  model.upsertDelivery({ binding, delivery: makeDelivery({ requestId: 'request-2', state: 'accepted', deliveryId: 'delivery-2',
    acceptedTurnId: 'turn-1' }) });
  model.upsertDelivery({ binding, delivery: makeDelivery({ requestId: 'request-3', state: 'resolved', deliveryId: 'delivery-3' }) });
  model.ingestEvent({ binding, stream: 'bridge', generation: 1, ordinal: 2, eventId: 'run-end',
    recordType: 'run', record: { state: 'ended' } });
  model.ingestEvent({ binding: activeBinding, stream: 'bridge', generation: 1, ordinal: 1, eventId: 'active-only',
    recordType: 'run', record: { state: 'active' } });

  const restored = RecoveryModel.restore(model.checkpoint());
  const row = restored.project().rows.find((item) => item.binding.threadId === binding.threadId);
  const activeRow = restored.project().rows.find((item) => item.binding.threadId === activeBinding.threadId);
  assert.equal(row.runState, 'ended');
  assert.equal(activeRow.runState, 'unknown');
  assert.equal(row.plans[0].state, 'active');
  assert.equal(row.plans[0].held, true);
  assert.equal(row.questions[0].state, 'unknown');
  assert.equal(row.questions[0].restoredFromState, 'pending');
  assert.equal(row.deliveries.find((item) => item.requestId === 'request-1').state, 'unknown');
  assert.equal(row.deliveries.find((item) => item.requestId === 'request-2').state, 'unknown');
  assert.equal(row.deliveries.find((item) => item.requestId === 'request-3').state, 'resolved');
});

test('restore後の完全なcurrent bridge/native一致だけが解除対象を照合する', () => {
  const model = new RecoveryModel();
  const binding = register(model, makeBinding({ origin: 'standalone', parent: null }));
  model.upsertDelivery({ binding, delivery: makeDelivery({ target: 'turn_start', targetTurnId: null }) });
  const restored = RecoveryModel.restore(model.checkpoint());
  let row = restored.project().rows[0];
  assert.equal(row.deliveries[0].readyToDeliver, false);
  assert.equal(reconcile(restored, binding, currentProof(binding, { threadState: 'idle', activeTurnId: null })).accepted, true);
  row = restored.project().rows[0];
  assert.equal(row.deliveries[0].readyToDeliver, true);
});

test('saved historyと未ロードthreadはcurrent proofにならない', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  for (const [source, reason] of [['history', 'history_is_not_current'], ['not_loaded', 'thread_not_loaded']]) {
    const result = reconcile(model, binding, currentProof(binding, { source }));
    assert.equal(result.accepted, false);
    assert.equal(result.reason, reason);
    assert.equal(model.project().rows[0].reconciliation.status, 'unknown');
  }
});

test('binding不一致と終了証拠欠落ではunknownを維持する', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  assert.equal(reconcile(model, binding, currentProof(binding), { registered: true, runState: 'active',
    binding: { ...binding, threadId: 'other-thread' } }).reason, 'bridge_binding_mismatch');
  assert.equal(reconcile(model, binding, currentProof(binding, { threadState: 'ended', activeTurnId: null,
    endObserved: false })).reason, 'current_state_incomplete');
  assert.equal(model.project().rows[0].reconciliation.status, 'unknown');
});

test('accepted回答は同じrequest delivery digest turn itemの証拠だけでappliedになる', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  const sending = makeDelivery({ state: 'accepted', deliveryId: 'delivery-1', acceptedTurnId: 'turn-1' });
  model.upsertDelivery({ binding, delivery: sending });
  const payloadDigest = model.project().rows[0].deliveries[0].payloadDigest;
  const proof = currentProof(binding, { deliveryEvidence: [{ requestId: 'request-1', deliveryId: 'delivery-1',
    turnId: 'turn-1', itemId: 'item-1', itemType: 'user_input', payloadDigest }] });
  assert.equal(reconcile(model, binding, proof).appliedDeliveries, 1);
  const delivery = model.project().rows[0].deliveries[0];
  assert.equal(delivery.state, 'applied');
  assert.equal(delivery.appliedEvidence.itemId, 'item-1');
});

test('wrong request digest turn or item type cannot apply a delivery', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  model.upsertDelivery({ binding, delivery: makeDelivery({ state: 'accepted', deliveryId: 'delivery-1', acceptedTurnId: 'turn-1' }) });
  const payloadDigest = model.project().rows[0].deliveries[0].payloadDigest;
  const evidence = { requestId: 'request-1', deliveryId: 'delivery-1', turnId: 'turn-1', itemId: 'item-1',
    itemType: 'user_input', payloadDigest };
  const result = reconcile(model, binding, currentProof(binding, { deliveryEvidence: [
    { ...evidence, requestId: 'other-request' }, { ...evidence, payloadDigest: '0'.repeat(64) },
    { ...evidence, turnId: 'other-turn' },
  ] }));
  assert.equal(result.appliedDeliveries, 0);
  assert.equal(reconcile(model, binding, currentProof(binding, { deliveryEvidence: [
    { ...evidence, itemType: 'assistant_message' },
  ] })).reason, 'invalid_native_proof');
  assert.equal(model.project().rows[0].deliveries[0].state, 'accepted');
});

test('delegated delivery requires its existing active turn; review is never deliverable', () => {
  const delegated = new RecoveryModel();
  const binding = register(delegated);
  const deliveries = [
    makeDelivery({ requestId: 'existing', target: 'existing_turn' }),
    makeDelivery({ requestId: 'expected', target: 'expected_turn' }),
    makeDelivery({ requestId: 'start', target: 'turn_start', targetTurnId: null }),
  ];
  for (const delivery of deliveries) delegated.upsertDelivery({ binding, delivery });
  reconcile(delegated, binding);
  const delegatedRows = delegated.project().rows[0].deliveries;
  assert.equal(delegatedRows.find((item) => item.requestId === 'existing').readyToDeliver, true);
  assert.equal(delegatedRows.find((item) => item.requestId === 'expected').readyToDeliver, false);
  assert.equal(delegatedRows.find((item) => item.requestId === 'start').readyToDeliver, false);

  const review = new RecoveryModel();
  const reviewBinding = register(review, makeBinding({ origin: 'review', hostId: 'host-review',
    homeScope: 'home-review', threadId: 'thread-review', launchId: 'review-launch', runId: 'review-run',
    attemptId: 'review-attempt' }));
  review.upsertDelivery({ binding: reviewBinding, delivery: makeDelivery() });
  reconcile(review, reviewBinding);
  assert.equal(review.project().rows[0].deliveries[0].readyToDeliver, false);
});

test('standalone may start an idle thread only when the registered run is active', () => {
  const model = new RecoveryModel();
  const binding = register(model, makeBinding({ origin: 'standalone', parent: null }));
  model.upsertDelivery({ binding, delivery: makeDelivery({ target: 'turn_start', targetTurnId: null }) });
  model.upsertDelivery({ binding, delivery: makeDelivery({ requestId: 'active-steer', target: 'expected_turn' }) });
  reconcile(model, binding, currentProof(binding, { threadState: 'idle', activeTurnId: null }));
  const rows = model.project().rows[0].deliveries;
  assert.equal(rows.find((item) => item.requestId === 'request-1').readyToDeliver, true);
  assert.equal(rows.find((item) => item.requestId === 'active-steer').readyToDeliver, false);
  reconcile(model, binding);
  const activeRows = model.project().rows[0].deliveries;
  assert.equal(activeRows.find((item) => item.requestId === 'request-1').readyToDeliver, false);
  assert.equal(activeRows.find((item) => item.requestId === 'active-steer').readyToDeliver, true);

  const unknownRun = new RecoveryModel();
  const unknownBinding = register(unknownRun, makeBinding({ origin: 'standalone', parent: null,
    hostId: 'host-unknown', homeScope: 'home-unknown', threadId: 'thread-unknown', launchId: 'launch-unknown',
    runId: 'run-unknown', attemptId: 'attempt-unknown' }));
  unknownRun.upsertDelivery({ binding: unknownBinding, delivery: makeDelivery({ target: 'turn_start', targetTurnId: null }) });
  reconcile(unknownRun, unknownBinding, currentProof(unknownBinding, { threadState: 'idle', activeTurnId: null }),
    { registered: true, binding: unknownBinding, runState: 'unknown' });
  assert.equal(unknownRun.project().rows[0].deliveries[0].readyToDeliver, false);
});

test('question or approval waits and unknown wait flags hold ordinary delivery', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  model.upsertDelivery({ binding, delivery: makeDelivery() });
  assert.equal(reconcile(model, binding).accepted, true);
  assert.equal(model.project().rows[0].deliveries[0].readyToDeliver, true);
  for (const patch of [{ waitingForQuestion: true }, { waitingForApproval: true }, { waitingForQuestion: null }]) {
    assert.equal(reconcile(model, binding, currentProof(binding, patch)).accepted, true);
    const row = model.project().rows[0];
    assert.equal(row.deliveries[0].readyToDeliver, false);
    assert.equal(row.deliveries[0].held, true);
  }
});

test('collector切断や不正な再照合は以前のready状態を解除する', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  model.upsertDelivery({ binding, delivery: makeDelivery() });
  reconcile(model, binding);
  assert.equal(model.project().rows[0].deliveries[0].readyToDeliver, true);
  assert.equal(model.markCurrentProofUnavailable({ binding, reason: 'collector_disconnected' }).accepted, true);
  assert.equal(model.project().rows[0].deliveries[0].readyToDeliver, false);

  reconcile(model, binding);
  assert.equal(model.project().rows[0].deliveries[0].readyToDeliver, true);
  assert.equal(reconcile(model, binding, { source: 'current_loaded' }).reason, 'invalid_native_proof');
  assert.equal(model.project().rows[0].deliveries[0].readyToDeliver, false);
});

test('nativeまたはbridgeの明示終了は後続のactive proofで復活しない', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  model.upsertDelivery({ binding, delivery: makeDelivery() });
  assert.equal(reconcile(model, binding, currentProof(binding, { threadState: 'ended', activeTurnId: null,
    endObserved: true })).accepted, true);
  assert.equal(model.project().rows[0].runState, 'ended');
  reconcile(model, binding, currentProof(binding), { registered: true, binding, runState: 'active' });
  assert.equal(model.project().rows[0].runState, 'ended');
  assert.equal(model.project().rows[0].deliveries[0].readyToDeliver, false);
});

test('同じnative itemを別requestへ二重所有させない', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  const first = makeDelivery({ state: 'accepted', deliveryId: 'delivery-1', acceptedTurnId: 'turn-1' });
  const second = makeDelivery({ requestId: 'request-2', state: 'accepted', deliveryId: 'delivery-2', acceptedTurnId: 'turn-1' });
  model.upsertDelivery({ binding, delivery: first });
  model.upsertDelivery({ binding, delivery: second });
  const payloadDigest = model.project().rows[0].deliveries[0].payloadDigest;
  const common = { deliveryId: 'delivery-1', turnId: 'turn-1', itemId: 'item-1', itemType: 'user_input', payloadDigest };
  const result = reconcile(model, binding, currentProof(binding, { deliveryEvidence: [
    { ...common, requestId: 'request-1' }, { ...common, requestId: 'request-2', deliveryId: 'delivery-2' },
  ] }));
  assert.equal(result.appliedDeliveries, 0);
  assert.deepEqual(model.project().rows[0].deliveries.map((item) => item.state), ['accepted', 'accepted']);
});

test('direct registration cannot claim native-applied state without current proof', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  const payloadDigest = require('../codex-instruction-delivery/delivery-model').digestPayload({ text: 'continue the registered task' });
  const result = model.upsertDelivery({ binding, delivery: makeDelivery({ state: 'applied', deliveryId: 'delivery-1',
    acceptedTurnId: 'turn-1', payloadDigest, appliedEvidence: { turnId: 'turn-1', itemId: 'item-1', itemType: 'user_input' } }) });
  assert.deepEqual(result, { accepted: false, reason: 'native_current_proof_required' });
});

test('同一event再送は冪等で逆順と同一ordinalの別eventは拒否する', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  const event = { binding, stream: 'bridge', generation: 2, ordinal: 3, eventId: 'event-3', recordType: 'run',
    record: { state: 'active' } };
  assert.equal(model.ingestEvent(event).accepted, true);
  assert.equal(model.ingestEvent(event).reason, 'duplicate_event');
  assert.equal(model.ingestEvent({ ...event, eventId: 'event-2', ordinal: 2 }).reason, 'stale_event_order');
  assert.equal(model.ingestEvent({ ...event, eventId: 'event-other' }).reason, 'event_order_conflict');
  assert.equal(model.project().counts.events, 1);
});

test('同一event IDはbinding scopeごとに分離しgeneration巻き戻しは拒否する', () => {
  const model = new RecoveryModel();
  const first = register(model);
  const second = register(model, makeBinding({ hostId: 'host-2', homeScope: 'home-2', threadId: 'thread-2' }));
  for (const binding of [first, second]) {
    assert.equal(model.ingestEvent({ binding, stream: 'native', generation: 1, ordinal: 1, eventId: 'local-1',
      recordType: 'run', record: { state: 'active' } }).accepted, true);
  }
  assert.equal(model.ingestEvent({ binding: first, stream: 'native', generation: 0, ordinal: 2, eventId: 'old-2',
    recordType: 'run', record: { state: 'active' } }).reason, 'stale_generation');
  assert.equal(model.project().counts.events, 2);
});

test('runやquestionの終端は遅延した開始eventや更新で復活しない', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  model.ingestEvent({ binding, stream: 'bridge', generation: 1, ordinal: 1, eventId: 'run-end',
    recordType: 'run', record: { state: 'ended' } });
  assert.equal(model.ingestEvent({ binding, stream: 'bridge', generation: 1, ordinal: 2, eventId: 'late-start',
    recordType: 'run', record: { state: 'active' } }).reason, 'terminal_preserved');
  model.upsertQuestion({ binding, question: { questionId: 'question-1', state: 'resolved', data: { answer: 'A' } } });
  assert.equal(model.upsertQuestion({ binding, question: { questionId: 'question-1', state: 'pending',
    data: { prompt: 'late event' } } }).reason, 'terminal_preserved');
  const row = model.project().rows[0];
  assert.equal(row.runState, 'ended');
  assert.equal(row.questions[0].state, 'resolved');
});

test('checkpoint schema拒否は余分な鍵、壊れたevent参照、version違いを捕捉する', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  model.ingestEvent({ binding, stream: 'native', generation: 1, ordinal: 1, eventId: 'event-1',
    recordType: 'run', record: { state: 'active' } });
  const checkpoint = model.checkpoint();
  assert.equal(validateCheckpoint(checkpoint), true);
  assert.equal(validateCheckpoint({ ...checkpoint, secret: 'unexpected' }), false);
  assert.equal(validateCheckpoint({ ...checkpoint, version: 2 }), false);
  assert.equal(validateCheckpoint({ ...checkpoint, events: [{ ...checkpoint.events[0], bindingKey: 'missing-binding' }] }), false);
  assert.equal(RecoveryModel.restore([]), null);
});

test('checkpointとvalidatorは128 KiBの上限を共有する', () => {
  const model = new RecoveryModel();
  const binding = register(model);
  const large = 'x'.repeat(15 * 1024);
  let rejection;
  for (let index = 0; index < 9; index += 1) {
    const before = model.checkpoint();
    const result = model.upsertPlan({ binding, plan: { planId: `plan-${index}`, state: 'active', data: { detail: large } } });
    if (!result.accepted) {
      rejection = result;
      assert.deepEqual(model.checkpoint(), before);
      break;
    }
  }
  assert.equal(rejection.reason, 'checkpoint_capacity');
  assert.equal(model.checkpoint() !== null, true);
  const validBase = new RecoveryModel();
  register(validBase);
  const base = validBase.checkpoint();
  const oversized = { ...base, bindings: [{ ...base.bindings[0], plans: Array.from({ length: 9 }, (_, index) => ({
    planId: `oversized-${index}`, state: 'active', data: { detail: large },
  })) }] };
  assert.equal(validateCheckpoint(oversized), false);
});
