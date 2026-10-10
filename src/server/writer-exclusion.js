const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const slotBasenames = Object.freeze({
  anchor: 'anchor.json',
  checkpoint: 'checkpoint.json',
  instructions: 'instructions.json',
  questions: 'questions.json',
});
const preparedFiles = new WeakMap();
const processReservations = new Map();

function prepareWriterExclusionFiles(root, slots) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('Writer exclusion root must be an absolute path');
  }
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new TypeError('Writer exclusion slots must be a non-empty array');
  }

  const seenSlots = new Set();
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    if (typeof slot !== 'string' || !Object.hasOwn(slotBasenames, slot)) {
      throw new TypeError('Writer exclusion slot is not supported');
    }
    if (seenSlots.has(slot)) throw new TypeError('Writer exclusion slots must be unique');
    seenSlots.add(slot);
  }

  const canonicalRoot = fs.realpathSync(root);
  if (!fs.statSync(canonicalRoot).isDirectory()) {
    throw new TypeError('Writer exclusion root must be an existing directory');
  }

  const orderedSlots = Object.keys(slotBasenames).filter((slot) => seenSlots.has(slot));
  const files = orderedSlots.map((slot) => {
    const markerPath = path.join(canonicalRoot, `${slotBasenames[slot]}.writer-exclusion`);
    return {
      markerPath,
      key: process.platform === 'win32' ? markerPath.toLowerCase() : markerPath,
    };
  });
  const capability = Object.freeze(Object.create(null));
  preparedFiles.set(capability, files);
  return capability;
}

function acquireWriterExclusionSet(prepared, quiesce) {
  const files = preparedFiles.get(prepared);
  if (!files) throw new TypeError('Writer exclusion preparation is invalid');
  if (typeof quiesce !== 'function') throw new TypeError('Writer exclusion quiesce must be a function');

  for (const file of files) {
    if (processReservations.has(file.key)) {
      const error = new Error('Writer exclusion set is already reserved in this process');
      error.code = 'ERR_WRITER_EXCLUSION_BUSY';
      throw error;
    }
  }

  const reservation = Object.freeze({});
  for (const file of files) processReservations.set(file.key, reservation);

  const ownedMarkers = [];
  const cleanupErrors = [];
  let hasPrimary = false;
  let primaryReason;
  let uncertainOutcome = false;
  let ownerNonce;

  const recordPrimary = (reason) => {
    if (hasPrimary) return;
    hasPrimary = true;
    primaryReason = reason;
  };

  const rollbackOwnedMarkers = () => {
    for (let index = ownedMarkers.length - 1; index >= 0; index -= 1) {
      const marker = ownedMarkers[index];
      if (!marker.closed) continue;
      try {
        const result = fs.unlinkSync(marker.file.markerPath);
        if (result !== undefined) {
          throw new TypeError('unlinkSync returned an unexpected result');
        }
      } catch (reason) {
        cleanupErrors.push(reason);
        uncertainOutcome = true;
      }
    }
  };

  try {
    ownerNonce = randomUUID();
    for (const file of files) {
      const metadata = Buffer.from(JSON.stringify({ version: 1, owner: ownerNonce }), 'utf8');
      let fd;
      try {
        fd = fs.openSync(file.markerPath, 'wx', 0o600);
      } catch (reason) {
        recordPrimary(reason);
        break;
      }

      if (!Number.isInteger(fd) || fd < 0) {
        recordPrimary(new TypeError('openSync returned an invalid descriptor'));
        uncertainOutcome = true;
        break;
      }

      const marker = { file, fd, closed: false };
      ownedMarkers.push(marker);
      let writeFailed = false;
      let offset = 0;

      while (offset < metadata.length) {
        let written;
        try {
          written = fs.writeSync(fd, metadata, offset, metadata.length - offset, null);
        } catch (reason) {
          recordPrimary(reason);
          writeFailed = true;
          break;
        }
        if (!Number.isInteger(written) || written <= 0 || written > metadata.length - offset) {
          recordPrimary(new TypeError('writeSync returned invalid byte progress'));
          writeFailed = true;
          break;
        }
        offset += written;
      }

      let closeReason;
      let closeFailed = false;
      try {
        const closeResult = fs.closeSync(fd);
        if (closeResult !== undefined) {
          closeReason = new TypeError('closeSync returned an unexpected result');
          closeFailed = true;
        } else {
          marker.closed = true;
        }
      } catch (reason) {
        closeReason = reason;
        closeFailed = true;
      }

      if (closeFailed) {
        if (!writeFailed) recordPrimary(closeReason);
        else cleanupErrors.push(closeReason);
        uncertainOutcome = true;
        break;
      }
      if (writeFailed) break;
    }

    if (!hasPrimary) {
      const owner = createOwner(files, ownedMarkers, reservation, quiesce);
      return owner;
    }
  } catch (reason) {
    recordPrimary(reason);
  }

  rollbackOwnedMarkers();
  if (!uncertainOutcome) {
    for (const file of files) {
      if (processReservations.get(file.key) === reservation) processReservations.delete(file.key);
    }
  }

  throw acquisitionFailure(primaryReason, cleanupErrors, uncertainOutcome);
}

function createOwner(files, ownedMarkers, reservation, quiesce) {
  let closePromise;

  const close = () => {
    if (closePromise) return closePromise;

    let resolveClose;
    let rejectClose;
    closePromise = new Promise((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    let quiesceResult;
    try {
      quiesceResult = quiesce();
    } catch (reason) {
      rejectClose(reason);
      return closePromise;
    }

    if (quiesceResult === closePromise) {
      rejectClose(new TypeError('Quiesce cannot await its own close promise'));
      return closePromise;
    }

    Promise.resolve(quiesceResult).then(
      () => {
        const unlinkErrors = [];
        for (let index = ownedMarkers.length - 1; index >= 0; index -= 1) {
          try {
            const result = fs.unlinkSync(ownedMarkers[index].file.markerPath);
            if (result !== undefined) {
              throw new TypeError('unlinkSync returned an unexpected result');
            }
          } catch (reason) {
            unlinkErrors.push(reason);
          }
        }

        if (unlinkErrors.length) {
          rejectClose(releaseFailure(unlinkErrors));
          return;
        }

        for (const file of files) {
          if (processReservations.get(file.key) === reservation) processReservations.delete(file.key);
        }
        resolveClose();
      },
      (reason) => {
        rejectClose(reason);
      },
    );

    return closePromise;
  };

  return Object.freeze({ close });
}

function acquisitionFailure(primaryReason, cleanupErrors, uncertainOutcome) {
  if (cleanupErrors.length === 0 && !uncertainOutcome) return primaryReason;
  const reasons = [primaryReason, ...cleanupErrors];
  return new AggregateError(reasons, 'Writer exclusion acquisition failed; process-local reservations are retained', {
    cause: primaryReason,
  });
}

function releaseFailure(unlinkErrors) {
  return new AggregateError(unlinkErrors, 'Writer exclusion release failed; process-local reservations are retained', {
    cause: unlinkErrors[0],
  });
}

module.exports = { prepareWriterExclusionFiles, acquireWriterExclusionSet };
