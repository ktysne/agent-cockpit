# 常駐サーバー、フック、画面の設計(段階 1)

計画書 [docs/handover/2026-10-02.md](../handover/2026-10-02.md) の段階 1 の設計である。
段階 2 以降も、ここで決めた置き場、識別子、通信の規約に乗せる。

## 構成

- Node.js 22 以上で、外部の依存を持たない。テストは `node:test` で書く。
- `src/server/` は常駐サーバー、`src/hooks/` はフックから呼ぶスクリプト、`src/web/` は画面である。
- 画面の見た目は [mock/index.html](../../mock/index.html) を踏襲する。段階 1 で表示するのは、セッション、作業中の内容、サブエージェント、許可待ちである。

## 置き場

常駐サーバーの置き場は `~/.agent-cockpit/` で、環境変数 `AGENT_COCKPIT_HOME` で差し替えられる。
テストは必ず一時ディレクトリへ差し替え、ポートは 0 で待ち受ける。開発機で動いている本物の常駐サーバーに触れないためである。

| ファイル | 中身 | 書く段階 |
|---|---|---|
| `server.json` | `{pid, port, secret, startedAt}` | 1 |
| `away.json` | `{enabled, since}` | 1c |
| `server.log` | 起動、停止、エラー。起動ごとに切り詰める。ツールの入力の要約は書かない | 1 |
| `start.lock` | 再起動の排他。10 秒で失効する | 1 |
| `state.json` | 表示順、保留、既読の時刻 | 4 |
| `routing.json` | 経路の設定 | 7 |

## 起動と寿命

- SessionStart フックが常駐サーバーの生存を確かめ、動いていなければ起動する。生存は `GET /health` の応答が `{app: "agent-cockpit", pid, startedAt}` で、`server.json` と一致することで判定する。Windows は pid の再利用が速いので、pid だけで判定しない。
- 起動は `detached`、`windowsHide: true`、`stdio` は `server.log` の fd、`unref()` で行う。`cwd` は常駐サーバーの置き場にする。worktree を `cwd` にすると Windows がそのディレクトリをロックし、worktree を消せなくなるためである。
- 起動するときの環境から `CLAUDE_CODE_` で始まる変数をすべて除く。受付トークンを常駐サーバーのプロセスに残さないためである。
- `server.json` は待ち受けに成功した後にだけ書き、一時ファイルへ書いてから名前を変えて置く。同時に起動して `EADDRINUSE` で負けた側は、このファイルに触れずに終わる。終了時は、ファイルの pid が自分のときだけ消す。
- SessionStart 以外のフックで接続が拒否され、`server.json` の常駐サーバーが生きていないときは、`start.lock` を排他作成できた 1 本だけが起動し直す。
- 終了するのは、生きているセッションがその時点で 0 件で、かつ直近 30 分に要求(フック、画面、`/health`)が 1 つも無いときだけにする。`~/.claude/sessions` を読めないときは終了しない。画面を開いている間はポーリングが要求になるので終了しない。

## 通信と照合

- 待ち受けるのは 127.0.0.1 だけにする。案内する URL も `http://127.0.0.1:<port>/` に統一する。
- すべての要求で、`Host` が `127.0.0.1:<port>` か `localhost:<port>` であることを確かめる。DNS リバインディングで別のページから読まれないようにするためである。
- 読み取りは `GET`、書き込みは `POST` にする。書き込みはすべて `X-Cockpit-Secret` の一致を求める。
- フックからの書き込みは、`Origin` ヘッダーが無いことを求める。ブラウザは `POST` に必ず `Origin` を付けるので、別のページからの書き込みをこれで弾ける。`/api/away` を除く画面からの書き込み(段階 3 以降)は、`Origin` が自分の origin で、`Sec-Fetch-Site` が無いか `same-origin` であることを求める。
- 秘密値は起動ごとに 2 つ作り、`server.json` に書く。`secret` はフックと MCP サーバー用で、`/api/events` だけが受け付ける。`uiSecret` は画面とトレイ用で、`/api/away` などの画面からの操作だけが受け付ける。画面には `uiSecret` だけを埋めるので、画面を読めてもイベントは偽造できない。
- `POST /api/away` は `uiSecret` を先に照合し、`Origin` が無いか、待ち受けポートに対する `http://127.0.0.1:<port>` または `http://localhost:<port>` であることを確かめる。画面は同一オリジンのページだけが読めるよう、`uiSecret` を HTML の meta 属性へ埋め込み、CORS ヘッダーは返さない。DNS リバインディングは全要求の Host 照合で防ぐ。
- 全応答に `X-Frame-Options: DENY` と `Content-Security-Policy: frame-ancestors 'none'` を付け、別のページが画面を iframe に埋めて操作させる経路を塞ぐ。
- 127.0.0.1 に接続できる同じマシンの他の利用者やプロセスは、`GET /` で `uiSecret` を得て画面と同じ操作ができる。単一の利用者の開発機で使う前提とし、画面からの操作はフックのイベントより狭い範囲に留める。
- 開発用の口は `/api/dev/` の下に置き、`--dev` で起動したときだけ有効にする。
- 書き込みの本文は 64KB を上限とし、超えたら拒否する。
- 常駐サーバーへ書き込むもの(フック、段階 2 の MCP サーバー、段階 3 の待機フック)は、`401` か接続の拒否を受けたら `server.json` を読み直して 1 回だけやり直す。秘密値は常駐サーバーの起動ごとに変わるためである。
- 画面は `uiSecret` を配信時に HTML の meta 属性から受け取る。`401` を受けたら常駐サーバーが再起動して秘密値が変わったとみなし、`GET /` を取り直して新しい値で 1 回だけ送り直す。

## フック

- すべてのイベントを 1 本のスクリプトで受ける。SessionStart 以外は非同期フック(`async: true`)として登録し、セッションの処理を待たせない。
- フックは標準入力の JSON から必要な項目だけを抜き出して送る。`tool_response` の全文や、ツールの入力の全文は送らない。
- フックは、受け取った時刻(`hookAt`、ミリ秒)を付けて送る。非同期のため到着の順は入れ替わるので、常駐サーバーはこの時刻で並べる。
- 送信のタイムアウトは 1 秒で、失敗しても終了コード 0 ですぐ終わる。セッションを止めない。
- SessionStart フックは、`additionalContext` でダッシュボードの URL を 1 行返す。メインセッションが `preview_start {url}` で開く契機にする。

送る項目は次のとおりである。

| イベント | 送る項目 |
|---|---|
| 共通 | `session_id`、`hook_event_name`、`cwd`、`agent_id`、`agent_type`、`hookAt` |
| PreToolUse | `tool_name`、`tool_use_id`、入力の要約(80 文字まで) |
| PostToolUse、PostToolUseFailure | `tool_name`、`tool_use_id`。Agent ツールでは `tool_response.resolvedModel`。Bash では出力の中の `codex-agent: agent=` の行 |
| Notification | 通知の種類、メッセージ(200 文字まで) |
| SubagentStart、SubagentStop | 共通の項目だけ |
| Stop、SessionEnd、UserPromptSubmit | 共通の項目だけ。プロンプトの本文は送らない |

入力の要約は、Bash ならコマンドの先頭、Read、Edit、Write ならファイルのパス、それ以外はツール名だけにする。

## 状態

- セッション表示の状態はメモリーだけに持つ。保存は段階 4 で行う。離席中は `{enabled, since}` を `away.json` に保存し、起動時に読む。壊れているときは離席中ではない状態として扱う。
- `GET /api/state` は `{version, generatedAt, sessions, away}` を返す。`GET /api/away` は離席中だけを返す。`version` はセッション表示の状態が変わるたびに 1 増える。段階 3 で、`version` が変わったことだけを流す SSE を足す。
- 識別子は `session_id`、`agent_id`、`tool_use_id` をそのまま使う。

セッションごとに次を持つ。

- プロダクト: 鍵はリポジトリのルートの絶対パス(Windows では小文字にする)、表示名はそのフォルダー名。`cwd` が `<ルート>/.claude/worktrees/<名前>` の下なら、`<ルート>` をリポジトリのルートとする。
- 題名: `~/.claude/sessions/*.json` の `name`。
- 状態: 作業中、待機中、待機中(サブエージェント稼働中)、許可待ち。Stop を受けたときに稼働中のサブエージェントがあれば「待機中(サブエージェント稼働中)」にする。SessionEnd を受けたら一覧から外す。
- 実行中のツール: PostToolUse が来ていない `tool_use_id` ごとの、ツール名と要約と開始時刻。
- サブエージェント: `agent_id` ごとに、`agent_type`、開始時刻、最後のツール、モデル、effort、取得元。

## サブエージェントのモデルと effort

- SubagentStart では、`~/.claude/agents/<agent_type>.md` の frontmatter の `model` と `effort` を仮の値として出す。
- Agent ツールの PostToolUse の `resolvedModel` が来たら、モデルを置き換える。
- GPT 側は、Bash の PreToolUse でコマンドに `codex-agent.sh <定義名>` を見つけたら、`~/.claude/gpt-agents/<定義名>.md` の frontmatter の `codex_model` と `codex_reasoning_effort` を仮の値として出す。PostToolUse の出力に `codex-agent: agent=` の行があれば、その値で置き換える。Bash を背景で動かした場合、この行は PostToolUse に載らないので、仮の値のままになる。

## 許可待ち

- Notification のうち許可を求める種類のものを、そのセッション(サブエージェントの中なら `agent_id` ごと)の許可待ちとし、待ち始めの時刻を持つ。待ちの対象は、実行中のツールのうち最も古いものとする。
- 解消するのは、同じ対象の PostToolUse、PostToolUseFailure、UserPromptSubmit、Stop を受けたときである。
- 通知の種類の値と、`PermissionRequest` フックが使えるかは確かめていない。開発用の口 `/api/dev/fields` で、フックが受け取った項目の名前と通知の種類の値(値はこれだけ)を見られるようにし、実機で確かめてから判定を決める。

## 秘匿

- `~/.claude/sessions/` は `*.json` だけを読む。`*.key` は読まない。
- `CLAUDE_CODE_MESSAGING_TOKEN` は、フック、常駐サーバー、ログのどこにも記録しない。
- ツールの入力は要約だけを持つ。全文は常駐サーバーのメモリーにも置かない。

## 画面

- 2 秒ごとに `GET /api/state` を読む。
- 待ち時間は 1 分ごとに表示を更新し、15 分を超えたものを強調する。
- タブのタイトルは、許可待ちの件数を出して `(件数) Agent Cockpit` にする。0 件なら `Agent Cockpit` のままにする。判断事項の件数は段階 2 で加える。

## 登録

フックの登録先の `~/.claude/settings.json` はリポジトリの外にあるので、自動では書き換えない。
追記する内容は README に書き、開発者の確認を取ってから登録する。
登録は exec 形式(`command` と `args` を分ける)で書く。Windows ではフックのコマンドが PowerShell で解釈され、引用符付きの実行ファイルのパスが失敗するためである。
