'use strict';

const { sha } = require('../fake-gh');

const OWNER = 'example-team';
const PLANNER_REPOSITORY = `${OWNER}/shift-planner`;
const PARCEL_REPOSITORY = `${OWNER}/parcel-api`;
const NOTES_REPOSITORY = `${OWNER}/field-notes`;

const headOf = (repository, number) => sha(`${repository}#${number}`);
const pullRequestUrl = (repository, number) => `https://github.com/${repository}/pull/${number}`;

function converged(repository, number, round) {
  const oid = headOf(repository, number);
  return { round, dismissed: [], lastReviewedSha: oid, lastTriage: { round, sha: oid, outcome: 'converged' } };
}

// 全体図に要素を並べるための基本のシナリオ。分単位の時刻は、基準時刻から何分前かで書く。
module.exports = function basic({ baseTime }) {
  const iso = (minutesAgo) => new Date(baseTime - minutesAgo * 60_000).toISOString();
  const open = (number, fields) => ({ number, createdAt: iso(fields.createdMinutesAgo), ...fields });

  return {
    name: 'basic',
    startMinutesAgo: 200,

    products: [
      {
        name: 'shift-planner',
        branch: 'feature/weekly-view',
        crossReview: {
          tool: true,
          state: {
            'feature/weekly-view': {
              round: 2,
              dismissed: ['命名の揺れ'],
              lastReviewedSha: headOf(PLANNER_REPOSITORY, 118),
              lastTriage: { round: 1, sha: headOf(PLANNER_REPOSITORY, 118), outcome: 'fixing' },
            },
          },
        },
        worktrees: [{
          name: 'holiday-sync',
          branch: 'feature/holiday-sync',
          crossReview: { tool: true, state: { 'feature/holiday-sync': converged(PLANNER_REPOSITORY, 119, 1) } },
        }],
      },
      {
        name: 'parcel-api',
        branch: 'feature/slots-lock',
        crossReview: {
          tool: true,
          state: {
            'feature/slots-api': converged(PARCEL_REPOSITORY, 41, 2),
            'feature/slots-lock': converged(PARCEL_REPOSITORY, 42, 1),
          },
        },
      },
      { name: 'field-notes', branch: 'feature/export-pdf', crossReview: { tool: true } },
    ],

    sessions: [
      { key: 'planner-main', id: 'demo-planner-main', product: 'shift-planner', title: '週切り替えの実装' },
      { key: 'planner-holiday', id: 'demo-planner-holiday', product: 'shift-planner', worktree: 'holiday-sync', title: '祝日の自動反映' },
      { key: 'parcel-main', id: 'demo-parcel-main', product: 'parcel-api', title: '配送枠の排他制御' },
      { key: 'parcel-scratch', id: 'demo-parcel-scratch', product: 'parcel-api', title: '調査メモ' },
      { key: 'notes-main', id: 'demo-notes-main', product: 'field-notes', title: 'PDF の書き出し' },
      { key: 'notes-old', id: 'demo-notes-old', product: 'field-notes', title: 'Markdown の整理' },
    ],

    claudeAgents: [
      { name: 'impl-standard', model: 'claude-sonnet-5-5', effort: 'medium' },
      { name: 'impl-light', model: 'claude-haiku-4-5', effort: 'low' },
    ],
    gptAgents: [
      { name: 'impl-standard', model: 'gpt-5.5-codex', effort: 'high' },
      { name: 'impl-light', model: 'gpt-5.5-codex', effort: 'medium' },
    ],

    github: {
      repositories: {
        [PLANNER_REPOSITORY]: {
          defaultBranch: 'main',
          pullRequests: [
            open(115, {
              title: '週の開始曜日を設定にする', head: 'feature/week-start', createdMinutesAgo: 600, checks: 'pass', reviewDecision: 'APPROVED',
            }),
            open(118, {
              title: 'シフト表を週ごとに切り替える', head: 'feature/weekly-view', createdMinutesAgo: 190, checks: 'pending',
            }),
            open(119, {
              title: '祝日をシフト表へ自動で反映する', head: 'feature/holiday-sync', createdMinutesAgo: 140, checks: 'pass',
              parentCommits: [headOf(PLANNER_REPOSITORY, 115)],
            }),
            open(120, {
              title: 'ログイン後の遷移先を直す', head: 'fix/login-redirect', createdMinutesAgo: 185,
              checks: 'pass', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY',
            }),
            open(121, {
              title: 'シフトの交換依頼を作る', head: 'feature/shift-swap', createdMinutesAgo: 180, draft: true, checks: 'none',
            }),
          ],
        },
        [PARCEL_REPOSITORY]: {
          defaultBranch: 'main',
          pullRequests: [
            open(41, {
              title: '配送枠の取得 API を追加する', head: 'feature/slots-api', createdMinutesAgo: 188, checks: 'pass', reviewDecision: 'APPROVED',
            }),
            open(42, {
              title: '枠の予約を排他制御にする', head: 'feature/slots-lock', base: 'feature/slots-api', createdMinutesAgo: 186, checks: 'pass',
            }),
            open(43, {
              title: '予約の確定を通知する', head: 'feature/slots-notify', base: 'feature/slots-lock', createdMinutesAgo: 120, checks: 'pending',
            }),
            open(44, {
              title: 'API の README を更新する', head: 'docs/api-readme', createdMinutesAgo: 184, checks: 'none',
            }),
          ],
        },
        [NOTES_REPOSITORY]: {
          defaultBranch: 'main',
          pullRequests: [
            open(57, {
              title: 'ノートを PDF で書き出す', head: 'feature/export-pdf', createdMinutesAgo: 183, checks: 'pass',
            }),
          ],
        },
      },
    },

    async play(demo) {
      const { at, hook, plan, prs } = demo;
      const toolStart = (key, id, name, input, agent) => hook(key, {
        hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: id, tool_input: input,
        ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}),
      });
      const toolEnd = (key, id, name, input, agent, response) => hook(key, {
        hook_event_name: 'PostToolUse', tool_name: name, tool_use_id: id, tool_input: input, tool_response: response ?? {},
        ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}),
      });
      const tool = async (key, id, name, input) => {
        await toolStart(key, id, name, input);
        await toolEnd(key, id, name, input);
      };
      const taskList = (...tasks) => ({
        kind: 'tasks',
        tasks: tasks.map(([title, state, ...criteria]) => ({
          title, state, criteria: criteria.map(([text, met]) => ({ text, met })),
        })),
      });
      const subagentStart = async (key, callId, description, agent, route) => {
        await toolStart(key, callId, 'Agent', { description });
        await hook(key, { hook_event_name: 'SubagentStart', agent_id: agent.id, agent_type: agent.type, route });
      };
      const codexLaunch = (key, id, agent, definition) => toolStart(key, id, 'Bash', {
        command: `bash ~/.claude/tools/codex-agent.sh ${definition} --task-file task.md`,
      }, agent);
      const codexOutput = (runId, model, effort, result) => [
        `codex-agent: agent=${runId.replace(/-\d{8}-\d{6}-\d+$/, '')} model=${model} effort=${effort}`,
        `codex-agent: run=${runId}`,
        ...(result ? ['codex-agent: result=ok exit=0'] : []),
      ].join('\n');

      // 200 分前: 5 つのセッションが始まる。
      at(200);
      for (const key of ['planner-main', 'planner-holiday', 'parcel-main', 'parcel-scratch', 'notes-main', 'notes-old']) {
        await hook(key, { hook_event_name: 'SessionStart', source: 'startup' });
        await hook(key, { hook_event_name: 'UserPromptSubmit' });
      }

      at(196);
      await plan('planner-main', taskList(
        ['週切り替えの API を追加', 'doing', ['週の範囲を指定して取得できる', false], ['範囲外の週は 404 を返す', false]],
        ['週表示のコンポーネントを作る', 'todo', ['前週と翌週のボタンで切り替わる', false], ['キーボードだけで切り替えられる', false], ['祝日が強調される', false]],
        ['モバイルの表示を整える', 'todo', ['幅 375px で崩れない', false]],
      ));
      await plan('planner-holiday', taskList(
        ['祝日データを取り込む', 'doing', ['内閣府の祝日一覧を読める', false]],
        ['勤務表へ反映する', 'todo', ['祝日の行が色分けされる', false], ['祝日出勤の手当が計算に入る', false]],
        ['年またぎのテストを足す', 'todo', ['12 月から 1 月の表示が崩れない', false]],
      ));
      await plan('parcel-main', taskList(
        ['予約テーブルに排他制御用の列を足す', 'doing', ['マイグレーションが通る', false]],
        ['ロックの取得と解放を実装する', 'todo', ['同じ枠の同時予約が 1 件だけ成功する', false], ['タイムアウトでロックが外れる', false]],
        ['競合時の再試行を実装する', 'todo', ['再試行は 3 回までにする', false]],
      ));
      await plan('notes-main', taskList(
        ['PDF 変換ライブラリを選ぶ', 'doing', ['日本語フォントが埋め込める', false], ['1 万字のノートを 5 秒以内に変換する', false]],
        ['書き出しボタンを足す', 'todo', ['ノートの画面から押せる', false]],
        ['余白を設定できるようにする', 'todo', ['余白は 0〜30mm で指定できる', false]],
      ));

      // 192〜181 分前: PR を登録する。
      at(192);
      await prs('planner-holiday', { kind: 'add_pr', url: pullRequestUrl(PLANNER_REPOSITORY, 115) });
      at(190);
      await prs('planner-main', { kind: 'add_pr', url: pullRequestUrl(PLANNER_REPOSITORY, 118) });
      at(186);
      await prs('parcel-main', { kind: 'add_pr', url: pullRequestUrl(PARCEL_REPOSITORY, 41) });
      at(185);
      await prs('parcel-main', { kind: 'add_pr', url: pullRequestUrl(PARCEL_REPOSITORY, 42) });
      at(184);
      await prs('planner-holiday', { kind: 'add_pr', url: pullRequestUrl(PLANNER_REPOSITORY, 120) });
      at(183);
      await prs('planner-holiday', { kind: 'add_pr', url: pullRequestUrl(PLANNER_REPOSITORY, 121) });
      at(182);
      await prs('parcel-main', { kind: 'add_pr', url: pullRequestUrl(PARCEL_REPOSITORY, 44) });
      at(181);
      await prs('notes-main', { kind: 'add_pr', url: pullRequestUrl(NOTES_REPOSITORY, 57) });
      await demo.refreshPullRequests();

      // 古いセッションは、最後の更新から時間が経っているので一覧から隠れる。
      at(175);
      await tool('notes-old', 'old-read-1', 'Read', { file_path: 'docs/notes.md' });
      await hook('notes-old', { hook_event_name: 'Stop' });

      // 170 分前: 画面を開いた時点を「前回見た時刻」にする。以降の変化が「前回見てから」に出る。
      at(170);
      await demo.getState();

      at(160);
      await demo.ui('/api/away', { enabled: true });

      at(150);
      const lockDecision = await plan('parcel-main', {
        kind: 'add_decision',
        title: '検索のインデックスを今回の変更に含めるか',
        context: '予約の一覧が遅いという報告があるが、原因は未特定。排他制御と同じ変更に入れると差分が大きくなる。',
        state: 'waiting',
        options: [
          { label: '今回は含めない', description: '別の Issue で原因を調べてから対応する', recommended: true },
          { label: '今回の変更に含める', description: 'マイグレーションが増え、レビューの範囲も広がる' },
        ],
      });
      at(145);
      await plan('parcel-main', {
        kind: 'update_decision', id: lockDecision.decision.id, state: 'resolved', chosen: '今回は含めない', note: '一覧の遅さは別の Issue で調べる',
      });

      at(140);
      await prs('planner-holiday', { kind: 'add_pr', url: pullRequestUrl(PLANNER_REPOSITORY, 119) });
      await demo.refreshPullRequests();

      at(120);
      await plan('planner-main', taskList(
        ['週切り替えの API を追加', 'done', ['週の範囲を指定して取得できる', true], ['範囲外の週は 404 を返す', true]],
        ['週表示のコンポーネントを作る', 'doing', ['前週と翌週のボタンで切り替わる', true], ['キーボードだけで切り替えられる', false], ['祝日が強調される', false]],
        ['モバイルの表示を整える', 'todo', ['幅 375px で崩れない', false]],
      ));
      await prs('parcel-main', { kind: 'add_pr', url: pullRequestUrl(PARCEL_REPOSITORY, 43) });
      await demo.refreshPullRequests();

      at(100);
      const planner115 = demo.gh.repository(PLANNER_REPOSITORY).pullRequests.find((pr) => pr.number === 115);
      planner115.state = 'MERGED';
      planner115.mergedAt = iso(100);
      await demo.refreshPullRequests();

      at(90);
      const indexDecision = await plan('parcel-main', {
        kind: 'add_decision',
        title: '予約の排他制御に使うロックの方式',
        context: '同じ枠への同時予約を 1 件だけ成功させる。枠の数は 1 店舗あたり最大 200 で、予約の集中は昼休み前に起きる。',
        state: 'provisional',
        options: [
          { label: '行ロック(推奨)', description: 'データベースの行ロックで直列化する。実装が小さく、既存の接続をそのまま使える', recommended: true },
          { label: '楽観ロック', description: 'バージョン列で衝突を検出して再試行する。集中すると失敗が増える' },
        ],
      });
      await plan('parcel-main', {
        kind: 'update_decision', id: indexDecision.decision.id, state: 'provisional', chosen: '行ロック(推奨)',
        note: '離席中のため推奨案で進める。戻ったら確認する',
      });

      at(80);
      await plan('notes-main', taskList(
        ['PDF 変換ライブラリを選ぶ', 'done', ['日本語フォントが埋め込める', true], ['1 万字のノートを 5 秒以内に変換する', true]],
        ['書き出しボタンを足す', 'doing', ['ノートの画面から押せる', false]],
        ['余白を設定できるようにする', 'todo', ['余白は 0〜30mm で指定できる', false]],
      ));

      at(75);
      await plan('planner-main', {
        kind: 'add_decision',
        title: '週の開始日を月曜と日曜のどちらにするか',
        context: '既存のシフト表は日曜始まりだが、週切り替えは月曜始まりを望む店舗が多い。祝日の自動反映も同じ設定を参照する。',
        state: 'waiting',
        options: [
          { label: '月曜始まりを既定にする', description: '国内の勤務表の慣習に合わせる。設定で日曜始まりに切り替えられる', recommended: true },
          { label: '日曜始まりのまま', description: '既存の表示を変えない。月曜始まりを望む店舗には使いにくい' },
        ],
      });

      at(70);
      const lightAgent = { id: 'agent-parcel-light', type: 'impl-light' };
      await subagentStart('parcel-main', 'call-parcel-light', 'API のスキーマ定義を直す', lightAgent, 'default');
      await toolStart('parcel-main', 'parcel-light-edit', 'Edit', { file_path: 'src/schema/slots.ts' }, lightAgent);
      at(60);
      await toolEnd('parcel-main', 'parcel-light-edit', 'Edit', { file_path: 'src/schema/slots.ts' }, lightAgent);
      await hook('parcel-main', { hook_event_name: 'SubagentStop', agent_id: lightAgent.id, agent_type: lightAgent.type });
      await toolEnd('parcel-main', 'call-parcel-light', 'Agent', { description: 'API のスキーマ定義を直す' });
      await prs('parcel-main', {
        kind: 'skip_review', owner: OWNER, repo: 'parcel-api', number: 44, headRefOid: headOf(PARCEL_REPOSITORY, 44),
        reason: 'ドキュメントだけの変更なので、クロスレビューを省く',
      });

      at(52);
      const finishedCodex = { id: 'agent-planner-codex-done', type: 'impl-light' };
      await subagentStart('planner-main', 'call-planner-codex-done', 'TypeScript の型エラーを直す', finishedCodex, 'default');
      await codexLaunch('planner-main', 'planner-codex-done-run', finishedCodex, 'impl-light');
      at(50);
      await demo.ui('/api/away', { enabled: false });
      await toolEnd('planner-main', 'planner-codex-done-run', 'Bash', {
        command: 'bash ~/.claude/tools/codex-agent.sh impl-light --task-file task.md',
      }, finishedCodex, codexOutput('impl-light-20261006-134000-3112', 'gpt-5.5-codex', 'medium', true));
      await hook('planner-main', { hook_event_name: 'SubagentStop', agent_id: finishedCodex.id, agent_type: finishedCodex.type });
      await toolEnd('planner-main', 'call-planner-codex-done', 'Agent', { description: 'TypeScript の型エラーを直す' });

      at(40);
      await tool('parcel-scratch', 'scratch-read-1', 'Read', { file_path: 'docs/notes.md' });
      at(35);
      await demo.ui('/api/hidden-sessions', { action: 'hide', session_id: demo.sessions.get('parcel-scratch').id });

      at(30);
      await toolStart('planner-main', 'ask-first-screens', 'AskUserQuestion', {
        questions: [{
          question: '週切り替えで先に対応する画面を選んでください',
          header: '対応する画面',
          multiSelect: true,
          options: [
            { label: '管理者の週表', description: '店長が使うシフトの編集画面' },
            { label: '従業員のモバイル表示', description: '自分のシフトを確かめる画面' },
            { label: '印刷用のレイアウト', description: '紙で掲示するための表' },
          ],
        }],
      });

      at(23);
      await hook('planner-holiday', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'holiday-migrate', tool_input: { command: 'npm run db:migrate' } });
      at(22);
      await hook('planner-holiday', {
        hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Bash の実行許可を待っています。',
      });

      at(14);
      const runningCodex = { id: 'agent-parcel-codex', type: 'impl-standard' };
      await subagentStart('parcel-main', 'call-parcel-codex', 'ロックの取得と解放を実装する', runningCodex, 'default');
      await codexLaunch('parcel-main', 'parcel-codex-run', runningCodex, 'impl-standard');
      at(13);
      await toolEnd('parcel-main', 'parcel-codex-run', 'Bash', {
        command: 'bash ~/.claude/tools/codex-agent.sh impl-standard --task-file task.md',
      }, runningCodex, codexOutput('impl-standard-20261006-141700-4821', 'gpt-5.5-codex', 'high', false));

      at(10);
      await tool('notes-main', 'notes-grep-1', 'Bash', { command: 'npm run build' });
      at(9);
      await hook('notes-main', { hook_event_name: 'Stop' });

      at(9);
      const claudeAgent = { id: 'agent-planner-weekly', type: 'impl-standard' };
      await subagentStart('planner-main', 'call-planner-weekly', '週表示の API 呼び出しを実装する', claudeAgent, 'default');
      at(8);
      await toolStart('planner-main', 'planner-weekly-read', 'Read', { file_path: 'src/api/schedules.ts' }, claudeAgent);

      at(5);
      await hook('parcel-main', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'parcel-push', tool_input: { command: 'git push origin feature/slots-lock' } });
      at(3);
      await hook('parcel-main', {
        hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Bash の実行許可を待っています。',
      });

      at(1);
      await toolStart('planner-main', 'planner-edit-weekview', 'Edit', { file_path: 'src/components/WeekView.tsx' });
    },
  };
};
