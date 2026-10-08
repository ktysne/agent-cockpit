const { isValidRouteUpdate } = require('../routing');
const { SECURITY_HEADERS, jsonResponse } = require('../http-helpers');
const { normalizeExternalUrl } = require('../request-validation');

function createSettingsRoutes(ctx) {
  const {
    answerDelivery, away, openExternalUrl, questionService,
    routing, state,
  } = ctx;

  async function handleAwayState({ response }) {
    jsonResponse(response, 200, away.snapshot());
    return;
  }

  async function handleAway({ request, response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    try {
      const snapshot = await away.setEnabled(body.enabled);
      if (!snapshot.enabled) answerDelivery.signalAll();
      if (typeof questionService?.notifyAwayChanged === 'function') {
        try { void Promise.resolve(questionService.notifyAwayChanged()).catch(() => {}); } catch {}
      }
      jsonResponse(response, 200, snapshot);
    } catch {
      jsonResponse(response, 500, { error: 'Internal Server Error' });
    }
    return;
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
    } catch {
      jsonResponse(response, 500, { error: 'Internal Server Error' });
    }
    return;
  }

  async function handleOpenUrl({ request, response, info, body }) {
    const externalUrl = body && typeof body === 'object' && !Array.isArray(body)
      ? normalizeExternalUrl(body.url, info.port)
      : null;
    if (!externalUrl) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    try {
      await openExternalUrl(externalUrl);
      response.writeHead(204, SECURITY_HEADERS);
      response.end();
    } catch {
      jsonResponse(response, 500, { error: 'Internal Server Error' });
    }
    return;
  }

  return { handleAwayState, handleAway, handleRouting, handleOpenUrl };
}

module.exports = { createSettingsRoutes };
