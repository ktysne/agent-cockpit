# 導入の整合の診断の設計

この資料は、agent-cockpit の導入と更新の後に、フック、MCP サーバー、スキル、常駐サーバーが checkout と食い違っていないかを調べる診断(`src/client/doctor.js`)の仕様を定める。
診断は、更新と反映を決定的な処理で行う後の段階の入力にもなる。段階の分け方と進みは [引き継ぎ資料](../handover/2026-10-20-tool-update.md) にある。

## 守ること

- 診断は読み取りだけを行う。設定ファイル、写し、常駐サーバー、動作中のセッションを変えない。フックの信頼、ログイン、再起動も行わない。
- 出力に秘密値を含めない。`server.json` から読むのは `port`、`pid`、`startedAt` だけで、`secret` は読み出した値を保持しない。MCP の登録の `env` と、設定ファイルのうち agent-cockpit の登録以外の部分は出力しない。
- 公開仕様でないファイル(Claude の `.claude.json`、Codex の `config.toml` の `[hooks.state]`)は、読めない、形が違うときに `unverified` にし、診断を止めない。
- 利用者が足した独自のフックや設定は照合の対象にせず、設定全体を置き換える案を出さない。
- 未導入の provider は、その provider の項目を 1 件の `not-installed` にまとめ、警告として扱わない。

## 入口

```sh
node src/client/doctor.js [--json] [--root <checkout>]
```

- 既定は人が読む一覧で、`--json` は下の「出力の形」の JSON を標準出力に書く。
- 終了コードは、`mismatch` が 1 件でもあれば 1、無ければ 0、診断そのものが失敗したら 2 にする。`unverified` と `not-run` だけなら 0 である。

## 照合する checkout

期待値を作る checkout(以下、対象の checkout)は、次の順に決める。

1. `--root` で渡したパス。
2. 登録済みのフックが指す agent-cockpit のスクリプト(`src/hooks/*.js`)の、`src/` の手前のディレクトリ。`package.json` の `name` が `agent-cockpit` のものに限る。provider をまたいで複数の checkout を指していれば、フックの項目を `mismatch` にし、候補をすべて観測値に載せる。対象の checkout は 3 で決める。
3. `doctor.js` を置いた checkout。そこが git の worktree なら、元のリポジトリの checkout に置き換える。

期待値の `version` と `commit` は、対象の checkout の `package.json` と `HEAD` から読む。

## ホームの解決

| 対象 | 場所 |
|---|---|
| Claude のホーム | `CLAUDE_CONFIG_DIR`、無ければ `~/.claude` |
| Claude のユーザースコープの MCP の登録 | `CLAUDE_CONFIG_DIR` があればその中の `.claude.json`、無ければユーザーホーム直下の `.claude.json` |
| Codex のホーム | `CODEX_HOME`、無ければ `~/.codex` |
| 保存先 | `AGENT_COCKPIT_HOME`、無ければ `~/.agent-cockpit` |

provider は、ホームに agent-cockpit のフック、MCP の登録、スキルのどれかがあれば導入済みとする。

## 期待値の正本

期待するフック、MCP の登録、スキルの対応は `src/shared/integration-manifest.js` が正本である。
[導入手順](../setup.md) の JSON と TOML の例は、このモジュールを `D:/path/to/agent-cockpit` で展開した内容と一致させ、テストで縛る。
導入手順を変えるときは、モジュールと導入手順を同じ変更で直す。

## 項目

| 区分 | 照合する内容 | 主な結果 |
|---|---|---|
| server | `/health` の `version`、`commit`、`sourceState` を対象の checkout と比べる | 一致で `ok`、違えば `mismatch`。動いていなければ `unverified`(SessionStart のフックが起動するため) |
| hooks | 期待する登録ごとに、同じイベントと matcher で同じスクリプトを指す登録を探し、引数、timeout、`async`、`asyncRewake` を比べる。agent-cockpit のスクリプトを指すが期待に無い登録も挙げる | 足りない、値が違う、余分、別の checkout を指すものは `mismatch` |
| mcp | Claude は `.claude.json` の `mcpServers['agent-cockpit']`、Codex は `config.toml` の `[mcp_servers.agent-cockpit]` の実行先と、各ツールの `approval_mode` | 違えば `mismatch`。Claude のプロジェクトのスコープに同名の登録があれば、そちらが効くので `unverified` |
| mcp-runtime | 診断ログ(`GET /api/diagnostics`)の今の起動の `mcp.write` に残る MCP プロセスの `version` と `commit` | 期待値より古いものがあれば `mismatch`。記録が無ければ `unverified` |
| skills | 正本と写しを、行末の違いを除いて比べる | 違えば `mismatch`。agent-cockpit のスキルが無ければ `mismatch`、`update-tools` が無ければ `not-installed` |
| runtime-check | MCP からの書き込みと質問の回答の往復 | 常に `not-run`。導入手順の「確認」へ案内する |

パスは、`\` と `/` の違い、末尾の区切り、Windows の大文字小文字を除いて比べる。`fs.realpath` は使わない。ジャンクションで別のパスに解決されるためである。
Codex のフックの `command` は、`node "<パス>" codex` の形の文字列から、スクリプトのパスと末尾の引数を取り出して比べる。

セッションが古い登録で動いているかは判定しない。ファイルの更新時刻は、同じ内容の写し直しでも変わるため、誤った案内が増えるからである。
代わりに、フック、MCP、スキルのどれかに `mismatch` があれば、直した後に開いたセッションだけが新しい内容で動くことを `manual` の対処として必ず添える。

## 出力の形

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-20T00:00:00.000Z",
  "checkout": { "root": "D:/Desktop/Develop/agent-cockpit", "version": "1.8.0", "commit": "<40 桁>", "resolvedBy": "hooks" },
  "homes": { "claude": "...", "codex": "...", "cockpit": "..." },
  "summary": { "ok": 0, "mismatch": 0, "unverified": 0, "notRun": 0, "notInstalled": 0 },
  "items": []
}
```

項目は次の形にする。

| キー | 内容 |
|---|---|
| `id` | 項目を一意に指す文字列(例: `claude.hooks.PreToolUse.AskUserQuestion.away`) |
| `tool` | 対象のツール。今は `agent-cockpit` だけ |
| `provider` | `claude`、`codex`、または provider によらない項目では `null` |
| `category` | 上の表の区分 |
| `target` | 対象のファイルのパスか、名前 |
| `expected`、`observed` | 期待値と観測値。秘密値を含めない |
| `observedAt` | 観測した時刻 |
| `result` | `ok`、`mismatch`、`unverified`、`not-installed`、`not-run` |
| `reason` | 結果の理由を利用者向けに 1 文で |
| `actions` | 対処の配列。下の「対処の形」 |

### 対処の形

対処は、後の段階がそのまま適用できる差分として持つ。

| `op` | 内容 |
|---|---|
| `json-add`、`json-replace`、`json-remove` | `file`、`path`(例 `["hooks","PreToolUse"]`)、`match`(配列の中の要素を選ぶ条件。matcher とスクリプト)、`value`。配列の添字は持たない。利用者の独自のフックが混ざり、読み直すたびに添字が変わるため |
| `toml-set` | `file`、`table`(例 `mcp_servers.agent-cockpit`)、`key`、`value`。`[hooks.state]` は対象にしない |
| `copy` | `from`(対象の checkout からの相対パス)、`to`(絶対パス) |
| `command` | `command`(例 `node src/client/restart-server.js --json`)と、実行する場所 |
| `manual` | 開発者の操作(セッションの開き直し、Codex の `/hooks` での信頼し直し)を `text` で |

ファイルを書き換える対処には、`observedDigest`(観測したファイル全体の sha256)を付ける。適用する側は、適用の直前に計算し直し、違えばその対処を適用しない。
Codex の `hooks.json` を書き換える対処には、`/hooks` で信頼し直す `manual` を必ず対にする。信頼の記録はフックの内容のハッシュで、書き換えると外れるためである。
