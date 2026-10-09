'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuestionPeriodGate } = require('../src/server/question-period-gate');

const identity = Object.freeze({
  provider: 'claude',
  nativeIdKind: 'session',
  hostId: 'host-a',
  homeScopeId: 'scope-a',
  nativeId: 'session-a',
});

function anchor(retiredQuestionPeriods = [], revision = 0) {
  return {
    schemaVersion: 1,
    revision,
    storeId: '11111111-1111-4111-8111-111111111111',
    retiredQuestionPeriods,
    migration: null,
  };
}

function retiredPeriod(value = identity, periodId = 'period-a') {
  return { identity: value, periodId, retiredAt: 20, reason: 'confirmed-retirement' };
}

test('a closed gate rejects capture and does not call the anchor', () => {
  let anchorReads = 0;
  const gate = createQuestionPeriodGate({
    getAnchor: () => { anchorReads += 1; return anchor(); },
    canWrite: () => false,
  });

  assert.throws(() => gate.capture(identity, 'period-a'), { code: 'question_gate_closed' });
  assert.equal(anchorReads, 0);
});

test('capture tokens are opaque and retirement synchronously invalidates them', () => {
  let currentAnchor = anchor();
  const gate = createQuestionPeriodGate({ getAnchor: () => currentAnchor, canWrite: () => true });
  const token = gate.capture(identity, 'period-a');

  gate.assertCurrent(token);
  assert.throws(() => gate.assertCurrent({}), { code: 'question_gate_closed' });

  const ticket = gate.beginRetirement(identity, 'period-a');
  assert.equal(gate.isRetired(identity, 'period-a'), true);
  assert.throws(() => gate.capture(identity, 'period-a'), { code: 'question_quarantined' });
  assert.throws(() => gate.assertCurrent(token), { code: 'question_quarantined' });
  assert.throws(() => gate.assertRetirement({}), { code: 'question_quarantined' });
  assert.deepEqual(gate.assertRetirement(ticket), { identity, periodId: 'period-a' });

  currentAnchor = anchor([retiredPeriod()], 1);
  gate.finishRetirement(ticket);
  assert.equal(gate.snapshot().retiringCount, 0);
  assert.equal(gate.snapshot().retiredCount, 1);
  assert.throws(() => gate.capture(identity, 'period-a'), { code: 'question_quarantined' });
});

test('persistent retirement is recognized after constructing a new gate', () => {
  const gate = createQuestionPeriodGate({
    getAnchor: () => anchor([retiredPeriod()], 1),
    canWrite: () => true,
  });

  assert.equal(gate.isRetired(identity, 'period-a'), true);
  assert.throws(() => gate.capture(identity, 'period-a'), { code: 'question_quarantined' });
});

test('retirement is keyed by the exact identity and period', () => {
  let currentAnchor = anchor([retiredPeriod()], 1);
  const gate = createQuestionPeriodGate({ getAnchor: () => currentAnchor, canWrite: () => true });
  const otherIdentity = { ...identity, nativeId: 'session-b' };

  assert.equal(gate.isRetired(identity, 'period-a'), true);
  assert.equal(gate.isRetired(otherIdentity, 'period-a'), false);
  currentAnchor = anchor([retiredPeriod()], 1);
  assert.throws(() => gate.capture(identity, 'period-a'), { code: 'question_quarantined' });
  assert.doesNotThrow(() => gate.capture(otherIdentity, 'period-a'));
});

test('identity accessors fail without execution and async readiness callbacks stay closed', () => {
  let getterCalls = 0;
  const accessorIdentity = { ...identity };
  Object.defineProperty(accessorIdentity, 'provider', {
    enumerable: true,
    get() { getterCalls += 1; return 'claude'; },
  });
  const gate = createQuestionPeriodGate({ getAnchor: () => anchor(), canWrite: () => true });

  assert.throws(() => gate.capture(accessorIdentity, 'period-a'), { code: 'invalid_question_gate_identity' });
  assert.equal(getterCalls, 0);
  const asyncGate = createQuestionPeriodGate({ getAnchor: () => anchor(), canWrite: () => Promise.resolve(true) });
  assert.throws(() => asyncGate.capture(identity, 'period-a'), { code: 'question_gate_closed' });
});

test('a malformed anchor fails the gate closed', () => {
  const gate = createQuestionPeriodGate({ getAnchor: () => ({ schemaVersion: 1 }), canWrite: () => true });

  assert.throws(() => gate.capture(identity, 'period-a'), { code: 'question_gate_closed' });
  assert.equal(gate.snapshot().blocked, true);
  assert.equal(gate.isRetired(identity, 'period-a'), true);
});
