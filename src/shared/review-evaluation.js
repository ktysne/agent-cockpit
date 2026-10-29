'use strict';

function completeReviewSha(value) {
  return typeof value === 'string' && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value);
}

function classifyReviewAtHead(review, headSha) {
  if (!completeReviewSha(headSha)) return 'stale';
  const head = headSha.toLowerCase();
  const triage = review?.triage;
  if (triage?.round === review?.round) {
    return triage?.sha?.toLowerCase() === head && ['converged', 'halted', 'fixing'].includes(triage.outcome)
      ? triage.outcome : 'stale';
  }
  return review?.reviewedSha?.toLowerCase() === head ? 'in-progress' : 'stale';
}

/** PR の記録と現在の head に対する判断を評価する。 */
function evaluateReview({ record, skip = null, deferral = null, headSha, afterConvergence = null }) {
  const headKnown = completeReviewSha(headSha);
  const head = headSha?.toLowerCase();
  const kind = record === undefined ? 'unregistered' : record === null ? 'none'
    : record.unavailable ? 'unavailable' : record.notRequired ? 'tool-absent' : 'recorded';
  const atHead = classifyReviewAtHead(record, headSha);
  const triage = record?.triage;
  const currentRound = triage && triage.round === record.round;
  const latest = { round: record?.round, outcome: currentRound ? triage.outcome : null,
    sha: (currentRound ? triage.sha : record?.reviewedSha)?.toLowerCase() };
  const conflict = record?.conflict || [];
  let decision = { kind: kind === 'tool-absent' ? 'not-required' : 'none',
    source: kind === 'tool-absent' ? 'tool-absent' : null, reason: null, next: null };
  if (deferral && deferral.headRefOid?.toLowerCase() === head && !conflict.length && atHead === 'stale') {
    decision = { kind: 'deferred', source: 'recorded', reason: deferral.reason, next: deferral.next };
  } else if (skip && skip.headRefOid?.toLowerCase() === head && atHead !== 'converged') {
    decision = { kind: 'not-required', source: 'recorded', reason: skip.reason, next: null };
  }
  const pushedAfterConvergence = latest.outcome === 'converged' && completeReviewSha(latest.sha) && headKnown && latest.sha !== head;
  afterConvergence = pushedAfterConvergence ? afterConvergence : null;
  return { headKnown, headSha: head, record: kind, atHead, latest, afterConvergence,
    covered: headKnown ? atHead !== 'stale' || afterConvergence?.kind === 'clean' || decision.kind !== 'none' : 'unknown',
    pushedAfterConvergence,
    conflict, decision, rounds: kind === 'recorded' ? { round: record.round, max: record.max, dismissed: record.dismissed } : null,
    reviewedSha: record?.reviewedSha?.toLowerCase(), awaitingConclusion: kind === 'recorded' && record.round > 0
      && (triage ? triage.round < record.round : atHead === 'in-progress') };
}

/** マージ条件のレビュー部分を返す。 */
function mergeConditionReview(e) {
  let waitReason = null;
  if (e.decision.kind === 'deferred') waitReason = 'レビュー保留';
  else if (e.decision.kind === 'not-required') return { met: true, waitReason };
  else if (e.conflict.length) waitReason = 'クロスレビューの記録が食い違う';
  else if (e.record === 'unavailable') waitReason = 'クロスレビューの状態を確認できない';
  else if (e.atHead === 'converged') return { met: true, waitReason };
  else if (e.afterConvergence?.kind === 'clean') return { met: true, waitReason };
  else if (e.afterConvergence?.kind === 'resolved') waitReason = '競合の解消の確認待ち';
  else if (e.latest.outcome === 'halted') waitReason = 'クロスレビューが開発者の判断待ち';
  else if (e.pushedAfterConvergence) waitReason = 'クロスレビュー後に push あり';
  else if (e.awaitingConclusion) waitReason = `クロスレビューの ${e.rounds.round} 往復目の結論が未記録`;
  else waitReason = e.rounds?.round > 0 ? 'クロスレビュー対応中' : 'クロスレビュー未実施';
  return { met: false, waitReason };
}

/** Stop でレビューの記録を促す必要があるかを返す。 */
function reviewReminderNeeded(e) {
  return e.headKnown && e.afterConvergence?.kind !== 'clean' && e.decision.kind === 'none' && !e.conflict.length
    && (e.record === 'none' || e.record === 'recorded' && e.atHead === 'stale');
}

/** 予約マージのレビュー条件を返す。 */
function reservationReview(e) {
  const wait = condition => ({ action: 'wait', condition, matchSha: null });
  if (e.decision.kind === 'deferred') return wait('review-deferred');
  if (e.conflict.length) return wait('review-conflict');
  if (e.decision.kind === 'not-required') return wait('review-required');
  if (e.latest.outcome === 'halted') return { action: 'cancel', condition: 'review-halted', matchSha: null };
  if (e.latest.outcome !== 'converged') return wait('review-not-converged');
  if (e.atHead !== 'converged') return wait('review-head-mismatch');
  if (!completeReviewSha(e.latest.sha)) return wait('review-head-missing');
  return { action: 'merge', condition: 'ready', matchSha: e.latest.sha };
}

/** 予約のレビュー待ち表示とチェックの有無を返す。 */
function reservationReviewDisplay(e) {
  let waitReason = null;
  if (e.decision.kind === 'deferred') waitReason = 'レビュー保留';
  else if (e.conflict.length) waitReason = 'クロスレビューの記録が食い違う';
  else if (e.decision.kind === 'not-required') waitReason = 'レビュー不要の記録では収束後マージは動かない。収束を記録するか、手でマージする';
  else if (e.afterConvergence?.kind === 'clean') waitReason = 'base の取り込み後の head では収束後マージは動かない。手でマージする';
  else if (e.atHead !== 'converged') {
    waitReason = e.pushedAfterConvergence ? '収束後に push あり。現在の head の収束待ち' : 'クロスレビューの収束待ち';
  }
  return { waitReason, showCheckbox: e.decision.source !== 'tool-absent' };
}

function skippedAfterConvergence(e) {
  return e.decision.kind === 'not-required' && e.pushedAfterConvergence;
}

function reviewBadge(e) {
  const state = (cls, text, warn = null) => ({ cls, text, warn });
  if (e.decision.kind === 'deferred') return state('warn', 'レビュー保留', 'レビュー保留');
  if (skippedAfterConvergence(e)) return state('mute', `収束後に不要と記録 (収束 ${e.latest.sha.slice(0, 7)})`);
  if (e.decision.kind === 'not-required') return state('mute', 'レビュー不要');
  if (e.record === 'unregistered') return state('mute', '');
  if (e.conflict.length) return state('warn', '記録が食い違う', 'クロスレビューの記録が食い違う');
  if (e.record === 'unavailable') return state('warn', '状態を確認できない', 'クロスレビューの状態を確認できない');
  if (!e.headKnown) return state('mute', 'head を確かめられない', 'head を確かめられない');
  if (e.record === 'none') return state('warn', 'レビュー未実施', 'クロスレビューの記録が無い');
  if (e.awaitingConclusion) return state('warn', `${e.rounds.round} 往復目の結論が未記録`,
    `クロスレビューの ${e.rounds.round} 往復目の結論が記録されていない。node tools/cross-review.js comment --round ${e.rounds.round} --outcome <fixing|converged|halted> で記録する`);
  if (e.latest.outcome === 'fixing') return state('warn', '指摘の対応中', `クロスレビューの ${e.latest.round} 往復目の指摘に対応している途中`);
  if (e.latest.outcome === 'halted') return state('warn', '開発者の判断待ち', 'クロスレビューは開発者の判断を待って止まっている');
  if (e.atHead === 'converged') return state('ok', 'レビュー済み');
  if (e.afterConvergence?.kind === 'clean') return state('ok', `収束 ${e.latest.sha.slice(0, 7)} の後に base を取り込み(競合なし)`);
  if (e.afterConvergence?.kind === 'resolved') return state('warn',
    `競合の解消の確認待ち (${e.afterConvergence.files} ファイル、+${e.afterConvergence.insertions} −${e.afterConvergence.deletions})`,
    'ai-cross-review の手順で解消の差分だけをレビューするか、cockpit_skip_review に現在の head SHA と理由を渡してレビュー不要を記録してください。');
  if (e.pushedAfterConvergence) return state('warn', `収束の後に変更あり (収束 ${e.latest.sha.slice(0, 7)})`,
    `head ${e.headSha.slice(0, 7)} はクロスレビューの収束の後に変更されている (収束は ${e.latest.sha.slice(0, 7)})`);
  if (!completeReviewSha(e.reviewedSha)) return state('mute', 'head を確かめられない', 'head を確かめられない');
  if (e.reviewedSha !== e.headSha) return state('warn', `レビューの後に変更あり (レビュー済み ${e.reviewedSha.slice(0, 7)})`,
    `head ${e.headSha.slice(0, 7)} はクロスレビューの後に変更されている (レビュー済みは ${e.reviewedSha.slice(0, 7)})`);
  return state('mute', 'この head をレビューに回した');
}

/** 画面で描画する札とレビュー行の材料を返す。 */
function reviewDisplay(e) {
  const badge = reviewBadge(e);
  const missing = e.decision.kind === 'none' && (e.record === 'none' || e.record === 'recorded' && e.covered === false && !e.conflict.length);
  const notRequired = e.decision.kind === 'not-required';
  const deferred = e.decision.kind === 'deferred';
  const labels = { halted: '開発者の判断待ち', fixing: '指摘の対応中', 'in-progress': '結論待ち', converged: '収束' };
  return { ...badge, visible: e.record !== 'unregistered' || e.decision.kind !== 'none',
    missingText: missing ? '現在の head の記録がありません。クロスレビューを実施するか、レビュー不要にする操作で記録してください。' : null,
    rounds: notRequired && !skippedAfterConvergence(e) || deferred ? null : e.rounds,
    roundsText: e.rounds ? `${e.rounds.round} / ${e.rounds.max} 往復、非対応 ${e.rounds.dismissed}` : null,
    reason: e.decision.reason, deferred,
    reasonText: deferred ? `理由: ${e.decision.reason}` : null, nextText: deferred ? `次の作業: ${e.decision.next}` : null,
    skipControl: notRequired ? (e.decision.source === 'recorded' ? 'clear' : null) : missing || badge.cls === 'warn' ? 'set' : null,
    conflict: e.conflict.map(record => ({ worktree: record.worktree, roundText: `${record.round} 往復目`, sha: record.sha, label: labels[record.outcome] || record.outcome })),
    conflictText: notRequired ? 'レビュー不要として確定済みです。記録元の食い違いは残っています。'
      : '古い worktree の記録を消すか、レビュー不要として確定してください' };
}

/** 配信用のレビュー評価と方針を組み立てる。 */
function reviewPresentation(evaluation) {
  return { evaluation, mergeCondition: mergeConditionReview(evaluation), display: reviewDisplay(evaluation),
    reservation: reservationReviewDisplay(evaluation) };
}

if (typeof module !== 'undefined') module.exports = { evaluateReview, mergeConditionReview, reviewReminderNeeded,
  reservationReview, reviewDisplay, reservationReviewDisplay, reviewPresentation };
