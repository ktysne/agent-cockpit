# PR登録とレビュー通知のPoC

`docs/poc-codex-164.md`を判定、実測、制約の正本とする。
本番機能の完成とは分け、`src/`と既存PoCを変更しない。

- `fixture-contract.js`と`model.js`：#163との仮契約による識別、PR登録、review分類、予約、通知台帳。
- `gh-output-adapter.js`：成功したgh pr createの合成出力と明示bindingの登録境界。
- `existing-probe.js`：既存本番PR処理と専用Cockpitへ偽ghを注入した測定。
- `native-probe.js`と`mcp-probe.js`：専用Codex HOMEとapp-serverのMCP metadata測定。

結果は新規の`poc/out/poc164-*`へ保存する。
同じ出力先を再利用せず、実際のghによる開発PRの操作は行わない。
通常ホーム、通常daemonと既存チャットは対象外。

```powershell
node --test --test-isolation=none poc/codex-pr-review-notifications/*.test.js
node poc/codex-pr-review-notifications/existing-probe.js --out poc/out/poc164-existing-a
node poc/codex-pr-review-notifications/native-probe.js --codex-path <codex.exeの絶対パス> --out poc/out/poc164-native-a
```

native試験にはローカルのCodex実行ファイルが必要。
使用版はその実行ファイルから取得し、設定値と実metadataを分けて記録する。
親子関係の合成登録と直接MCP RPCは、モデルのMCP呼出しや実Claudeからの委譲成功を意味しない。
配送受付が不明な通知は自動再送しない。
