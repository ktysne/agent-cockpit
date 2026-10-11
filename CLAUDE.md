## このリポジトリについて

Claude Code デスクトップアプリのセッション状態を、内部ブラウザに表示するローカルのダッシュボード。
hooks が送るイベントと、メインセッションが MCP ツールで書く計画・判断事項を、127.0.0.1 の常駐サーバーが集めて表示する。
ダッシュボードで書いた回答は、フック(`PreToolUse` の `updatedInput`、`PostToolBatch` の差し込み、`Stop` の `asyncRewake`)でセッションへ届ける。セッションの受付ソケット(cross-session messaging)は送信形式が公開されていないので使わない。
導入の手順は [docs/setup.md](docs/setup.md)、開発の入口は [docs/development.md](docs/development.md) にある。

## 守ること

- 常駐サーバーは 127.0.0.1 にだけ待ち受ける。書き込みを受ける口は、起動ごとの秘密値と Origin を照合する。照合しないと、別の Web ページからセッションへ指示を注入できてしまう
- セッションの受付トークン(`CLAUDE_CODE_MESSAGING_TOKEN`)はメモリーにだけ置き、ファイルやログに書かない
- `~/.claude/sessions/*.json` は公開仕様ではない。読めなくても本体が動くようにする
- PR のマージは、開発者がダッシュボードで確認したときだけ常駐サーバーが `gh` で行う。画面で見た head の SHA を `--match-head-commit` で照合し、マージできるのはスタックの一番下(base が既定ブランチ)の PR だけにする。モデルにマージを指示する形にはしない
  - 確認欄で「レビュー収束後マージ」を予約したときは、画面で見た head ではなく、クロスレビューの収束を記録した head の SHA で照合する。レビューを経ていないコミットをマージしないため
- 許可待ちは表示だけにし、ダッシュボードから許可を出す口は作らない
- 経路の設定(サブエージェント、クロスレビュー)は全セッション共通で、次に起動するものから効かせる。稼働中のサブエージェントを止めたり切り替えたりしない

## Codex連携の開発

- この節の運用は 2026-10-11 に終了した。`codex/feature-codex-support` は凍結した固定参照であり、新しい作業ブランチと PR を作らない。Codex 対応の正本は main の `docs/handover/2026-10-11-codex-rebuild.md` である。以下は記録として残す。
- 集約先の `codex/feature-codex-support` は `main` から作成し、本実装と関連するPoCや修正は集約先の最新headから `codex/` で始まる作業ブランチを作る。
- PRの作成前とレビュー開始時に、実際のhead、base、headの起点をGitとGitHubで確認する。
- 通常の作業PRは `codex/feature-codex-support` をbaseにする。mainの変更は同期PRで集約先へ随時取り込む。
- Codex対応の全体の流れ、現在地、次の作業、判断待ちは [docs/handover/codex-support.md](docs/handover/codex-support.md) が正本である。PRのマージ、Issueのクローズ、開発者の決定のたびに、その資料をその場で更新する。
- PoCと用済みの引き継ぎ資料は作業ツリーに置かず、固定したコミットの参照だけを同資料の「資料の一覧」に残す。
- 全作業、統合検証、レビューを終えた後に限り、集約先から `main` への最終PRを作る。
- mainへ直接pushせず、mergeは既存の開発者確認フローで行う。
- 現在のダッシュボードがマージできるのはbaseが既定ブランチのPRだけである。この制限を迂回せず、モデルの判断だけでfeature向けPRをマージしない。
- ClaudeとCodexで同じ結果を期待する機能は、[適合試験方針](docs/design/provider-conformance-testing.md)に機能単位のscenarioを追加する。
- scenarioの期待値は実装から独立に定め、両adapterの結果、fixtureと実runtimeの区別、未確認理由を記録する。
- 未実装側や未実行runtimeを成功扱いしない。

## モックとの整合

- GUI のモック([mock/index.html](mock/index.html))は、開発者と合意した最終形の見た目と機能の正本である。実装はモックの見た目と機能にそろえる
- 各機能を実装するときは、モックの該当箇所と照らし合わせて食い違いが無いかを確かめる
- 検証の結果、実現できないことや表現を変える必要が出たら、計画書の決定済みの判断に記録したうえで、その場でモックにも反映する。モックと計画書と実装を食い違わせたままにしない

## AIクロスレビュー

手順は [docs/cross-review.md](docs/cross-review.md) と cross-review スキルに従う。観点は [.cross-review.md](.cross-review.md)。

## テスト

- テストを書く、直す、消す基準は [docs/testing.md](docs/testing.md) に従う。製品の入口から到達しないモジュールの単体テストと、信頼境界の内側への防御検査は書かない
- 全体のテストは `npm test` で流す
- 子プロセスを起動できない環境(Codex の Windows サンドボックスなど。`npm test` が `spawn EPERM` で止まる)では、`npm run test:inprocess` を使う。テストファイルを 1 つのプロセスで流すので、テストランナーが子プロセスを起動しない
  - `test/ensure-server.test.js` は常駐サーバーを子プロセスで起動して確かめるので、この環境では失敗する。報告では、その失敗を「子プロセスを起動できないため未確認」と書き、ほかのテストの合否と分ける

## Claude と Codex の設定文書

`CLAUDE.md`はClaude Code向け、`AGENTS.md`はCodex向けの独立した正本として管理する。
両方のエージェントが守る規則は、それぞれの正本に記載する。
片方の変更をもう片方へ自動反映せず、指定されたファイルだけを更新する。

## リモートセッション時の作業について

- クラウドセッションは `~/.claude` を読まないので、グローバルの CLAUDE.md とフックが効かない
- 開発者に見える文を日本語に保つフックは、リポジトリの `.claude/hooks/japanese-guard.js` に置いてある。仕組みと他のリポジトリへの写し方は [docs/japanese-guard.md](docs/japanese-guard.md) にある
