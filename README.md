# agent-cockpit

Claude Code と Codex(CLI、デスクトップ)のセッションの状態を、ローカルのダッシュボードにまとめて表示する常駐サーバーです。
動かすのに外部パッケージは要らず、Node.js 22 以上で動きます。

## 概要

複数の Claude Code や Codex のセッションを並行して動かしているときに、「どのセッションが何をしていて、どこで自分を待っているか」を 1 画面で見渡せます。

- **セッションの状態**:作業中のツール、稼働中のサブエージェント、待機中かどうかを、フックが送るイベントから組み立てて表示します。
- **タスクと完了条件**:メインセッションが MCP ツールで登録した計画を表示します。
- **判断待ちと回答**:`AskUserQuestion`(Codex は `request_user_input`)の質問や、推奨で仮に進めた判断を一覧にします。ダッシュボードから回答すると、フックがセッションへ届けます。
- **離席中**:離席中にすると、質問はダッシュボードで回答を待ち、締切を過ぎたら推奨で進めます。
- **許可待ち**:許可を待っているセッションを表示します。画面から許可は出しません。

常駐サーバーは `127.0.0.1` だけで待ち受け、書き込みの口は起動ごとの秘密値と Origin を照合します。
画面の使い方は、常駐サーバーが `http://127.0.0.1:47821/manual/` で配る利用者向けマニュアルにあります。

## 連携できるツール

agent-cockpit は単独で使えます。次のツールを導入済みなら、表示と操作が増えます。導入していなくても、エラーや警告は出ません。

| ツール | 概要 | 連携するとできること |
|---|---|---|
| [GitHub CLI(`gh`)](https://cli.github.com/) | GitHub の公式 CLI | セッションが作った PR を、スタックの形で CI やレビューの状態と一緒に表示します。スタックの一番下の PR を、画面で確認してマージできます。 |
| [claude-codex-bridge](https://github.com/ktysne/claude-codex-bridge) | Claude Code から Codex CLI を、用途別のサブエージェントとして呼び出す定義一式 | サブエージェントを Codex と Claude のどちらで動かすかを、画面の「経路の設定」で切り替えます。サブエージェントの行に経路と Codex のモデルを表示します。 |
| [ai-cross-review](https://github.com/ktysne/ai-cross-review) | Claude と Codex に、git の差分で交互にコードレビューさせる CLI | PR のカードにクロスレビューの往復と結論を表示します。レビューの収束を待ってからマージする予約ができます。レビュアーを画面の「経路の設定」で選べます。 |
| [Codex](https://github.com/openai/codex)(CLI、デスクトップ) | OpenAI のコーディングエージェント | Codex のセッションも同じダッシュボードに出します。判断事項への回答、離席中の推奨の適用、PR の登録は、Claude のセッションと同じ仕様で動きます。 |

## 導入

導入は AI(Claude Code など)に任せる前提で、手順を [docs/setup.md](docs/setup.md) にまとめています。
AI には、次のように依頼してください。

> agent-cockpit を導入して。手順は https://raw.githubusercontent.com/ktysne/agent-cockpit/main/docs/setup.md にある。

手順書は、agent-cockpit だけを導入する手順と、連携ツールごとに agent-cockpit 側で必要な設定の手順に分かれています。Claude Code を使わず、Codex だけで使う手順もあります。
連携ツールそのものの導入は、それぞれのドキュメントに従ってください。手順書は、導入済みの連携ツールに合わせて agent-cockpit 側の設定を案内します。
`~/.claude/settings.json` や `~/.codex/hooks.json` など、リポジトリの外のファイルを変えるときは、AI が変更内容を示して確認を求めます。
導入済みの agent-cockpit を更新するときは、手順書の「更新するとき」に従います。

## 導入できたかの確認

パターンごとに、次の点を確かめます。具体的なコマンドと期待する結果は、[docs/setup.md](docs/setup.md) の各パターンの「確認」にあります。

| パターン | 確かめること |
|---|---|
| agent-cockpit だけ | `http://127.0.0.1:47821/health` が `"app":"agent-cockpit"` を返す。新しく開いたセッションがダッシュボードに出る。`claude mcp list` で `agent-cockpit` がつながっている。セッションに計画を登録させると、タスクが画面に出る。 |
| + GitHub CLI | `gh auth status` が、環境変数のトークンに頼らずに通る。セッションが作った PR が、CI の状態と一緒に画面に出る。 |
| + claude-codex-bridge | 画面の「経路の設定」にサブエージェントの段が出る。経路を選んでから起動したサブエージェントの行に、動いている間は経路の札が付く。 |
| + ai-cross-review | ai-cross-review を入れたリポジトリでセッションを開くと、「経路の設定」にクロスレビューの段が出る。画面で選んだ値を `node tools/cross-review.js route` が返す。PR のカードにクロスレビューの段が出る。 |
| + Codex | `/hooks` でフックを信頼した後に開いた Codex のセッションが、青紫の色帯付きで画面に出る。`codex mcp list` で `agent-cockpit` が `enabled` になっている。Codex のセッションに計画を登録させると、タスクが画面に出る。 |

## 開発者向けドキュメント

agent-cockpit 自体を開発するときは、[docs/development.md](docs/development.md) から読み始めてください。テストの流し方、イベントの再生、設計資料と計画書の場所をまとめています。

## ライセンス

MIT License。全文は [LICENSE](LICENSE) にあります。
