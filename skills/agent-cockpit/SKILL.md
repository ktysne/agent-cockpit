---
name: agent-cockpit
description: メインセッションのタスク、完了条件、判断事項を Agent Cockpit に記録する。開発者への質問、推奨の適用、サブエージェントとの分担を扱う。
---

# Agent Cockpit の使い方

## タスク

- 計画を立てたら `cockpit_set_tasks` を呼び、タスクと完了条件を登録する。
- タスクの状態または完了条件が変わったら、変更後の一覧全体を `cockpit_set_tasks` で置き換える。
- タスクには `todo`、`doing`、`done` の状態を付け、完了条件ごとに `met` を更新する。
- PR のマージを確かめたとき、作業を別のものへ切り替えたときは、その時点で一覧を書き直す。終わったタスクを `doing` のまま残さない。

## 判断事項

- 開発者に選んでもらう内容は `AskUserQuestion` で尋ねる。
- 推奨する選択肢は label の先頭に「(推奨)」を付け、理由を description に書く。
- `AskUserQuestion` の判断事項は自動で記録されるため、`cockpit_add_decision` で重ねて登録しない。
- 尋ねずに推奨を適用する判断は `cockpit_add_decision` で `provisional` として登録し、推奨する選択肢を明示する。
- 適用した選択肢も残す場合は、返された id を `cockpit_update_decision` に渡し、state を `provisional` にして chosen と note を更新する。
- 離席中に `AskUserQuestion` が止められた場合は、示された id を `cockpit_update_decision` に渡し、state を `provisional` にして選んだ選択肢を書く。
- 判断が完了したら `cockpit_update_decision` で state を `resolved` にする。

## サブエージェント

- サブエージェントは Agent Cockpit の MCP ツールを呼ばない。
- メインセッションがサブエージェントの報告を受けてタスクと判断事項を更新する。
