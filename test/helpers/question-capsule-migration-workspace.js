'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { types } = require('node:util');
const {
  createQuestionCapsuleMigrationPlanFixture,
} = require('./question-capsule-migration-plan-fixtures');
const { planQuestionCapsuleFileMigration } = require('../../src/server/question-capsule-migration-plan');
const {
  createQuestionCapsulePrepareManifest,
} = require('../../src/server/question-capsule-prepare-manifest-codec');
const {
  createQuestionCapsulePreparedMaterial,
} = require('../../src/server/question-capsule-prepared-material-codec');
const {
  assessQuestionCapsuleMigrationCapacity,
} = require('../../src/server/question-capsule-migration-capacity');
const {
  classifyQuestionCapsuleMigrationBoundary,
} = require('../../src/server/question-capsule-migration-boundary');
const {
  validateQuestionCapsuleFiles,
} = require('../../src/server/question-capsule-files-validation');
const {
  decodeCapsuleCheckpointV4Local,
  encodeCapsuleCheckpointV4Local,
} = require('../../src/server/question-capsule-checkpoint-codec');
const {
  decodeQuestionCapsuleJournalV3Local,
  encodeQuestionCapsuleJournalV3Local,
} = require('../../src/server/question-capsule-journal-codec');
const {
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
} = require('../../src/server/reclamation-capacity-bounds');
const { createReclamationCapacityBudget } = require('../../src/server/reclamation-capacity-reservation');
const { decodeSourceBytes, encodeNormalized } = require('../../src/server/reclamation-json-codec');
const { validateReclamationSnapshot } = require('../../src/server/reclamation-store-consistency');
const { validateQuestionCapsuleWholeRepresentation } = require('../../src/server/question-capsule-whole-validation');

const WORKSPACE_PREFIX = 'agent-cockpit-question-capsule-migration-';
const WORKSPACE_KIND = 'agent_cockpit_question_capsule_migration_fixture';
const WORKSPACE_VERSION = 1;
const MARKER_BASENAME = 'workspace-marker.json';
const FILE_BASENAMES = Object.freeze({
  anchor: 'question-reclamation-anchor.json',
  questions: 'common-question-journal.json',
  checkpoint: 'delivery-checkpoint.json',
  instructions: 'instruction-journal.json',
});
const STORE_SLOTS = Object.freeze(['questions', 'checkpoint', 'instructions']);
const MARKER_FIELDS = Object.freeze([
  'formatVersion', 'kind', 'workspaceId', 'provider', 'scenario', 'configuredSlots',
]);
const CREATE_FIELDS = Object.freeze(['provider', 'scenario', 'maxAdditionalBytes', 'failurePoint', 'pauseAfterBoundary']);
const RECOVER_FIELDS = Object.freeze(['root', 'maxAdditionalBytes', 'failurePoint', 'pauseAfterBoundary']);
const PROVIDERS = new Set(['claude', 'codex', 'mixed']);
const SCENARIOS = new Set(['normal', 'checkpoint-null', 'instruction-grant']);
const PAUSE_BOUNDARIES = new Set(['prepared', 'checkpoint_moved', 'complete']);
const FAILURE_POINTS = new Set([
  'question_prepare_before_rename',
  'question_prepare_after_rename_before_readback',
  'checkpoint_target_before_rename',
  'checkpoint_target_after_rename_before_readback',
  'question_target_before_rename',
  'question_target_after_rename_before_readback',
]);
const SCOPE_LIMITATIONS = Object.freeze([
  'assessment_excludes_fixture_marker_and_filesystem_metadata',
  'external_process_exclusion_not_verified',
  'same_user_path_substitution_not_verified',
  'filesystem_free_space_not_verified',
  'process_termination_recovery_only',
  'os_crash_and_power_loss_durability_not_verified',
  'runtime_integration_not_verified',
]);
const ACTIVE_ROOTS = new Set();
const INVALID_WORKSPACE = 'invalid_question_capsule_migration_workspace';
const OPERATION_CAPACITY = 'reclamation_capacity_exceeded';

function fail(message = INVALID_WORKSPACE) {
  const error = new TypeError(message);
  error.code = message;
  throw error;
}

function requireValue(condition, message = INVALID_WORKSPACE) {
  if (!condition) fail(message);
}

function pathKey(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function captureRecord(value, fields, requiredFields = fields) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value));
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail();
  }
  requireValue(prototype === Object.prototype || prototype === null);
  const allowed = new Set(fields);
  const result = Object.create(null);
  for (const key of keys) {
    requireValue(typeof key === 'string' && allowed.has(key));
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail();
    }
    requireValue(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
    result[key] = descriptor.value;
  }
  for (const key of requiredFields) requireValue(Object.hasOwn(result, key));
  return result;
}

function assertSafeBytes(value) {
  requireValue(Number.isSafeInteger(value) && value >= 0);
  return value;
}

function addBytes(left, right) {
  const result = assertSafeBytes(left) + assertSafeBytes(right);
  requireValue(Number.isSafeInteger(result));
  return result;
}

function cloneBytes(value) {
  return value === null ? null : Buffer.from(value);
}

function cloneSourceBytes(sourceBytes) {
  return Object.fromEntries(Object.entries(sourceBytes).map(([slot, bytes]) => [slot, cloneBytes(bytes)]));
}

function limitsForScenario(fixture) {
  return structuredClone(fixture.input.normalByteLimitsBySlot);
}

function makeCheckpointNullFixture(providerOptions) {
  const fixture = createQuestionCapsuleMigrationPlanFixture({
    ...providerOptions,
    internalQuestionIds: ['internal-4'],
  });
  const questionStore = decodeSourceBytes(fixture.input.sourceBytes.questions, MAX_SOURCE_BYTES).value;
  questionStore.questions = [];
  questionStore.reservations = questionStore.reservations.filter((row) =>
    row.internalQuestionId === 'internal-4');
  fixture.input.sourceBytes.questions = encodeNormalized(questionStore).bytes;
  fixture.input.sourceBytes.checkpoint = null;
  fixture.input.sourceBytes.instructions = null;
  fixture.input.normalByteLimitsBySlot.checkpoint = null;
  fixture.input.normalByteLimitsBySlot.instructions = null;
  return fixture;
}

function buildFixture(provider, scenario) {
  requireValue(PROVIDERS.has(provider) && SCENARIOS.has(scenario));
  const providerOptions = provider === 'mixed'
    ? { provider: 'claude', secondaryProvider: 'codex', ordinaryQuestionSelected: true }
    : { provider, ordinaryQuestionSelected: true };
  const fixture = scenario === 'checkpoint-null'
    ? makeCheckpointNullFixture(providerOptions)
    : createQuestionCapsuleMigrationPlanFixture(providerOptions);

  if (scenario === 'normal' && fixture.input.sourceBytes.instructions !== null) {
    const instructionStore = decodeSourceBytes(fixture.input.sourceBytes.instructions, MAX_SOURCE_BYTES).value;
    if (instructionStore.migrationAllowance !== null) {
      instructionStore.migrationAllowance = null;
      instructionStore.revision += 1;
      fixture.input.sourceBytes.instructions = encodeNormalized(instructionStore).bytes;
    }
  }

  const sourceBytes = cloneSourceBytes(fixture.input.sourceBytes);
  const normalByteLimitsBySlot = limitsForScenario(fixture);
  const sourceValue = decodeSourceFiles(sourceBytes);
  const whole = validateQuestionCapsuleWholeRepresentation(makeLegacyWholeInput(
    sourceValue.anchor,
    sourceValue.stores,
    normalByteLimitsBySlot,
  ));
  const ready = validateReclamationSnapshot(whole.snapshot);
  requireValue(ready.status === 'ready' && ready.reasons.length === 0);

  const plannerInput = {
    sourceBytes,
    normalByteLimitsBySlot,
    selection: structuredClone(fixture.input.selection),
    operationId: fixture.input.operationId,
    chunkIds: [...fixture.input.chunkIds],
  };
  const manifestResult = createQuestionCapsulePrepareManifest(plannerInput);
  const plan = planQuestionCapsuleFileMigration(plannerInput);
  const targetBytes = {
    questions: plan.targets.questions.bytes,
    checkpoint: plan.targets.checkpoint?.bytes ?? null,
  };
  const materialResult = createQuestionCapsulePreparedMaterial({
    manifest: manifestResult.manifest,
    sourceBytes,
    targetBytes,
  });
  const assessment = assessQuestionCapsuleMigrationCapacity({
    materialBytes: materialResult.bytes,
    anchorBytes: sourceBytes.anchor,
    instructionBytes: sourceBytes.instructions,
    expectedNormalByteLimitsBySlot: normalByteLimitsBySlot,
  });
  requireValue(assessment.stableBoundsFit);

  const baselineBytes = baselineReservationBytes(assessment);
  const operationBytes = wholeOperationReservationBytes(assessment);
  return {
    provider,
    scenario,
    fixture,
    sourceBytes,
    normalByteLimitsBySlot,
    sourceValue,
    plannerInput,
    plan,
    targetBytes,
    material: materialResult,
    assessment,
    baselineBytes,
    operationBytes,
    configuredSlots: STORE_SLOTS.filter((slot) => sourceBytes[slot] !== null),
  };
}

function decodeSourceFiles(sourceBytes) {
  const anchor = decodeSourceBytes(sourceBytes.anchor, NORMAL_ANCHOR_MAX_BYTES).value;
  const stores = {};
  for (const slot of STORE_SLOTS) {
    stores[slot] = sourceBytes[slot] === null
      ? null
      : decodeSourceBytes(sourceBytes[slot], MAX_SOURCE_BYTES).value;
  }
  return { anchor, stores };
}

function makeLegacyWholeInput(anchor, stores, normalByteLimitsBySlot) {
  return {
    formatVersion: 1,
    anchor,
    ordinaryStores: stores,
    capsulePairs: [],
    deliveryAttemptOrder: stores.checkpoint?.ledger.deliveries.map((row) => row.deliveryAttemptId) ?? [],
    questionReservationOrder: stores.questions?.reservations.map((row) => row.internalQuestionId) ?? [],
    normalByteLimitsBySlot,
  };
}

function baselineReservationBytes(assessment) {
  const measurements = assessment.measurements;
  const sizes = [Math.max(measurements.anchor.rawCurrentBytes, measurements.anchor.reservedBytes)];
  const instruction = measurements.instructions;
  if (instruction !== null) sizes.push(Math.max(instruction.rawCurrentBytes, instruction.reservedBytes));
  const question = measurements.source.questions;
  sizes.push(Math.max(question.rawCurrentBytes, question.reservedBytes));
  const checkpoint = measurements.source.checkpoint;
  if (checkpoint !== null) sizes.push(Math.max(checkpoint.rawCurrentBytes, checkpoint.reservedBytes));
  return sizes.reduce(addBytes, 0);
}

function wholeOperationReservationBytes(assessment) {
  const values = [
    ...Object.values(assessment.boundaries).map((boundary) => boundary.protectedTotalBytes),
    ...Object.values(assessment.singleTempCandidates).map((candidate) => candidate.conditionalReservationBytes),
  ];
  requireValue(values.length > 0 && values.every((value) => Number.isSafeInteger(value) && value >= 0));
  return Math.max(...values);
}

function markerFor(workspaceId, fixture) {
  return {
    formatVersion: WORKSPACE_VERSION,
    kind: WORKSPACE_KIND,
    workspaceId,
    provider: fixture.provider,
    scenario: fixture.scenario,
    configuredSlots: [...fixture.configuredSlots],
  };
}

function expectedEntryNames(configuredSlots) {
  return [MARKER_BASENAME, FILE_BASENAMES.anchor,
    ...configuredSlots.map((slot) => FILE_BASENAMES[slot])].sort();
}

function ensureSameStringArray(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function validateMarker(value, workspaceId, provider, scenario, configuredSlots) {
  const marker = captureRecord(value, MARKER_FIELDS);
  requireValue(marker.formatVersion === WORKSPACE_VERSION && marker.kind === WORKSPACE_KIND &&
    marker.workspaceId === workspaceId && marker.provider === provider && marker.scenario === scenario &&
    ensureSameStringArray(marker.configuredSlots, configuredSlots));
}

function normalizeRoot(value, workspaceId) {
  requireValue(typeof value === 'string' && value.length > 0);
  const resolved = path.resolve(value);
  requireValue(resolved === value && pathKey(path.dirname(resolved)) === pathKey(os.tmpdir()));
  const basename = path.basename(resolved);
  requireValue(basename.startsWith(`${WORKSPACE_PREFIX}${workspaceId}-`) &&
    basename.length > WORKSPACE_PREFIX.length + workspaceId.length + 1);
  return resolved;
}

async function lstatRegular(filePath, expectedType) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    fail();
  }
  requireValue(!stat.isSymbolicLink());
  if (expectedType === 'directory') requireValue(stat.isDirectory());
  else requireValue(stat.isFile());
  return stat;
}

async function readMarker(root) {
  requireValue(typeof root === 'string' && path.resolve(root) === root &&
    pathKey(path.dirname(root)) === pathKey(os.tmpdir()) &&
    path.basename(root).startsWith(WORKSPACE_PREFIX));
  await lstatRegular(root, 'directory');
  const markerPath = path.join(root, MARKER_BASENAME);
  await lstatRegular(markerPath, 'file');
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  } catch {
    fail();
  }
  const marker = captureRecord(parsed, MARKER_FIELDS);
  requireValue(marker.formatVersion === WORKSPACE_VERSION && marker.kind === WORKSPACE_KIND &&
    typeof marker.workspaceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(marker.workspaceId) &&
    PROVIDERS.has(marker.provider) && SCENARIOS.has(marker.scenario) && Array.isArray(marker.configuredSlots));
  return marker;
}

async function verifyWorkspaceRoot(root, fixture) {
  const canonicalRoot = normalizeRoot(root, fixture.workspaceId);
  const stat = await lstatRegular(canonicalRoot, 'directory');
  requireValue(stat.isDirectory());
  const markerPath = path.join(canonicalRoot, MARKER_BASENAME);
  await lstatRegular(markerPath, 'file');
  const markerBytes = await fs.readFile(markerPath);
  let marker;
  try {
    marker = JSON.parse(markerBytes.toString('utf8'));
  } catch {
    fail();
  }
  validateMarker(marker, fixture.workspaceId, fixture.provider, fixture.scenario, fixture.configuredSlots);

  let entries;
  try {
    entries = (await fs.readdir(canonicalRoot)).sort();
  } catch {
    fail();
  }
  const expected = expectedEntryNames(fixture.configuredSlots);
  if (entries.some(isWriterTempName)) fail('unresolved_atomic_temp_or_orphan');
  requireValue(entries.length === expected.length && expected.every((name, index) => entries[index] === name));
  for (const name of expected) await lstatRegular(path.join(canonicalRoot, name), 'file');
  return canonicalRoot;
}

function isWriterTempName(name) {
  return /^\.[^/\\]+\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(name);
}

async function readCurrentBytes(root, fixture) {
  const values = { anchor: null, questions: null, checkpoint: null, instructions: null };
  for (const slot of ['anchor', ...STORE_SLOTS]) {
    if (slot !== 'anchor' && !fixture.configuredSlots.includes(slot)) continue;
    values[slot] = await fs.readFile(path.join(root, FILE_BASENAMES[slot]));
  }
  return values;
}

function equalOptionalBytes(left, right) {
  return left === null ? right === null : right !== null && left.equals(right);
}

function sameSources(actual, expected) {
  return ['anchor', ...STORE_SLOTS].every((slot) => equalOptionalBytes(actual[slot], expected[slot]));
}

function boundaryInput(fixture, current) {
  return {
    materialBytes: fixture.material.bytes,
    anchorBytes: current.anchor,
    instructionBytes: current.instructions,
    questionBytes: current.questions,
    checkpointBytes: current.checkpoint,
  };
}

function assertExpectedBoundary(fixture, current, expectedBoundary) {
  const result = classifyQuestionCapsuleMigrationBoundary(boundaryInput(fixture, current));
  requireValue(result.boundary === expectedBoundary);
  return result;
}

function validateFinalFiles(fixture, current) {
  requireValue(current.questions !== null && current.questions.equals(fixture.targetBytes.questions) &&
    equalOptionalBytes(current.checkpoint, fixture.targetBytes.checkpoint));
  const anchor = decodeSourceBytes(current.anchor, NORMAL_ANCHOR_MAX_BYTES).value;
  const instructionStore = current.instructions === null ? null
    : decodeSourceBytes(current.instructions, MAX_SOURCE_BYTES).value;
  const questionFile = decodeQuestionCapsuleJournalV3Local(current.questions);
  const checkpointFile = current.checkpoint === null ? null : decodeCapsuleCheckpointV4Local(current.checkpoint);
  const questionEncoded = encodeQuestionCapsuleJournalV3Local(questionFile);
  requireValue(questionEncoded.bytes.equals(current.questions));
  if (checkpointFile !== null) {
    requireValue(encodeCapsuleCheckpointV4Local(checkpointFile).bytes.equals(current.checkpoint));
  }
  return validateQuestionCapsuleFiles({
    anchor,
    questionFile,
    checkpointFile,
    instructionStore,
    normalByteLimitsBySlot: fixture.normalByteLimitsBySlot,
  });
}

class FixtureWorkspace {
  constructor({ root, workspaceId, fixture, budget, baselineLease, failurePoint, pauseAfterBoundary,
    removeRootOnDispose }) {
    this.root = root;
    this.workspaceId = workspaceId;
    this.fixture = fixture;
    this.budget = budget;
    this.baselineLease = baselineLease;
    this.failurePoint = failurePoint;
    this.pauseAfterBoundary = pauseAfterBoundary;
    this.removeRootOnDispose = removeRootOnDispose;
    this.operationLease = null;
    this.currentBoundary = 'source';
    this.state = 'source';
    this.blockedReason = null;
    this.operationProvenance = null;
    this.migrationWriteCount = 0;
    this.closing = false;
    this.activeOperation = null;
    this.closePromise = null;
    this.disposePromise = null;
    this.pausePromise = null;
    this.releasePause = null;
  }

  status() {
    return {
      status: this.state,
      boundary: this.currentBoundary,
      workspaceId: this.workspaceId,
      baselineLeaseBytes: this.baselineLease.status().bytes,
      operationLeaseBytes: this.operationLease?.status().bytes ?? 0,
      operationLeaseHeld: this.operationLease !== null && !this.operationLease.status().released,
      migrationWriteCount: this.migrationWriteCount,
      closing: this.closing,
      blockedReason: this.blockedReason,
      operationProvenance: this.operationProvenance,
      scopeLimitations: SCOPE_LIMITATIONS,
    };
  }

  async runExclusive(name, operation) {
    requireValue(!this.activeOperation && !this.closing && this.state !== 'closed' &&
      this.state !== 'blocked' && this.blockedReason === null);
    const running = (async () => {
      try {
        return await operation();
      } catch (error) {
        this.state = 'blocked';
        this.blockedReason = error?.code || error?.message || INVALID_WORKSPACE;
        return this.status();
      } finally {
        if (this.activeOperation === running) this.activeOperation = null;
      }
    })();
    this.activeOperation = running;
    this.state = `${name}_running`;
    return running;
  }

  async acquireOperationLease() {
    try {
      this.operationLease = this.budget.acquire(this.fixture.operationBytes);
      return true;
    } catch {
      this.state = 'blocked';
      this.blockedReason = OPERATION_CAPACITY;
      return false;
    }
  }

  async start() {
    return this.runExclusive('start', async () => {
      requireValue(!this.closing);
      requireValue(this.currentBoundary === 'source' &&
        (this.state === 'source' || this.state === 'source_unprepared'));
      await verifyWorkspaceRoot(this.root, this.fixture);
      const current = await readCurrentBytes(this.root, this.fixture);
      requireValue(sameSources(current, this.fixture.sourceBytes));
      if (!(await this.acquireOperationLease())) return this.status();

      requireValue(!this.closing);
      const beforeFirstWrite = await readCurrentBytes(this.root, this.fixture);
      requireValue(sameSources(beforeFirstWrite, this.fixture.sourceBytes));
      await this.writeBoundary('prepared', 'questions', this.fixture.material.bytes);
      if (!(await this.pauseOrContinue('prepared'))) return this.status();

      if (this.fixture.targetBytes.checkpoint !== null) {
        await this.writeBoundary('checkpoint_moved', 'checkpoint', this.fixture.targetBytes.checkpoint);
        if (!(await this.pauseOrContinue('checkpoint_moved'))) return this.status();
      }

      await this.writeBoundary('complete', 'questions', this.fixture.targetBytes.questions);
      validateFinalFiles(this.fixture, await readCurrentBytes(this.root, this.fixture));
      this.currentBoundary = 'complete';
      this.state = 'complete';
      if (!(await this.pauseOrContinue('complete'))) return this.status();
      return this.status();
    });
  }

  async recover() {
    return this.runExclusive('recover', async () => {
      await verifyWorkspaceRoot(this.root, this.fixture);
      const current = await readCurrentBytes(this.root, this.fixture);
      requireValue(current.anchor.equals(this.fixture.sourceBytes.anchor) &&
        equalOptionalBytes(current.instructions, this.fixture.sourceBytes.instructions));

      if (sameSources(current, this.fixture.sourceBytes)) {
        const legacy = validateQuestionCapsuleWholeRepresentation(makeLegacyWholeInput(
          this.fixture.sourceValue.anchor,
          this.fixture.sourceValue.stores,
          this.fixture.normalByteLimitsBySlot,
        ));
        const ready = validateReclamationSnapshot(legacy.snapshot);
        requireValue(ready.status === 'ready' && ready.reasons.length === 0);
        this.currentBoundary = 'source';
        this.state = 'source_unprepared';
        return { ...this.status(), outcome: 'source_unprepared' };
      }

      if (current.questions.equals(this.fixture.targetBytes.questions) &&
          equalOptionalBytes(current.checkpoint, this.fixture.targetBytes.checkpoint)) {
        validateFinalFiles(this.fixture, current);
        this.currentBoundary = 'complete';
        this.state = 'already_migrated_representation';
        this.operationProvenance = 'unknown';
        return { ...this.status(), outcome: 'already_migrated_representation' };
      }

      requireValue(current.questions.equals(this.fixture.material.bytes));
      const classification = classifyQuestionCapsuleMigrationBoundary(boundaryInput(this.fixture, current));
      requireValue(classification.boundary === 'prepared' || classification.boundary === 'checkpoint_moved');
      this.currentBoundary = classification.boundary;
      if (!(await this.acquireOperationLease())) return this.status();
      requireValue(!this.closing);
      this.state = 'recovering';

      if (classification.boundary === 'prepared' && this.fixture.targetBytes.checkpoint !== null) {
        await this.writeBoundary('checkpoint_moved', 'checkpoint', this.fixture.targetBytes.checkpoint);
        if (!(await this.pauseOrContinue('checkpoint_moved'))) return this.status();
      }

      await this.writeBoundary('complete', 'questions', this.fixture.targetBytes.questions);
      validateFinalFiles(this.fixture, await readCurrentBytes(this.root, this.fixture));
      this.currentBoundary = 'complete';
      this.state = 'complete';
      if (!(await this.pauseOrContinue('complete'))) return this.status();
      return { ...this.status(), outcome: 'resumed_operation' };
    });
  }

  async pauseOrContinue(boundary) {
    if (this.pauseAfterBoundary !== boundary || this.closing) return !this.closing;
    this.state = 'paused';
    if (typeof process.send === 'function') {
      process.send({ type: 'paused', root: this.root, boundary });
    }
    this.pausePromise = new Promise((resolve) => { this.releasePause = resolve; });
    await this.pausePromise;
    this.pausePromise = null;
    this.releasePause = null;
    return !this.closing;
  }

  async writeBoundary(boundary, slot, bytes) {
    requireValue(!this.closing);
    const expectedBefore = this.currentBoundary;
    const currentBefore = await readCurrentBytes(this.root, this.fixture);
    assertExpectedBoundary(this.fixture, currentBefore, expectedBefore);
    requireValue(!this.closing && this.blockedReason === null);
    const filePath = path.join(this.root, FILE_BASENAMES[slot]);
    const stage = boundary === 'prepared' ? 'question_prepare'
      : boundary === 'checkpoint_moved' ? 'checkpoint_target' : 'question_target';
    await atomicWriteAndReadback(filePath, bytes, {
      failurePoint: this.failurePoint,
      stage,
      onRename: () => { this.migrationWriteCount += 1; },
    });
    const currentAfter = await readCurrentBytes(this.root, this.fixture);
    await verifyWorkspaceRoot(this.root, this.fixture);
    assertExpectedBoundary(this.fixture, currentAfter, boundary);
    if (!currentAfter.anchor.equals(this.fixture.sourceBytes.anchor) ||
        !equalOptionalBytes(currentAfter.instructions, this.fixture.sourceBytes.instructions)) {
      fail();
    }
    this.currentBoundary = boundary;
    this.state = boundary;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.state !== 'blocked' && this.state !== 'closed') this.state = 'closing';
    if (this.releasePause) this.releasePause();
    this.closePromise = (async () => {
      if (this.activeOperation) await this.activeOperation;
      this.operationLease?.release();
      this.state = this.blockedReason ? 'closed_blocked' : 'closed';
      return this.status();
    })();
    return this.closePromise;
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    const disposing = (async () => {
      await this.close();
      await verifyWorkspaceRoot(this.root, this.fixture);
      if (this.removeRootOnDispose) {
        for (const name of expectedEntryNames(this.fixture.configuredSlots)) {
          await fs.unlink(path.join(this.root, name));
        }
        await fs.rmdir(this.root);
      }
      ACTIVE_ROOTS.delete(pathKey(this.root));
      this.baselineLease.release();
      return this.status();
    })();
    this.disposePromise = disposing.catch((error) => {
      this.disposePromise = null;
      throw error;
    });
    return this.disposePromise;
  }
}

function workspaceFacade(workspace) {
  return Object.freeze({
    root: workspace.root,
    workspaceId: workspace.workspaceId,
    start: () => workspace.start(),
    recover: () => workspace.recover(),
    status: () => workspace.status(),
    close: () => workspace.close(),
    dispose: () => workspace.dispose(),
  });
}

async function atomicWriteAndReadback(filePath, bytes, { failurePoint, stage, onRename }) {
  const temporaryPath = path.join(path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle = null;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.close();
    handle = null;
    if (failurePoint === `${stage}_before_rename`) fail(`${stage}_before_rename`);
    await fs.rename(temporaryPath, filePath);
    onRename();
    if (failurePoint === `${stage}_after_rename_before_readback`) {
      fail(`${stage}_after_rename_before_readback`);
    }
    const readback = await fs.readFile(filePath);
    requireValue(readback.equals(bytes));
  } finally {
    if (handle !== null) {
      try { await handle.close(); } catch { /* 一時ファイルの状態が不明なため残す。 */ }
    }
  }
}

async function createFixtureWorkspace(value) {
  const input = captureRecord(value, CREATE_FIELDS, ['provider', 'scenario', 'maxAdditionalBytes']);
  requireValue(PROVIDERS.has(input.provider) && SCENARIOS.has(input.scenario));
  assertSafeBytes(input.maxAdditionalBytes);
  const failurePoint = input.failurePoint ?? null;
  const pauseAfterBoundary = input.pauseAfterBoundary ?? null;
  requireValue(failurePoint === null || FAILURE_POINTS.has(failurePoint));
  requireValue(pauseAfterBoundary === null || PAUSE_BOUNDARIES.has(pauseAfterBoundary));
  const fixture = buildFixture(input.provider, input.scenario);
  const workspaceId = randomUUID();
  const budget = createReclamationCapacityBudget({ maxAdditionalBytes: input.maxAdditionalBytes });
  const baselineLease = budget.acquire(fixture.baselineBytes);
  const rootPrefix = `${WORKSPACE_PREFIX}${workspaceId}-`;
  let root;
  try {
    root = await fs.mkdtemp(path.join(os.tmpdir(), rootPrefix));
  } catch (error) {
    baselineLease.release();
    throw error;
  }
  ACTIVE_ROOTS.add(pathKey(root));
  const completeFixture = { ...fixture, workspaceId };
  try {
    await fs.writeFile(path.join(root, MARKER_BASENAME), JSON.stringify(markerFor(workspaceId, fixture)),
      { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(root, FILE_BASENAMES.anchor), fixture.sourceBytes.anchor,
      { flag: 'wx', mode: 0o600 });
    for (const slot of STORE_SLOTS) {
      if (fixture.sourceBytes[slot] !== null) {
        await fs.writeFile(path.join(root, FILE_BASENAMES[slot]), fixture.sourceBytes[slot],
          { flag: 'wx', mode: 0o600 });
      }
    }
    await verifyWorkspaceRoot(root, completeFixture);
  } catch (error) {
    baselineLease.release();
    ACTIVE_ROOTS.delete(pathKey(root));
    try {
      const entries = await fs.readdir(root);
      const expected = new Set(expectedEntryNames(fixture.configuredSlots));
      if (entries.every((entry) => expected.has(entry))) {
        for (const entry of entries) await fs.unlink(path.join(root, entry));
        await fs.rmdir(root);
      }
    } catch {
      // 不明なファイルが残る場合は自動削除しない。
    }
    throw error;
  }
  return workspaceFacade(new FixtureWorkspace({
    root,
    workspaceId,
    fixture: completeFixture,
    budget,
    baselineLease,
    failurePoint,
    pauseAfterBoundary,
    removeRootOnDispose: true,
  }));
}

async function recoverFixtureWorkspace(value) {
  const input = captureRecord(value, RECOVER_FIELDS, ['root', 'maxAdditionalBytes']);
  assertSafeBytes(input.maxAdditionalBytes);
  const failurePoint = input.failurePoint ?? null;
  const pauseAfterBoundary = input.pauseAfterBoundary ?? null;
  requireValue(failurePoint === null || FAILURE_POINTS.has(failurePoint));
  requireValue(pauseAfterBoundary === null || PAUSE_BOUNDARIES.has(pauseAfterBoundary));
  const marker = await readMarker(input.root);
  const root = normalizeRoot(input.root, marker.workspaceId);
  requireValue(!ACTIVE_ROOTS.has(pathKey(root)));
  const fixture = buildFixture(marker.provider, marker.scenario);
  const completeFixture = { ...fixture, workspaceId: marker.workspaceId };
  await verifyWorkspaceRoot(root, completeFixture);
  const budget = createReclamationCapacityBudget({ maxAdditionalBytes: input.maxAdditionalBytes });
  const baselineLease = budget.acquire(fixture.baselineBytes);
  ACTIVE_ROOTS.add(pathKey(root));
  return workspaceFacade(new FixtureWorkspace({
    root,
    workspaceId: marker.workspaceId,
    fixture: completeFixture,
    budget,
    baselineLease,
    failurePoint,
    pauseAfterBoundary,
    removeRootOnDispose: true,
  }));
}

function estimateFixtureRequirements(value) {
  const input = captureRecord(value, ['provider', 'scenario']);
  const fixture = buildFixture(input.provider, input.scenario);
  return {
    baselineBytes: fixture.baselineBytes,
    operationBytes: fixture.operationBytes,
    maxAdditionalBytesForStart: addBytes(fixture.baselineBytes, fixture.operationBytes),
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

module.exports = {
  FAILURE_POINTS: Object.freeze([...FAILURE_POINTS]),
  FILE_BASENAMES,
  PAUSE_BOUNDARIES: Object.freeze([...PAUSE_BOUNDARIES]),
  SCOPE_LIMITATIONS,
  createFixtureWorkspace,
  estimateFixtureRequirements,
  recoverFixtureWorkspace,
};
