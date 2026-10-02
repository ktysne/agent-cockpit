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

Windows では、リポジトリ直下の `start-tray.cmd` をダブルクリックすると、タスクトレイを起動してダッシュボードを開きます。
起動の瞬間に黒いウィンドウが一瞬表示されます。
どの起動方法も、PowerShell の実行ポリシーが `RemoteSigned` 以上であることを前提にしています(`Get-ExecutionPolicy` で確かめられます)。
既定の `Restricted` のままでは、ウィンドウを出さずに起動が失敗します。

ショートカットには、スクリプトを実行したチェックアウトの絶対パスが入ります。
worktree を消すとリンクが切れるので、本体のチェックアウトから実行してください。

```powershell
powershell.exe -NoProfile -File ".\src\tray\install-shortcut.ps1"
```

このスクリプトを実行すると、デスクトップとスタートメニューに「Agent Cockpit」のショートカットができます。
ショートカットを作り直すと、起動引数も更新されます。
これらのショートカットをダブルクリックすると、タスクトレイを起動してダッシュボードを開きます。
黒いウィンドウは表示されません。

ログオン時にタスクトレイだけを自動起動するには、`-Startup` を付けて実行します。
自動起動をやめるときは、同じ場所の指定に `-Remove` を付けます。

```powershell
powershell.exe -NoProfile -File ".\src\tray\install-shortcut.ps1" -Startup
powershell.exe -NoProfile -File ".\src\tray\install-shortcut.ps1" -Remove -Startup
```

ダッシュボードを閉じてもタスクトレイは動き続けます。
タスクトレイのメニューに「常駐サーバーを再起動」があります。確認すると、`server.json` の PID のプロセスコマンドラインに、このチェックアウトの `src/server/server.js` が含まれる場合だけ停止して起動し直します。ファイルが無い場合や別のプロセスを指している場合は、停止せずに起動処理へ進みます。ダッシュボードのウィンドウは閉じず、開いている画面は自動的につなぎ直し、表示中のセッション状態は次のイベントから組み立て直されます。
タスクトレイのメニューで「終了」を選ぶと、ダッシュボードとタスクトレイを終了します。常駐サーバーは動き続けます。

アプリアイコンの元画像は `assets/agent-cockpit_icon.png` にあります。64×64 の画面用画像は次のコマンドで作り直せます。ショートカット用 ICO はインストール時に元画像から生成されます。

```powershell
powershell.exe -NoProfile -File ".\tools\make-icons.ps1"
```

画面のアイコンは、`src/web/index.html` と `mock/index.html` にこの 64×64 の画像を data URI で埋め込んでいます(タブのアイコンとタイトルの左の 2 か所ずつ)。元画像を差し替えたら、作り直した画像の base64 でこの 4 か所も書き換えてください。

「設定」の画面では「表示」から配色を変更できます。

表示モードを「プロダクト別」と「種類別」で切り替えられます。上部の件数タグを押すとその種類を隠し、「すべて表示する」で戻せます。プロダクト別では、各プロダクトを固定、上下移動、折りたたみできます。表示設定はブラウザーの `localStorage` に保存されます。保存できない場合も操作できますが、再読み込みすると初期状態に戻ります。

## フックの登録

`~/.claude/settings.json` は自動では変更しません。
次の `hooks` の内容を既存設定へ統合し、スクリプトのパスをこのリポジトリの絶対パスに置き換えてください。
`event.js` の `SessionStart` は同期フックとして登録し、それ以外には `async: true` を付けます。
実行ファイルと引数を分ける exec 形式で登録します。

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"] }] },
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/away.js"], "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] },
      { "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/away.js"], "timeout": 330 }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "PostToolUseFailure": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "PostToolBatch": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/answer.js"], "timeout": 2 }] }
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
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] },
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/answer.js"], "asyncRewake": true, "timeout": 3600 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] },
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/away.js"], "timeout": 5 }] },
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/answer.js"], "timeout": 5 }] }
    ]
  }
}
```

同期の `SessionStart` はサーバーの起動を確認し、起動 URL を `additionalContext` で返します。
フックが送るツール入力は要約だけです。
許可待ちは表示だけで、画面から許可を出す機能はありません。
`away.js` は `PreToolUse`(matcher `AskUserQuestion`)に同期フックとして登録し、timeout を 330 秒にします。
`UserPromptSubmit` と `SessionStart` の `away.js` は同期フックとして登録し、timeout を 5 秒にします。
`PostToolBatch` の `answer.js` は同期フックとして登録し、timeout を 2 秒にします。
`Stop` の `answer.js` は `asyncRewake: true` と timeout 3600 秒で登録します。
`UserPromptSubmit` にも `answer.js` を同期フックとして登録し、渡した回答が反映されていない場合に、最大 3 回まで文脈へ差し込み直します。
`away.js` は開始時と各ターンの入力時にタスク登録の決まりを知らせ、`PostToolBatch` の `answer.js` は条件に応じて作業中の登録を促します。

離席中は画面上部のチェックボックスか、タスクトレイの右クリックメニューで切り替えます。
有効な間、`AskUserQuestion` はダッシュボードの回答を最大 5 分待ちます。締切までに回答が無ければ質問を止め、推奨で作業を続けるようフックが伝えます。常駐サーバーへの再接続に失敗した場合も、離席中が続いていれば同じ扱いです。
離席中が解除されていれば、再接続失敗時も `released` として扱い、フックは回答を返さずデスクトップアプリのダイアログへ戻します。
回答待ちのフックから 30 秒間 long-poll が届かない場合は待ちを解除し、届いていた回答も破棄してデスクトップアプリのダイアログへ戻します。
ダッシュボードでは「推奨案で OK」「判断を保留する」「指示」を送れます。保留の回答は推奨のまま進め、最後の報告に記載するよう伝えます。推奨の無い質問への保留は、離席中が続いていれば締切と同じ扱いにします。離席中が解除された場合は保留回答を破棄してダイアログへ戻します。
回答待ちの質問への回答は `PreToolUse` の `updatedInput` で渡し、元の `tool_input` を保ったまま `answers` を加えます。
作業中は `PostToolBatch` から回答を差し込み、停止中は `Stop` の `asyncRewake` フックが回答を待ってセッションを起こします。
`awaitingAnswerUntil` がある質問の回答は、`PostToolBatch`、`UserPromptSubmit`、`Stop` からは渡しません。
回答本文は常駐サーバーのメモリーとフックの出力にだけ置きます。
許可のダイアログには答えず、破壊的な操作、PR のマージ、`main` への push は判断待ちに残します。
`claude -p` では `AskUserQuestion` が無効なため、この制御は対話セッションでだけ働きます。

フックの登録後に開いたセッションから離席中の制御が有効になります。
すでに実行中のセッションは、後から追加したフックを読み込みません。

## タスクと判断事項

メインセッションは計画を立てた後に MCP ツール `cockpit_set_tasks` を呼び、タスクと完了条件を登録します。
タスクの状態や完了条件が変わったときは、一覧全体を置き換えます。

`AskUserQuestion` の質問はフックが自動で判断事項にします。
推奨は、単一選択の質問で label に「(推奨)」または「(Recommended)」(括弧は全角・半角を許容し、英語の大文字小文字は区別しない)を含む選択肢、または MCP の `cockpit_add_decision` で `recommended: true` を明示した選択肢がちょうど 1 つのときに付け、description は判定に使いません。
複数の選択肢に含まれる場合や、質問が複数選択の場合は推奨なしとして扱います。
質問せずに推奨を適用する判断は `cockpit_add_decision` または `cockpit_update_decision` で記録します。

画面は判断事項の状態、待ち時間、背景、質問、選択肢を表示します。
解決済みと取り下げの判断事項、および完了したタスクは折りたたまれます。
回答欄から推奨案で OK、判断の保留、または指示だけの回答を送れます。
メインセッションでの MCP ツールの使い方は [agent-cockpit スキル](skills/agent-cockpit/SKILL.md) にあります。

## MCP サーバーとスキルの登録

MCP サーバーは、Node.js の実行ファイルとこのリポジトリの `src/mcp/server.js` をユーザースコープで登録します。
作業ツリーのルートで次を実行してください。

```powershell
$nodePath = (Get-Command node).Source
$serverPath = (Resolve-Path .\src\mcp\server.js).Path
claude mcp add --scope user agent-cockpit -- $nodePath $serverPath
```

この登録方法と `--` による実行コマンドの指定は [Claude Code の MCP ガイド](https://docs.anthropic.com/en/docs/claude-code/mcp) に記載されています。
登録後、実際のセッションで MCP 環境の `CLAUDE_CODE_SESSION_ID` とフックの `session_id` が同じ値であることを確かめてください。

スキルは `~/.claude/skills/agent-cockpit/` にコピーします。
PowerShell では次のように実行します。

```powershell
$skillDirectory = Join-Path $env:USERPROFILE '.claude\skills\agent-cockpit'
New-Item -ItemType Directory -Path $skillDirectory -Force | Out-Null
Copy-Item .\skills\agent-cockpit\SKILL.md (Join-Path $skillDirectory 'SKILL.md') -Force
```

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
