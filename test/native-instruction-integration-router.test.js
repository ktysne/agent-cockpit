'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNativeInstructionOwnerRouter } = require('../src/server/native-instruction-service-integration');

function createOwner(provider, launchRef, capability = Object.freeze({}), prepareHook = null, checkHook = null) {
  const calls = [];
  const evidenceListeners = new Set();
  const ack = Promise.resolve({ launchRef });
  const owner = Object.freeze({
    prepareInstructionDispatch(metadata) {
      calls.push(['prepare', metadata.source.launchRef]);
      if (prepareHook) return prepareHook(metadata, capability);
      return metadata.source.claims.provider === provider && metadata.source.launchRef === launchRef
        ? capability
        : null;
    },
    checkInstructionDispatch(receivedCapability, metadata) {
      calls.push(['check', receivedCapability, metadata.source.launchRef]);
      if (checkHook) return checkHook(receivedCapability, metadata, capability);
      return receivedCapability === capability &&
        metadata.source.claims.provider === provider &&
        metadata.source.launchRef === launchRef;
    },
    dispatchInstructionNow(receivedCapability, command) {
      calls.push(['dispatch', receivedCapability, command.source.launchRef]);
      if (receivedCapability !== capability || command.source.launchRef !== launchRef) {
        throw new Error('foreign native instruction capability');
      }
      return ack;
    },
    subscribeInstructionEvidence(listener) {
      evidenceListeners.add(listener);
      return () => evidenceListeners.delete(listener);
    },
  });
  return {
    owner,
    capability,
    ack,
    calls,
    evidenceListeners,
    emit(receivedCapability, evidence) {
      for (const listener of [...evidenceListeners]) listener(receivedCapability, evidence);
    },
  };
}

function createComposition(owners) {
  return Object.freeze({
    createInstructionOwner(receipt) {
      const owner = owners.get(receipt);
      if (!owner) throw new Error('admission receipt unavailable');
      return owner;
    },
  });
}

function makeReceipt() {
  return Object.freeze({});
}

function makeMetadata(provider, launchRef, deliveryAttemptId = 'attempt-' + launchRef, revision = 0) {
  return Object.freeze({
    deliveryAttemptId,
    revision,
    payloadDigest: 'a'.repeat(64),
    nativeContentDigest: 'b'.repeat(64),
    source: Object.freeze({
      launchRef,
      claims: Object.freeze({ provider }),
    }),
    target: Object.freeze({}),
    mode: 'steer',
    expectedTurnId: 'turn-a',
  });
}

function createRouter(ownersByReceipt, provider = 'claude') {
  return createNativeInstructionOwnerRouter({
    provider,
    composition: createComposition(ownersByReceipt),
  });
}

test('observation closure checks the exact capability metadata and admission before reaching an owner', () => {
  const receipt = makeReceipt(); const legacy = createOwner('claude', 'launch-a'); const closed = [];
  let closeListener; let closes = 0;
  const owner = { ...legacy.owner, subscribeInstructionClosed(listener) { closeListener = listener; return () => {}; },
    closeInstructionObservation(capability) { closes += 1; assert.equal(capability, legacy.capability); return true; } };
  const router = createRouter(new Map([[receipt, owner]])); router.attachAdmission(receipt);
  router.subscribeInstructionClosed((capability, reason) => closed.push({ capability, reason }));
  const metadata = makeMetadata('claude', 'launch-a'); const capability = router.prepareInstructionDispatch(metadata);
  assert.equal(router.supportsLateInstructionEvidence(capability), true);
  assert.equal(router.closeInstructionObservation({}, metadata), false);
  assert.equal(router.closeInstructionObservation(capability, { ...metadata, deliveryAttemptId: 'different' }), false);
  closeListener({}, 'instruction_context_ended'); assert.equal(closed.length, 0);
  closeListener(capability, 'instruction_context_ended'); assert.equal(closed.length, 1);
  assert.equal(router.closeInstructionObservation(capability, metadata), true);
  assert.equal(router.closeInstructionObservation(capability, metadata), false); assert.equal(closes, 1);
  closeListener(capability, 'instruction_context_ended'); assert.equal(closed.length, 1);
  router.close();
});

test('provider router fixes an opaque capability to its originating owner', () => {
  const receiptA = makeReceipt();
  const receiptB = makeReceipt();
  const ownerA = createOwner('claude', 'launch-a');
  const ownerB = createOwner('claude', 'launch-b');
  const router = createRouter(new Map([[receiptA, ownerA.owner], [receiptB, ownerB.owner]]));
  router.attachAdmission(receiptA);
  router.attachAdmission(receiptB);

  const metadataB = makeMetadata('claude', 'launch-b');
  const capability = router.prepareInstructionDispatch(metadataB);
  assert.equal(capability, ownerB.capability);
  assert.deepEqual(ownerA.calls, [['prepare', 'launch-b']]);
  assert.deepEqual(ownerB.calls, [['prepare', 'launch-b']]);
  assert.equal(router.checkInstructionDispatch(capability, metadataB), true);
  assert.deepEqual(ownerB.calls[1], ['check', capability, 'launch-b']);
  assert.equal(ownerA.calls.some(([method]) => method === 'check'), false);
  router.close();
});

test('provider mismatch and cloned or foreign capabilities fail closed', () => {
  const receipt = makeReceipt();
  const owner = createOwner('claude', 'launch-a');
  const router = createRouter(new Map([[receipt, owner.owner]]));
  router.attachAdmission(receipt);

  assert.equal(router.prepareInstructionDispatch(makeMetadata('codex', 'launch-a')), null);
  assert.deepEqual(owner.calls, []);
  const capability = router.prepareInstructionDispatch(makeMetadata('claude', 'launch-a'));
  assert.equal(router.checkInstructionDispatch(Object.freeze({}), makeMetadata('claude', 'launch-a')), false);
  assert.throws(() => router.dispatchInstructionNow(Object.freeze({}), {
    source: { launchRef: 'launch-a' },
  }), { code: 'instruction_dispatch_unavailable' });
  assert.equal(router.checkInstructionDispatch(capability, makeMetadata('claude', 'launch-a')), true);

  const foreignReceipt = makeReceipt();
  const foreignOwner = createOwner('claude', 'launch-b');
  const foreignRouter = createRouter(new Map([[foreignReceipt, foreignOwner.owner]]));
  foreignRouter.attachAdmission(foreignReceipt);
  const foreignCapability = foreignRouter.prepareInstructionDispatch(makeMetadata('claude', 'launch-b'));
  assert.equal(router.checkInstructionDispatch(foreignCapability, makeMetadata('claude', 'launch-b')), false);
  assert.throws(() => router.dispatchInstructionNow(foreignCapability, {
    source: { launchRef: 'launch-b' },
  }), { code: 'instruction_dispatch_unavailable' });
  router.close();
  foreignRouter.close();
});

test('reentrant detach or close during check cannot return authorization', () => {
  for (const action of ['detach', 'close']) {
    const receipt = makeReceipt();
    let router;
    const owner = createOwner('claude', 'launch-a', Object.freeze({}), null,
      () => {
        if (action === 'detach') router.detachAdmission(receipt);
        else router.close();
        return true;
      });
    router = createRouter(new Map([[receipt, owner.owner]]));
    router.attachAdmission(receipt);
    const metadata = makeMetadata('claude', 'launch-a');
    const capability = router.prepareInstructionDispatch(metadata);

    assert.equal(router.checkInstructionDispatch(capability, metadata), false);
    assert.equal(owner.calls.filter(([method]) => method === 'check').length, 1);
    router.close();
  }
});

test('dispatch returns the original promise and evidence follows only the mapped capability', async () => {
  const receiptA = makeReceipt();
  const receiptB = makeReceipt();
  const ownerA = createOwner('claude', 'launch-a');
  const ownerB = createOwner('claude', 'launch-b');
  const router = createRouter(new Map([[receiptA, ownerA.owner], [receiptB, ownerB.owner]]));
  router.attachAdmission(receiptA);
  router.attachAdmission(receiptB);

  const evidence = [];
  router.subscribeInstructionEvidence((capability, value) => {
    evidence.push([capability, value]);
    return true;
  });
  const metadataB = makeMetadata('claude', 'launch-b');
  const capability = router.prepareInstructionDispatch(metadataB);
  const command = { source: metadataB.source, input: ['hello'] };
  const result = router.dispatchInstructionNow(capability, command);
  assert.equal(result, ownerB.ack);
  assert.deepEqual(ownerB.calls[ownerB.calls.length - 1], ['dispatch', capability, 'launch-b']);
  assert.equal(ownerA.calls.some(([method]) => method === 'dispatch'), false);

  const acceptedEvidence = Object.freeze({ marker: 'matching capability' });
  ownerB.emit(capability, acceptedEvidence);
  ownerA.emit(capability, Object.freeze({ marker: 'foreign owner' }));
  assert.deepEqual(evidence, [[capability, acceptedEvidence]]);
  router.close();
  await result;
});

test('prepare rejects metadata fields outside the body-free contract', () => {
  const receipt = makeReceipt();
  const owner = createOwner('claude', 'launch-a');
  const router = createRouter(new Map([[receipt, owner.owner]]));
  router.attachAdmission(receipt);
  const metadata = Object.freeze({
    ...makeMetadata('claude', 'launch-a'),
    input: ['instruction body'],
  });

  assert.equal(router.prepareInstructionDispatch(metadata), null);
  assert.deepEqual(owner.calls, []);
  router.close();
});

test('same owner and identical metadata retain an idempotent capability', () => {
  const receipt = makeReceipt();
  const owner = createOwner('claude', 'launch-a');
  const router = createRouter(new Map([[receipt, owner.owner]]));
  router.attachAdmission(receipt);
  const metadata = makeMetadata('claude', 'launch-a');

  const first = router.prepareInstructionDispatch(metadata);
  const second = router.prepareInstructionDispatch(metadata);
  assert.equal(second, first);
  assert.equal(router.checkInstructionDispatch(first, metadata), true);
  assert.equal(owner.calls.filter(([method]) => method === 'prepare').length, 2);
  router.close();
});

test('same owner capability with different metadata is retired', () => {
  const receipt = makeReceipt();
  const capability = Object.freeze({});
  const owner = createOwner('claude', 'launch-a', capability, () => capability);
  const router = createRouter(new Map([[receipt, owner.owner]]));
  router.attachAdmission(receipt);
  const metadata = makeMetadata('claude', 'launch-a');

  assert.equal(router.prepareInstructionDispatch(metadata), capability);
  assert.equal(router.prepareInstructionDispatch(makeMetadata('claude', 'launch-a', 'attempt-other')), null);
  assert.equal(router.checkInstructionDispatch(capability, metadata), false);
  router.close();
});

test('reused or cross-owner aliased capability is retired', () => {
  const receiptA = makeReceipt();
  const receiptB = makeReceipt();
  const sharedCapability = Object.freeze({});
  const ownerA = createOwner('claude', 'launch-a', sharedCapability);
  const ownerB = createOwner('claude', 'launch-b', sharedCapability);
  const router = createRouter(new Map([[receiptA, ownerA.owner], [receiptB, ownerB.owner]]));

  router.attachAdmission(receiptA);
  router.attachAdmission(receiptB);
  const metadataA = makeMetadata('claude', 'launch-a');
  assert.equal(router.prepareInstructionDispatch(metadataA), sharedCapability);
  assert.equal(router.prepareInstructionDispatch(makeMetadata('claude', 'launch-b')), null);
  assert.equal(router.checkInstructionDispatch(sharedCapability, metadataA), false);
  assert.throws(() => router.dispatchInstructionNow(sharedCapability, {
    source: metadataA.source,
    input: ['hello'],
  }), { code: 'instruction_dispatch_unavailable' });
  assert.equal(ownerA.calls.some(([method]) => method === 'dispatch'), false);
  assert.equal(ownerB.calls.some(([method]) => method === 'dispatch'), false);
  router.close();
});

test('prepare rejects promises and thenables without invoking their then property', async () => {
  const receiptPromise = makeReceipt();
  const rejected = Promise.reject(new Error('prepare rejected'));
  const promiseOwner = createOwner('claude', 'launch-promise', Object.freeze({}),
    () => rejected);
  const promiseRouter = createRouter(new Map([[receiptPromise, promiseOwner.owner]]));
  promiseRouter.attachAdmission(receiptPromise);
  assert.equal(promiseRouter.prepareInstructionDispatch(makeMetadata('claude', 'launch-promise')), null);
  await Promise.resolve();
  promiseRouter.close();

  const receiptThenable = makeReceipt();
  let thenReads = 0;
  const thenable = Object.freeze({
    get then() {
      thenReads += 1;
      return () => {};
    },
  });
  const thenableOwner = createOwner('claude', 'launch-thenable', Object.freeze({}),
    () => thenable);
  const thenableRouter = createRouter(new Map([[receiptThenable, thenableOwner.owner]]));
  thenableRouter.attachAdmission(receiptThenable);
  assert.equal(thenableRouter.prepareInstructionDispatch(makeMetadata('claude', 'launch-thenable')), null);
  assert.equal(thenReads, 0);
  thenableRouter.close();
});

test('detach during prepare cannot return or revive a capability', () => {
  const receipt = makeReceipt();
  let router;
  const capability = Object.freeze({});
  const owner = createOwner('claude', 'launch-a', capability, () => {
    router.detachAdmission(receipt);
    return capability;
  });
  router = createRouter(new Map([[receipt, owner.owner]]));
  router.attachAdmission(receipt);

  assert.equal(router.prepareInstructionDispatch(makeMetadata('claude', 'launch-a')), null);
  assert.equal(router.checkInstructionDispatch(capability, makeMetadata('claude', 'launch-a')), false);
  assert.throws(() => router.dispatchInstructionNow(capability, {
    source: { launchRef: 'launch-a' },
  }), { code: 'instruction_dispatch_unavailable' });
  assert.throws(() => router.attachAdmission(receipt), { code: 'admission_already_detached' });
  assert.equal(owner.evidenceListeners.size, 0);
  router.close();
});

test('close during prepare cannot return a capability', () => {
  const receipt = makeReceipt();
  let router;
  const capability = Object.freeze({});
  const owner = createOwner('claude', 'launch-a', capability, () => {
    router.close();
    return capability;
  });
  router = createRouter(new Map([[receipt, owner.owner]]));

  router.attachAdmission(receipt);
  assert.equal(router.prepareInstructionDispatch(makeMetadata('claude', 'launch-a')), null);
  assert.equal(owner.evidenceListeners.size, 0);
  assert.equal(router.checkInstructionDispatch(capability, makeMetadata('claude', 'launch-a')), false);
});

test('reentrant detach during evidence stops the remaining listeners', () => {
  const receipt = makeReceipt();
  const owner = createOwner('claude', 'launch-a');
  const router = createRouter(new Map([[receipt, owner.owner]]));
  router.attachAdmission(receipt);
  const capability = router.prepareInstructionDispatch(makeMetadata('claude', 'launch-a'));
  const seen = [];
  router.subscribeInstructionEvidence(() => {
    seen.push('first');
    router.detachAdmission(receipt);
    return true;
  });
  router.subscribeInstructionEvidence(() => {
    seen.push('second');
    return true;
  });

  owner.emit(capability, { marker: 'input evidence' });
  assert.deepEqual(seen, ['first']);
  assert.equal(owner.evidenceListeners.size, 0);
  router.close();
});

test('reentrant close during evidence stops the remaining listeners', () => {
  const receipt = makeReceipt();
  const owner = createOwner('claude', 'launch-a');
  const router = createRouter(new Map([[receipt, owner.owner]]));
  router.attachAdmission(receipt);
  const capability = router.prepareInstructionDispatch(makeMetadata('claude', 'launch-a'));
  const seen = [];
  router.subscribeInstructionEvidence(() => {
    seen.push('first');
    router.close();
    return true;
  });
  router.subscribeInstructionEvidence(() => {
    seen.push('second');
    return true;
  });

  owner.emit(capability, { marker: 'input evidence' });
  assert.deepEqual(seen, ['first']);
  assert.equal(owner.evidenceListeners.size, 0);
  assert.equal(router.checkInstructionDispatch(capability, makeMetadata('claude', 'launch-a')), false);
});

test('close unsubscribes owners and disables existing capabilities', () => {
  const receiptA = makeReceipt();
  const receiptB = makeReceipt();
  const ownerA = createOwner('claude', 'launch-a');
  const ownerB = createOwner('claude', 'launch-b');
  const router = createRouter(new Map([[receiptA, ownerA.owner], [receiptB, ownerB.owner]]));
  const detachA = router.attachAdmission(receiptA);
  assert.equal(router.attachAdmission(receiptA), detachA);
  router.attachAdmission(receiptB);

  const capabilityA = router.prepareInstructionDispatch(makeMetadata('claude', 'launch-a'));
  assert.equal(router.detachAdmission(receiptA), true);
  assert.equal(router.checkInstructionDispatch(capabilityA, makeMetadata('claude', 'launch-a')), false);
  assert.throws(() => router.dispatchInstructionNow(capabilityA, {
    source: { launchRef: 'launch-a' },
  }), { code: 'instruction_dispatch_unavailable' });
  assert.equal(ownerA.evidenceListeners.size, 0);

  const capabilityB = router.prepareInstructionDispatch(makeMetadata('claude', 'launch-b'));
  const observed = [];
  router.subscribeInstructionEvidence((capability, value) => observed.push([capability, value]));
  router.close();
  assert.equal(router.checkInstructionDispatch(capabilityB, makeMetadata('claude', 'launch-b')), false);
  assert.throws(() => router.dispatchInstructionNow(capabilityB, {
    source: { launchRef: 'launch-b' },
  }), { code: 'instruction_dispatch_unavailable' });
  assert.equal(ownerB.evidenceListeners.size, 0);
  assert.equal(router.prepareInstructionDispatch(makeMetadata('claude', 'launch-b')), null);
  ownerB.emit(capabilityB, { marker: 'late' });
  assert.deepEqual(observed, []);
});
