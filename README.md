# agent-cockpit

Claude Code のフックを受け取り、セッションの状態をローカルのダッシュボードに表示する常駐サーバーです。
外部パッケージは使わず、Node.js 22 以上で動きます。

## 起動

通常は次のコマンドで起動します。

```powershell
npm start
```

サーバーは `127.0.0.1:47821` で待ち受け、ブラウザーで `http://127.0.0.1:47821/` を開くと画面が表示されます。
保存先は `~/.agent-cockpit/` です。
`AGENT_COCKPIT_HOME` を設定すると保存先を変更できます。
`--port` でポートを変え、`--dev` を付けると受信した項目名を調べる開発用 API が有効になります。

```powershell
$env:AGENT_COCKPIT_HOME = Join-Path $env:TEMP 'agent-cockpit-dev'
npm start -- --port 48377 --dev
```

サーバーを終了するときは、起動した端末で `Ctrl+C` を押します。

## タスクトレイ

Windows では、次のコマンドでタスクトレイを起動できます。
`D:\path\to\agent-cockpit` をこのリポジトリの絶対パスに置き換えてください。

```powershell
powershell.exe -NoProfile -STA -WindowStyle Hidden -File "D:\path\to\agent-cockpit\src\tray\tray.ps1"
```

ログオン時に起動するには、`Win + R` で `shell:startup` を開き、ショートカットを作成します。
ショートカットのリンク先を `powershell.exe` にし、引数に次の文字列を設定してください。

```text
-NoProfile -STA -WindowStyle Hidden -File "D:\path\to\agent-cockpit\src\tray\tray.ps1"
```

この手順はショートカットを作成する方法だけを案内します。

## フックの登録

`~/.claude/settings.json` は自動では変更しません。
次の `hooks` の内容を既存設定へ統合し、スクリプトのパスをこのリポジトリの絶対パスに置き換えてください。
`SessionStart` は同期フックとして登録し、それ以外は `async: true` を付けます。
実行ファイルと引数を分ける exec 形式で登録します。

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"] }] }
    ],
    "PreToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "PostToolUseFailure": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ]
  }
}
```

同期の `SessionStart` はサーバーの起動を確認し、起動 URL を `additionalContext` で返します。
フックが送るツール入力は要約だけです。
許可待ちは表示だけで、画面から許可を出す機能はありません。

## テスト

```powershell
npm test
```

テストは `AGENT_COCKPIT_HOME` を一時ディレクトリに設定します。
サーバーの単体テストはポート `0` で起動します。
`ensure-server.js` のテストは空きポートを `AGENT_COCKPIT_PORT` に設定し、ポート `47821` を使いません。
開発機の `~/.agent-cockpit` と通常ポートには接続しません。

## イベント再生

別の端末で一時保存先を設定してサーバーを起動します。

```powershell
$env:AGENT_COCKPIT_HOME = Join-Path $env:TEMP 'agent-cockpit-replay'
npm start -- --port 48377 --dev
```

もう一つの端末でも同じ保存先を設定し、イベントを再生します。

```powershell
$env:AGENT_COCKPIT_HOME = Join-Path $env:TEMP 'agent-cockpit-replay'
node src/dev/replay.js
Invoke-RestMethod http://127.0.0.1:48377/api/state | ConvertTo-Json -Depth 8
```

状態には許可待ちの開始と解消、終了したサブエージェント、codex-agent の監査行、稼働中のサブエージェントと `Stop` による待機が含まれます。
`SessionEnd` を送った再生用セッションは一覧から消えます。
受信した項目名と通知の種類は、`--dev` 起動時だけ `GET /api/dev/fields` で確認できます。
