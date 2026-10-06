'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { REPOSITORY_ROOT } = require('../codex-hooks-identity/setup');
const {
  MAX_CHECKPOINT_BYTES,
  readCheckpoint,
  writeCheckpoint,
} = require('./checkpoint-store');

const OUTPUT_BASE = path.join(REPOSITORY_ROOT, 'poc', 'out');

function withOwnedOutput(run) {
  const directory = path.join(OUTPUT_BASE, `poc162-store-test-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  const filePath = path.join(directory, 'checkpoint.json');
  try {
    return run({ directory, filePath });
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(OUTPUT_BASE));
    const stat = fs.lstatSync(resolved);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
    fs.rmSync(resolved, { recursive: true, force: false });
  }
}

function acceptsJson(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

test('checkpoint writes a JSON snapshot and atomically replaces an existing checkpoint', () => {
  withOwnedOutput(({ filePath }) => {
    const input = { revision: 1, state: { phase: 'ready' } };
    writeCheckpoint(filePath, input, { validate: acceptsJson });
    input.state.phase = 'mutated-after-write';
    assert.deepEqual(readCheckpoint(filePath, { validate: acceptsJson }), {
      revision: 1,
      state: { phase: 'ready' },
    });

    writeCheckpoint(filePath, { revision: 2 }, { validate: acceptsJson });
    assert.deepEqual(readCheckpoint(filePath, { validate: acceptsJson }), { revision: 2 });
  });
});

test('checkpoint validators are required and must accept before the existing file changes', () => {
  withOwnedOutput(({ filePath }) => {
    writeCheckpoint(filePath, { revision: 1 }, { validate: acceptsJson });
    const original = fs.readFileSync(filePath);

    assert.throws(() => writeCheckpoint(filePath, { revision: 2 }));
    assert.throws(() => writeCheckpoint(filePath, { revision: 2 }, { validate: () => false }));
    assert.throws(() => writeCheckpoint(filePath, { revision: 2 }, { validate: () => 1 }));
    assert.throws(() => writeCheckpoint(filePath, { revision: 2 }, { validate: () => { throw new Error('rejected'); } }));
    assert.throws(() => readCheckpoint(filePath));
    assert.throws(() => readCheckpoint(filePath, { validate: () => false }));
    assert.deepEqual(fs.readFileSync(filePath), original);
  });
});

test('checkpoint size limits reject oversized writes and loads while malformed JSON is rejected', () => {
  withOwnedOutput(({ filePath }) => {
    writeCheckpoint(filePath, { revision: 1 }, { validate: acceptsJson });
    const original = fs.readFileSync(filePath);
    assert.throws(() => writeCheckpoint(filePath, { payload: 'x'.repeat(MAX_CHECKPOINT_BYTES) }, { validate: acceptsJson }));
    assert.deepEqual(fs.readFileSync(filePath), original);

    fs.writeFileSync(filePath, '{broken json', { flag: 'w' });
    assert.throws(() => readCheckpoint(filePath, { validate: acceptsJson }));
    fs.writeFileSync(filePath, Buffer.alloc(MAX_CHECKPOINT_BYTES + 1, 0x20), { flag: 'w' });
    assert.throws(() => readCheckpoint(filePath, { validate: acceptsJson }));
  });
});

test('checkpoint paths reject relative, noncanonical, outside, and symlink paths', () => {
  withOwnedOutput(({ directory, filePath }) => {
    assert.throws(() => writeCheckpoint(path.relative(REPOSITORY_ROOT, filePath), {}, { validate: acceptsJson }));
    const noncanonicalPath = `${directory}${path.sep}child${path.sep}..${path.sep}checkpoint.json`;
    assert.throws(() => writeCheckpoint(noncanonicalPath, {}, { validate: acceptsJson }));
    assert.throws(() => writeCheckpoint(path.join(REPOSITORY_ROOT, 'package.json'), {}, { validate: acceptsJson }));

    const parentJunction = path.join(directory, 'linked-parent');
    fs.symlinkSync(REPOSITORY_ROOT, parentJunction, 'junction');
    const throughJunction = path.join(parentJunction, 'checkpoint.json');
    assert.throws(() => writeCheckpoint(throughJunction, {}, { validate: acceptsJson }));
    assert.throws(() => readCheckpoint(throughJunction, { validate: acceptsJson }));

    const targetJunction = path.join(directory, 'linked-target.json');
    fs.symlinkSync(REPOSITORY_ROOT, targetJunction, 'junction');
    assert.throws(() => writeCheckpoint(targetJunction, {}, { validate: acceptsJson }));
    assert.throws(() => readCheckpoint(targetJunction, { validate: acceptsJson }));
  });
});

test('failed atomic rename preserves the prior checkpoint and removes only its temporary file', () => {
  withOwnedOutput(({ directory, filePath }) => {
    writeCheckpoint(filePath, { revision: 1 }, { validate: acceptsJson });
    const original = fs.readFileSync(filePath);
    const renameSync = fs.renameSync;
    fs.renameSync = () => { throw new Error('simulated rename failure'); };
    try {
      assert.throws(() => writeCheckpoint(filePath, { revision: 2 }, { validate: acceptsJson }), /rename failure/);
    } finally {
      fs.renameSync = renameSync;
    }

    assert.deepEqual(fs.readFileSync(filePath), original);
    assert.deepEqual(fs.readdirSync(directory), ['checkpoint.json']);
  });
});
