'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  assertSha256,
  assertSafeUnsignedInteger,
  checkedAddBytes,
} = require('./reclamation-codec-primitives');
const {
  captureFileRecord,
} = require('./question-capsule-file-primitives');
const {
  FIXED_H_BOUNDS,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
  measureCheckpointReservation,
  measureInstructionReservation,
  measurePendingQuestionPeriodCapacity,
  measureQuestionJournalReservationBytes,
} = require('./reclamation-capacity-bounds');
const {
  measureCheckpointCapsuleExistingUpdateReservation,
  measureQuestionCapsuleExistingUpdateReservation,
} = require('./question-capsule-existing-update-capacity');
const { validateQuestionCapsuleExistingUpdate } = require('./question-capsule-existing-update-validation');
const { validateQuestionCapsuleFiles } = require('./question-capsule-files-validation');
const { decodeCapsuleCheckpointV4Local, encodeCapsuleCheckpointV4Local } =
  require('./question-capsule-checkpoint-codec');
const { decodeQuestionCapsuleJournalV3Local, encodeQuestionCapsuleJournalV3Local } =
  require('./question-capsule-journal-codec');
const { encodeInstructionJournalV2Local } = require('./delivery-reclamation-codec');
const { encodeQuestionReclamationAnchorV1Local } = require('./question-reclamation-anchor-codec');
const { decodeSourceBytes } = require('./reclamation-json-codec');
const { measureReclamationStoreCapacity } = require('./reclamation-capacity-reservation');
const { createReclamationPersistence } = require('./reclamation-persistence');

const INVALID_BACKEND = 'invalid_question_capsule_existing_update_backend';
const CLOSED_BACKEND = 'question_capsule_existing_update_backend_closed';
const BLOCKED_BACKEND = 'question_capsule_existing_update_backend_blocked';
const STALE_HEAD = 'stale_question_capsule_existing_update_head';
const PATH_BASENAMES = Object.freeze({
  anchor: 'question-reclamation-anchor.json',
  questions: 'common-question-journal.json',
  checkpoint: 'delivery-checkpoint.json',
  instructions: 'instruction-journal.json',
});
const CONFIG_FIELDS = Object.freeze([
  'anchorPath', 'slotPathsBySlot', 'expectedAnchorFingerprint', 'expectedInstructionFingerprint',
  'normalByteLimitsBySlot', 'capacityBudget', 'pausePoint', 'failurePoint',
]);
const SLOT_PATH_FIELDS = Object.freeze(['questions', 'checkpoint', 'instructions']);
const LIMIT_FIELDS = Object.freeze(['questions', 'checkpoint', 'instructions']);
const FINGERPRINT_FIELDS = Object.freeze(['sizeBytes', 'sha256']);
const SAVE_FIELDS = Object.freeze({
  questions: Object.freeze(['questionFile', 'expectedHead']),
  checkpoint: Object.freeze(['checkpointFile', 'expectedHead']),
});
const HEAD_FIELDS = Object.freeze(['revision', 'sizeBytes', 'sha256']);
const PAUSE_POINTS = new Set([null, 'before_atomic_temp_open']);
const FAILURE_POINTS = new Set([
  null,
  'questions_before_rename',
  'questions_after_rename_before_readback',
  'checkpoint_before_rename',
  'checkpoint_after_rename_before_readback',
]);
const INSTRUCTION_RAW_MAX_BYTES = MAX_SOURCE_BYTES + FIXED_H_BOUNDS.instructions;
const SCOPE_LIMITATIONS = Object.freeze([
  'fixture_owned_paths_only',
  'constructor_is_not_caller_authentication',
  'process_local_path_ownership_only',
  'external_process_exclusion_not_verified',
  'filesystem_metadata_and_free_space_not_verified',
  'readback_is_not_power_loss_durability',
  'runtime_source_authority_not_verified',
  'runtime_integration_not_verified',
  'count_capacity_release_not_verified',
]);

function fail(code = INVALID_BACKEND, ErrorType = TypeError) {
  const error = new ErrorType(code);
  error.code = code;
  throw error;
}

function requireValue(condition, code = INVALID_BACKEND) {
  if (!condition) fail(code);
}

function captureFingerprint(value, nullable = false) {
  if (nullable && value === null) return null;
  const fingerprint = captureFileRecord(value, FINGERPRINT_FIELDS, INVALID_BACKEND);
  assertSafeUnsignedInteger(fingerprint.sizeBytes, INVALID_BACKEND);
  requireValue(fingerprint.sizeBytes > 0);
  return { sizeBytes: fingerprint.sizeBytes, sha256: assertSha256(fingerprint.sha256, INVALID_BACKEND) };
}

function fingerprint(bytes) {
  if (bytes === null) return null;
  return { sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function sameFingerprint(left, right) {
  if (left === null || right === null) return left === right;
  return left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256;
}

function sameBytes(left, right) {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.equals(right);
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && sameValue(left[key], right[key]));
}

function freezeTree(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeTree(child);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function canonicalPath(value, basename) {
  requireValue(typeof value === 'string' && value.length > 0 && path.isAbsolute(value));
  requireValue(path.resolve(value) === value && path.normalize(value) === value && path.basename(value) === basename);
  return value;
}

function pathComparison(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function captureConfiguration(value) {
  const config = captureFileRecord(value, CONFIG_FIELDS, INVALID_BACKEND);
  const anchorPath = canonicalPath(config.anchorPath, PATH_BASENAMES.anchor);
  const root = path.dirname(anchorPath);
  const tempRoot = path.resolve(os.tmpdir());
  requireValue(pathComparison(path.dirname(root)) === pathComparison(tempRoot));
  requireValue(path.basename(root).startsWith('agent-cockpit-question-capsule-existing-update-'));

  const rawPaths = captureFileRecord(config.slotPathsBySlot, SLOT_PATH_FIELDS, INVALID_BACKEND);
  const slotPathsBySlot = Object.create(null);
  for (const slot of SLOT_PATH_FIELDS) {
    const filePath = canonicalPath(rawPaths[slot], PATH_BASENAMES[slot]);
    requireValue(pathComparison(path.dirname(filePath)) === pathComparison(root));
    slotPathsBySlot[slot] = filePath;
  }

  const rawLimits = captureFileRecord(config.normalByteLimitsBySlot, LIMIT_FIELDS, INVALID_BACKEND);
  const normalByteLimitsBySlot = Object.create(null);
  for (const slot of LIMIT_FIELDS) {
    const limit = rawLimits[slot];
    if (limit === null) {
      normalByteLimitsBySlot[slot] = null;
      continue;
    }
    assertSafeUnsignedInteger(limit, INVALID_BACKEND);
    requireValue(limit > 0 && limit <= MAX_SOURCE_BYTES);
    normalByteLimitsBySlot[slot] = limit;
  }
  requireValue(normalByteLimitsBySlot.questions !== null);

  const anchorFingerprint = captureFingerprint(config.expectedAnchorFingerprint);
  const instructionFingerprint = captureFingerprint(config.expectedInstructionFingerprint, true);
  requireValue((instructionFingerprint === null) === (normalByteLimitsBySlot.instructions === null));

  const budget = captureFileRecord(config.capacityBudget, ['acquire', 'status'], INVALID_BACKEND);
  requireValue(Object.isFrozen(config.capacityBudget) && typeof budget.acquire === 'function' &&
    typeof budget.status === 'function');
  requireValue(PAUSE_POINTS.has(config.pausePoint) && FAILURE_POINTS.has(config.failurePoint));

  return {
    anchorPath,
    root,
    slotPathsBySlot,
    expectedAnchorFingerprint: anchorFingerprint,
    expectedInstructionFingerprint: instructionFingerprint,
    normalByteLimitsBySlot,
    capacityBudget: config.capacityBudget,
    pausePoint: config.pausePoint,
    failurePoint: config.failurePoint,
  };
}

function expectedPresentSlots(configuration) {
  return new Set([
    PATH_BASENAMES.anchor,
    PATH_BASENAMES.questions,
    ...(configuration.normalByteLimitsBySlot.checkpoint === null ? [] : [PATH_BASENAMES.checkpoint]),
    ...(configuration.normalByteLimitsBySlot.instructions === null ? [] : [PATH_BASENAMES.instructions]),
  ]);
}

async function assertOwnedDirectory(configuration) {
  let rootStat;
  let realRoot;
  let entries;
  try {
    rootStat = await fs.lstat(configuration.root);
    realRoot = await fs.realpath(configuration.root);
    entries = await fs.readdir(configuration.root);
  } catch {
    fail('question_capsule_existing_update_path_unavailable');
  }
  requireValue(rootStat.isDirectory() && !rootStat.isSymbolicLink() &&
    pathComparison(realRoot) === pathComparison(configuration.root),
  'question_capsule_existing_update_unsafe_path');
  const expected = expectedPresentSlots(configuration);
  requireValue(entries.length === expected.size && entries.every((entry) => expected.has(entry)),
    'question_capsule_existing_update_unknown_file');
  for (const entry of entries) {
    let stat;
    try {
      stat = await fs.lstat(path.join(configuration.root, entry));
    } catch {
      fail('question_capsule_existing_update_path_unavailable');
    }
    requireValue(stat.isFile() && !stat.isSymbolicLink(), 'question_capsule_existing_update_unsafe_path');
  }
}

function maximum(values) {
  return Math.max(...values);
}

function captureSaveRequest(slot, value) {
  const field = slot === 'questions' ? 'questionFile' : 'checkpointFile';
  const request = captureFileRecord(value, SAVE_FIELDS[slot], INVALID_BACKEND);
  const encoded = slot === 'questions'
    ? encodeQuestionCapsuleJournalV3Local(request[field])
    : encodeCapsuleCheckpointV4Local(request[field]);
  const rawHead = captureFileRecord(request.expectedHead, HEAD_FIELDS, INVALID_BACKEND);
  assertSafeUnsignedInteger(rawHead.revision, INVALID_BACKEND);
  assertSafeUnsignedInteger(rawHead.sizeBytes, INVALID_BACKEND);
  requireValue(rawHead.sizeBytes > 0);
  return {
    slot,
    file: encoded.value,
    bytes: Buffer.from(encoded.bytes),
    head: {
      revision: rawHead.revision,
      sizeBytes: rawHead.sizeBytes,
      sha256: assertSha256(rawHead.sha256, INVALID_BACKEND),
    },
  };
}

function decodeCurrent(raw, configuration) {
  requireValue(raw.anchor !== null && raw.questions !== null);
  requireValue((raw.checkpoint === null) === (configuration.normalByteLimitsBySlot.checkpoint === null));
  requireValue((raw.instructions === null) === (configuration.normalByteLimitsBySlot.instructions === null));

  const anchor = decodeSourceBytes(raw.anchor, NORMAL_ANCHOR_MAX_BYTES).value;
  const questionFile = decodeQuestionCapsuleJournalV3Local(raw.questions);
  const checkpointFile = raw.checkpoint === null ? null : decodeCapsuleCheckpointV4Local(raw.checkpoint);
  const instructionStore = raw.instructions === null ? null
    : decodeSourceBytes(raw.instructions, INSTRUCTION_RAW_MAX_BYTES).value;
  requireValue(encodeQuestionReclamationAnchorV1Local(anchor).bytes.equals(raw.anchor));
  const questionEncoded = encodeQuestionCapsuleJournalV3Local(questionFile);
  requireValue(questionEncoded.bytes.equals(raw.questions));
  if (checkpointFile !== null) {
    requireValue(encodeCapsuleCheckpointV4Local(checkpointFile).bytes.equals(raw.checkpoint));
  }
  if (instructionStore !== null) {
    requireValue(encodeInstructionJournalV2Local(instructionStore).bytes.equals(raw.instructions));
  }

  const validation = validateQuestionCapsuleFiles({
    anchor,
    questionFile,
    checkpointFile,
    instructionStore,
    normalByteLimitsBySlot: configuration.normalByteLimitsBySlot,
  });
  return {
    files: { questionFile, checkpointFile },
    snapshot: validation.snapshot,
    projection: validation.snapshot,
    counts: validation.counts,
  };
}

async function readNativeFiles(persistence, configuration) {
  await assertOwnedDirectory(configuration);
  const anchor = await persistence.readAnchorBytes(NORMAL_ANCHOR_MAX_BYTES);
  const questions = await persistence.readSlotBytes('questions', MAX_SOURCE_BYTES);
  const checkpoint = configuration.normalByteLimitsBySlot.checkpoint === null ? null
    : await persistence.readSlotBytes('checkpoint', MAX_SOURCE_BYTES);
  const instructions = configuration.normalByteLimitsBySlot.instructions === null ? null
    : await persistence.readSlotBytes('instructions', INSTRUCTION_RAW_MAX_BYTES);
  await assertOwnedDirectory(configuration);
  return { anchor, questions, checkpoint, instructions };
}

function fingerprintsFor(raw) {
  return {
    anchor: fingerprint(raw.anchor),
    questions: fingerprint(raw.questions),
    checkpoint: fingerprint(raw.checkpoint),
    instructions: fingerprint(raw.instructions),
  };
}

function sameFingerprints(left, right) {
  return ['anchor', 'questions', 'checkpoint', 'instructions'].every((slot) =>
    sameFingerprint(left[slot], right[slot]));
}

function headFor(file, bytes) {
  if (file === null || bytes === null) return null;
  return { revision: file.revision, ...fingerprint(bytes) };
}

function sameHead(left, right) {
  return left !== null && right !== null && left.revision === right.revision &&
    left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256;
}

function makeLegacyMeasurement(snapshot, raw, normalByteLimitsBySlot) {
  const rawSizeBytesBySlot = Object.create(null);
  const limits = Object.create(null);
  for (const slot of LIMIT_FIELDS) {
    if (snapshot.stores[slot] === null) continue;
    rawSizeBytesBySlot[slot] = raw[slot]?.length ?? 0;
    limits[slot] = normalByteLimitsBySlot[slot];
  }
  return measureReclamationStoreCapacity({
    anchor: snapshot.anchor,
    stores: snapshot.stores,
    normalByteLimitsBySlot: limits,
    rawSizeBytesBySlot,
    rawAnchorSizeBytes: raw.anchor.length,
  });
}

function activeQuestionPeriods(snapshot) {
  return (snapshot.stores.questions?.reservations ?? []).map(({ identity, periodId }) => ({ identity, periodId }));
}

function protectedAmounts(snapshot, files, raw, normalByteLimitsBySlot) {
  const legacy = makeLegacyMeasurement(snapshot, raw, normalByteLimitsBySlot);
  const encodedAnchor = encodeQuestionReclamationAnchorV1Local(snapshot.anchor);
  const pendingAnchor = measurePendingQuestionPeriodCapacity(snapshot.anchor, activeQuestionPeriods(snapshot));
  requireValue(pendingAnchor.fits && pendingAnchor.projectedBytes !== null);
  const protectedBySlot = Object.create(null);
  protectedBySlot.anchor = maximum([
    raw.anchor.length,
    encodedAnchor.sizeBytes,
    pendingAnchor.projectedBytes,
    legacy.anchor.reserveBytes,
  ]);

  for (const slot of ['questions', 'checkpoint']) {
    const file = files[slot === 'questions' ? 'questionFile' : 'checkpointFile'];
    if (file === null) {
      protectedBySlot[slot] = 0;
      continue;
    }
    const byteLimit = normalByteLimitsBySlot[slot];
    const outer = slot === 'questions'
      ? measureQuestionCapsuleExistingUpdateReservation({ questionFile: file, currentByteLimit: byteLimit })
      : measureCheckpointCapsuleExistingUpdateReservation({ checkpointFile: file, currentByteLimit: byteLimit });
    const old = slot === 'questions'
      ? measureQuestionJournalReservationBytes({ snapshot: snapshot.stores.questions, currentByteLimit: byteLimit })
      : measureCheckpointReservation({ snapshot: snapshot.stores.checkpoint, currentByteLimit: byteLimit });
    const actualBytes = raw[slot]?.length ?? 0;
    requireValue(outer.fits && old.fits && actualBytes <= byteLimit);
    protectedBySlot[slot] = maximum([
      actualBytes,
      outer.currentBytes,
      outer.reservedBytes,
      old.reservedBytes,
      legacy.slots[slot].reserveBytes,
    ]);
  }

  const instructionStore = snapshot.stores.instructions;
  if (instructionStore === null) {
    protectedBySlot.instructions = 0;
  } else {
    const byteLimit = normalByteLimitsBySlot.instructions;
    const actualBytes = raw.instructions.length;
    const currentBytes = encodeInstructionJournalV2Local(instructionStore).sizeBytes;
    const future = measureInstructionReservation({ snapshot: instructionStore, currentByteLimit: byteLimit });
    const grantBytes = instructionStore.migrationAllowance?.maxExtraBytes ?? 0;
    const maxAllowed = checkedAddBytes(byteLimit, grantBytes);
    const required = maximum([
      actualBytes,
      currentBytes,
      future.reservedBytes,
      legacy.slots.instructions.reserveBytes,
    ]);
    requireValue(required <= maxAllowed);
    protectedBySlot.instructions = checkedAddBytes(required, grantBytes);
  }

  return protectedBySlot;
}

function operationLeaseBytes(before, after, targetBytes) {
  const slots = ['anchor', 'questions', 'checkpoint', 'instructions'];
  const protectedBytes = slots.map((slot) => Math.max(before[slot], after[slot]));
  return checkedAddBytes(...protectedBytes, targetBytes.length);
}

function sameFixedStructure(previous, next) {
  if ((previous.questionFile === null) !== (next.questionFile === null) ||
      (previous.checkpointFile === null) !== (next.checkpointFile === null)) return false;
  if (previous.questionFile !== null &&
      (!sameValue(previous.questionFile.questionCapsules, next.questionFile.questionCapsules) ||
       !sameValue(previous.questionFile.reservationOrder, next.questionFile.reservationOrder))) return false;
  if (previous.checkpointFile !== null &&
      (!sameValue(previous.checkpointFile.checkpointCapsules, next.checkpointFile.checkpointCapsules) ||
       !sameValue(previous.checkpointFile.deliveryAttemptOrder, next.checkpointFile.deliveryAttemptOrder))) return false;
  return true;
}

function createQuestionCapsuleExistingUpdateBackend(value) {
  const configuration = captureConfiguration(value);
  let closing = false;
  let closed = false;
  let state = 'new';
  let blockedReason = null;
  let installed = null;
  let pending = Promise.resolve();
  let queuedOperations = 0;
  let activeOperation = null;
  let activeWrite = null;
  let operationLease = null;
  let closePromise = null;
  let pauseReached = false;
  let resolvePauseReached;
  let resolvePauseGate;
  const pauseReachedPromise = new Promise((resolve) => { resolvePauseReached = resolve; });
  const pauseGate = new Promise((resolve) => { resolvePauseGate = resolve; });
  let pauseConsumed = false;

  async function beforeExclusiveOpen() {
    if (configuration.pausePoint === 'before_atomic_temp_open' && !pauseConsumed) {
      pauseConsumed = true;
      pauseReached = true;
      resolvePauseReached(true);
      await pauseGate;
    }
    if (blockedReason !== null) fail(BLOCKED_BACKEND);
    if (closing || closed) fail(CLOSED_BACKEND);
  }

  const nativeFileSystem = Object.freeze({
    lstat: fs.lstat.bind(fs),
    open: async (filePath, flags, mode) => {
      if (flags === 'wx') await beforeExclusiveOpen();
      if (flags === 'wx' && blockedReason !== null) fail(BLOCKED_BACKEND);
      if (closing && flags === 'wx') fail(CLOSED_BACKEND);
      const handle = mode === undefined ? await fs.open(filePath, flags) : await fs.open(filePath, flags, mode);
      if (flags === 'wx' && activeWrite !== null) {
        activeWrite.tempOpened = true;
        activeWrite.tempPath = filePath;
      }
      return handle;
    },
    rename: async (temporaryPath, targetPath) => {
      const write = activeWrite;
      const beforeFailure = write !== null && targetPath === write.targetPath &&
        configuration.failurePoint === `${write.slot}_before_rename`;
      if (beforeFailure) {
        write.leaveTemporary = true;
        fail('question_capsule_existing_update_test_write_fault', Error);
      }
      await fs.rename(temporaryPath, targetPath);
      if (write !== null && targetPath === write.targetPath) {
        write.renamed = true;
        if (configuration.failurePoint === `${write.slot}_after_rename_before_readback`) {
          fail('question_capsule_existing_update_test_write_fault', Error);
        }
      }
    },
    unlink: async (filePath) => {
      if (activeWrite?.leaveTemporary === true && filePath === activeWrite.tempPath) {
        fail('question_capsule_existing_update_test_orphan_fault', Error);
      }
      return fs.unlink(filePath);
    },
  });

  const persistence = createReclamationPersistence({
    anchorPath: configuration.anchorPath,
    slotPathsBySlot: configuration.slotPathsBySlot,
    fileSystem: nativeFileSystem,
  });

  function blockAll(reason) {
    if (blockedReason !== null) return;
    blockedReason = reason;
    state = 'blocked';
  }

  function enqueue(name, operation) {
    if (closing || closed) return Promise.reject(Object.assign(new TypeError(CLOSED_BACKEND), { code: CLOSED_BACKEND }));
    if (blockedReason !== null) return Promise.reject(Object.assign(new TypeError(BLOCKED_BACKEND), { code: BLOCKED_BACKEND }));
    queuedOperations += 1;
    const run = pending.then(async () => {
      queuedOperations -= 1;
      if (closing || closed) fail(CLOSED_BACKEND);
      if (blockedReason !== null) fail(BLOCKED_BACKEND);
      activeOperation = name;
      try {
        return await operation();
      } finally {
        activeOperation = null;
      }
    });
    pending = run.then(() => undefined, () => undefined);
    return run;
  }

  async function readCurrent() {
    const raw = await readNativeFiles(persistence, configuration);
    requireValue(raw.anchor !== null && sameFingerprint(fingerprint(raw.anchor), configuration.expectedAnchorFingerprint),
      'question_capsule_existing_update_anchor_changed');
    requireValue(sameFingerprint(fingerprint(raw.instructions), configuration.expectedInstructionFingerprint),
      'question_capsule_existing_update_instruction_changed');
    const parsed = decodeCurrent(raw, configuration);
    return { ...parsed, raw, fingerprints: fingerprintsFor(raw) };
  }

  function exportCurrent(current = installed) {
    requireValue(current !== null, 'question_capsule_existing_update_not_loaded');
    const heads = {
      questions: headFor(current.files.questionFile, current.raw.questions),
      checkpoint: headFor(current.files.checkpointFile, current.raw.checkpoint),
    };
    return {
      questionFile: clone(current.files.questionFile),
      checkpointFile: clone(current.files.checkpointFile),
      projection: freezeTree(clone(current.projection)),
      heads,
      fingerprints: clone(current.fingerprints),
      scopeLimitations: SCOPE_LIMITATIONS,
    };
  }

  function status() {
    const current = installed;
    return {
      status: state,
      loaded: current !== null,
      closing,
      closed,
      blockedReason,
      activeOperation,
      activeTarget: activeWrite?.slot ?? null,
      pauseReached,
      queuedOperations,
      operationLeaseBytes: operationLease?.status().bytes ?? 0,
      operationLeaseHeld: operationLease !== null && !operationLease.status().released,
      fingerprints: current === null ? null : clone(current.fingerprints),
      heads: current === null ? null : {
        questions: headFor(current.files.questionFile, current.raw.questions),
        checkpoint: headFor(current.files.checkpointFile, current.raw.checkpoint),
      },
      scopeLimitations: SCOPE_LIMITATIONS,
    };
  }

  async function load() {
    if (closing || closed) return Promise.reject(Object.assign(new TypeError(CLOSED_BACKEND), { code: CLOSED_BACKEND }));
    if (blockedReason !== null) return Promise.reject(Object.assign(new TypeError(BLOCKED_BACKEND), { code: BLOCKED_BACKEND }));
    if (installed !== null) return exportCurrent();
    return enqueue('load', async () => {
      state = 'loading';
      try {
        const current = await readCurrent();
        installed = current;
        state = 'ready';
        return exportCurrent(current);
      } catch {
        blockAll('initial_representation_unverified');
        throw new TypeError(INVALID_BACKEND);
      }
    });
  }

  function readProjection() {
    requireValue(installed !== null, 'question_capsule_existing_update_not_loaded');
    return freezeTree(clone(installed.projection));
  }

  async function saveInternal(request) {
    requireValue(installed !== null, 'question_capsule_existing_update_not_loaded');
    let beforeRaw;
    let before;
    let beforeFingerprints;
    try {
      beforeRaw = await readNativeFiles(persistence, configuration);
      beforeFingerprints = fingerprintsFor(beforeRaw);
      requireValue(sameFingerprints(beforeFingerprints, installed.fingerprints));
      before = decodeCurrent(beforeRaw, configuration);
    } catch {
      blockAll('external_file_change');
      fail(BLOCKED_BACKEND);
    }
    const currentHead = headFor(before.files[request.slot === 'questions' ? 'questionFile' : 'checkpointFile'],
      beforeRaw[request.slot]);
    if (!sameHead(currentHead, request.head)) fail(STALE_HEAD);

    const previousFiles = before.files;
    const nextFiles = {
      questionFile: request.slot === 'questions' ? request.file : before.files.questionFile,
      checkpointFile: request.slot === 'checkpoint' ? request.file : before.files.checkpointFile,
    };
    requireValue(sameFixedStructure(previousFiles, nextFiles));
    const nextJoint = validateQuestionCapsuleFiles({
      anchor: before.snapshot.anchor,
      questionFile: nextFiles.questionFile,
      checkpointFile: nextFiles.checkpointFile,
      instructionStore: before.snapshot.stores.instructions,
      normalByteLimitsBySlot: configuration.normalByteLimitsBySlot,
    });
    const transition = validateQuestionCapsuleExistingUpdate({
      anchor: before.snapshot.anchor,
      previous: previousFiles,
      next: nextFiles,
      instructionStore: before.snapshot.stores.instructions,
      normalByteLimitsBySlot: configuration.normalByteLimitsBySlot,
    });
    requireValue(transition.measurements[request.slot] !== null);

    const nextRaw = { ...beforeRaw, [request.slot]: Buffer.from(request.bytes) };
    const beforeProtected = protectedAmounts(before.snapshot, previousFiles, beforeRaw,
      configuration.normalByteLimitsBySlot);
    const afterProtected = protectedAmounts(nextJoint.snapshot, nextFiles, nextRaw,
      configuration.normalByteLimitsBySlot);
    const leaseBytes = operationLeaseBytes(beforeProtected, afterProtected, request.bytes);
    const nextLease = configuration.capacityBudget.acquire(leaseBytes);
    operationLease = nextLease;

    try {
      const prewriteRaw = await readNativeFiles(persistence, configuration);
      requireValue(sameFingerprints(fingerprintsFor(prewriteRaw), beforeFingerprints));
      decodeCurrent(prewriteRaw, configuration);
    } catch {
      nextLease.release();
      if (operationLease === nextLease) operationLease = null;
      blockAll('external_file_change');
      fail(BLOCKED_BACKEND);
    }

    const targetPath = request.slot === 'questions'
      ? configuration.slotPathsBySlot.questions
      : configuration.slotPathsBySlot.checkpoint;
    activeWrite = { slot: request.slot, targetPath, tempOpened: false, renamed: false };
    try {
      await persistence.writeSlotBytes(request.slot, request.bytes, MAX_SOURCE_BYTES);
      const afterRaw = await readNativeFiles(persistence, configuration);
      const after = decodeCurrent(afterRaw, configuration);
      const afterFingerprints = fingerprintsFor(afterRaw);
      const expectedFingerprints = { ...beforeFingerprints, [request.slot]: fingerprint(request.bytes) };
      requireValue(sameBytes(afterRaw[request.slot], request.bytes) &&
        sameFingerprints(afterFingerprints, expectedFingerprints),
      'question_capsule_existing_update_readback_mismatch');
      requireValue(sameFixedStructure(previousFiles, after.files));
      const finalGuard = validateQuestionCapsuleExistingUpdate({
        anchor: after.snapshot.anchor,
        previous: previousFiles,
        next: after.files,
        instructionStore: after.snapshot.stores.instructions,
        normalByteLimitsBySlot: configuration.normalByteLimitsBySlot,
      });
      requireValue(finalGuard.measurements[request.slot] !== null);
      installed = { ...after, raw: afterRaw, fingerprints: afterFingerprints };
      nextLease.release();
      if (operationLease === nextLease) operationLease = null;
      return exportCurrent(installed);
    } catch (error) {
      if (closing && !activeWrite.tempOpened) {
        nextLease.release();
        if (operationLease === nextLease) operationLease = null;
        throw new TypeError(CLOSED_BACKEND);
      }
      blockAll(activeWrite.tempOpened ? 'write_result_unknown' : 'persistence_write_failed');
      throw error instanceof TypeError && error.code === BLOCKED_BACKEND
        ? error
        : Object.assign(new TypeError(BLOCKED_BACKEND), { code: BLOCKED_BACKEND });
    } finally {
      activeWrite = null;
    }
  }

  function saveQuestion(value) {
    let request;
    try { request = captureSaveRequest('questions', value); }
    catch (error) { return Promise.reject(error); }
    return enqueue('save_questions', () => saveInternal(request));
  }

  function saveCheckpoint(value) {
    let request;
    try { request = captureSaveRequest('checkpoint', value); }
    catch (error) { return Promise.reject(error); }
    return enqueue('save_checkpoint', () => saveInternal(request));
  }

  function waitForPause() {
    if (configuration.pausePoint === null) return Promise.resolve(false);
    return pauseReachedPromise;
  }

  function close() {
    if (closePromise !== null) return closePromise;
    closing = true;
    if (state !== 'blocked' && state !== 'closed') state = 'closing';
    if (!pauseReached) resolvePauseReached(false);
    resolvePauseGate();
    closePromise = pending.then(async () => {
      try {
        await persistence.close();
      } finally {
        if (operationLease !== null) {
          operationLease.release();
          operationLease = null;
        }
        closed = true;
        state = 'closed';
      }
    });
    return closePromise;
  }

  return Object.freeze({
    load,
    readProjection,
    saveQuestion,
    saveCheckpoint,
    status,
    waitForPause,
    close,
  });
}

module.exports = { createQuestionCapsuleExistingUpdateBackend };
