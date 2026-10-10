'use strict';

const accessors = new WeakMap();
const controls = new WeakMap();

function isWeakKey(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function getOwnedNativeCollectorControl(value) {
  return isWeakKey(value) ? controls.get(value) || null : null;
}

function aliasOwnedNativeCollectorControl(source, alias) {
  const control = getOwnedNativeCollectorControl(source);
  if (!control || !isWeakKey(alias)) return false;
  const existing = controls.get(alias);
  if (existing) return existing === control;
  controls.set(alias, control);
  return true;
}

function createOwnedSourceAccessor(binding) {
  const accessor = Object.freeze(() => undefined);
  accessors.set(accessor, binding);
  return accessor;
}

function createOwnedNativeSourceCollector(options, sanitizeSnapshot) {
  if (Object.keys(options).some((key) => !['ownedSourceAccessor', 'onObservation'].includes(key)) ||
      (options.onObservation !== undefined && typeof options.onObservation !== 'function')) throw new TypeError('owned collector options are invalid');
  const binding = accessors.get(options.ownedSourceAccessor);
  if (!binding || binding.reserve() !== true) throw new TypeError('owned source is already claimed or unavailable');
  let loan = null;
  let connecting = null;
  let connectingRecord = null;
  let epoch = 0;
  let generation = 0;
  let state = 'disconnected';
  let observation = null;
  let admissionStopped = false;
  let everStarted = false;
  let ticketAcquirer = null;
  const operations = new Set();

  function operationCurrent(operation) {
    return !admissionStopped && epoch === operation.epoch;
  }

  function connectCurrent(operation) {
    return operationCurrent(operation) && connectingRecord === operation;
  }

  function beginOperation(kind, rejectedResult, execute, hooks = {}) {
    const operationEpoch = epoch;
    let resolveResult;
    let rejectResult;
    let resolveSettled;
    const resultPromise = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    resultPromise.catch(() => {});
    const operation = {
      kind,
      epoch: operationEpoch,
      settled: new Promise((resolve) => { resolveSettled = resolve; }),
    };
    operations.add(operation);
    everStarted = true;
    let release = () => {};
    let finished = false;

    function complete(error, result, failed = false) {
      if (finished) return;
      finished = true;
      let finalError = error;
      try {
        const releaseResult = release();
        if (releaseResult && typeof releaseResult.then === 'function') {
          Promise.resolve(releaseResult).catch(() => {});
          throw new TypeError('owned collector ticket release must be synchronous');
        }
      } catch (releaseError) {
        if (!failed) {
          failed = true;
          finalError = releaseError;
        }
      } finally {
        try { hooks.onSettled?.(operation); }
        catch (settleError) {
          if (!failed) {
            failed = true;
            finalError = settleError;
          }
        }
        operations.delete(operation);
        resolveSettled();
      }
      if (failed) rejectResult(finalError);
      else resolveResult(operationCurrent(operation) ? result : rejectedResult);
    }

    try { hooks.onRegistered?.(operation, resultPromise); }
    catch (error) { complete(error, undefined, true); return resultPromise; }

    try {
      const acquiredRelease = ticketAcquirer ? ticketAcquirer(kind) : () => {};
      if (typeof acquiredRelease !== 'function') throw new TypeError('owned collector ticket acquirer must return a release function');
      release = acquiredRelease;
    } catch (error) {
      complete(error, undefined, true);
      return resultPromise;
    }

    if (!operationCurrent(operation)) {
      complete(null, rejectedResult);
      return resultPromise;
    }

    let work;
    try { work = execute(operation); }
    catch (error) { complete(error, undefined, true); return resultPromise; }
    Promise.resolve(work).then(
      (result) => complete(null, result),
      (error) => complete(error, undefined, true),
    );
    return resultPromise;
  }

  function unknownSnapshot(metadata) {
    const publicObservation = observation ? {
      ...observation,
      status: 'unknown',
      activity: observation.activity || 'unknown',
      turnState: observation.turnState || 'unknown',
      reason: observation.reason || 'current_proof_unavailable',
      pendingRequests: [],
    } : null;
    return sanitizeSnapshot({
      version: 1,
      provider: metadata.provider,
      scope: metadata.scope,
      connection: { state: 'unknown', generation, providerVersion: null },
      capabilities: {
        loadedList: metadata.provider === 'codex' ? 'supported' : 'unsupported',
        threadRead: metadata.provider === 'codex' ? 'supported' : 'unsupported',
        resume: 'unsupported',
        serverRequests: 'unsupported',
      },
      observations: publicObservation ? [publicObservation] : [],
    });
  }

  function publish(activity, reason, expected = {}) {
    if (admissionStopped) return false;
    const expectedEpoch = expected.epoch ?? epoch;
    const expectedLoan = Object.hasOwn(expected, 'loan') ? expected.loan : loan;
    const hasExpectedConnecting = Object.hasOwn(expected, 'connecting');
    const isCurrent = () => !admissionStopped && epoch === expectedEpoch && loan === expectedLoan &&
      (!hasExpectedConnecting || connectingRecord === expected.connecting);
    if (!isCurrent()) return false;
    const metadata = binding.metadata();
    if (!isCurrent() || !metadata.identity || !metadata.registration) return false;
    const proof = expectedLoan ? binding.proof(expectedLoan) : null;
    if (!isCurrent()) return false;
    observation = {
      observationId: 'owned-' + generation,
      nativeId: metadata.identity.nativeId,
      conversationId: metadata.registration.conversationId,
      executionId: metadata.registration.executionId,
      sessionId: metadata.registration.sessionId,
      status: proof ? activity : 'unknown',
      activity: proof ? activity : observation?.activity || 'unknown',
      turnState: proof ? activity : observation?.turnState || 'unknown',
      turnId: proof ? metadata.contextId : observation?.turnId || null,
      pendingRequests: [],
      reason: proof ? reason : reason || 'current_proof_unavailable',
    };
    if (options.onObservation && isCurrent()) {
      try { options.onObservation(Object.freeze({ ...observation, pendingRequests: [] })); } catch {}
    }
    return isCurrent();
  }

  function onNative(event) {
    if (admissionStopped) return;
    const expectedEpoch = epoch;
    const capturedLoan = loan;
    if (!capturedLoan || binding.current(capturedLoan) !== true ||
        admissionStopped || epoch !== expectedEpoch || loan !== capturedLoan) return;
    publish(event.type === 'context' ? 'active' : 'unknown',
      event.type === 'context_ended' ? 'native_context_ended' : null,
      { epoch: expectedEpoch, loan: capturedLoan });
  }

  function onDetach(detachedLoan, reason = 'owned_source_detached') {
    if (admissionStopped || loan !== detachedLoan) return;
    epoch += 1;
    loan = null;
    state = 'disconnected';
    connecting = null;
    connectingRecord = null;
    publish('unknown', reason, { epoch, loan: null, connecting: null });
  }

  function isConnectionCurrent(operation, capturedLoan) {
    return connectCurrent(operation) && loan === capturedLoan;
  }

  function connect() {
    if (admissionStopped) return Promise.resolve({ status: 'unknown', reason: 'owned_source_admission_stopped' });
    if (connecting) return connecting;

    const rejectedResult = { status: 'unknown', reason: 'connection_epoch_changed' };
    return beginOperation('connect', rejectedResult, async (operation) => {
      if (!connectCurrent(operation)) return rejectedResult;
      const existingLoan = loan;
      if (existingLoan) {
        const current = binding.current(existingLoan) === true;
        if (!connectCurrent(operation) || loan !== existingLoan) return rejectedResult;
        if (current) return { status: 'connected', generation };
      }

      state = 'connecting';
      let attached;
      try { attached = binding.attach(onNative, onDetach); }
      catch {
        if (connectCurrent(operation)) state = 'unknown';
        return { status: 'unknown', reason: 'owned_source_unavailable' };
      }

      let result;
      try { result = await attached; }
      catch {
        if (connectCurrent(operation)) state = 'unknown';
        return { status: 'unknown', reason: 'owned_source_unavailable' };
      }
      if (!connectCurrent(operation)) {
        if (result) binding.detach(result);
        return rejectedResult;
      }
      if (!result) {
        state = 'unknown';
        return { status: 'unknown', reason: 'owned_source_unavailable' };
      }

      const current = binding.current(result) === true;
      if (!connectCurrent(operation)) {
        if (result) binding.detach(result);
        return rejectedResult;
      }
      if (!current) {
        state = 'unknown';
        binding.detach(result);
        return { status: 'unknown', reason: 'owned_source_unavailable' };
      }
      loan = result;
      generation += 1;
      state = 'connected';
      publish('active', null, { epoch: operation.epoch, loan: result, connecting: operation });
      if (!isConnectionCurrent(operation, result)) return rejectedResult;
      const stillCurrent = binding.current(result) === true;
      if (!isConnectionCurrent(operation, result) || !stillCurrent) return rejectedResult;
      return { status: 'connected', generation };
    }, {
      onRegistered(operation, promise) {
        connecting = promise;
        connectingRecord = operation;
      },
      onSettled(operation) {
        if (connectingRecord === operation) {
          connecting = null;
          connectingRecord = null;
        }
      },
    });
  }

  function observeKnownThreadCore(nativeId, operation) {
    return (async () => {
      if (!operationCurrent(operation)) return { status: 'unknown', reason: 'connection_epoch_changed' };
      const captured = loan;
      const metadata = binding.metadata();
      if (!operationCurrent(operation) || loan !== captured) return { status: 'unknown', reason: 'connection_epoch_changed' };
      if (!metadata.identity || nativeId !== metadata.identity.nativeId || !captured) {
        return { status: 'unknown', reason: 'owned_source_unavailable' };
      }
      const isCurrent = () => operationCurrent(operation) && loan === captured;
      const currentBeforeRead = binding.current(captured) === true;
      if (!isCurrent()) return { status: 'unknown', reason: 'connection_epoch_changed' };
      if (!currentBeforeRead) return { status: 'unknown', reason: 'owned_source_unavailable' };
      const result = await binding.read(captured);
      if (!isCurrent()) return { status: 'unknown', reason: 'connection_epoch_changed' };
      publish(result.status === 'observed' ? result.activity : 'unknown', result.reason || null,
        { epoch: operation.epoch, loan: captured });
      if (!isCurrent()) return { status: 'unknown', reason: 'connection_epoch_changed' };
      const proof = binding.proof(captured);
      if (!isCurrent()) return { status: 'unknown', reason: 'connection_epoch_changed' };
      const currentAfterProof = binding.current(captured) === true;
      if (!isCurrent() || !currentAfterProof) return { status: 'unknown', reason: 'connection_epoch_changed' };
      return {
        status: result.status === 'unsupported' ? 'unsupported' : proof ? 'observed' : 'unknown',
        reason: result.reason || (proof ? null : 'current_proof_unavailable'),
        observation: observation ? { ...observation, pendingRequests: [] } : null,
      };
    })();
  }

  function observeKnownThread(nativeId) {
    const rejectedResult = { status: 'unknown', reason: 'connection_epoch_changed' };
    if (admissionStopped) return Promise.resolve({ status: 'unknown', reason: 'owned_source_admission_stopped' });
    return beginOperation('observe', rejectedResult,
      (operation) => observeKnownThreadCore(nativeId, operation));
  }

  function resolveProofCore(launchRef, expectedEpoch = epoch) {
    if (admissionStopped || launchRef !== binding.launchRef || !loan) return null;
    const captured = loan;
    const proof = binding.proof(captured);
    if (admissionStopped || epoch !== expectedEpoch || loan !== captured || !proof) return null;
    const current = binding.current(captured) === true;
    return !admissionStopped && epoch === expectedEpoch && loan === captured && current ? proof : null;
  }

  function resolveProof(launchRef) {
    return resolveProofCore(launchRef);
  }

  function reconcileProof(launchRef) {
    if (admissionStopped) return Promise.resolve(false);
    return beginOperation('reconcile', false, async (operation) => {
      if (!operationCurrent(operation) || launchRef !== binding.launchRef) return false;
      const metadata = binding.metadata();
      if (!operationCurrent(operation) || !metadata.identity) return false;
      await observeKnownThreadCore(metadata.identity.nativeId, operation);
      if (!operationCurrent(operation)) return false;
      return Boolean(resolveProofCore(launchRef, operation.epoch));
    });
  }

  async function disconnect() {
    const changed = state !== 'disconnected' || loan !== null || connecting !== null;
    epoch += 1;
    const captured = loan;
    loan = null;
    state = 'disconnected';
    connecting = null;
    connectingRecord = null;
    if (captured) binding.detach(captured);
    else binding.cancelPending();
    if (changed) publish('unknown', 'owned_source_detached', { epoch, loan: null, connecting: null });
    return { status: 'disconnected' };
  }

  function snapshot() {
    const expectedEpoch = epoch;
    const capturedLoan = loan;
    const metadata = binding.metadata();
    const stillSame = () => epoch === expectedEpoch && loan === capturedLoan;
    if (admissionStopped || !stillSame()) return unknownSnapshot(metadata);
    let proof = null;
    if (capturedLoan) {
      proof = binding.proof(capturedLoan);
      if (admissionStopped || !stillSame()) return unknownSnapshot(metadata);
    }
    let current = false;
    if (capturedLoan) {
      current = binding.current(capturedLoan) === true;
      if (admissionStopped || !stillSame()) return unknownSnapshot(metadata);
    }
    const publicObservation = observation && !proof
      ? { ...observation, status: 'unknown', reason: observation.reason || 'current_proof_unavailable' }
      : observation;
    return sanitizeSnapshot({
      version: 1, provider: metadata.provider, scope: metadata.scope,
      connection: {
        state: current ? state : state === 'connected' ? 'unknown' : state,
        generation,
        providerVersion: null,
      },
      capabilities: {
        loadedList: metadata.provider === 'codex' ? 'supported' : 'unsupported',
        threadRead: metadata.provider === 'codex' ? 'supported' : 'unsupported',
        resume: 'unsupported',
        serverRequests: 'unsupported',
      },
      observations: publicObservation ? [{ ...publicObservation, pendingRequests: [] }] : [],
    });
  }

  function stopAdmission() {
    if (admissionStopped) return false;
    admissionStopped = true;
    epoch += 1;
    return true;
  }

  function drain() {
    if (!admissionStopped) throw new Error('owned collector admission must stop before drain');
    return Promise.all([...operations].map((operation) => operation.settled)).then(() => undefined);
  }

  function bindTicketAcquirer(acquirer) {
    if (typeof acquirer !== 'function') throw new TypeError('owned collector ticket acquirer must be a function');
    if (admissionStopped || everStarted || ticketAcquirer) return false;
    ticketAcquirer = acquirer;
    return true;
  }

  const facade = Object.freeze({
    connect,
    disconnect,
    close: disconnect,
    observeKnownThread,
    resolveProof,
    reconcileProof,
    resumeKnownThread: async () => ({ status: 'unsupported', reason: 'owned_source_resume_unsupported' }),
    snapshot,
  });
  const control = Object.freeze({ bindTicketAcquirer, stopAdmission, drain });
  controls.set(facade, control);
  return facade;
}

module.exports = {
  createOwnedSourceAccessor,
  createOwnedNativeSourceCollector,
  getOwnedNativeCollectorControl,
  aliasOwnedNativeCollectorControl,
};
