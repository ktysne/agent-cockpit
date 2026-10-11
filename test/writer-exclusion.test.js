const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  acquireWriterExclusionSet,
  prepareWriterExclusionFiles,
} = require('../src/server/writer-exclusion');
const { startWriterExclusionChild } = require('./support/writer-exclusion-process');

function temporaryRoot(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-exclusion-'));
  context.after(() => removeTemporaryRoot(root));
  return root;
}

function removeTemporaryRoot(root) {
  const resolvedRoot = path.resolve(root);
  const relativeRoot = path.relative(path.resolve(os.tmpdir()), resolvedRoot);
  assert.equal(root, resolvedRoot);
  assert.ok(relativeRoot && relativeRoot !== '..' && !relativeRoot.startsWith(`..${path.sep}`));
  fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function temporaryProcessRoot(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-exclusion-process-'));
  const children = [];
  context.after(async () => {
    await Promise.all(children.map((child) => child.stop()));
    for (const child of children) {
      if (child.spawnFailed) continue;
      await Promise.all([child.waitForExit(), child.waitForClose()]);
    }
    removeTemporaryRoot(root);
  });
  return { root, children };
}

function markerPath(root, slot) {
  return path.join(root, `${slot}.json.writer-exclusion`);
}

function captureThrow(callback) {
  try {
    callback();
  } catch (reason) {
    return { threw: true, reason };
  }
  return { threw: false };
}

async function captureRejection(promise) {
  return promise.then(
    () => ({ rejected: false }),
    (reason) => ({ rejected: true, reason }),
  );
}

function assertBusy(callback) {
  assert.throws(callback, (error) => error && error.code === 'ERR_WRITER_EXCLUSION_BUSY');
}

test('preparation fixes the slot set and does not read or write source files', async (context) => {
  const root = temporaryRoot(context);
  const sourcePath = path.join(root, 'anchor.json');
  fs.writeFileSync(sourcePath, 'source sentinel');
  const readFileSync = fs.readFileSync;
  const openSync = fs.openSync;
  const readAttempts = [];
  const openedPaths = [];
  context.mock.method(fs, 'readFileSync', (file, ...args) => {
    readAttempts.push(file);
    throw new Error('source reads are outside the primitive');
  });
  context.mock.method(fs, 'openSync', (file, ...args) => {
    openedPaths.push(file);
    return openSync(file, ...args);
  });

  const prepared = prepareWriterExclusionFiles(root, ['questions', 'anchor', 'checkpoint']);
  assert.equal(Object.isFrozen(prepared), true);
  assert.deepEqual(Object.keys(prepared), []);
  assert.throws(() => acquireWriterExclusionSet({ ...prepared }, () => Promise.resolve()), TypeError);
  assert.throws(() => acquireWriterExclusionSet(prepared, null), TypeError);
  assert.deepEqual(openedPaths, []);
  const owner = acquireWriterExclusionSet(prepared, () => Promise.resolve());
  assert.deepEqual(Object.keys(owner), ['close']);
  assert.equal(Object.isFrozen(owner), true);
  const owners = ['anchor', 'checkpoint', 'questions'].map((slot) =>
    JSON.parse(readFileSync(markerPath(root, slot), 'utf8')).owner,
  );
  assert.equal(new Set(owners).size, 1);
  assert.equal(readFileSync(sourcePath, 'utf8'), 'source sentinel');
  assert.deepEqual(readAttempts, []);
  assert.deepEqual(openedPaths, [
    markerPath(root, 'anchor'),
    markerPath(root, 'checkpoint'),
    markerPath(root, 'questions'),
  ]);
  await owner.close();
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), false);
});

test('preparation rejects unsupported, duplicate, and missing-root inputs before acquisition', (context) => {
  const root = temporaryRoot(context);
  assert.throws(() => prepareWriterExclusionFiles(root, ['anchor', 'anchor']), /unique/);
  assert.throws(() => prepareWriterExclusionFiles(root, ['../questions']), /not supported/);
  assert.throws(() => prepareWriterExclusionFiles(root, []), /non-empty/);
  assert.throws(() => prepareWriterExclusionFiles(path.join(root, 'missing'), ['anchor']));
  assert.equal(fs.existsSync(path.join(root, 'missing')), false);
});

test('partial acquisition rolls back only its own markers in reverse order', (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor', 'checkpoint', 'instructions']);
  const foreign = Buffer.from('foreign partial marker');
  fs.writeFileSync(markerPath(root, 'instructions'), foreign, { flag: 'wx' });
  const unlinkSync = fs.unlinkSync;
  const unlinked = [];
  context.mock.method(fs, 'unlinkSync', (file) => {
    unlinked.push(file);
    return unlinkSync(file);
  });

  const thrown = captureThrow(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
  assert.equal(thrown.threw, true);
  assert.equal(thrown.reason.code, 'EEXIST');
  assert.deepEqual(unlinked, [markerPath(root, 'checkpoint'), markerPath(root, 'anchor')]);
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), false);
  assert.equal(fs.existsSync(markerPath(root, 'checkpoint')), false);
  assert.deepEqual(fs.readFileSync(markerPath(root, 'instructions')), foreign);
});

test('metadata failure retains a falsy primary reason and rollback failure', (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor']);
  context.mock.method(fs, 'writeSync', () => {
    throw false;
  });
  context.mock.method(fs, 'unlinkSync', () => {
    throw '';
  });

  const thrown = captureThrow(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
  assert.equal(thrown.threw, true);
  assert.ok(thrown.reason instanceof AggregateError);
  assert.deepEqual(thrown.reason.errors, [false, '']);
  assert.equal(thrown.reason.cause, false);
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), true);
  assertBusy(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
});

test('metadata write preserves every falsy thrown reason when rollback succeeds', (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor']);
  const reasons = [undefined, null, false, 0, ''];
  let nextReason;
  context.mock.method(fs, 'writeSync', () => {
    throw nextReason;
  });

  for (const reason of reasons) {
    nextReason = reason;
    const thrown = captureThrow(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
    assert.equal(thrown.threw, true);
    assert.strictEqual(thrown.reason, reason);
    assert.equal(fs.existsSync(markerPath(root, 'anchor')), false);
  }
});

test('an invalid open result with a created marker holds every process reservation', (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor', 'checkpoint']);
  const openSync = fs.openSync;
  const closeSync = fs.closeSync;
  context.mock.method(fs, 'openSync', (file, flags, mode) => {
    const fd = openSync(file, flags, mode);
    closeSync(fd);
    return false;
  });

  const thrown = captureThrow(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
  assert.equal(thrown.threw, true);
  assert.ok(thrown.reason instanceof AggregateError);
  assert.match(thrown.reason.message, /reservations are retained/);
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), true);
  assert.equal(fs.existsSync(markerPath(root, 'checkpoint')), false);
  assertBusy(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
});

test('short writes continue to completion and descriptor zero is valid', async (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor']);
  const openSync = fs.openSync;
  const writeSync = fs.writeSync;
  const closeSync = fs.closeSync;
  let realFd;
  let writes = 0;
  let closes = 0;
  context.mock.method(fs, 'openSync', (file, flags, mode) => {
    realFd = openSync(file, flags, mode);
    return 0;
  });
  context.mock.method(fs, 'writeSync', (fd, buffer, offset, length, position) => {
    assert.equal(fd, 0);
    writes += 1;
    return writeSync(realFd, buffer, offset, Math.min(2, length), position);
  });
  context.mock.method(fs, 'closeSync', (fd) => {
    assert.equal(fd, 0);
    closes += 1;
    return closeSync(realFd);
  });

  const owner = acquireWriterExclusionSet(prepared, () => Promise.resolve());
  assert.ok(writes > 1);
  assert.equal(closes, 1);
  const metadata = JSON.parse(fs.readFileSync(markerPath(root, 'anchor'), 'utf8'));
  assert.equal(metadata.version, 1);
  assert.equal(typeof metadata.owner, 'string');
  await owner.close();
});

test('zero write progress fails and rolls back the known closed marker', async (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor']);
  const writeSync = fs.writeSync;
  const closeSync = fs.closeSync;
  const unlinkSync = fs.unlinkSync;
  let closeCalls = 0;
  let unlinkCalls = 0;
  let returnZero = true;
  context.mock.method(fs, 'writeSync', (fd, ...args) => {
    if (returnZero) {
      returnZero = false;
      return 0;
    }
    return writeSync(fd, ...args);
  });
  context.mock.method(fs, 'closeSync', (fd) => {
    closeCalls += 1;
    return closeSync(fd);
  });
  context.mock.method(fs, 'unlinkSync', (file) => {
    unlinkCalls += 1;
    return unlinkSync(file);
  });

  const thrown = captureThrow(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
  assert.equal(thrown.threw, true);
  assert.ok(thrown.reason instanceof TypeError);
  assert.equal(closeCalls, 1);
  assert.equal(unlinkCalls, 1);
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), false);
  const owner = acquireWriterExclusionSet(prepared, () => Promise.resolve());
  await owner.close();
});

test('unknown descriptor close is attempted once and its marker is not unlinked', (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor']);
  const closeSync = fs.closeSync;
  const unlinkSync = fs.unlinkSync;
  let closeCalls = 0;
  let unlinkCalls = 0;
  context.mock.method(fs, 'closeSync', (fd) => {
    closeCalls += 1;
    closeSync(fd);
    return false;
  });
  context.mock.method(fs, 'unlinkSync', (file) => {
    unlinkCalls += 1;
    return unlinkSync(file);
  });

  const thrown = captureThrow(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
  assert.equal(thrown.threw, true);
  assert.ok(thrown.reason instanceof AggregateError);
  assert.equal(thrown.reason.cause instanceof TypeError, true);
  assert.equal(closeCalls, 1);
  assert.equal(unlinkCalls, 0);
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), true);
  assertBusy(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
});

test('a falsy close throw remains the acquisition cause and prevents unlink', (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor']);
  const closeSync = fs.closeSync;
  let unlinkCalls = 0;
  context.mock.method(fs, 'closeSync', (fd) => {
    closeSync(fd);
    throw false;
  });
  context.mock.method(fs, 'unlinkSync', () => {
    unlinkCalls += 1;
  });

  const thrown = captureThrow(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
  assert.equal(thrown.threw, true);
  assert.ok(thrown.reason instanceof AggregateError);
  assert.deepEqual(thrown.reason.errors, [false]);
  assert.equal(thrown.reason.cause, false);
  assert.equal(unlinkCalls, 0);
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), true);
});

test('close stores one promise before quiesce and preserves a falsy rejection without unlinking', async (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor']);
  let rejectBarrier;
  let quiesceCalls = 0;
  let unlinkCalls = 0;
  const barrier = new Promise((resolve, reject) => {
    rejectBarrier = reject;
  });
  const unlinkSync = fs.unlinkSync;
  context.mock.method(fs, 'unlinkSync', (file) => {
    unlinkCalls += 1;
    return unlinkSync(file);
  });

  const owner = acquireWriterExclusionSet(prepared, () => {
    quiesceCalls += 1;
    return barrier;
  });
  const first = owner.close();
  const firstResult = captureRejection(first);
  assert.equal(owner.close(), first);
  assert.equal(quiesceCalls, 1);
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), true);
  rejectBarrier(0);
  const result = await firstResult;
  assert.deepEqual(result, { rejected: true, reason: 0 });
  assert.equal(unlinkCalls, 0);
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), true);
  assert.equal(owner.close(), first);
  assertBusy(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
});

test('sync and async quiesce failures preserve all falsy reasons', async (context) => {
  const root = temporaryRoot(context);
  const reasons = [undefined, null, false, 0, ''];

  for (let index = 0; index < reasons.length; index += 1) {
    const directory = path.join(root, `case-${index}`);
    fs.mkdirSync(directory);
    const prepared = prepareWriterExclusionFiles(directory, ['anchor']);
    const reason = reasons[index];
    const owner = acquireWriterExclusionSet(prepared, () => {
      if (index % 2 === 0) throw reason;
      return Promise.reject(reason);
    });
    const closePromise = owner.close();
    const result = await captureRejection(closePromise);
    assert.equal(result.rejected, true);
    assert.strictEqual(result.reason, reason);
    assert.equal(owner.close(), closePromise);
    assert.equal(fs.existsSync(markerPath(directory, 'anchor')), true);
  }
});

test('close rejects direct self-wait without releasing its marker', async (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor']);
  let owner;
  owner = acquireWriterExclusionSet(prepared, () => owner.close());
  const promise = owner.close();
  const result = await captureRejection(promise);
  assert.equal(result.rejected, true);
  assert.match(result.reason.message, /own close promise/);
  assert.equal(owner.close(), promise);
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), true);
  assertBusy(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
});

test('release attempts every marker once in reverse order and holds reservations on failure', async (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor', 'checkpoint', 'questions']);
  const unlinkSync = fs.unlinkSync;
  const unlinked = [];
  context.mock.method(fs, 'unlinkSync', (file) => {
    unlinked.push(file);
    if (file === markerPath(root, 'questions')) throw false;
    return unlinkSync(file);
  });

  const owner = acquireWriterExclusionSet(prepared, () => Promise.resolve());
  const closePromise = owner.close();
  const result = await captureRejection(closePromise);
  assert.equal(result.rejected, true);
  assert.ok(result.reason instanceof AggregateError);
  assert.deepEqual(result.reason.errors, [false]);
  assert.equal(result.reason.cause, false);
  assert.deepEqual(unlinked, [
    markerPath(root, 'questions'),
    markerPath(root, 'checkpoint'),
    markerPath(root, 'anchor'),
  ]);
  assert.equal(owner.close(), closePromise);
  assert.equal(unlinked.length, 3);
  assertBusy(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
});

test('an unlink result after its side effect is unknown and is never retried', async (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor']);
  const unlinkSync = fs.unlinkSync;
  let unlinkCalls = 0;
  context.mock.method(fs, 'unlinkSync', (file) => {
    unlinkCalls += 1;
    unlinkSync(file);
    return false;
  });

  const owner = acquireWriterExclusionSet(prepared, () => Promise.resolve());
  const closePromise = owner.close();
  const result = await captureRejection(closePromise);
  assert.equal(result.rejected, true);
  assert.equal(result.reason.errors[0] instanceof TypeError, true);
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), false);
  assert.equal(owner.close(), closePromise);
  assert.equal(unlinkCalls, 1);
  assertBusy(() => acquireWriterExclusionSet(prepared, () => Promise.resolve()));
});

test('normal close permits a new owner and an old close leaves its marker untouched', async (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor']);
  const unlinkSync = fs.unlinkSync;
  let unlinkCalls = 0;
  context.mock.method(fs, 'unlinkSync', (file) => {
    unlinkCalls += 1;
    return unlinkSync(file);
  });

  const oldOwner = acquireWriterExclusionSet(prepared, () => Promise.resolve());
  const oldClose = oldOwner.close();
  await oldClose;
  const newOwner = acquireWriterExclusionSet(prepared, () => Promise.resolve());
  const newMarker = fs.readFileSync(markerPath(root, 'anchor'));
  const unlinkCountAfterNewAcquire = unlinkCalls;
  assert.equal(oldOwner.close(), oldClose);
  await oldOwner.close();
  assert.equal(unlinkCalls, unlinkCountAfterNewAcquire);
  assert.deepEqual(fs.readFileSync(markerPath(root, 'anchor')), newMarker);
  await newOwner.close();
  assert.equal(unlinkCalls, unlinkCountAfterNewAcquire + 1);
});

test('reentrant acquisition sees the entire set reserved before the first filesystem call', async (context) => {
  const root = temporaryRoot(context);
  const prepared = prepareWriterExclusionFiles(root, ['anchor', 'checkpoint']);
  const checkpointOnly = prepareWriterExclusionFiles(root, ['checkpoint']);
  const openSync = fs.openSync;
  let openCalls = 0;
  let reentryReason;
  context.mock.method(fs, 'openSync', (file, flags, mode) => {
    openCalls += 1;
    if (openCalls === 1) {
      const nested = captureThrow(() => acquireWriterExclusionSet(checkpointOnly, () => Promise.resolve()));
      reentryReason = nested.reason;
    }
    return openSync(file, flags, mode);
  });

  const owner = acquireWriterExclusionSet(prepared, () => Promise.resolve());
  assert.equal(reentryReason.code, 'ERR_WRITER_EXCLUSION_BUSY');
  assert.equal(openCalls, 2);
  await owner.close();
});

test('two processes contend, drain behind a barrier, and permit a fresh owner afterward', async (context) => {
  const { root, children } = temporaryProcessRoot(context);

  const first = startWriterExclusionChild(root, ['anchor', 'checkpoint']);
  children.push(first);
  const second = startWriterExclusionChild(root, ['anchor', 'checkpoint']);
  children.push(second);
  await Promise.all([first.waitForMessage('ready'), second.waitForMessage('ready')]);

  first.send('acquire');
  second.send('acquire');
  const outcomes = await Promise.all([
    first.waitForEither('acquired', 'acquire-error'),
    second.waitForEither('acquired', 'acquire-error'),
  ]);
  const winner = outcomes[0].type === 'acquired' ? first : outcomes[1].type === 'acquired' ? second : null;
  const loser = winner === first ? second : first;
  assert.ok(winner);
  assert.equal(outcomes.filter((message) => message.type === 'acquired').length, 1);
  assert.equal(outcomes.find((message) => message.type === 'acquire-error').code, 'EEXIST');

  const third = startWriterExclusionChild(root, ['anchor', 'checkpoint']);
  children.push(third);
  await third.waitForMessage('ready');
  third.send('acquire');
  const thirdOutcome = await third.waitForEither('acquired', 'acquire-error');
  assert.equal(thirdOutcome.type, 'acquire-error');
  assert.equal(thirdOutcome.code, 'EEXIST');

  winner.send('close');
  await winner.waitForMessage('quiesce-started');
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), true);
  winner.send('release-quiesce');
  await winner.waitForMessage('closed');
  const fresh = startWriterExclusionChild(root, ['anchor', 'checkpoint']);
  children.push(fresh);
  await fresh.waitForMessage('ready');
  fresh.send('acquire');
  assert.equal((await fresh.waitForEither('acquired', 'acquire-error')).type, 'acquired');
  const freshMarker = fs.readFileSync(markerPath(root, 'anchor'));

  winner.send('close-again');
  const oldClose = await winner.waitForMessage('close-again-result');
  assert.equal(oldClose.samePromise, true);
  assert.deepEqual(fs.readFileSync(markerPath(root, 'anchor')), freshMarker);

  fresh.send('close');
  await fresh.waitForMessage('quiesce-started');
  fresh.send('release-quiesce');
  await fresh.waitForMessage('closed');
  await Promise.all([winner.stop(), loser.stop(), third.stop(), fresh.stop()]);
});

test('process.exit without close leaves markers and is distinguished by exit plus close', async (context) => {
  const { root, children } = temporaryProcessRoot(context);
  const child = startWriterExclusionChild(root, ['anchor']);
  children.push(child);
  await child.waitForMessage('ready');
  child.send('acquire');
  await child.waitForMessage('acquired');
  child.send('exit-without-close');
  const exit = await child.waitForExit();
  const close = await child.waitForClose();
  assert.equal(exit.code, 23);
  assert.equal(close.code, 23);
  assert.equal(fs.existsSync(markerPath(root, 'anchor')), true);

  const next = startWriterExclusionChild(root, ['anchor']);
  children.push(next);
  await next.waitForMessage('ready');
  next.send('acquire');
  const result = await next.waitForEither('acquired', 'acquire-error');
  assert.equal(result.type, 'acquire-error');
  assert.equal(result.code, 'EEXIST');
  await next.stop();
});
