'use strict';

const { Buffer } = require('node:buffer');
const { types } = require('node:util');
const {
  assertSafeUnsignedInteger,
  assertUuidV4,
  captureDenseArray,
  captureExactRecord,
  checkedAddBytes,
} = require('./reclamation-codec-primitives');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('./question-reclamation-anchor-codec');
const {
  createEmptyCheckpointV3TargetLocal,
  createEmptyInstructionJournalV2TargetLocal,
  createEmptyQuestionJournalV2TargetLocal,
  projectLegacyReclamationMigrationLocal,
} = require('./reclamation-migration-projection');
const {
  FIXED_ANCHOR_MIGRATION_BOUNDS,
  FIXED_H_BOUNDS,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
  computePhysicalReclamationBounds,
  measureMigrationAllowance,
} = require('./reclamation-capacity-bounds');
const { validateReclamationSnapshot } = require('./reclamation-store-consistency');
const { encodeQuestionJournalV2Local } = require('./common-question-reclamation-codec');
const {
  encodeCheckpointV3Local,
  encodeInstructionJournalV2Local,
} = require('./delivery-reclamation-codec');

const INVALID_PLAN = 'invalid_initial_reclamation_migration_plan';
const SLOT_ORDER = ['checkpoint', 'instructions', 'questions'];
const STORE_ORDER = ['questions', 'checkpoint', 'instructions'];
const INPUT_FIELDS = [
  'configuredSlots', 'sourceBytesBySlot', 'normalByteLimitsBySlot', 'storeId', 'operationId', 'startedAt',
];
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getTypedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const getTypedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const SLOT_ENCODERS = Object.freeze({
  checkpoint: encodeCheckpointV3Local,
  instructions: encodeInstructionJournalV2Local,
  questions: encodeQuestionJournalV2Local,
});

function reject() {
  throw new TypeError(INVALID_PLAN);
}

function requireValue(condition) {
  if (!condition) reject();
}

function exact(value, fields) {
  return captureExactRecord(value, fields, INVALID_PLAN);
}

function dense(value, maxLength) {
  return captureDenseArray(value, maxLength, INVALID_PLAN);
}

function makeRecord(entries) {
  const result = Object.create(null);
  for (const [key, value] of entries) result[key] = value;
  return result;
}

function copySourceBytes(value) {
  if (!types.isUint8Array(value)) reject();
  try {
    const buffer = Reflect.apply(getTypedArrayBuffer, value, []);
    const byteOffset = Reflect.apply(getTypedArrayByteOffset, value, []);
    const byteLength = Reflect.apply(getTypedArrayByteLength, value, []);
    if (byteLength > MAX_SOURCE_BYTES) throw new RangeError('source_too_large');
    return Buffer.from(Buffer.from(buffer, byteOffset, byteLength));
  } catch (error) {
    if (error instanceof RangeError && error.message === 'source_too_large') throw error;
    reject();
  }
}

function canonicalSlots(value) {
  const supplied = dense(value, SLOT_ORDER.length);
  requireValue(supplied.length >= 1 && supplied.every((slot) =>
    typeof slot === 'string' && SLOT_ORDER.includes(slot)));
  requireValue(new Set(supplied).size === supplied.length);
  return SLOT_ORDER.filter((slot) => supplied.includes(slot));
}

function captureInputs(value) {
  const options = exact(value, INPUT_FIELDS);
  const slots = canonicalSlots(options.configuredSlots);
  assertUuidV4(options.storeId, INVALID_PLAN);
  assertUuidV4(options.operationId, INVALID_PLAN);
  assertSafeUnsignedInteger(options.startedAt, INVALID_PLAN);

  const sourceValues = exact(options.sourceBytesBySlot, slots);
  const normalLimits = exact(options.normalByteLimitsBySlot, slots);
  const sourceBytesBySlot = makeRecord(slots.map((slot) => [
    slot,
    sourceValues[slot] === null ? null : copySourceBytes(sourceValues[slot]),
  ]));
  for (const slot of slots) {
    assertSafeUnsignedInteger(normalLimits[slot], INVALID_PLAN);
    requireValue(normalLimits[slot] > 0 && normalLimits[slot] <= MAX_SOURCE_BYTES);
  }

  return {
    slots,
    sourceBytesBySlot,
    normalByteLimitsBySlot: normalLimits,
    storeId: options.storeId,
    operationId: options.operationId,
    startedAt: options.startedAt,
  };
}

function migrationAllowanceMap(slots, selectedSlot = null, grant = null) {
  return makeRecord(slots.map((slot) => [slot, slot === selectedSlot ? grant : null]));
}

function projectAllSlots(input, allowances) {
  return projectLegacyReclamationMigrationLocal({
    configuredSlots: input.slots,
    sourceBytesBySlot: input.sourceBytesBySlot,
    storeId: input.storeId,
    operationId: input.operationId,
    startedAt: input.startedAt,
    migrationAllowanceBySlot: allowances,
  });
}

function maximumGrantFor(input, slot, projection) {
  const source = projection.slots[slot].source;
  const rosterField = slot === 'questions' ? 'eligibleQuestionIds' : 'eligibleAttemptIds';
  return makeRecord([
    ['operationId', input.operationId],
    ['sourceSchemaVersion', source.schemaVersion],
    ['sourceSizeBytes', source.sizeBytes],
    ['sourceSha256', source.sha256],
    ['maxExtraBytes', Number.MAX_SAFE_INTEGER],
    [rosterField, projection.slots[slot].eligibleIds],
  ]);
}

function capacityProjections(noGrant, maximumGrant, slot) {
  const rowField = slot === 'questions' ? 'questionCandidates'
    : slot === 'checkpoint' ? 'deliveryCandidates' : 'instructionCandidates';
  return makeRecord([
    ['withoutGrant', noGrant.slots[slot].candidateSnapshotsByBoundary],
    ['withMaximumGrant', maximumGrant.slots[slot].candidateSnapshotsByBoundary],
    [rowField, noGrant.slots[slot][rowField]],
  ]);
}

function measureGrants(input, noGrantProjection) {
  const grants = makeRecord(input.slots.map((slot) => [slot, null]));
  for (const slot of input.slots) {
    const source = noGrantProjection.slots[slot].source;
    if (!source.present) continue;

    const normalByteLimit = input.normalByteLimitsBySlot[slot];
    requireValue(source.sizeBytes <= normalByteLimit);
    const temporaryGrant = maximumGrantFor(input, slot, noGrantProjection);
    const maximumProjection = projectAllSlots(input,
      migrationAllowanceMap(input.slots, slot, temporaryGrant));
    grants[slot] = measureMigrationAllowance({
      slot,
      sourcePresent: true,
      sourceSchemaVersion: source.schemaVersion,
      sourceRevision: source.revision,
      sourceSizeBytes: source.sizeBytes,
      sourceSha256: source.sha256,
      currentByteLimit: normalByteLimit,
      anchor: noGrantProjection.anchor,
      eligibleIds: noGrantProjection.slots[slot].eligibleIds,
      projections: capacityProjections(noGrantProjection, maximumProjection, slot),
    });
  }
  return grants;
}

function emptyTargetForSlot(slot, storeId) {
  if (slot === 'checkpoint') return createEmptyCheckpointV3TargetLocal({ storeId });
  if (slot === 'instructions') return createEmptyInstructionJournalV2TargetLocal({ storeId });
  return createEmptyQuestionJournalV2TargetLocal({ storeId });
}

function emptySourceMetadata() {
  return makeRecord([
    ['present', false], ['schemaVersion', null], ['revision', null], ['sizeBytes', 0], ['sha256', null],
  ]);
}

function normalAnchorAtMaximumRevision(storeId, retiredQuestionPeriods) {
  const snapshot = normalizeQuestionReclamationAnchorV1Local(makeRecord([
    ['schemaVersion', 1],
    ['revision', Number.MAX_SAFE_INTEGER],
    ['storeId', storeId],
    ['retiredQuestionPeriods', retiredQuestionPeriods],
    ['migration', null],
  ]));
  return { snapshot, encoded: encodeQuestionReclamationAnchorV1Local(snapshot) };
}

function validateProjectedSnapshot(anchor, anchorEncoded, slots, stores, expectedTargets,
  expectedStatus, expectedReasons) {
  const validation = validateReclamationSnapshot({ anchor, stores });
  requireValue(validation.status === expectedStatus &&
    validation.reasons.length === expectedReasons.length &&
    validation.reasons.every((reason, index) => reason === expectedReasons[index]));
  requireValue(encodeQuestionReclamationAnchorV1Local(validation.snapshot.anchor).bytes.equals(anchorEncoded.bytes));
  for (const slot of slots) {
    const encoded = SLOT_ENCODERS[slot](validation.snapshot.stores[slot]);
    requireValue(encoded.bytes.equals(expectedTargets[slot].encoded.bytes));
  }
  return validation;
}

function buildInitialCreatePlan(input) {
  const stores = makeRecord(STORE_ORDER.map((slot) => [slot, null]));
  const slots = makeRecord([]);
  const expectedTargets = makeRecord([]);
  for (const slot of input.slots) {
    const target = emptyTargetForSlot(slot, input.storeId);
    requireValue(target.sizeBytes <= input.normalByteLimitsBySlot[slot]);
    stores[slot] = target.snapshot;
    expectedTargets[slot] = target;
    slots[slot] = makeRecord([
      ['source', emptySourceMetadata()],
      ['eligibleIds', []],
      ['normalByteLimit', input.normalByteLimitsBySlot[slot]],
      ['grant', null],
      ['target', target],
    ]);
  }
  const anchor = normalizeQuestionReclamationAnchorV1Local(makeRecord([
    ['schemaVersion', 1], ['revision', 0], ['storeId', input.storeId],
    ['retiredQuestionPeriods', []], ['migration', null],
  ]));
  const anchorEncoded = encodeQuestionReclamationAnchorV1Local(anchor);
  const normalAnchorBound = normalAnchorAtMaximumRevision(input.storeId, anchor.retiredQuestionPeriods);
  requireValue(anchorEncoded.sizeBytes <= NORMAL_ANCHOR_MAX_BYTES &&
    normalAnchorBound.encoded.sizeBytes <= NORMAL_ANCHOR_MAX_BYTES);
  const validation = validateProjectedSnapshot(anchor, anchorEncoded, input.slots, stores,
    expectedTargets, 'ready', []);
  return makeRecord([
    ['outcome', 'initial-create'],
    ['operationId', null],
    ['anchor', validation.snapshot.anchor],
    ['anchorEncoded', anchorEncoded],
    ['stores', validation.snapshot.stores],
    ['slots', slots],
    ['crossStoreValidation', makeRecord([['status', validation.status], ['reasons', validation.reasons]])],
    ['normalAnchorMaxRevisionBytes', normalAnchorBound.encoded.sizeBytes],
    ['migrationAnchorBytes', null],
    ['migrationAnchorMaxBytes', FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes],
    ['physicalBounds', null],
  ]);
}

function validateSlotTargetLimits(input, projection, grants) {
  for (const slot of input.slots) {
    const slotProjection = projection.slots[slot];
    const source = slotProjection.source;
    const target = slotProjection.target;
    const grant = grants[slot];
    const normalByteLimit = input.normalByteLimitsBySlot[slot];
    const writableLimit = grant === null
      ? normalByteLimit
      : checkedAddBytes(source.sizeBytes, grant.maxExtraBytes);
    requireValue(target.sizeBytes <= writableLimit);
    requireValue(target.sizeBytes <= checkedAddBytes(MAX_SOURCE_BYTES, FIXED_H_BOUNDS[slot]));
  }
}

function buildMigrationPlan(input, noGrantProjection) {
  const grants = measureGrants(input, noGrantProjection);
  const finalProjectionWithGrants = projectAllSlots(input,
    makeRecord(input.slots.map((slot) => [slot, grants[slot]])));
  validateSlotTargetLimits(input, finalProjectionWithGrants, grants);

  const stores = makeRecord(STORE_ORDER.map((slot) => [
    slot,
    input.slots.includes(slot) ? finalProjectionWithGrants.slots[slot].target.snapshot : null,
  ]));
  const expectedTargets = makeRecord(input.slots.map((slot) =>
    [slot, finalProjectionWithGrants.slots[slot].target]));
  const validation = validateProjectedSnapshot(finalProjectionWithGrants.anchor,
    finalProjectionWithGrants.anchorEncoded, input.slots, stores, expectedTargets,
    'reconciliation-required', ['migration_in_progress']);
  const normalAnchorBound = normalAnchorAtMaximumRevision(input.storeId,
    finalProjectionWithGrants.anchor.retiredQuestionPeriods);
  requireValue(normalAnchorBound.encoded.sizeBytes <= NORMAL_ANCHOR_MAX_BYTES);
  requireValue(finalProjectionWithGrants.anchorEncoded.sizeBytes <=
    FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes);

  const physicalBounds = computePhysicalReclamationBounds({
    anchorByteLimit: NORMAL_ANCHOR_MAX_BYTES,
    slots: input.slots.map((slot) => makeRecord([
      ['slot', slot],
      ['sourceSizeBytes', finalProjectionWithGrants.slots[slot].source.sizeBytes],
      ['normalByteLimit', input.normalByteLimitsBySlot[slot]],
      ['grantBytes', grants[slot] === null ? 0 : grants[slot].maxExtraBytes],
    ])),
  });
  const slotResults = makeRecord(input.slots.map((slot) => {
    const projected = finalProjectionWithGrants.slots[slot];
    return [slot, makeRecord([
      ['source', projected.source],
      ['eligibleIds', projected.eligibleIds],
      ['normalByteLimit', input.normalByteLimitsBySlot[slot]],
      ['grant', grants[slot]],
      ['target', projected.target],
    ])];
  }));
  return makeRecord([
    ['outcome', 'migration-prepared'],
    ['operationId', input.operationId],
    ['anchor', validation.snapshot.anchor],
    ['anchorEncoded', finalProjectionWithGrants.anchorEncoded],
    ['stores', validation.snapshot.stores],
    ['slots', slotResults],
    ['crossStoreValidation', makeRecord([['status', validation.status], ['reasons', validation.reasons]])],
    ['normalAnchorMaxRevisionBytes', normalAnchorBound.encoded.sizeBytes],
    ['migrationAnchorBytes', finalProjectionWithGrants.anchorEncoded.sizeBytes],
    ['migrationAnchorMaxBytes', FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes],
    ['physicalBounds', physicalBounds],
  ]);
}

/** 初回の旧形式移行または全slot未作成時の空schema初期化計画を生成する。 */
function planInitialReclamationMigration(value) {
  const input = captureInputs(value);
  if (input.slots.every((slot) => input.sourceBytesBySlot[slot] === null)) {
    return buildInitialCreatePlan(input);
  }
  const noGrantProjection = projectAllSlots(input, migrationAllowanceMap(input.slots));
  return buildMigrationPlan(input, noGrantProjection);
}

module.exports = { planInitialReclamationMigration };
