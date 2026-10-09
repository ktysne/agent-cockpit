'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const {
  createQuestionRecord,
  normalizeQuestionRecord,
  selectionFor,
  sha256Json,
} = require('../src/server/common-question-kernel');
const {
  encodeQuestionJournalV2Local,
  normalizeQuestionDetailV2,
  normalizeQuestionJournalV2Local,
  normalizeQuestionReservation,
  questionCommonKeyDigest,
  questionRecordDigest,
} = require('../src/server/common-question-reclamation-codec');

const SHA = 'a'.repeat(64);
const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const MAX_SOURCE_BYTES = 16_777_216;
const DETAIL_V2_FIELDS = [
  'internalQuestionId', 'questionId', 'identity', 'periodId', 'executionId', 'conversationId',
  'launchRef', 'executionBinding', 'category', 'contentDigest', 'questions', 'createdAt',
  'deadlineAt', 'timeoutMinutes', 'revision', 'held', 'selection', 'deliveryIntent',
  'deliveryCreationState', 'autoApplyEnabledAtRegistration', 'quarantinedAt', 'externalResolution',
  'lateAnswers', 'cancelledAt',
];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const QUESTION_FIELDS = ['id', 'text', 'mode', 'options', 'allowFreeText', 'recommendedOptionId'];
const OPTION_FIELDS = ['id', 'label', 'description'];
const ANSWER_FIELDS = ['questionId', 'optionIds', 'freeText'];
const DELIVERY_INTENT_FIELDS = ['deliveryAttemptId', 'logicalMessageId', 'revision', 'payloadDigest'];
const EXTERNAL_RESOLUTION_FIELDS = ['resolvedAt', 'evidenceDigest'];

function questionsFor(id = 'q-1') {
  return [{
    id,
    text: 'Choose one',
    mode: 'single',
    options: [{ id: 'option-1', label: 'First', description: '' }],
    allowFreeText: true,
    recommendedOptionId: 'option-1',
  }];
}

function answerFor(question) {
  return [{ questionId: question.id, optionIds: ['option-1'], freeText: null }];
}

function createV1Record({
  provider = 'claude',
  internalQuestionId = 'internal-1',
  questionId = 'public-1',
  periodId = 'period-1',
  questions = questionsFor(),
  createdAt = 1_000,
  identity = null,
  autoApplyEnabledAtRegistration = false,
} = {}) {
  const nativeIdKind = provider === 'claude' ? 'session' : 'thread';
  return createQuestionRecord({
    internalQuestionId,
    questionId,
    identity: identity || {
      provider,
      nativeIdKind,
      hostId: 'host-1',
      homeScopeId: 'home-1',
      nativeId: `native-${internalQuestionId}`,
    },
    periodId,
    executionId: `execution-${internalQuestionId}`,
    conversationId: `conversation-${internalQuestionId}`,
    launchRef: `launch-${internalQuestionId}`,
    executionBinding: { periodId, actor: { kind: 'agent', id: `actor-${internalQuestionId}` } },
    category: 'ordinary',
    questions,
    timeoutMinutes: 1,
    createdAt,
    autoApplyEnabledAtRegistration,
  });
}

function toV2(record, { deliveryCreationState = 'not_created', quarantinedAt = null } = {}) {
  return { ...record, deliveryCreationState, quarantinedAt };
}

function select(record, { source = 'manual', selectedAt = record.createdAt + 1_000 } = {}) {
  const result = selectionFor(record, answerFor(record.questions[0]), source, selectedAt, 'fixed-uuid');
  return result.record;
}

function terminalResultKind(checkpointState) {
  return ['applied', 'cancelled_before_send', 'superseded_before_send'].includes(checkpointState)
    ? checkpointState
    : null;
}

function reservationFor(detail, overrides = {}) {
  const creationState = overrides.deliveryCreationState || detail.deliveryCreationState;
  const checkpointState = Object.hasOwn(overrides, 'checkpointState')
    ? overrides.checkpointState
    : creationState === 'checkpointed' ? 'available' : creationState === 'indeterminate' ? 'unknown' : null;
  const checkpointed = creationState === 'checkpointed';
  const reservation = {
    internalQuestionId: detail.internalQuestionId,
    identity: detail.identity,
    periodId: detail.periodId,
    questionId: detail.questionId,
    contentDigest: detail.contentDigest,
    executionId: detail.executionId,
    conversationId: detail.conversationId,
    launchRef: detail.launchRef,
    executionBinding: detail.executionBinding,
    createdAt: detail.createdAt,
    revision: detail.revision,
    selectionSource: detail.selection === null ? null : detail.selection.source,
    selectedAt: detail.selection === null ? null : detail.selection.selectedAt,
    deliveryIntent: detail.deliveryIntent,
    deliveryCreationState: creationState,
    checkpointState,
    sourceClaimsDigest: checkpointed ? SHA : null,
    sessionId: checkpointed ? 'session-1' : null,
    externalResolution: detail.externalResolution,
    cancelledAt: detail.cancelledAt,
    terminalResultKind: terminalResultKind(checkpointState),
    quarantinedAt: detail.quarantinedAt,
    bodyState: 'retained',
    reclaimedAt: null,
    reclamation: null,
  };
  return { ...reservation, ...overrides };
}

function journal(questions, reservations, migrationAllowance = null) {
  return { schemaVersion: 2, storeId: STORE_ID, revision: 1, questions, reservations, migrationAllowance };
}

function preparedSnapshot(detail, deliveryPresence, checkpointState = null) {
  const quarantinedDetail = toV2(normalizeQuestionRecord(stripV2(detail)), {
    deliveryCreationState: detail.deliveryCreationState,
    quarantinedAt: 5_000,
  });
  const overrides = {
    reclamation: {
      operationId: OPERATION_ID,
      preparedAt: 5_010,
      deliveryPresence,
      checkpointState,
    },
  };
  if (deliveryPresence === 'checkpoint') {
    overrides.checkpointState = checkpointState;
    overrides.terminalResultKind = terminalResultKind(checkpointState);
  }
  const reservation = reservationFor(quarantinedDetail, overrides);
  return { detail: quarantinedDetail, reservation };
}

function stripV2(record) {
  const { deliveryCreationState, quarantinedAt, ...v1 } = record;
  return v1;
}

function orderedFields(value, fields) {
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function canonicalAnswer(value) {
  return orderedFields(value, ANSWER_FIELDS);
}

function canonicalQuestion(value) {
  return orderedFields({
    ...value,
    options: value.options.map((option) => orderedFields(option, OPTION_FIELDS)),
  }, QUESTION_FIELDS);
}

function canonicalDetail(value) {
  const fields = {
    ...value,
    identity: orderedFields(value.identity, IDENTITY_FIELDS),
    executionBinding: {
      periodId: value.executionBinding.periodId,
      actor: orderedFields(value.executionBinding.actor, ['kind', 'id']),
    },
    questions: value.questions.map(canonicalQuestion),
    selection: value.selection === null ? null : {
      source: value.selection.source,
      selectedAt: value.selection.selectedAt,
      answers: value.selection.answers.map(canonicalAnswer),
    },
    deliveryIntent: value.deliveryIntent === null ? null : orderedFields(value.deliveryIntent, DELIVERY_INTENT_FIELDS),
    externalResolution: value.externalResolution === null ? null :
      orderedFields(value.externalResolution, EXTERNAL_RESOLUTION_FIELDS),
    lateAnswers: value.lateAnswers.map((late) => ({
      submittedAt: late.submittedAt,
      digest: late.digest,
      answers: late.answers.map(canonicalAnswer),
    })),
  };
  return orderedFields(fields, DETAIL_V2_FIELDS);
}

test('v2 detail keeps the existing v1 fields, normalization, and content digest for both providers', () => {
  for (const provider of ['claude', 'codex']) {
    const v1 = createV1Record({ provider, internalQuestionId: `internal-${provider}` });
    const normalized = normalizeQuestionDetailV2(toV2(v1));
    const v1Projection = stripV2(normalized);

    assert.deepEqual(v1Projection, normalizeQuestionRecord(v1));
    assert.equal(normalized.contentDigest, v1.contentDigest);
    assert.deepEqual(Reflect.ownKeys(normalized), [
      'internalQuestionId', 'questionId', 'identity', 'periodId', 'executionId', 'conversationId',
      'launchRef', 'executionBinding', 'category', 'contentDigest', 'questions', 'createdAt',
      'deadlineAt', 'timeoutMinutes', 'revision', 'held', 'selection', 'deliveryIntent',
      'deliveryCreationState', 'autoApplyEnabledAtRegistration', 'quarantinedAt', 'externalResolution',
      'lateAnswers', 'cancelledAt',
    ]);
  }
});

test('v2 requires autoApplyEnabledAtRegistration and the two new detail fields', () => {
  const record = toV2(createV1Record());
  const missingBoolean = { ...record };
  delete missingBoolean.autoApplyEnabledAtRegistration;
  assert.throws(() => normalizeQuestionDetailV2(missingBoolean));

  const missingCreationState = { ...record };
  delete missingCreationState.deliveryCreationState;
  assert.throws(() => normalizeQuestionDetailV2(missingCreationState));

  const missingQuarantineTime = { ...record };
  delete missingQuarantineTime.quarantinedAt;
  assert.throws(() => normalizeQuestionDetailV2(missingQuarantineTime));
});

test('recommendation validation matches the kernel for multi-select questions', () => {
  const question = { ...questionsFor()[0], mode: 'multi' };
  const detail = toV2(createV1Record({ questions: [question] }));
  assert.equal(normalizeQuestionDetailV2(detail).questions[0].recommendedOptionId, 'option-1');
});

test('late answer digest and away-default timing and answer constraints match the kernel', () => {
  const base = createV1Record();
  const answers = answerFor(base.questions[0]);
  const late = {
    submittedAt: base.createdAt + 1,
    digest: sha256Json(answers),
    answers,
  };
  const validLate = toV2(normalizeQuestionRecord({ ...base, lateAnswers: [late] }));
  assert.equal(normalizeQuestionDetailV2(validLate).lateAnswers.length, 1);
  assert.throws(() => normalizeQuestionDetailV2(toV2({
    ...normalizeQuestionRecord({ ...base, lateAnswers: [late] }),
    lateAnswers: [{ ...late, digest: 'b'.repeat(64) }],
  })));

  const validDefault = selectionFor(base, answers, 'away-default', base.deadlineAt, 'fixed-uuid').record;
  assert.equal(normalizeQuestionDetailV2(toV2(validDefault)).selection.source, 'away-default');

  const selectedBeforeDeadline = selectionFor(base, answers, 'manual', base.deadlineAt - 1, 'fixed-uuid').record;
  assert.throws(() => normalizeQuestionDetailV2(toV2({
    ...selectedBeforeDeadline,
    selection: { ...selectedBeforeDeadline.selection, source: 'away-default' },
  })));

  const questions = [{
    ...questionsFor()[0],
    options: [
      ...questionsFor()[0].options,
      { id: 'option-2', label: 'Second', description: '' },
    ],
  }];
  const withAlternative = createV1Record({ questions });
  const differentAnswers = [{ questionId: questions[0].id, optionIds: ['option-2'], freeText: null }];
  const selectedDifferentAnswer = selectionFor(
    withAlternative, differentAnswers, 'manual', withAlternative.deadlineAt, 'fixed-uuid',
  ).record;
  assert.throws(() => normalizeQuestionDetailV2(toV2({
    ...selectedDifferentAnswer,
    selection: { ...selectedDifferentAnswer.selection, source: 'away-default' },
  })));
});

test('detail creation states accept the four intent-compatible states and reject impossible unselected states', () => {
  const v1 = createV1Record();
  const unselected = toV2(v1);
  assert.equal(normalizeQuestionDetailV2(unselected).deliveryCreationState, 'not_created');
  for (const state of ['not_created', 'creating', 'checkpointed', 'indeterminate']) {
    const selected = select(v1);
    assert.equal(normalizeQuestionDetailV2(toV2(selected, { deliveryCreationState: state })).deliveryCreationState, state);
  }
  assert.throws(() => normalizeQuestionDetailV2(toV2(v1, { deliveryCreationState: 'creating' })));
  assert.throws(() => normalizeQuestionDetailV2(toV2(v1, { deliveryCreationState: 'unknown' })));
});

test('reservation validates unselected, selected, creating, checkpointed, and indeterminate states', () => {
  const unselected = toV2(createV1Record());
  assert.equal(normalizeQuestionReservation(reservationFor(unselected)).selectionSource, null);

  const selectedV1 = select(createV1Record());
  for (const state of ['not_created', 'creating', 'checkpointed', 'indeterminate']) {
    const detail = toV2(selectedV1, { deliveryCreationState: state });
    const reservation = reservationFor(detail);
    assert.equal(normalizeQuestionReservation(reservation).deliveryCreationState, state);
  }

  const invalidSelectedNotCreated = reservationFor(unselected, { deliveryIntent: { ...selectedV1.deliveryIntent } });
  assert.throws(() => normalizeQuestionReservation(invalidSelectedNotCreated));

  const invalidCheckpointed = reservationFor(toV2(selectedV1, { deliveryCreationState: 'checkpointed' }), {
    sourceClaimsDigest: null,
  });
  assert.throws(() => normalizeQuestionReservation(invalidCheckpointed));

  const invalidIndeterminate = reservationFor(toV2(selectedV1, { deliveryCreationState: 'indeterminate' }), {
    checkpointState: 'available',
  });
  assert.throws(() => normalizeQuestionReservation(invalidIndeterminate));
});

test('checkpoint cache accepts all states and derives terminalResultKind only for terminal states', () => {
  const selectedV1 = select(createV1Record());
  for (const checkpointState of [
    'available', 'claimed', 'sending', 'accepted', 'applied', 'unknown',
    'cancelled_before_send', 'superseded_before_send',
  ]) {
    const detail = toV2(selectedV1, { deliveryCreationState: 'checkpointed' });
    const reservation = reservationFor(detail, { checkpointState, terminalResultKind: terminalResultKind(checkpointState) });
    assert.equal(normalizeQuestionReservation(reservation).checkpointState, checkpointState);
  }

  const terminalMismatch = reservationFor(toV2(selectedV1, { deliveryCreationState: 'checkpointed' }), {
    checkpointState: 'applied',
    terminalResultKind: null,
  });
  assert.throws(() => normalizeQuestionReservation(terminalMismatch));
});

test('prepared and reclaimed snapshots preserve delivery presence, quarantine time, and preparation time', () => {
  const unselected = toV2(createV1Record());
  const noDelivery = preparedSnapshot(unselected, 'none');
  assert.equal(normalizeQuestionJournalV2Local(journal([noDelivery.detail], [noDelivery.reservation])).reservations[0]
    .reclamation.deliveryPresence, 'none');

  const selected = select(createV1Record());
  const checkpointDetail = toV2(selected, { deliveryCreationState: 'checkpointed' });
  const checkpoint = preparedSnapshot(checkpointDetail, 'checkpoint', 'available');
  const preparedJournal = normalizeQuestionJournalV2Local(journal([checkpoint.detail], [checkpoint.reservation]));
  assert.equal(preparedJournal.reservations[0].reclamation.checkpointState, 'available');

  const reclaimed = {
    ...checkpoint.reservation,
    bodyState: 'reclaimed',
    reclaimedAt: checkpoint.reservation.reclamation.preparedAt,
  };
  assert.equal(normalizeQuestionJournalV2Local(journal([], [reclaimed])).questions.length, 0);

  assert.throws(() => normalizeQuestionJournalV2Local(journal([], [{ ...reclaimed, reclaimedAt: 5_009 }])));
  assert.throws(() => normalizeQuestionJournalV2Local(journal([checkpoint.detail], [reclaimed])));
  assert.throws(() => normalizeQuestionJournalV2Local(journal([checkpoint.detail], [
    { ...checkpoint.reservation, reclamation: { ...checkpoint.reservation.reclamation, checkpointState: 'accepted' } },
  ])));

  const indeterminate = preparedSnapshot(toV2(selected, { deliveryCreationState: 'indeterminate' }), 'indeterminate', 'unknown');
  assert.equal(normalizeQuestionReservation(indeterminate.reservation).reclamation.deliveryPresence, 'indeterminate');
  assert.throws(() => normalizeQuestionReservation({
    ...indeterminate.reservation,
    reclamation: { ...indeterminate.reservation.reclamation, deliveryPresence: 'none', checkpointState: null },
  }));
});

test('reclaimed tombstones preserve none, unknown, and terminal outcomes without body or answer fields', () => {
  const selected = select(createV1Record());
  const cases = [
    {
      name: 'none',
      detail: toV2(createV1Record()),
      presence: 'none',
      checkpointState: null,
      terminalResultKind: null,
    },
    {
      name: 'indeterminate unknown',
      detail: toV2(selected, { deliveryCreationState: 'indeterminate' }),
      presence: 'indeterminate',
      checkpointState: 'unknown',
      terminalResultKind: null,
    },
    ...['unknown', 'applied', 'cancelled_before_send', 'superseded_before_send'].map((checkpointState) => ({
      name: `checkpoint ${checkpointState}`,
      detail: toV2(selected, { deliveryCreationState: 'checkpointed' }),
      presence: 'checkpoint',
      checkpointState,
      terminalResultKind: terminalResultKind(checkpointState),
    })),
  ];

  for (const item of cases) {
    const prepared = preparedSnapshot(item.detail, item.presence, item.checkpointState);
    const reclaimed = {
      ...prepared.reservation,
      bodyState: 'reclaimed',
      reclaimedAt: prepared.reservation.reclamation.preparedAt,
    };
    const tombstone = normalizeQuestionJournalV2Local(journal([], [reclaimed])).reservations[0];
    assert.equal(tombstone.terminalResultKind, item.terminalResultKind, item.name);
    assert.deepEqual(tombstone.reclamation, prepared.reservation.reclamation, item.name);
    for (const bodyField of ['questions', 'questionText', 'answers', 'lateAnswers', 'freeText']) {
      assert.throws(() => normalizeQuestionReservation({ ...reclaimed, [bodyField]: [] }),
        `${item.name}: ${bodyField} is not retained`);
    }
  }
});

test('migration allowance validates its exact grant shape without checking the anchor roster', () => {
  const eligibleQuestionIds = ['already-reclaimed-id', 'not-present-in-current-journal'];
  const migrationAllowance = {
    operationId: OPERATION_ID,
    sourceSchemaVersion: 1,
    sourceSizeBytes: MAX_SOURCE_BYTES,
    sourceSha256: SHA,
    maxExtraBytes: Number.MAX_SAFE_INTEGER,
    eligibleQuestionIds,
  };
  const detail = toV2(createV1Record());
  const result = normalizeQuestionJournalV2Local(journal([detail], [reservationFor(detail)], migrationAllowance));
  assert.deepEqual(result.migrationAllowance.eligibleQuestionIds, eligibleQuestionIds);

  for (const patch of [
    { operationId: '22222222-2222-4222-0222-222222222222' },
    { sourceSchemaVersion: 2 },
    { sourceSizeBytes: MAX_SOURCE_BYTES + 1 },
    { sourceSizeBytes: -1 },
    { sourceSizeBytes: Number.MAX_SAFE_INTEGER + 1 },
    { sourceSha256: SHA.toUpperCase() },
    { maxExtraBytes: 0 },
    { maxExtraBytes: Number.MAX_SAFE_INTEGER + 1 },
    { eligibleQuestionIds: ['duplicate', 'duplicate'] },
    { eligibleQuestionIds: new Array(20_001).fill('id') },
    { unexpectedField: true },
  ]) {
    assert.throws(() => normalizeQuestionJournalV2Local(journal([detail], [reservationFor(detail)], {
      ...migrationAllowance,
      ...patch,
    })));
  }
});

test('maxRecords accepts 1 and 20,000 while rejecting invalid limits and excess entries', () => {
  const empty = journal([], []);
  assert.doesNotThrow(() => normalizeQuestionJournalV2Local(empty, 1));
  assert.doesNotThrow(() => normalizeQuestionJournalV2Local(empty, 20_000));
  assert.throws(() => normalizeQuestionJournalV2Local(empty, 0));
  assert.throws(() => normalizeQuestionJournalV2Local(empty, 20_001));
  assert.throws(() => normalizeQuestionJournalV2Local({
    ...empty,
    reservations: new Array(20_001).fill(null),
  }, 20_000));

  for (const revision of [-1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeQuestionJournalV2Local({ ...empty, revision }));
  }
  assert.throws(() => normalizeQuestionJournalV2Local({ ...empty, storeId: 'not-a-lowercase-v4-uuid' }));
});

test('journal rejects duplicate IDs or common keys, missing details, and detail-reservation mismatches', () => {
  const detail = toV2(createV1Record());
  const reservation = reservationFor(detail);
  assert.throws(() => normalizeQuestionJournalV2Local(journal([detail], [reservation, reservation])));
  assert.throws(() => normalizeQuestionJournalV2Local(journal([], [reservation])));
  assert.throws(() => normalizeQuestionJournalV2Local(journal([detail, detail], [reservation])));

  const sameCommonKey = toV2(createV1Record({ internalQuestionId: 'internal-2', identity: detail.identity }));
  assert.throws(() => normalizeQuestionJournalV2Local(journal(
    [detail, sameCommonKey], [reservation, reservationFor(sameCommonKey)],
  )));

  const changedIdentity = reservationFor(detail, {
    identity: { ...detail.identity, nativeId: 'different-native-id' },
  });
  assert.throws(() => normalizeQuestionJournalV2Local(journal([detail], [changedIdentity])));
});

test('journal compares every shared detail and reservation field after each side passes local validation', () => {
  const base = toV2(createV1Record());
  const baseReservation = reservationFor(base);
  const selected = toV2(select(createV1Record()));
  const selectedReservation = reservationFor(selected);
  const externalV1 = normalizeQuestionRecord({
    ...createV1Record(),
    externalResolution: { resolvedAt: 2_000, evidenceDigest: SHA },
  });
  const external = toV2(externalV1);
  const externalReservation = reservationFor(external);
  const selectedRevisionTwo = normalizeQuestionRecord({
    ...stripV2(selected),
    revision: 2,
    deliveryIntent: {
      ...selected.deliveryIntent,
      revision: 2,
      payloadDigest: sha256Json({
        questionId: selected.questionId,
        revision: 2,
        answers: selected.selection.answers,
      }),
    },
  });
  const detailRevisionTwo = toV2(selectedRevisionTwo);
  const reservationRevisionTwo = reservationFor(detailRevisionTwo);
  const table = [
    ['internalQuestionId', base, { ...baseReservation, internalQuestionId: 'different-id' }],
    ['identity provider pair', base, { ...baseReservation, identity: { ...base.identity, provider: 'codex', nativeIdKind: 'thread' } }],
    ['identity hostId', base, { ...baseReservation, identity: { ...base.identity, hostId: 'other-host' } }],
    ['identity homeScopeId', base, { ...baseReservation, identity: { ...base.identity, homeScopeId: 'other-home' } }],
    ['identity nativeId', base, { ...baseReservation, identity: { ...base.identity, nativeId: 'other-native' } }],
    ['periodId and binding periodId', base, {
      ...baseReservation,
      periodId: 'other-period',
      executionBinding: { ...base.executionBinding, periodId: 'other-period' },
    }],
    ['questionId', base, { ...baseReservation, questionId: 'other-question' }],
    ['contentDigest', base, { ...baseReservation, contentDigest: 'b'.repeat(64) }],
    ['executionId', base, { ...baseReservation, executionId: 'other-execution' }],
    ['conversationId', base, { ...baseReservation, conversationId: 'other-conversation' }],
    ['launchRef', base, { ...baseReservation, launchRef: 'other-launch' }],
    ['binding actor kind', base, {
      ...baseReservation,
      executionBinding: { ...base.executionBinding, actor: { kind: 'tool-use', id: base.executionBinding.actor.id } },
    }],
    ['binding actor id', base, {
      ...baseReservation,
      executionBinding: { ...base.executionBinding, actor: { ...base.executionBinding.actor, id: 'other-actor' } },
    }],
    ['createdAt', base, { ...baseReservation, createdAt: base.createdAt + 1 }],
    ['revision', base, { ...baseReservation, revision: base.revision + 1 }],
    ['selectionSource', selected, { ...selectedReservation, selectionSource: 'away-default' }],
    ['selectedAt', selected, { ...selectedReservation, selectedAt: selected.selection.selectedAt + 1 }],
    ['deliveryAttemptId', selected, {
      ...selectedReservation,
      deliveryIntent: { ...selectedReservation.deliveryIntent, deliveryAttemptId: 'other-attempt' },
    }],
    ['logicalMessageId', selected, {
      ...selectedReservation,
      deliveryIntent: { ...selectedReservation.deliveryIntent, logicalMessageId: 'other-message' },
    }],
    ['payloadDigest', selected, {
      ...selectedReservation,
      deliveryIntent: { ...selectedReservation.deliveryIntent, payloadDigest: 'b'.repeat(64) },
    }],
    ['delivery intent revision tuple', detailRevisionTwo, {
      ...reservationRevisionTwo,
      revision: 3,
      deliveryIntent: {
        ...reservationRevisionTwo.deliveryIntent,
        revision: 3,
        payloadDigest: sha256Json({
          questionId: detailRevisionTwo.questionId,
          revision: 3,
          answers: detailRevisionTwo.selection.answers,
        }),
      },
    }],
    ['deliveryCreationState', selected, { ...selectedReservation, deliveryCreationState: 'creating' }],
    ['externalResolution', external, {
      ...externalReservation,
      externalResolution: { resolvedAt: 2_001, evidenceDigest: 'b'.repeat(64) },
    }],
    ['cancelledAt', base, { ...baseReservation, cancelledAt: base.createdAt + 1 }],
    ['quarantinedAt', base, { ...baseReservation, quarantinedAt: 3_000 }],
  ];

  for (const [field, detail, reservation] of table) {
    assert.doesNotThrow(() => normalizeQuestionDetailV2(detail), `${field}: detail local validation`);
    assert.doesNotThrow(() => normalizeQuestionReservation(reservation), `${field}: reservation local validation`);
    assert.throws(() => normalizeQuestionJournalV2Local(journal([detail], [reservation])), field);
  }
});

test('journal and detail reject unknown fields, unknown enum values, and malformed digests', () => {
  const detail = toV2(createV1Record());
  const reservation = reservationFor(detail);
  assert.throws(() => normalizeQuestionJournalV2Local({ ...journal([detail], [reservation]), extra: true }));
  assert.throws(() => normalizeQuestionDetailV2({ ...detail, extra: true }));
  assert.throws(() => normalizeQuestionDetailV2({ ...detail, deliveryCreationState: 'prepared' }));
  assert.throws(() => normalizeQuestionDetailV2({ ...detail, contentDigest: 'A'.repeat(64) }));

  const selected = toV2(select(createV1Record()));
  assert.throws(() => normalizeQuestionDetailV2({
    ...selected,
    deliveryIntent: { ...selected.deliveryIntent, payloadDigest: SHA },
  }));
  assert.throws(() => normalizeQuestionJournalV2Local(journal([detail], [
    reservationFor(detail, { deliveryCreationState: 'reclaimed' }),
  ])));
});

test('strict capture rejects accessors, sparse arrays, custom prototypes, and own toJSON without invoking them', () => {
  let calls = 0;
  const hostileValue = {
    toString() { calls += 1; throw new Error('coercion must not run'); },
    [Symbol.toPrimitive]() { calls += 1; throw new Error('coercion must not run'); },
  };
  const detail = toV2(createV1Record());
  const accessorRecord = { ...detail };
  delete accessorRecord.createdAt;
  Object.defineProperty(accessorRecord, 'createdAt', {
    enumerable: true,
    get() { calls += 1; return 1_000; },
  });
  assert.throws(() => normalizeQuestionDetailV2(accessorRecord));

  const toJsonRecord = { ...detail, toJSON() { calls += 1; return {}; } };
  assert.throws(() => normalizeQuestionDetailV2(toJsonRecord));

  const sparseQuestions = { ...detail, questions: new Array(1) };
  assert.throws(() => normalizeQuestionDetailV2(sparseQuestions));

  const customPrototype = Object.assign(Object.create({ inherited: true }), detail);
  assert.throws(() => normalizeQuestionDetailV2(customPrototype));

  assert.throws(() => normalizeQuestionDetailV2({
    ...detail,
    identity: { ...detail.identity, provider: hostileValue },
  }));
  const checkpointed = toV2(select(createV1Record()), { deliveryCreationState: 'checkpointed' });
  assert.throws(() => normalizeQuestionReservation(reservationFor(checkpointed, {
    sourceClaimsDigest: hostileValue,
  })));
  assert.equal(calls, 0);
});

test('compact digests and encoding do not invoke inherited array or object toJSON hooks', () => {
  const detail = toV2(createV1Record());
  const input = journal([detail], [reservationFor(detail)]);
  const originalArrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  const originalObjectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  let calls = 0;

  try {
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      get() { calls += 1; return () => { calls += 1; }; },
    });
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() { calls += 1; return () => { calls += 1; }; },
    });
    questionRecordDigest(detail);
    questionCommonKeyDigest(detail.identity, detail.periodId, detail.questionId);
    encodeQuestionJournalV2Local(input);
  } finally {
    if (originalArrayToJSON) Object.defineProperty(Array.prototype, 'toJSON', originalArrayToJSON);
    else delete Array.prototype.toJSON;
    if (originalObjectToJSON) Object.defineProperty(Object.prototype, 'toJSON', originalObjectToJSON);
    else delete Object.prototype.toJSON;
  }

  assert.equal(calls, 0);
});

test('maximum legal question and answer lengths with escapes and surrogate code units encode within schema depth', () => {
  function escapedString(length) {
    const token = '"\\\u0000\ud800';
    let value = 'x';
    while (value.length < length) value += token;
    return value.slice(0, length);
  }

  const maxQuestions = Array.from({ length: 4 }, (_, questionIndex) => ({
    id: `q-${questionIndex}`,
    text: escapedString(2_000),
    mode: 'single',
    options: Array.from({ length: 6 }, (_, optionIndex) => ({
      id: `o-${questionIndex}-${optionIndex}`,
      label: escapedString(200),
      description: escapedString(2_000),
    })),
    allowFreeText: true,
    recommendedOptionId: `o-${questionIndex}-0`,
  }));
  const identity = {
    provider: 'codex',
    nativeIdKind: 'thread',
    hostId: 'h'.repeat(512),
    homeScopeId: 's'.repeat(512),
    nativeId: 'n'.repeat(512),
  };
  const v1 = createV1Record({
    provider: 'codex',
    internalQuestionId: 'internal-max',
    questionId: 'p'.repeat(512),
    periodId: 'r'.repeat(512),
    identity,
    questions: maxQuestions,
  });
  const answers = maxQuestions.map((question) => ({
    questionId: question.id,
    optionIds: [`o-${question.id.slice(2)}-0`],
    freeText: escapedString(2_000),
  }));
  const selected = selectionFor(v1, answers, 'manual', v1.createdAt + 1, 'fixed-uuid').record;
  const lateAnswers = Array.from({ length: 10 }, (_, index) => ({
    submittedAt: selected.createdAt + index,
    digest: sha256Json(answers),
    answers,
  }));
  const detail = toV2({ ...selected, lateAnswers });
  const normalized = normalizeQuestionDetailV2(detail);
  const encoded = encodeQuestionJournalV2Local(journal([normalized], [reservationFor(normalized)]));

  assert.equal(normalized.questions.length, 4);
  assert.equal(normalized.questions[0].text.length, 2_000);
  assert.equal(normalized.questions[0].options[0].description.length, 2_000);
  assert.equal(normalized.selection.answers[0].freeText.length, 2_000);
  assert.equal(normalized.lateAnswers.length, 10);
  assert.equal(createHash('sha256').update(encoded.bytes).digest('hex'), encoded.sha256);
  assert.ok(encoded.sizeBytes > 0);
});

test('common key digest follows the existing identity-period-question tuple', () => {
  const detail = toV2(createV1Record({ provider: 'codex' }));
  const values = [
    detail.identity.provider,
    detail.identity.nativeIdKind,
    detail.identity.hostId,
    detail.identity.homeScopeId,
    detail.identity.nativeId,
  ];
  const expected = createHash('sha256').update(JSON.stringify([values, detail.periodId, detail.questionId]), 'utf8').digest('hex');
  assert.equal(questionCommonKeyDigest(detail.identity, detail.periodId, detail.questionId), expected);
});

test('record digest uses the documented compact field order and encoding roundtrips without changing input', () => {
  const detail = toV2(select(createV1Record({ autoApplyEnabledAtRegistration: true })));
  const expectedContentDigest = createHash('sha256').update(JSON.stringify({
    category: detail.category,
    questions: detail.questions.map(canonicalQuestion),
  }), 'utf8').digest('hex');
  assert.equal(detail.contentDigest, expectedContentDigest);

  const expectedRecordDigest = createHash('sha256')
    .update(JSON.stringify(canonicalDetail(detail)), 'utf8')
    .digest('hex');
  assert.equal(questionRecordDigest(detail), expectedRecordDigest);
  const invalidContentDigest = { ...detail, contentDigest: 'b'.repeat(64) };
  assert.throws(() => questionRecordDigest(invalidContentDigest));

  const input = journal([detail], [reservationFor(detail)]);
  const before = structuredClone(input);
  const encoded = encodeQuestionJournalV2Local(input);
  const roundtrip = JSON.parse(encoded.bytes.toString('utf8'));
  assert.deepEqual(roundtrip, normalizeQuestionJournalV2Local(input));
  assert.equal(encoded.sha256, createHash('sha256').update(encoded.bytes).digest('hex'));
  assert.deepEqual(input, before);
});
