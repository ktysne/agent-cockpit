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

## Codex機能のブランチ運用

- 集約先の codex/feature-codex-support は main から作成する。
- Codexの本実装と、それに関連するPoCや修正作業は、最新の codex/feature-codex-support から codex/ で始まる作業ブランチを作成する。
- 作業PRのbaseは codex/feature-codex-support とし、レビュー済みの変更を集約先へ取り込む。
- PRの作成前とレビュー時に、gitとghで実際のhead、base、headの起点を確認する。通常作業のPRがmainを向く場合や、headとbaseが逆の場合は、レビューや取り込みの前に修正する。
- mainの変更は同期PRで集約先へ随時取り込む。取り込みは元のheadを祖先として残す通常のmerge commitで行い、squash mergeとrebase mergeは使わない。
- Codex対応の全体の流れ、現在地、次の作業、判断待ちは docs/handover/codex-support.md が正本である。PRのマージ、Issueのクローズ、開発者の決定のたびに、その資料をその場で更新する。
- PoCと用済みの引き継ぎ資料は作業ツリーに置かず、固定したコミットの参照だけを同資料の「資料の一覧」に残す。
- 全作業、統合検証、レビューが完了した後に限り、codex/feature-codex-support から main への最終PRを作成する。mainへ直接pushせず、開発者が確認して承認する前に取り込まない。
- 現在のダッシュボードはbaseが既定ブランチのPRだけをマージ対象にする。この制限を迂回せず、モデル判断でfeature向けPRをマージしない。

## モックとの整合

- GUI のモック([mock/index.html](mock/index.html))は、開発者と合意した最終形の見た目と機能の正本である。実装はモックの見た目と機能にそろえる
- 各機能を実装するときは、モックの該当箇所と照らし合わせて食い違いが無いかを確かめる
- 検証の結果、実現できないことや表現を変える必要が出たら、計画書の決定済みの判断に記録したうえで、その場でモックにも反映する。モックと計画書と実装を食い違わせたままにしない

## Claude/Codex適合試験

ClaudeとCodexで同じ結果を期待するCockpit機能は、本実装に合わせて [docs/design/provider-conformance-testing.md](docs/design/provider-conformance-testing.md) の適合試験を機能単位で追加し、関連IssueとPRの完了条件にする。
全機能の実装後に横断する実runtime統合試験を行う。
未実装側や未実行runtimeは成功や同等と扱わず、PRに結果と未確認理由を記録する。

## AIクロスレビュー

手順は [docs/cross-review.md](docs/cross-review.md) と cross-review スキルに従う。観点は [.cross-review.md](.cross-review.md)。
通常のCodexレビューは `codex-review`モデル定義を使う。`.claude/gpt-agents/codex-review.md` があればそれを優先し、無ければ `~/.claude/gpt-agents/codex-review.md` を参照する。Astraは、AGENTS.mdで相談が必要とされる困難な設計判断などに限って使う。

## テスト

- 全体のテストは `npm test` で流す
- 子プロセスを起動できない環境(Codex の Windows サンドボックスなど。`npm test` が `spawn EPERM` で止まる)では、`npm run test:inprocess` を使う。テストファイルを 1 つのプロセスで流すので、テストランナーが子プロセスを起動しない
  - `test/ensure-server.test.js` は常駐サーバーを子プロセスで起動して確かめるので、この環境では失敗する。報告では、その失敗を「子プロセスを起動できないため未確認」と書き、ほかのテストの合否と分ける

## CLAUDE.md と AGENTS.md の管理

両方のエージェントが守る規則は、CLAUDE.md と AGENTS.md のそれぞれに記載する。
両ファイルは対象エージェントごとに独立して管理し、片方の変更をもう一方へ自動的に反映せず、変更対象に指定されたファイルだけを更新する。

## リモートセッション時の作業について

- クラウドセッションは `~/.claude` を読まないので、グローバルの CLAUDE.md とフックが効かない
- 開発者に見える文を日本語に保つフックは、リポジトリの `.claude/hooks/japanese-guard.js` に置いてある。仕組みと他のリポジトリへの写し方は [docs/japanese-guard.md](docs/japanese-guard.md) にある
