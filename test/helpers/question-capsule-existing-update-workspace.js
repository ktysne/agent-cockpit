'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { types } = require('node:util');
const { createQuestionCapsuleFilesFixture } = require('./question-capsule-files-fixtures');
const { createQuestionCapsuleMigrationPlanFixture } = require('./question-capsule-migration-plan-fixtures');
const { createQuestionCapsuleExistingUpdateBackend } =
  require('../../src/server/question-capsule-existing-update-backend');
const { planQuestionCapsuleFileMigration } = require('../../src/server/question-capsule-migration-plan');
const { encodeNormalized, decodeSourceBytes } = require('../../src/server/reclamation-json-codec');
const { encodeCapsuleCheckpointV4Local } = require('../../src/server/question-capsule-checkpoint-codec');
const { encodeInstructionJournalV2Local } = require('../../src/server/delivery-reclamation-codec');
const { encodeQuestionReclamationAnchorV1Local } = require('../../src/server/question-reclamation-anchor-codec');
const { encodeQuestionCapsuleJournalV3Local } = require('../../src/server/question-capsule-journal-codec');
const { MAX_SOURCE_BYTES } = require('../../src/server/reclamation-capacity-bounds');
const { createReclamationCapacityBudget, measureReclamationStoreCapacity } =
  require('../../src/server/reclamation-capacity-reservation');
const { validateQuestionCapsuleFiles } = require('../../src/server/question-capsule-files-validation');

const WORKSPACE_PREFIX = 'agent-cockpit-question-capsule-existing-update-';
const FILE_BASENAMES = Object.freeze({
  anchor: 'question-reclamation-anchor.json',
  questions: 'common-question-journal.json',
  checkpoint: 'delivery-checkpoint.json',
  instructions: 'instruction-journal.json',
});
const SLOT_NAMES = Object.freeze(['anchor', 'questions', 'checkpoint', 'instructions']);
const PROVIDERS = new Set(['claude', 'codex']);
const PAUSE_POINTS = new Set([null, 'before_atomic_temp_open']);
const FAILURE_POINTS = new Set([
  null,
  'questions_before_rename',
  'questions_after_rename_before_readback',
  'checkpoint_before_rename',
  'checkpoint_after_rename_before_readback',
]);
const FIXTURE_SCENARIOS = new Set(['standard', 'checkpoint-instructions-null']);
const FIXTURE_OPTION_NAMES = new Set(['scenario', 'provider', 'secondaryProvider', 'ordinaryQuestionSelected']);
const OPTION_NAMES = new Set([...FIXTURE_OPTION_NAMES, 'maxAdditionalBytes']);
const BACKEND_OPTION_NAMES = new Set(['pausePoint', 'failurePoint']);
const TEMPORARY_FILE = /^\.(?:question-reclamation-anchor\.json|common-question-journal\.json|delivery-checkpoint\.json|instruction-journal\.json)\.\d+\.[0-9a-f-]{36}\.tmp$/;
const ACTIVE_ROOTS = new Set();
const INVALID_WORKSPACE = 'invalid_question_capsule_existing_update_workspace';
const DEFAULT_MAX_ADDITIONAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_FIXTURE_OPTIONS = {
  scenario: 'standard',
  provider: 'claude',
  secondaryProvider: null,
  ordinaryQuestionSelected: true,
};

function fail(code = INVALID_WORKSPACE) {
  const error = new TypeError(code);
  error.code = code;
  throw error;
}

function requireValue(condition, code = INVALID_WORKSPACE) {
  if (!condition) fail(code);
}

function captureOptionalRecord(value, allowedNames, defaults) {
  if (types.isProxy(value)) fail();
  let prototype;
  let keys;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail();
  }
  requireValue(prototype === Object.prototype || prototype === null);
  const captured = { ...defaults };
  for (const key of keys) {
    requireValue(typeof key === 'string' && allowedNames.has(key));
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail(); }
    requireValue(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
    captured[key] = descriptor.value;
  }
  return captured;
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fingerprint(bytes) {
  if (bytes === null) return null;
  return { sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function encodeFixture(fixture) {
  const bytes = {
    anchor: Buffer.from(encodeQuestionReclamationAnchorV1Local(fixture.input.anchor).bytes),
    questions: Buffer.from(encodeQuestionCapsuleJournalV3Local(fixture.questionFile).bytes),
    checkpoint: fixture.checkpointFile === null
      ? null : Buffer.from(encodeCapsuleCheckpointV4Local(fixture.checkpointFile).bytes),
    instructions: fixture.input.instructionStore === null
      ? null : Buffer.from(encodeInstructionJournalV2Local(fixture.input.instructionStore).bytes),
  };
  return bytes;
}

function baselineReservation(fixture, bytes) {
  const validated = validateQuestionCapsuleFiles(fixture.input);
  const configuredSlots = SLOT_NAMES.slice(1).filter((slot) => validated.snapshot.stores[slot] !== null);
  const normalByteLimitsBySlot = Object.fromEntries(configuredSlots.map((slot) =>
    [slot, fixture.input.normalByteLimitsBySlot[slot]]));
  const rawSizeBytesBySlot = Object.fromEntries(configuredSlots.map((slot) =>
    [slot, bytes[slot].length]));
  const capacity = measureReclamationStoreCapacity({
    anchor: validated.snapshot.anchor,
    stores: validated.snapshot.stores,
    normalByteLimitsBySlot,
    rawSizeBytesBySlot,
    rawAnchorSizeBytes: bytes.anchor.length,
  });
  return capacity.anchor.reserveBytes + configuredSlots.reduce((total, slot) =>
    total + Math.max(bytes[slot].length, capacity.slots[slot].reserveBytes), 0);
}

function requireFixtureOptions(options) {
  requireValue(FIXTURE_SCENARIOS.has(options.scenario));
  requireValue(PROVIDERS.has(options.provider));
  requireValue(options.secondaryProvider === null || PROVIDERS.has(options.secondaryProvider));
  requireValue(options.secondaryProvider === null || options.secondaryProvider !== options.provider);
  requireValue(typeof options.ordinaryQuestionSelected === 'boolean');
}

function makeCheckpointInstructionsNullFixture(options) {
  const sourceFixture = createQuestionCapsuleMigrationPlanFixture({
    provider: options.provider,
    secondaryProvider: options.secondaryProvider,
    ordinaryQuestionSelected: options.ordinaryQuestionSelected,
    internalQuestionIds: ['internal-4'],
  });
  const questionStore = decodeSourceBytes(sourceFixture.input.sourceBytes.questions, MAX_SOURCE_BYTES).value;
  questionStore.questions = [];
  questionStore.reservations = questionStore.reservations.filter((row) =>
    row.internalQuestionId === 'internal-4');
  sourceFixture.input.sourceBytes.questions = encodeNormalized(questionStore).bytes;
  sourceFixture.input.sourceBytes.checkpoint = null;
  sourceFixture.input.sourceBytes.instructions = null;
  sourceFixture.input.normalByteLimitsBySlot.checkpoint = null;
  sourceFixture.input.normalByteLimitsBySlot.instructions = null;

  const planned = planQuestionCapsuleFileMigration(sourceFixture.input);
  const input = {
    anchor: structuredClone(sourceFixture.snapshot.anchor),
    questionFile: planned.targets.questions.value,
    checkpointFile: null,
    instructionStore: null,
    normalByteLimitsBySlot: structuredClone(sourceFixture.input.normalByteLimitsBySlot),
  };
  const validated = validateQuestionCapsuleFiles(input);
  requireValue(validated.snapshot.stores.checkpoint === null &&
    validated.snapshot.stores.instructions === null);
  return {
    input,
    snapshot: validated.snapshot,
    questionFile: input.questionFile,
    checkpointFile: null,
  };
}

function makeFixture(options) {
  return options.scenario === 'standard'
    ? createQuestionCapsuleFilesFixture({
      provider: options.provider,
      secondaryProvider: options.secondaryProvider,
      ordinaryQuestionSelected: options.ordinaryQuestionSelected,
    })
    : makeCheckpointInstructionsNullFixture(options);
}

function createQuestionCapsuleExistingUpdateFixture(value = {}) {
  const options = captureOptionalRecord(value, FIXTURE_OPTION_NAMES, DEFAULT_FIXTURE_OPTIONS);
  requireFixtureOptions(options);
  return makeFixture(options);
}

function expectedEntries(bytes) {
  return SLOT_NAMES.filter((slot) => bytes[slot] !== null).map((slot) => FILE_BASENAMES[slot]).sort();
}

async function assertOwnedRoot(root, expectedNames) {
  let rootStat;
  let realRoot;
  let entries;
  try {
    rootStat = await fs.lstat(root);
    realRoot = await fs.realpath(root);
    entries = await fs.readdir(root);
  } catch {
    fail('question_capsule_existing_update_workspace_path_unavailable');
  }
  const tempRoot = path.resolve(os.tmpdir());
  requireValue(rootStat.isDirectory() && !rootStat.isSymbolicLink() &&
    pathKey(realRoot) === pathKey(root) && pathKey(path.dirname(root)) === pathKey(tempRoot) &&
    path.basename(root).startsWith(WORKSPACE_PREFIX), 'question_capsule_existing_update_workspace_unsafe_root');
  requireValue(entries.length === expectedNames.length && entries.every((entry) => expectedNames.includes(entry)),
    'question_capsule_existing_update_workspace_unknown_file');
  for (const name of entries) {
    let stat;
    try { stat = await fs.lstat(path.join(root, name)); } catch { fail('question_capsule_existing_update_workspace_path_unavailable'); }
    requireValue(stat.isFile() && !stat.isSymbolicLink(), 'question_capsule_existing_update_workspace_unsafe_file');
  }
  return entries;
}

function captureBackendOptions(value) {
  const options = captureOptionalRecord(value, BACKEND_OPTION_NAMES, { pausePoint: null, failurePoint: null });
  requireValue(PAUSE_POINTS.has(options.pausePoint) && FAILURE_POINTS.has(options.failurePoint));
  return options;
}

async function createQuestionCapsuleExistingUpdateWorkspace(value = {}) {
  const options = captureOptionalRecord(value, OPTION_NAMES, {
    ...DEFAULT_FIXTURE_OPTIONS,
    maxAdditionalBytes: DEFAULT_MAX_ADDITIONAL_BYTES,
  });
  requireFixtureOptions(options);
  requireValue(Number.isSafeInteger(options.maxAdditionalBytes) && options.maxAdditionalBytes >= 0);

  const fixture = makeFixture(options);
  const bytes = encodeFixture(fixture);
  const baselineBytes = baselineReservation(fixture, bytes);
  const budget = createReclamationCapacityBudget({ maxAdditionalBytes: options.maxAdditionalBytes });
  const baselineLease = budget.acquire(baselineBytes);
  const workspaceId = crypto.randomUUID();
  const tempRoot = path.resolve(os.tmpdir());
  let root;
  try {
    root = await fs.mkdtemp(path.join(tempRoot, WORKSPACE_PREFIX));
  } catch (error) {
    baselineLease.release();
    throw error;
  }
  const rootKey = pathKey(root);
  requireValue(!ACTIVE_ROOTS.has(rootKey), 'question_capsule_existing_update_workspace_already_owned');
  ACTIVE_ROOTS.add(rootKey);
  const filePaths = Object.fromEntries(SLOT_NAMES.map((slot) => [slot, path.join(root, FILE_BASENAMES[slot])]));
  const expectedNames = expectedEntries(bytes);
  const openedBackends = new Set();
  let disposePromise = null;
  let disposed = false;

  try {
    for (const slot of SLOT_NAMES) {
      if (bytes[slot] !== null) await fs.writeFile(filePaths[slot], bytes[slot], { flag: 'wx', mode: 0o600 });
    }
    await assertOwnedRoot(root, expectedNames);
  } catch (error) {
    baselineLease.release();
    ACTIVE_ROOTS.delete(rootKey);
    try {
      const rootStat = await fs.lstat(root);
      const realRoot = await fs.realpath(root);
      const entries = await fs.readdir(root);
      requireValue(rootStat.isDirectory() && !rootStat.isSymbolicLink() && pathKey(realRoot) === pathKey(root) &&
        pathKey(path.dirname(root)) === pathKey(tempRoot) && path.basename(root).startsWith(WORKSPACE_PREFIX));
      requireValue(entries.every((entry) => expectedNames.includes(entry)));
      for (const entry of entries) {
        const stat = await fs.lstat(path.join(root, entry));
        requireValue(stat.isFile() && !stat.isSymbolicLink());
        await fs.unlink(path.join(root, entry));
      }
      await fs.rmdir(root);
    } catch {}
    throw error;
  }

  function openBackend(backendOptions = {}) {
    const backendConfig = captureBackendOptions(backendOptions);
    const backend = createQuestionCapsuleExistingUpdateBackend({
      anchorPath: filePaths.anchor,
      slotPathsBySlot: {
        questions: filePaths.questions,
        checkpoint: filePaths.checkpoint,
        instructions: filePaths.instructions,
      },
      expectedAnchorFingerprint: fingerprint(bytes.anchor),
      expectedInstructionFingerprint: fingerprint(bytes.instructions),
      normalByteLimitsBySlot: fixture.input.normalByteLimitsBySlot,
      capacityBudget: budget,
      pausePoint: backendConfig.pausePoint,
      failurePoint: backendConfig.failurePoint,
    });
    openedBackends.add(backend);
    return backend;
  }

  async function readBytes(slot) {
    requireValue(SLOT_NAMES.includes(slot));
    if (bytes[slot] === null) return null;
    return Buffer.from(await fs.readFile(filePaths[slot]));
  }

  async function readAllBytes() {
    const result = Object.create(null);
    for (const slot of SLOT_NAMES) result[slot] = await readBytes(slot);
    return result;
  }

  async function replaceBytesForTest(slot, replacement) {
    requireValue(SLOT_NAMES.includes(slot) && bytes[slot] !== null && Buffer.isBuffer(replacement));
    await fs.writeFile(filePaths[slot], Buffer.from(replacement));
  }

  async function cleanupInjectedOrphan() {
    if (disposed) return 0;
    const entries = await fs.readdir(root);
    const expected = new Set(expectedNames);
    const extras = entries.filter((entry) => !expected.has(entry));
    requireValue(extras.length <= 1 && extras.every((entry) => TEMPORARY_FILE.test(entry)),
      'question_capsule_existing_update_workspace_unknown_file');
    for (const entry of extras) {
      const filePath = path.join(root, entry);
      const stat = await fs.lstat(filePath);
      requireValue(stat.isFile() && !stat.isSymbolicLink(), 'question_capsule_existing_update_workspace_unsafe_file');
      await fs.unlink(filePath);
    }
    return extras.length;
  }

  function dispose() {
    if (disposePromise !== null) return disposePromise;
    const run = (async () => {
      await Promise.all([...openedBackends].map((backend) => backend.close()));
      baselineLease.release();
      await assertOwnedRoot(root, expectedNames);
      for (const name of expectedNames) await fs.unlink(path.join(root, name));
      await fs.rmdir(root);
      ACTIVE_ROOTS.delete(rootKey);
      disposed = true;
    })();
    disposePromise = run.catch((error) => {
      disposePromise = null;
      throw error;
    });
    return disposePromise;
  }

  function status() {
    return {
      workspaceId,
      root,
      baselineLeaseBytes: baselineLease.status().bytes,
      baselineLeaseHeld: !baselineLease.status().released,
      budget: budget.status(),
      openBackendCount: openedBackends.size,
    };
  }

  return Object.freeze({
    root,
    workspaceId,
    openBackend,
    readBytes,
    readAllBytes,
    replaceBytesForTest,
    cleanupInjectedOrphan,
    status,
    dispose,
  });
}

module.exports = {
  createQuestionCapsuleExistingUpdateFixture,
  createQuestionCapsuleExistingUpdateWorkspace,
};
