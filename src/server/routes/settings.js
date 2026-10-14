const { jsonResponse, SECURITY_HEADERS } = require('../http-helpers');
const { isValidRouteUpdate } = require('../routing');
const { normalizeExternalUrl } = require('../request-validation');

function createSettingsRoutes(ctx) {
  const { state, away, routing, answerDelivery, openExternalUrl, updateChecker } = ctx;

  function handleAwayState({ response }) {
    jsonResponse(response, 200, away.snapshot());
  }

  async function handleAway({ request, response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    try {
      const snapshot = await away.setEnabled(body.enabled);
      if (!snapshot.enabled) answerDelivery.signalAll();
      jsonResponse(response, 200, snapshot);
    } catch (error) {
      request?.setDiagnosticError?.(error);
      jsonResponse(response, 500, { error: 'Internal Server Error' });
    }
  }

  async function handleRouting({ request, response, body }) {
    if (!isValidRouteUpdate(body)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    try {
      const snapshot = await routing.set(body.key, body.value);
      state.touch?.();
      jsonResponse(response, 200, snapshot);
    } catch (error) {
      request?.setDiagnosticError?.(error);
      jsonResponse(response, 500, { error: 'Internal Server Error' });
    }
  }

  async function handleOpenUrl({ request, response, info, body }) {
    const externalUrl = body && typeof body === 'object' && !Array.isArray(body)
      ? normalizeExternalUrl(body.url)
      : null;
    if (!externalUrl) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    try {
      await openExternalUrl(externalUrl);
      response.writeHead(204, SECURITY_HEADERS);
      response.end();
    } catch (error) {
      request?.setDiagnosticError?.(error);
      jsonResponse(response, 500, { error: 'Internal Server Error' });
    }
  }

  // 確認の時機は変えず、実行中の確認があればその結果を待つ(UpdateChecker.check の inFlight)。
  async function handleUpdateCheck({ request, response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    if (!updateChecker) {
      jsonResponse(response, 409, { error: 'update-check-disabled' });
      return;
    }
    try {
      jsonResponse(response, 200, await updateChecker.check());
    } catch (error) {
      request?.setDiagnosticError?.(error);
      jsonResponse(response, 500, { error: 'Internal Server Error' });
    }
  }

  return { handleAwayState, handleAway, handleRouting, handleOpenUrl, handleUpdateCheck };
}

module.exports = { createSettingsRoutes };
