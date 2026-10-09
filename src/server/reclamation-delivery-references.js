'use strict';

const { createHash } = require('node:crypto');

const CLAIM_FIELDS = [
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding',
];

function cloneNormalizedJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const result = [];
    Object.defineProperty(result, 'toJSON', { value: null });
    for (const item of value) result.push(cloneNormalizedJson(item));
    return result;
  }
  const result = Object.create(null);
  for (const key of Object.keys(value)) result[key] = cloneNormalizedJson(value[key]);
  return result;
}

function claimsDigest(claims) {
  const orderedClaims = Object.create(null);
  for (const field of CLAIM_FIELDS) orderedClaims[field] = claims[field];
  return createHash('sha256').update(JSON.stringify(cloneNormalizedJson(orderedClaims)), 'utf8').digest('hex');
}

function sourceReference(source) {
  return {
    launchRef: source.launchRef,
    launchKey: [source.claims.launchId, source.claims.runId, source.claims.attemptId],
    sourceClaimsDigest: claimsDigest(source.claims),
    identity: cloneNormalizedJson(source.identity),
    executionBinding: cloneNormalizedJson(source.executionBinding),
    conversationId: source.conversationId,
    sessionId: source.sessionId,
  };
}

function targetReference(target) {
  if (target.kind === 'owner') {
    return {
      kind: 'owner',
      launchRef: null,
      launchKey: null,
      targetClaimsDigest: null,
      identity: cloneNormalizedJson(target.identity),
      periodId: target.periodId,
      actor: cloneNormalizedJson(target.actor),
      conversationId: target.conversationId,
      sessionId: target.sessionId,
    };
  }
  return {
    kind: 'execution',
    launchRef: target.launchRef,
    launchKey: [target.claims.launchId, target.claims.runId, target.claims.attemptId],
    targetClaimsDigest: claimsDigest(target.claims),
    identity: cloneNormalizedJson(target.identity),
    periodId: target.periodId,
    actor: cloneNormalizedJson(target.actor),
    conversationId: target.conversationId,
    sessionId: target.sessionId,
  };
}

function projectNormalizedDeliveryReferences(detail) {
  if (!detail || detail.recordType !== 'detail') {
    const error = new TypeError('delivery_references_require_detail');
    error.code = 'delivery_references_require_detail';
    throw error;
  }
  return {
    sourceRef: sourceReference(detail.source),
    targetRef: targetReference(detail.target),
  };
}

module.exports = { projectNormalizedDeliveryReferences };
