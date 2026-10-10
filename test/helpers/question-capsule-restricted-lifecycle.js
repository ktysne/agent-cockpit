'use strict';

const crypto = require('node:crypto');
const { captureFileRecord, preflightFileRow } = require('../../src/server/question-capsule-file-primitives');
const { selectionFor } = require('../../src/server/common-question-kernel');
const { transitionReclamationDelivery } = require('../../src/server/delivery-reclamation-runtime');
const {
  expandQuestionDeliveryCapsule,
  expandQuestionRejectionCapsule,
} = require('../../src/server/question-rejection-capsule-codec');
const { createQuestionCapsuleExistingUpdateWorkspace } =
  require('./question-capsule-existing-update-workspace');

const INVALID = 'invalid_question_capsule_restricted_lifecycle';
const NOT_STARTED = 'question_capsule_restricted_lifecycle_not_started';
const CLOSED = 'question_capsule_restricted_lifecycle_closed';
const BLOCKED = 'question_capsule_restricted_lifecycle_blocked';
const UNSUPPORTED = 'question_capsule_restricted_lifecycle_unsupported_operation';
const OPTIONS = Object.freeze(['provider', 'scenario']);
const PROVIDERS = new Set(['claude', 'codex']);
const SCENARIOS = new Set([
  'standard',
  'unselected',
  'budget_shortage',
  'pause_before_temp_open',
  'question_before_rename',
  'question_after_rename',
  'checkpoint_before_rename',
  'checkpoint_after_rename',
]);
const BEFORE_RENAME_SCENARIOS = new Set(['question_before_rename', 'checkpoint_before_rename']);
const FIXTURE_QUESTION_ID = 'internal-5';
const ACCEPTED_CORRELATION_FIELDS = Object.freeze([
  'deliveryAttemptId', 'revision', 'payloadDigest', 'targetPeriodId',
  'nativeTurnId', 'nativeItemId', 'clientRequestId',
]);

function failure(code) {
  const error = new TypeError(code);
  error.code = code;
  return error;
}

function requireValue(condition, code = INVALID) {
  if (!condition) throw failure(code);
}

function captureOptions(value) {
  const options = captureFileRecord(value, OPTIONS, INVALID);
  requireValue(PROVIDERS.has(options.provider));
  requireValue(SCENARIOS.has(options.scenario));
  return options;
}

function backendOptionsFor(scenario) {
  if (scenario === 'pause_before_temp_open') return { pausePoint: 'before_atomic_temp_open' };
  if (scenario === 'question_before_rename') return { failurePoint: 'questions_before_rename' };
  if (scenario === 'question_after_rename') {
    return { failurePoint: 'questions_after_rename_before_readback' };
  }
  if (scenario === 'checkpoint_before_rename') return { failurePoint: 'checkpoint_before_rename' };
  if (scenario === 'checkpoint_after_rename') {
    return { failurePoint: 'checkpoint_after_rename_before_readback' };
  }
  return {};
}

async function createWorkspace(provider, scenario) {
  const ordinaryQuestionSelected = scenario !== 'unselected';
  if (scenario !== 'budget_shortage') {
    return createQuestionCapsuleExistingUpdateWorkspace({ provider, ordinaryQuestionSelected });
  }

  const reference = await createQuestionCapsuleExistingUpdateWorkspace({ provider, ordinaryQuestionSelected });
  const baselineBytes = reference.status().baselineLeaseBytes;
  await reference.dispose();
  return createQuestionCapsuleExistingUpdateWorkspace({
    provider,
    ordinaryQuestionSelected,
    maxAdditionalBytes: baselineBytes,
  });
}

function clone(value) {
  return structuredClone(value);
}

function sameIdentity(left, right) {
  if (!left || !right) return false;
  return ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']
    .every((field) => left[field] === right[field]);
}

function capsuleQuestionIds(questionFile) {
  return new Set(questionFile.questionCapsules.flatMap((entry) =>
    expandQuestionRejectionCapsule(entry.capsule).map((reservation) => reservation.internalQuestionId)));
}

function structureSummary(current) {
  const questionFile = current?.questionFile ?? null;
  const checkpointFile = current?.checkpointFile ?? null;
  if (questionFile === null || checkpointFile === null) return null;
  const structure = {
    questionCapsules: questionFile.questionCapsules,
    checkpointCapsules: checkpointFile.checkpointCapsules,
    questionReservationOrder: questionFile.reservationOrder,
    deliveryAttemptOrder: checkpointFile.deliveryAttemptOrder,
  };
  return {
    questionCapsuleChunks: questionFile.questionCapsules.length,
    checkpointCapsuleChunks: checkpointFile.checkpointCapsules.length,
    ordinaryQuestionReservationRows: questionFile.reservations.length,
    capsuleQuestionReservationRows: questionFile.questionCapsules.reduce((total, entry) =>
      total + expandQuestionRejectionCapsule(entry.capsule).length, 0),
    ordinaryDeliveryRows: checkpointFile.ledger.deliveries.length,
    capsuleDeliveryRows: checkpointFile.checkpointCapsules.reduce((total, entry) =>
      total + expandQuestionDeliveryCapsule(entry.capsule).length, 0),
    questionReservationOrderEntries: questionFile.reservationOrder.length,
    deliveryAttemptOrderEntries: checkpointFile.deliveryAttemptOrder.length,
    capsuleStructureSha256: crypto.createHash('sha256').update(JSON.stringify(structure)).digest('hex'),
  };
}

function selectedQuestionSummary(current) {
  if (current?.questionFile === null || current?.questionFile === undefined) return null;
  const row = current.questionFile.questions.find((question) => question.internalQuestionId === FIXTURE_QUESTION_ID);
  return row === undefined ? null : {
    selected: row.selection !== null,
    selectionSha256: row.selection === null ? null
      : crypto.createHash('sha256').update(JSON.stringify(row.selection)).digest('hex'),
    lateAnswerCount: row.lateAnswers.length,
  };
}

function instructionSummary(current) {
  if (current?.checkpointFile === null || current?.checkpointFile === undefined) return null;
  const row = current.checkpointFile.ledger.deliveries.find((delivery) =>
    delivery.kind === 'instruction' && delivery.recordType === 'detail');
  return row === undefined ? null : { state: row.state, revision: row.revision };
}

async function createQuestionCapsuleRestrictedLifecycle(value) {
  const { provider, scenario } = captureOptions(value);
  const workspace = await createWorkspace(provider, scenario);
  let backend;
  try {
    backend = workspace.openBackend(backendOptionsFor(scenario));
  } catch (error) {
    await workspace.dispose();
    throw error;
  }
  let current = null;
  let state = 'new';
  let started = false;
  let closing = false;
  let closed = false;
  let disposed = false;
  let blockedReason = null;
  let outcomeUnknown = false;
  let knownOrphan = false;
  let activeOperation = null;
  let pendingOperations = 0;
  let questionWriteAttempts = 0;
  let checkpointWriteAttempts = 0;
  let completedQuestionWrites = 0;
  let completedCheckpointWrites = 0;
  let logicalTime = 2_100_000;
  let tail = Promise.resolve();
  let startPromise = null;
  let closePromise = null;
  let reopenPromise = null;
  let disposePromise = null;
  let lastOperation = null;

  function backendStatus() {
    return backend.status();
  }

  function refreshLatch() {
    const status = backendStatus();
    if (status.blockedReason !== null) {
      blockedReason = status.blockedReason;
      if (status.blockedReason === 'write_result_unknown') {
        outcomeUnknown = true;
        const questionFault = scenario === 'question_before_rename' &&
          activeOperation === 'submit_late_answer';
        const checkpointFault = scenario === 'checkpoint_before_rename' &&
          activeOperation === 'advance_fixture_delivery';
        if (questionFault || checkpointFault) knownOrphan = true;
      }
      if (!closing && !disposed) state = 'blocked';
    }
    return status;
  }

  function ensureOpen() {
    if (disposed || closing || closed) throw failure(CLOSED);
    const status = refreshLatch();
    if (blockedReason !== null || status.blockedReason !== null) throw failure(BLOCKED);
  }

  function enqueue(name, operation) {
    if (disposed || closing || closed) return Promise.reject(failure(CLOSED));
    pendingOperations += 1;
    const run = tail.then(async () => {
      pendingOperations -= 1;
      ensureOpen();
      activeOperation = name;
      try {
        return await operation();
      } catch (error) {
        refreshLatch();
        throw error;
      } finally {
        activeOperation = null;
      }
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  function updateCurrent(loaded) {
    current = loaded;
    const status = refreshLatch();
    if (!closing && !closed && !disposed && status.blockedReason === null) state = 'ready';
  }

  async function loadLatest() {
    const loaded = await backend.load();
    if (closing || closed || disposed) throw failure(CLOSED);
    const status = refreshLatch();
    if (status.blockedReason !== null) throw failure(BLOCKED);
    updateCurrent(loaded);
    return loaded;
  }

  function publicStatus() {
    const backend = backendStatus();
    const ws = workspace.status();
    const blocked = blockedReason !== null || backend.blockedReason !== null;
    const visibleState = disposed ? 'disposed'
      : closing ? 'closing'
        : blocked ? 'blocked'
          : closed ? 'closed'
            : state;
    return {
      state: visibleState,
      started,
      closing,
      closed,
      disposed,
      blocked,
      blockedReason: blockedReason ?? backend.blockedReason,
      outcomeUnknown,
      activeOperation,
      pendingOperations,
      pauseReached: backend.pauseReached,
      baselineLeaseHeld: ws.baselineLeaseHeld,
      baselineLeaseBytes: ws.baselineLeaseBytes,
      reservedBudgetBytes: ws.budget.reservedBytes,
      operationLeaseHeld: backend.operationLeaseHeld,
      saveAttempts: { questions: questionWriteAttempts, checkpoint: checkpointWriteAttempts },
      completedSaves: { questions: completedQuestionWrites, checkpoint: completedCheckpointWrites },
      question: selectedQuestionSummary(current),
      instruction: instructionSummary(current),
      structure: structureSummary(current),
      lastOperation,
    };
  }

  function start(...args) {
    if (args.length !== 0) return Promise.reject(failure(INVALID));
    if (disposed || closing || closed) return Promise.reject(failure(CLOSED));
    if (started) return Promise.resolve(publicStatus());
    if (startPromise !== null) return startPromise;
    startPromise = enqueue('start', async () => {
      state = 'loading';
      try {
        const loaded = await backend.load();
        if (closing || closed || disposed) throw failure(CLOSED);
        current = loaded;
        const status = refreshLatch();
        if (status.blockedReason !== null) throw failure(BLOCKED);
        started = true;
        state = 'ready';
        lastOperation = 'start';
        return publicStatus();
      } catch (error) {
        refreshLatch();
        if (!closing && !closed && !disposed && blockedReason === null) state = 'blocked';
        throw error;
      }
    });
    return startPromise;
  }

  function requireStarted() {
    if (disposed || closing || closed) throw failure(CLOSED);
    if (!started) throw failure(NOT_STARTED);
    ensureOpen();
  }

  function submitLateAnswer(value) {
    let input;
    try {
      requireStarted();
      input = captureFileRecord(value, ['internalQuestionId', 'answers'], INVALID);
      requireValue(typeof input.internalQuestionId === 'string' && input.internalQuestionId.length > 0);
      preflightFileRow(input.answers, INVALID);
      input.answers = clone(input.answers);
    } catch (error) {
      return Promise.reject(error instanceof TypeError ? error : failure(INVALID));
    }

    return enqueue('submit_late_answer', async () => {
      const loaded = await loadLatest();
      const questionFile = loaded.questionFile;
      const rowIndex = questionFile.questions.findIndex((question) =>
        question.internalQuestionId === input.internalQuestionId);
      if (rowIndex < 0 || capsuleQuestionIds(questionFile).has(input.internalQuestionId)) {
        throw failure(UNSUPPORTED);
      }
      const row = questionFile.questions[rowIndex];
      const reservation = questionFile.reservations.find((entry) =>
        entry.internalQuestionId === input.internalQuestionId);
      const retired = loaded.projection.anchor.retiredQuestionPeriods.some((entry) =>
        entry.periodId === row.periodId && sameIdentity(entry.identity, row.identity));
      if (retired || reservation?.bodyState !== 'retained' || reservation?.quarantinedAt !== null ||
          row.category !== 'ordinary' || row.selection === null ||
          row.cancelledAt !== null || row.externalResolution !== null || row.quarantinedAt !== null) {
        throw failure(UNSUPPORTED);
      }

      const detail = clone(row);
      delete detail.deliveryCreationState;
      delete detail.quarantinedAt;
      logicalTime = Math.max(logicalTime + 1, row.createdAt + 1);
      let selection;
      try {
        selection = selectionFor(detail, input.answers, 'manual', logicalTime, `restricted-late-${logicalTime}`);
      } catch {
        throw failure(INVALID);
      }
      if (selection.outcome === 'duplicate') {
        lastOperation = 'late_answer_duplicate';
        return { outcome: 'duplicate', saved: false };
      }
      if (selection.outcome !== 'late') throw failure(UNSUPPORTED);

      const candidate = clone(questionFile);
      candidate.questions[rowIndex].lateAnswers = clone(selection.record.lateAnswers);
      candidate.revision += 1;
      ensureOpen();
      questionWriteAttempts += 1;
      const saved = await backend.saveQuestion({ questionFile: candidate, expectedHead: loaded.heads.questions });
      updateCurrent(saved);
      completedQuestionWrites += 1;
      lastOperation = 'late_answer_saved';
      return { outcome: 'late', saved: true };
    });
  }

  function advanceFixtureDelivery(...args) {
    if (args.length !== 0) return Promise.reject(failure(INVALID));
    try { requireStarted(); } catch (error) { return Promise.reject(error); }

    return enqueue('advance_fixture_delivery', async () => {
      const loaded = await loadLatest();
      const checkpointFile = loaded.checkpointFile;
      if (checkpointFile === null) throw failure(UNSUPPORTED);
      const rows = checkpointFile.ledger.deliveries;
      const rowIndex = rows.findIndex((delivery) =>
        delivery.kind === 'instruction' && delivery.recordType === 'detail');
      if (rowIndex < 0) throw failure(UNSUPPORTED);
      const row = rows[rowIndex];
      const capsuleDeliveryIds = new Set(checkpointFile.checkpointCapsules.flatMap((entry) =>
        expandQuestionDeliveryCapsule(entry.capsule).map((delivery) => delivery.deliveryAttemptId)));
      if (capsuleDeliveryIds.has(row.deliveryAttemptId)) throw failure(UNSUPPORTED);
      const correlation = {
        deliveryAttemptId: row.deliveryAttemptId,
        revision: row.revision,
        payloadDigest: row.payloadDigest,
        targetPeriodId: row.target.periodId,
        nativeTurnId: 'restricted-lifecycle-native-turn',
        nativeItemId: null,
        clientRequestId: row.deliveryAttemptId,
      };
      if (row.state === 'accepted' && ACCEPTED_CORRELATION_FIELDS.every((field) =>
        row.acceptedCorrelation?.[field] === correlation[field])) {
        lastOperation = 'fixture_delivery_duplicate';
        return { outcome: 'duplicate', saved: false };
      }
      if (row.state !== 'available') throw failure(UNSUPPORTED);

      const checkpointSnapshot = loaded.projection.stores.checkpoint;
      let transition;
      try {
        const sending = transitionReclamationDelivery(checkpointSnapshot,
          row.deliveryAttemptId, 'sendStart', undefined);
        transition = transitionReclamationDelivery({
          ...checkpointSnapshot,
          ledger: sending.ledger,
        }, row.deliveryAttemptId, 'accepted', correlation);
      } catch {
        throw failure(UNSUPPORTED);
      }
      if (!transition.changed || transition.delivery.state !== 'accepted') throw failure(UNSUPPORTED);

      const candidate = clone(checkpointFile);
      candidate.ledger.deliveries[rowIndex] = clone(transition.delivery);
      candidate.ledger.revision = transition.ledger.revision;
      candidate.revision += 1;
      ensureOpen();
      checkpointWriteAttempts += 1;
      const saved = await backend.saveCheckpoint({
        checkpointFile: candidate,
        expectedHead: loaded.heads.checkpoint,
      });
      updateCurrent(saved);
      completedCheckpointWrites += 1;
      lastOperation = 'fixture_delivery_accepted';
      return { outcome: 'accepted', saved: true };
    });
  }

  function waitForPause(...args) {
    if (args.length !== 0) return Promise.reject(failure(INVALID));
    if (disposed) return Promise.resolve(false);
    return backend.waitForPause();
  }

  function close(...args) {
    if (args.length !== 0) return Promise.reject(failure(INVALID));
    if (closePromise !== null) return closePromise;
    if (disposed) return Promise.resolve(publicStatus());
    closing = true;
    started = false;
    state = 'closing';
    let backendClosing;
    try { backendClosing = backend.close(); } catch (error) { backendClosing = Promise.reject(error); }
    const closingTail = tail;
    closePromise = (async () => {
      const settled = await Promise.allSettled([closingTail, backendClosing]);
      closed = true;
      closing = false;
      const status = refreshLatch();
      state = status.blockedReason === null && blockedReason === null ? 'closed' : 'blocked';
      const failed = settled.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      return publicStatus();
    })();
    return closePromise;
  }

  function reopen(...args) {
    if (args.length !== 0) return Promise.reject(failure(INVALID));
    if (disposed) return Promise.reject(failure(CLOSED));
    if (!closed || closing) return Promise.reject(failure(UNSUPPORTED));
    if (reopenPromise !== null) return reopenPromise;
    try {
      backend = workspace.openBackend();
      closing = false;
      closed = false;
      started = false;
      blockedReason = null;
      state = 'new';
      closePromise = null;
      startPromise = null;
      const opening = start();
      reopenPromise = opening.finally(() => { reopenPromise = null; });
    } catch (error) {
      return Promise.reject(error);
    }
    return reopenPromise;
  }

  function dispose(...args) {
    if (args.length !== 0) return Promise.reject(failure(INVALID));
    if (disposePromise !== null) return disposePromise;
    disposed = true;
    closing = true;
    started = false;
    state = 'disposing';
    let backendClosing;
    try { backendClosing = backend.close(); } catch (error) { backendClosing = Promise.reject(error); }
    const closingTail = tail;
    disposePromise = (async () => {
      await Promise.all([closingTail, backendClosing]);
      if (knownOrphan) {
        const removed = await workspace.cleanupInjectedOrphan();
        requireValue(removed === 1, 'question_capsule_restricted_lifecycle_cleanup_failed');
        knownOrphan = false;
      }
      await workspace.dispose();
      closed = true;
      closing = false;
      state = 'disposed';
      return publicStatus();
    })();
    return disposePromise;
  }

  return Object.freeze({
    start,
    submitLateAnswer,
    advanceFixtureDelivery,
    status: publicStatus,
    waitForPause,
    close,
    reopen,
    dispose,
  });
}

module.exports = { createQuestionCapsuleRestrictedLifecycle };
