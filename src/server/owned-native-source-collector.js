'use strict';

const accessors = new WeakMap();

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
  let epoch = 0;
  let generation = 0;
  let state = 'disconnected';
  let observation = null;

  function publish(activity, reason) {
    const metadata = binding.metadata();
    if (!metadata.identity || !metadata.registration) return;
    const proof = loan && binding.proof(loan);
    observation = {
      observationId: `owned-${generation}`,
      nativeId: metadata.identity.nativeId,
      conversationId: metadata.registration.conversationId,
      executionId: metadata.registration.executionId,
      sessionId: metadata.registration.sessionId,
      status: proof ? activity : 'unknown',
      activity: proof ? activity : observation?.activity || 'unknown',
      turnState: proof ? activity : observation?.turnState || 'unknown',
      turnId: proof ? metadata.contextId : observation?.turnId || null,
      pendingRequests: [], reason: proof ? reason : reason || 'current_proof_unavailable',
    };
    if (options.onObservation) {
      try { options.onObservation(Object.freeze({ ...observation, pendingRequests: [] })); } catch {}
    }
  }

  function onNative(event) {
    if (!loan || binding.current(loan) !== true) return;
    publish(event.type === 'context' ? 'active' : 'unknown', event.type === 'context_ended' ? 'native_context_ended' : null);
  }

  function onDetach(detachedLoan, reason = 'owned_source_detached') {
    if (loan !== detachedLoan) return;
    epoch += 1;
    loan = null;
    state = 'disconnected';
    publish('unknown', reason);
  }

  function connect() {
    if (loan && binding.current(loan) === true) return Promise.resolve({ status: 'connected', generation });
    if (connecting) return connecting;
    const expectedEpoch = epoch;
    state = 'connecting';
    let attached;
    try { attached = binding.attach(onNative, onDetach); }
    catch { state = 'unknown'; return Promise.resolve({ status: 'unknown', reason: 'owned_source_unavailable' }); }
    const adopt = (result) => {
      if (expectedEpoch !== epoch) { if (result) binding.detach(result); return { status: 'unknown', reason: 'connection_epoch_changed' }; }
      if (!result || binding.current(result) !== true) { state = 'unknown'; return { status: 'unknown', reason: 'owned_source_unavailable' }; }
      loan = result;
      generation += 1;
      state = 'connected';
      publish('active', null);
      return expectedEpoch === epoch && loan === result && binding.current(result) === true
        ? { status: 'connected', generation } : { status: 'unknown', reason: 'connection_epoch_changed' };
    };
    if (attached && typeof attached.then !== 'function') return Promise.resolve(adopt(attached));
    connecting = Promise.resolve(attached).then(adopt)
      .catch(() => { state = 'unknown'; return { status: 'unknown', reason: 'owned_source_unavailable' }; })
      .finally(() => { connecting = null; });
    return connecting;
  }

  async function observeKnownThread(nativeId) {
    const metadata = binding.metadata();
    const captured = loan;
    if (!metadata.identity || nativeId !== metadata.identity.nativeId || !captured || binding.current(captured) !== true) return { status: 'unknown', reason: 'owned_source_unavailable' };
    const expectedEpoch = epoch;
    const result = await binding.read(captured);
    if (expectedEpoch !== epoch || loan !== captured || binding.current(captured) !== true) return { status: 'unknown', reason: 'connection_epoch_changed' };
    publish(result.status === 'observed' ? result.activity : 'unknown', result.reason || null);
    const proof = binding.proof(captured);
    if (expectedEpoch !== epoch || loan !== captured || binding.current(captured) !== true) return { status: 'unknown', reason: 'connection_epoch_changed' };
    return { status: result.status === 'unsupported' ? 'unsupported' : proof ? 'observed' : 'unknown', reason: result.reason || (proof ? null : 'current_proof_unavailable'), observation: observation ? { ...observation, pendingRequests: [] } : null };
  }

  function resolveProof(launchRef) {
    return launchRef === binding.launchRef && loan ? binding.proof(loan) : null;
  }

  async function reconcileProof(launchRef) {
    if (launchRef !== binding.launchRef) return false;
    const metadata = binding.metadata();
    if (!metadata.identity) return false;
    await observeKnownThread(metadata.identity.nativeId);
    return Boolean(resolveProof(launchRef));
  }

  async function disconnect() {
    const changed = state !== 'disconnected' || loan !== null;
    epoch += 1;
    const captured = loan;
    loan = null;
    state = 'disconnected';
    if (captured) binding.detach(captured);
    else binding.cancelPending();
    if (changed) publish('unknown', 'owned_source_detached');
    return { status: 'disconnected' };
  }

  function snapshot() {
    const metadata = binding.metadata();
    const proof = loan && binding.proof(loan);
    const publicObservation = observation && !proof ? { ...observation, status: 'unknown', reason: observation.reason || 'current_proof_unavailable' } : observation;
    return sanitizeSnapshot({
      version: 1, provider: metadata.provider, scope: metadata.scope,
      connection: { state: loan && binding.current(loan) === true ? state : state === 'connected' ? 'unknown' : state, generation, providerVersion: null },
      capabilities: { loadedList: metadata.provider === 'codex' ? 'supported' : 'unsupported', threadRead: metadata.provider === 'codex' ? 'supported' : 'unsupported', resume: 'unsupported', serverRequests: 'unsupported' },
      observations: publicObservation ? [{ ...publicObservation, pendingRequests: [] }] : [],
    });
  }

  return Object.freeze({ connect, disconnect, close: disconnect, observeKnownThread, resolveProof, reconcileProof,
    resumeKnownThread: async () => ({ status: 'unsupported', reason: 'owned_source_resume_unsupported' }), snapshot });
}

module.exports = { createOwnedSourceAccessor, createOwnedNativeSourceCollector };
