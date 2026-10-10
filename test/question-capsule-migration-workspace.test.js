'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createFixtureWorkspace,
  estimateFixtureRequirements,
  FAILURE_POINTS,
  FILE_BASENAMES,
  recoverFixtureWorkspace,
} = require('./helpers/question-capsule-migration-workspace');
const { createQuestionCapsuleMigrationPlanFixture } = require('./helpers/question-capsule-migration-plan-fixtures');
const { planQuestionCapsuleFileMigration } = require('../src/server/question-capsule-migration-plan');
const { createQuestionCapsulePrepareManifest } = require('../src/server/question-capsule-prepare-manifest-codec');
const { createQuestionCapsulePreparedMaterial } = require('../src/server/question-capsule-prepared-material-codec');
const { assessQuestionCapsuleMigrationCapacity } = require('../src/server/question-capsule-migration-capacity');
const { decodeSourceBytes } = require('../src/server/reclamation-json-codec');
const { MAX_SOURCE_BYTES } = require('../src/server/reclamation-capacity-bounds');
const {
  decodeCapsuleCheckpointV4Local,
  encodeCapsuleCheckpointV4Local,
} = require('../src/server/question-capsule-checkpoint-codec');
const {
  decodeQuestionCapsuleJournalV3Local,
  encodeQuestionCapsuleJournalV3Local,
} = require('../src/server/question-capsule-journal-codec');

const CHILD_PATH = path.join(__dirname, 'helpers', 'question-capsule-migration-workspace-child.js');
const WORKSPACE_FILES = Object.freeze(Object.values(FILE_BASENAMES));
const CHILD_TIMEOUT_MS = 30_000;
const REQUIREMENTS = new Map();

function maxBudget(provider, scenario) {
  return requirements(provider, scenario).maxAdditionalBytesForStart;
}

function requirements(provider, scenario) {
  const key = `${provider}:${scenario}`;
  if (!REQUIREMENTS.has(key)) REQUIREMENTS.set(key, estimateFixtureRequirements({ provider, scenario }));
  return REQUIREMENTS.get(key);
}

function metadataFor(provider, scenario) {
  const options = provider === 'mixed'
    ? { provider: 'claude', secondaryProvider: 'codex', ordinaryQuestionSelected: true }
    : { provider, ordinaryQuestionSelected: true };
  if (scenario === 'checkpoint-null') options.internalQuestionIds = ['internal-4'];
  const fixture = createQuestionCapsuleMigrationPlanFixture(options);
  const normalByteLimitsBySlot = structuredClone(fixture.input.normalByteLimitsBySlot);
  if (scenario === 'checkpoint-null') {
    normalByteLimitsBySlot.checkpoint = null;
    normalByteLimitsBySlot.instructions = null;
  }
  return { fixture, normalByteLimitsBySlot };
}

function independentReservationFromSeededBytes(files, provider, scenario) {
  const { fixture, normalByteLimitsBySlot } = metadataFor(provider, scenario);
  const sourceBytes = {
    anchor: files.get(FILE_BASENAMES.anchor),
    questions: files.get(FILE_BASENAMES.questions),
    checkpoint: files.get(FILE_BASENAMES.checkpoint) ?? null,
    instructions: files.get(FILE_BASENAMES.instructions) ?? null,
  };
  assert.ok(sourceBytes.anchor && sourceBytes.questions);
  assert.equal(sourceBytes.checkpoint === null, scenario === 'checkpoint-null');
  assert.equal(sourceBytes.instructions === null, scenario === 'checkpoint-null');

  const plannerInput = {
    sourceBytes,
    normalByteLimitsBySlot,
    selection: structuredClone(fixture.input.selection),
    operationId: fixture.input.operationId,
    chunkIds: [...fixture.input.chunkIds],
  };
  const manifest = createQuestionCapsulePrepareManifest(plannerInput);
  const plan = planQuestionCapsuleFileMigration(plannerInput);
  const targetBytes = {
    questions: plan.targets.questions.bytes,
    checkpoint: plan.targets.checkpoint?.bytes ?? null,
  };
  const material = createQuestionCapsulePreparedMaterial({
    manifest: manifest.manifest,
    sourceBytes,
    targetBytes,
  });
  const assessment = assessQuestionCapsuleMigrationCapacity({
    materialBytes: material.bytes,
    anchorBytes: sourceBytes.anchor,
    instructionBytes: sourceBytes.instructions,
    expectedNormalByteLimitsBySlot: normalByteLimitsBySlot,
  });

  function oldSlotBytes(measurement) {
    if (measurement === null) return 0;
    assert.ok(Number.isSafeInteger(measurement.rawCurrentBytes) && measurement.rawCurrentBytes >= 0);
    assert.ok(Number.isSafeInteger(measurement.reservedBytes) && measurement.reservedBytes >= 0);
    return Math.max(measurement.rawCurrentBytes, measurement.reservedBytes);
  }

  const baselineBySlot = {
    anchor: oldSlotBytes(assessment.measurements.anchor),
    instructions: oldSlotBytes(assessment.measurements.instructions),
    questions: oldSlotBytes(assessment.measurements.source.questions),
    checkpoint: oldSlotBytes(assessment.measurements.source.checkpoint),
  };
  const baselineBytes = Object.values(baselineBySlot).reduce((sum, bytes) => sum + bytes, 0);
  assert.ok(Number.isSafeInteger(baselineBytes));

  const protectedTotals = Object.values(assessment.boundaries).map((boundary) => boundary.protectedTotalBytes);
  const conditionalTemps = Object.values(assessment.singleTempCandidates)
    .map((candidate) => candidate.conditionalReservationBytes);
  const allOperationCandidates = [...protectedTotals, ...conditionalTemps];
  assert.ok(allOperationCandidates.length > 0);
  assert.ok(allOperationCandidates.every((bytes) => Number.isSafeInteger(bytes) && bytes >= 0));
  const operationBytes = Math.max(...allOperationCandidates);
  return { baselineBytes, operationBytes, totalBytes: baselineBytes + operationBytes, baselineBySlot };
}

async function readKnownFiles(root) {
  const result = new Map();
  for (const basename of WORKSPACE_FILES) {
    try {
      result.set(basename, await fs.readFile(path.join(root, basename)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return result;
}

async function assertKnownFilesEqual(root, expected) {
  const actual = await readKnownFiles(root);
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [basename, bytes] of expected) assert.deepEqual(actual.get(basename), bytes);
}

function spawnFixtureChild(input) {
  const { cleanup, ...childInput } = input;
  let child;
  try {
    child = fork(CHILD_PATH, [JSON.stringify(childInput)], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  } catch (error) {
    if (error.code === 'EPERM') return { unavailable: error };
    throw error;
  }
  const queued = [];
  const waiters = [];
  let exitInfo = null;
  let spawnError = null;
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });

  function rejectWaiters(error) {
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.length = 0;
  }

  function finishExit(result) {
    if (exitInfo !== null) return;
    exitInfo = result;
    resolveExit(exitInfo);
    rejectWaiters(new Error(`child exited before requested message: ${result.code}/${result.signal}`));
  }

  child.once('exit', (code, signal) => finishExit({ code, signal }));
  child.on('error', (error) => {
    spawnError = error;
    rejectWaiters(error);
    if (child.pid === undefined) finishExit({ code: null, signal: null, error });
  });

  child.on('message', (message) => {
    if (message?.type === 'created' && typeof message.root === 'string') {
      cleanup.registerRoot(message.root, input.maxAdditionalBytes);
    }
    const index = waiters.findIndex((waiter) => waiter.type === message?.type);
    if (index === -1) {
      queued.push(message);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });

  function waitFor(type) {
    const index = queued.findIndex((message) => message?.type === type);
    if (index !== -1) return Promise.resolve(queued.splice(index, 1)[0]);
    if (exitInfo) return Promise.reject(spawnError || new Error(`child exited before ${type}: ${exitInfo.code}/${exitInfo.signal}`));
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex !== -1) waiters.splice(waiterIndex, 1);
        reject(new Error(`timed out waiting for child ${type}`));
      }, CHILD_TIMEOUT_MS);
      waiters.push(waiter);
    });
  }

  const handle = { child, exit, waitFor, get exitInfo() { return exitInfo; }, get spawnError() { return spawnError; } };
  cleanup.registerChild(handle);
  return handle;
}

async function killAndWait(childHandle) {
  if (childHandle.exitInfo !== null) return childHandle.exit;
  if (childHandle.spawnError && childHandle.child.pid === undefined) return childHandle.exit;
  if (childHandle.child.exitCode === null && childHandle.child.signalCode === null) {
    try {
      childHandle.child.kill('SIGKILL');
    } catch (error) {
      if (childHandle.exitInfo === null) throw error;
    }
  }
  return childHandle.exit;
}

function registerOwnedCleanup(t) {
  const children = new Set();
  const roots = new Map();
  const cleanup = {
    registerChild(child) { children.add(child); },
    registerRoot(root, maxAdditionalBytes) { roots.set(root, maxAdditionalBytes); },
    forgetRoot(root) { roots.delete(root); },
  };
  t.after(async () => {
    let allChildrenExited = true;
    for (const child of children) {
      try {
        await killAndWait(child);
      } catch (error) {
        allChildrenExited = false;
        console.error(`fixture child cleanup failed: ${error?.message || error}`);
      }
    }
    if (!allChildrenExited) {
      for (const root of roots.keys()) console.error(`fixture root cleanup deferred while a child may run: ${root}`);
      return;
    }
    for (const [root, maxAdditionalBytes] of roots) {
      try {
        const owner = await recoverFixtureWorkspace({ root, maxAdditionalBytes });
        await owner.dispose();
      } catch (error) {
        console.error(`fixture root cleanup left unchanged: ${root}: ${error?.code || error?.message || error}`);
      }
    }
  });
  return cleanup;
}

async function createFreshRecovery(input, cleanup) {
  const childHandle = spawnFixtureChild({
    command: 'recover',
    root: input.root,
    maxAdditionalBytes: input.maxAdditionalBytes,
    failurePoint: input.failurePoint ?? null,
    pauseAfterBoundary: input.pauseAfterBoundary ?? null,
    cleanup,
  });
  return childHandle;
}

async function removeOwnedWriterTemp(root) {
  const entries = await fs.readdir(root);
  const temporaries = entries.filter((entry) =>
    /^\.[^/\\]+\.\d+\.[0-9a-f-]{36}\.tmp$/.test(entry));
  assert.equal(temporaries.length, 1);
  const tempPath = path.join(root, temporaries[0]);
  const stat = await fs.lstat(tempPath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  await fs.unlink(tempPath);
}

function mutateTrailingNewline(bytes) {
  const copy = Buffer.from(bytes);
  const index = copy.lastIndexOf(0x0a);
  assert.notEqual(index, -1);
  copy[index] = 0x20;
  return copy;
}

test('native migration succeeds for both providers, mixed periods, null checkpoints, and an instruction grant', async (t) => {
  const cases = [
    ['claude', 'normal'],
    ['codex', 'normal'],
    ['mixed', 'normal'],
    ['claude', 'checkpoint-null'],
    ['codex', 'checkpoint-null'],
    ['claude', 'instruction-grant'],
  ];

  for (const [provider, scenario] of cases) {
    await t.test(`${provider} ${scenario}`, async () => {
      const workspace = await createFixtureWorkspace({
        provider,
        scenario,
        maxAdditionalBytes: maxBudget(provider, scenario),
      });
      try {
        const before = await readKnownFiles(workspace.root);
        const independent = independentReservationFromSeededBytes(before, provider, scenario);
        const estimate = requirements(provider, scenario);
        assert.equal(estimate.baselineBytes, independent.baselineBytes);
        assert.equal(estimate.operationBytes, independent.operationBytes);
        assert.equal(estimate.maxAdditionalBytesForStart, independent.totalBytes);
        assert.equal(maxBudget(provider, scenario), independent.totalBytes);
        if (scenario === 'checkpoint-null') {
          assert.equal(before.has(FILE_BASENAMES.instructions), false);
        } else {
          const instructionStore = decodeSourceBytes(before.get(FILE_BASENAMES.instructions), MAX_SOURCE_BYTES).value;
          assert.equal(instructionStore.migrationAllowance === null, scenario !== 'instruction-grant');
        }
        const initial = workspace.status();
        assert.equal(initial.status, 'source');
        assert.equal(initial.baselineLeaseBytes, independent.baselineBytes);
        assert.equal(initial.operationLeaseBytes, 0);

        const result = await workspace.start();
        assert.equal(result.status, 'complete');
        assert.equal(result.boundary, 'complete');
        assert.equal(result.operationLeaseHeld, true);
        assert.equal(result.operationLeaseBytes, independent.operationBytes);
        assert.equal(result.migrationWriteCount, scenario === 'checkpoint-null' ? 2 : 3);

        const after = await readKnownFiles(workspace.root);
        assert.deepEqual(after.get(FILE_BASENAMES.anchor), before.get(FILE_BASENAMES.anchor));
        assert.deepEqual(after.get(FILE_BASENAMES.instructions) ?? null,
          before.get(FILE_BASENAMES.instructions) ?? null);
        const questions = decodeQuestionCapsuleJournalV3Local(after.get(FILE_BASENAMES.questions));
        assert.deepEqual(encodeQuestionCapsuleJournalV3Local(questions).bytes,
          after.get(FILE_BASENAMES.questions));
        const checkpointBytes = after.get(FILE_BASENAMES.checkpoint);
        if (scenario === 'checkpoint-null') {
          assert.equal(checkpointBytes, undefined);
        } else {
          const checkpoint = decodeCapsuleCheckpointV4Local(checkpointBytes);
          assert.deepEqual(encodeCapsuleCheckpointV4Local(checkpoint).bytes, checkpointBytes);
        }

        const closed = await workspace.close();
        assert.equal(closed.operationLeaseBytes, 0);
        assert.equal(closed.operationLeaseHeld, false);
        assert.equal(closed.baselineLeaseBytes, independent.baselineBytes);
        const disposed = await workspace.dispose();
        assert.equal(disposed.baselineLeaseBytes, 0);
      } finally {
        await workspace.dispose();
      }
    });
  }
});

test('source recovery reports unprepared without starting migration writes', async () => {
  const workspace = await createFixtureWorkspace({
    provider: 'codex', scenario: 'normal', maxAdditionalBytes: maxBudget('codex', 'normal'),
  });
  try {
    const before = await readKnownFiles(workspace.root);
    const recovered = await workspace.recover();
    assert.equal(recovered.outcome, 'source_unprepared');
    assert.equal(recovered.status, 'source_unprepared');
    assert.equal(recovered.migrationWriteCount, 0);
    assert.equal(recovered.operationLeaseBytes, 0);
    await assertKnownFilesEqual(workspace.root, before);
    const started = await workspace.start();
    assert.equal(started.status, 'complete');
    assert.equal(started.migrationWriteCount, 3);
  } finally {
    await workspace.dispose();
  }
});

test('operation-capacity shortage leaves seeded source files unchanged and takes no migration write', async () => {
  const capacityLimit = maxBudget('claude', 'normal') - 1;
  const workspace = await createFixtureWorkspace({
    provider: 'claude',
    scenario: 'normal',
    maxAdditionalBytes: capacityLimit,
  });
  try {
    const before = await readKnownFiles(workspace.root);
    const independent = independentReservationFromSeededBytes(before, 'claude', 'normal');
    const estimate = requirements('claude', 'normal');
    assert.equal(estimate.baselineBytes, independent.baselineBytes);
    assert.equal(estimate.operationBytes, independent.operationBytes);
    assert.equal(capacityLimit, independent.totalBytes - 1);
    assert.equal(workspace.status().baselineLeaseBytes, independent.baselineBytes);
    const result = await workspace.start();
    assert.equal(result.status, 'blocked');
    assert.equal(result.blockedReason, 'reclamation_capacity_exceeded');
    assert.equal(result.migrationWriteCount, 0);
    assert.equal(result.operationLeaseBytes, 0);
    assert.ok(result.baselineLeaseBytes > 0);
    await assertKnownFilesEqual(workspace.root, before);
    await assert.rejects(workspace.start(), TypeError);
    await assert.rejects(workspace.recover(), TypeError);
    assert.equal(workspace.status().operationLeaseBytes, 0);
  } finally {
    await workspace.dispose();
  }
});

test('close drains a paused operation, prevents its next boundary, and is idempotent', async () => {
  const workspace = await createFixtureWorkspace({
    provider: 'mixed',
    scenario: 'normal',
    maxAdditionalBytes: maxBudget('mixed', 'normal'),
    pauseAfterBoundary: 'prepared',
  });
  try {
    const starting = workspace.start();
    for (let attempt = 0; attempt < 200 && workspace.status().status !== 'paused'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(workspace.status().status, 'paused');
    await assert.rejects(workspace.start(), TypeError);
    await assert.rejects(workspace.recover(), TypeError);
    const closing = workspace.close();
    assert.equal(workspace.close(), closing);
    const closed = await closing;
    const startResult = await starting;
    assert.equal(startResult.boundary, 'prepared');
    assert.equal(startResult.migrationWriteCount, 1);
    assert.equal(closed.operationLeaseBytes, 0);
    assert.equal(closed.baselineLeaseBytes, requirements('mixed', 'normal').baselineBytes);
    await assert.rejects(workspace.start(), TypeError);
  } finally {
    await workspace.dispose();
  }
});

test('a fresh process resumes only from a known saved boundary and reports final provenance as unknown', async (t) => {
  const cleanup = registerOwnedCleanup(t);
  const provider = 'claude';
  const scenario = 'normal';
  const maxAdditionalBytes = maxBudget(provider, scenario);
  const first = spawnFixtureChild({
    command: 'seed-and-start', provider, scenario, maxAdditionalBytes,
    failurePoint: null, pauseAfterBoundary: 'prepared',
    cleanup,
  });
  if (first.unavailable) {
    t.skip(`fresh-process execution is unavailable: ${first.unavailable.code}`);
    return;
  }
  const created = await first.waitFor('created');
  const prepared = await first.waitFor('paused');
  assert.equal(prepared.boundary, 'prepared');
  await killAndWait(first);

  const second = await createFreshRecovery({
    root: created.root, maxAdditionalBytes, pauseAfterBoundary: 'checkpoint_moved',
  }, cleanup);
  if (second.unavailable) {
    t.skip(`fresh-process recovery is unavailable: ${second.unavailable.code}`);
    return;
  }
  const moved = await second.waitFor('paused');
  assert.equal(moved.boundary, 'checkpoint_moved');
  await killAndWait(second);

  const third = await createFreshRecovery({ root: created.root, maxAdditionalBytes }, cleanup);
  if (third.unavailable) {
    t.skip(`fresh-process recovery is unavailable: ${third.unavailable.code}`);
    return;
  }
  const completed = await third.waitFor('result');
  assert.equal(completed.result.outcome, 'resumed_operation');
  assert.equal(completed.result.boundary, 'complete');
  assert.equal((await third.exit).code, 0);

  const fourth = await createFreshRecovery({ root: created.root, maxAdditionalBytes }, cleanup);
  if (fourth.unavailable) {
    t.skip(`fresh-process recovery is unavailable: ${fourth.unavailable.code}`);
    return;
  }
  const alreadyMigrated = await fourth.waitFor('result');
  assert.equal(alreadyMigrated.result.outcome, 'already_migrated_representation');
  assert.equal(alreadyMigrated.result.operationProvenance, 'unknown');
  assert.equal((await fourth.exit).code, 0);

  const owner = await recoverFixtureWorkspace({ root: created.root, maxAdditionalBytes });
  await owner.dispose();
  cleanup.forgetRoot(created.root);
});

test('each fixed writer failure either blocks on an orphan or resumes from the exact renamed boundary', async (t) => {
  for (const failurePoint of FAILURE_POINTS) {
    await t.test(failurePoint, async (subtest) => {
      const cleanup = registerOwnedCleanup(subtest);
      const provider = failurePoint.startsWith('question_prepare') ? 'codex' : 'claude';
      const scenario = 'normal';
      const maxAdditionalBytes = maxBudget(provider, scenario);
      const writer = spawnFixtureChild({
        command: 'seed-and-start', provider, scenario, maxAdditionalBytes,
        failurePoint, pauseAfterBoundary: null,
        cleanup,
      });
      if (writer.unavailable) {
        subtest.skip(`fresh-process execution is unavailable: ${writer.unavailable.code}`);
        return;
      }
      const created = await writer.waitFor('created');
      const failedStart = await writer.waitFor('result');
      assert.equal(failedStart.result.status, 'blocked');
      assert.equal((await writer.exit).code, 0);

      if (failurePoint.endsWith('_before_rename')) {
        const recovery = await createFreshRecovery({ root: created.root, maxAdditionalBytes }, cleanup);
        if (recovery.unavailable) {
          subtest.skip(`fresh-process recovery is unavailable: ${recovery.unavailable.code}`);
          return;
        }
        const failure = await recovery.waitFor('error');
        assert.equal(failure.code, 'unresolved_atomic_temp_or_orphan');
        assert.notEqual((await recovery.exit).code, 0);
        await removeOwnedWriterTemp(created.root);
        const owner = await recoverFixtureWorkspace({ root: created.root, maxAdditionalBytes });
        await owner.dispose();
        cleanup.forgetRoot(created.root);
        return;
      }

      const recovery = await createFreshRecovery({ root: created.root, maxAdditionalBytes }, cleanup);
      if (recovery.unavailable) {
        subtest.skip(`fresh-process recovery is unavailable: ${recovery.unavailable.code}`);
        return;
      }
      const result = await recovery.waitFor('result');
      if (failurePoint === 'question_target_after_rename_before_readback') {
        assert.equal(result.result.outcome, 'already_migrated_representation');
        assert.equal(result.result.operationProvenance, 'unknown');
      } else {
        assert.equal(result.result.outcome, 'resumed_operation');
      }
      assert.equal((await recovery.exit).code, 0);
      const owner = await recoverFixtureWorkspace({ root: created.root, maxAdditionalBytes });
      await owner.dispose();
      cleanup.forgetRoot(created.root);
    });
  }
});

test('recovery blocks on changed, missing, extra, or nonregular files and permits owner cleanup after restoration', async (t) => {
  const cases = [
    ['same-size anchor change', 'anchor-change'],
    ['same-size instruction change', 'instruction-change'],
    ['extra file', 'extra'],
    ['missing instruction store', 'missing'],
    ['directory in place of instruction store', 'directory'],
  ];
  for (const [name, fault] of cases) {
    await t.test(name, async () => {
      const workspace = await createFixtureWorkspace({
        provider: 'claude', scenario: 'normal', maxAdditionalBytes: maxBudget('claude', 'normal'),
      });
      const instructionPath = path.join(workspace.root, FILE_BASENAMES.instructions);
      const anchorPath = path.join(workspace.root, FILE_BASENAMES.anchor);
      const targetPath = fault === 'anchor-change' ? anchorPath : instructionPath;
      const original = fault === 'anchor-change'
        ? await fs.readFile(anchorPath)
        : await fs.readFile(instructionPath);
      const heldPath = `${instructionPath}.held`;
      const extraPath = path.join(workspace.root, 'unexpected-fixture-file');
      try {
        if (fault.endsWith('-change')) {
          const altered = mutateTrailingNewline(original);
          assert.equal(altered.length, original.length);
          await fs.writeFile(targetPath, altered);
        } else if (fault === 'extra') {
          await fs.writeFile(extraPath, 'owned test fault');
        } else if (fault === 'missing') {
          await fs.rename(instructionPath, heldPath);
        } else {
          await fs.unlink(instructionPath);
          await fs.mkdir(instructionPath);
        }
        assert.equal((await workspace.recover()).status, 'blocked');
        await assert.rejects(workspace.recover(), TypeError);
      } finally {
        if (fault.endsWith('-change')) {
          await fs.writeFile(targetPath, original);
        } else if (fault === 'extra') {
          try { await fs.unlink(extraPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        } else if (fault === 'missing') {
          try { await fs.rename(heldPath, instructionPath); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await fs.writeFile(instructionPath, original);
          }
        } else {
          try { await fs.rmdir(instructionPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await fs.writeFile(instructionPath, original);
        }
        await workspace.dispose();
      }
    });
  }
});

test('recovery rejects an instruction-store symlink when the filesystem permits creating one', async (t) => {
  const workspace = await createFixtureWorkspace({
    provider: 'codex', scenario: 'normal', maxAdditionalBytes: maxBudget('codex', 'normal'),
  });
  const instructionPath = path.join(workspace.root, FILE_BASENAMES.instructions);
  const anchorPath = path.join(workspace.root, FILE_BASENAMES.anchor);
  const original = await fs.readFile(instructionPath);
  let linkCreated = false;
  try {
    await fs.unlink(instructionPath);
    try {
      await fs.symlink(anchorPath, instructionPath, 'file');
      linkCreated = true;
    } catch (error) {
      await fs.writeFile(instructionPath, original);
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
        t.skip(`symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.equal((await workspace.recover()).status, 'blocked');
  } finally {
    if (linkCreated) await fs.unlink(instructionPath);
    try { await fs.lstat(instructionPath); } catch (error) {
      if (error.code === 'ENOENT') await fs.writeFile(instructionPath, original);
      else throw error;
    }
    await workspace.dispose();
  }
});

test('an active workspace cannot be opened a second time in the same process', async () => {
  const maxAdditionalBytes = maxBudget('claude', 'normal');
  const workspace = await createFixtureWorkspace({
    provider: 'claude', scenario: 'normal', maxAdditionalBytes,
  });
  try {
    await assert.rejects(recoverFixtureWorkspace({ root: workspace.root, maxAdditionalBytes }), TypeError);
  } finally {
    await workspace.dispose();
  }
});
