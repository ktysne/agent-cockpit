# agent-cockpit の開発

agent-cockpit 自体を開発するときの入口です。利用者向けの導入は [setup.md](setup.md)、画面と機能は、常駐サーバーが `/manual/` で配る利用者向けマニュアルにあります。

## 最初に読むもの

| 文書 | 内容 |
|---|---|
| [CLAUDE.md](../CLAUDE.md) / [AGENTS.md](../AGENTS.md) | 開発で守ること。Claude Code向けとCodex向けの規約は独立して管理する |
| [mock/index.html](../mock/index.html) | 開発者と合意した最終形の見た目と機能の正本。実装はモックにそろえる |
| [docs/handover/2026-10-02.md](handover/2026-10-02.md) | 実装の計画書。決定済みの判断、対応順序、判断待ち、落とし穴 |
| [Codex本実装計画](design/codex-implementation-plan.md) | Claude/Codex共通機能の段階実装、依存関係、統合ゲート |
| [Claude/Codex適合試験方針](https://github.com/ktysne/agent-cockpit/blob/f4460762641d9eef6c0eb0c2c9c55df4f625532e/docs/design/provider-conformance-testing.md) | 共通適合試験のscenario定義、検証層、結果の扱い |
| [Codex共有契約](https://github.com/ktysne/agent-cockpit/blob/a2da27f1f51e932a0184cea72da38fc89b1c5c5f/docs/design/codex-shared-contract.md) | Codex連携の共有契約。参照モデルは実adapter適合の証明ではない |
| [docs/design/server.md](design/server.md) | 常駐サーバー、フック、画面の設計 |
| [docs/design/codex-shared-contract.md](design/codex-shared-contract.md) | Codex連携の会話識別、所有者引継ぎ、入力配信の共有契約 |
| [docs/design/manual.md](design/manual.md) | 利用者向けマニュアルの構成、デモ状態、画面の撮影、配信、検査の設計 |
| [docs/architecture.html](architecture.html) / [docs/architecture-detail.html](architecture-detail.html) | 構成要素と通信経路の図。回答の届け方、PR の登録からマージまでの流れ |
| [docs/poc-results.md](poc-results.md) | PoC で確かめたことと、分かった制約。再現の一式は `poc/` にある |
| [適合試験の設計](design/provider-conformance-testing.md) | Claude/Codex共通機能の適合シナリオ、検証層、結果の扱い |
| [共有契約](https://github.com/ktysne/agent-cockpit/blob/a2da27f1f51e932a0184cea72da38fc89b1c5c5f/docs/design/codex-shared-contract.md) | Codex連携の共有契約。参照モデルは実adapterの適合証明ではない |
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
| `manual/` | 利用者向けマニュアルの原稿、撮影の定義、撮った画像、組み立てた結果(`dist/`) |
| `tools/manual/` | マニュアルの組み立て、検査、デモ状態、撮影 |
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

## マニュアル

設計は [docs/design/manual.md](design/manual.md) にあります。

| コマンド | すること |
|---|---|
| `npm run manual:build` | 原稿から `manual/dist/` を組み立て直す。原稿を直したら実行して、結果もコミットする |
| `npm run lint:manual` | 組み立ての結果、画面の文言、画像、リンクを検査する。`npm test` からも走る |
| `npm run manual:capture -- [定義名...]` | デモ状態の常駐サーバーと Edge(または Chrome)のヘッドレスで画面を撮り、`manual/img/` を更新する。画面を変えたら実行する |
| `npm run manual:demo -- [シナリオ名] [--port N] [--fixed]` | デモ状態の常駐サーバーを起動したままにする。原稿を書くときに画面を見ながら確かめる |

撮影とデモは、一時ディレクトリの保存先と偽の `gh` を使います。普段の `~/.agent-cockpit/`、`~/.claude/`、ポート `47821` の常駐サーバーには触れません。
ブラウザは環境変数 `MANUAL_BROWSER` で指定でき、無ければ Edge と Chrome の既定の場所を探します。

## アプリアイコン

元画像は `assets/agent-cockpit_icon.png` にあります。64×64 の画面用画像は次のコマンドで作り直せます。ショートカット用の ICO は、インストール時に元画像から生成されます。

```powershell
powershell.exe -NoProfile -File ".\tools\make-icons.ps1"
```

画面のアイコンは、`src/web/index.html` と `mock/index.html` にこの 64×64 の画像を data URI で埋め込んでいます(タブのアイコンとタイトルの左の 2 か所ずつ)。元画像を差し替えたら、作り直した画像の base64 でこの 4 か所も書き換えてください。

## 文書を直すとき

- 導入の手順(フック、MCP サーバー、スキル、連携ツールごとの設定と確認)を変えたら [setup.md](setup.md) を直します。
- 画面や機能の挙動を変えたら、マニュアルの原稿(`manual/pages/`)と [design/server.md](design/server.md) を直します。画面の見た目が変わるときは、撮影し直して `manual/dist/` も組み立て直します(上の「マニュアル」)。
- 連携ツールや概要が変わったら [README.md](../README.md) を直します。
