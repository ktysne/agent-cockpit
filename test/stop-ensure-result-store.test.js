'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createStopEnsureResultStore } = require('../src/server/stop-ensure-result-store');
const { encodeStopEnsureRecord } = require('../src/server/stop-ensure-record-codec');

const INSTANCE_ID = 'a5f9b3c1-6d72-4f80-9b31-2c6d8e4f7012';
const REQUEST_ID = 'c7b1d5e3-8f94-4ba2-9d53-4e8f0a6b9234';
const ATTEMPT_ID = 'd8c2e6f4-9a05-4cb3-8e64-5f901b7ca345';
const SCOPE_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const EXPECTED_SHUTDOWN = { kind: 'shutdown', instanceId: INSTANCE_ID, requestId: REQUEST_ID };
const EXPECTED_STARTUP = { kind: 'startup', scopeId: SCOPE_ID, attemptId: ATTEMPT_ID };

function shutdownRecord(status = 'completed', reasonCode = null) {
  return {
    version: 1,
    kind: 'shutdown',
    instanceId: INSTANCE_ID,
    requestId: REQUEST_ID,
    status,
    reasonCode,
  };
}

function startupRecord(status = 'started', reasonCode = null) {
  return {
    version: 1,
    kind: 'startup',
    scopeId: SCOPE_ID,
    attemptId: ATTEMPT_ID,
    instanceId: status === 'started' ? INSTANCE_ID : null,
    status,
    reasonCode,
  };
}

function slotPath(root, expectedIds) {
  const fields = expectedIds.kind === 'shutdown'
    ? [expectedIds.kind, expectedIds.instanceId, expectedIds.requestId]
    : [expectedIds.kind, expectedIds.scopeId, expectedIds.attemptId];
  const tuple = Buffer.from(fields.map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join(''), 'utf8');
  const digest = crypto.createHash('sha256').update(tuple).digest('hex');
  return path.join(root, `${expectedIds.kind}-${digest}.json`);
}

function makeStat({ directory = false, file = false, symlink = false, size = 0 } = {}) {
  return {
    size,
    isDirectory: () => directory,
    isFile: () => file,
    isSymbolicLink: () => symlink,
  };
}

function ioError(code = 'EIO') {
  const error = new Error('fixture error');
  error.code = code;
  return error;
}

function makeMemoryFileSystem(root) {
  const files = new Map();
  const calls = { lstat: 0, open: 0, read: 0, write: 0, close: 0, rename: 0, unlink: 0 };
  const state = { rootPresent: true, behavior: Object.create(null) };
  const fileSystem = Object.create(null);

  function run(name, args, fallback) {
    calls[name] += 1;
    const override = state.behavior[name];
    return override ? override(...args, fallback) : fallback();
  }

  fileSystem.lstat = (filePath) => run('lstat', [filePath], () => {
    if (filePath === root) {
      if (!state.rootPresent) throw ioError('ENOENT');
      return makeStat({ directory: true });
    }
    if (files.has(filePath)) return makeStat({ file: true, size: files.get(filePath).byteLength });
    throw ioError('ENOENT');
  });

  fileSystem.open = (filePath, flags) => run('open', [filePath, flags], () => {
    if (flags === 'r') {
      if (!files.has(filePath)) throw ioError('ENOENT');
      const source = files.get(filePath);
      return {
        stat: async () => makeStat({ file: true, size: source.byteLength }),
        read: (buffer, offset, length, position) => run('read', [filePath, buffer, offset, length, position], () => {
          const available = Math.max(0, source.byteLength - position);
          const count = Math.min(length, available, state.behavior.maxRead || length);
          source.copy(buffer, offset, position, position + count);
          return { bytesRead: count };
        }),
        close: () => run('close', [filePath, 'read'], () => undefined),
      };
    }
    if (flags !== 'wx') throw ioError('EINVAL');
    if (files.has(filePath)) throw ioError('EEXIST');
    files.set(filePath, Buffer.alloc(0));
    return {
      write: (buffer, offset, length, position) => run('write', [filePath, buffer, offset, length, position], () => {
        const configuredLimit = state.behavior.maxWrite || length;
        const count = Math.min(length, configuredLimit);
        const destination = files.get(filePath);
        const nextSize = Math.max(destination.byteLength, position + count);
        const next = Buffer.alloc(nextSize);
        destination.copy(next);
        buffer.copy(next, position, offset, offset + count);
        files.set(filePath, next);
        return { bytesWritten: count };
      }),
      close: () => run('close', [filePath, 'write'], () => undefined),
    };
  });

  fileSystem.rename = (fromPath, toPath) => run('rename', [fromPath, toPath], () => {
    if (files.has(toPath)) throw ioError('EEXIST');
    if (!files.has(fromPath)) throw ioError('ENOENT');
    files.set(toPath, files.get(fromPath));
    files.delete(fromPath);
    return undefined;
  });

  fileSystem.unlink = (filePath) => run('unlink', [filePath], () => {
    if (!files.has(filePath)) throw ioError('ENOENT');
    files.delete(filePath);
    return undefined;
  });

  return { fileSystem, files, calls, state };
}

function assertOwnedTempDirectory(directory) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  const relative = path.relative(tempRoot, resolved);
  assert.notEqual(relative, '');
  assert.notEqual(relative, '..');
  assert.equal(relative.startsWith(`..${path.sep}`), false);
  assert.equal(path.isAbsolute(relative), false);
}

async function makeRealStoreFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-ensure-result-store-'));
  let openHandles = 0;
  const fileSystem = Object.create(null);
  fileSystem.lstat = (filePath) => fs.lstat(filePath);
  fileSystem.open = async (...args) => {
    const handle = await fs.open(...args);
    openHandles += 1;
    let closed = false;
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      read: (...readArgs) => handle.read(...readArgs),
      write: (...writeArgs) => handle.write(...writeArgs),
      close: async () => {
        const result = await handle.close();
        if (result === undefined && !closed) {
          closed = true;
          openHandles -= 1;
        }
        return result;
      },
    };
  };
  fileSystem.rename = (fromPath, toPath) => fs.rename(fromPath, toPath);
  fileSystem.unlink = (filePath) => fs.unlink(filePath);
  const store = createStopEnsureResultStore({ controlDirectory: root, fileSystem });
  t.after(async () => {
    assert.equal(openHandles, 0);
    assertOwnedTempDirectory(root);
    await fs.rm(root, { recursive: true, force: false });
  });
  return { root, store };
}

function makeFakeStore(root, memory = makeMemoryFileSystem(root)) {
  return { ...memory, store: createStopEnsureResultStore({ controlDirectory: root, fileSystem: memory.fileSystem }) };
}

function assertUnknown(result, diagnostic, extra = {}) {
  assert.deepEqual(result, { status: 'unknown', diagnostic, ...extra });
  assert.equal(Object.isFrozen(result), true);
}

test('factory and record inputs reject unsafe shapes synchronously before filesystem access', () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  assert.throws(() => createStopEnsureResultStore({ controlDirectory: root, extra: true }),
    (error) => error instanceof TypeError && error.message === 'invalid_stop_ensure_store_options');
  assert.throws(() => createStopEnsureResultStore({ controlDirectory: 'relative' }),
    (error) => error instanceof TypeError && error.message === 'invalid_stop_ensure_store_options');
  let getterCalls = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, 'controlDirectory', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('getter must not run'); },
  });
  assert.throws(() => createStopEnsureResultStore(accessorOptions),
    (error) => error instanceof TypeError && error.message === 'invalid_stop_ensure_store_options');
  assert.equal(getterCalls, 0);
  assert.throws(() => createStopEnsureResultStore({
    controlDirectory: root,
    fileSystem: { ...memory.fileSystem, lstat: undefined },
  }), (error) => error instanceof TypeError && error.message === 'invalid_stop_ensure_store_options');
  const { store } = makeFakeStore(root, memory);
  const before = { ...memory.calls };
  assert.throws(() => store.readResult({ ...EXPECTED_SHUTDOWN, extra: true }),
    (error) => error instanceof TypeError && error.message === 'invalid_stop_ensure_record');
  assert.throws(() => store.writeResult({ ...shutdownRecord(), status: 'unknown' }),
    (error) => error instanceof TypeError && error.message === 'invalid_stop_ensure_record');
  assert.deepEqual(memory.calls, before);
});

test('filesystem methods are captured at factory creation', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  const store = createStopEnsureResultStore({ controlDirectory: root, fileSystem: memory.fileSystem });
  for (const name of ['lstat', 'open', 'rename', 'unlink']) {
    memory.fileSystem[name] = () => { throw ioError(); };
  }
  assert.deepEqual(await store.writeResult(shutdownRecord()), { status: 'written' });
  assert.equal((await store.readResult(EXPECTED_SHUTDOWN)).status, 'valid');
});

test('store surface is frozen and a write reentered from filesystem I/O sees the reserved promise', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  let store;
  let reentered;
  memory.state.behavior.lstat = (filePath, fallback) => {
    const stat = fallback();
    if (filePath === root && !reentered) reentered = store.writeResult(shutdownRecord());
    return stat;
  };
  store = createStopEnsureResultStore({ controlDirectory: root, fileSystem: memory.fileSystem });
  assert.deepEqual(Object.keys(store).sort(), ['readResult', 'writeResult']);
  assert.equal(Object.isFrozen(store), true);
  const first = store.writeResult(shutdownRecord());
  assert.deepEqual(await first, { status: 'written' });
  assert.equal(reentered, first);
  assert.equal(memory.calls.open, 1);
});

test('real fixture writes and reads a record and latches identical writes to the same promise', async (t) => {
  const { root, store } = await makeRealStoreFixture(t);
  const record = shutdownRecord();
  const first = store.writeResult(record);
  assert.equal(first, store.writeResult({
    reasonCode: null,
    status: 'completed',
    requestId: REQUEST_ID,
    instanceId: INSTANCE_ID,
    kind: 'shutdown',
    version: 1,
  }));
  const result = await first;
  assert.deepEqual(result, { status: 'written' });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(store.writeResult(record), first);

  assert.deepEqual(await store.writeResult(startupRecord()), { status: 'written' });

  const read = await store.readResult(EXPECTED_SHUTDOWN);
  assert.equal(read.status, 'valid');
  assert.equal(Object.isFrozen(read), true);
  assert.equal(Object.getPrototypeOf(read.record), null);
  assert.equal(Object.isFrozen(read.record), true);
  assert.deepEqual(read.record, Object.assign(Object.create(null), record));
  const startupRead = await store.readResult(EXPECTED_STARTUP);
  assert.equal(startupRead.status, 'valid');
  assert.equal(startupRead.record.kind, 'startup');
  const fileNames = await fs.readdir(root);
  assert.deepEqual(fileNames.sort(), [
    path.basename(slotPath(root, EXPECTED_SHUTDOWN)),
    path.basename(slotPath(root, EXPECTED_STARTUP)),
  ].sort());
  assertOwnedTempDirectory(root);
});

test('same identity with different canonical bytes conflicts synchronously and does not repeat I/O', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const fixture = makeFakeStore(root);
  const resultPromise = fixture.store.writeResult(shutdownRecord());
  const callsBeforeConflict = { ...fixture.calls };
  assert.throws(() => fixture.store.writeResult(shutdownRecord('failed', 'shutdown_incomplete')),
    (error) => error instanceof TypeError && error.message === 'stop_ensure_result_conflict');
  assert.deepEqual(fixture.calls, callsBeforeConflict);
  assert.deepEqual(await resultPromise, { status: 'written' });
  assert.equal(fixture.store.writeResult(shutdownRecord()), resultPromise);
});

test('startup and shutdown identifiers derive separate bounded slots and reads recheck exact IDs', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const fixture = makeFakeStore(root);
  assert.deepEqual(await fixture.store.writeResult(startupRecord()), { status: 'written' });
  assert.deepEqual(await fixture.store.writeResult(shutdownRecord()), { status: 'written' });
  assert.deepEqual([...fixture.files.keys()].sort(), [
    slotPath(root, EXPECTED_SHUTDOWN),
    slotPath(root, EXPECTED_STARTUP),
  ].sort());
  assert.equal((await fixture.store.readResult(EXPECTED_STARTUP)).status, 'valid');
  const mismatchedIds = { ...EXPECTED_STARTUP, attemptId: 'e9d3f705-ab16-4dc4-9f75-60a12c8db456' };
  fixture.files.set(slotPath(root, mismatchedIds), encodeStopEnsureRecord(startupRecord()));
  assertUnknown(await fixture.store.readResult(mismatchedIds), 'record_invalid', { closeFailed: false });
});

test('read returns missing only while the parent directory remains available', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const fixture = makeFakeStore(root);
  assert.deepEqual(await fixture.store.readResult(EXPECTED_SHUTDOWN), { status: 'missing' });
  fixture.state.rootPresent = false;
  assertUnknown(await fixture.store.readResult(EXPECTED_SHUTDOWN), 'directory_unavailable', { closeFailed: false });
});

test('target ENOENT is missing only if the parent remains present at recheck', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const target = slotPath(root, EXPECTED_SHUTDOWN);
  const memory = makeMemoryFileSystem(root);
  memory.state.behavior.lstat = (filePath, fallback) => {
    if (filePath === target) {
      memory.state.rootPresent = false;
      throw ioError('ENOENT');
    }
    return fallback();
  };
  const fixture = makeFakeStore(root, memory);
  assertUnknown(await fixture.store.readResult(EXPECTED_SHUTDOWN), 'directory_unavailable', { closeFailed: false });
});

test('read loops over positive short reads and never reads an oversized stat result', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const fixture = makeFakeStore(root);
  const target = slotPath(root, EXPECTED_SHUTDOWN);
  const bytes = encodeStopEnsureRecord(shutdownRecord());
  fixture.files.set(target, bytes);
  fixture.state.behavior.maxRead = 3;
  assert.equal((await fixture.store.readResult(EXPECTED_SHUTDOWN)).status, 'valid');
  assert.ok(fixture.calls.read > 2);

  fixture.files.set(target, Buffer.alloc(4097, 0x20));
  const readCountBefore = fixture.calls.read;
  assertUnknown(await fixture.store.readResult(EXPECTED_SHUTDOWN), 'record_too_large', { closeFailed: false });
  assert.equal(fixture.calls.read, readCountBefore);
});

test('read accepts a valid record padded to the exact byte ceiling', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const fixture = makeFakeStore(root);
  const encoded = encodeStopEnsureRecord(shutdownRecord());
  const padded = Buffer.concat([encoded, Buffer.alloc(4096 - encoded.byteLength, 0x20)]);
  fixture.files.set(slotPath(root, EXPECTED_SHUTDOWN), padded);
  assert.equal(padded.byteLength, 4096);
  assert.equal((await fixture.store.readResult(EXPECTED_SHUTDOWN)).status, 'valid');
});

test('read detects the 4097th byte after stat and classifies malformed contents', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const fixture = makeFakeStore(root);
  const target = slotPath(root, EXPECTED_SHUTDOWN);
  fixture.files.set(target, Buffer.alloc(4097, 0x20));
  fixture.state.behavior.open = (filePath, flags, fallback) => {
    const handle = fallback();
    if (filePath === target && flags === 'r') {
      handle.stat = async () => makeStat({ file: true, size: 0 });
    }
    return handle;
  };
  assertUnknown(await fixture.store.readResult(EXPECTED_SHUTDOWN), 'record_too_large', { closeFailed: false });
  assert.ok(fixture.calls.read > 0);

  fixture.state.behavior.open = undefined;
  fixture.files.set(target, Buffer.from([0xc3, 0x28]));
  assertUnknown(await fixture.store.readResult(EXPECTED_SHUTDOWN), 'record_invalid', { closeFailed: false });
});

test('read rejects a nonregular target without opening it', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  const target = slotPath(root, EXPECTED_SHUTDOWN);
  let targetKind = 'directory';
  memory.state.behavior.lstat = (filePath, fallback) => {
    if (filePath !== target) return fallback();
    return targetKind === 'directory'
      ? makeStat({ directory: true })
      : makeStat({ file: true, symlink: true });
  };
  const fixture = makeFakeStore(root, memory);
  assertUnknown(await fixture.store.readResult(EXPECTED_SHUTDOWN), 'record_not_regular', { closeFailed: false });
  assert.equal(fixture.calls.open, 0);
  targetKind = 'symlink';
  assertUnknown(await fixture.store.readResult(EXPECTED_SHUTDOWN), 'record_not_regular', { closeFailed: false });
  assert.equal(fixture.calls.open, 0);
});

test('opened handle stat failure still closes the known read handle once', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const fixture = makeFakeStore(root);
  const target = slotPath(root, EXPECTED_SHUTDOWN);
  fixture.files.set(target, encodeStopEnsureRecord(shutdownRecord()));
  fixture.state.behavior.open = (filePath, flags, fallback) => {
    const handle = fallback();
    if (filePath === target && flags === 'r') handle.stat = async () => { throw ioError(); };
    return handle;
  };
  assertUnknown(await fixture.store.readResult(EXPECTED_SHUTDOWN), 'record_io_failed', { closeFailed: false });
  assert.equal(fixture.calls.close, 1);
  assert.equal(fixture.calls.read, 0);
});

test('read rejects contract-invalid progress and closes its known handle once', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const fixture = makeFakeStore(root);
  fixture.files.set(slotPath(root, EXPECTED_SHUTDOWN), encodeStopEnsureRecord(shutdownRecord()));
  fixture.state.behavior.read = () => ({ bytesRead: false });
  assertUnknown(await fixture.store.readResult(EXPECTED_SHUTDOWN), 'record_io_failed', { closeFailed: false });
  assert.equal(fixture.calls.close, 1);
});

test('read preserves the first diagnostic when close fails and never closes twice', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const fixture = makeFakeStore(root);
  const target = slotPath(root, EXPECTED_SHUTDOWN);
  fixture.files.set(target, Buffer.from('{'));
  fixture.state.behavior.close = () => { throw ioError(); };
  assertUnknown(await fixture.store.readResult(EXPECTED_SHUTDOWN), 'record_invalid', { closeFailed: true });
  assert.equal(fixture.calls.close, 1);

  fixture.files.set(target, encodeStopEnsureRecord(shutdownRecord()));
  assertUnknown(await fixture.store.readResult(EXPECTED_SHUTDOWN), 'record_close_unknown', { closeFailed: true });
  assert.equal(fixture.calls.close, 2);
});

test('positive short writes progress, while zero progress rolls back only its closed temp', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const fixture = makeFakeStore(root);
  fixture.state.behavior.maxWrite = 2;
  assert.deepEqual(await fixture.store.writeResult(shutdownRecord()), { status: 'written' });
  assert.ok(fixture.calls.write > 2);

  const otherRoot = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root-zero'));
  const zeroMemory = makeMemoryFileSystem(otherRoot);
  zeroMemory.state.behavior.write = (_filePath, _buffer, _offset, _length, _position) => ({ bytesWritten: 0 });
  const zero = makeFakeStore(otherRoot, zeroMemory);
  const promise = zero.store.writeResult(startupRecord());
  const result = await promise;
  assert.deepEqual(result, { status: 'unknown', diagnostic: 'record_write_failed', cleanupFailed: false });
  assert.deepEqual([...zero.files.keys()], []);
  const counts = { ...zero.calls };
  assert.equal(zero.store.writeResult(startupRecord()), promise);
  assert.deepEqual(zero.calls, counts);
});

test('open reject after creating a temp does not claim or unlink that path', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  memory.state.behavior.open = (filePath, flags, fallback) => {
    if (flags === 'wx') {
      memory.files.set(filePath, Buffer.alloc(0));
      throw ioError();
    }
    return fallback();
  };
  const fixture = makeFakeStore(root, memory);
  const result = await fixture.store.writeResult(shutdownRecord());
  assert.deepEqual(result, { status: 'unknown', diagnostic: 'record_open_unknown', cleanupFailed: false });
  assert.equal(fixture.calls.unlink, 0);
  assert.equal(fixture.files.size, 1);
});

test('an invalid resolved temp handle stays unknown and is not unlinked', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  memory.state.behavior.open = (filePath, flags, fallback) => flags === 'wx'
    ? { close: async () => { memory.calls.close += 1; return undefined; } }
    : fallback();
  const fixture = makeFakeStore(root, memory);
  assert.deepEqual(await fixture.store.writeResult(shutdownRecord()), {
    status: 'unknown', diagnostic: 'record_open_unknown', cleanupFailed: false,
  });
  assert.equal(fixture.calls.close, 1);
  assert.equal(fixture.calls.unlink, 0);
});

test('close uncertainty prevents rename and cleanup, with one close attempt', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  memory.state.behavior.close = (_filePath, kind) => kind === 'write' ? Promise.resolve(null) : undefined;
  const fixture = makeFakeStore(root, memory);
  const result = await fixture.store.writeResult(shutdownRecord());
  assert.deepEqual(result, { status: 'unknown', diagnostic: 'record_close_unknown', cleanupFailed: false });
  assert.equal(fixture.calls.close, 1);
  assert.equal(fixture.calls.rename, 0);
  assert.equal(fixture.calls.unlink, 0);
});

test('write failure stays the first diagnostic when close is also unknown', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  memory.state.behavior.write = () => { throw ioError(); };
  memory.state.behavior.close = () => { throw ioError(); };
  const fixture = makeFakeStore(root, memory);
  assert.deepEqual(await fixture.store.writeResult(shutdownRecord()), {
    status: 'unknown', diagnostic: 'record_write_failed', cleanupFailed: false,
  });
  assert.equal(fixture.calls.close, 1);
  assert.equal(fixture.calls.unlink, 0);
});

test('rename side effect followed by reject stays unknown and never removes the target', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  memory.state.behavior.rename = (fromPath, toPath, fallback) => {
    fallback();
    throw ioError();
  };
  const fixture = makeFakeStore(root, memory);
  const result = await fixture.store.writeResult(shutdownRecord());
  assert.deepEqual(result, { status: 'unknown', diagnostic: 'record_rename_unknown', cleanupFailed: false });
  assert.equal(fixture.files.has(slotPath(root, EXPECTED_SHUTDOWN)), true);
  assert.equal(fixture.calls.unlink, 1);
});

test('unexpected rename and cleanup return values remain unknown and set cleanupFailed', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  memory.state.behavior.rename = () => false;
  memory.state.behavior.unlink = () => false;
  const fixture = makeFakeStore(root, memory);
  assert.deepEqual(await fixture.store.writeResult(shutdownRecord()), {
    status: 'unknown', diagnostic: 'record_rename_unknown', cleanupFailed: true,
  });
  assert.equal(fixture.calls.rename, 1);
  assert.equal(fixture.calls.unlink, 1);
});

test('cleanup failure is reported separately and cannot replace the first write diagnostic', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  memory.state.behavior.write = () => { throw ioError(); };
  memory.state.behavior.unlink = () => { throw ioError(); };
  const fixture = makeFakeStore(root, memory);
  assert.deepEqual(await fixture.store.writeResult(shutdownRecord()), {
    status: 'unknown', diagnostic: 'record_write_failed', cleanupFailed: true,
  });
  assert.equal(fixture.calls.close, 1);
  assert.equal(fixture.calls.unlink, 1);
});

test('an existing target is never overwritten and write failure outcomes are terminal', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  const target = slotPath(root, EXPECTED_SHUTDOWN);
  memory.files.set(target, Buffer.from('foreign'));
  const fixture = makeFakeStore(root, memory);
  const promise = fixture.store.writeResult(shutdownRecord());
  assert.deepEqual(await promise, { status: 'unknown', diagnostic: 'record_exists', cleanupFailed: false });
  const counts = { ...fixture.calls };
  assert.equal(fixture.store.writeResult(shutdownRecord()), promise);
  assert.deepEqual(fixture.calls, counts);
  assert.equal(memory.files.get(target).toString(), 'foreign');
});

test('failed write cleanup leaves unrelated targets, markers, and temp files unchanged', async () => {
  const root = path.resolve(path.join(os.tmpdir(), 'stop-ensure-fake-root'));
  const memory = makeMemoryFileSystem(root);
  const untouched = new Map([
    [path.join(root, 'foreign-target.json'), Buffer.from('target')],
    [path.join(root, 'writer.marker'), Buffer.from('marker')],
    [path.join(root, '.foreign.123.tmp'), Buffer.from('temporary')],
  ]);
  for (const [filePath, bytes] of untouched) memory.files.set(filePath, Buffer.from(bytes));
  memory.state.behavior.write = () => { throw ioError(); };
  const fixture = makeFakeStore(root, memory);
  assert.deepEqual(await fixture.store.writeResult(shutdownRecord()), {
    status: 'unknown', diagnostic: 'record_write_failed', cleanupFailed: false,
  });
  assert.deepEqual([...fixture.files.keys()].sort(), [...untouched.keys()].sort());
  for (const [filePath, bytes] of untouched) assert.deepEqual(fixture.files.get(filePath), bytes);
  assert.equal(fixture.calls.unlink, 1);
});
