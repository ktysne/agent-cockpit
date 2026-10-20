const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateReview, mergeConditionReview, reviewReminderNeeded, reservationReview, reviewDisplay, reservationReviewDisplay } = require('../src/shared/review-evaluation');

const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const record = (outcome, sha = head, round = 2, triageRound = round) => ({ round, max: 3, dismissed: 1,
  reviewedSha: head, triage: { round: triageRound, outcome, sha } });
const skip = { headRefOid: head.toUpperCase(), reason: '文言だけ' };
const deferral = { headRefOid: head, reason: '実機待ち', next: '実機で確認する' };

const cases = [
  { name: '登録場所なしと不要', input: { skip }, atHead: 'stale', covered: true, met: true, remind: false, action: 'wait', text: 'レビュー不要' },
  { name: '登録場所なしと保留', input: { deferral }, atHead: 'stale', covered: true, met: false, remind: false, action: 'wait', text: 'レビュー保留' },
  { name: '登録なし', input: {}, atHead: 'stale', covered: false, met: false, remind: false, action: 'wait', text: '', wait: 'クロスレビュー未実施' },
  { name: '未実施', input: { record: null }, atHead: 'stale', covered: false, met: false, remind: true, action: 'wait', text: 'レビュー未実施' },
  { name: '収束後の変更', input: { record: record('converged', old) }, atHead: 'stale', covered: false, met: false, remind: true, action: 'wait', text: '収束の後に変更あり (収束 bbbbbbb)' },
  { name: '古い head の判断待ち', input: { record: record('halted', old) }, atHead: 'stale', covered: false, met: false, remind: true, action: 'cancel', text: '開発者の判断待ち' },
  { name: '古い往復の判断待ち', input: { record: record('halted', old, 3, 2) }, atHead: 'in-progress', covered: true, met: false, remind: false, action: 'wait', text: '3 往復目の結論待ち', wait: 'クロスレビュー対応中' },
  { name: '新しい往復の判断待ち', input: { record: record('halted', old, 1, 2) }, atHead: 'in-progress', covered: true, met: false, remind: false, action: 'wait', text: 'この head をレビューに回した' },
  { name: '収束と不要', input: { record: record('converged'), skip }, atHead: 'converged', covered: true, met: true, remind: false, action: 'merge', text: 'レビュー済み' },
  { name: '判断待ちと不要', input: { record: record('halted'), skip }, atHead: 'halted', covered: true, met: true, remind: false, action: 'wait', condition: 'review-required', text: 'レビュー不要' },
  { name: '確認不能', input: { record: { unavailable: true } }, atHead: 'stale', covered: false, met: false, remind: false, action: 'wait', text: '状態を確認できない' },
  { name: '確認不能と不要', input: { record: { unavailable: true }, skip }, atHead: 'stale', covered: true, met: true, remind: false, action: 'wait', text: 'レビュー不要' },
  { name: '道具なし', input: { record: { notRequired: true, source: 'tool-absent' } }, atHead: 'stale', covered: true, met: true, remind: false, action: 'wait', text: 'レビュー不要' },
  { name: '古い head と保留', input: { record: record('fixing', old), deferral }, atHead: 'stale', covered: true, met: false, remind: false, action: 'wait', condition: 'review-deferred', text: 'レビュー保留' },
];
for (const scenario of cases) {
  test(`${scenario.name}を評価して各入口の方針を返す`, () => {
    const e = evaluateReview({ headSha: head, ...scenario.input });
    assert.equal(e.atHead, scenario.atHead);
    assert.equal(e.covered, scenario.covered);
    assert.equal(mergeConditionReview(e).met, scenario.met);
    if (scenario.wait) assert.equal(mergeConditionReview(e).waitReason, scenario.wait);
    assert.equal(reviewReminderNeeded(e), scenario.remind);
    assert.equal(reservationReview(e).action, scenario.action);
    if (scenario.condition) assert.equal(reservationReview(e).condition, scenario.condition);
    assert.equal(reviewDisplay(e).text, scenario.text);
    if (scenario.action === 'merge') assert.equal(reservationReview(e).matchSha, head);
  });
}

for (const headSha of ['short', '', 'a'.repeat(41), 'a'.repeat(63)]) {
  test(`不完全な head (${headSha.length} 桁) は催促せず確認不能を表示する`, () => {
    const e = evaluateReview({ record: record('fixing'), headSha });
    assert.equal(e.atHead, 'stale');
    assert.equal(e.covered, 'unknown');
    assert.equal(reviewReminderNeeded(e), false);
    assert.equal(reviewDisplay(e).text, 'head を確かめられない');
  });
}

for (const outcome of [null, 'fixing', 'halted', 'converged']) {
  test(`今の head の ${outcome || '進行中'} の記録は保留で隠さない`, () => {
    const raw = outcome ? record(outcome) : { round: 2, max: 3, reviewedSha: head };
    const e = evaluateReview({ record: raw, deferral, headSha: head });
    assert.equal(e.decision.kind, 'none');
    assert.equal(e.covered, true);
  });
}

test('不要を重ねても競合の証拠と往復と結論を残す', () => {
  const conflict = [{ worktree: '/other', round: 1, sha: head, outcome: 'converged' }];
  const e = evaluateReview({ record: { ...record('halted'), conflict }, skip, headSha: head });
  assert.equal(mergeConditionReview(e).met, true);
  assert.equal(reviewDisplay(e).text, 'レビュー不要');
  assert.deepEqual(e.conflict, conflict);
  assert.equal(e.latest.outcome, 'halted');
  assert.equal(e.rounds.round, 2);
  assert.equal(reservationReview(e).condition, 'review-conflict');
  assert.equal(reviewReminderNeeded(e), false);
});

test('64 桁と大文字の SHA を同じ head と扱う', () => {
  const sha = 'c'.repeat(64);
  const e = evaluateReview({ record: record('converged', sha.toUpperCase()), headSha: sha });
  assert.equal(e.atHead, 'converged');
  assert.equal(reservationReview(e).matchSha, sha);
});

test('不要の出所は予約チェックの表示に反映する', () => {
  const absent = evaluateReview({ record: { notRequired: true, source: 'tool-absent' }, headSha: head });
  const recorded = evaluateReview({ record: null, skip, headSha: head });
  assert.equal(reservationReviewDisplay(absent).showCheckbox, false);
  assert.equal(reservationReviewDisplay(recorded).showCheckbox, true);
  assert.equal(reviewDisplay(recorded).skipControl, 'clear');
});


for (const triageRound of [1, 3]) {
  test(`別の往復 (${triageRound}) の結論は head を覆う結論として使わない`, () => {
    for (const reviewedSha of [head, old]) {
      const e = evaluateReview({ headSha: head, record: { ...record('converged', head, 2, triageRound), reviewedSha } });
      assert.equal(e.latest.outcome, null);
      assert.equal(e.latest.sha, reviewedSha);
      assert.equal(e.atHead, reviewedSha === head ? 'in-progress' : 'stale');
      assert.equal(e.pushedAfterConvergence, false);
      assert.equal(reservationReviewDisplay(e).waitReason, 'クロスレビューの収束待ち');
    }
  });
}
