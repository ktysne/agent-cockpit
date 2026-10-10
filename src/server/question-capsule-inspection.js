'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const fsConstants = require('node:fs').constants;
const path = require('node:path');
const { captureFileRecord } = require('./question-capsule-file-primitives');
const {
  decodeCapsuleCheckpointV4Local,
  normalizeCapsuleCheckpointV4Local,
} = require('./question-capsule-checkpoint-codec');
const {
  decodeQuestionCapsuleJournalV3Local,
  normalizeQuestionCapsuleJournalV3Local,
} = require('./question-capsule-journal-codec');
const {
  decodeQuestionCapsulePreparedMaterial,
  encodeQuestionCapsulePreparedMaterial,
  validateQuestionCapsulePreparedMaterial,
} = require('./question-capsule-prepared-material-codec');
const { assessQuestionCapsuleMigrationCapacity } = require('./question-capsule-migration-capacity');
const { classifyQuestionCapsuleMigrationBoundary } = require('./question-capsule-migration-boundary');
const {
  measureCheckpointCapsuleExistingUpdateReservation,
  measureQuestionCapsuleExistingUpdateReservation,
} = require('./question-capsule-existing-update-capacity');
const {
  FIXED_H_BOUNDS,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
  checkedCapacityAdd,
  measureCheckpointReservation,
  measureInstructionReservation,
  measurePendingQuestionPeriodCapacity,
  measureQuestionJournalReservationBytes,
} = require('./reclamation-capacity-bounds');
const { normalizeQuestionJournalV2Local } = require('./common-question-reclamation-codec');
const {
  normalizeCheckpointV3Local,
  normalizeInstructionJournalV2Local,
} = require('./delivery-reclamation-codec');
const { normalizeQuestionReclamationAnchorV1Local } = require('./question-reclamation-anchor-codec');
const {
  validateReclamationSnapshot,
} = require('./reclamation-store-consistency');
const { validateQuestionCapsuleFiles } = require('./question-capsule-files-validation');
const { validateQuestionCapsuleWholeRepresentation } = require('./question-capsule-whole-validation');
const { decodeSourceBytes } = require('./reclamation-json-codec');

const INVALID_INPUT = 'invalid_question_capsule_inspection';
const CLOSED_INSPECTION = 'question_capsule_inspection_closed';
const INPUT_FIELDS = ['dataDirectory', 'normalByteLimitsBySlot'];
const LIMIT_FIELDS = ['questions', 'checkpoint', 'instructions'];
const BYTE_SLOTS = ['anchor', 'questions', 'checkpoint', 'instructions'];
const MAX_DIRECTORY_ENTRIES = 100_000;
const MATERIAL_KIND = 'question_capsule_prepared_material';
const RAW_READ_CHUNK_BYTES = 64 * 1024;
const FILES = Object.freeze({
  anchor: 'question-reclamation-anchor.json',
  questions: 'common-question-journal.json',
  checkpoint: 'delivery-checkpoint.json',
  instructions: 'instruction-journal.json',
});
const INSTRUCTION_RAW_MAX_BYTES = checkedCapacityAdd(MAX_SOURCE_BYTES, FIXED_H_BOUNDS.instructions);
const SCOPE_LIMITATIONS = Object.freeze([
  'explicit_read_only_inspection_only',
  'normal_byte_limit_provenance_not_verified',
  'persistent_grant_protocol_not_applied',
  'source_freshness_after_return_not_verified',
  'external_writer_exclusion_not_verified',
  'aba_changes_not_excluded',
  'orphan_and_backup_detection_not_exhaustive',
  'filesystem_allocation_and_os_durability_not_verified',
  'atomic_write_and_readback_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'runtime_integration_not_verified',
  'standard_loader_integration_not_verified',
  'save_or_resume_authority_not_granted',
  'provider_startup_not_performed',
  'prepared_operation_provenance_not_verified',
]);

class InspectionBlocked extends Error {
  constructor(reason) {
    super();
    this.reason = reason;
  }
}

function block(reason) {
  throw new InspectionBlocked(reason);
}

function requireValue(condition, reason = 'invalid_representation') {
  if (!condition) block(reason);
}

function failInput() {
  throw new TypeError(INVALID_INPUT);
}

function captureConfiguration(value) {
  let input;
  let limits;
  try {
    input = captureFileRecord(value, INPUT_FIELDS, INVALID_INPUT);
    limits = captureFileRecord(input.normalByteLimitsBySlot, LIMIT_FIELDS, INVALID_INPUT);
  } catch {
    failInput();
  }
  if (typeof input.dataDirectory !== 'string' || input.dataDirectory.length === 0 ||
      input.dataDirectory.includes('\0')) failInput();
  let root;
  try {
    root = path.resolve(input.dataDirectory);
  } catch {
    failInput();
  }
  if (!path.isAbsolute(input.dataDirectory)) failInput();
  for (const slot of LIMIT_FIELDS) {
    const limit = limits[slot];
    if (slot === 'questions' && limit === null) failInput();
    if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_SOURCE_BYTES)) failInput();
  }
  return Object.freeze({
    root,
    limits: Object.freeze({ questions: limits.questions, checkpoint: limits.checkpoint,
      instructions: limits.instructions }),
  });
}

function reasonOf(error, fallback = 'invalid_representation') {
  return error instanceof InspectionBlocked ? error.reason : fallback;
}

function pathKey(value) {
  const normalized = path.normalize(value).replace(/^\\\\\?\\/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function statIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}

function isMissing(error) {
  return error && error.code === 'ENOENT';
}

async function verifyDirectoryPath(root) {
  const parsed = path.parse(root);
  const components = root.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  try {
    const rootStat = await fs.lstat(current, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) block('unsafe_directory_path');
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]);
      const stat = await fs.lstat(current, { bigint: true });
      if (stat.isSymbolicLink() || (index < components.length - 1 && !stat.isDirectory()) ||
          (index === components.length - 1 && !stat.isDirectory())) block('unsafe_directory_path');
    }
    const real = await fs.realpath(root);
    if (pathKey(real) !== pathKey(root)) block('unsafe_directory_path');
  } catch (error) {
    if (error instanceof InspectionBlocked) throw error;
    block('unsafe_directory_path');
  }
}

async function scanOrphanCandidates(root) {
  const candidates = [];
  let directory;
  try {
    directory = await fs.opendir(root);
    let entry;
    let count = 0;
    while ((entry = await directory.read()) !== null) {
      count += 1;
      if (count > MAX_DIRECTORY_ENTRIES) block('directory_entry_limit');
      const name = entry.name;
      for (const basename of Object.values(FILES)) {
        if (name.startsWith(`${basename}.`) || name.startsWith(`.${basename}.`)) {
          candidates.push(name);
          break;
        }
      }
    }
  } catch (error) {
    if (error instanceof InspectionBlocked) throw error;
    block('directory_read_failed');
  } finally {
    try { await directory?.close(); } catch {}
  }
  return candidates.sort();
}

async function readRegularFile(root, slot, maxBytes, expectedPresent) {
  const filename = FILES[slot];
  const fullPath = path.join(root, filename);
  let before;
  try {
    await verifyDirectoryPath(root);
    before = await fs.lstat(fullPath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      if (expectedPresent) block('configured_file_missing');
      return null;
    }
    if (error instanceof InspectionBlocked) throw error;
    block('file_metadata_unavailable');
  }
  if (before.isSymbolicLink() || !before.isFile()) block('unsafe_file_path');
  if (!expectedPresent) block('file_presence_mismatch');

  let handle;
  try {
    const noFollow = fsConstants.O_NOFOLLOW || 0;
    handle = await fs.open(fullPath, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || statIdentity(opened) !== statIdentity(before)) block('source_changed_during_inspection');
    const chunks = [];
    let total = 0;
    const readCeiling = maxBytes + 1;
    while (total < readCeiling) {
      const buffer = Buffer.allocUnsafe(Math.min(RAW_READ_CHUNK_BYTES, readCeiling - total));
      const result = await handle.read(buffer, 0, buffer.length, total);
      if (result.bytesRead === 0) break;
      chunks.push(buffer.subarray(0, result.bytesRead));
      total += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (statIdentity(after) !== statIdentity(opened)) {
      block('source_changed_during_inspection');
    }
    if (total > maxBytes) block('source_too_large');
    if (total !== Number(after.size)) block('source_changed_during_inspection');
    const linked = await fs.lstat(fullPath, { bigint: true });
    if (linked.isSymbolicLink() || !linked.isFile() || statIdentity(linked) !== statIdentity(opened)) {
      block('source_changed_during_inspection');
    }
    const bytes = Buffer.concat(chunks, total);
    return { bytes, identity: statIdentity(opened) };
  } catch (error) {
    if (error instanceof InspectionBlocked) throw error;
    block('file_read_failed');
  } finally {
    try { await handle?.close(); } catch {}
  }
}

function rawFingerprint(entry) {
  if (entry === null) return null;
  return { sizeBytes: entry.bytes.length, sha256: createHash('sha256').update(entry.bytes).digest('hex') };
}

function sameCapture(left, right) {
  if (left === null || right === null) return left === right;
  const leftFingerprint = rawFingerprint(left);
  const rightFingerprint = rawFingerprint(right);
  return left.identity === right.identity && leftFingerprint.sizeBytes === rightFingerprint.sizeBytes &&
    leftFingerprint.sha256 === rightFingerprint.sha256;
}

function reportFileFingerprints(captures) {
  return Object.fromEntries(BYTE_SLOTS.map((slot) => [slot, rawFingerprint(captures[slot] ?? null)]));
}

function emptyCounts() {
  return { questions: null, checkpoint: null };
}

function emptyMeasurements(captures) {
  const actualOuterBytesBySlot = {};
  for (const slot of BYTE_SLOTS) actualOuterBytesBySlot[slot] = captures[slot]?.bytes.length ?? null;
  return {
    actualOuterBytesBySlot,
    restoredLegacyFutureBySlot: { anchor: null, questions: null, checkpoint: null, instructions: null },
    targetFixedFutureBySlot: { questions: null, checkpoint: null },
    preparedCapacity: null,
  };
}

function baseReport(captures = {}) {
  const completeCaptures = Object.fromEntries(BYTE_SLOTS.map((slot) => [slot, captures[slot] ?? null]));
  return {
    inspectionStatus: 'blocked',
    representation: 'unknown',
    preparedBoundary: null,
    operationProvenance: null,
    reasons: [],
    files: reportFileFingerprints(completeCaptures),
    counts: { restoredLegacyView: emptyCounts(), targetCapsuleView: emptyCounts() },
    measurements: emptyMeasurements(completeCaptures),
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

function decodeRaw(entry, maxBytes) {
  if (entry === null) block('configured_file_missing');
  try {
    return decodeSourceBytes(entry.bytes, maxBytes).value;
  } catch {
    block('invalid_representation');
  }
}

function assertNormalizedWhole(snapshot) {
  let result;
  try {
    result = validateReclamationSnapshot(snapshot);
  } catch {
    block('invalid_representation');
  }
  if (result.status !== 'ready' || result.reasons.length !== 0) block('snapshot_requires_repair');
  return result.snapshot;
}

function validateLegacyWhole(anchor, questions, checkpoint, instructions, limits) {
  const deliveryAttemptOrder = checkpoint === null ? []
    : checkpoint.ledger.deliveries.map((delivery) => delivery.deliveryAttemptId);
  const questionReservationOrder = questions === null ? []
    : questions.reservations.map((reservation) => reservation.internalQuestionId);
  let result;
  try {
    result = validateQuestionCapsuleWholeRepresentation({
      formatVersion: 1,
      anchor,
      ordinaryStores: { questions, checkpoint, instructions },
      capsulePairs: [],
      deliveryAttemptOrder,
      questionReservationOrder,
      normalByteLimitsBySlot: limits,
    });
  } catch {
    block('invalid_representation');
  }
  return { ...result, snapshot: assertNormalizedWhole(result.snapshot) };
}

function measureLegacySlots(snapshot, actualBytes, limits) {
  const stores = snapshot.stores;
  const activePeriods = stores.questions === null ? [] : stores.questions.reservations.map((reservation) => ({
    identity: reservation.identity,
    periodId: reservation.periodId,
  }));
  const anchorCapacity = measurePendingQuestionPeriodCapacity(snapshot.anchor, activePeriods);
  if (!anchorCapacity.fits || anchorCapacity.projectedBytes === null ||
      Math.max(actualBytes.anchor, anchorCapacity.projectedBytes) > NORMAL_ANCHOR_MAX_BYTES) {
    block('capacity_not_fit');
  }
  const restoredLegacyFutureBySlot = {
    anchor: { rawCurrentBytes: actualBytes.anchor, reservedBytes: anchorCapacity.projectedBytes },
    questions: null,
    checkpoint: null,
    instructions: null,
  };
  for (const slot of LIMIT_FIELDS) {
    const store = stores[slot];
    const limit = limits[slot];
    if (store === null) {
      if (limit !== null) block('file_presence_mismatch');
      continue;
    }
    const rawCurrentBytes = actualBytes[slot];
    const reservation = slot === 'questions'
      ? measureQuestionJournalReservationBytes({ snapshot: store, currentByteLimit: limit })
      : slot === 'checkpoint'
        ? measureCheckpointReservation({ snapshot: store, currentByteLimit: limit })
        : measureInstructionReservation({ snapshot: store, currentByteLimit: limit });
    const grantedExtraBytes = store.migrationAllowance?.maxExtraBytes ?? 0;
    const writableLimit = limit + grantedExtraBytes;
    if (Math.max(rawCurrentBytes ?? 0, reservation.currentBytes, reservation.reservedBytes) > writableLimit) {
      block('capacity_not_fit');
    }
    restoredLegacyFutureBySlot[slot] = {
      rawCurrentBytes,
      normalizedCurrentBytes: reservation.currentBytes,
      reservedBytes: reservation.reservedBytes,
      grantedExtraBytes,
    };
  }
  return restoredLegacyFutureBySlot;
}

function countLegacy(snapshot) {
  return countLegacyStores(snapshot.stores.questions, snapshot.stores.checkpoint);
}

function countLegacyStores(questions, checkpoint) {
  return {
    questions: questions === null ? null : {
      ordinaryQuestionDetails: questions.questions.length,
      ordinaryQuestionReservations: questions.reservations.length,
      capsuleWrappers: 0,
      capsuleEntries: 0,
      restoredQuestionReservations: questions.reservations.length,
    },
    checkpoint: checkpoint === null ? null : {
      ordinaryDeliveries: checkpoint.ledger.deliveries.length,
      capsuleWrappers: 0,
      capsuleEntries: 0,
      restoredDeliveries: checkpoint.ledger.deliveries.length,
    },
  };
}

function sumCapsuleEntries(wrappers, field) {
  return wrappers.reduce((count, wrapper) => count + wrapper.capsule[field].length, 0);
}

function countCapsuleFiles(questionFile, checkpointFile, snapshot = null) {
  const questionEntries = questionFile === null ? 0 : sumCapsuleEntries(questionFile.questionCapsules, 'reservations');
  const checkpointEntries = checkpointFile === null ? 0 : sumCapsuleEntries(checkpointFile.checkpointCapsules, 'deliveries');
  const restoredQuestionCount = snapshot?.stores.questions?.reservations.length ??
    (questionFile === null ? 0 : questionFile.reservations.length + questionEntries);
  const restoredDeliveryCount = snapshot?.stores.checkpoint?.ledger.deliveries.length ??
    (checkpointFile === null ? 0 : checkpointFile.ledger.deliveries.length + checkpointEntries);
  return {
    questions: questionFile === null ? null : {
      ordinaryQuestionDetails: questionFile.questions.length,
      ordinaryQuestionReservations: questionFile.reservations.length,
      capsuleWrappers: questionFile.questionCapsules.length,
      capsuleEntries: questionEntries,
      restoredQuestionReservations: restoredQuestionCount,
    },
    checkpoint: checkpointFile === null ? null : {
      ordinaryDeliveries: checkpointFile.ledger.deliveries.length,
      capsuleWrappers: checkpointFile.checkpointCapsules.length,
      capsuleEntries: checkpointEntries,
      restoredDeliveries: restoredDeliveryCount,
    },
  };
}

function buildNewCapsuleResult(values, limits, captures, report) {
  let questionFile;
  let checkpointFile;
  try {
    questionFile = normalizeQuestionCapsuleJournalV3Local(values.questions);
    checkpointFile = values.checkpoint === null ? null : normalizeCapsuleCheckpointV4Local(values.checkpoint);
  } catch {
    block('invalid_representation');
  }
  if ((checkpointFile === null) !== (limits.checkpoint === null)) block('file_presence_mismatch');
  let joint;
  try {
    joint = validateQuestionCapsuleFiles({
      anchor: values.anchor,
      questionFile,
      checkpointFile,
      instructionStore: values.instructions,
      normalByteLimitsBySlot: limits,
    });
  } catch {
    block('invalid_representation');
  }
  const snapshot = assertNormalizedWhole(joint.snapshot);
  report.representation = 'capsule_q3_cp4';
  report.operationProvenance = 'unknown';
  report.counts = {
    restoredLegacyView: countLegacy(snapshot),
    targetCapsuleView: countCapsuleFiles(questionFile, checkpointFile, snapshot),
  };
  report.measurements.restoredLegacyFutureBySlot = measureLegacySlots(snapshot,
    {
      anchor: captures.anchor.bytes.length,
      questions: null,
      checkpoint: null,
      instructions: captures.instructions?.bytes.length ?? null,
    }, limits);

  const questionCapacity = measureQuestionCapsuleExistingUpdateReservation({ questionFile, currentByteLimit: limits.questions });
  const checkpointCapacity = checkpointFile === null ? null
    : measureCheckpointCapsuleExistingUpdateReservation({ checkpointFile, currentByteLimit: limits.checkpoint });
  report.measurements.targetFixedFutureBySlot = {
    questions: {
      rawCurrentBytes: captures.questions.bytes.length,
      normalizedCurrentBytes: questionCapacity.currentBytes,
      reservedBytes: questionCapacity.reservedBytes,
    },
    checkpoint: checkpointCapacity === null ? null : {
      rawCurrentBytes: captures.checkpoint.bytes.length,
      normalizedCurrentBytes: checkpointCapacity.currentBytes,
      reservedBytes: checkpointCapacity.reservedBytes,
    },
  };
  if (!questionCapacity.fits || (checkpointCapacity !== null && !checkpointCapacity.fits)) {
    block('capacity_not_fit');
  }
  const instructionGrant = snapshot.stores.instructions?.migrationAllowance?.maxExtraBytes ?? 0;
  if (captures.instructions !== null &&
      captures.instructions.bytes.length > limits.instructions + instructionGrant) {
    block('capacity_not_fit');
  }
}

function buildPreparedResult(materialBytes, values, limits, captures, report) {
  let material;
  let encodedMaterial;
  let evidence;
  let capacity;
  let boundary;
  try {
    material = decodeQuestionCapsulePreparedMaterial(materialBytes);
    encodedMaterial = encodeQuestionCapsulePreparedMaterial(material);
    if (!encodedMaterial.bytes.equals(materialBytes)) block('invalid_representation');
    if (LIMIT_FIELDS.some((slot) => material.manifest.normalByteLimitsBySlot[slot] !== limits[slot])) {
      block('normal_byte_limit_mismatch');
    }
    if ((material.manifest.sourceFingerprints.checkpoint === null) !== (captures.checkpoint === null) ||
        (material.manifest.targetFingerprints.checkpoint === null) !== (captures.checkpoint === null) ||
        (material.manifest.sourceFingerprints.instructions === null) !== (captures.instructions === null)) {
      block('file_presence_mismatch');
    }
    evidence = validateQuestionCapsulePreparedMaterial({
      material,
      anchorBytes: captures.anchor.bytes,
      instructionBytes: captures.instructions?.bytes ?? null,
    });
    capacity = assessQuestionCapsuleMigrationCapacity({
      materialBytes,
      anchorBytes: captures.anchor.bytes,
      instructionBytes: captures.instructions?.bytes ?? null,
      expectedNormalByteLimitsBySlot: limits,
    });
    boundary = classifyQuestionCapsuleMigrationBoundary({
      materialBytes,
      anchorBytes: captures.anchor.bytes,
      instructionBytes: captures.instructions?.bytes ?? null,
      questionBytes: captures.questions.bytes,
      checkpointBytes: captures.checkpoint?.bytes ?? null,
    });
  } catch (error) {
    if (error instanceof InspectionBlocked) throw error;
    block('invalid_representation');
  }
  const sourceQuestion = normalizeQuestionJournalV2Local(decodeSourceBytes(
    Buffer.from(material.sourceQuestionBytesBase64, 'base64'), MAX_SOURCE_BYTES).value);
  const sourceCheckpoint = material.sourceCheckpointBytesBase64 === null ? null
    : normalizeCheckpointV3Local(decodeSourceBytes(Buffer.from(material.sourceCheckpointBytesBase64, 'base64'),
      MAX_SOURCE_BYTES).value);
  const targetQuestion = decodeQuestionCapsuleJournalV3Local(evidence.targetBytes.questions);
  const targetCheckpoint = evidence.targetBytes.checkpoint === null ? null
    : decodeCapsuleCheckpointV4Local(evidence.targetBytes.checkpoint);
  report.representation = 'prepared_material_v1';
  report.operationProvenance = 'unknown';
  report.preparedBoundary = boundary.boundary;
  report.counts = {
    restoredLegacyView: countLegacyStores(sourceQuestion, sourceCheckpoint),
    targetCapsuleView: countCapsuleFiles(targetQuestion, targetCheckpoint),
  };
  report.measurements.restoredLegacyFutureBySlot = {
    anchor: capacity.measurements.anchor,
    questions: capacity.measurements.source.questions,
    checkpoint: capacity.measurements.source.checkpoint,
    instructions: capacity.measurements.instructions,
  };
  report.measurements.targetFixedFutureBySlot = {
    questions: capacity.measurements.target.questions,
    checkpoint: capacity.measurements.target.checkpoint,
  };
  report.measurements.preparedCapacity = {
    stableBoundsFit: capacity.stableBoundsFit,
    stableBoundsFitBySlot: capacity.stableBoundsFitBySlot,
    measurements: capacity.measurements,
    boundaries: capacity.boundaries,
    singleTempCandidates: capacity.singleTempCandidates,
    scopeLimitations: capacity.scopeLimitations,
  };
  if (!capacity.stableBoundsFit) block('capacity_not_fit');
}

function parseAndValidate(captures, limits) {
  const report = baseReport(captures);
  try {
    const values = {
      anchor: decodeRaw(captures.anchor, NORMAL_ANCHOR_MAX_BYTES),
      questions: decodeRaw(captures.questions, MAX_SOURCE_BYTES),
      checkpoint: captures.checkpoint === null ? null : decodeRaw(captures.checkpoint, MAX_SOURCE_BYTES),
      instructions: captures.instructions === null ? null : decodeRaw(captures.instructions, INSTRUCTION_RAW_MAX_BYTES),
    };
    if ((values.checkpoint === null) !== (limits.checkpoint === null) ||
        (values.instructions === null) !== (limits.instructions === null)) block('file_presence_mismatch');
    const q = values.questions;
    if (q && q.kind === MATERIAL_KIND) {
      buildPreparedResult(captures.questions.bytes, values, limits, captures, report);
    } else if (q?.schemaVersion === 3 && (values.checkpoint === null || values.checkpoint?.schemaVersion === 4)) {
      buildNewCapsuleResult(values, limits, captures, report);
    } else if (q?.schemaVersion === 2 && (values.checkpoint === null || values.checkpoint?.schemaVersion === 3)) {
      const questions = normalizeQuestionJournalV2Local(q);
      const checkpoint = values.checkpoint === null ? null : normalizeCheckpointV3Local(values.checkpoint);
      const instructions = values.instructions === null ? null : normalizeInstructionJournalV2Local(values.instructions);
      const whole = validateLegacyWhole(values.anchor, questions, checkpoint, instructions, limits);
      report.representation = 'legacy_q2_cp3';
      report.counts.restoredLegacyView = countLegacy(whole.snapshot);
      report.measurements.restoredLegacyFutureBySlot = measureLegacySlots(whole.snapshot,
        Object.fromEntries(BYTE_SLOTS.map((slot) => [slot, captures[slot]?.bytes.length ?? 0])), limits);
    } else {
      const checkpointVersion = values.checkpoint?.schemaVersion;
      if ((q?.schemaVersion === 2 && checkpointVersion === 4) ||
          (q?.schemaVersion === 3 && checkpointVersion === 3)) block('mixed_representation');
      block('unsupported_representation');
    }
    if (report.representation === 'capsule_q3_cp4') {
      for (const slot of ['questions', 'checkpoint']) {
        if (limits[slot] !== null && captures[slot].bytes.length > limits[slot]) {
          block('capacity_not_fit');
        }
      }
    }
    if (report.representation === 'prepared_material_v1' && report.preparedBoundary === 'complete') {
      for (const slot of ['questions', 'checkpoint']) {
        if (limits[slot] !== null && captures[slot].bytes.length > limits[slot]) {
          block('capacity_not_fit');
        }
      }
    }
    report.inspectionStatus = 'inspected';
    report.reasons = [];
  } catch (error) {
    report.inspectionStatus = 'blocked';
    report.reasons = [reasonOf(error)];
  }
  return report;
}

async function readRound(root, limits) {
  await verifyDirectoryPath(root);
  const candidates = await scanOrphanCandidates(root);
  if (candidates.length > 0) block('orphan_candidate_present');
  const captures = {};
  for (const slot of BYTE_SLOTS) {
    const expectedPresent = slot === 'anchor' || slot === 'questions' || limits[slot] !== null;
    const maxBytes = slot === 'anchor' ? NORMAL_ANCHOR_MAX_BYTES
      : slot === 'instructions' ? INSTRUCTION_RAW_MAX_BYTES : MAX_SOURCE_BYTES;
    captures[slot] = await readRegularFile(root, slot, maxBytes, expectedPresent);
  }
  const candidatesAfter = await scanOrphanCandidates(root);
  if (candidatesAfter.length > 0) block('orphan_candidate_present');
  return { captures, candidates };
}

async function inspectOnce(configuration) {
  let first;
  try {
    first = await readRound(configuration.root, configuration.limits);
    const second = await readRound(configuration.root, configuration.limits);
    if (first.candidates.join('\n') !== second.candidates.join('\n') ||
        BYTE_SLOTS.some((slot) => !sameCapture(first.captures[slot], second.captures[slot]))) {
      block('source_changed_during_inspection');
    }
    return parseAndValidate(first.captures, configuration.limits);
  } catch (error) {
    const report = baseReport(first?.captures ?? {});
    report.reasons = [reasonOf(error, 'file_read_failed')];
    return report;
  }
}

function openQuestionCapsuleInspection(value) {
  const configuration = captureConfiguration(value);
  let closed = false;
  let inFlight = null;
  let closePromise = null;

  function inspect() {
    if (closed) return Promise.reject(new TypeError(CLOSED_INSPECTION));
    if (inFlight === null) {
      const operation = inspectOnce(configuration);
      inFlight = operation;
      operation.finally(() => {
        if (inFlight === operation) inFlight = null;
      }).catch(() => {});
    }
    return inFlight.then((result) => {
      const detached = structuredClone(result);
      detached.scopeLimitations = Object.freeze([...SCOPE_LIMITATIONS]);
      if (detached.measurements.preparedCapacity !== null) {
        detached.measurements.preparedCapacity.scopeLimitations = Object.freeze([
          ...detached.measurements.preparedCapacity.scopeLimitations,
        ]);
      }
      return detached;
    });
  }

  function close() {
    closed = true;
    if (closePromise === null) {
      const pending = inFlight;
      closePromise = pending === null ? Promise.resolve() : pending.then(() => undefined, () => undefined);
    }
    return closePromise;
  }

  return Object.freeze({ inspect, close });
}

module.exports = { openQuestionCapsuleInspection };
