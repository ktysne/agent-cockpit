'use strict';

const { createRegistrationKernel } = require('../../src/server/conversation-registry');
const { createProviderRegistrationAdapter } = require('../../src/server/provider-registration');

function createRegistrationFixture(provider, options = {}) {
  const nativeIdentity = {
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: options.hostId || 'test-host',
    homeScopeId: options.homeScopeId || 'test-home',
    nativeId: options.nativeId || `${provider}-native-id`,
  };
  const identity = { provider, ...nativeIdentity };
  const kernel = createRegistrationKernel();
  const adapter = createProviderRegistrationAdapter(provider, kernel.registry, kernel.authority);
  const startId = options.startId || `${provider}-start`;
  const evidence = {
    evidenceId: `${startId}-evidence`,
    source: 'test-verifier',
    method: 'authenticated-fixture',
    adapterVersion: 'test',
    runtimeVersion: 'test',
    capabilities: ['native-binding'],
  };
  const registration = adapter.register(nativeIdentity, evidence, {
    startId,
    ...(provider === 'claude' ? { projectionId: nativeIdentity.nativeId } : {}),
  });
  const contextId = options.contextId || `${startId}-context`;
  const writer = adapter.bindWriter(registration.executionId, {
    identity,
    contextId,
    evidence: { ...evidence, evidenceId: `${startId}-binding` },
  });
  const nativeContext = { ...identity, contextId };

  return {
    ...kernel,
    adapter,
    identity,
    nativeIdentity,
    nativeContext,
    registration,
    writer,
    evidence,
    startId,
  };
}

module.exports = { createRegistrationFixture };
