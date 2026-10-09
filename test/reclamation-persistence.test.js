'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createReclamationPersistence } = require('../src/server/reclamation-persistence');
const { loadQuestionWriteIsolationModules } = require('./support/question-write-isolation-loader');

const ANCHOR_NAME = 'question-reclamation-anchor.json';

async function createFixture(t) {
  const temporaryRoot = await fsp.realpath(os.tmpdir());
  const directory = await fsp.mkdtemp(path.join(temporaryRoot, 'reclamation-persistence-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const anchorPath = path.join(directory, ANCHOR_NAME);
  const slotPathsBySlot = {
    questions: path.join(directory, 'questions.store'),
    checkpoint: path.join(directory, 'checkpoint.store'),
    instructions: path.join(directory, 'instructions.store'),
  };
  return { directory, anchorPath, slotPathsBySlot };
}

function persistenceFor(fixture, options = {}) {
  const { anchorPath, slotPathsBySlot } = fixture;
  return createReclamationPersistence({
    anchorPath,
    slotPathsBySlot: options.slotPathsBySlot || { questions: slotPathsBySlot.questions },
    ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
    ...(options.atomicWriteBytes === undefined ? {} : { atomicWriteBytes: options.atomicWriteBytes }),
  });
}

function coded(error, expectedCode) {
  return error && error.code === expectedCode;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fileSystemWith(overrides = {}) {
  return {
    lstat: overrides.lstat || fsp.lstat.bind(fsp),
    open: overrides.open || fsp.open.bind(fsp),
    rename: overrides.rename || fsp.rename.bind(fsp),
    unlink: fsp.unlink.bind(fsp),
  };
}

test('raw slot bytes round-trip without JSON conversion and use bounded reads', async (t) => {
  const fixture = await createFixture(t);
  const sourceBytes = Buffer.from([0x7b, 0x00, 0xff, 0x0a]);
  await fsp.writeFile(fixture.slotPathsBySlot.questions, sourceBytes);
  const persistence = persistenceFor(fixture, {
    slotPathsBySlot: {
      questions: fixture.slotPathsBySlot.questions,
      checkpoint: fixture.slotPathsBySlot.checkpoint,
    },
  });

  assert.deepEqual(persistence.configuredSlots, ['checkpoint', 'questions']);
  assert.equal(Object.isFrozen(persistence.configuredSlots), true);
  assert.equal(await persistence.readAnchorBytes(10), null);
  assert.deepEqual(await persistence.readSlotBytes('questions', sourceBytes.length), sourceBytes);
  await assert.rejects(persistence.readSlotBytes('questions', sourceBytes.length - 1),
    (error) => coded(error, 'reclamation_persistence_size_limit'));

  let toJsonCalls = 0;
  const targetBytes = Uint8Array.from([0x00, 0x22, 0x80, 0xff]);
  Object.defineProperty(targetBytes, 'length', {
    configurable: true,
    get() {
      toJsonCalls += 1;
      throw new Error('length getter must not run');
    },
  });
  Object.defineProperty(targetBytes, 'toJSON', {
    configurable: true,
    get() {
      toJsonCalls += 1;
      throw new Error('toJSON must not run');
    },
  });
  await persistence.writeSlotBytes('questions', targetBytes, 4);
  assert.equal(toJsonCalls, 0);
  assert.deepEqual(await persistence.readSlotBytes('questions', 4),
    Buffer.from([0x00, 0x22, 0x80, 0xff]));
  const anchorBytes = Buffer.from([0x7b, 0x22, 0x72, 0x22, 0x3a, 0x31, 0x7d]);
  await persistence.writeAnchorBytes(anchorBytes, anchorBytes.length);
  assert.deepEqual(await persistence.readAnchorBytes(anchorBytes.length), anchorBytes);
  assert.equal((await fsp.readdir(fixture.directory)).some((name) => name.endsWith('.tmp')), false);
  if (process.platform !== 'win32') {
    assert.equal((await fsp.stat(fixture.slotPathsBySlot.questions)).mode & 0o777, 0o600);
  }
  await persistence.close();
});

test('a bounded read requests at most one byte beyond the configured limit and leaves the file untouched', async (t) => {
  const fixture = await createFixture(t);
  const sourceBytes = Buffer.from([1, 2, 3, 4, 5]);
  await fsp.writeFile(fixture.slotPathsBySlot.questions, sourceBytes);
  const requestedBytes = [];
  const fileSystem = fileSystemWith({
    open: async (...args) => {
      const handle = await fsp.open(...args);
      return {
        stat: (...statArgs) => handle.stat(...statArgs),
        read: (...readArgs) => {
          requestedBytes.push(readArgs[2]);
          return handle.read(...readArgs);
        },
        close: () => handle.close(),
      };
    },
  });
  const persistence = persistenceFor(fixture, { fileSystem });

  await assert.rejects(persistence.readSlotBytes('questions', 4),
    (error) => coded(error, 'reclamation_persistence_size_limit'));
  assert.deepEqual(requestedBytes, [5]);
  assert.deepEqual(await fsp.readFile(fixture.slotPathsBySlot.questions), sourceBytes);
  await persistence.close();
});

test('ENOENT during open, read, or close is not mistaken for an initially missing file', async (t) => {
  const fixture = await createFixture(t);
  const sourceBytes = Buffer.from([5, 6, 7]);
  await fsp.writeFile(fixture.slotPathsBySlot.questions, sourceBytes);
  const missingError = () => Object.assign(new Error('path changed during read'), { code: 'ENOENT' });
  const faults = [
    ['open', fileSystemWith({ open: async () => { throw missingError(); } })],
    ['read', fileSystemWith({
      open: async (...args) => {
        const handle = await fsp.open(...args);
        return {
          stat: () => handle.stat(),
          read: async () => { throw missingError(); },
          close: () => handle.close(),
        };
      },
    })],
    ['close', fileSystemWith({
      open: async (...args) => {
        const handle = await fsp.open(...args);
        return {
          stat: () => handle.stat(),
          read: async (buffer) => ({ bytesRead: 0, buffer }),
          close: async () => {
            await handle.close();
            throw missingError();
          },
        };
      },
    })],
  ];

  for (const [stage, fileSystem] of faults) {
    const persistence = persistenceFor(fixture, { fileSystem });
    await assert.rejects(persistence.readSlotBytes('questions', 10),
      (error) => error.code === 'ENOENT', `${stage} ENOENT must remain an I/O failure`);
    await persistence.close();
  }
  assert.deepEqual(await fsp.readFile(fixture.slotPathsBySlot.questions), sourceBytes);
});

test('invalid slots, aliases, and non-normalized paths are rejected', async (t) => {
  const fixture = await createFixture(t);
  const persistence = persistenceFor(fixture);
  await assert.rejects(persistence.readSlotBytes({ toString() { throw new Error('no coercion'); } }, 1),
    (error) => coded(error, 'reclamation_persistence_slot_not_configured'));
  await assert.rejects(persistence.writeSlotBytes('checkpoint', Buffer.from([1]), 1),
    (error) => coded(error, 'reclamation_persistence_slot_not_configured'));
  assert.equal(persistence.status().writeBlocked, false);
  await persistence.close();

  assert.throws(() => createReclamationPersistence({
    anchorPath: path.join(fixture.directory, 'other-anchor.json'),
    slotPathsBySlot: { questions: fixture.slotPathsBySlot.questions },
  }), (error) => coded(error, 'invalid_reclamation_anchor_path'));
  assert.throws(() => createReclamationPersistence({
    anchorPath: fixture.anchorPath,
    slotPathsBySlot: {
      questions: fixture.slotPathsBySlot.questions,
      checkpoint: fixture.slotPathsBySlot.questions,
    },
  }), (error) => coded(error, 'reclamation_persistence_path_alias'));
  assert.throws(() => createReclamationPersistence({
    anchorPath: fixture.anchorPath,
    slotPathsBySlot: {
      questions: `${fixture.directory}${path.sep}nested${path.sep}..${path.sep}questions.store`,
    },
  }), (error) => coded(error, 'invalid_reclamation_persistence_path'));
  let getterCalls = 0;
  const optionsWithGetter = {
    anchorPath: fixture.anchorPath,
    slotPathsBySlot: { questions: fixture.slotPathsBySlot.questions },
  };
  Object.defineProperty(optionsWithGetter, 'fileSystem', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('filesystem getter must not run');
    },
  });
  assert.throws(() => createReclamationPersistence(optionsWithGetter),
    (error) => coded(error, 'invalid_reclamation_persistence_options'));
  assert.equal(getterCalls, 0);
  if (process.platform === 'win32') {
    assert.throws(() => createReclamationPersistence({
      anchorPath: fixture.anchorPath,
      slotPathsBySlot: {
        questions: fixture.slotPathsBySlot.questions,
        checkpoint: fixture.slotPathsBySlot.questions.toUpperCase(),
      },
    }), (error) => coded(error, 'reclamation_persistence_path_alias'));
  }
});

test('symlinked data paths are rejected', async (t) => {
  const fixture = await createFixture(t);
  const realPath = path.join(fixture.directory, 'real.store');
  const linkPath = fixture.slotPathsBySlot.questions;
  await fsp.writeFile(realPath, Buffer.from([1, 2, 3]));
  try {
    await fsp.symlink(realPath, linkPath);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('file symlinks are unavailable in this environment');
      return;
    }
    throw error;
  }
  const persistence = persistenceFor(fixture);
  await assert.rejects(persistence.readSlotBytes('questions', 10),
    (error) => coded(error, 'reclamation_persistence_symlink'));
  await assert.rejects(persistence.writeSlotBytes('questions', Buffer.from([4]), 10),
    (error) => coded(error, 'reclamation_persistence_symlink'));
  assert.deepEqual(await fsp.readFile(realPath), Buffer.from([1, 2, 3]));
  await persistence.close();
});

test('filesystem metadata identifying a symbolic link is rejected before open or rename', async (t) => {
  const fixture = await createFixture(t);
  const original = Buffer.from([3, 4, 5]);
  await fsp.writeFile(fixture.slotPathsBySlot.questions, original);
  const realLstat = fsp.lstat.bind(fsp);
  const fileSystem = fileSystemWith({
    lstat: async (filePath) => {
      if (filePath === fixture.slotPathsBySlot.questions) {
        return {
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false,
        };
      }
      return realLstat(filePath);
    },
  });
  const persistence = persistenceFor(fixture, { fileSystem });

  await assert.rejects(persistence.readSlotBytes('questions', 10),
    (error) => coded(error, 'reclamation_persistence_symlink'));
  await assert.rejects(persistence.writeSlotBytes('questions', Buffer.from([8]), 10),
    (error) => coded(error, 'reclamation_persistence_symlink'));
  assert.deepEqual(await fsp.readFile(fixture.slotPathsBySlot.questions), original);
  assert.equal(persistence.status().writeBlocked, true);
  await persistence.close();
});

test('same-process path ownership lasts until close drains pending operations', async (t) => {
  const fixture = await createFixture(t);
  await fsp.writeFile(fixture.slotPathsBySlot.questions, Buffer.from([9]));
  const started = deferred();
  const release = deferred();
  let bytesObserved;
  const persistence = persistenceFor(fixture, {
    atomicWriteBytes: async (_targetPath, bytes) => {
      started.resolve();
      await release.promise;
      bytesObserved = Buffer.from(bytes);
    },
  });
  const input = Uint8Array.from([1, 2, 3]);
  const writing = persistence.writeAnchorBytes(input, 10);
  await started.promise;
  input[0] = 99;
  const reading = persistence.readSlotBytes('questions', 10);
  const closing = persistence.close();

  assert.deepEqual(persistence.status(), { closed: true, writeBlocked: false });
  await assert.rejects(persistence.readSlotBytes('questions', 10),
    (error) => coded(error, 'reclamation_persistence_closed'));
  assert.throws(() => persistenceFor(fixture),
    (error) => coded(error, 'reclamation_persistence_path_owned'));

  release.resolve();
  await writing;
  assert.deepEqual(bytesObserved, Buffer.from([1, 2, 3]));
  assert.deepEqual(await reading, Buffer.from([9]));
  await closing;

  const replacement = persistenceFor(fixture);
  await replacement.close();
});

test('a failed write blocks later writes while reads remain available', async (t) => {
  const fixture = await createFixture(t);
  const originalAnchor = Buffer.from('original-anchor');
  const originalSlot = Buffer.from([0, 0xff, 2]);
  await fsp.writeFile(fixture.anchorPath, originalAnchor);
  await fsp.writeFile(fixture.slotPathsBySlot.questions, originalSlot);
  let attempts = 0;
  const persistence = persistenceFor(fixture, {
    atomicWriteBytes: async () => {
      attempts += 1;
      throw Object.assign(new Error('write failed'), { code: 'ENOSPC' });
    },
  });

  await assert.rejects(persistence.writeAnchorBytes(Buffer.from('replacement'), 100),
    (error) => error.code === 'ENOSPC');
  assert.deepEqual(persistence.status(), { closed: false, writeBlocked: true });
  await assert.rejects(persistence.writeSlotBytes('questions', Buffer.from([8]), 10),
    (error) => coded(error, 'reclamation_persistence_write_blocked'));
  assert.equal(attempts, 1);
  assert.deepEqual(await persistence.readSlotBytes('questions', 10), originalSlot);
  assert.deepEqual(await fsp.readFile(fixture.anchorPath), originalAnchor);
  assert.deepEqual(await fsp.readFile(fixture.slotPathsBySlot.questions), originalSlot);
  await persistence.close();
});

test('an error before temporary creation preserves existing anchor and source files', async (t) => {
  const fixture = await createFixture(t);
  const originalAnchor = Buffer.from('anchor-before-write');
  const originalSource = Buffer.from('source-before-write');
  await fsp.writeFile(fixture.anchorPath, originalAnchor);
  await fsp.writeFile(fixture.slotPathsBySlot.questions, originalSource);
  const fileSystem = fileSystemWith({
    open: async (filePath, flags, mode) => {
      if (flags === 'wx') throw Object.assign(new Error('temporary creation failed'), { code: 'EIO' });
      return fsp.open(filePath, flags, mode);
    },
  });
  const persistence = persistenceFor(fixture, { fileSystem });

  await assert.rejects(persistence.writeAnchorBytes(Buffer.from('replacement'), 100),
    (error) => error.code === 'EIO');
  assert.equal(persistence.status().writeBlocked, true);
  assert.deepEqual(await fsp.readFile(fixture.anchorPath), originalAnchor);
  assert.deepEqual(await fsp.readFile(fixture.slotPathsBySlot.questions), originalSource);
  assert.equal((await fsp.readdir(fixture.directory)).some((name) => name.endsWith('.tmp')), false);
  await persistence.close();
});

test('ENOSPC while writing a temporary file cleans only the temporary file', async (t) => {
  const fixture = await createFixture(t);
  const originalAnchor = Buffer.from('anchor-before-write');
  const originalSource = Buffer.from('source-before-write');
  await fsp.writeFile(fixture.anchorPath, originalAnchor);
  await fsp.writeFile(fixture.slotPathsBySlot.questions, originalSource);
  const fileSystem = fileSystemWith({
    open: async (filePath, flags, mode) => {
      const handle = await fsp.open(filePath, flags, mode);
      if (flags !== 'wx') return handle;
      return {
        writeFile: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
        close: () => handle.close(),
      };
    },
  });
  const persistence = persistenceFor(fixture, { fileSystem });

  await assert.rejects(persistence.writeAnchorBytes(Buffer.from('replacement'), 100),
    (error) => error.code === 'ENOSPC');
  assert.equal(persistence.status().writeBlocked, true);
  assert.deepEqual(await fsp.readFile(fixture.anchorPath), originalAnchor);
  assert.deepEqual(await fsp.readFile(fixture.slotPathsBySlot.questions), originalSource);
  assert.equal((await fsp.readdir(fixture.directory)).some((name) => name.endsWith('.tmp')), false);
  await persistence.close();
});

test('a transient EPERM rename retries and leaves the writer usable', async (t) => {
  const fixture = await createFixture(t);
  const originalSource = Buffer.from('source-before-write');
  const replacement = Buffer.from([0x00, 0xff, 0x7b]);
  await fsp.writeFile(fixture.anchorPath, Buffer.from('anchor-before-write'));
  await fsp.writeFile(fixture.slotPathsBySlot.questions, originalSource);
  let renameCalls = 0;
  const fileSystem = fileSystemWith({
    rename: async (temporaryPath, targetPath) => {
      renameCalls += 1;
      if (renameCalls === 1) throw Object.assign(new Error('target is temporarily busy'), { code: 'EPERM' });
      return fsp.rename(temporaryPath, targetPath);
    },
  });
  const persistence = persistenceFor(fixture, { fileSystem });

  await persistence.writeAnchorBytes(replacement, 100);
  assert.equal(renameCalls, 2);
  assert.deepEqual(persistence.status(), { closed: false, writeBlocked: false });
  assert.deepEqual(await persistence.readAnchorBytes(100), replacement);
  assert.deepEqual(await fsp.readFile(fixture.slotPathsBySlot.questions), originalSource);
  assert.equal((await fsp.readdir(fixture.directory)).some((name) => name.endsWith('.tmp')), false);
  await persistence.close();
});

test('rename retry exhaustion keeps the old target and blocks later writes', async (t) => {
  const fixture = await createFixture(t);
  const originalAnchor = Buffer.from('anchor-before-write');
  const originalSource = Buffer.from('source-before-write');
  await fsp.writeFile(fixture.anchorPath, originalAnchor);
  await fsp.writeFile(fixture.slotPathsBySlot.questions, originalSource);
  let renameCalls = 0;
  const fileSystem = fileSystemWith({
    rename: async () => {
      renameCalls += 1;
      throw Object.assign(new Error('target remains busy'), { code: 'EPERM' });
    },
  });
  const persistence = persistenceFor(fixture, { fileSystem });

  await assert.rejects(persistence.writeAnchorBytes(Buffer.from('replacement'), 100),
    (error) => error.code === 'EPERM');
  assert.equal(renameCalls, 4);
  assert.deepEqual(persistence.status(), { closed: false, writeBlocked: true });
  await assert.rejects(persistence.writeAnchorBytes(Buffer.from('second'), 100),
    (error) => coded(error, 'reclamation_persistence_write_blocked'));
  assert.equal(renameCalls, 4);
  assert.deepEqual(await fsp.readFile(fixture.anchorPath), originalAnchor);
  assert.deepEqual(await fsp.readFile(fixture.slotPathsBySlot.questions), originalSource);
  assert.equal((await fsp.readdir(fixture.directory)).some((name) => name.endsWith('.tmp')), false);
  await persistence.close();
});

test('a temporary-file close failure remains sticky and cleans only the temporary file', async (t) => {
  const fixture = await createFixture(t);
  const originalAnchor = Buffer.from('anchor-before-write');
  const originalSource = Buffer.from('source-before-write');
  await fsp.writeFile(fixture.anchorPath, originalAnchor);
  await fsp.writeFile(fixture.slotPathsBySlot.questions, originalSource);
  const fileSystem = fileSystemWith({
    open: async (...args) => {
      const handle = await fsp.open(...args);
      if (args[1] !== 'wx') return handle;
      let isClosed = false;
      return {
        writeFile: (bytes) => handle.writeFile(bytes),
        close: async () => {
          if (!isClosed) {
            isClosed = true;
            await handle.close();
          }
          throw Object.assign(new Error('close result is uncertain'), { code: 'EIO' });
        },
      };
    },
  });
  const persistence = persistenceFor(fixture, { fileSystem });

  await assert.rejects(persistence.writeAnchorBytes(Buffer.from('replacement'), 100),
    (error) => error.code === 'EIO');
  assert.deepEqual(persistence.status(), { closed: false, writeBlocked: true });
  assert.deepEqual(await fsp.readFile(fixture.anchorPath), originalAnchor);
  assert.deepEqual(await fsp.readFile(fixture.slotPathsBySlot.questions), originalSource);
  assert.equal((await fsp.readdir(fixture.directory)).some((name) => name.endsWith('.tmp')), false);
  await persistence.close();
});

test('an error reported after rename remains a failed and blocked write without deleting source files', async (t) => {
  const fixture = await createFixture(t);
  const originalSource = Buffer.from('source-before-write');
  const replacement = Buffer.from([0x00, 0xff, 0x7b]);
  await fsp.writeFile(fixture.anchorPath, Buffer.from('anchor-before-write'));
  await fsp.writeFile(fixture.slotPathsBySlot.questions, originalSource);
  let renameCalls = 0;
  const fileSystem = fileSystemWith({
    rename: async (temporaryPath, targetPath) => {
      renameCalls += 1;
      await fsp.rename(temporaryPath, targetPath);
      throw Object.assign(new Error('rename result is uncertain'), { code: 'EIO' });
    },
  });
  const persistence = persistenceFor(fixture, { fileSystem });

  await assert.rejects(persistence.writeAnchorBytes(replacement, 100),
    (error) => error.code === 'EIO');
  assert.equal(renameCalls, 1);
  assert.equal(persistence.status().writeBlocked, true);
  assert.deepEqual(await fsp.readFile(fixture.anchorPath), replacement);
  assert.deepEqual(await fsp.readFile(fixture.slotPathsBySlot.questions), originalSource);
  assert.equal((await fsp.readdir(fixture.directory)).some((name) => name.endsWith('.tmp')), false);
  await persistence.close();
});

for (const phase of ['before', 'after']) {
  test(`a default questions rename retry exhaustion in the ${phase} phase can be consumed once`, async (t) => {
    const fixture = await createFixture(t);
    const modules = loadQuestionWriteIsolationModules();
    const original = Buffer.from('questions-before-write');
    const replacement = Buffer.from('questions-after-write');
    const checkpointPath = fixture.slotPathsBySlot.checkpoint;
    await fsp.writeFile(fixture.slotPathsBySlot.questions, original);
    const persistence = modules.persistence.createReclamationPersistence({
      anchorPath: fixture.anchorPath,
      slotPathsBySlot: {
        questions: fixture.slotPathsBySlot.questions,
        checkpoint: checkpointPath,
      },
    });
    const error = Object.assign(new Error('rename stayed busy'), { code: 'EPERM' });
    modules.nativeFileSystem.armRenameRetryExhaustion({
      targetPath: fixture.slotPathsBySlot.questions,
      phase,
      error,
    });

    await assert.rejects(persistence.writeSlotBytes('questions', replacement, 100),
      (caught) => caught === error);
    assert.equal(modules.nativeFileSystem.renameCalls(fixture.slotPathsBySlot.questions), 4);
    assert.equal(modules.nativeFileSystem.cleanupCalls(fixture.slotPathsBySlot.questions), 1);
    assert.equal(modules.nativeFileSystem.events.some((event) =>
      event.operation === (phase === 'before' ? 'unlink-removed' : 'unlink-missing')), true);
    assert.deepEqual(await fsp.readFile(fixture.slotPathsBySlot.questions),
      phase === 'before' ? original : replacement);

    await persistence.readSlotBytes('questions', 100);
    await assert.rejects(persistence.writeSlotBytes('checkpoint', Buffer.from('blocked'), 100),
      (caught) => caught.code === 'reclamation_persistence_question_failure_pending');
    assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure({}, error, replacement), false);
    assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(persistence, error,
      Buffer.from('different bytes')), false);
    assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(persistence, error, replacement), true);
    assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(persistence, error, replacement), false);
    await assert.rejects(persistence.writeSlotBytes('questions', Buffer.from('later'), 100),
      (caught) => caught.code === 'reclamation_persistence_question_write_blocked');
    await persistence.writeSlotBytes('checkpoint', Buffer.from('non-question write'), 100);
    assert.deepEqual(persistence.status(), { closed: false, writeBlocked: false });
    assert.equal((await fsp.readdir(fixture.directory)).some((name) => name.endsWith('.tmp')), false);
    await persistence.close();
  });
}

test('qualified question rename provenance is discarded on close and cannot be reused by another instance', async (t) => {
  const firstFixture = await createFixture(t);
  const secondFixture = await createFixture(t);
  const modules = loadQuestionWriteIsolationModules();
  const bytes = Buffer.from('same candidate');
  const error = Object.assign(new Error('rename stayed busy'), { code: 'EBUSY' });
  await fsp.writeFile(firstFixture.slotPathsBySlot.questions, Buffer.from('first source'));
  await fsp.writeFile(secondFixture.slotPathsBySlot.questions, Buffer.from('second source'));
  const first = modules.persistence.createReclamationPersistence({
    anchorPath: firstFixture.anchorPath,
    slotPathsBySlot: {
      questions: firstFixture.slotPathsBySlot.questions,
      checkpoint: firstFixture.slotPathsBySlot.checkpoint,
    },
  });
  const second = modules.persistence.createReclamationPersistence({
    anchorPath: secondFixture.anchorPath,
    slotPathsBySlot: { questions: secondFixture.slotPathsBySlot.questions },
  });
  modules.nativeFileSystem.armRenameRetryExhaustion({
    targetPath: firstFixture.slotPathsBySlot.questions,
    code: 'EBUSY',
    error,
  });
  await assert.rejects(first.writeSlotBytes('questions', bytes, 100), (caught) => caught === error);
  assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(second, error, bytes), false);
  await first.close();
  assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(first, error, bytes), false);

  modules.nativeFileSystem.armRenameRetryExhaustion({
    targetPath: secondFixture.slotPathsBySlot.questions,
    code: 'EBUSY',
    error,
  });
  await assert.rejects(second.writeSlotBytes('questions', bytes, 100), (caught) => caught === error);
  assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(second, error, bytes), false);
  assert.deepEqual(second.status(), { closed: false, writeBlocked: true });
  assert.deepEqual(await fsp.readFile(secondFixture.slotPathsBySlot.questions), Buffer.from('second source'));
  await second.close();
});

test('reusing a default rename error invalidates outstanding provenance across persistence instances', async (t) => {
  const firstFixture = await createFixture(t);
  const secondFixture = await createFixture(t);
  const modules = loadQuestionWriteIsolationModules();
  const bytes = Buffer.from('same candidate');
  const error = Object.assign(new Error('rename stayed busy'), { code: 'EPERM' });
  await fsp.writeFile(firstFixture.slotPathsBySlot.questions, Buffer.from('first source'));
  await fsp.writeFile(secondFixture.slotPathsBySlot.questions, Buffer.from('second source'));
  const first = modules.persistence.createReclamationPersistence({
    anchorPath: firstFixture.anchorPath,
    slotPathsBySlot: {
      questions: firstFixture.slotPathsBySlot.questions,
      checkpoint: firstFixture.slotPathsBySlot.checkpoint,
    },
  });
  const second = modules.persistence.createReclamationPersistence({
    anchorPath: secondFixture.anchorPath,
    slotPathsBySlot: { questions: secondFixture.slotPathsBySlot.questions },
  });

  modules.nativeFileSystem.armRenameRetryExhaustion({
    targetPath: firstFixture.slotPathsBySlot.questions,
    error,
  });
  await assert.rejects(first.writeSlotBytes('questions', bytes, 100), (caught) => caught === error);
  modules.nativeFileSystem.armRenameRetryExhaustion({
    targetPath: secondFixture.slotPathsBySlot.questions,
    error,
  });
  await assert.rejects(second.writeSlotBytes('questions', bytes, 100), (caught) => caught === error);

  assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(first, error, bytes), false);
  assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(second, error, bytes), false);
  await assert.rejects(first.writeSlotBytes('checkpoint', bytes, 100),
    (caught) => caught.code === 'reclamation_persistence_question_failure_pending');
  assert.deepEqual(second.status(), { closed: false, writeBlocked: true });
  assert.deepEqual(await fsp.readFile(firstFixture.slotPathsBySlot.questions), Buffer.from('first source'));
  assert.deepEqual(await fsp.readFile(secondFixture.slotPathsBySlot.questions), Buffer.from('second source'));
  await Promise.all([first.close(), second.close()]);
});

test('custom persistence options and uncertain cleanup cannot create local question provenance', async (t) => {
  const fixture = await createFixture(t);
  const modules = loadQuestionWriteIsolationModules();
  const bytes = Buffer.from('candidate');
  const error = Object.assign(new Error('rename stayed busy'), { code: 'EPERM' });
  await fsp.writeFile(fixture.slotPathsBySlot.questions, Buffer.from('source'));
  const persistence = modules.persistence.createReclamationPersistence({
    anchorPath: fixture.anchorPath,
    slotPathsBySlot: { questions: fixture.slotPathsBySlot.questions },
    atomicWriteBytes: undefined,
  });
  modules.nativeFileSystem.armRenameRetryExhaustion({
    targetPath: fixture.slotPathsBySlot.questions,
    error,
  });
  await assert.rejects(persistence.writeSlotBytes('questions', bytes, 100), (caught) => caught === error);
  assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(persistence, error, bytes), false);
  assert.deepEqual(persistence.status(), { closed: false, writeBlocked: true });
  await persistence.close();

  const fileSystemFixture = await createFixture(t);
  await fsp.writeFile(fileSystemFixture.slotPathsBySlot.questions, Buffer.from('source'));
  const fileSystemError = Object.assign(new Error('rename stayed busy'), { code: 'EPERM' });
  const fileSystemPersistence = modules.persistence.createReclamationPersistence({
    anchorPath: fileSystemFixture.anchorPath,
    slotPathsBySlot: { questions: fileSystemFixture.slotPathsBySlot.questions },
    fileSystem: modules.nativeFileSystem.fileSystem,
  });
  modules.nativeFileSystem.armRenameRetryExhaustion({
    targetPath: fileSystemFixture.slotPathsBySlot.questions,
    error: fileSystemError,
  });
  await assert.rejects(fileSystemPersistence.writeSlotBytes('questions', bytes, 100),
    (caught) => caught === fileSystemError);
  assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(
    fileSystemPersistence, fileSystemError, bytes), false);
  assert.deepEqual(fileSystemPersistence.status(), { closed: false, writeBlocked: true });
  await fileSystemPersistence.close();

  const checkpointFixture = await createFixture(t);
  await fsp.writeFile(checkpointFixture.slotPathsBySlot.questions, Buffer.from('question source'));
  const checkpointError = Object.assign(new Error('checkpoint rename stayed busy'), { code: 'EBUSY' });
  const checkpointPersistence = modules.persistence.createReclamationPersistence({
    anchorPath: checkpointFixture.anchorPath,
    slotPathsBySlot: {
      questions: checkpointFixture.slotPathsBySlot.questions,
      checkpoint: checkpointFixture.slotPathsBySlot.checkpoint,
    },
  });
  modules.nativeFileSystem.armRenameRetryExhaustion({
    targetPath: checkpointFixture.slotPathsBySlot.checkpoint,
    code: 'EBUSY',
    error: checkpointError,
  });
  await assert.rejects(checkpointPersistence.writeSlotBytes('checkpoint', bytes, 100),
    (caught) => caught === checkpointError);
  assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(
    checkpointPersistence, checkpointError, bytes), false);
  assert.deepEqual(checkpointPersistence.status(), { closed: false, writeBlocked: true });
  assert.deepEqual(await fsp.readFile(checkpointFixture.slotPathsBySlot.questions), Buffer.from('question source'));
  await checkpointPersistence.close();

  const cleanupFixture = await createFixture(t);
  await fsp.writeFile(cleanupFixture.slotPathsBySlot.questions, Buffer.from('source'));
  const cleanupError = Object.assign(new Error('rename stayed busy'), { code: 'EPERM' });
  const cleanupPersistence = modules.persistence.createReclamationPersistence({
    anchorPath: cleanupFixture.anchorPath,
    slotPathsBySlot: { questions: cleanupFixture.slotPathsBySlot.questions },
  });
  modules.nativeFileSystem.armRenameRetryExhaustion({
    targetPath: cleanupFixture.slotPathsBySlot.questions,
    error: cleanupError,
    cleanupFailure: true,
  });
  await assert.rejects(cleanupPersistence.writeSlotBytes('questions', bytes, 100),
    (caught) => caught === cleanupError);
  assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(cleanupPersistence, cleanupError, bytes), false);
  assert.deepEqual(cleanupPersistence.status(), { closed: false, writeBlocked: true });
  assert.equal((await fsp.readdir(cleanupFixture.directory)).some((name) => name.endsWith('.tmp')), true);
  await modules.nativeFileSystem.removeTemporaryFiles(cleanupFixture.directory);
  await cleanupPersistence.close();
});

test('a question failure arriving after close begins is globally blocked without provenance', async (t) => {
  const fixture = await createFixture(t);
  const modules = loadQuestionWriteIsolationModules();
  const error = Object.assign(new Error('rename stayed busy'), { code: 'EPERM' });
  const original = Buffer.from('before close');
  await fsp.writeFile(fixture.slotPathsBySlot.questions, original);
  const persistence = modules.persistence.createReclamationPersistence({
    anchorPath: fixture.anchorPath,
    slotPathsBySlot: { questions: fixture.slotPathsBySlot.questions },
  });
  const barrier = modules.nativeFileSystem.armRenameRetryExhaustion({
    targetPath: fixture.slotPathsBySlot.questions,
    error,
    hold: true,
  });
  const write = persistence.writeSlotBytes('questions', Buffer.from('replacement'), 100);
  await barrier.entered;
  const closing = persistence.close();
  barrier.release();
  await assert.rejects(write, (caught) => caught === error);
  await closing;

  assert.equal(modules.persistence.consumeBoundedQuestionWriteFailure(
    persistence, error, Buffer.from('replacement')), false);
  assert.deepEqual(persistence.status(), { closed: true, writeBlocked: true });
  assert.deepEqual(await fsp.readFile(fixture.slotPathsBySlot.questions), original);
  assert.equal((await fsp.readdir(fixture.directory)).some((name) => name.endsWith('.tmp')), false);
});

test('the isolated loader leaves global module cache and native filesystem references unchanged', () => {
  const persistencePath = require.resolve('../src/server/reclamation-persistence');
  const cachedPersistence = require.cache[persistencePath];
  const nativeRename = fsp.rename;
  const isolated = loadQuestionWriteIsolationModules();

  assert.equal(typeof isolated.persistence.consumeBoundedQuestionWriteFailure, 'function');
  assert.equal(require.cache[persistencePath], cachedPersistence);
  assert.equal(fsp.rename, nativeRename);
});
