const {
  acquireWriterExclusionSet,
  prepareWriterExclusionFiles,
} = require('../../src/server/writer-exclusion');

const root = process.argv[2];
const slots = JSON.parse(process.argv[3]);
const prepared = prepareWriterExclusionFiles(root, slots);
let owner;
let closePromise;
let releaseQuiesce;

function send(type, fields = {}) {
  if (process.connected) process.send({ type, ...fields });
}

function startClose() {
  if (!owner) throw new Error('No owner is acquired');
  if (closePromise) return closePromise;
  closePromise = owner.close();
  closePromise.then(
    () => send('closed'),
    (reason) => send('close-error', { message: String(reason), code: reason && reason.code }),
  );
  return closePromise;
}

function shutdown() {
  if (!owner) {
    process.exit(0);
    return;
  }
  let closing;
  try {
    closing = startClose();
  } catch {
    process.exit(1);
    return;
  }
  if (releaseQuiesce) releaseQuiesce();
  closing.then(
    () => process.exit(0),
    () => process.exit(1),
  );
}

process.on('message', (message) => {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'acquire') {
    try {
      owner = acquireWriterExclusionSet(prepared, () => new Promise((resolve) => {
        releaseQuiesce = resolve;
        send('quiesce-started');
      }));
      send('acquired');
    } catch (reason) {
      send('acquire-error', { message: String(reason), code: reason && reason.code });
    }
    return;
  }
  if (message.type === 'close') {
    startClose();
    return;
  }
  if (message.type === 'close-again') {
    send('close-again-result', { samePromise: Boolean(owner && closePromise && owner.close() === closePromise) });
    return;
  }
  if (message.type === 'release-quiesce') {
    if (releaseQuiesce) releaseQuiesce();
    return;
  }
  if (message.type === 'exit-without-close') {
    process.exit(23);
    return;
  }
  if (message.type === 'shutdown') shutdown();
});

send('ready');
