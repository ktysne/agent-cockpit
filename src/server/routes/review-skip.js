const UNAVAILABLE = Object.freeze({ ok: false, status: 503, error: 'Pull request state is unavailable' });

function pullRequestStateUnavailable(pullRequestTracker) {
  return !pullRequestTracker?.refreshRepoFresh || !pullRequestTracker.mergeCandidate;
}

// 応答は書かず、setReviewSkip の結果か、依存が揃わないときの 503 を返す。
// 登録が無いときの 404、例外の扱い、成功時の応答の形は呼び出し側が決める。
async function applyReviewSkip({ pullRequestTracker, pullRequestMergeManager, registration, headRefOid, reason }) {
  if (pullRequestStateUnavailable(pullRequestTracker) || !pullRequestMergeManager?.setReviewSkip) return UNAVAILABLE;
  return pullRequestMergeManager.setReviewSkip(registration, headRefOid, reason);
}

async function applyReviewDeferral({ pullRequestTracker, pullRequestMergeManager, registration, headRefOid, reason, next }) {
  if (pullRequestStateUnavailable(pullRequestTracker) || !pullRequestMergeManager?.setReviewDeferral) return UNAVAILABLE;
  return pullRequestMergeManager.setReviewDeferral(registration, headRefOid, reason, next);
}

module.exports = { applyReviewSkip, applyReviewDeferral, pullRequestStateUnavailable };
