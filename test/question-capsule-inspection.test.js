'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fsConstants = require('node:fs').constants;
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createFixtureWorkspace,
} = require('./helpers/question-capsule-migration-workspace');
const { createQuestionCapsuleFilesFixture } = require('./helpers/question-capsule-files-fixtures');
const { createQuestionCapsuleMigrationPlanFixture } = require('./helpers/question-capsule-migration-plan-fixtures');
const { openQuestionCapsuleInspection } = require('../src/server/question-capsule-inspection');
const {
  encodeQuestionJournalV2Local,
} = require('../src/server/common-question-reclamation-codec');
const {
  encodeCheckpointV3Local,
  encodeInstructionJournalV2Local,
} = require('../src/server/delivery-reclamation-codec');
const {
  encodeQuestionReclamationAnchorV1Local,
} = require('../src/server/question-reclamation-anchor-codec');
const {
  encodeQuestionCapsuleJournalV3Local,
} = require('../src/server/question-capsule-journal-codec');
const {
  encodeCapsuleCheckpointV4Local,
} = require('../src/server/question-capsule-checkpoint-codec');
const { createQuestionCapsulePrepareManifest } = require('../src/server/question-capsule-prepare-manifest-codec');
const {
  createQuestionCapsulePreparedMaterial,
  validateQuestionCapsulePreparedMaterial,
} = require('../src/server/question-capsule-prepared-material-codec');
const { planQuestionCapsuleFileMigration } = require('../src/server/question-capsule-migration-plan');
const { measureQuestionCapsuleExistingUpdateReservation } = require('../src/server/question-capsule-existing-update-capacity');
const { planMigrationAllowanceRelease } = require('../src/server/migration-allowance-release');
const {
  MAX_SOURCE_BYTES,
  measureInstructionReservation,
  measureQuestionJournalReservationBytes,
} = require('../src/server/reclamation-capacity-bounds');
const { validateReclamationSnapshot } = require('../src/server/reclamation-store-consistency');
const { createQuestionCapsuleWholeValidationFixture } = require('./helpers/question-capsule-whole-validation-fixtures');
const { validateQuestionCapsuleWholeRepresentation } = require('../src/server/question-capsule-whole-validation');

const FILES = Object.freeze({
  anchor: 'question-reclamation-anchor.json',
  questions: 'common-question-journal.json',
  checkpoint: 'delivery-checkpoint.json',
  instructions: 'instruction-journal.json',
});
const WRITE_ACCESS_FLAGS = fsConstants.O_WRONLY | fsConstants.O_RDWR |
  (fsConstants.O_CREAT ?? 0) | (fsConstants.O_TRUNC ?? 0) | (fsConstants.O_APPEND ?? 0);
const ALL_LIMITS = Object.freeze({
  questions: MAX_SOURCE_BYTES,
  checkpoint: MAX_SOURCE_BYTES,
  instructions: MAX_SOURCE_BYTES,
});

function fixtureFor(provider) {
  return provider === 'mixed'
    ? createQuestionCapsuleFilesFixture({ provider: 'claude', secondaryProvider: 'codex', ordinaryQuestionSelected: true })
    : createQuestionCapsuleFilesFixture({ provider, ordinaryQuestionSelected: true });
}

function legacyBytes(fixture) {
  const snapshot = fixture.snapshot;
  return {
    anchor: encodeQuestionReclamationAnchorV1Local(snapshot.anchor).bytes,
    questions: encodeQuestionJournalV2Local(snapshot.stores.questions).bytes,
    checkpoint: snapshot.stores.checkpoint === null
      ? null : encodeCheckpointV3Local(snapshot.stores.checkpoint).bytes,
    instructions: snapshot.stores.instructions === null
      ? null : encodeInstructionJournalV2Local(snapshot.stores.instructions).bytes,
  };
}

function legacyWholeInput(snapshot, limits = ALL_LIMITS) {
  return {
    formatVersion: 1,
    anchor: snapshot.anchor,
    ordinaryStores: snapshot.stores,
    capsulePairs: [],
    deliveryAttemptOrder: snapshot.stores.checkpoint === null ? []
      : snapshot.stores.checkpoint.ledger.deliveries.map((delivery) => delivery.deliveryAttemptId),
    questionReservationOrder: snapshot.stores.questions === null ? []
      : snapshot.stores.questions.reservations.map((reservation) => reservation.internalQuestionId),
    normalByteLimitsBySlot: limits,
  };
}

function capsuleBytes(fixture) {
  return {
    anchor: encodeQuestionReclamationAnchorV1Local(fixture.input.anchor).bytes,
    questions: encodeQuestionCapsuleJournalV3Local(fixture.questionFile).bytes,
    checkpoint: fixture.checkpointFile === null
      ? null : encodeCapsuleCheckpointV4Local(fixture.checkpointFile).bytes,
    instructions: fixture.input.instructionStore === null
      ? null : encodeInstructionJournalV2Local(fixture.input.instructionStore).bytes,
  };
}

function buildPreparedAtQuestionLimit(options, questionLimit) {
  const fixture = createQuestionCapsuleMigrationPlanFixture(options);
  fixture.input.normalByteLimitsBySlot.questions = questionLimit;
  const manifest = createQuestionCapsulePrepareManifest(fixture.input);
  const plan = planQuestionCapsuleFileMigration(fixture.input);
  const material = createQuestionCapsulePreparedMaterial({
    manifest: manifest.manifest,
    sourceBytes: fixture.input.sourceBytes,
    targetBytes: {
      questions: plan.targets.questions.bytes,
      checkpoint: plan.targets.checkpoint?.bytes ?? null,
    },
  });
  return { fixture, manifest, plan, material };
}

function buildPreparedEnvelopeOverLimit(options) {
  let probe = buildPreparedAtQuestionLimit(options, MAX_SOURCE_BYTES);
  let questionLimit = probe.material.bytes.length + 1;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const bundle = buildPreparedAtQuestionLimit(options, questionLimit);
    if (bundle.material.bytes.length === questionLimit + 1) return bundle;
    questionLimit = bundle.material.bytes.length - 1;
    probe = bundle;
  }
  throw new Error(`prepared envelope limit did not converge: ${probe.material.bytes.length}`);
}

async function materializeFiles(bytes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'question-capsule-inspection-'));
  for (const [slot, filename] of Object.entries(FILES)) {
    if (bytes[slot] !== null) await fs.writeFile(path.join(root, filename), bytes[slot], { flag: 'wx', mode: 0o600 });
  }
  return fs.realpath(root);
}

async function removeInspectionDirectory(root) {
  const tempRoot = path.resolve(await fs.realpath(os.tmpdir()));
  const target = path.resolve(root);
  const relative = path.relative(tempRoot, target);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  assert.equal(path.dirname(target).toLowerCase(), tempRoot.toLowerCase());
  assert.match(path.basename(target), /^question-capsule-inspection-/);
  const stat = await fs.lstat(target);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await fs.realpath(target), target);
  await fs.rm(target, { recursive: true, force: true });
}

async function withReadOnlyFilesystemSpy(operation) {
  const originalOpen = fs.open;
  const mutationMethods = [
    'appendFile', 'chmod', 'chown', 'copyFile', 'link', 'mkdir', 'rename', 'rm', 'rmdir',
    'symlink', 'truncate', 'unlink', 'writeFile',
  ].filter((name) => typeof fs[name] === 'function');
  const originals = new Map(mutationMethods.map((name) => [name, fs[name]]));
  const openedFlags = [];
  const mutations = [];
  fs.open = async function (filePath, flags, ...args) {
    openedFlags.push(flags);
    return originalOpen.call(this, filePath, flags, ...args);
  };
  for (const name of mutationMethods) {
    fs[name] = function (...args) {
      mutations.push(name);
      return originals.get(name).apply(this, args);
    };
  }
  try {
    return await operation({ openedFlags, mutations });
  } finally {
    fs.open = originalOpen;
    for (const [name, original] of originals) fs[name] = original;
  }
}

async function withDirectory(bytes, operation) {
  const root = await materializeFiles(bytes);
  try {
    return await operation(root);
  } finally {
    await removeInspectionDirectory(root);
  }
}

function options(root, limits = ALL_LIMITS) {
  return { dataDirectory: root, normalByteLimitsBySlot: { ...limits } };
}

async function directoryState(root) {
  const names = (await fs.readdir(root)).sort();
  const files = {};
  for (const name of names) {
    const fullPath = path.join(root, name);
    const stat = await fs.stat(fullPath, { bigint: true });
    files[name] = {
      bytes: await fs.readFile(fullPath),
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ino: stat.ino,
    };
  }
  return { names, files };
}

async function waitForPaused(workspace) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (workspace.status().status === 'paused') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture_workspace_pause_timeout:${workspace.status().status}`);
}

async function withWorkspace(scenario, provider, pauseAfterBoundary, operation) {
  const workspace = await createFixtureWorkspace({
    provider,
    scenario,
    maxAdditionalBytes: 100_000_000,
    ...(pauseAfterBoundary ? { pauseAfterBoundary } : {}),
  });
  let startPromise = null;
  try {
    const root = await fs.realpath(workspace.root);
    const limits = scenario === 'checkpoint-null'
      ? { questions: MAX_SOURCE_BYTES, checkpoint: null, instructions: null }
      : ALL_LIMITS;
    if (pauseAfterBoundary) {
      startPromise = workspace.start();
      await waitForPaused(workspace);
    } else if (pauseAfterBoundary === false) {
      await workspace.start();
    }
    await operation(root, limits, workspace);
  } finally {
    await workspace.close();
    if (startPromise) await startPromise;
    await workspace.dispose();
  }
}

test('legacy Q2/CP3 inspection reports reconstructed reservations and leaves files unchanged', async () => {
  const fixture = fixtureFor('claude');
  const raw = legacyBytes(fixture);
  raw.questions = Buffer.concat([raw.questions, Buffer.from('\n \t', 'utf8')]);
  await withDirectory(raw, async (root) => {
    const before = await directoryState(root);
    const service = openQuestionCapsuleInspection(options(root));
    const result = await service.inspect();
    await service.close();
    const after = await directoryState(root);

    assert.equal(result.inspectionStatus, 'inspected');
    assert.equal(result.representation, 'legacy_q2_cp3');
    assert.deepEqual(result.reasons, []);
    assert.equal(result.counts.restoredLegacyView.questions.restoredQuestionReservations,
      fixture.snapshot.stores.questions.reservations.length);
    assert.equal(result.counts.restoredLegacyView.checkpoint.restoredDeliveries,
      fixture.snapshot.stores.checkpoint.ledger.deliveries.length);
    assert.equal(result.files.questions.sizeBytes, raw.questions.length);
    assert.equal(result.files.questions.sha256, createHash('sha256').update(raw.questions).digest('hex'));
    assert.equal(Object.isFrozen(result.scopeLimitations), true);
    assert.ok(result.scopeLimitations.includes('path_component_race_not_excluded'));
    assert.deepEqual(after.names, before.names);
    for (const name of before.names) {
      assert.deepEqual(after.files[name].bytes, before.files[name].bytes);
      assert.equal(after.files[name].size, before.files[name].size);
      assert.equal(after.files[name].mtimeNs, before.files[name].mtimeNs);
    }
  });
});

test('legacy Q2/CP3 capacity failure at canonical B minus one retains every slot measurement', async () => {
  const fixture = fixtureFor('claude');
  const raw = legacyBytes(fixture);
  const limits = { ...ALL_LIMITS, questions: raw.questions.length - 1 };
  await withDirectory(raw, async (root) => {
    const result = await openQuestionCapsuleInspection(options(root, limits)).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['capacity_not_fit']);
    assert.equal(result.representation, 'legacy_q2_cp3');
    assert.equal(result.measurements.restoredLegacyFutureBySlot.questions.rawCurrentBytes,
      raw.questions.length);
    assert.equal(result.measurements.restoredLegacyFutureBySlot.questions.fits, false);
    assert.equal(result.measurements.restoredLegacyFutureBySlot.checkpoint.fits, true);
    assert.equal(result.measurements.restoredLegacyFutureBySlot.instructions.fits, true);
    assert.ok(result.counts.restoredLegacyView.questions);
  });
});

test('legacy Q2/CP3 raw whitespace one byte over B blocks while normalized and future sizes fit', async () => {
  const fixture = fixtureFor('claude');
  const raw = legacyBytes(fixture);
  const normalizedCurrentBytes = encodeQuestionJournalV2Local(fixture.snapshot.stores.questions).sizeBytes;
  const maxLimitMeasurement = measureQuestionJournalReservationBytes({
    snapshot: fixture.snapshot.stores.questions,
    currentByteLimit: MAX_SOURCE_BYTES,
  });
  const questionLimit = Math.max(normalizedCurrentBytes, maxLimitMeasurement.reservedBytes);
  const questionCapacity = measureQuestionJournalReservationBytes({
    snapshot: fixture.snapshot.stores.questions,
    currentByteLimit: questionLimit,
  });
  assert.ok(questionLimit <= MAX_SOURCE_BYTES);
  assert.ok(normalizedCurrentBytes <= questionLimit);
  assert.ok(questionCapacity.reservedBytes <= questionLimit);
  assert.equal(questionCapacity.fits, true);
  assert.doesNotThrow(() => validateQuestionCapsuleWholeRepresentation(legacyWholeInput(
    fixture.snapshot, { ...ALL_LIMITS, questions: questionLimit })));

  raw.questions = Buffer.concat([
    raw.questions,
    Buffer.alloc(questionLimit + 1 - raw.questions.length, 0x20),
  ]);
  assert.equal(raw.questions.length, questionLimit + 1);
  await withDirectory(raw, async (root) => {
    const before = await directoryState(root);
    const result = await openQuestionCapsuleInspection(options(root, {
      ...ALL_LIMITS,
      questions: questionLimit,
    })).inspect();
    const after = await directoryState(root);
    const questionMeasurement = result.measurements.restoredLegacyFutureBySlot.questions;

    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['capacity_not_fit']);
    assert.equal(result.representation, 'legacy_q2_cp3');
    assert.equal(questionMeasurement.rawCurrentBytes, questionLimit + 1);
    assert.equal(questionMeasurement.normalizedCurrentBytes, normalizedCurrentBytes);
    assert.equal(questionMeasurement.reservedBytes, questionCapacity.reservedBytes);
    assert.equal(questionMeasurement.fits, false);
    assert.equal(result.measurements.restoredLegacyFutureBySlot.anchor.fits, true);
    assert.equal(result.measurements.restoredLegacyFutureBySlot.checkpoint.fits, true);
    assert.equal(result.measurements.restoredLegacyFutureBySlot.instructions.fits, true);
    assert.equal(result.files.questions.sha256, createHash('sha256').update(raw.questions).digest('hex'));
    assert.deepEqual(after, before);
  });
});

test('legacy Q2/CP3 repair state is classified before configured-B capacity', async () => {
  const fixture = fixtureFor('claude');
  assert.doesNotThrow(() => validateQuestionCapsuleWholeRepresentation(legacyWholeInput(fixture.snapshot)));
  const snapshot = structuredClone(fixture.snapshot);
  const retained = snapshot.stores.questions.reservations.find((reservation) =>
    reservation.bodyState === 'retained' && reservation.reclamation === null && reservation.quarantinedAt === null);
  assert.ok(retained);
  const retiredAt = Math.max(0, ...snapshot.anchor.retiredQuestionPeriods.map((period) => period.retiredAt)) + 1;
  snapshot.anchor.retiredQuestionPeriods.push({
    identity: structuredClone(retained.identity),
    periodId: retained.periodId,
    retiredAt,
    reason: 'confirmed-retirement',
  });
  const snapshotResult = validateReclamationSnapshot(snapshot);
  assert.equal(snapshotResult.status, 'reconciliation-required');
  assert.deepEqual(snapshotResult.reasons, ['question_retirement_snapshot']);
  const raw = legacyBytes({ snapshot });
  const before = await materializeFiles(raw);
  try {
    const beforeState = await directoryState(before);
    const result = await openQuestionCapsuleInspection(options(before, {
      ...ALL_LIMITS,
      questions: raw.questions.length - 1,
    })).inspect();
    const afterState = await directoryState(before);
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['snapshot_requires_repair']);
    assert.deepEqual(afterState, beforeState);
  } finally {
    await removeInspectionDirectory(before);
  }
});

test('legacy Q2/CP3 grant rows are explicitly unsupported after valid local normalization', async () => {
  const generated = createQuestionCapsuleWholeValidationFixture({ ordinaryQuestionSelected: true });
  for (const slot of ['questions', 'checkpoint']) {
    const snapshot = structuredClone(generated.snapshot);
    snapshot.stores[slot].migrationAllowance = structuredClone(generated.sourceGrants[slot]);
    const validSnapshot = validateReclamationSnapshot(snapshot);
    assert.equal(validSnapshot.status, 'ready');
    assert.deepEqual(validSnapshot.reasons, []);
    assert.equal(validateQuestionCapsuleWholeRepresentation(legacyWholeInput(snapshot))
      .snapshot.stores[slot].migrationAllowance.maxExtraBytes,
    generated.sourceGrants[slot].maxExtraBytes);
    const raw = legacyBytes({ snapshot });
    await withDirectory(raw, async (root) => {
      const result = await openQuestionCapsuleInspection(options(root)).inspect();
      assert.equal(result.inspectionStatus, 'blocked', slot);
      assert.equal(result.representation, 'legacy_q2_cp3', slot);
      assert.deepEqual(result.reasons, ['unsupported_legacy_q_cp_grant'], slot);
    });
  }
});

test('Q3/CP4 inspection separates ordinary records, wrappers, entries, and restored rows for both providers', async () => {
  for (const provider of ['claude', 'codex', 'mixed']) {
    const fixture = fixtureFor(provider);
    await withDirectory(capsuleBytes(fixture), async (root) => {
      const result = await openQuestionCapsuleInspection(options(root)).inspect();
      assert.equal(result.inspectionStatus, 'inspected', provider);
      assert.equal(result.representation, 'capsule_q3_cp4');
      assert.equal(result.operationProvenance, 'unknown');
      assert.equal(result.counts.targetCapsuleView.questions.ordinaryQuestionDetails,
        fixture.questionFile.questions.length);
      assert.equal(result.counts.targetCapsuleView.questions.ordinaryQuestionReservations,
        fixture.questionFile.reservations.length);
      assert.equal(result.counts.targetCapsuleView.questions.capsuleWrappers,
        fixture.questionFile.questionCapsules.length);
      assert.equal(result.counts.targetCapsuleView.questions.restoredQuestionReservations,
        fixture.snapshot.stores.questions.reservations.length);
      assert.equal(result.counts.targetCapsuleView.checkpoint.capsuleWrappers,
        fixture.checkpointFile.checkpointCapsules.length);
      assert.equal(result.counts.targetCapsuleView.checkpoint.restoredDeliveries,
        fixture.snapshot.stores.checkpoint.ledger.deliveries.length);
      assert.ok(result.measurements.targetFixedFutureBySlot.questions.reservedBytes >=
        result.measurements.targetFixedFutureBySlot.questions.normalizedCurrentBytes);
    });
  }
});

test('Q3/CP4 capacity failure at canonical B minus one retains counts and both capacity tables', async () => {
  const fixture = fixtureFor('claude');
  const raw = capsuleBytes(fixture);
  const questionLimit = raw.questions.length - 1;
  assert.equal(raw.questions.length, encodeQuestionCapsuleJournalV3Local(fixture.questionFile).sizeBytes);
  assert.ok(questionLimit < MAX_SOURCE_BYTES);
  await withDirectory(raw, async (root) => {
    const result = await openQuestionCapsuleInspection(options(root, {
      ...ALL_LIMITS,
      questions: questionLimit,
    })).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['capacity_not_fit']);
    assert.equal(result.representation, 'capsule_q3_cp4');
    assert.ok(result.counts.restoredLegacyView.questions);
    assert.ok(result.counts.targetCapsuleView.questions);
    assert.equal(result.measurements.targetFixedFutureBySlot.questions.fits, false);
    assert.equal(result.measurements.restoredLegacyFutureBySlot.questions.fits, false);
    assert.ok(result.measurements.restoredLegacyFutureBySlot.anchor);
    assert.equal(result.measurements.targetFixedFutureBySlot.checkpoint.fits, true);
  });
});

test('Q3/CP4 raw whitespace at B plus one is capacity-blocked after normalized bytes fit', async () => {
  const fixture = fixtureFor('claude');
  const raw = capsuleBytes(fixture);
  const questionCapacity = measureQuestionCapsuleExistingUpdateReservation({
    questionFile: fixture.questionFile,
    currentByteLimit: MAX_SOURCE_BYTES,
  });
  const questionLimit = Math.max(raw.questions.length, questionCapacity.reservedBytes);
  assert.equal(questionCapacity.currentBytes, raw.questions.length);
  assert.ok(questionLimit < MAX_SOURCE_BYTES);
  const padded = {
    ...raw,
    questions: Buffer.concat([raw.questions, Buffer.alloc(questionLimit + 1 - raw.questions.length, 0x20)]),
  };
  assert.equal(padded.questions.length, questionLimit + 1);
  await withDirectory(padded, async (root) => {
    const result = await openQuestionCapsuleInspection(options(root, {
      ...ALL_LIMITS,
      questions: questionLimit,
    })).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['capacity_not_fit']);
    assert.equal(result.measurements.targetFixedFutureBySlot.questions.rawCurrentBytes, questionLimit + 1);
    assert.equal(result.measurements.targetFixedFutureBySlot.questions.normalizedCurrentBytes, raw.questions.length);
    assert.equal(result.measurements.targetFixedFutureBySlot.questions.fits, false);
    assert.ok(result.measurements.targetFixedFutureBySlot.questions.reservedBytes <= questionLimit);
    assert.equal(result.measurements.restoredLegacyFutureBySlot.questions.fits, true);
  });
});

test('Q3/CP4 instruction at canonical B minus one reaches measurement and retains the whole table', async () => {
  const originalFixture = fixtureFor('claude');
  const release = planMigrationAllowanceRelease({
    anchor: originalFixture.snapshot.anchor,
    stores: originalFixture.snapshot.stores,
    normalByteLimitsBySlot: ALL_LIMITS,
    slot: 'instructions',
  });
  assert.equal(release.status, 'released');
  assert.equal(validateReclamationSnapshot(release.snapshot).status, 'ready');
  const fixture = {
    ...originalFixture,
    input: { ...originalFixture.input, instructionStore: release.snapshot.stores.instructions },
  };
  const raw = capsuleBytes(fixture);
  assert.equal(fixture.input.instructionStore.migrationAllowance, null);
  assert.equal(raw.instructions.length, encodeInstructionJournalV2Local(fixture.input.instructionStore).sizeBytes);
  await withDirectory(raw, async (root) => {
    const result = await openQuestionCapsuleInspection(options(root, {
      ...ALL_LIMITS,
      instructions: raw.instructions.length - 1,
    })).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['capacity_not_fit']);
    assert.equal(result.representation, 'capsule_q3_cp4');
    assert.equal(result.measurements.restoredLegacyFutureBySlot.instructions.fits, false);
    assert.equal(result.measurements.restoredLegacyFutureBySlot.instructions.rawCurrentBytes, raw.instructions.length);
    assert.equal(result.measurements.restoredLegacyFutureBySlot.questions.fits, true);
    assert.equal(result.measurements.restoredLegacyFutureBySlot.checkpoint.fits, true);
    assert.equal(result.measurements.targetFixedFutureBySlot.questions.fits, true);
    assert.equal(result.measurements.targetFixedFutureBySlot.checkpoint.fits, true);
  });
});

test('a Q3/CP4 meaning error with low B remains invalid representation', async () => {
  const fixture = fixtureFor('claude');
  const raw = capsuleBytes(fixture);
  const mismatchedAnchor = structuredClone(fixture.input.anchor);
  mismatchedAnchor.storeId = '99999999-9999-4999-8999-999999999999';
  const anchorBytes = encodeQuestionReclamationAnchorV1Local(mismatchedAnchor).bytes;
  assert.doesNotThrow(() => encodeQuestionCapsuleJournalV3Local(fixture.questionFile));
  await withDirectory({ ...raw, anchor: anchorBytes }, async (root) => {
    const result = await openQuestionCapsuleInspection(options(root, {
      ...ALL_LIMITS,
      questions: raw.questions.length - 1,
    })).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['invalid_representation']);
    assert.equal(result.measurements.targetFixedFutureBySlot.questions, null);
  });
});

test('prepared inspection identifies prepared and checkpoint-moved physical boundaries', async () => {
  for (const boundary of ['prepared', 'checkpoint_moved']) {
    await withWorkspace('normal', 'mixed', boundary, async (root, limits) => {
      const service = openQuestionCapsuleInspection(options(root, limits));
      const result = await service.inspect();
      await service.close();
      assert.equal(result.inspectionStatus, 'inspected');
      assert.equal(result.representation, 'prepared_material_v1');
      assert.equal(result.preparedBoundary, boundary);
      assert.equal(result.operationProvenance, 'unknown');
      assert.ok(result.measurements.preparedCapacity.boundaries[boundary]);
      assert.equal(Object.isFrozen(result.measurements.preparedCapacity.scopeLimitations), true);
      assert.ok(result.measurements.restoredLegacyFutureBySlot.questions.reservedBytes > 0);
      assert.ok(result.measurements.targetFixedFutureBySlot.questions.reservedBytes > 0);
    });
  }
});

test('prepared inspection keeps nullable CP and instruction slots absent', async () => {
  await withWorkspace('checkpoint-null', 'codex', 'prepared', async (root, limits) => {
    const result = await openQuestionCapsuleInspection(options(root, limits)).inspect();
    assert.equal(result.inspectionStatus, 'inspected');
    assert.equal(result.preparedBoundary, 'prepared');
    assert.equal(result.files.checkpoint, null);
    assert.equal(result.files.instructions, null);
    assert.equal(result.counts.targetCapsuleView.checkpoint, null);
    assert.equal(result.measurements.targetFixedFutureBySlot.checkpoint, null);
  });
});

test('valid prepared material above B remains a blocked inspection with its boundary diagnostics', async () => {
  const bundle = buildPreparedEnvelopeOverLimit({ provider: 'claude' });
  const sourceBytes = bundle.fixture.input.sourceBytes;
  const limits = bundle.fixture.input.normalByteLimitsBySlot;
  assert.equal(bundle.material.bytes.length, limits.questions + 1);
  assert.doesNotThrow(() => validateQuestionCapsulePreparedMaterial({
    material: bundle.material.material,
    anchorBytes: sourceBytes.anchor,
    instructionBytes: sourceBytes.instructions,
  }));
  await withDirectory({
    anchor: sourceBytes.anchor,
    questions: bundle.material.bytes,
    checkpoint: sourceBytes.checkpoint,
    instructions: sourceBytes.instructions,
  }, async (root) => {
    const result = await openQuestionCapsuleInspection(options(root, limits)).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['capacity_not_fit']);
    assert.equal(result.representation, 'prepared_material_v1');
    assert.equal(result.preparedBoundary, 'prepared');
    assert.equal(result.measurements.preparedCapacity.stableBoundsFit, false);
    assert.equal(result.measurements.preparedCapacity.stableBoundsFitBySlot.questions, false);
    assert.ok(result.measurements.preparedCapacity.boundaries.prepared);
    assert.ok(result.counts.restoredLegacyView.questions);
    assert.ok(result.counts.targetCapsuleView.questions);
  });
});

test('instruction grants remain measured in their own slot', async () => {
  await withWorkspace('instruction-grant', 'claude', null, async (root, limits) => {
    const result = await openQuestionCapsuleInspection(options(root, limits)).inspect();
    assert.equal(result.inspectionStatus, 'inspected');
    assert.ok(result.measurements.restoredLegacyFutureBySlot.instructions.grantedExtraBytes > 0);
  });
});

test('complete physical files use the Q3/CP4 view without claiming operation provenance', async () => {
  await withWorkspace('normal', 'codex', false, async (root, limits) => {
    const service = openQuestionCapsuleInspection(options(root, limits));
    const result = await service.inspect();
    await service.close();
    assert.equal(result.inspectionStatus, 'inspected');
    assert.equal(result.representation, 'capsule_q3_cp4');
    assert.equal(result.operationProvenance, 'unknown');
    assert.ok(result.counts.targetCapsuleView.questions);
  });
});

test('Q3/CP4 instruction raw bytes may reach B plus the verified grant, but not exceed it', async () => {
  await withWorkspace('instruction-grant', 'claude', false, async (root, limits) => {
    const instructionPath = path.join(root, FILES.instructions);
    const instructionBytes = await fs.readFile(instructionPath);
    const instructionStore = JSON.parse(instructionBytes.toString('utf8'));
    const canonicalBytes = encodeInstructionJournalV2Local(instructionStore).bytes;
    const grantBytes = instructionStore.migrationAllowance.maxExtraBytes;
    const capacity = measureInstructionReservation({
      snapshot: instructionStore,
      currentByteLimit: MAX_SOURCE_BYTES,
    });
    const instructionLimit = Math.max(canonicalBytes.length, capacity.reservedBytes - grantBytes) + 1;
    const exactRawBytes = instructionLimit + grantBytes;
    const exactPadding = exactRawBytes - canonicalBytes.length;

    assert.ok(grantBytes > 0);
    assert.ok(exactPadding >= grantBytes);
    await fs.writeFile(instructionPath, Buffer.concat([
      canonicalBytes,
      Buffer.alloc(exactPadding, 0x20),
    ]));

    const exact = await openQuestionCapsuleInspection(options(root, {
      ...limits,
      instructions: instructionLimit,
    })).inspect();
    assert.equal(exact.inspectionStatus, 'inspected');
    assert.equal(exact.representation, 'capsule_q3_cp4');
    assert.equal(exact.files.instructions.sizeBytes, exactRawBytes);
    assert.equal(exact.measurements.restoredLegacyFutureBySlot.instructions.rawCurrentBytes, exactRawBytes);
    assert.equal(exact.measurements.restoredLegacyFutureBySlot.instructions.grantedExtraBytes, grantBytes);
    assert.equal(exactRawBytes, instructionLimit + grantBytes);

    await fs.writeFile(instructionPath, Buffer.concat([
      canonicalBytes,
      Buffer.alloc(exactPadding + 1, 0x20),
    ]));
    const over = await openQuestionCapsuleInspection(options(root, {
      ...limits,
      instructions: instructionLimit,
    })).inspect();
    assert.equal(over.inspectionStatus, 'blocked');
    assert.deepEqual(over.reasons, ['capacity_not_fit']);
  });
});

test('ready and blocked inspections use only read-only file opens and no filesystem mutation APIs', async () => {
  assert.ok(Number.isInteger(WRITE_ACCESS_FLAGS) && WRITE_ACCESS_FLAGS > 0);
  assert.notEqual(fsConstants.O_WRONLY & WRITE_ACCESS_FLAGS, 0);
  assert.notEqual(fsConstants.O_RDWR & WRITE_ACCESS_FLAGS, 0);
  for (const flag of [fsConstants.O_CREAT, fsConstants.O_TRUNC, fsConstants.O_APPEND]) {
    if (Number.isInteger(flag)) assert.notEqual(flag & WRITE_ACCESS_FLAGS, 0);
  }
  const fixture = fixtureFor('claude');
  const current = capsuleBytes(fixture);
  for (const [bytes, expectedStatus] of [
    [current, 'inspected'],
    [{ ...current, questions: Buffer.from('{"schemaVersion":99}', 'utf8') }, 'blocked'],
  ]) {
    await withDirectory(bytes, async (root) => {
      const observed = await withReadOnlyFilesystemSpy(async ({ openedFlags, mutations }) => ({
        result: await openQuestionCapsuleInspection(options(root)).inspect(),
        openedFlags,
        mutations,
      }));
      assert.equal(observed.result.inspectionStatus, expectedStatus);
      assert.ok(observed.openedFlags.length > 0);
      assert.ok(observed.openedFlags.every((flags) => Number.isInteger(flags) &&
        (flags & WRITE_ACCESS_FLAGS) === 0));
      assert.deepEqual(observed.mutations, []);
    });
  }
  await withWorkspace('normal', 'claude', 'prepared', async (root, limits) => {
    const observed = await withReadOnlyFilesystemSpy(async ({ openedFlags, mutations }) => ({
      result: await openQuestionCapsuleInspection(options(root, limits)).inspect(),
      openedFlags,
      mutations,
    }));
    assert.equal(observed.result.inspectionStatus, 'inspected');
    assert.equal(observed.result.representation, 'prepared_material_v1');
    assert.ok(observed.openedFlags.every((flags) => Number.isInteger(flags) &&
      (flags & WRITE_ACCESS_FLAGS) === 0));
    assert.deepEqual(observed.mutations, []);
  });
});

test('prepared material whose manifest limits differ from configured limits is blocked', async () => {
  await withWorkspace('normal', 'claude', 'prepared', async (root) => {
    const mismatched = { ...ALL_LIMITS, questions: ALL_LIMITS.questions - 1 };
    const result = await openQuestionCapsuleInspection(options(root, mismatched)).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['normal_byte_limit_mismatch']);
  });
});

test('unknown schemas, mixed Q/CP versions, missing required files, presence mismatches, and orphan candidates are blocked', async () => {
  const fixture = fixtureFor('claude');
  const current = capsuleBytes(fixture);
  await withDirectory({ ...current, questions: Buffer.from('{"schemaVersion":99}', 'utf8') }, async (root) => {
    const result = await openQuestionCapsuleInspection(options(root)).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['unsupported_representation']);
  });
  await withDirectory({ ...current, questions: legacyBytes(fixture).questions }, async (root) => {
    const result = await openQuestionCapsuleInspection(options(root)).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['mixed_representation']);
  });
  await withDirectory({ ...current, checkpoint: legacyBytes(fixture).checkpoint }, async (root) => {
    const result = await openQuestionCapsuleInspection(options(root)).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['mixed_representation']);
  });
  await withDirectory({ ...current, questions: null }, async (root) => {
    const result = await openQuestionCapsuleInspection(options(root)).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['configured_file_missing']);
  });
  await withDirectory(current, async (root) => {
    const presentWithNullLimit = await openQuestionCapsuleInspection(options(root,
      { ...ALL_LIMITS, checkpoint: null })).inspect();
    assert.equal(presentWithNullLimit.inspectionStatus, 'blocked');
    assert.deepEqual(presentWithNullLimit.reasons, ['file_presence_mismatch']);
    await fs.writeFile(path.join(root, '.common-question-journal.json.123.aaaa.tmp'), 'candidate');
    const orphan = await openQuestionCapsuleInspection(options(root)).inspect();
    assert.equal(orphan.inspectionStatus, 'blocked');
    assert.deepEqual(orphan.reasons, ['orphan_candidate_present']);
  });
});

test('inspection blocks a junction at a canonical data-directory path', async (t) => {
  const fixture = fixtureFor('claude');
  const bytes = capsuleBytes(fixture);
  await withDirectory(bytes, async (root) => {
    const target = path.join(root, 'target-data');
    const junction = path.join(root, 'linked-data');
    await fs.mkdir(target);
    for (const filename of Object.values(FILES)) {
      const source = path.join(root, filename);
      try {
        await fs.rename(source, path.join(target, filename));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
    }
    try {
      await fs.symlink(target, junction, 'junction');
    } catch (error) {
      if (['EACCES', 'ENOTSUP', 'EPERM'].includes(error.code)) {
        t.skip('the test environment does not allow creating directory junctions');
        return;
      }
      throw error;
    }
    try {
      const result = await openQuestionCapsuleInspection(options(junction)).inspect();
      assert.equal(result.inspectionStatus, 'blocked');
      assert.deepEqual(result.reasons, ['unsafe_directory_path']);
    } finally {
      await fs.unlink(junction);
    }
  });
});

test('inspection blocks a symbolic link at a canonical file path', async (t) => {
  const fixture = fixtureFor('claude');
  const current = capsuleBytes(fixture);
  await withDirectory(current, async (root) => {
    const questionPath = path.join(root, FILES.questions);
    const targetPath = path.join(root, 'question-copy.json');
    await fs.writeFile(targetPath, current.questions);
    await fs.unlink(questionPath);
    try {
      await fs.symlink(targetPath, questionPath, 'file');
    } catch (error) {
      if (['EACCES', 'ENOTSUP', 'EPERM'].includes(error.code)) {
        t.skip('the test environment does not allow creating file symbolic links');
        return;
      }
      throw error;
    }
    const result = await openQuestionCapsuleInspection(options(root)).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['unsafe_file_path']);
  });
});

test('concurrent inspections return detached diagnostics and close gates later reads', async () => {
  const fixture = fixtureFor('claude');
  await withDirectory(legacyBytes(fixture), async (root) => {
    const service = openQuestionCapsuleInspection(options(root));
    const capturedConfig = options(root);
    const capturedService = openQuestionCapsuleInspection(capturedConfig);
    capturedConfig.normalByteLimitsBySlot.questions = 1;
    assert.equal((await capturedService.inspect()).inspectionStatus, 'inspected');
    await capturedService.close();
    assert.equal(Object.isFrozen(service), true);
    const [first, second] = await Promise.all([service.inspect(), service.inspect()]);
    assert.notEqual(first, second);
    assert.deepEqual(first, second);
    first.files.questions.sizeBytes = -1;
    assert.notEqual(second.files.questions.sizeBytes, -1);
    assert.doesNotMatch(JSON.stringify(second), /11111111-1111-4111-8111-111111111111|internal-1|payload/);
    const closeOne = service.close();
    const closeTwo = service.close();
    assert.equal(closeOne, closeTwo);
    await closeOne;
    await assert.rejects(service.inspect(), { name: 'TypeError', message: 'question_capsule_inspection_closed' });
  });
});

test('close waits for an in-flight inspection before draining', async () => {
  const fixture = fixtureFor('claude');
  await withDirectory(legacyBytes(fixture), async (root) => {
    const originalOpen = fs.open;
    let signalReadStarted;
    let releaseRead;
    const readStarted = new Promise((resolve) => { signalReadStarted = resolve; });
    const readGate = new Promise((resolve) => { releaseRead = resolve; });
    let service;
    let inspection;
    fs.open = async function (...args) {
      const handle = await originalOpen.apply(this, args);
      const originalRead = handle.read.bind(handle);
      let firstRead = true;
      handle.read = async (...readArgs) => {
        if (firstRead) {
          firstRead = false;
          signalReadStarted();
          await readGate;
        }
        return originalRead(...readArgs);
      };
      return handle;
    };
    try {
      service = openQuestionCapsuleInspection(options(root));
      inspection = service.inspect();
      await readStarted;
      let drained = false;
      const closing = service.close().then(() => { drained = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(drained, false);
      releaseRead();
      const result = await inspection;
      await closing;
      assert.equal(result.inspectionStatus, 'inspected');
      assert.equal(drained, true);
      await assert.rejects(service.inspect(), {
        name: 'TypeError', message: 'question_capsule_inspection_closed',
      });
    } finally {
      releaseRead();
      if (service !== undefined) {
        await Promise.allSettled([service.close(), ...(inspection === undefined ? [] : [inspection])]);
      }
      fs.open = originalOpen;
    }
  });
});

test('inspection blocks when source bytes change between its two read rounds', async () => {
  const fixture = fixtureFor('claude');
  const bytes = legacyBytes(fixture);
  await withDirectory(bytes, async (root) => {
    const originalOpen = fs.open;
    const originalWriteFile = fs.writeFile;
    const questionPath = path.join(root, FILES.questions);
    let changed = false;
    fs.open = async function (filePath, ...args) {
      const handle = await originalOpen.call(this, filePath, ...args);
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        await originalClose();
        if (!changed && path.resolve(filePath) === path.resolve(questionPath)) {
          changed = true;
          await originalWriteFile(questionPath, Buffer.concat([bytes.questions, Buffer.from('\n', 'utf8')]));
        }
      };
      return handle;
    };
    try {
      const result = await openQuestionCapsuleInspection(options(root)).inspect();
      assert.equal(changed, true);
      assert.equal(result.inspectionStatus, 'blocked');
      assert.deepEqual(result.reasons, ['source_changed_during_inspection']);
    } finally {
      fs.open = originalOpen;
    }
  });
});

test('invalid configuration rejects proxies and getters without invoking them', async () => {
  let traps = 0;
  const proxied = new Proxy({}, {
    ownKeys() { traps += 1; throw new Error('trap'); },
  });
  assert.throws(() => openQuestionCapsuleInspection(proxied), {
    name: 'TypeError', message: 'invalid_question_capsule_inspection',
  });
  let getterCalls = 0;
  const input = Object.create(null);
  Object.defineProperty(input, 'dataDirectory', { enumerable: true, get() { getterCalls += 1; return 'x'; } });
  Object.defineProperty(input, 'normalByteLimitsBySlot', { enumerable: true, value: ALL_LIMITS });
  assert.throws(() => openQuestionCapsuleInspection(input), {
    name: 'TypeError', message: 'invalid_question_capsule_inspection',
  });
  assert.equal(traps, 0);
  assert.equal(getterCalls, 0);
});

test('raw file limits reject an oversized question source before JSON decoding', async () => {
  const root = await materializeFiles({
    anchor: Buffer.from('{}'),
    questions: Buffer.alloc(MAX_SOURCE_BYTES + 1),
    checkpoint: null,
    instructions: null,
  });
  try {
    const result = await openQuestionCapsuleInspection(options(root,
      { questions: MAX_SOURCE_BYTES, checkpoint: null, instructions: null })).inspect();
    assert.equal(result.inspectionStatus, 'blocked');
    assert.deepEqual(result.reasons, ['source_too_large']);
  } finally {
    await removeInspectionDirectory(root);
  }
});
