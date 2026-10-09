'use strict';

const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

function makeError(code) {
  const error = new Error(`fixture ${code}`);
  error.code = code;
  return error;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createNativeFileSystemFixture() {
  const native = Object.freeze({
    lstat: fs.lstat.bind(fs),
    open: fs.open.bind(fs),
    rename: fs.rename.bind(fs),
    unlink: fs.unlink.bind(fs),
    writeFile: fs.writeFile.bind(fs),
  });
  const events = [];
  let armedRenameFailure = null;

  async function rename(temporaryPath, targetPath) {
    const fault = armedRenameFailure;
    if (!fault || fault.targetPath !== targetPath) return native.rename(temporaryPath, targetPath);
    if (fault.temporaryPath !== temporaryPath) {
      fault.temporaryPath = temporaryPath;
      fault.writeOccurrences += 1;
      fault.calls = 0;
    }
    if (fault.writeOccurrences < fault.occurrence) {
      events.push({ operation: 'rename-passthrough', targetPath, writeOccurrence: fault.writeOccurrences, phase: fault.phase });
      return native.rename(temporaryPath, targetPath);
    }
    fault.calls += 1;
    events.push({ operation: 'rename', targetPath, call: fault.calls,
      writeOccurrence: fault.writeOccurrences, phase: fault.phase });
    if (fault.hold && fault.calls === 1) {
      fault.entered.resolve();
      await fault.release.promise;
    }
    if (fault.phase === 'after' && fault.calls === 1) {
      await native.rename(temporaryPath, targetPath);
      throw fault.error || makeError(fault.code);
    }
    throw fault.error || makeError(fault.code);
  }

  async function unlink(temporaryPath) {
    const fault = armedRenameFailure;
    if (fault?.cleanupFailure && path.dirname(temporaryPath) === path.dirname(fault.targetPath) &&
        path.basename(temporaryPath).startsWith(`.${path.basename(fault.targetPath)}.`)) {
      fault.cleanupCalls += 1;
      events.push({ operation: 'unlink-failed', targetPath: fault.targetPath });
      throw makeError('EIO');
    }
    try {
      await native.unlink(temporaryPath);
      events.push({ operation: 'unlink-removed', targetPath: fault?.targetPath || null });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        events.push({ operation: 'unlink-missing', targetPath: fault?.targetPath || null });
      }
      throw error;
    } finally {
      if (fault && path.dirname(temporaryPath) === path.dirname(fault.targetPath) &&
          path.basename(temporaryPath).startsWith(`.${path.basename(fault.targetPath)}.`) &&
          !fault.cleanupFailure) {
        armedRenameFailure = null;
      }
    }
  }

  const fileSystem = Object.freeze({
    lstat: native.lstat,
    open: native.open,
    rename,
    unlink,
    writeFile: native.writeFile,
  });

  return Object.freeze({
    fileSystem,
    events,
    armRenameRetryExhaustion({
      targetPath,
      phase = 'before',
      occurrence = 1,
      code = 'EPERM',
      cleanupFailure = false,
      error = null,
      hold = false,
    }) {
      if (armedRenameFailure !== null || typeof targetPath !== 'string' ||
          !['before', 'after'].includes(phase) || !['EPERM', 'EBUSY'].includes(code) ||
          !Number.isSafeInteger(occurrence) || occurrence < 1 ||
          typeof cleanupFailure !== 'boolean' || typeof hold !== 'boolean' ||
          (error !== null && (!error || typeof error !== 'object' || error.code !== code))) {
        throw new TypeError('invalid isolated rename fault');
      }
      const entered = deferred();
      const release = deferred();
      armedRenameFailure = {
        targetPath,
        phase,
        occurrence,
        code,
        cleanupFailure,
        error,
        hold,
        entered,
        release,
        calls: 0,
        writeOccurrences: 0,
        temporaryPath: null,
        cleanupCalls: 0,
      };
      return Object.freeze({ entered: entered.promise, release: release.resolve });
    },
    renameCalls(targetPath) {
      return events.filter((event) => event.operation === 'rename' && event.targetPath === targetPath).length;
    },
    cleanupCalls(targetPath) {
      return events.filter((event) => ['unlink-removed', 'unlink-missing', 'unlink-failed']
        .includes(event.operation) && event.targetPath === targetPath).length;
    },
    async removeTemporaryFiles(directory) {
      const names = await fs.readdir(directory);
      await Promise.all(names.filter((name) => name.endsWith('.tmp'))
        .map((name) => native.unlink(path.join(directory, name)).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        })));
    },
  });
}

function compileIsolated(filename, overrides = {}) {
  const normalRequire = Module.createRequire(filename);
  const localRequire = (request) => Object.hasOwn(overrides, request)
    ? overrides[request]
    : normalRequire(request);
  localRequire.resolve = normalRequire.resolve.bind(normalRequire);
  localRequire.cache = require.cache;
  localRequire.main = require.main;
  localRequire.extensions = require.extensions;
  localRequire.paths = normalRequire.paths;

  const source = fsSync.readFileSync(filename, 'utf8');
  const wrapped = Module.wrap(source);
  const compiled = vm.runInThisContext(wrapped, { filename });
  const isolatedModule = {
    exports: {},
    filename,
    id: filename,
    loaded: true,
    paths: Module._nodeModulePaths(path.dirname(filename)),
  };
  compiled.call(isolatedModule.exports, isolatedModule.exports, localRequire, isolatedModule,
    filename, path.dirname(filename));
  return isolatedModule.exports;
}

function loadQuestionWriteIsolationModules() {
  const nativeFileSystem = createNativeFileSystemFixture();
  const persistencePath = require.resolve('../../src/server/reclamation-persistence');
  const contextPath = require.resolve('../../src/server/reclamation-service-context');
  const integrationPath = require.resolve('../../src/server/native-instruction-service-integration');
  const persistence = compileIsolated(persistencePath, {
    'node:fs/promises': nativeFileSystem.fileSystem,
  });
  const context = compileIsolated(contextPath, {
    './reclamation-persistence': persistence,
  });
  const contexts = [];
  const observedContext = Object.freeze({
    ...context,
    createReclamationServiceContext(options) {
      const created = context.createReclamationServiceContext(options);
      contexts.push(created);
      return created;
    },
  });
  const compositionPath = require.resolve('../../src/server/native-launch-composition');
  const compositionModule = require(compositionPath);
  const compositions = [];
  const observedComposition = Object.freeze({
    ...compositionModule,
    createNativeLaunchComposition(options) {
      const created = compositionModule.createNativeLaunchComposition(options);
      compositions.push(created);
      return created;
    },
  });
  const integration = compileIsolated(integrationPath, {
    './native-launch-composition': observedComposition,
    './reclamation-persistence': persistence,
    './reclamation-service-context': observedContext,
  });
  return Object.freeze({
    nativeFileSystem,
    persistence,
    context,
    integration,
    observer: Object.freeze({
      contexts: () => Object.freeze([...contexts]),
      compositions: () => Object.freeze([...compositions]),
    }),
  });
}

module.exports = { loadQuestionWriteIsolationModules };
