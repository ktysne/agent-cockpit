const { evaluateReview, reviewPresentation } = require('../../src/shared/review-evaluation');

function reviewPr({ crossReview, review, children, ...pr }) {
  const skip = crossReview?.notRequired && crossReview.source === 'recorded'
    ? { headRefOid: pr.headRefOid, reason: crossReview.reason } : null;
  const deferral = crossReview?.deferred
    ? { headRefOid: pr.headRefOid, reason: crossReview.reason, next: crossReview.next } : null;
  const record = skip || deferral ? null : crossReview;
  return { ...pr, githubReview: review || 'none', review: reviewPresentation(evaluateReview({ record,
    skip, deferral, headSha: pr.headRefOid })), ...(children ? { children: children.map(reviewPr) } : {}) };
}

module.exports = { reviewPr };
