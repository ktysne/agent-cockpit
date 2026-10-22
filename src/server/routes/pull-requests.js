const { jsonResponse } = require('../http-helpers');
const { isCompleteCommitSha, isSha256Digest, validRepositoryPart } = require('../pull-request-utils');
const { applyReviewSkip, pullRequestStateUnavailable } = require('./review-skip');

function createPullRequestRoutes(ctx) {
  const { state, pullRequestTracker, pullRequestMergeManager } = ctx;

  async function handlePullRequestRefresh({ response }) {
    const result = await pullRequestTracker.refreshAllByUser();
    jsonResponse(response, 200, result);
  }

  async function handleReviewSkip({ request, response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'action,headRefOid,registration_key' ||
      !['set', 'clear'].includes(body.action) || !isSha256Digest(body.registration_key) ||
      !isCompleteCommitSha(body.headRefOid)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const registration = state.pullRequestRegistrationByKey(body.registration_key);
    if (!registration) {
      jsonResponse(response, 404, { error: 'Registered pull request not found' });
      return;
    }
    if (body.action === 'set') {
      const result = await applyReviewSkip({
        pullRequestTracker,
        pullRequestMergeManager,
        registration,
        headRefOid: body.headRefOid,
        reason: '開発者がダッシュボードでこの head のレビューを不要と判断した',
      });
      if (!result.ok) {
        jsonResponse(response, result.status, { error: result.error });
        return;
      }
      jsonResponse(response, 200, { action: body.action, number: registration.number });
      return;
    }
    if (pullRequestStateUnavailable(pullRequestTracker)) {
      jsonResponse(response, 503, { error: 'Pull request state is unavailable' });
      return;
    }
    if (!pullRequestMergeManager?.reviewSkipCandidate) {
      jsonResponse(response, 503, { error: 'Pull request state is unavailable' });
      return;
    }
    try {
      const candidate = await pullRequestMergeManager.reviewSkipCandidate(registration);
      if (candidate.refreshFailed) {
        jsonResponse(response, 502, { error: 'PR の状態を取り直せませんでした' });
        return;
      }
      if (candidate.error) {
        jsonResponse(response, 409, { error: 'PR はオープンではありません' });
        return;
      }
      if (candidate.pullRequest.headRefOid.toLowerCase() !== body.headRefOid.toLowerCase()) {
        jsonResponse(response, 409, { error: 'PR の head が変わりました。現在の状態を確認してください' });
        return;
      }
      if (!state.clearCrossReviewSkip(registration.owner, registration.repo, registration.number, candidate.pullRequest.headRefOid)) {
        jsonResponse(response, 409, { error: 'Review skip is no longer active' });
        return;
      }
      await state.flushStoreWrite();
      await state.waitForPersistence();
      await pullRequestTracker.refreshReviewGroups(registration.owner, registration.repo);
      jsonResponse(response, 200, { action: body.action, number: registration.number });
    } catch (error) {
      request?.setDiagnosticError?.(error);
      jsonResponse(response, 502, { error: 'PR の状態を取り直せませんでした' });
    }
  }

  async function handlePullRequestAction({ response, params, body }) {
    const action = params[1];
    const isConflictRequest = action === 'conflict-request';
    const expectedFields = isConflictRequest ? ['headRefOid', 'key'] : action === 'cancel-reservation'
      ? ['number', 'registration_key']
      : ['deleteBranch', 'headRefOid', 'method', 'number', 'registration_key'];
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== expectedFields.join(',') ||
      (isConflictRequest
        ? (!isSha256Digest(body.key) || typeof body.headRefOid !== 'string' || body.headRefOid.length > 64)
        : (!Number.isSafeInteger(body.number) || body.number < 1 || !isSha256Digest(body.registration_key) ||
          (action !== 'cancel-reservation' && (typeof body.headRefOid !== 'string' || body.headRefOid.length > 64 ||
            typeof body.method !== 'string' || typeof body.deleteBranch !== 'boolean'))))) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const result = isConflictRequest
      ? await pullRequestMergeManager.requestConflictResolution(body)
      : action === 'merge'
        ? await pullRequestMergeManager.merge(body)
        : action === 'reserve'
          ? await pullRequestMergeManager.reserve(body)
          : await pullRequestMergeManager.cancelReservation(body);
    await state.waitForPersistence();
    jsonResponse(response, result.ok ? 200 : result.status, result.ok ? result : { error: result.error });
  }

  async function handleRepositoryUnregister({ response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'owner,repo' ||
      !validRepositoryPart(body.owner) || !validRepositoryPart(body.repo)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const deleted = await pullRequestTracker.unregisterUnknownRepository(body.owner, body.repo);
    if (deleted) await state.flushStoreWrite();
    await state.waitForPersistence();
    jsonResponse(response, 200, { deleted });
  }

  async function handleMergeResultClose({ response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'number,owner,repo' ||
      !validRepositoryPart(body.owner) || !validRepositoryPart(body.repo) ||
      !Number.isSafeInteger(body.number) || body.number < 1) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const closed = state.closeAutomaticPullRequestMergeResult(body.owner, body.repo, body.number);
    if (closed === null) {
      jsonResponse(response, 404, { error: 'Automatic pull request merge result not found' });
      return;
    }
    await state.waitForPersistence?.();
    jsonResponse(response, 200, { closed: true });
  }

  return { handlePullRequestRefresh, handleReviewSkip, handlePullRequestAction, handleMergeResultClose, handleRepositoryUnregister };
}

module.exports = { createPullRequestRoutes };
