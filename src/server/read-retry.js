const DEFAULT_READ_RETRY_DELAYS_MS = Object.freeze([40, 40, 40, 40]);
const waitArray = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function delaySync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(waitArray, 0, 0, milliseconds);
}

async function readWithRetry(read, options = {}) {
  const retryDelaysMs = options.retryDelaysMs || DEFAULT_READ_RETRY_DELAYS_MS;
  let retries = 0;
  while (true) {
    try {
      return await read();
    } catch (error) {
      if (error.code === 'ENOENT' || retries >= retryDelaysMs.length) throw error;
      await (options.delay || delay)(retryDelaysMs[retries]);
      retries += 1;
    }
  }
}

function readSyncWithRetry(read, options = {}) {
  const retryDelaysMs = options.retryDelaysMs || DEFAULT_READ_RETRY_DELAYS_MS;
  let retries = 0;
  while (true) {
    try {
      return read();
    } catch (error) {
      if (error.code === 'ENOENT' || retries >= retryDelaysMs.length) throw error;
      (options.delaySync || delaySync)(retryDelaysMs[retries]);
      retries += 1;
    }
  }
}

function storageFailure(error, fileName, operation) {
  const wrapped = new Error(`${fileName} ${operation} failed`, { cause: error });
  if (error.code !== undefined) wrapped.code = error.code;
  wrapped.storageFileName = fileName;
  wrapped.storageOperation = operation;
  return wrapped;
}

module.exports = { DEFAULT_READ_RETRY_DELAYS_MS, readSyncWithRetry, readWithRetry, storageFailure };
