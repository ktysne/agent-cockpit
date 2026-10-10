'use strict';

const { MAX_INSTRUCTION_DISPATCHES } = require('./owned-native-instruction-writer');
const MAX_SOURCE_TERMINALS = MAX_INSTRUCTION_DISPATCHES + 1;

const SOURCE_CAPABILITIES = new WeakMap();
const READ_LEASES = new WeakMap();
const READ_RECEIPTS = new WeakMap();

function isOpaque(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !value.startsWith('-');
}

function freezeIdentity(value, provider, hostId, homeScopeId) {
  const nativeIdKind = provider === 'codex' ? 'thread' : 'session';
  if (!hasExactKeys(value, ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']) ||
      value.provider !== provider || value.nativeIdKind !== nativeIdKind ||
      value.hostId !== hostId || value.homeScopeId !== homeScopeId || !isIdentifier(value.nativeId)) {
    return null;
  }
  return Object.freeze({
    provider,
    nativeIdKind,
    hostId,
    homeScopeId,
    nativeId: value.nativeId,
  });
}

function freezeContext(value, provider, terminal = false) {
  const keys = terminal
    ? ['kind', 'nativeContextId']
    : ['kind', 'nativeContextId', 'parentToolUseId'];
  const kind = provider === 'codex' ? 'turn' : 'assistant_message';
  if (!hasExactKeys(value, keys) || value.kind !== kind || !isIdentifier(value.nativeContextId) ||
      (!terminal && value.parentToolUseId !== null)) {
    return null;
  }
  return terminal
    ? Object.freeze({ kind, nativeContextId: value.nativeContextId })
    : Object.freeze({ kind, nativeContextId: value.nativeContextId, parentToolUseId: null });
}

function sameIdentity(left, right) {
  return Boolean(left && right &&
    left.provider === right.provider &&
    left.nativeIdKind === right.nativeIdKind &&
    left.hostId === right.hostId &&
    left.homeScopeId === right.homeScopeId &&
    left.nativeId === right.nativeId);
}

function sameContext(left, right) {
  return Boolean(left && right &&
    left.kind === right.kind &&
    left.nativeContextId === right.nativeContextId &&
    left.parentToolUseId === right.parentToolUseId);
}

function unknownResult(status = 'unknown') {
  return Object.freeze({
    status,
    identity: null,
    context: null,
    activity: 'unknown',
    receipt: null,
  });
}

function createOwnedNativeSource(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['provider', 'hostId', 'homeScopeId', 'ownedSourceClaim', 'readNativeCurrent'].includes(key)) ||
      !['codex', 'claude'].includes(options.provider) ||
      !isIdentifier(options.hostId) || !isIdentifier(options.homeScopeId) ||
      !isOpaque(options.ownedSourceClaim) || typeof options.readNativeCurrent !== 'function') {
    throw new TypeError('invalid owned source');
  }

  const source = {
    provider: options.provider,
    hostId: options.hostId,
    homeScopeId: options.homeScopeId,
    claim: options.ownedSourceClaim,
    readNativeCurrent: options.readNativeCurrent,
    ready: false,
    invalidated: false,
    owner: null,
    currentIdentity: null,
    currentContext: null,
    activeLease: null,
    nextLeaseId: 1,
    terminals: new Map(),
    terminalSubscribers: new Set(),
  };
  const capability = Object.freeze(Object.create(null));
  SOURCE_CAPABILITIES.set(capability, source);
  const readScopes = new Set();
  const leaseReadScopes = new WeakMap();

  function createReadScope(leaseRecord) {
    let cancelled = false;
    let disposed = false;
    const callbacks = new Set();
    const notify = (callback) => { try { callback(); } catch {} };
    const scope = {
      capability: Object.freeze({
        registerCancel(callback) {
          if (typeof callback !== 'function') return () => {};
          if (cancelled) { notify(callback); return () => {}; }
          if (disposed) return () => {};
          const registration = { callback };
          callbacks.add(registration);
          return () => callbacks.delete(registration);
        },
        isCancelled() { return cancelled; },
      }),
      cancel() {
        if (cancelled || disposed) return;
        cancelled = true;
        const pending = [...callbacks];
        callbacks.clear();
        for (const registration of pending) notify(registration.callback);
      },
      dispose() {
        disposed = true;
        callbacks.clear();
        readScopes.delete(scope);
        leaseReadScopes.get(leaseRecord)?.delete(scope);
      },
    };
    let scopes = leaseReadScopes.get(leaseRecord);
    if (!scopes) { scopes = new Set(); leaseReadScopes.set(leaseRecord, scopes); }
    scopes.add(scope);
    readScopes.add(scope);
    return scope;
  }

  function checkSource() {
    return source.ready && !source.invalidated;
  }

  function isLeaseRecordCurrent(leaseRecord) {
    return checkSource() && leaseRecord?.source === source &&
      leaseRecord.active && source.activeLease === leaseRecord;
  }

  function sameCapture(identity, context) {
    return sameIdentity(source.currentIdentity, identity) &&
      sameContext(source.currentContext, context) &&
      !source.terminals.has(identity.nativeId + '\u0000' + context.nativeContextId);
  }

  function makeEvent(type, identity, context) {
    return Object.freeze({ type, provider: source.provider, identity, context });
  }

  function recordTerminal(identity, context, allowMissingCurrentContext) {
    if (!identity || !context || source.invalidated || !sameIdentity(source.currentIdentity, identity)) return false;
    if (allowMissingCurrentContext) {
      if (source.currentContext !== null) return false;
    } else if (!source.currentContext || source.currentContext.nativeContextId !== context.nativeContextId) {
      return false;
    }
    const key = identity.nativeId + '\u0000' + context.nativeContextId;
    if (source.terminals.has(key) || source.terminals.size >= MAX_SOURCE_TERMINALS) return false;
    const event = makeEvent('context_ended', identity, context);
    source.terminals.set(key, event);
    deliver(source.terminalSubscribers, event, (subscription) =>
      subscription.active && subscription.ownerToken === source.owner);
    return true;
  }

  function deliver(subscribers, event, stillCurrent) {
    for (const subscription of [...subscribers]) {
      if (!stillCurrent(subscription)) continue;
      try { subscription.callback(event); } catch {}
    }
  }

  const facade = Object.freeze({
    provider: source.provider,
    hostId: source.hostId,
    homeScopeId: source.homeScopeId,

    bindOwner(ownerToken) {
      if (ownerToken !== source.claim || !isOpaque(ownerToken) || source.invalidated) return false;
      if (source.owner && source.owner !== ownerToken) return false;
      source.owner = ownerToken;
      return true;
    },

    acquireReadLease(connectionReceipt) {
      if (!source.owner || !isOpaque(connectionReceipt) || !checkSource() || source.activeLease) return null;
      const lease = Object.freeze(Object.create(null));
      const leaseRecord = {
        source,
        id: source.nextLeaseId,
        connectionReceipt,
        active: true,
        reading: false,
        subscriptions: new Set(),
        requestToken: null,
      };
      source.nextLeaseId += 1;
      READ_LEASES.set(lease, leaseRecord);
      source.activeLease = leaseRecord;
      return lease;
    },

    async readCurrent(lease) {
      const leaseRecord = READ_LEASES.get(lease);
      if (!isLeaseRecordCurrent(leaseRecord)) return unknownResult();
      if (source.provider !== 'codex') return unknownResult('unsupported');
      if (leaseRecord.reading) return unknownResult();
      leaseRecord.reading = true;
      const requestToken = Object.freeze(Object.create(null));
      leaseRecord.requestToken = requestToken;
      const readScope = createReadScope(leaseRecord);
      let receiptIssued = false;
      try {
        const candidate = await source.readNativeCurrent(Object.freeze({
          leaseToken: leaseRecord,
          requestToken,
        }), readScope.capability);
        if (readScope.capability.isCancelled() || !isLeaseRecordCurrent(leaseRecord) ||
            !candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
            !hasExactKeys(candidate, ['requestToken', 'identity', 'context', 'activity']) ||
            candidate.requestToken !== requestToken ||
            leaseRecord.requestToken !== requestToken ||
            candidate.activity !== 'inProgress') {
          return unknownResult();
        }
        const identity = freezeIdentity(candidate.identity, source.provider, source.hostId, source.homeScopeId);
        const context = freezeContext(candidate.context, source.provider);
        if (!identity || !context || !isLeaseRecordCurrent(leaseRecord) ||
            leaseRecord.requestToken !== requestToken || !sameCapture(identity, context)) return unknownResult();
        const receipt = Object.freeze(Object.create(null));
        READ_RECEIPTS.set(receipt, {
          source,
          leaseRecord,
          identity,
          context,
          activity: candidate.activity,
          used: false,
          requestToken,
        });
        receiptIssued = true;
        return Object.freeze({
          status: 'attested',
          identity,
          context,
          activity: 'inProgress',
          receipt,
        });
      } catch {
        return unknownResult();
      } finally {
        readScope.dispose();
        leaseRecord.reading = false;
        if (!receiptIssued && leaseRecord.requestToken === requestToken) leaseRecord.requestToken = null;
      }
    },

    consumeReadReceipt(lease, receipt) {
      const leaseRecord = READ_LEASES.get(lease);
      const receiptRecord = READ_RECEIPTS.get(receipt);
      if (!receiptRecord || receiptRecord.source !== source || receiptRecord.leaseRecord !== leaseRecord ||
          receiptRecord.used || !leaseRecord || leaseRecord.requestToken !== receiptRecord.requestToken ||
          !isLeaseRecordCurrent(leaseRecord)) return false;
      receiptRecord.used = true;
      leaseRecord.requestToken = null;
      return isLeaseRecordCurrent(leaseRecord) && sameCapture(receiptRecord.identity, receiptRecord.context) &&
        receiptRecord.activity === 'inProgress' &&
        receiptRecord.requestToken !== null;
    },

    subscribe(lease, callback) {
      const leaseRecord = READ_LEASES.get(lease);
      if (!isLeaseRecordCurrent(leaseRecord) || typeof callback !== 'function') return () => {};
      const subscription = { leaseRecord, callback, active: true };
      leaseRecord.subscriptions.add(subscription);
      return () => {
        if (!subscription.active) return false;
        subscription.active = false;
        leaseRecord.subscriptions.delete(subscription);
        return true;
      };
    },

    releaseReadLease(lease) {
      const leaseRecord = READ_LEASES.get(lease);
      if (!leaseRecord || leaseRecord.source !== source || !leaseRecord.active ||
          source.activeLease !== leaseRecord) return false;
      leaseRecord.active = false;
      leaseRecord.requestToken = null;
      for (const subscription of leaseRecord.subscriptions) subscription.active = false;
      leaseRecord.subscriptions.clear();
      source.activeLease = null;
      for (const scope of [...(leaseReadScopes.get(leaseRecord) || [])]) scope.cancel();
      return true;
    },

    checkLease(lease) {
      return isLeaseRecordCurrent(READ_LEASES.get(lease));
    },

    checkSource,

    subscribeTerminal(ownerToken, callback) {
      if (ownerToken !== source.owner || !source.owner || typeof callback !== 'function') return () => {};
      const subscription = { ownerToken, callback, active: true };
      source.terminalSubscribers.add(subscription);
      for (const event of source.terminals.values()) {
        if (!subscription.active || source.owner !== ownerToken) break;
        try { callback(event); } catch {}
      }
      return () => {
        if (!subscription.active) return false;
        subscription.active = false;
        source.terminalSubscribers.delete(subscription);
        return true;
      };
    },
  });

  const controller = Object.freeze({
    capability,
    markReady() {
      if (source.invalidated || source.ready) return false;
      source.ready = true;
      return true;
    },
    invalidate() {
      if (source.invalidated) return false;
      source.invalidated = true;
      source.ready = false;
      if (source.activeLease) {
        source.activeLease.active = false;
        source.activeLease.requestToken = null;
        for (const subscription of source.activeLease.subscriptions) subscription.active = false;
        source.activeLease.subscriptions.clear();
        source.activeLease = null;
      }
      for (const subscription of source.terminalSubscribers) subscription.active = false;
      source.terminalSubscribers.clear();
      for (const scope of [...readScopes]) scope.cancel();
      return true;
    },
    observeIdentity(value) {
      const identity = freezeIdentity(value, source.provider, source.hostId, source.homeScopeId);
      if (!identity || source.invalidated) return false;
      if (source.currentIdentity && !sameIdentity(source.currentIdentity, identity)) return false;
      source.currentIdentity = identity;
      return true;
    },
    deliverIdentity(value) {
      const identity = freezeIdentity(value, source.provider, source.hostId, source.homeScopeId);
      if (!identity || source.invalidated || !sameIdentity(source.currentIdentity, identity) || !source.activeLease) return false;
      const event = makeEvent('identity', identity, null);
      deliver(source.activeLease.subscriptions, event, (subscription) =>
        subscription.active && isLeaseRecordCurrent(subscription.leaseRecord));
      return true;
    },
    observeContext(identityValue, value) {
      const identity = freezeIdentity(identityValue, source.provider, source.hostId, source.homeScopeId);
      const context = freezeContext(value, source.provider);
      if (!identity || !context || source.invalidated ||
          !sameIdentity(source.currentIdentity, identity) ||
          (source.currentContext && !sameContext(source.currentContext, context)) ||
          source.terminals.has(identity.nativeId + '\u0000' + context.nativeContextId)) return false;
      source.currentContext = context;
      return true;
    },
    deliverContext(identityValue, value) {
      const identity = freezeIdentity(identityValue, source.provider, source.hostId, source.homeScopeId);
      const context = freezeContext(value, source.provider);
      if (!identity || !context || source.invalidated || !source.activeLease ||
          !sameIdentity(source.currentIdentity, identity) || !sameContext(source.currentContext, context)) return false;
      const event = makeEvent('context', identity, context);
      deliver(source.activeLease.subscriptions, event, (subscription) =>
        subscription.active && isLeaseRecordCurrent(subscription.leaseRecord));
      return true;
    },
    observeTerminal(identityValue, value) {
      const identity = freezeIdentity(identityValue, source.provider, source.hostId, source.homeScopeId);
      const context = freezeContext(value, source.provider, true);
      return recordTerminal(identity, context, false);
    },
    observeEarlyTerminal(identityValue, value) {
      const identity = freezeIdentity(identityValue, source.provider, source.hostId, source.homeScopeId);
      const context = freezeContext(value, source.provider, true);
      return recordTerminal(identity, context, true);
    },
    beginInstructionContext(terminalId) {
      if (!checkSource() || !source.currentIdentity || !source.currentContext ||
          source.currentContext.nativeContextId !== terminalId ||
          !source.terminals.has(source.currentIdentity.nativeId + '\u0000' + terminalId)) return false;
      source.currentContext = null;
      return true;
    },
    captureInstructionLease() { return source.activeLease; },
    isLeaseTokenCurrent(leaseToken) {
      return Boolean(leaseToken && leaseToken.source === source && isLeaseRecordCurrent(leaseToken));
    },
  });

  source.facade = facade;
  return Object.freeze({ capability, facade, controller });
}

function getOwnedSource(capability) {
  const source = SOURCE_CAPABILITIES.get(capability);
  return source ? source.facade : null;
}

module.exports = { createOwnedNativeSource, getOwnedSource };
