'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeQuestionReservation } = require('../src/server/common-question-reclamation-codec');
const { normalizeDeliveryRecordV2Local } = require('../src/server/delivery-reclamation-codec');
const { encodeNormalized } = require('../src/server/reclamation-json-codec');
const { createReclaimedQuestionPairFixture } = require('./helpers/reclaimed-question-pair-fixtures');
const {
  ASCII_ESCAPED_IDENTIFIER,
  MAX_ESCAPED_IDENTIFIER,
  MAX_ESCAPED_STRING_BYTES,
  MAX_SAFE_INTEGER,
  QUESTION_GRAVE_MAX_SHAPE,
  QUESTION_RESERVATION_MAX_SHAPE,
  assertShapeFits,
  createMaximumQuestionGrave,
  createMaximumQuestionReservation,
  prettyJsonUpperBound,
  measureJson,
} = require('./helpers/reclaimed-question-record-byte-fixtures');

function assertIndependentEncoding(normalized, expectedUpperBound) {
  const measured = measureJson(normalized, encodeNormalized);
  assert.equal(measured.encodedText, measured.prettyWithLf);
  assert.equal(measured.encodedBytes, measured.prettyBytes);
  assert.equal(measured.encodedLength, measured.prettyBytes);
  assert.ok(measured.prettyBytes <= expectedUpperBound);
  assert.equal(measured.compactBytes, Buffer.byteLength(JSON.stringify(normalized), 'utf8'));
  return measured;
}

test('最大構造shapeのQ reservationとCP graveは独立byte上界を満たす', () => {
  const questionBound = prettyJsonUpperBound(QUESTION_RESERVATION_MAX_SHAPE) + 1;
  const graveBound = prettyJsonUpperBound(QUESTION_GRAVE_MAX_SHAPE) + 1;
  assert.equal(questionBound, 90_224);
  assert.equal(graveBound, 161_394);

  for (const provider of ['claude', 'codex']) {
    const question = normalizeQuestionReservation(createMaximumQuestionReservation({ provider }));
    const grave = normalizeDeliveryRecordV2Local(createMaximumQuestionGrave({ provider }));
    assertShapeFits(question, QUESTION_RESERVATION_MAX_SHAPE);
    assertShapeFits(grave, QUESTION_GRAVE_MAX_SHAPE);
    const questionMeasurement = assertIndependentEncoding(question, questionBound);
    const graveMeasurement = assertIndependentEncoding(grave, graveBound);
    const expected = provider === 'claude'
      ? { question: [44_566, 44_326], grave: [109_624, 109_134] }
      : { question: [44_564, 44_324], grave: [109_620, 109_130] };
    assert.deepEqual([questionMeasurement.prettyBytes, questionMeasurement.compactBytes], expected.question);
    assert.deepEqual([graveMeasurement.prettyBytes, graveMeasurement.compactBytes], expected.grave);
  }
});

test('null固定shapeのownerGenerationはnullを許し、それ以外を拒否する', () => {
  const grave = normalizeDeliveryRecordV2Local(createMaximumQuestionGrave());
  assert.equal(grave.ownerGeneration, null);
  assert.doesNotThrow(() => assertShapeFits(grave, QUESTION_GRAVE_MAX_SHAPE));

  for (const ownerGeneration of [0, '0', {}]) {
    assert.throws(() => assertShapeFits({ ...grave, ownerGeneration }, QUESTION_GRAVE_MAX_SHAPE),
      /unexpected_value:ownerGeneration/);
  }
});

test('512 code unitのsurrogate identifierは両record normalizerで受理される', () => {
  assert.equal(MAX_ESCAPED_IDENTIFIER.length, 512);
  assert.equal(Buffer.byteLength(JSON.stringify(MAX_ESCAPED_IDENTIFIER), 'utf8'), MAX_ESCAPED_STRING_BYTES);
  const question = normalizeQuestionReservation(createMaximumQuestionReservation());
  const grave = normalizeDeliveryRecordV2Local(createMaximumQuestionGrave());
  assert.equal(question.internalQuestionId, MAX_ESCAPED_IDENTIFIER);
  assert.equal(grave.deliveryAttemptId, MAX_ESCAPED_IDENTIFIER);
  assertIndependentEncoding(question, prettyJsonUpperBound(QUESTION_RESERVATION_MAX_SHAPE) + 1);
  assertIndependentEncoding(grave, prettyJsonUpperBound(QUESTION_GRAVE_MAX_SHAPE) + 1);
});

test('引用符とbackslashを含む512 code unit identifierは受理され上界内に収まる', () => {
  assert.equal(ASCII_ESCAPED_IDENTIFIER.length, 512);
  assert.equal(Buffer.byteLength(JSON.stringify(ASCII_ESCAPED_IDENTIFIER), 'utf8'), 1_026);
  for (const provider of ['claude', 'codex']) {
    const question = normalizeQuestionReservation(createMaximumQuestionReservation({
      identifier: ASCII_ESCAPED_IDENTIFIER,
      provider,
    }));
    const grave = normalizeDeliveryRecordV2Local(createMaximumQuestionGrave({
      identifier: ASCII_ESCAPED_IDENTIFIER,
      provider,
    }));
    assertIndependentEncoding(question, prettyJsonUpperBound(QUESTION_RESERVATION_MAX_SHAPE) + 1);
    assertIndependentEncoding(grave, prettyJsonUpperBound(QUESTION_GRAVE_MAX_SHAPE) + 1);
  }
});

test('513 code unit identifierはQ reservationとCP graveで拒否される', () => {
  const tooLong = 'x'.repeat(513);
  assert.equal(tooLong.length, 513);
  assert.throws(() => normalizeQuestionReservation(createMaximumQuestionReservation({ identifier: tooLong })));
  assert.throws(() => normalizeDeliveryRecordV2Local(createMaximumQuestionGrave({ identifier: tooLong })));
});

test('question graveのstateとcorrelation nullable branchは最大構造shape内に収まる', () => {
  const graveBound = prettyJsonUpperBound(QUESTION_GRAVE_MAX_SHAPE) + 1;
  const branches = [
    { state: 'available', terminalAt: null, acceptedCorrelation: null, appliedCorrelation: null },
    { state: 'unknown', terminalAt: null, acceptedCorrelation: null, appliedCorrelation: null },
    { state: 'unknown', terminalAt: null, acceptedCorrelation: 'accepted', appliedCorrelation: null },
    { state: 'unknown', terminalAt: null, acceptedCorrelation: 'accepted-null-native', appliedCorrelation: null },
    { state: 'applied', terminalAt: MAX_SAFE_INTEGER - 604_800_000, acceptedCorrelation: null,
      appliedCorrelation: 'applied' },
    { state: 'applied', terminalAt: MAX_SAFE_INTEGER - 604_800_000, acceptedCorrelation: 'accepted',
      appliedCorrelation: 'applied' },
    { state: 'applied', terminalAt: MAX_SAFE_INTEGER - 604_800_000,
      acceptedCorrelation: 'accepted-null-native', appliedCorrelation: 'applied' },
    { state: 'cancelled_before_send', terminalAt: MAX_SAFE_INTEGER - 604_800_000,
      acceptedCorrelation: null, appliedCorrelation: null },
    { state: 'superseded_before_send', terminalAt: MAX_SAFE_INTEGER - 604_800_000,
      acceptedCorrelation: null, appliedCorrelation: null },
  ];

  for (const provider of ['claude', 'codex']) {
    for (const branch of branches) {
      const input = createMaximumQuestionGrave({ provider });
      input.state = branch.state;
      input.terminalAt = branch.terminalAt;
      if (branch.acceptedCorrelation === null) {
        input.acceptedCorrelation = null;
      } else if (branch.acceptedCorrelation === 'accepted-null-native') {
        input.acceptedCorrelation.nativeTurnId = null;
        input.acceptedCorrelation.nativeItemId = null;
      }
      input.appliedCorrelation = branch.appliedCorrelation === 'applied' ? input.appliedCorrelation : null;
      const grave = normalizeDeliveryRecordV2Local(input);
      assertShapeFits(grave, QUESTION_GRAVE_MAX_SHAPE);
      assertIndependentEncoding(grave, graveBound);
    }
  }
});

test('ready pair fixtureのnullable branchとstateは両providerで最大構造shape内に収まる', () => {
  const variants = [
    { presence: 'none', selected: false },
    { presence: 'none', selected: true },
    { presence: 'indeterminate', selected: true },
    ...['available', 'unknown', 'applied', 'cancelled_before_send', 'superseded_before_send']
      .map((state) => ({ presence: 'checkpoint', selected: true, state })),
  ];
  const questionBound = prettyJsonUpperBound(QUESTION_RESERVATION_MAX_SHAPE) + 1;
  const graveBound = prettyJsonUpperBound(QUESTION_GRAVE_MAX_SHAPE) + 1;

  for (const provider of ['claude', 'codex']) {
    for (const variant of variants) {
      const fixture = createReclaimedQuestionPairFixture({ provider, ...variant });
      const question = normalizeQuestionReservation(fixture.reservation);
      assertShapeFits(question, QUESTION_RESERVATION_MAX_SHAPE);
      assertIndependentEncoding(question, questionBound);
      if (fixture.delivery !== null) {
        const grave = normalizeDeliveryRecordV2Local(fixture.delivery);
        assertShapeFits(grave, QUESTION_GRAVE_MAX_SHAPE);
        assertIndependentEncoding(grave, graveBound);
      }
    }
  }
});
