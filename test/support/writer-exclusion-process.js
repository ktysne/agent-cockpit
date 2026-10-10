const path = require('node:path');
const { fork } = require('node:child_process');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'writer-exclusion-child.js');
const MESSAGE_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 3000;

function startWriterExclusionChild(root, slots) {
  let child;
  try {
    child = fork(fixturePath, [root, JSON.stringify(slots)], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
  } catch (error) {
    return failedChild(error);
  }

  const messages = [];
  const messageWaiters = [];
  let childError;
  let spawnFailed = false;
  let signalSpawnFailure;
  let exitRecord;
  let closeRecord;
  let stopPromise;

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exitRecord = { code, signal };
      resolve(exitRecord);
      failMessageWaiters(new Error('Child exited before the expected message'));
    });
  });
  const closePromise = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      closeRecord = { code, signal };
      resolve(closeRecord);
    });
  });
  const spawnFailurePromise = new Promise((resolve) => {
    signalSpawnFailure = resolve;
  });

  function failMessageWaiters(error) {
    for (const waiter of messageWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  child.on('error', (error) => {
    childError = error;
    spawnFailed = !child.pid;
    if (spawnFailed) signalSpawnFailure(error);
    failMessageWaiters(error);
  });
  child.on('message', (message) => {
    const waiterIndex = messageWaiters.findIndex((waiter) => waiter.types.includes(message && message.type));
    if (waiterIndex < 0) {
      messages.push(message);
      return;
    }
    const [waiter] = messageWaiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });

  function waitForMessage(...types) {
    const index = messages.findIndex((message) => types.includes(message && message.type));
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    if (childError) return Promise.reject(childError);
    if (exitRecord || closeRecord) {
      return Promise.reject(new Error(`Child ended before sending ${types.join(' or ')}`));
    }
    return new Promise((resolve, reject) => {
      const waiter = { types, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const waiterIndex = messageWaiters.indexOf(waiter);
        if (waiterIndex >= 0) messageWaiters.splice(waiterIndex, 1);
        reject(new Error(`Timed out waiting for child message: ${types.join(' or ')}`));
      }, MESSAGE_TIMEOUT_MS);
      messageWaiters.push(waiter);
    });
  }

  return {
    child,
    get spawnFailed() {
      return spawnFailed;
    },
    send(type) {
      if (childError) throw childError;
      if (!child.connected) throw new Error('Child IPC channel is closed');
      child.send({ type });
    },
    waitForMessage(type) {
      return waitForMessage(type);
    },
    waitForEither(firstType, secondType) {
      return waitForMessage(firstType, secondType);
    },
    waitForExit() {
      if (exitRecord) return Promise.resolve(exitRecord);
      return Promise.race([
        exitPromise,
        spawnFailurePromise.then((error) => Promise.reject(error)),
      ]);
    },
    waitForClose() {
      if (closeRecord) return Promise.resolve(closeRecord);
      return Promise.race([
        closePromise,
        spawnFailurePromise.then((error) => Promise.reject(error)),
      ]);
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (spawnFailed) return;
        if (exitRecord && closeRecord) return;
        if (child.connected) {
          if (childError) {
            child.disconnect();
          } else {
            try {
              child.send({ type: 'shutdown' });
            } catch {
              if (child.connected) child.disconnect();
            }
          }
        }

        const waitForEnd = () => Promise.all([exitPromise, closePromise]).then(() => true);
        let timer;
        let ended = await Promise.race([
          waitForEnd(),
          spawnFailurePromise.then(() => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
        if (ended) return;
        if (spawnFailed) return;
        if (child.pid && !exitRecord) child.kill();

        timer = null;
        ended = await Promise.race([
          waitForEnd(),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
        if (!ended) {
          throw new Error('Spawned writer exclusion child did not emit both exit and close');
        }
      })();
      return stopPromise;
    },
  };
}

function failedChild(error) {
  return {
    child: null,
    spawnFailed: true,
    send() {
      throw error;
    },
    waitForMessage() {
      return Promise.reject(error);
    },
    waitForEither() {
      return Promise.reject(error);
    },
    waitForExit() {
      return Promise.reject(error);
    },
    waitForClose() {
      return Promise.reject(error);
    },
    stop() {
      return Promise.resolve();
    },
  };
}

module.exports = { startWriterExclusionChild };
