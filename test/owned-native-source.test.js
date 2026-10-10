'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createOwnedNativeSource, getOwnedSource } = require('../src/server/owned-native-source');

const IDENTITY = Object.freeze({
  provider: 'codex',
  nativeIdKind: 'thread',
  hostId: 'host_test',
  homeScopeId: 'home_test',
  nativeId: 'thread_native_1',
});
const CONTEXT = Object.freeze({
  kind: 'turn',
  nativeContextId: 'turn_native_1',
  parentToolUseId: null,
});

function createSource(t, values = {}) {
  const claim = Object.freeze({});
  let calls = 0;
  let reader = values.readNativeCurrent || (async ({ requestToken }) => ({
    requestToken,
    identity: IDENTITY,
    context: CONTEXT,
    activity: 'inProgress',
  }));
  const created = createOwnedNativeSource({
    provider: values.provider || 'codex',
    hostId: 'host_test',
    homeScopeId: 'home_test',
    ownedSourceClaim: claim,
    readNativeCurrent: async (request, scope) => {
      calls += 1;
      return reader(request, scope);
    },
  });
  const facade = getOwnedSource(created.capability);
  const owner = claim;
  const connectionReceipt = Object.freeze({});
  assert.equal(created.controller.markReady(), true);
  assert.equal(facade.bindOwner(owner), true);
  const lease = facade.acquireReadLease(connectionReceipt);
  t.after(() => created.controller.invalidate());
  return {
    ...created,
    facade,
    owner,
    connectionReceipt,
    lease,
    calls: () => calls,
    setReader(value) { reader = value; },
  };
}

test('the opaque source capability exposes only one owner-bound readonly lease', (t) => {
  const source = createSource(t);
  const facade = source.facade;

  assert.equal(Object.isFrozen(source.capability), true);
  assert.equal(getOwnedSource({}), null);
  assert.equal(facade.bindOwner({}), false);
  assert.equal(facade.bindOwner(source.owner), true);
  assert.equal(facade.bindOwner(source.owner), true);
  assert.equal(facade.bindOwner({}), false);
  assert.equal(facade.checkSource(), true);
  assert.equal(facade.checkLease(source.lease), true);
  assert.equal(facade.acquireReadLease(Object.freeze({})), null);
  assert.deepEqual(Object.keys(facade).sort(), [
    'acquireReadLease', 'bindOwner', 'checkLease', 'checkSource', 'consumeReadReceipt',
    'hostId', 'homeScopeId', 'provider', 'readCurrent', 'releaseReadLease', 'subscribe', 'subscribeTerminal',
  ].sort());
});

test('a fresh same-context read receipt is frozen and consumable once', async (t) => {
  const source = createSource(t);
  source.controller.observeIdentity(IDENTITY, false);
  source.controller.observeContext(IDENTITY, CONTEXT, false);

  const result = await source.facade.readCurrent(source.lease);
  assert.equal(result.status, 'attested');
  assert.deepEqual(result.identity, IDENTITY);
  assert.deepEqual(result.context, CONTEXT);
  assert.equal(result.activity, 'inProgress');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.identity), true);
  assert.equal(Object.isFrozen(result.context), true);
  assert.deepEqual(Object.keys(result.receipt), []);
  assert.equal(source.facade.consumeReadReceipt(source.lease, result.receipt), true);
  assert.equal(source.facade.consumeReadReceipt(source.lease, result.receipt), false);
});

test('a newer read invalidates an unconsumed receipt and keeps only one request token', async (t) => {
  const source = createSource(t);
  source.controller.observeIdentity(IDENTITY, false);
  source.controller.observeContext(IDENTITY, CONTEXT, false);

  const first = await source.facade.readCurrent(source.lease);
  const second = await source.facade.readCurrent(source.lease);
  assert.equal(source.facade.consumeReadReceipt(source.lease, first.receipt), false);
  assert.equal(source.facade.consumeReadReceipt(source.lease, second.receipt), true);
  assert.equal(source.calls(), 2);
});

test('a context terminal survives lease detach and blocks the old context after reattach', async (t) => {
  const source = createSource(t);
  source.controller.observeIdentity(IDENTITY, false);
  source.controller.observeContext(IDENTITY, CONTEXT, false);
  const terminal = Object.freeze({ kind: 'turn', nativeContextId: CONTEXT.nativeContextId });
  const events = [];
  const unsubscribe = source.facade.subscribeTerminal(source.owner, (event) => events.push(event));

  assert.equal(source.facade.releaseReadLease(source.lease), true);
  assert.equal(source.controller.observeTerminal(IDENTITY, terminal), true);
  assert.equal(source.facade.checkSource(), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'context_ended');
  assert.equal(source.facade.subscribeTerminal(source.owner, (event) => events.push(event)) instanceof Function, true);
  assert.equal(events.length, 2);

  const nextLease = source.facade.acquireReadLease(Object.freeze({}));
  assert.ok(nextLease);
  assert.equal((await source.facade.readCurrent(nextLease)).status, 'unknown');
  assert.equal(source.facade.releaseReadLease(nextLease), true);
  assert.equal(unsubscribe(), true);
});

test('only the matched early-terminal path can retain an end before positive context', (t) => {
  const source = createSource(t);
  source.controller.observeIdentity(IDENTITY, false);
  const terminal = Object.freeze({ kind: 'turn', nativeContextId: CONTEXT.nativeContextId });
  const events = [];
  source.facade.subscribeTerminal(source.owner, (event) => events.push(event));

  assert.equal(source.controller.observeTerminal(IDENTITY, terminal), false);
  assert.equal(source.controller.observeEarlyTerminal(IDENTITY, terminal), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'context_ended');
  assert.equal(source.controller.observeContext(IDENTITY, CONTEXT), false);
  assert.equal(source.controller.observeEarlyTerminal(IDENTITY, terminal), false);
});

test('a read released during an in-flight native response cannot mint for a new lease', async (t) => {
  let finishRead;
  const source = createSource(t, {
    readNativeCurrent: ({ requestToken }) => new Promise((resolve) => {
      finishRead = () => resolve({ requestToken, identity: IDENTITY, context: CONTEXT, activity: 'inProgress' });
    }),
  });
  source.controller.observeIdentity(IDENTITY, false);
  source.controller.observeContext(IDENTITY, CONTEXT, false);
  const pending = source.facade.readCurrent(source.lease);
  assert.equal(source.facade.releaseReadLease(source.lease), true);
  const nextLease = source.facade.acquireReadLease(Object.freeze({}));
  finishRead();

  assert.equal((await pending).status, 'unknown');
  assert.equal(source.facade.checkLease(nextLease), true);
  assert.equal(source.facade.releaseReadLease(nextLease), true);
});

test('lease reentry while normalizing a native result prevents receipt issuance', async (t) => {
  let source;
  const sourceOptions = createSource(t, {
    readNativeCurrent: ({ requestToken }) => {
      const candidate = { requestToken, context: CONTEXT, activity: 'inProgress' };
      Object.defineProperty(candidate, 'identity', {
        enumerable: true,
        get() {
          source.facade.releaseReadLease(source.lease);
          return IDENTITY;
        },
      });
      return candidate;
    },
  });
  source = sourceOptions;
  source.controller.observeIdentity(IDENTITY, false);
  source.controller.observeContext(IDENTITY, CONTEXT, false);

  const result = await source.facade.readCurrent(source.lease);
  assert.equal(result.status, 'unknown');
  assert.equal(result.receipt, null);
  assert.equal(source.facade.checkLease(source.lease), false);
});

test('foreign receipt, foreign lease, and wrong provider metadata never attest', async (t) => {
  const first = createSource(t);
  const second = createSource(t);
  first.controller.observeIdentity(IDENTITY, false);
  first.controller.observeContext(IDENTITY, CONTEXT, false);
  second.controller.observeIdentity(IDENTITY, false);
  second.controller.observeContext(IDENTITY, CONTEXT, false);
  const result = await first.facade.readCurrent(first.lease);

  assert.equal(first.facade.consumeReadReceipt(second.lease, result.receipt), false);
  assert.equal(second.facade.consumeReadReceipt(second.lease, result.receipt), false);
  assert.equal(first.facade.checkLease(second.lease), false);
  first.controller.invalidate();
  assert.equal(first.facade.checkSource(), false);
  assert.equal(first.facade.consumeReadReceipt(first.lease, result.receipt), false);
});

test('Claude owned sources report unsupported and never invoke read transport', async (t) => {
  const source = createSource(t, { provider: 'claude', readNativeCurrent: () => { throw new Error('must not read'); } });
  const result = await source.facade.readCurrent(source.lease);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.receipt, null);
  assert.equal(source.calls(), 0);
});

test('read scope exposes only frozen registration functions and release cancels once', async (t) => {
  let scope;
  let cancellations = 0;
  let removedCallbacks = 0;
  const source = createSource(t, {
    readNativeCurrent: (request, value) => new Promise((resolve) => {
      scope = value;
      assert.equal(Object.isFrozen(request), true);
      assert.deepEqual(Object.keys(request).sort(), ['leaseToken', 'requestToken']);
      assert.equal(Object.isFrozen(scope), true);
      assert.deepEqual(Object.keys(scope).sort(), ['isCancelled', 'registerCancel']);
      assert.equal(Object.values(request.leaseToken).includes(scope), false);
      assert.equal(Object.values(request.leaseToken.source).includes(scope), false);
      assert.deepEqual(Object.keys(request.leaseToken).sort(), [
        'active', 'connectionReceipt', 'id', 'reading', 'requestToken', 'source', 'subscriptions',
      ].sort());
      assert.deepEqual(Object.keys(request.leaseToken.source).sort(), [
        'activeLease', 'claim', 'currentContext', 'currentIdentity', 'facade', 'homeScopeId',
        'hostId', 'invalidated', 'nextLeaseId', 'owner', 'provider', 'readNativeCurrent',
        'ready', 'terminalSubscribers', 'terminals',
      ].sort());
      const unsubscribe = scope.registerCancel(() => { removedCallbacks += 1; });
      unsubscribe();
      unsubscribe();
      scope.registerCancel(() => { throw new Error('isolated callback'); });
      scope.registerCancel(() => { cancellations += 1; resolve(null); });
    }),
  });
  const read = source.facade.readCurrent(source.lease);
  assert.equal(source.facade.releaseReadLease(source.lease), true);
  assert.equal(scope.isCancelled(), true);
  assert.equal(cancellations, 1);
  assert.equal(source.facade.releaseReadLease(source.lease), false);
  assert.equal((await read).status, 'unknown');
  assert.equal(removedCallbacks, 0);
  scope.registerCancel(() => { cancellations += 1; })();
  assert.equal(cancellations, 2);
});

test('synchronous release before read registration cancels late registration immediately', async (t) => {
  const source = createSource(t);
  source.controller.observeIdentity(IDENTITY);
  source.controller.observeContext(IDENTITY, CONTEXT);
  let notified = 0;
  let releaseResult;
  source.setReader((request, scope) => {
    releaseResult = source.facade.releaseReadLease(source.lease);
    const unsubscribe = scope.registerCancel(() => { notified += 1; });
    unsubscribe();
    unsubscribe();
    return { requestToken: request.requestToken, identity: IDENTITY, context: CONTEXT, activity: 'inProgress' };
  });
  assert.equal((await source.facade.readCurrent(source.lease)).status, 'unknown');
  assert.equal(notified, 1);
  assert.equal(releaseResult, true);
  assert.equal(source.facade.checkLease(source.lease), false);
});

test('old scope cancellation reentry cannot cancel a newly acquired lease read', async (t) => {
  const source = createSource(t);
  source.controller.observeIdentity(IDENTITY);
  source.controller.observeContext(IDENTITY, CONTEXT);
  let newLease;
  let newRead;
  let newScope;
  let finishNew;
  let finishOld;
  t.after(() => { finishOld?.(); finishNew?.(); });
  source.setReader((request, scope) => new Promise((resolve) => {
    finishOld = () => resolve(null);
    scope.registerCancel(() => {
      assert.equal(source.facade.checkLease(source.lease), false);
      newLease = source.facade.acquireReadLease(Object.freeze({}));
      source.setReader((nextRequest, nextScope) => new Promise((finish) => {
        newScope = nextScope;
        finishNew = () => finish({ requestToken: nextRequest.requestToken, identity: IDENTITY, context: CONTEXT, activity: 'inProgress' });
      }));
      newRead = source.facade.readCurrent(newLease);
      resolve(null);
    });
  }));
  const oldRead = source.facade.readCurrent(source.lease);
  source.facade.releaseReadLease(source.lease);
  assert.equal((await oldRead).status, 'unknown');
  assert.equal(newScope.isCancelled(), false);
  assert.equal(source.facade.checkLease(newLease), true);
  finishNew();
  const result = await newRead;
  assert.equal(result.status, 'attested');
  assert.equal(source.facade.consumeReadReceipt(newLease, result.receipt), true);
});

test('invalidate cancels all retained scopes after authority expires despite callback exceptions', async (t) => {
  const source = createSource(t);
  const scopes = [];
  const finishes = [];
  t.after(() => finishes.forEach((finish) => finish()));
  const notifications = [];
  const authorityAtNotification = [];
  source.setReader((request, scope) => new Promise((resolve) => {
    const index = scopes.length;
    scopes.push(scope);
    finishes.push(() => resolve(null));
    scope.registerCancel(() => { throw new Error('cancel callback'); });
    scope.registerCancel(() => {
      notifications.push(index);
      authorityAtNotification.push(source.facade.checkLease(index === 0 ? source.lease : nextLease));
    });
  }));
  const first = source.facade.readCurrent(source.lease);
  source.facade.releaseReadLease(source.lease);
  const nextLease = source.facade.acquireReadLease(Object.freeze({}));
  const second = source.facade.readCurrent(nextLease);
  assert.equal(source.controller.invalidate(), true);
  assert.equal(source.controller.invalidate(), false);
  assert.deepEqual(notifications, [0, 1]);
  assert.deepEqual(authorityAtNotification, [false, false]);
  assert.equal(scopes.every((scope) => scope.isCancelled()), true);
  finishes.forEach((finish) => finish());
  assert.equal((await first).status, 'unknown');
  assert.equal((await second).status, 'unknown');
});

test('normal read completion disposes callbacks without cancelling or invalidating its receipt', async (t) => {
  const source = createSource(t);
  let scope;
  let cancellations = 0;
  source.controller.observeIdentity(IDENTITY);
  source.controller.observeContext(IDENTITY, CONTEXT);
  source.setReader(({ requestToken }, value) => {
    scope = value;
    scope.registerCancel(() => { cancellations += 1; });
    return { requestToken, identity: IDENTITY, context: CONTEXT, activity: 'inProgress' };
  });
  const result = await source.facade.readCurrent(source.lease);
  assert.equal(scope.isCancelled(), false);
  assert.equal(source.facade.consumeReadReceipt(source.lease, result.receipt), true);
  scope.registerCancel(() => { cancellations += 1; });
  source.facade.releaseReadLease(source.lease);
  assert.equal(cancellations, 0);
});

test('a scope-ignoring reader remains pending after release until its own work settles', async (t) => {
  let finish;
  t.after(() => finish?.(null));
  let settled = false;
  const source = createSource(t, { readNativeCurrent: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = source.facade.readCurrent(source.lease).then((result) => { settled = true; return result; });
  source.facade.releaseReadLease(source.lease);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finish(null);
  assert.equal((await pending).status, 'unknown');
});
