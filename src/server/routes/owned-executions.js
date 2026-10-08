const { jsonResponse } = require('../http-helpers');
const { hasExactKeys, ownedExecutionProjection, validScopedIdentifier, validSessionId } = require('../request-validation');
const { OWNED_STOP_FIELDS } = require('../server-constants');

function createOwnedExecutionsRoutes(ctx) {
  const {
    stopOwnedExecution,
  } = ctx;

  async function handleOwnedExecutionStop({ response, body }) {
    if (!hasExactKeys(body, OWNED_STOP_FIELDS) || !validScopedIdentifier(body.launchRef) ||
        !validScopedIdentifier(body.executionId) || !validSessionId(body.sessionId) ||
        (body.expectedContextId !== null && !validScopedIdentifier(body.expectedContextId)) ||
        !Number.isSafeInteger(body.expectedOwnerGeneration) || body.expectedOwnerGeneration < 0 ||
        !Number.isSafeInteger(body.stopRevision) || body.stopRevision < 0) {
      jsonResponse(response, 400, { error: 'invalid_owned_stop_request' });
      return;
    }
    try {
      const result = await stopOwnedExecution(body);
      const ownedExecution = result?.ownedExecution === null ? null : ownedExecutionProjection(result?.ownedExecution);
      if (result?.status === 'stale') {
        jsonResponse(response, 409, { error: 'stale_owned_execution', ownedExecution });
        return;
      }
      if (!ownedExecution || !['stop_confirmed', 'stop_unconfirmed'].includes(result?.status) ||
          (result.status === 'stop_confirmed') !== ownedExecution.stopConfirmed) {
        jsonResponse(response, 503, { error: 'owned_execution_stop_unavailable' });
        return;
      }
      jsonResponse(response, 200, { status: result.status, ownedExecution });
    } catch (error) {
      jsonResponse(response, error?.code === 'invalid_owned_stop_request' ? 400 : 503,
        { error: error?.code === 'invalid_owned_stop_request' ? 'invalid_owned_stop_request' : 'owned_execution_stop_unavailable' });
    }
    return;
  }

  return { handleOwnedExecutionStop };
}

module.exports = { createOwnedExecutionsRoutes };
