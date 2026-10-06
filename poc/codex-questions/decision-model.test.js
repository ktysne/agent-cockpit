'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DecisionQuestionsBroker } = require('./decision-model');

const MINUTE = 60_000;

function makeQuestion(overrides = {}) {
  return {
    id: 'q1',
    text: 'Choose a direction',
    mode: 'single',
    options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    allowFreeText: false,
    recommendedOptionId: null,
    ...overrides,
  };
}

function registration(overrides = {}) {
  return {
    provenance: 'common_mcp',
    category: 'ordinary',
    hostId: 'host-a',
    homeScope: 'home-a',
    threadId: 'thread-a',
    requestId: 'request-a',
    timeoutMinutes: 5,
    questions: [makeQuestion()],
    ...overrides,
  };
}

function answerInput(overrides = {}) {
  return {
    hostId: 'host-a',
    homeScope: 'home-a',
    threadId: 'thread-a',
    requestId: 'request-a',
    source: 'dashboard',
    submissionId: 'submission-a',
    answers: [{ questionId: 'q1', optionIds: ['yes'] }],
    ...overrides,
  };
}

function requestInput(overrides = {}) {
  return {
    hostId: 'host-a',
    homeScope: 'home-a',
    threadId: 'thread-a',
    requestId: 'request-a',
    ...overrides,
  };
}

function setup(options = {}) {
  let now = options.now ?? 1_000_000;
  let id = 0;
  const broker = new DecisionQuestionsBroker({
    now: () => now,
    randomId: () => `claim-${++id}`,
    awayEnabled: options.awayEnabled ?? false,
  });
  return { broker, setNow: (value) => { now = value; }, getNow: () => now };
}

test('registration enforces the 1–30 minute deadline and keeps an exact duplicate idempotent', () => {
  for (const timeoutMinutes of [1, 5, 30]) {
    const { broker, getNow } = setup();
    const result = broker.register(registration({ timeoutMinutes }));
    assert.equal(result.accepted, true);
    assert.equal(result.request.deadlineAt, getNow() + timeoutMinutes * MINUTE);
    assert.equal(result.request.state, 'pending');
    const duplicate = broker.register(registration({ timeoutMinutes }));
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.reason, 'duplicate_registration');
    assert.equal(duplicate.request.deadlineAt, result.request.deadlineAt);
    assert.equal(broker.register(registration({ timeoutMinutes: timeoutMinutes === 30 ? 29 : timeoutMinutes + 1 })).reason, 'request_conflict');
  }
});

test('registration separates scoped request keys and rejects unsupported provenance and permission categories', () => {
  const { broker } = setup();
  assert.equal(broker.register(registration({ provenance: 'native' })).reason, 'unsupported_provenance');
  assert.equal(broker.register(registration({ provenance: 'client_claim' })).reason, 'unsupported_provenance');
  for (const category of ['permission', 'network_permission', 'app_approval']) {
    assert.equal(broker.register(registration({ category })).reason, 'permission_category');
  }
  assert.equal(broker.register(registration({ category: 'unknown' })).reason, 'unsupported_category');

  assert.equal(broker.register(registration()).accepted, true);
  assert.equal(broker.register(registration({ homeScope: 'home-b' })).accepted, true);
  assert.equal(broker.register(registration({ threadId: 'thread-b' })).accepted, true);
  assert.equal(broker.project().counts.total, 3);
  assert.equal(broker.register(registration({
    requestId: 'request-b',
    questions: [makeQuestion({ text: 'Permission approval?' })],
  })).accepted, true);
});

test('registration rejects malformed question schemas without silently converting them', () => {
  const invalidQuestions = [
    [],
    [makeQuestion(), makeQuestion({ id: 'q2' }), makeQuestion({ id: 'q3' }), makeQuestion({ id: 'q4' })],
    [makeQuestion({ id: 'q1', mode: 'multiple' })],
    [makeQuestion({ recommendedOptionId: 'missing' })],
    [makeQuestion({ options: [], allowFreeText: false })],
    [makeQuestion({ options: Array.from({ length: 7 }, (_, index) => ({ id: `o${index}`, label: 'Option' })) })],
    [makeQuestion({ options: [{ id: 'same', label: 'One' }, { id: 'same', label: 'Two' }] })],
    [makeQuestion({ text: ' ' })],
  ];
  const { broker } = setup();
  for (const questions of invalidQuestions) {
    assert.equal(broker.register(registration({ questions })).reason, 'invalid_questions');
  }
  assert.equal(broker.register(registration({ timeoutMinutes: 0 })).reason, 'invalid_input');
  assert.equal(broker.register(registration({ timeoutMinutes: 31 })).reason, 'invalid_input');
  assert.equal(broker.register(registration({ requestId: 'Bearer secret-value' })).reason, 'invalid_input');
  assert.equal(broker.project().counts.total, 0);
});

test('1, 5, and 30 minute deadlines distinguish one millisecond before, exactly at, and one millisecond after expiry', () => {
  for (const timeoutMinutes of [1, 5, 30]) {
    for (const offsetMs of [-1, 0, 1]) {
      const { broker, setNow, getNow } = setup({ awayEnabled: true });
      broker.register(registration({
        timeoutMinutes,
        questions: [makeQuestion({ recommendedOptionId: 'yes' })],
      }));
      const deadline = getNow() + timeoutMinutes * MINUTE;
      setNow(deadline + offsetMs);
      const result = broker.poll(requestInput());
      assert.equal(result.found, true);
      assert.equal(result.request.deadlineReached, offsetMs >= 0);
      assert.equal(result.request.state, offsetMs >= 0 ? 'provisional' : 'pending');
      assert.equal(result.request.deadlineEvaluated, offsetMs >= 0);
    }
  }
});

test('recommendation is applied for all explicit single-choice questions or none when one is missing', () => {
  const completeQuestions = [
    makeQuestion({ id: 'q1', recommendedOptionId: 'yes' }),
    makeQuestion({ id: 'q2', recommendedOptionId: 'no' }),
    makeQuestion({ id: 'q3', recommendedOptionId: 'yes' }),
  ];
  const complete = setup({ awayEnabled: true });
  complete.broker.register(registration({ questions: completeQuestions }));
  complete.setNow(complete.getNow() + 5 * MINUTE);
  const applied = complete.broker.poll(requestInput()).request;
  assert.equal(applied.state, 'provisional');
  assert.deepEqual(applied.applied.answers, [
    { questionId: 'q1', optionIds: ['yes'] },
    { questionId: 'q2', optionIds: ['no'] },
    { questionId: 'q3', optionIds: ['yes'] },
  ]);

  const incomplete = setup({ awayEnabled: true });
  incomplete.broker.register(registration({
    questions: [completeQuestions[0], completeQuestions[1], makeQuestion({ id: 'q3' })],
  }));
  incomplete.setNow(incomplete.getNow() + 5 * MINUTE);
  const stillPending = incomplete.broker.poll(requestInput()).request;
  assert.equal(stillPending.state, 'pending');
  assert.equal(stillPending.applied, null);
  assert.equal(stillPending.deadlineEvaluated, true);
});

test('poll is immediate and does not apply a recommendation just because time passed', () => {
  const { broker, setNow, getNow } = setup({ awayEnabled: true });
  broker.register(registration({ questions: [makeQuestion({ recommendedOptionId: 'yes' })] }));
  setNow(getNow() + 5 * MINUTE);
  const projection = broker.project();
  assert.equal(projection.rows[0].state, 'pending');
  const polled = broker.poll(requestInput());
  assert.equal(polled.found, true);
  assert.equal(polled.request.state, 'provisional');
  assert.equal(polled.request.applied.kind, 'provisional');
  assert.equal(polled.request.applied.answers[0].optionIds[0], 'yes');
});

test('deadline equality applies the recommendation before a simultaneous user answer', () => {
  const { broker, setNow, getNow } = setup({ awayEnabled: true });
  broker.register(registration({ questions: [makeQuestion({ recommendedOptionId: 'no' })] }));
  setNow(getNow() + 5 * MINUTE);
  const result = broker.submitAnswer(answerInput({ source: 'origin_ui' }));
  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'late_answer_recorded');
  assert.equal(result.applied, false);
  assert.equal(result.request.state, 'provisional');
  assert.equal(result.request.applied.answers[0].optionIds[0], 'no');
  assert.deepEqual(result.request.lateAnswer.answers[0].optionIds, ['yes']);
  assert.equal(broker.submitAnswer(answerInput({ submissionId: 'submission-b', source: 'dashboard' })).reason, 'late_answer_already_recorded');
});

test('current away state controls expiry and re-enabling after deadline is evaluated on the next broker operation', () => {
  const first = setup({ awayEnabled: true });
  first.broker.register(registration({ questions: [makeQuestion({ recommendedOptionId: 'yes' })] }));
  first.broker.setAwayEnabled(false);
  first.setNow(first.getNow() + 5 * MINUTE);
  assert.equal(first.broker.poll(requestInput()).request.state, 'pending');
  assert.equal(first.broker.project().rows[0].deadlineEvaluated, false);

  const chosen = first.broker.submitAnswer(answerInput());
  assert.equal(chosen.reason, 'chosen');
  assert.equal(chosen.request.state, 'chosen');

  const second = setup({ awayEnabled: true });
  second.broker.register(registration({ questions: [makeQuestion({ recommendedOptionId: 'yes' })] }));
  second.broker.setAwayEnabled(false);
  second.setNow(second.getNow() + 5 * MINUTE);
  assert.equal(second.broker.poll(requestInput()).request.state, 'pending');
  second.broker.setAwayEnabled(true);
  assert.equal(second.broker.poll(requestInput()).request.state, 'provisional');
});

test('hold only marks the request and neither extends its deadline nor applies a recommendation', () => {
  const { broker, setNow, getNow } = setup({ awayEnabled: true });
  const registered = broker.register(registration({ questions: [makeQuestion({ recommendedOptionId: 'yes' })] }));
  const held = broker.hold({ ...requestInput(), source: 'dashboard', operationId: 'hold-a' });
  assert.equal(held.request.held, true);
  assert.equal(held.request.deadlineAt, registered.request.deadlineAt);
  assert.equal(held.request.state, 'pending');
  setNow(getNow() + 5 * MINUTE);
  assert.equal(broker.hold({ ...requestInput(), source: 'origin_ui', operationId: 'hold-b' }).request.state, 'pending');
  assert.equal(broker.poll(requestInput()).request.state, 'provisional');

  const noRecommendation = setup({ awayEnabled: true });
  noRecommendation.broker.register(registration({ requestId: 'request-b' }));
  noRecommendation.setNow(noRecommendation.getNow() + 5 * MINUTE);
  const row = noRecommendation.broker.poll(requestInput({ requestId: 'request-b' })).request;
  assert.equal(row.state, 'pending');
  assert.equal(row.deadlineEvaluated, true);
});

test('hold rejects an invalid clock without changing request state', () => {
  const { broker, setNow } = setup();
  broker.register(registration());
  const before = broker.project().rows[0];
  setNow(Number.NaN);
  assert.equal(broker.hold({ ...requestInput(), source: 'dashboard', operationId: 'hold-a' }).reason, 'invalid_clock');
  const after = broker.project().rows[0];
  assert.equal(after.state, before.state);
  assert.equal(after.held, before.held);
  assert.equal(after.version, before.version);
});

test('multi-select and free-text questions remain unanswered by recommendation and retain their explicit answer shape', () => {
  const { broker, setNow, getNow } = setup({ awayEnabled: true });
  const questions = [
    makeQuestion({ id: 'q1', mode: 'multi', recommendedOptionId: 'yes' }),
    makeQuestion({ id: 'q2', allowFreeText: true, recommendedOptionId: 'yes' }),
  ];
  broker.register(registration({ questions }));
  setNow(getNow() + 5 * MINUTE);
  assert.equal(broker.poll(requestInput()).request.state, 'pending');

  const result = broker.submitAnswer(answerInput({ answers: [
    { questionId: 'q1', optionIds: ['yes', 'no'] },
    { questionId: 'q2', optionIds: [], freeText: 'write a reason' },
  ] }));
  assert.equal(result.reason, 'chosen');
  assert.deepEqual(result.request.chosen.answers, [
    { questionId: 'q1', optionIds: ['yes', 'no'] },
    { questionId: 'q2', optionIds: [], freeText: 'write a reason' },
  ]);
});

test('dashboard and origin UI share one answer winner and reject repeated or conflicting submissions', () => {
  const { broker } = setup();
  broker.register(registration());
  const winner = broker.submitAnswer(answerInput({ source: 'origin_ui' }));
  assert.equal(winner.reason, 'chosen');
  assert.equal(broker.submitAnswer(answerInput({ source: 'origin_ui' })).reason, 'duplicate_submission');
  assert.equal(broker.submitAnswer(answerInput({
    source: 'dashboard', submissionId: 'submission-b', answers: [{ questionId: 'q1', optionIds: ['no'] }],
  })).reason, 'answer_already_set');
  assert.equal(broker.submitAnswer(answerInput({
    source: 'dashboard', answers: [{ questionId: 'q1', optionIds: ['no'] }],
  })).reason, 'submission_id_conflict');
  assert.equal(broker.project().counts.chosen, 1);
});

test('cancel and unknown-content external resolution are terminal and do not reopen on late answers', () => {
  const cancelled = setup();
  cancelled.broker.register(registration());
  assert.equal(cancelled.broker.cancel({ ...requestInput(), source: 'origin_ui', operationId: 'cancel-a' }).reason, 'cancelled');
  assert.equal(cancelled.broker.submitAnswer(answerInput()).reason, 'terminal_request');

  const externallyResolved = setup();
  externallyResolved.broker.register(registration());
  assert.equal(externallyResolved.broker.submitAnswer(answerInput()).reason, 'chosen');
  const claim = externallyResolved.broker.claimDelivery({ ...requestInput(), deliveryId: 'delivery-a' });
  assert.equal(claim.accepted, true);
  assert.equal(externallyResolved.broker.observeExternalResolved({ ...requestInput(), eventId: 'native-event-a' }).reason, 'external_resolved');
  assert.equal(externallyResolved.broker.acknowledgeDelivery({
    ...requestInput(), deliveryId: claim.delivery.deliveryId, claimId: claim.delivery.claimId,
  }).reason, 'claim_not_active');
  assert.equal(externallyResolved.broker.submitAnswer(answerInput({ submissionId: 'submission-b' })).reason, 'terminal_request');
  assert.equal(externallyResolved.broker.project().rows[0].state, 'external_resolved');
});

test('chosen and provisional answers can be cancelled until acknowledged while preserving answer history', () => {
  const makeChosen = () => {
    const context = setup();
    context.broker.register(registration());
    context.broker.submitAnswer(answerInput());
    return context;
  };
  const makeProvisional = () => {
    const context = setup({ awayEnabled: true });
    context.broker.register(registration({ questions: [makeQuestion({ recommendedOptionId: 'no' })] }));
    context.setNow(context.getNow() + 5 * MINUTE);
    assert.equal(context.broker.poll(requestInput()).request.state, 'provisional');
    return context;
  };

  for (const [answerKind, makeContext] of [['chosen', makeChosen], ['provisional', makeProvisional]]) {
    for (const deliveryPhase of ['available', 'claimed']) {
      const { broker } = makeContext();
      const prior = broker.project().rows[0];
      let claim = null;
      if (deliveryPhase === 'claimed') {
        claim = broker.claimDelivery({ ...requestInput(), deliveryId: 'delivery-a' });
        assert.equal(claim.accepted, true);
      }

      const cancelled = broker.cancel({
        ...requestInput(), source: 'dashboard', operationId: `cancel-${answerKind}-${deliveryPhase}`,
      });
      assert.equal(cancelled.reason, 'cancelled');
      assert.equal(cancelled.request.state, 'cancelled');
      assert.equal(cancelled.request.deliveryState, 'invalidated');
      assert.deepEqual(cancelled.request.applied, prior.applied);
      assert.deepEqual(cancelled.request.chosen, prior.chosen);
      assert.equal(broker.claimDelivery({ ...requestInput(), deliveryId: 'delivery-b' }).reason, 'delivery_unavailable');
      if (claim) {
        assert.equal(broker.acknowledgeDelivery({
          ...requestInput(), deliveryId: claim.delivery.deliveryId, claimId: claim.delivery.claimId,
        }).reason, 'claim_not_active');
      }
    }
  }

  const acknowledged = makeChosen();
  const acknowledgedClaim = acknowledged.broker.claimDelivery({ ...requestInput(), deliveryId: 'delivery-a' });
  assert.equal(acknowledged.broker.acknowledgeDelivery({
    ...requestInput(), deliveryId: acknowledgedClaim.delivery.deliveryId, claimId: acknowledgedClaim.delivery.claimId,
  }).reason, 'acknowledged');
  const appliedBeforeCancellation = acknowledged.broker.poll(requestInput()).request.applied;
  assert.equal(acknowledged.broker.cancel({
    ...requestInput(), source: 'dashboard', operationId: 'cancel-acknowledged',
  }).reason, 'terminal_request');
  const retained = acknowledged.broker.poll(requestInput()).request;
  assert.equal(retained.state, 'chosen');
  assert.equal(retained.deliveryState, 'acknowledged');
  assert.deepEqual(retained.applied, appliedBeforeCancellation);
});

test('delivery claim and receipt acknowledgment are separate one-time operations', () => {
  const { broker } = setup();
  broker.register(registration());
  assert.equal(broker.claimDelivery({ ...requestInput(), deliveryId: 'delivery-a' }).reason, 'delivery_unavailable');
  assert.equal(broker.poll(requestInput()) instanceof Promise, false);
  broker.submitAnswer(answerInput());
  const claim = broker.claimDelivery({ ...requestInput(), deliveryId: 'delivery-a' });
  assert.equal(claim.accepted, true);
  assert.deepEqual(claim.delivery.answers[0].optionIds, ['yes']);
  assert.equal(broker.project().rows[0].deliveryState, 'claimed');
  assert.equal(broker.claimDelivery({ ...requestInput(), deliveryId: 'delivery-b' }).reason, 'delivery_unavailable');
  assert.equal(broker.acknowledgeDelivery({
    ...requestInput(), deliveryId: 'delivery-a', claimId: claim.delivery.claimId,
  }).reason, 'acknowledged');
  assert.equal(broker.acknowledgeDelivery({
    ...requestInput(), deliveryId: 'delivery-a', claimId: claim.delivery.claimId,
  }).reason, 'claim_not_active');
});

test('malformed answers and unknown answer sources leave the request pending', () => {
  const { broker } = setup();
  broker.register(registration());
  assert.equal(broker.submitAnswer(answerInput({ source: 'native' })).reason, 'invalid_input');
  assert.equal(broker.submitAnswer(answerInput({ answers: [{ questionId: 'q1', optionIds: ['missing'] }] })).reason, 'invalid_answer');
  assert.equal(broker.submitAnswer(answerInput({ answers: [{ questionId: 'q1', optionIds: ['yes', 'no'] }] })).reason, 'invalid_answer');
  assert.equal(broker.submitAnswer(answerInput({ answers: [{ questionId: 'q1', optionIds: [], freeText: 'not enabled' }] })).reason, 'invalid_answer');
  assert.equal(broker.project().rows[0].state, 'pending');
});
