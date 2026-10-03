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
| `server.json` | `{pid, port, secret, uiSecret, startedAt}` | 1 |
| `away.json` | `{enabled, since}` | 1c |
| `server.log` | 起動、停止、エラー。起動ごとに切り詰める。ツールの入力の要約は書かない | 1 |
| `start.lock` | 再起動の排他。10 秒で失効する | 1 |
| `store.json` | 画面表示設定、タスク、判断事項と回答の記録、完了タスク、外したセッション、PR の記録 | 4、5 |
| `routing.json` | 経路の設定 | 7 |
| `route-agents/*.json` | サブエージェント開始時の経路記録。24 時間使われていない記録は次の開始時に削除する | 7 |

## 起動と寿命

- SessionStart フックが常駐サーバーの生存を確かめ、動いていなければ起動する。生存は `GET /health` の応答が `{app: "agent-cockpit", pid, startedAt}` で、`server.json` と一致することで判定する。Windows は pid の再利用が速いので、pid だけで判定しない。
- 起動は `detached`、`windowsHide: true`、`stdio` は `server.log` の fd、`unref()` で行う。`cwd` は常駐サーバーの置き場にする。worktree を `cwd` にすると Windows がそのディレクトリをロックし、worktree を消せなくなるためである。
- 起動するときの環境から `CLAUDE_CODE_` で始まる変数と `GH_TOKEN`、`GITHUB_TOKEN`、`GH_ENTERPRISE_TOKEN` を除く。受付トークンと GitHub の環境変数トークンを常駐サーバーへ渡さないためである。
- `server.json` は待ち受けに成功した後にだけ書き、一時ファイルへ書いてから名前を変えて置く。同時に起動して `EADDRINUSE` で負けた側は、このファイルに触れずに終わる。終了時は、ファイルの pid が自分のときだけ消す。
- SessionStart 以外のフックで接続が拒否され、`server.json` の常駐サーバーが生きていないときは、`start.lock` を排他作成できた 1 本だけが起動し直す。
- 終了するのは、生きているセッションがその時点で 0 件で、かつ直近 30 分に要求(フック、画面、`/health`)が 1 つも無いときだけにする。`~/.claude/sessions` を読めないときは終了しない。画面を開いている間はポーリングが要求になるので終了しない。

## 通信と照合

- 待ち受けるのは 127.0.0.1 だけにする。案内する URL も `http://127.0.0.1:<port>/` に統一する。
- すべての要求で、`Host` が `127.0.0.1:<port>` か `localhost:<port>` であることを確かめる。DNS リバインディングで別のページから読まれないようにするためである。
- 読み取りは `GET`、書き込みは `POST` にする。書き込みはすべて `X-Cockpit-Secret` の一致を求める。
- 段階 2 の `POST /api/sessions/<session_id>/plan` も、`/api/events` と同じ `secret` と Origin 不在を求める。`session_id` は英数字と `-` だけを使い、128 文字までにする。
- `GET /api/sessions/<session_id>/context` は Host を照合し、離席状態、タスクの題と状態、未解決判断事項の id、題、状態を返す。秘密値は求めない。
- フックからの書き込みは、`Origin` ヘッダーが無いことを求める。ブラウザは `POST` に必ず `Origin` を付けるので、別のページからの書き込みをこれで弾ける。`/api/away` を除く画面からの書き込み(段階 3 以降)は、`Origin` が自分の origin で、`Sec-Fetch-Site` が無いか `same-origin` であることを求める。
- 秘密値は起動ごとに 2 つ作り、`server.json` に書く。`secret` はフックと MCP サーバー用で、`/api/events` だけが受け付ける。`uiSecret` は画面とトレイ用で、`/api/away` などの画面からの操作だけが受け付ける。画面には `uiSecret` だけを埋めるので、画面を読めてもイベントは偽造できない。
- `POST /api/away` は `uiSecret` を先に照合し、`Origin` が無いか、待ち受けポートに対する `http://127.0.0.1:<port>` または `http://localhost:<port>` であることを確かめる。画面は同一オリジンのページだけが読めるよう、`uiSecret` を HTML の meta 属性へ埋め込み、CORS ヘッダーは返さない。DNS リバインディングは全要求の Host 照合で防ぐ。
- 状態不明のセッションへの書き込みも `uiSecret` と `Origin` を同じ規則で照合する。画面は `401` のとき `/` を取り直し、新しい秘密値で 1 回だけ再送する。
- 全応答に `X-Frame-Options: DENY` と `Content-Security-Policy: frame-ancestors 'none'` を付け、別のページが画面を iframe に埋めて操作させる経路を塞ぐ。
- 127.0.0.1 に接続できる同じマシンの他の利用者やプロセスは、`GET /` で `uiSecret` を得て画面と同じ操作ができる。単一の利用者の開発機で使う前提とし、画面からの操作はフックのイベントより狭い範囲に留める。
- 開発用の口は `/api/dev/` の下に置き、`--dev` で起動したときだけ有効にする。
- 書き込みの本文は 64KB を上限とし、超えたら拒否する。
- 常駐サーバーへ書き込むもの(フック、段階 2 の MCP サーバー、段階 3 の待機フック)は、`401` か接続の拒否を受けたら `server.json` を読み直して 1 回だけやり直す。秘密値は常駐サーバーの起動ごとに変わるためである。
- 画面は `uiSecret` を配信時に HTML の meta 属性から受け取る。`401` を受けたら常駐サーバーが再起動して秘密値が変わったとみなし、`GET /` を取り直して新しい値で 1 回だけ送り直す。

## 状態不明のセッション

- 常駐サーバーは、定期取得したライブセッションファイルの一覧から消えたイベント由来のセッションを、最後に一覧で確認してから 60 秒経過した時点で終了扱いにする。一度も一覧に載らなかったセッションは対象にせず、一覧を読めなかった取得では判定しない。時刻には `syncSessionFiles` の `now` を使う。
- `POST /api/sessions/<session_id>/estimate` は、現在の一覧に存在する状態不明のセッションだけを推定する。存在しない ID は `404`、状態が不明でなければ `409` を返す。ID は `[A-Za-z0-9_-]` の 1〜100 文字に限る。
- 会話記録の場所は、常駐サーバーが登録済みセッションの `cwd` と ID から `~/.claude/projects/<cwd の英数字以外を '-' に置換した値>/<session_id>.jsonl` として決める。画面からパスは受け取らない。解決したパスは `projects` の直下にある 1 階層のプロジェクトディレクトリ内に限る。
- 推定ではファイルの末尾 256KB だけを位置指定で読み、途中から読んだ場合は先頭の行を捨てる。assistant と user のうちサイドチェーンでない行を使い、会話本文は返さない。記録を読めない場合や対象行の形式が合わない場合は、推定不可として保存する。user の行の `content` は文字列のこともある。知らない種類の要素は推定に使わずに飛ばす。`isMeta` の user の行(スラッシュコマンドの出力など)は対象にしない。中断の行(`[Request interrupted` で始まる user の行)で終わる場合は `input` とする。長い cwd では Claude Code が記録の置き場の名前を縮めるので、場所が合わずに推定できないことがある。
- assistant の最後の行が `end_turn` で終わる場合、または `tool_use` を含まず stop reason も `tool_use` でない場合は `input` とする。user の行が最後なら `model`、それ以外の assistant の行なら `tool` とする。最後のツール名は末尾の読取範囲内で最後に現れる `tool_use` から求める。
- 推定結果はセッションごとにメモリーへ持ち、そのセッションのイベントで消す。読み取り中にイベントが届いて状態が分かったときは保存せず `409` を返す。結果を保存した後は `version` を進め、推定結果を応答と `GET /api/state` に含める。
- `POST /api/hidden-sessions` は `{action: "hide", session_id}` または `{action: "hide", session_ids}` で、一覧にあるセッションを状態にかかわらず外す。`session_ids` は ID を 1〜50 件含み、各 ID は `[A-Za-z0-9_-]` の 1〜100 文字に限る。知らない ID は無視し、1 件も一覧に無ければ `404` を返す。本文が仕様に合わない場合は `400` を返す。状態不明カードの「一覧から外す」とプロダクト見出しの「×」は同じ操作を使う。
- `{action: "clear"}` はすべて表示する。外した ID はメモリーに持ち、セッションのイベントが届いたとき、またはセッションが終了扱いになったときに集合から削除する。`GET /api/state` では外したセッションにだけ `hidden: true` を付ける。

## フック

- すべてのイベントを 1 本のスクリプトで受ける。SessionStart 以外は非同期フック(`async: true`)として登録し、セッションの処理を待たせない。
- フックは標準入力の JSON から必要な項目だけを抜き出して送る。`tool_response` の全文や、ツールの入力の全文は送らない。
- `AskUserQuestion` では判断事項の表示と解決に要る項目だけを送る。回答の形を判別できないときは、回答を空にして解決済みにする。
- フックは、受け取った時刻(`hookAt`、ミリ秒)を付けて送る。非同期のため到着の順は入れ替わるので、常駐サーバーはこの時刻で並べる。
- 送信のタイムアウトは 1 秒で、失敗しても終了コード 0 ですぐ終わる。セッションを止めない。
- SessionStart フックは、`additionalContext` でダッシュボードの URL を 1 行返す。メインセッションが `preview_start {url}` で開く契機にする。

送る項目は次のとおりである。

| イベント | 送る項目 |
|---|---|
| 共通 | `session_id`、`hook_event_name`、`cwd`、`agent_id`、`agent_type`、`hookAt` |
| PreToolUse | `tool_name`、`tool_use_id`、入力の要約(80 文字まで。切り詰めた場合は末尾に「…」を付ける)。Agent ツールでは `tool_input.description`(200 文字まで)。メインセッションの `AskUserQuestion` では質問、見出し、選択肢の label と description、`multiSelect` も上限付きで送る |
| PostToolUse、PostToolUseFailure | `tool_name`、`tool_use_id`。Agent ツールでは `tool_response.resolvedModel`。出力(PostToolUseFailure では `error` の文字列も)に含まれる Codex の監査行と結果行だけを送る。Codex を終了と判定するのは結果行を受けたときだけで、監査行だけなら背景で動いているものとして扱う。メインセッションの `AskUserQuestion` の PostToolUse では、認識できた回答だけを送る |
| Notification | 通知の種類、メッセージ(200 文字まで) |
| SubagentStart、SubagentStop | 共通の項目だけ |
| Stop、SessionEnd、UserPromptSubmit | 共通の項目だけ。プロンプトの本文は送らない |

`answer.js` から届く `PostToolBatch` は、常駐サーバーの受信時刻を使う状態イベントとして記録する。
入力の要約は、Bash なら改行と続く空白を空白一つに置き換えたコマンド、Read、Edit、Write ならファイルのパス、それ以外はツール名だけにする。
要約が80文字を超える場合だけ先頭79文字に「…」を付ける。画面幅による省略は CSS の `text-overflow: ellipsis` で行う。

PostToolUse の出力全文は送らない。
`event.js` は `tool_response` から `codex-agent: agent=` と `codex-agent: result=` の行だけを抽出する。
常駐サーバーは監査行からモデル、effort、`codex_home` を読み、結果行から実行結果を読む。

## 状態

- タスク催促の記録はセッションごとにメモリーだけに持ち、`SessionEnd` で消す。
- イベントとイベントから組み立てるセッション状態はメモリーだけに持つ。MCP のタスクと判断事項、回答の記録、完了タスク、外したセッション、表示設定は `store.json` に保存する。表示設定は `GET /api/state` の `display` で配り、初回だけ画面が旧 `localStorage` の値をサーバーへ移す。テーマはブラウザーごとの `localStorage` に残す。離席中は `{enabled, since}` を `away.json` に保存し、起動時に読む。壊れているときは離席中ではない状態として扱う。
- `GET /api/state` は `{version, generatedAt, display, sessions, pullRequests, away, routing}` を返す。状態不明のセッションには、推定済みなら `estimate`、一覧から外したなら `hidden: true` を含める。`GET /api/away` は離席中だけを返す。`version` はセッション表示の状態が変わるたびに 1 増える。段階 3 で、`version` が変わったことだけを流す SSE を足す。
- 識別子は `session_id`、`agent_id`、`tool_use_id` をそのまま使う。

## 保存

保存対象、書き込みの直列化と再試行、起動時の復元と期限切れの扱いは、計画書の「段階 4 の設計(保存と閉じる操作)」を正本とする。

セッションごとに次を持つ。

- プロダクト: 鍵はリポジトリのルートの絶対パス(Windows では小文字にする)、表示名はそのフォルダー名。`cwd` が `<ルート>/.claude/worktrees/<名前>` の下なら、`<ルート>` をリポジトリのルートとする。ブランチ名は `cwd` から上へ探した `.git/HEAD` から読む。`.git` が worktree のポインター ファイルなら `gitdir:` の場所にある `HEAD` を読む。`ref: refs/heads/<名前>` はブランチ名、detached HEAD は短い SHA とし、読めなければ `null` にする。子プロセスは起動せず、同じ `cwd` の結果を 10 秒間キャッシュする。読み取るファイルは `.git` のポインターと `HEAD` に限り、どちらも 4 KB を上限とする。
- 最終イベント時刻: `lastActivityAt` にセッションの最新フック時刻を ISO 形式で持ち、メイン行の経過表示に使う。
- 題名: `~/.claude/sessions/*.json` の `name`。
- 状態: 作業中、待機中、待機中(サブエージェント稼働中)、許可待ち。Stop を受けたときに稼働中のサブエージェントがあれば「待機中(サブエージェント稼働中)」にする。SessionStart の source が startup、resume、clear のときは、入力を待つ状態で始まるので待機中にし、メインの実行中のツールと許可待ちを外す。compact は自動の圧縮でターンの途中にも起きるので、直前の状態を保つ。SessionEnd を受けたら一覧から外す。一度生きている一覧に載ったセッションファイルが 60 秒以上一覧から消えた場合も、不在による終了として一覧から外す。不在による終了は、セッションファイルが再び一覧に載ったときに解除する。SessionStart と、それ以外のイベントは、hookAt が終了判定時刻より後なら終了扱いを解除して受け付ける。SessionEnd による終了は解除しない。
- 実行中のツール: PostToolUse が来ていない `tool_use_id` ごとの、ツール名と要約と開始時刻。メインの Stop と UserPromptSubmit ではメインのツールを消し、PostToolBatch ではその時刻より前に始まったメインのツールを消す。いずれもサブエージェントのツールは残す。
- サブエージェント: `agent_id` ごとに、`agent_type`、作業の説明、開始時刻、最後のツール、モデル、effort。
- `SubagentStart` が記録されていなくても、`SubagentStop` 以外のイベントで初めて届いた `agent_id` から行を作る。
  開始時刻はそのイベントの時刻とし、稼働中として扱う。
  `SubagentStop` 後のイベントでは行を作らず、稼働中にも戻さない。
  `codex:<tool_use_id>` の Codex 行はこの復元の対象外とする。
- タスク: `tasks` の全項目と、最後に書いた時刻 `tasksUpdatedAt`。
- 判断事項: AskUserQuestion の記録と MCP から登録した項目を `decisions` に持つ。

## PR の表示

PR は Bash の `gh pr create`、GitHub MCP の作成応答、または MCP ツール `cockpit_add_pr` から登録し、`store.json` に保存する。
常駐サーバーは `gh` の保存済み認証を使い、60 秒ごとと `git push` または `gh pr` の後にリポジトリの状態を取得する。
base と head の対応から関連するオープン PR を積み上げ、クロスレビューの往復数と非対応の指摘数も表示する。
積み直し待ちは、GitHub のマージ済み PR の head SHA が各オープン PR の既定ブランチとの compare に残っているかで判定し、compare の失敗や 250 件超で全件を確認できない場合はマージ不可とする。
判定の詳細は[計画書の「積み直し待ちの判定」](../handover/2026-10-02.md#積み直し待ちの判定)を正本とする。
取得と判定の詳細は [計画書](../handover/2026-10-02.md) の「段階 5、6 の設計(PR の表示とマージ)」を正本とする。

## 前回見てから

プロダクトごとの既読時刻と CI 失敗への遷移時刻を `store.json` に保存し、既読後のタスク完了、PR 作成、仮適用した判断、CI 失敗、PR マージを新しい順に表示する。
既読の口は `POST /api/seen` とし、`uiSecret` と `validRequiredUiOrigin` を照合する。
初回表示時はその時点を既読時刻にする。
詳細は[計画書の「許可待ち、待ち時間、前回見てからの変化」](../handover/2026-10-02.md#許可待ち待ち時間前回見てからの変化)を正本とする。

## ダッシュボードからの PR マージ

書き込み口は `POST /api/pull-requests/merge`、`/reserve`、`/cancel-reservation` とする。
いずれも `uiSecret` と `validRequiredUiOrigin` を照合し、PR の記録キーから owner/repo を解決する。
画面の SHA、許可方式、スタック最下段、現在のマージ理由を gh で取り直して確かめ、同じ PR への操作は同時に 1 件だけ実行する。
予約中は 15 秒ごとに head SHA を取り直し、変化があれば自動マージを取り消す。
マージ履歴、予約、リポジトリごとの前回方式は `store.json` に保存し、マージ履歴は 24 時間で消す。
結果は PR を登録したセッションへ PostToolBatch、UserPromptSubmit、Stop の回答配信経路で知らせる。
gh の順序、失敗時の扱い、積み直し通知は[計画書のマージの手順](../handover/2026-10-02.md#マージの手順常駐サーバー)を正本とする。

## サブエージェントのモデルと effort

- Agent ツールの PreToolUse で受けた説明は、`tool_use_id` と `agent_id` の結び付けから対象のサブエージェントへ持たせる。
- `SubagentStart`、または `SubagentStop` 以外で `agent_id` と `agent_type` を含むイベントでは、`~/.claude/agents/<agent_type>.md` の frontmatter の `model` と `effort` を仮の値として出す。
- Agent ツールの PostToolUse の `resolvedModel` が来たら、モデルを置き換える。
- Claude のモデル名は、画面では `claude-sonnet-5-5` を `Sonnet 5.5` のように読みやすく表示する。
- Bash の PreToolUse で `codex-agent.sh <定義名>` を見つけたら、`~/.claude/gpt-agents/<定義名>.md` の frontmatter の `codex_model` と `codex_reasoning_effort` を仮の値として持つ。
- Codex 呼び出しを開始したイベントに親の `agent_id` がある場合は、GPT のモデル、effort、`codex_home` を親の行へまとめる。
- 親が特定できないメインセッションからの呼び出しは、独立した行にする。
- 監査行が届いたらモデル、effort、`codex_home` を実際の値に置き換える。
- 結果行が `rate-limited` なら「GPT 不使用(利用上限)」、`unavailable` なら「GPT 不使用(使用不能)」を表示する。
- GPT 側の情報を取得できない場合は、モデルの札を表示しない。
- 背景で起動した Codex は、同じ親の後続ツールの PostToolUse 出力に結果行が現れたとき、最も古い稼働中の呼び出しを終了にする。
- 結果行が現れないまま親が終わったときは、終了未確認にする。

## 許可待ち

- Notification のうち許可を求める種類のものを、そのセッション(サブエージェントの中なら `agent_id` ごと)の許可待ちとし、待ち始めの時刻を持つ。待ちの対象は、実行中のツールのうち最も古いものとする。
- 解消するのは、同じ対象の PostToolUse、PostToolUseFailure、UserPromptSubmit、Stop を受けたときである。
- 通知の種類の値と、`PermissionRequest` フックが使えるかは確かめていない。開発用の口 `/api/dev/fields` で、フックが受け取った項目の名前と通知の種類の値(値はこれだけ)を見られるようにし、実機で確かめてから判定を決める。

## タスクと判断事項

判断事項は次の形で保持する。

```json
{
  "id": "tool_use_id または MCP が作る ID",
  "session_id": "session ID",
  "source": "ask または mcp",
  "state": "waiting、provisional、resolved、withdrawn のいずれか",
  "title": "題",
  "context": "背景",
  "questions": [{
    "question": "質問",
    "header": "見出し",
    "multiSelect": false,
    "options": [{ "label": "選択肢", "description": "説明", "recommended": false }]
  }],
  "createdAt": "作成時刻",
  "updatedAt": "更新時刻",
  "resolvedAt": null,
  "awaitingAnswerUntil": null,
  "answer": {
    "choice": "ok",
    "note": "指示",
    "sentAt": "送信時刻",
    "deliveredAt": null,
    "reflectedAt": null,
    "promptDeliveries": 0
  },
  "resolution": null
}
```

回答を送る前の `answer` は `null` にする。
回答の `choice` は `ok`、`hold`、`null` のいずれかにし、`note` に指示を持つ。
`deliveredAt` と `reflectedAt` は常駐サーバーが記録する。
AskUserQuestion は `tool_use_id` を id にし、1 回の呼び出しを質問配列付きの 1 件として記録する。
推奨は、単一選択の質問で label に「(推奨)」または「(Recommended)」(括弧は全角・半角を許容し、英語の大文字小文字は区別しない)を含む選択肢、または MCP の `cockpit_add_decision` で `recommended: true` を明示した選択肢がちょうど 1 つのときに付け、description は判定に使わない。
同じセッションに未解決の同じ質問がある場合は、その id に後続の tool_use_id を結び付ける。
PostToolUse は `resolved`、PostToolUseFailure は `withdrawn` にし、どちらも `resolvedAt` を記録する。
サブエージェントの `agent_id` があるイベントは判断事項にしない。

タスクは `[{title, state, criteria: [{text, met}]}]` の配列で持つ。
`state` は `todo`、`doing`、`done` のいずれかにする。
MCP の `cockpit_set_tasks` は配列全体を置き換え、成功時に `tasksUpdatedAt` を更新する。
題は 200 文字、本文は 2,000 文字、タスクは 50 件、完了条件は 20 件、選択肢は 6 件までに制限する。

段階 2 の MCP サーバーは `src/mcp/server.js` で、JSON-RPC を stdio の行単位で扱う。
ツールは `cockpit_set_tasks`、`cockpit_add_decision`、`cockpit_update_decision` の 3 つにする。
各ツール呼び出しは `ensureServerRunning` で常駐サーバーを確かめ、`secret` 付きで `/plan` に送る。
送信する環境由来の値は `CLAUDE_CODE_SESSION_ID` だけとし、MCP の `ppid` から `~/.claude/sessions/*.json` の `pid` が一致する session ID を引けたときは、その ID を優先する。
PID から引けない場合は `CLAUDE_CODE_SESSION_ID` を使い、どちらも無ければ書き込みを拒否する。
他の環境変数値や `CLAUDE_CODE_MESSAGING_TOKEN` は MCP の結果、ログ、常駐サーバーへの要求に含めない。
`cockpit_add_decision` は質問を 1 つ持つ判断事項を作り、`cockpit_update_decision` は `provisional` または `resolved` と `resolution` を記録する。
成功時の MCP 応答は、保存した後の一覧を短く示す。

`SessionStart` の source が `compact` または `resume` のとき、`away.js` は `/context` からタスクと未解決判断事項の要約を読む。
離席中の文脈も必要な場合は、同じ `additionalContext` にまとめる。
メインの `SessionStart` と `UserPromptSubmit` では、常駐サーバーに届かない場合もタスク登録の決まりを `additionalContext` に足す。

## 経路の設定

`routing.json` に `{agents, review}` を保存し、値は `default`、`codex`、`claude` のいずれかとする。欠落、破損、無効な値の場合は両方を `default` として読む。
書き込みは `POST /api/routing` だけで受け付け、画面用秘密値と `validRequiredUiOrigin` を照合する。
ファイルは `AtomicJsonWriter` が一時ファイルから rename して保存する。

`GET /api/state` は現在の経路を返す。`event.js` は `SubagentStart` の送信時に `agents` の値を `route` として記録し、画面は起動時の値と現在値が異なる稼働中の行に「変更前」を表示する。
同期フック `route.js` は `SubagentStart` 時点の `agents` を `route-agents/` に記録し、指定がある場合は `additionalContext` へ差し込む。記録名は session ID と agent ID を小文字の 16 進数文字列にして作り、一時ファイルから rename して保存する。`PreToolUse` はこの記録を参照するため、起動後に設定を変えても稼働中の経路は変わらない。Claude 経路では `codex-agent.sh` 呼び出しを拒否し、Codex と既定の経路は拒否しない。同じサブエージェントの `SubagentStart` が再び届いても記録は上書きせず、終了時にも消さない。再開したサブエージェントの経路を初回のまま保つためである。記録は読むたびに更新時刻を進め、開始時に 24 時間使われていない記録を削除する。記録の読み書きに失敗したフックは応答を返さない。
クロスレビューの画面操作は ai-cross-review 側の経路切替に対応するまで無効にし、「未対応」と表示する。`POST /api/routing` は `review` の値も引き続き受け付ける。

## 秘匿

- `~/.claude/sessions/` は `*.json` だけを読む。`*.key` は読まない。
- `CLAUDE_CODE_MESSAGING_TOKEN` は、フック、常駐サーバー、ログのどこにも記録しない。
- 通常のツール入力は要約だけを持つ。`AskUserQuestion` は判断事項の表示に必要な質問項目だけを持ち、ツール入力の全文は常駐サーバーのメモリーにも置かない。

## 画面

- 2 秒ごとに `GET /api/state` を読む。
- プロダクト別では `product.key` ごとにまとめ、プロダクト名、取得できたブランチ名、0 件を除く許可待ちと判断待ちの件数を見出しに出す。1 プロダクトに複数セッションがあるときだけ、各まとまりにセッション名と状態を出す。
- セッション内は許可待ちと判断事項、タスクと完了条件、メインの作業行、サブエージェントの順に表示する。メイン行は状態、doing タスク、実行中ツール、最終イベントからの経過を示し、作業中の点は `prefers-reduced-motion` のとき点滅を止める。
- ツール名は札にし、コマンドやファイルのパスは別に表示する。
- サブエージェントの行には Agent ツールの説明を表示し、Claude と GPT のモデルを暖色と緑の札で矢印につなぐ。
- GPT の札にマウスを重ねると `codex_home` を表示する。
- 許可待ちのカードには待ち時間と「許可はデスクトップアプリの <プロダクト名> のセッションで出す。ダッシュボードからは出せない。」を表示する。
- 種類別では、許可待ちと判断事項を待ち時間の長い順に並べ、その後にタスクと完了条件、今やっていることを表示する。各項目にプロダクト名を付け、同じプロダクトに複数セッションがあるときはセッション名も付ける。
- 上部の件数タグは許可待ち、止めて待っている判断事項、推奨案を仮適用した判断事項、保留中の判断事項、稼働中のサブエージェントとする。タグで該当種類を隠せ、非表示の種類と件数を確認してすべて再表示できる。PR のタグは各データが加わる段階まで出さない。
- プロダクト別では上下移動、最上部への固定、畳む・開くを使える。固定と通常の境界を越える移動はできない。表示操作の設定はブラウザーの `localStorage` に保存し、利用できない場合も画面操作は使える。
- 待ち時間は 1 分ごとに表示を更新し、15 分を超えたものを強調する。解決済みと取り下げの判断事項、終了済みサブエージェント、完了タスクは折りたためる。
- 上部の件数とタブのタイトルには、許可待ちと回答送信前の `waiting` の判断事項を含める。
- 判断事項の回答欄と配信経路は、次節の仕様に従う。

## 判断事項への回答

回答欄と配信経路は次のとおり。

| 状態 | 意味 | 画面 |
|---|---|---|
| `waiting` で `awaitingAnswerUntil` が無い | デスクトップアプリに質問のダイアログが出ている | 回答欄の代わりに、該当プロダクトのセッションで答える案内 |
| `waiting` で `awaitingAnswerUntil` がある | 離席中に出た質問をフックが待っている | 回答欄と推奨へ進むまでの残り時間 |
| `provisional` | 推奨で仮に進めたか、保留した回答を適用した | 回答欄 |
| `resolved` または `withdrawn` | 解決したか、取り下げた | 送信した回答の記録 |

15 分を超えた待ち時間の強調は `waiting` の判断事項だけに使う。

回答欄には「推奨案で OK」と「判断を保留する」の選択、指示の入力欄、「回答を送る」を置く。

回答欄を出している判断事項では、選択肢そのものを押して答えに選べる。
単一選択の質問では 1 つ、複数選択の質問では複数を選べる。
選択肢を選ぶと「推奨案で OK」と「判断を保留する」は外れ、どちらかを選ぶと選んだ選択肢は外れる。
選んだ選択肢があるときは、回答欄に「送る答え: <label>」を出す。
複数の質問を持つ判断事項では、選ばなかった質問に推奨の label を使い、推奨が無ければ指示の文を使う。
推奨も指示も無い質問が残る間は「回答を送る」を押せない。

推奨は、単一選択の質問で label に「(推奨)」または「(Recommended)」(括弧は全角・半角を許容し、英語の大文字小文字は区別しない)を含む選択肢、または MCP の `cockpit_add_decision` で `recommended: true` を明示した選択肢がちょうど 1 つのときに付け、description は判定に使わない。

複数選択の質問では推奨を決めない。

推奨が無い質問を含む判断事項では「推奨案で OK」を無効にし、選択肢を押して選ぶか指示欄に答える案内を出す。
推奨がすべてある場合は、回答欄に OK で送る label を先に表示する。

質問文が重複する判断事項は `answers` のキーが重なるため、回答欄を出さずダイアログと同じ案内にする。
重複する質問文を含む呼び出しは、フックが待たずにデスクトップアプリのダイアログへ通す。

`POST /api/decisions/<id>/answer` は `{session_id, choice: "ok" | "hold" | "pick" | null, note, picks}` を受ける。
`picks` は `choice` が `"pick"` のときだけ必須で、質問の順に並べた label の配列の配列にする。
label はその質問の選択肢にあるものだけを受け、単一選択の質問では 1 つまで、全体で 1 つ以上とする。
選ばなかった質問に推奨も指示も無い回答は 400 で拒む。

この口は `uiSecret` と待ち受け先の Origin を照合し、Origin が無い要求を拒む。

同一オリジンの `Sec-Fetch-Site` が付く場合は `same-origin` だけを受ける。

回答を再送した場合は最新の回答を有効にする。

送信時刻、フックへ渡した時刻、セッションに反映された時刻を回答欄に表示する。

離席中に出たメインセッションの `AskUserQuestion` では、フックが `{tool_use_id, questions}` を常駐サーバーへ送り、同じ質問文の未解決判断事項に束ねる。

同じ `tool_use_id` による再登録は冪等にし、判断事項を再利用したときは前の回答を破棄する。

締切は登録時刻から 5 分後とし、常駐サーバーが持つ。

long-poll は 1 回につき最大 25 秒とし、30 秒間 poll が届かない場合は回答待ちを解除する。
解除時は、その判断事項に届いていた回答も破棄し、後続の `PostToolBatch` などから配信しない。
`away.js` は `PreToolUse` の `timeout` を 330 秒にする。

回答があれば常駐サーバーが回答内容を返し、フックが元の `tool_input` に `answers` を加えて `PreToolUse` の出力を組み立てる。

「推奨案で OK」は推奨の label を `updatedInput.answers` に入れ、「指示のみ」は指示文を入れる。

「推奨案で OK」と指示を送った場合は推奨の label を入れ、指示文を `additionalContext` で添える。

選択肢を選んだ回答は、選んだ label を `updatedInput.answers` に入れる。
複数選択の質問で複数を選んだときは、label を「, 」でつないだ 1 つの文字列にする。
選ばなかった質問には推奨の label を入れ、推奨が無ければ指示文を入れる。
指示があれば `additionalContext` で添える。

保留では推奨の label を入れ、推奨で進めて最後の報告に記載するよう `additionalContext` で伝える。

推奨のない質問への保留は、離席中なら締切と同じく質問を拒否して `provisional` にする。離席中が解除されていれば保留回答を破棄し、質問をデスクトップアプリのダイアログへ戻す。
finish が常駐サーバーに届いた場合、回答済みまたは保留の結末を優先する。それ以外は離席状態を確認し、離席中なら質問を拒否して `provisional` にし、解除済みなら `released` としてダイアログへ戻す。
finish も常駐サーバーに届かなかった場合、フックは離席状態を確認できないため、常に質問を拒否して推奨で進める。
推奨のない質問への保留は配信済みや反映済みとして数えない。

離席中が解除されたときは待機期限を消し、質問のダイアログを出す。
回答が締切までに届いていれば、離席中の解除より回答を優先する。

回答待ちの判断事項は `awaitingAnswerUntil` がある間、`PostToolBatch`、`UserPromptSubmit`、`Stop` の配信対象から外す。
`PostToolUseFailure` では待機期限を消し、該当する回答待ちを `released` にしてタイマーを解除する。lifecycle の上書き状態を消すが、保留や締切で `provisional` にした状態は保つ。

回答で質問に答えた判断事項は `PostToolUse` で `resolved` にする。

保留の回答では `PostToolUse` が届いても `provisional` を維持する。

作業中は `PostToolBatch` が 1 秒以内に常駐サーバーへ尋ね、未配信の回答を `additionalContext` に入れて配信済みにする。タスク催促の条件に当たる場合は、催促の文も同じ `additionalContext` に続けて入れる(条件は [docs/handover/2026-10-02.md「段階 3a の設計」](../handover/2026-10-02.md)を参照)。

停止中は `Stop` の `asyncRewake` フックが 1 回最大 25 秒の long-poll を繰り返す。
回答が届いたら標準エラーへ書いて終了コード 2 でセッションを起こす。

メインの `PreToolUse`、`PostToolUse`、`PostToolUseFailure` が最後の lifecycle 時刻より新しければ、停止フックの待機を終える。

最後の lifecycle 時刻より古い `Stop` は世代を更新せず、待機せずに終わる。

停止フックは後続の `Stop`、`UserPromptSubmit`、`SessionEnd`、親プロセスの終了でも何もせず終わる。

`SessionStart` は `startup`、`resume`、`clear` のときだけ最後の lifecycle 時刻を消す。

`PostToolBatch` と `Stop` は `agent_id` のあるサブエージェント内では何もしない。

README のフック登録例では `PostToolBatch` の timeout を 2 秒、`Stop` を 3600 秒、AskUserQuestion の `PreToolUse` を 330 秒にする。

配信済みで未反映の回答は、`UserPromptSubmit` の `additionalContext` で最大 3 回差し込み直す。

待機質問への回答は `PostToolUse`、仮適用した判断事項への回答は `cockpit_update_decision` を受けた時点で反映済みにする。

フックが使う `POST /api/hooks/answers` は `secret` と Origin 不在を照合し、要求中の `session_id` と判断事項の所有セッションを一致させる。

回答本文は常駐サーバーのメモリーとフックの出力にだけ置き、ファイルとログには書かない。

フック設定の例は README に記載し、`~/.claude/settings.json` は自動で変更しない。

## 登録

フックの登録先の `~/.claude/settings.json` はリポジトリの外にあるので、自動では書き換えない。
追記する内容は README に書き、開発者の確認を取ってから登録する。
登録は exec 形式(`command` と `args` を分ける)で書く。Windows ではフックのコマンドが PowerShell で解釈され、引用符付きの実行ファイルのパスが失敗するためである。
MCP サーバーは `claude mcp add --scope user` で登録し、スキルは `~/.claude/skills/agent-cockpit/` にコピーする。手順は README に記載し、自動登録やコピーはしない。
