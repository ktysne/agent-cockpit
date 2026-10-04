# agent-cockpit の開発

agent-cockpit 自体を開発するときの入口です。利用者向けの導入は [setup.md](setup.md)、画面と機能は [usage.md](usage.md) にあります。

## 最初に読むもの

| 文書 | 内容 |
|---|---|
| [CLAUDE.md](../CLAUDE.md) / [AGENTS.md](../AGENTS.md) | 開発で守ること(待ち受けと照合、秘匿、マージの条件、モックとの整合など)。2 つは同じ内容に保つ |
| [mock/index.html](../mock/index.html) | 開発者と合意した最終形の見た目と機能の正本。実装はモックにそろえる |
| [docs/handover/2026-10-02.md](handover/2026-10-02.md) | 実装の計画書。決定済みの判断、対応順序、判断待ち、落とし穴 |
| [docs/design/server.md](design/server.md) | 常駐サーバー、フック、画面の設計 |
| [docs/architecture.html](architecture.html) / [docs/architecture-detail.html](architecture-detail.html) | 構成要素と通信経路の図。回答の届け方、PR の登録からマージまでの流れ |
| [docs/poc-results.md](poc-results.md) | PoC で確かめたことと、分かった制約。再現の一式は `poc/` にある |
| [docs/cross-review.md](cross-review.md) / [.cross-review.md](../.cross-review.md) | AI クロスレビューの手順と、このリポジトリのレビュー観点 |
| [docs/japanese-guard.md](japanese-guard.md) | 開発者に見える文を日本語に保つフック(クラウドセッション向け) |

## ディレクトリの構成

| 場所 | 中身 |
|---|---|
| `src/server/` | 常駐サーバー。状態の組み立て、保存、PR の取得とマージ、経路の設定 |
| `src/hooks/` | Claude Code のフック。`event.js`(イベント送信と常駐サーバーの起動)、`away.js`(離席中の質問待ち)、`answer.js`(回答の配信)、`route.js`(サブエージェントの経路) |
| `src/mcp/` | タスクと判断事項を書き込む MCP サーバー |
| `src/web/` | ダッシュボードの画面(1 ファイル) |
| `src/tray/` | Windows のタスクトレイとショートカットの作成 |
| `src/dev/` | 開発用のイベント再生 |
| `skills/agent-cockpit/` | メインセッションが読むスキル |
| `test/` | テスト |

## テスト

```powershell
npm test
```

- テストは `AGENT_COCKPIT_HOME` を一時ディレクトリに設定します。サーバーの単体テストはポート `0` で起動します。
- `ensure-server.js` のテストは空きポートを `AGENT_COCKPIT_PORT` に設定し、ポート `47821` を使いません。
- 開発機の `~/.agent-cockpit` と通常のポートには接続しません。

子プロセスを起動できない環境(Codex の Windows サンドボックスなど)では、`npm test` が `spawn EPERM` で止まります。その環境では、テストファイルを 1 つのプロセスで流す次のコマンドを使います。

```powershell
npm run test:inprocess
```

`test/ensure-server.test.js` は常駐サーバーを子プロセスで起動するので、この環境では失敗します。報告では、その失敗を「子プロセスを起動できないため未確認」と書き、ほかのテストの合否と分けます。

## 開発用の起動

普段使いの保存先と分けるため、一時保存先と別のポートで起動します。`--dev` を付けると、受信した項目名と通知の種類を `GET /api/dev/fields` で確かめられます。

```powershell
$env:AGENT_COCKPIT_HOME = Join-Path $env:TEMP 'agent-cockpit-dev'
npm start -- --port 48377 --dev
```

## イベントの再生

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

状態には、許可待ちの開始と解消、終了したサブエージェント、codex-agent の監査行、稼働中のサブエージェントと `Stop` による待機が含まれます。
`SessionEnd` を送った再生用セッションは一覧から消えます。

## アプリアイコン

元画像は `assets/agent-cockpit_icon.png` にあります。64×64 の画面用画像は次のコマンドで作り直せます。ショートカット用の ICO は、インストール時に元画像から生成されます。

```powershell
powershell.exe -NoProfile -File ".\tools\make-icons.ps1"
```

画面のアイコンは、`src/web/index.html` と `mock/index.html` にこの 64×64 の画像を data URI で埋め込んでいます(タブのアイコンとタイトルの左の 2 か所ずつ)。元画像を差し替えたら、作り直した画像の base64 でこの 4 か所も書き換えてください。

## 文書を直すとき

- 導入の手順(フック、MCP サーバー、スキル、連携ツールごとの設定と確認)を変えたら [setup.md](setup.md) を直します。
- 画面や機能の挙動を変えたら [usage.md](usage.md) と [design/server.md](design/server.md) を直します。
- 連携ツールや概要が変わったら [README.md](../README.md) を直します。
