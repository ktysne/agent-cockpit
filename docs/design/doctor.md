# 導入の整合の診断の設計

この資料は、agent-cockpit の導入と更新の後に、フック、MCP サーバー、スキル、常駐サーバーが checkout と食い違っていないかを調べる診断(`src/client/doctor.js`)の仕様を定める。
診断は、更新と反映を決定的な処理で行う後の段階の入力にもなる。段階の分け方と進みは [引き継ぎ資料](../handover/2026-10-20-tool-update.md) にある。

## 守ること

- 診断は読み取りだけを行う。設定ファイル、写し、常駐サーバー、動作中のセッションを変えない。フックの信頼、ログイン、再起動も行わない。
- 出力に秘密値を含めない。`server.json` から読むのは `port`、`pid`、`startedAt` だけで、`secret` は読み出した値を保持しない。MCP の登録の `env` と、設定ファイルのうち agent-cockpit の登録以外の部分は出力しない。
- 公開仕様でないファイル(Claude の `.claude.json`、Codex の `config.toml` の `[hooks.state]`)は、読めない、形が違うときに `unverified` にし、診断を止めない。
- 利用者が足した独自のフックや設定は照合の対象にせず、設定全体を置き換える案を出さない。
- 未導入の provider は、その provider の項目を 1 件の `not-installed` にまとめ、警告として扱わない。
- 適用前の退避には `.claude.json` の秘密値も含まれるため、`backups/` と各回のフォルダーは mode `0o700`、写しと manifest は `0o600` で作る。出力するのは退避先のパスだけで、中身は出さない。
- Claude Code は `.claude.json` の書き込みを排他する手段を公開していない。一時ファイルの作成後にも照合するが、最後の読み直しから rename までの間の更新は失われうる。この競合は受け入れ、セッションが応答を書いている最中の適用を避けるよう案内する。上書き前の内容は退避から戻せる。

## 入口

```sh
node src/client/doctor.js [--json] [--root <checkout>]
```

- 既定は人が読む一覧で、`--json` は下の「出力の形」の JSON を標準出力に書く。
- 終了コードは、`mismatch` が 1 件でもあれば 1、無ければ 0、診断そのものが失敗したら 2 にする。`unverified` と `not-run` だけなら 0 である。

## 読み取り、評価、出力の分担

`src/client/doctor-observe.js` の `observe(options)` が、ファイルと常駐サーバーを読み、対象の checkout、期待値、観測した時刻を含む観測結果を返す。
`server.json` の `secret` は観測結果に含めない。
`src/client/doctor-evaluate.js` の `evaluate(observation)` が、観測結果だけから診断の項目と対処を作る。
評価は I/O を持たず、時刻や環境変数も読み取らない。

`src/client/doctor.js` は読み取りと評価を順に呼び、人が読む一覧か JSON を出力する。
適用コマンドも同じ読み取りと評価を使い、適用の直前に診断をやり直す。

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
| mcp-runtime | 診断ログ(`GET /api/diagnostics`)の今の起動の `mcp.write` に残る MCP プロセスの `version` と `commit` | すべて期待値と一致すれば `ok`。古いものがあれば、開き直しの案内を付けて `unverified`。記録はセッションを閉じた後も起動のあいだ残り、今動いているとは言えないため。記録が無ければ `unverified` |
| skills | 正本と写しを、行末の違いを除いて比べる | 違えば `mismatch`。agent-cockpit のスキルが無ければ `mismatch`、`update-tools` が無ければ `not-installed` |
| runtime-check | MCP からの書き込みと質問の回答の往復 | 常に `not-run`。導入手順の「確認」へ案内する |

Claude の `route.js` のフック(導入手順のパターン C)は、bridge が導入済み(`codexAgentScriptPaths` のどれかに `codex-agent.sh` がある)なら期待する登録に含め、無ければ `mismatch` にする。
bridge が未導入なら、登録があれば値を照合し、無くても `mismatch` にしない。どちらの場合も余分な登録として扱わない。bridge を外した後も登録を残してよい作りのためである。

matcher は、無い、空、`*` を同じものとして比べる。どれもすべてのツールに一致するためである。

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
| `json-add`、`json-replace`、`json-remove` | `file`、`path`(例 `["hooks","PreToolUse"]`)、`match`(配列の中の要素を選ぶ条件。matcher とスクリプト)、`target`、`value`。配列の添字は持たない。利用者の独自のフックが混ざり、読み直すたびに添字が変わるため |
| `toml-set` | `file`、`table`(例 `mcp_servers.agent-cockpit`)、`key`、`value`。`[hooks.state]` は対象にしない |

フックの対処の `target` は、`group`(matcher のグループを足す)か `hook`(`match` の matcher のグループの中で、`match` のスクリプトを指すフック 1 件を置き換えるか取り除く)である。
`target` が無い JSON の対処はオブジェクトのキーを対象とし、`path` の最後のキーの値だけを書き換える。
`json-add` は無い途中のオブジェクトを作るが、途中にオブジェクト以外の値があれば適用できない。
この形を使い、Claude の MCP の `command` と `args` を直しても、同じ登録の `env` とほかの MCP の登録を残す。
同じグループに利用者のフックが同居することがあるため、置き換えと取り除きはグループ全体を対象にしない。取り除いてグループが空になったときだけ、グループも取り除く。
matcher はグループの属性なので、matcher が違う登録は、フックを取り除く対処と、期待するグループを足す対処の 2 つにする。
1 つの項目の対処は、同じ観測に対してまとめて適用する。

Codex の `config.toml` のうち、agent-cockpit の登録をインラインテーブルやドット付きのキーで書いたもの(`tools = { … }` など)は読まないので、MCP の項目を `unverified` にし、書き換えの対処を出さない。
| `copy` | `from`(対象の checkout からの相対パス)、`to`(絶対パス) |
| `command` | `command`(例 `node src/client/restart-server.js --json`)と、実行する場所 |
| `manual` | 開発者の操作(セッションの開き直し、Codex の `/hooks` での信頼し直し)を `text` で |

ファイルを書き換える対処には、`observedDigest`(観測したファイル全体の sha256)を付ける。UTF-8 で読んだ文字列から計算する。
ただし、Claude の MCP の登録の対処は `digestPath: ['mcpServers', 'agent-cockpit']` を持ち、この部分木の `JSON.stringify(値 ?? null)` の sha256 を使う。
途中がオブジェクトでない場合も値を `null` として計算する。
Claude Code が登録以外を頻繁に書き換えるため、この対処では登録の変化だけを検出する。
適用する側は、適用の直前に計算し直し、違えばその対処を適用しない。
観測したときにファイルが無ければ `observedDigest` を `null` にする。適用する側は、適用の直前にもファイルが無いことを確かめ、あればその対処を適用しない。
`digestPath` がある場合は、ファイルが無くても `null` の部分木のハッシュを使う。
Codex の `hooks.json` を書き換える対処には、`/hooks` で信頼し直す `manual` を必ず対にする。信頼の記録はフックの内容のハッシュで、書き換えると外れるためである。

## 選んだ対処の適用

```sh
node src/client/doctor.js --json > diagnosis.json
node src/client/apply.js --from diagnosis.json --item claude.mcp.registration [--item <id> ...] [--json]
```

`--from` は `schemaVersion: 1` と `items` を持つ診断の JSON とし、`--item` を 1 件以上指定する。
入力に無い id、使い方の誤り、診断そのものの失敗は終了コード 2 とし、書き込みを始めない。
選んだ項目がすべて `applied` か `already-ok` なら終了コード 0、`skipped` か `failed` があれば 1 とする。

適用は次の順に進める。

1. 保存した診断の `checkout.resolvedBy` が `root` なら同じ `root` を指定し、それ以外は既定の解決で観測と評価をやり直す。正規化した checkout が違えばすべて `skipped` にする。
2. 元が `mismatch` の項目だけを候補とする。今は `ok` なら `already-ok`、項目が消えたか適用できる状態でなければ `skipped` にする。今の対処と保存した対処を `isDeepStrictEqual` で比べ、違えば診断し直すよう案内して `skipped` にする。
3. ファイルの対処をファイルごとにまとめる。1 項目が複数のファイルを対象にしていれば `failed` にする。ファイルを読み、各対処の digest を確かめ、違えばそのファイルの項目をすべて `skipped` にする。
4. 元のバイト列を退避して、メモリー上で `json-remove`、`json-replace`、`json-add` の順に適用する。同じ操作の中と TOML、copy は選んだ項目の順、項目内の順にする。どれかが適用できなければ、そのファイルを書かずに対象の項目をすべて `failed` にする。
5. 同じフォルダーの一時ファイルに書き、対象をもう一度読んで同じ digest 照合を行う。違えば一時ファイルを消して `skipped` にし、一致すれば rename で 1 回だけ書き換える。JSON は字下げ、改行コード、末尾の改行の有無を保つ。TOML は対象の表のキーだけを書き換え、ほかの表と `[hooks.state]` を残す。copy は checkout の正本のバイト列を写す。
6. ファイルへの適用が終わってから、選んだ `command` を実行する。許すのは checkout を cwd とする `node src/client/restart-server.js --json` だけで、`execFile` に実行ファイルと引数を分けて渡す。適用した項目の `manual` は重複を除いて最後に案内する。

退避先は `AGENT_COCKPIT_HOME/backups/<時刻>/` とする。
時刻は ISO 形式の `:` と `.` を `-` に置き換える。
既にあるファイルを `<連番>-<元の名前>` に写し、`manifest.json` に `[{ original, backup, sha256 }]` を書く。
退避する既存ファイルが無ければフォルダーを作らない。
退避に失敗したファイルは書き換えず `failed` にする。
退避後、時刻の形のフォルダーを名前順に並べ、新しい 10 回より古い退避だけを削除する。

既定の出力は、人が読む適用結果、見送った理由、失敗、退避先、手作業の案内である。
`--json` は次の形にし、秘密値や設定の中身を含めない。

```json
{
  "schemaVersion": 1,
  "backupDir": null,
  "results": [{ "id": "claude.mcp.registration", "status": "applied", "reason": "対処を適用しました。" }],
  "commands": [],
  "manual": ["セッションが応答を書いている最中の適用は避けてください。"]
}
```

`commands` は実行した対処の `command` と `exitCode` を持つ。
