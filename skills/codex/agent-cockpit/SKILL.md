---
name: agent-cockpit
description: Codex のメインセッションのタスク、完了条件、判断事項を Agent Cockpit に記録する。開発者への質問、推奨の適用、サブエージェントとの分担を扱う。
---

# Agent Cockpit の使い方(Codex)

## タスク

- 計画を立てたら `cockpit_set_tasks` を呼び、タスクと完了条件を登録する。
- タスクの状態または完了条件が変わったら、変更後の一覧全体を `cockpit_set_tasks` で置き換える。
- タスクには `todo`、`doing`、`done` の状態を付け、完了条件ごとに `met` を更新する。
- PR のマージを確かめたとき、作業を別のものへ切り替えたときは、その時点で一覧を書き直す。終わったタスクを `doing` のまま残さない。

## PR のクロスレビュー

- 軽微な変更など、レビューを省けると判断した場合は、メインセッションから `cockpit_skip_review` を呼び、owner、repo、PR 番号、現在の head SHA、具体的な理由を渡す。
- 呼び出す前に PR の最新 head SHA を確認する。PR がこのセッションに登録されていない場合は `cockpit_add_pr` で登録してから記録する。
- 記録は指定した head だけに有効である。push で head が変わったら、必要に応じて改めてレビューするか、新しい head に対する判断を記録する。
- ダッシュボードの PR カードでも「レビュー不要にする」と取り消しを操作できる。こちらの記録も現在表示している head だけに有効である。

## 判断事項

- 開発者に選んでもらう内容は `request_user_input_async` で尋ねる。Plan モードでは、待つ形の `request_user_input` も使える。
- `request_user_input_async` では、推奨する選択肢を先頭に置く。Agent Cockpit は先頭の選択肢を推奨として扱う。
- `request_user_input` では、推奨する選択肢を 1 つだけにし、label の末尾に「(推奨)」を付け、理由を description に書く。
- 質問ツールの判断事項は自動で記録されるため、`cockpit_add_decision` で重ねて登録しない。
- 尋ねずに推奨を適用する判断は `cockpit_add_decision` で `provisional` として登録し、推奨する選択肢に `recommended: true` を付ける。
- 適用した選択肢も残す場合は、返された id を `cockpit_update_decision` に渡し、state を `provisional` にして chosen と note を更新する。
- 離席中に質問ツールが止められた場合は、示された id を `cockpit_update_decision` に渡し、state を `provisional` にして選んだ選択肢を書く。推奨の無い質問で仮定を置いて進めたときは、その仮定を note に書く。
- 判断が完了したら `cockpit_update_decision` で state を `resolved` にする。

## 確認依頼

- worktree で動作確認を頼むときは、質問ツール(`request_user_input_async` / `request_user_input`)や `AskUserQuestion` ではなく、`cockpit_add_decision` に `state: "waiting"` と `verify: { steps: [{ cmd, note }] }` を付けて登録する。
- 選択肢は「確認した。コミットして PR を作る」(`recommended: true`)と「直してほしい点がある」にする。
- 各選択肢の `next` に、前者は「セッションがコミットして PR を作ると、PR の欄にクロスレビューとマージの段が出ます。」、後者は「セッションが直したあと、このカードがもう一度届きます。」を書く。
- チャットにも確認を頼む文を書き、ターンを終える。
- 通知で起動を頼まれたら、自分のツールでアプリを起動し(内部ブラウザなら `preview_start`)、`cockpit_report_launch` に判断事項の `id` と `url` または `process` のどちらかを渡す。
- 起動先の URL は `http:` または `https:` にする。起動報告では判断事項を解決しない。
- 回答を受けたら `cockpit_update_decision` で `resolved` にする。チャットで回答を受けたときも同じように更新する。
- Codex は席にいる間は Stop で待たないため、画面の回答と起動依頼は次のツール実行かプロンプト送信で受け取る。

## サブエージェント

- サブエージェントは Agent Cockpit の MCP ツールを呼ばない。
- メインセッションがサブエージェントの報告を受けてタスクと判断事項を更新する。
