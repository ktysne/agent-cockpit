'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function* ancestorDirectories(cwd, paths = path) {
  let current = paths.resolve(cwd);
  while (true) {
    yield current;
    const parent = paths.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function findWorktreeRoot(cwd, fileSystem = fsp, paths = path) {
  if (typeof cwd !== 'string' || !cwd || !paths.isAbsolute(cwd)) return { root: null, reason: 'invalid-path' };
  for (const directory of ancestorDirectories(cwd, paths)) {
    try {
      const marker = await fileSystem.stat(paths.join(directory, '.git'));
      return { root: directory, marker, reason: null };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      return { root: null, reason: 'unreadable', errorCode: error.code };
    }
  }
  return { root: null, reason: 'not-found' };
}

function findWorktreeRootSync(cwd, fileSystem = fs, paths = path) {
  if (typeof cwd !== 'string' || !cwd || !paths.isAbsolute(cwd)) return { root: null, reason: 'invalid-path' };
  for (const directory of ancestorDirectories(cwd, paths)) {
    try {
      const marker = fileSystem.statSync(paths.join(directory, '.git'));
      return { root: directory, marker, reason: null };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      return { root: null, reason: 'unreadable', errorCode: error.code };
    }
  }
  return { root: null, reason: 'not-found' };
}

module.exports = { ancestorDirectories, findWorktreeRoot, findWorktreeRootSync };
