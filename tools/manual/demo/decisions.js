'use strict';

const askQuestions = (question, header, options, multiSelect = false) => ({
  questions: [{ question, header, multiSelect, options }],
});

// 判断事項の状態と回答の届き方を並べるシナリオ。離席中のまま終わる。
// 回答欄の状態は、送信済み、渡した、反映された、離席中に待っている質問、締切を過ぎた質問の順に見られる。
module.exports = function decisions() {
  return {
    name: 'decisions',
    startMinutesAgo: 160,

    products: [
      { name: 'parcel-api', branch: 'feature/slots-lock' },
    ],

    sessions: [
      { key: 'parcel-main', id: 'demo-parcel-main', product: 'parcel-api', title: '配送枠の排他制御' },
    ],

    claudeAgents: [],
    gptAgents: [],
    github: { repositories: {} },

    async play(demo) {
      const { at, hook, plan, hookAnswer } = demo;
      const key = 'parcel-main';
      const sessionId = demo.sessions.get(key).id;
      const sendAnswer = (decisionId, body) => demo.ui(`/api/decisions/${decisionId}/answer`, { session_id: sessionId, ...body });
      const deliverBatch = () => hookAnswer(key, { action: 'post-tool-batch', event_name: 'PostToolBatch', id: `batch-${Date.now()}` });

      at(160);
      await hook(key, { hook_event_name: 'SessionStart', source: 'startup' });
      await hook(key, { hook_event_name: 'UserPromptSubmit' });

      at(155);
      await plan(key, {
        kind: 'tasks',
        tasks: [{
          title: '予約の排他制御を実装する',
          state: 'doing',
          criteria: [{ text: '同じ枠の同時予約が 1 件だけ成功する', met: false }, { text: 'タイムアウトでロックが外れる', met: false }],
        }],
      });

      at(140);
      await demo.ui('/api/away', { enabled: true });

      // 解決済み: 質問を出して、答えが決まった。
      at(135);
      const resolved = await plan(key, {
        kind: 'add_decision',
        title: '検索のインデックスを今回の変更に含めるか',
        context: '予約の一覧が遅いという報告があるが、原因は未特定。',
        state: 'waiting',
        options: [
          { label: '今回は含めない', description: '別の Issue で原因を調べてから対応する', recommended: true },
          { label: '今回の変更に含める', description: 'マイグレーションが増え、レビューの範囲も広がる', recommended: false },
        ],
      });
      at(128);
      await plan(key, {
        kind: 'update_decision', id: resolved.decision.id, state: 'resolved', chosen: '今回は含めない', note: '一覧の遅さは別の Issue で調べる',
      });

      // 取り下げ: 質問が答えられないまま終わった。
      at(120);
      await hook(key, {
        hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'ask-withdrawn',
        tool_input: askQuestions('ロックの取得に失敗したときの扱い', '失敗時の扱い', [
          { label: '呼び出し元へエラーを返す', description: '再試行は呼び出し元に任せる' },
          { label: '内部で再試行する', description: '3 回まで再試行する' },
        ]),
      });
      at(118);
      await hook(key, {
        hook_event_name: 'PostToolUseFailure', tool_name: 'AskUserQuestion', tool_use_id: 'ask-withdrawn',
        tool_input: {}, error: 'ユーザーが質問を中断した',
      });

      // 締切を過ぎた質問: 離席中に出た質問が、回答の無いまま締切を過ぎ、推奨案で進んだ。
      at(100);
      const timeoutQuestions = askQuestions('ロックの方式', '方式', [
        { label: '行ロック(推奨)', description: 'データベースの行ロックで直列化する' },
        { label: '楽観ロック', description: 'バージョン列で衝突を検出して再試行する' },
      ]).questions;
      const timeoutRegistration = await hookAnswer(key, {
        action: 'ask-register', event_name: 'PreToolUse', id: 'ask-timeout', questions: timeoutQuestions,
      });
      at(94);
      await hookAnswer(key, {
        action: 'ask-finish', event_name: 'PreToolUse', id: 'ask-timeout', decision_id: timeoutRegistration.decisionId, outcome: 'timeout',
      });

      // 反映された回答: 推奨案で OK を送り、セッションに渡り、セッションが判断事項を更新した。
      at(90);
      const reflected = await plan(key, {
        kind: 'add_decision',
        title: 'ロックのタイムアウト値',
        context: '長すぎると他の予約が待たされ、短すぎると正常な予約が失敗する。',
        state: 'provisional',
        options: [
          { label: '30 秒', description: '現在の接続のタイムアウトに合わせる', recommended: true },
          { label: '10 秒', description: '待ちを短くし、失敗は再試行で補う', recommended: false },
        ],
      });
      at(80);
      await sendAnswer(reflected.decision.id, { choice: 'ok', note: '' });
      at(79);
      await deliverBatch();
      at(75);
      await plan(key, {
        kind: 'update_decision', id: reflected.decision.id, state: 'provisional', chosen: '30 秒', note: '推奨案のとおり 30 秒で進める',
      });

      // 渡した回答: 選択肢と指示を送り、セッションに渡ったが、まだ反映されていない。
      at(70);
      const delivered = await plan(key, {
        kind: 'add_decision',
        title: '再試行の回数',
        context: '競合したときに自動で再試行する回数を決める。',
        state: 'provisional',
        options: [
          { label: '3 回', description: '標準的な回数', recommended: true },
          { label: '5 回', description: '昼休み前の集中に備える', recommended: false },
        ],
      });
      at(60);
      await sendAnswer(delivered.decision.id, { choice: 'pick', picks: [['5 回']], note: '集中する時間帯の失敗を減らしたい' });
      at(59);
      await deliverBatch();

      // 送信済みの回答: 選択肢と指示を送ったが、まだセッションに渡っていない。
      at(50);
      const sent = await plan(key, {
        kind: 'add_decision',
        title: 'ロックの失敗をログに残すか',
        context: '競合による失敗は想定内なので、毎回ログに残すと量が増える。',
        state: 'provisional',
        options: [
          { label: '警告として残す', description: '失敗のたびに 1 行残す', recommended: true },
          { label: '残さない', description: '集計の件数だけを持つ', recommended: false },
        ],
      });
      at(30);
      await sendAnswer(sent.decision.id, { choice: 'pick', picks: [['残さない']], note: '件数はメトリクスで見る' });

      // 離席中に待っている質問: 回答を待つ時間の中にある。
      at(2);
      await hookAnswer(key, {
        action: 'ask-register',
        event_name: 'PreToolUse',
        id: 'ask-awaiting',
        questions: askQuestions('予約の確定を通知する方法', '通知の方法', [
          { label: 'メールで通知する(推奨)', description: '確定した予約ごとに 1 通送る' },
          { label: 'アプリ内の通知だけにする', description: 'メールは送らない' },
        ]).questions,
      });
    },
  };
};
