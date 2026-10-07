# 常駐サーバー、フック、画面の設計

この資料は常駐サーバー、フック、画面の現在の構成と通信の仕様を定める。
正規登録済みのClaude/Codexイベントを共通状態へ変換する契約は[イベント投影の設計](codex-event-projection.md)に定める。
共通質問の登録、回答poll、離席時の仮選択と復旧の契約は[共通質問の設計](common-questions.md)に定める。
回答のjournalと配信台帳を分け、画面には選択の保存と配送状態を別に表示する。
managed runtimeの読取専用collectorは、trusted compositionが`startServer({ managedCollectors })`へ明示して渡した場合だけ動く。詳細と採用境界は[managed collectorの設計](managed-collector.md)に定める。

## 構成

- Node.js 22 以上で、外部の依存を持たない。テストは `node:test` で書く。
- `src/server/` は常駐サーバー、`src/hooks/` はフックから呼ぶスクリプト、`src/web/` は画面である。
- 画面の見た目は [mock/index.html](../../mock/index.html) とそろえる。画面にはセッション、判断事項、タスク、サブエージェント、許可待ち、プルリクエストなどの状態を表示する。

## 置き場

常駐サーバーの置き場は `~/.agent-cockpit/` で、環境変数 `AGENT_COCKPIT_HOME` で差し替えられる。
テストは必ず一時ディレクトリへ差し替え、ポートは 0 で待ち受ける。開発機で動いている本物の常駐サーバーに触れないためである。

| ファイル | 中身 |
|---|---|
| `server.json` | `{pid, port, secret, uiSecret, startedAt}` |
| `away.json` | `{enabled, since, periods}` |
| `server.log` | 起動、停止、エラー。起動ごとに切り詰める。ツールの入力の要約は書かない |
| `start.lock` | 再起動の排他。10 秒で失効する |
| `store.json` | 画面表示設定、タスク、判断事項と回答の記録、完了タスク、外したセッション、削除済みセッションの時刻、PR の記録 |
| `routing.json` | 経路の設定 |
| `route-agents/*.json` | サブエージェント開始時の経路記録。24 時間使われていない記録は次の開始時に削除する |

## 起動と寿命

managed collectorはserverの通常起動では作成・接続しない。注入されたcollectorのallowlist済みsnapshotだけを`GET /api/state`の`managedCollectors`として返し、HTTP経路から接続、resume、登録、proof照会は行わない。

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
- `POST /api/sessions/<session_id>/plan` は、`/api/events` と同じ `secret` と Origin 不在を求める。`session_id` は英数字と `-` だけを使い、128 文字までにする。
- `GET /api/sessions/<session_id>/context` は Host を照合し、離席状態、タスクの題と状態、未解決判断事項の id、題、状態を返す。秘密値は求めない。
- フックからの書き込みは、`Origin` ヘッダーが無く、`Sec-Fetch-Site` が `cross-site` でないことを求める。ブラウザは `POST` に必ず `Origin` を付けるので、別のページからの書き込みをこれで弾ける。`/api/away` は画面用秘密値を照合し、Origin が無いか待ち受け先の Origin と一致すること、および `Sec-Fetch-Site` が `cross-site` でないことを求める。ほかの画面からの書き込みは、`Origin` が自分の origin で、`Sec-Fetch-Site` が無いか `same-origin` であることを求める。
- 秘密値は起動ごとに 2 つ作り、`server.json` に書く。`secret` はフックと MCP サーバー用で、`/api/events` とMCP書込みの入口が受け付ける。`uiSecret` は画面とトレイ用で、`/api/away` などの画面からの操作だけが受け付ける。画面には `uiSecret` だけを埋めるので、画面を読めてもイベントは偽造できない。正規登録された宛先への書込みには、共通secretとは別にwriterの照合も求める。
- `POST /api/claude/writer` は MCP サーバーが自分の親プロセスの pid(`ppid`)と自分の pid(`contextPid`)を送り、Claude の writer を受け取る口である。`/api/events` と同じ `secret` と Origin 不在を求め、本文はこの 2 つの正の整数だけに限る。親が Claude 本体と確認できなければ、`403` と `reason`(`claude_parent_unverified`、`claude_sessions_unreadable`、`claude_registration_failed`)を返す。応答に token を含むので、本文をログに書かない。照合の規則は[Claude の writer の発行](claude-local-issuer.md)にある。
- フックの `/api/events` と `/api/hooks/answers` は、本文の `claudeLineage: { ppid }` を同じ規則で照合する。通ればフック用の writer を付けて、writer を持つ要求と同じ経路で処理する。通らなければ `claudeLineage` を捨てて、未登録の Claude 向けの観測の経路で扱い(登録済みの `session_id` は従来どおり `403`)、理由をログに出す。`writer` と同時に送られた要求だけは `403` と `reason` で拒否する。registry を注入した構成には issuer が無く、`claudeLineage` を使わずに従来の経路で扱う。
- `POST /api/away` は `uiSecret` を先に照合し、`Origin` が無いか、待ち受けポートに対する `http://127.0.0.1:<port>` または `http://localhost:<port>` であることを確かめる。画面は同一オリジンのページだけが読めるよう、`uiSecret` を HTML の meta 属性へ埋め込み、CORS ヘッダーは返さない。DNS リバインディングは全要求の Host 照合で防ぐ。
- 状態不明のセッションへの書き込み(`/api/sessions/<session_id>/estimate` と `/api/hidden-sessions`)も、ほかの画面からの書き込みと同じく `uiSecret` を照合し、`Origin` が自分の origin であることを求める。`Origin` が無い要求を通すのは、トレイが呼ぶ `/api/away` だけにする。画面は `401` のとき `/` を取り直し、新しい秘密値で 1 回だけ再送する。
- 全応答に `X-Frame-Options: DENY` と `Content-Security-Policy: frame-ancestors 'none'` を付け、別のページが画面を iframe に埋めて操作させる経路を塞ぐ。
- 127.0.0.1 に接続できる同じマシンの他の利用者やプロセスは、`GET /` で `uiSecret` を得て画面と同じ操作ができる。単一の利用者の開発機で使う前提とし、画面からの操作はフックのイベントより狭い範囲に留める。
- 開発用の口は `/api/dev/` の下に置き、`--dev` で起動したときだけ有効にする。
- 書き込みの本文は 64KB を上限とし、超えたら拒否する。
- フックと MCP サーバーからの書き込みは、`401` か接続の拒否を受けたら `server.json` を読み直して 1 回だけやり直す。秘密値は常駐サーバーの起動ごとに変わるためである。
- MCP の全書き込み（共通質問を含む）は、送信開始後の応答待ちがタイムアウトした場合に再送せず、処理結果不明として返す。`cockpit_skip_review` の全体期限は 60 秒で、送信開始前に期限を使い切った場合は未到達として返す。
- 画面は `uiSecret` を配信時に HTML の meta 属性から受け取る。`401` を受けたら常駐サーバーが再起動して秘密値が変わったとみなし、`GET /` を取り直して新しい値で 1 回だけ送り直す。

## 状態不明のセッション

- 常駐サーバーは、正規登録されていないClaude互換セッションについて、定期取得したライブセッションファイルの一覧から消えたイベント由来のセッションを、最後に一覧で確認してから 60 秒経過した時点で終了扱いにする。一度も一覧に載らなかったセッションは対象にせず、一覧を読めなかった取得では判定しない。時刻には `syncSessionFiles` の `now` を使う。正規登録された期間はこの判定から除外し、session fileの消失を期間終了の証拠にしない。
- `POST /api/sessions/<session_id>/estimate` は、現在の一覧に存在する状態不明のセッションだけを推定する。存在しない ID は `404`、状態が不明でなければ `409` を返す。ID は `[A-Za-z0-9_-]` の 1〜100 文字に限る。
- 会話記録の場所は、常駐サーバーが登録済みセッションの `cwd` と ID から `~/.claude/projects/<cwd の英数字以外を '-' に置換した値>/<session_id>.jsonl` として決める。画面からパスは受け取らない。解決したパスは `projects` の直下にある 1 階層のプロジェクトディレクトリ内に限る。
- 推定ではファイルの末尾 256KB だけを位置指定で読み、途中から読んだ場合は先頭の行を捨てる。assistant と user のうちサイドチェーンでない行を使い、会話本文は返さない。記録を読めない場合や対象行の形式が合わない場合は、推定不可として保存する。user の行の `content` は文字列のこともある。知らない種類の要素は推定に使わずに飛ばす。`isMeta` の user の行(スラッシュコマンドの出力など)は対象にしない。中断の行(`[Request interrupted` で始まる user の行)で終わる場合は `input` とする。長い cwd では Claude Code が記録の置き場の名前を縮めるので、場所が合わずに推定できないことがある。
- assistant の最後の行が `end_turn` で終わる場合、または `tool_use` を含まず stop reason も `tool_use` でない場合は `input` とする。user の行が最後なら `model`、それ以外の assistant の行なら `tool` とする。最後のツール名は末尾の読取範囲内で最後に現れる `tool_use` から求める。
- 推定結果はセッションごとにメモリーへ持ち、そのセッションのイベントで消す。読み取り中にイベントが届いて状態が分かったときは保存せず `409` を返す。結果を保存した後は `version` を進め、推定結果を応答と `GET /api/state` に含める。
- `POST /api/hidden-sessions` は `{action: "hide", session_id}` または `{action: "hide", session_ids}` で、一覧にあるセッションを状態にかかわらず外す。`session_ids` は ID を 1〜50 件含み、各 ID は `[A-Za-z0-9_-]` の 1〜100 文字に限る。知らない ID は無視し、1 件も一覧に無ければ `404` を返す。本文が仕様に合わない場合は `400` を返す。状態不明カードの「一覧から外す」とプロダクト見出しの「×」は同じ操作を使う。
- `{action: "clear"}` はすべて表示する。外した ID と時刻は `store.json` に保存し、セッションのイベントが届いたとき、またはセッションが終了扱いになったときに集合から削除する。`GET /api/state` では外したセッションに `hidden: true` と `hiddenAt` を付ける。
  `hiddenAt` は保存済みの `hiddenSessionUpdatedAt` である。
  時間経過による移動は画面の分類だけで行い、サーバーは外した集合から戻さない。

## サブエージェントの終了通知

- `TaskStop` などで止まったサブエージェントには `SubagentStop` が届かないことがあるので、常駐サーバーはメインの会話記録から終了の通知を読む。
- 読むのは、状態が「待機中(サブエージェント稼働中)」で、稼働中の Claude のサブエージェントがあるセッションだけとする。メインのイベント(`agent_id` を持たないもの)を受けて約 500ms 後に 1 回読み、その状態が続く間は 60 秒ごとに読み直す。サブエージェントのイベントでは読まない。
- 記録の場所と末尾 256KB の読み方は、状態不明の推定と同じとする。
- 対象の行は、`type` が `queue-operation`、`operation` が `enqueue` で、`content` が `<task-notification>` で始まるものだけとする。ツールの入出力や会話の本文に写った通知の文字列を、終了と取り違えないためである。
  enqueue の行を書かない古い版の Claude Code では、通知を読み取れないので、手で「終了にする」を使う。
- 通知から `<task-id>`(`[A-Za-z0-9_-]` の 1〜64 文字)と `<status>`(`completed`、`killed`、`failed`、`stopped`)を読む。`stopped` は前のプロセスで終わらなかった背景のエージェントの通知で、1 通に複数の `<task-id>` が並ぶので、すべてを読む。稼働中の Claude のサブエージェントに一致し、通知の時刻がそのサブエージェントの開始時刻より前でなければ、`SubagentStop` を合成して通常のイベントと同じ経路で処理する。

## 記録の削除

`POST /api/record-deletions` は画面が帯に数えた ID を受け取り、分類を再計算せずに削除する。
`x-cockpit-secret` が `uiSecret` と異なれば `401`、Origin が無いか自分の origin と異なれば `403` を返す。
本文は次の 3 キーだけを許し、各キーは省略できる。

```json
{
  "session_ids": ["session-id"],
  "merge_history": [{"owner": "example", "repo": "project", "number": 1}],
  "closed_pull_requests": [{"owner": "example", "repo": "project", "number": 2}]
}
```

各配列は 0〜50 件で、合計 1 件以上を必要とする。
セッション ID は `[A-Za-z0-9_-]` の 1〜100 文字、PR は有効な owner、repo と正の整数の number を持つ。
PR のオブジェクトも上記の 3 キーだけを許す。
形が違う本文は `400`、正常時は `{deleted: {sessions, pullRequests}}` を返す。
未知の ID と重複は件数に含めない。
帯に 50 件を超える対象がある場合、画面は分割して送る。

セッションの削除では、イベント、状態、終了時刻、不在終了、判断の上書き、推定、非表示、閉じたサブエージェント、ファイル最終確認時刻を消す。
保存済みの計画、質問との結び付き、イベント外で終えた質問の印、回答ライフサイクル、閉じたタスクも消す。
セッション別の PR 登録、マージ予約、マージ意図は残す。
PR 登録はグループの起点と、マージ後の base 付け替えと restack の追跡に使うためである。
削除でも不在終了と同じ通知を送り、離席中の質問を待つフックを解放する。

`deletedSessions` はセッション ID から削除時刻の ISO 文字列への対応として `store.json` に保存する。
項目の無い旧形式は空として読む。
ファイルの更新時刻が削除時刻以前、または更新時刻が無い場合、ファイルだけからセッションを再表示しない。
削除時刻以前の `hookAt` を持つイベントは捨てる。
新しいイベント、新しいファイル更新、MCP の書き込みでは削除印を解除して復活させる。
削除印は保存期限の 14 日を超えたときに掃除する。
同期時の一覧に ID が無い状態は、ファイルの読み取り失敗でも起きるため掃除に使わない。

共通質問・指示から合成する検証済み行の表示設定は、`projectionDisplaySettings` として `store.json` に保存する。各要素は `{provider, session_id, hiddenAt}` または `{provider, session_id, deletedAt}` のどちらかで、provider と session ID の組を識別に使う。項目の無い旧形式は空として読む。画面は provider を指定せず、サーバーが有効なsnapshotと登録情報から対象を照合する。

合成行の非表示と削除は表示overlayだけを変更し、projection削除から実セッションの終了処理や `answerDelivery` の終了通知を呼ばない。実rowの起源が同providerだけのときは、削除印がある間だけそのrowを `GET /api/state` から隠す。混在・不明の実rowは隠さない。session file と実状態は保持して不在終了の判定を続ける。複数providerのprojection、実rowの複数・不明・異providerの起源が重なる操作は `409`、構成済みのprojection snapshotまたは登録情報を取得できない操作は状態を変更せず `503` を返す。snapshot取得に失敗したときも `GET /api/state` は応答し、取得できた表示を返す。

projectionの `deletedAt` は一覧の再合成、session fileの再走査、古いイベントでは解除しない。イベントは表示印だけを理由に通常の状態更新や後続処理を止めず、検証済み登録から受理した `SessionEnd` 以外のstate writeで、`hookAt` が削除時刻より新しい場合だけ同providerの印を解除する。`{action: "clear"}` は非表示印を消すが、削除印を残す。この表示overlayの時刻判定は、実セッション削除を扱う `deletedSessions` の互換動作とは独立している。

マージ履歴の削除はレコードを残し、`historyDismissedAt` を付けて通常の履歴から除く。
保存と復元でもこの時刻を保ち、merged 登録からの履歴再生成で戻らないようにする。
同じ `mergedAt` の再記録では非表示時刻を引き継ぎ、新しい `mergedAt` では引き継がない。
`headMismatch === true` の警告履歴は対象にしない。
クローズ済み PR は、セッション別と関連 PR のうち state が `closed` の登録だけを削除してグループを再計算する。
state が `merged` の登録は残す。

3 つの帯の右端にゴミ箱を置く。
押すと同じ帯に件数、元に戻せない旨、「削除する」「やめる」を出す。
確認対象と確認状態は定期描画をまたいで保ち、フォーカスも同じ操作へ戻す。
「やめる」は要求を送らず、削除後は対象 ID を「元に戻す」の記録から除く。

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
| PostToolUse、PostToolUseFailure | `tool_name`、`tool_use_id`。Agent ツールでは `tool_response.resolvedModel`。出力(PostToolUseFailure では `error` の文字列も)に含まれる Codex の監査行と結果行だけを送る。背景へ移った Bash の `tool_response.backgroundTaskId` と、背景タスクの出力ファイル(`<ID>.output`)を読んだ Read、`cat` などの Bash、`TaskOutput` の背景タスク ID も、決まった形(英数字、`_`、`-` の 64 文字まで)のときだけ送る。Codex を終了と判定するのは結果行を受けたときだけで、監査行だけなら背景で動いているものとして扱う。メインセッションの `AskUserQuestion` の PostToolUse では、認識できた回答だけを送る |
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
- イベントとイベントから組み立てるセッション状態はメモリーだけに持つ。MCP のタスクと判断事項、離席中の `AskUserQuestion` から作る判断事項、それらへの回答記録、完了タスク、外したセッション、削除時刻の `deletedSessions`、表示設定、クロスレビュー不要記録は `store.json` に保存する。判断事項の質問、状態、作成・更新・解決時刻、解決内容は `plans.decisions` に、回答と配信時刻は `decisionLifecycles` に置く。離席中の質問の `tool_use_id` と判断事項 ID の対応は `askDecisionBindings` に置く。この項目が無い旧形式の `store.json` は、結び付きが無いものとして読み込む。`crossReviewSkips` が無い旧形式は空として読み込む。表示設定は `GET /api/state` の `display` で配り、初回だけ画面が旧 `localStorage` の値をサーバーへ移す。`display.sectionOrder` は 5 種類のセクションを表示する順で、未知の値や重複を除いて既定の種類順で補う。`display.hideFinished` は完了済みの情報を隠す設定で、既定は `true` で、古い保存ファイルでも `true` として補う。`display.mergeResultHideMinutes` は警告のないマージ結果の行を隠すまでの時間で、既定は 5 分、範囲は 1〜60 分の整数とする。旧形式または範囲外の保存値は 5 分として補う。`display.mergeableCondition` は `operation`、`ci`、`cross-review` のいずれかで、旧形式では既定の `cross-review` として補う。テーマはブラウザーごとの `localStorage` に残す。離席状態と期間は `{enabled, since, periods}` として `away.json` に保存し、起動時に読む。期間は `{start, end}` の数値ミリ秒で、離席中の期間の `end` は `null` にする。旧形式の `{enabled, since}` は、離席中なら `since` から現在まで、離席中でなければ期間なしとして読む。既読済みの期間、14 日の保持期限を過ぎた期間、50 件を超える古い期間を整理する。期間の記録だけが壊れているか食い違うときは、旧形式と同じく `enabled` と `since` から期間を作り直す。`enabled` と `since` が壊れているときは離席中ではない状態として扱う。
- 旧 `store.json` に残る `display.mergeAfterReviewDefault` は読み込み時に無視する。`mergeReservations` は登録セッション、リポジトリ、PR、方式、ブランチ削除の有無、予約時刻を `store.json` に保存する。旧 GitHub 自動マージ形式は予約として復元せず、そのまま捨てる。
- 表示設定 `display.idleHideMinutes` は更新の無いセッションを隠すまでの時間で、既定は 30 分、範囲は 5〜1440 分の整数とする。保存値が範囲外または整数でなければ読み込み時に 30 分へ戻し、書き込み時は拒む。
- `GET /api/state` は `{version, generatedAt, display, sessions, pullRequests, sinceSeen, away, routing, integrations, uiVersion}` を返す。`uiVersion` は `src/web/index.html` の内容の SHA-256 先頭 16 桁で、ファイルの更新時刻か大きさが変わったときに再計算する。`GET /` の HTML にも同じ版を埋め込み、画面は版の違いを検出して読み込み直す。状態不明のセッションには、推定済みなら `estimate`、一覧から外したなら `hidden: true` と `hiddenAt` を含める。`GET /api/away` は離席中だけを返す。`version` は画面に出す状態が変わるたびに 1 増える。画面は 2 秒ごとに状態を取得する。
- 識別子は `session_id`、`agent_id`、`tool_use_id` をそのまま使う。

## 保存

保存対象、書き込みの直列化と再試行、起動時の復元と期限切れの扱いは、この節と「表示設定」「マージ」の各節に記す。

セッションごとに次を持つ。

- プロダクト: 鍵はリポジトリのルートの絶対パス(Windows では小文字にする)、表示名はそのフォルダー名。`cwd` が `<ルート>/.claude/worktrees/<名前>` の下なら、`<ルート>` をリポジトリのルートとする。ブランチ名は `cwd` から上へ探した `.git/HEAD` から読む。`.git` が worktree のポインター ファイルなら `gitdir:` の場所にある `HEAD` を読む。`ref: refs/heads/<名前>` はブランチ名、detached HEAD は短い SHA とし、読めなければ `null` にする。子プロセスは起動せず、同じ `cwd` の結果を 10 秒間キャッシュする。読み取るファイルは `.git` のポインターと `HEAD` に限り、どちらも 4 KB を上限とする。
- 最終イベント時刻: `lastActivityAt` にセッションの最新フック時刻を ISO 形式で持ち、メイン行の経過表示に使う。
- セッションファイル: `~/.claude/sessions/*.json` の `procStart` は Claude の writer の発行で期間の鍵に使い、文字列か有限の数値以外は `null` にする。`name` を題名に使い、有限の数値 `updatedAt` は ISO 形式にして `sessionFileUpdatedAt` に載せる。状態不明のセッションを隠す判定に使う。
- 状態: 作業中、待機中、待機中(サブエージェント稼働中)、許可待ち。Stop を受けたときに稼働中のサブエージェントがあれば「待機中(サブエージェント稼働中)」にする。SessionStart の source が startup、resume、clear のときは、入力を待つ状態で始まるので待機中にし、メインの実行中のツールと許可待ちを外す。compact は自動の圧縮でターンの途中にも起きるので、直前の状態を保つ。SessionEnd を受けたら一覧から外す。一度生きている一覧に載ったセッションファイルが 60 秒以上一覧から消えた場合も、不在による終了として一覧から外す。不在による終了は、セッションファイルが再び一覧に載ったときに解除する。Claude の writer の発行で期間が active のセッションは、この終了の対象にしない。期間は、親のプロセスが一覧から消えるか、同じ親のセッション ID が変わったときに終える。SessionStart と、それ以外のイベントは、hookAt が終了判定時刻より後なら終了扱いを解除して受け付ける。SessionEnd による終了は解除しない。
- 実行中のツール: PostToolUse が来ていない `tool_use_id` ごとの、ツール名と要約と開始時刻。メインの Stop と UserPromptSubmit ではメインのツールを消し、PostToolBatch ではその時刻より前に始まったメインのツールを消す。いずれもサブエージェントのツールは残す。
- サブエージェント: `agent_id` ごとに、`agent_type`、作業の説明、開始時刻、最後のツール、モデル、effort。
- `SubagentStart` が記録されていなくても、`SubagentStop` 以外のイベントで初めて届いた `agent_id` から行を作る。
  開始時刻はそのイベントの時刻とし、稼働中として扱う。
  `SubagentStop` 後のイベントでは行を作らず、稼働中にも戻さない。
  `codex:<tool_use_id>` の Codex 行はこの復元の対象外とする。
- サブエージェントを終了にするのは、`SubagentStop` を受けたとき、メインの `TaskStop` の `PostToolUse` の `tool_input.task_id`(無ければ非推奨の `shell_id`)が Claude のサブエージェントに一致したとき、終了通知から `SubagentStop` を合成したときである。
  どの場合も、そのサブエージェントの未完了のツールと許可待ちを消す。
  `SubagentStart` を受けたら稼働中に戻し、開始時刻をその時刻にする。
- タスク: `tasks` の全項目と、最後に書いた時刻 `tasksUpdatedAt`。
- 判断事項: AskUserQuestion の記録と MCP から登録した項目を `decisions` に持つ。計画に記録した判断事項の仮適用時刻は `plans.decisions.provisionalAt` に、回答記録で仮適用になった時刻は `decisionLifecycles.provisionalAt` に保存する。

## PR の表示

PR は Bash の `gh pr create`、GitHub MCP の作成応答、または MCP ツール `cockpit_add_pr` から登録し、`store.json` に保存する。
常駐サーバーは `gh` の保存済み認証を使い、60 秒ごとと `git push` または `gh pr` の後にリポジトリの状態を取得する。
base と head の対応から関連するオープン PR を積み上げる。クロスレビュー状態は各オープン PR のスタック木の `crossReview` に `round`、`max`、`dismissed`、`reviewedSha`、`triage` を設定する。`triage` は状態ファイルの `lastTriage` を `{round, sha, outcome}` に検証したもので、`sha` は 40 桁か 64 桁の小文字、`outcome` は `fixing`、`converged`、`halted` のいずれか。無いか形が合わなければ `null` とする。表示の規則は計画書の決定「クロスレビューの結論の表示」を正本とする。セッションが登録したオープン PR で、worktree に `tools/cross-review.js` はあるがそのブランチの記録が無いもの(状態ファイルがまだ無いものを含む)は「レビュー未実施」とする。`tools/cross-review.js` が無い worktree の PR は「レビュー不要」とする。登録の無い関連 PR とマージ済み PR にはレビュー行を出さない。状態ファイルの有無ではなく、追跡される `tools/cross-review.js` の有無で連携を判定する。
表示設定 `display.mergeableCondition` は「マージ操作が可能」「CI が成功」「現在の head のクロスレビューが収束または不要」の各条件を選ぶ。既定は最後の条件まで求める。収束は `lastTriage.round` と現在の round が一致し、`lastTriage.sha` と現在の head が一致する場合だけ有効とする。操作可否は CI とクロスレビューを含めずに判定し、選択条件を満たすかどうかでカードの緑表示、待ち条件と件数を決める。操作可だが条件が残る場合も、確認欄に警告を出して開発者が実行できる。
クロスレビュー不要記録は PR の owner/repo/番号、head SHA、理由を `store.json` の `crossReviewSkips` に保存する。MCP の `cockpit_skip_review` は登録元セッションからのみ記録でき、ダッシュボードの操作は起動時の秘密値と必須 Origin を照合して記録または取り消す。どちらもサーバーが最新の PR head を取り直して照合し、別の head には適用しない。head が変われば記録を無効にし、PR 登録の保持期限に合わせて削除する。
MCP ツールは `POST /api/sessions/:session/prs`、カードの設定と取り消しは `POST /api/pull-requests/review-skip` を使う。画面からの要求は `uiSecret` と `validRequiredUiOrigin` を通し、登録キーと表示中の head SHA が最新状態と一致することを確かめる。
各プロダクトの PR 群には、リポジトリ全体の失敗をまとめた `error` とは別に、そのプロダクトのオープンの PR を数えきれていないことを示す `openStateUnknown` を付ける。PR の一覧を取得できなかったときと、そのプロダクトが登録した PR の状態を確かめられなかったときに真にする。
登録が保持期限などで消えたプロダクトの PR 群は、次の取り直しで配らなくなる。登録と関連 PR が 1 件も無くなったリポジトリは、取得した状態ごと捨てる。
積み直し待ちは、各オープン PR の base から同じブランチ名を head に持つオープン PR、次にマージ済み PR をたどって compare の base を決め、マージ済み PR の head SHA がその差分に残っているかで判定する。
マージ済み PR と同じ名前のブランチが残り、現在の head がマージ時の head SHA と異なる場合、または `mergedHead.branchKept: true` で残す選択が記録されている場合は、その生きているブランチを compare の base にして追跡を止める。
既定ブランチに行き着かない場合は、行き着いたブランチとの差分を使う。
compare の失敗や 250 件超で全件を確認できない場合はマージ不可とする。
判定の詳細は[計画書の「積み直し待ちの判定」](../handover/2026-10-02.md#積み直し待ちの判定)を正本とする。
ダッシュボードから即時マージする口は、秘密値と必須 Origin を照合し、登録済みスタックの一番下と現在の head をサーバーで確かめる。`gh pr merge` には画面で確認した `--match-head-commit` を渡す。PR 行の予約チェックからは画面で見た head、方式、ブランチ削除の有無を予約口に送り、条件がそろっていればクロスレビューの最後の `converged` 記録の SHA を `--match-head-commit` に渡してその場でマージする。確認欄は予約状態にかかわらず即時マージ専用とする。
子 PR の base は head ブランチを削除する場合(自動削除を含む)だけ付け替え、残す場合と fork では付け替えない。
`mergedHead` のない旧マージ済み記録は refresh ごとに最大 5 件を `gh pr view` で補完し、通知を再発火させず、失敗を画面へ出さずに同じプロセス内で 1 回まで再試行する。
取得と判定の詳細は [計画書のマージ手順](../handover/2026-10-02.md#マージの手順常駐サーバー)に記す。

## 前回見てから

プロダクトごとの既読時刻と CI 失敗への遷移時刻を `store.json` に保存し、既読後で、離席中の期間に起きたタスク完了、PR 作成、仮適用した判断、CI 失敗、PR マージを新しい順に表示する。
離席中の期間は開始時刻と終了時刻の両方を含む。
離席中なら終了時刻を現在時刻とし、離席解除後も既読にするまで期間と変化を残す。
既読の口は `POST /api/seen` とし、`uiSecret` と `validRequiredUiOrigin` を照合する。
初回表示時はその時点を既読時刻にする。
マージの項目は PR の登録に記録されたマージ時刻からも作る。
既読の時刻は、そのプロダクトを参照する記録が無くなったときに消す。
「前回見てから」を「常に」「離席中のみ」「出さない」のどれにするかは画面だけで持ち(`localStorage`)、この設定は表示だけを切り替える。常駐サーバーは設定にかかわらず、離席中の期間に起きた変化の `sinceSeen` を返す。既読時刻がないプロダクトの起点は従来どおり初回表示時刻とする。規則は計画書の決定「「前回見てから」の表示の設定」を正本とする。
詳細は[計画書の「許可待ち、待ち時間、前回見てからの変化」](../handover/2026-10-02.md#許可待ち待ち時間前回見てからの変化)を正本とする。

## ダッシュボードからの PR マージ

書き込み口は `POST /api/pull-requests/merge`、`/reserve`、`/cancel-reservation` とする。
いずれも `uiSecret` と `validRequiredUiOrigin` を照合し、PR の記録キーから owner/repo を解決する。
即時マージは画面の SHA、許可方式、スタック最下段、現在のマージ操作条件を gh で取り直して確かめる。予約は方式とブランチ削除の有無を保存し、GitHub の自動マージ予約 API は呼ばない。同じ PR への操作は同時に 1 件だけ実行する。予約中でも即時マージを拒まない。成功後はマージ検出処理が予約を消し、失敗した場合は予約を残す。
`/reserve` は保存直後にも同じ PR の予約条件を確認する。条件がそろっていれば、クロスレビュー収束記録の SHA を `--match-head-commit` に指定してその場でマージし、即時マージと同じ結果(`merged`、`branchDeleted`、`queued`、`warning`)を応答する。条件がそろっていなければ `reserved: true` と予約を応答する。
リポジトリの状態を取り直すたびに予約を確認する。最後のクロスレビュー記録が現在の round の `converged` で SHA が現在の head と一致し、スタック最下段、ドラフトでない、コンフリクトなし、CI 成功を満たし、レビュー承認が必須のリポジトリでは GitHub レビューが承認済みの場合、通常のマージ手順でその収束 SHA を `--match-head-commit` に指定する。`review.notRequired` だけでは予約によるマージを実行しない。head が収束 SHA と違う場合は予約を維持し、新しい head の収束を待つ。サーバー停止中に条件がそろった場合は起動後最初の PR 状態取得で処理する。
画面からの予約取消、PR のクローズ、最後のクロスレビュー記録の `halted` ではローカル予約を消し、画面と作成元セッションへ知らせる。
予約取消の知らせは記録時刻から 1 分で画面から隠し、常駐サーバーは期限を過ぎた知らせを配らない。
旧形式の GitHub 自動マージ予約は読み込み時に捨て、GitHub 側の取消 API は呼ばない。
マージ履歴、予約、リポジトリごとの前回方式は `store.json` に保存し、マージ履歴は 24 時間で消す。予約取消の通知はメモリーに持ち、該当 PR グループの `reservationNotices` で画面へ配る。
`delete_branch_on_merge` が有効なリポジトリではスナップショットに `autoDeleteBranch` を含め、確認欄に GitHub がブランチを削除することを示す。常駐サーバーはブランチを削除しない。削除 API の 422 応答に `Reference does not exist` が含まれる場合と、ref 取得 API が 404 を返す場合は、削除済みとして扱う。
結果は PR を登録したセッションへ PostToolBatch、UserPromptSubmit、Stop の回答配信経路で知らせる。レビュー収束後マージの結果には、ブランチ削除、base の付け替え、警告を保存し、既存のマージ結果 1 行と同じ形式で画面へ配る。警告のない結果行は `display.mergeResultHideMinutes` の経過後に隠し、即時マージは応答を受けた時刻、予約マージは `mergedAt` から時間を数える。`warning` が空でない文字列か `headMismatch` が真なら、時間で隠さない。予約マージ結果の `mergeResultClosedAt` は `POST /api/pull-requests/merge-result/close` で記録し、旧形式で項目が無い結果は未閉鎖として扱う。閉鎖時刻はマージ履歴と同じ 24 時間の保持期限で整理する。
gh の順序、失敗時の扱い、積み直し通知は[計画書のマージの手順](../handover/2026-10-02.md#マージの手順常駐サーバー)を正本とする。

## 衝突の解消の依頼

衝突のある PR(`conflict` が真)は、ダッシュボードから PR を登録したセッションへ衝突の解消を依頼できる。
常駐サーバー自身は PR のブランチを変えない。
マージまたは衝突解消の依頼に失敗したときの画面メッセージは、表示してから 1 分で隠す。
書き込み口は `POST /api/pull-requests/conflict-request` で、本文は `{key, headRefOid}`(`key` はマージの口と同じ PR の記録キー)とする。`uiSecret` と `validRequiredUiOrigin` を照合する。
受け付けるのは、追跡中のオープン PR で `conflict` が真、画面の `headRefOid` が今の head と一致し、PR を登録したセッションのうち終了扱いでないものが 1 つ以上あるときだけである。PR が無ければ `404`、衝突が無いか head が違えば `409`、依頼先が無ければ `409` を返す。
依頼は、終了扱いでない登録セッションへ、マージの結果と同じ回答配信経路(`notifySessions`)で届ける。文面は PR の番号と URL、base のブランチ名を含め、base を取り込んで衝突を解消し、検証してから push すること、マージはしないこと、解消できなければ理由を報告することを伝える。
依頼の記録 `{owner, repo, number, headRefOid, requestedAt, sessionIds}` はメモリーに持ち、PR ごとに最後の 1 件だけを残す。スナップショットの PR には、記録の `headRefOid` が今の head と一致するときだけ `conflictRequest: {requestedAt, sessionIds}` を付ける。画面は依頼済みの表示の依頼先を、この `sessionIds`(実際に送ったセッション)から求める。head が変われば表示を消す。
スナップショットの PR には、登録したセッションを `conflictRequestTargets: [{sessionId, alive}]` として付ける。`alive` は終了扱いでないこと。画面はセッションの表示名をこの `sessionId` から既存の表示と同じ方法で求め、`alive` が 1 つも無ければボタンを押せなくして理由を出す。

## サブエージェントのモデルと effort

- Agent ツールの PreToolUse で受けた説明は、`tool_use_id` と `agent_id` の結び付けから対象のサブエージェントへ持たせる。
- `SubagentStart`、または `SubagentStop` 以外で `agent_id` と `agent_type` を含むイベントでは、`~/.claude/agents/<agent_type>.md` の frontmatter の `model` と `effort` を仮の値として出す。
- Agent ツールの PostToolUse の `resolvedModel` が来たら、モデルを置き換える。
- Claude のモデル名は、画面では `claude-sonnet-5-5` を `Sonnet 5.5` のように読みやすく表示する。
- Bash の PreToolUse で `codex-agent.sh <定義名>` を見つけたら、`~/.claude/gpt-agents/<定義名>.md` の frontmatter の `codex_model` と `codex_reasoning_effort` を仮の値として持つ。
- Bash の PreToolUse では、要約の切り詰め前にコマンド位置にあるクロスレビュー起動も Codex 呼び出しとして扱う。
- `npm run review:codex` と `node tools/cross-review.js codex` は `codex-review`、`--fix` 付きと `npm run review:codex:fix` は `codex-subagent` の定義を使い、`--no-codex-agent` 付きは対象にしない。
- Codex 呼び出しを開始したイベントに親の `agent_id` がある場合は、GPT のモデル、effort、`codex_home` を親の行へまとめる。
- 親が特定できないメインセッションからの呼び出しは、独立した行にする。
- 監査行が届いたらモデル、effort、`codex_home` を実際の値に置き換える。
- 結果行が `rate-limited` なら「GPT 不使用(利用上限)」、`unavailable` なら「GPT 不使用(使用不能)」を表示する。
- GPT 側の情報を取得できない場合は、モデルの札を表示しない。
- 背景で起動した Codex は、同じ親の後続ツールの PostToolUse 出力に結果行が現れたとき、まず一致する実行 ID の行を終了にする。無ければ、出力を読んだ背景タスク ID が起動時に記録した背景タスク ID と一致する Codex の行(親は問わない)を終了にする。どちらも無い場合は、実行 ID を持たないか結果行の実行 ID と一致する候補が一つだけならその行を終了にする。結果行に実行 ID が無い場合は、実行 ID を持つ行を候補に含めない。候補が複数なら行を終了にせず、終了未確認のまま残す。`--wait` の状態の行(`orphaned`、`unverified`)で終了未確認にした行は、ラッパーが既に消えていて結果行が届かないので、この候補にしない。
- 結果行が現れないままサブエージェントが `SubagentStop` を迎えたときは、背景 Codex を終了未確認にする。
- メインの `Stop` では、メイン直下の背景 Codex を稼働中のまま残す。
- 「終了にする」は、終了未確認の行、メイン直下で稼働中の背景 Codex の行、背景で起動した稼働中の Claude のサブエージェントの行に表示する。
  `Agent` ツールの `PostToolUse` が届いた時点でサブエージェントが稼働中なら、背景で起動したものとみなす。
- 閉じた行はスナップショットで終了として出し、セッションの稼働中エージェント数から除く。
- 閉じた行の `agent_id` から `SubagentStop` 以外のイベントが届いたら、その行の閉じた記録を外す。
- 結果行で終了した行や、状態から消えた行の記録は破棄する。
- サブエージェントが `codex-agent.sh --wait <実行 ID>` を呼んだら、同じ Codex の実行が続いているものとして扱う。実行 ID は `<定義名>-YYYYMMDD-HHMMSS-<番号>` の形だけを受け、定義名は実行 ID の先頭から得る。同じ親の下で同じ定義の、背景へ移って(終了未確認を含む)結果行をまだ受けていない行のうち最も新しいものを稼働中に戻し、この呼び出しの結果行で終了にする。`--wait` が結果行なしで抜けたときは、最後の状態の行で扱いを分ける。`waiting`(上限までに終わらない)か状態の行が読めないときは、Codex が背景で動き続けている見込みなので稼働中に残す。`vanished` と `not-found` は終了、`orphaned` と `unverified` は終了未確認にする。結果行なしで失敗した起動は続きが無いので、候補にしない。該当する行が無ければ(常駐サーバーの再起動で起動のイベントが失われたときなど)、新しい行を作る。
- Codex の行には、分かったときに実行 ID を持たせる。起動の Bash の出力の `codex-agent: run=<実行 ID>` の行と、`--wait` の実行 ID から得る。背景へ移った起動の出力には実行 ID が出ないことがあり、その行には `--wait` の時点で付く。背景へ移った起動の Bash の背景タスク ID は行に記録し、その背景タスクの出力を後で読んだ呼び出しの背景タスク ID と照合する。実行 ID を持たない背景 Codex が同じ親の下に複数あっても、どの行の出力かを区別できるためである。コマンドの全文から出力ファイルが複数見つかる Bash は、出力が混ざって照合できないので使わない。Codex を起動した Bash も、出力はその起動のものなので、引数に出力ファイルのパスがあっても照合に使わない。途中の出力に `run=` の行があれば、結果行が無くても同じ行へ実行 ID を記録する。`--wait` の実行 ID と同じ行があれば、親を問わず、親と定義による選び方より先にその行を使い、呼び出した親の下へ付け替える。その行が既に結果行を受けていれば、行を作りも戻しもしない。終わった実行の結果を取り出し直す呼び出しで、行が増えないためである。親と定義で選ぶときは、実行 ID が分かっていて別の値の行を候補にしない。後続のツールの出力に結果行が出たときも、`run=` の行があれば同じ実行 ID の行に結び付け(既に結果を受けていれば何もしない)、照合できずに選んだ行にはその実行 ID を記録する。常駐サーバーを再起動すると行そのものが消えるので、この照合で再起動後の `--wait` を取りこぼすことはない。
- `--wait` はコマンドの全文から探す(要約は 80 字で切られるため)。ただしヒアドキュメントより前の、コマンドの位置(行頭か `;`、`&&`、`|`、`(` の後)にある呼び出しだけを見る。引用符の中の区切り文字と改行は、コマンドの位置として扱わない。同じ呼び出しで Codex を起動しているときは起動として扱い、`--wait` は見ない。依頼文や文字列に書かれた手順の `--wait` を拾わないためである。
- 親の行の GPT の札は、稼働中の Codex の行を優先し、その中で最も新しいものを出す。
- メインセッションの `--wait` は、窓口の完了報告の後に最終報告を取り出す呼び出しなので、行を作りも戻しもしない。

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
  "provisionalAt": "仮適用になった時刻",
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
回答記録の状態が仮適用へ変わった時刻は `decisionLifecycles.provisionalAt` に保存し、回答の送信や配信では更新しない。
この時刻は仮適用の間だけ持ち、仮適用を抜けると消す。計画側の `plans.decisions.provisionalAt` は解決した後も残し、「前回見てから」の項目に使う。
回答の `choice` は `ok`、`pick`、`null` のいずれかにし、`note` に指示を持つ。
`deliveredAt` と `reflectedAt` は常駐サーバーが記録する。
AskUserQuestion は `tool_use_id` を id にし、1 回の呼び出しを質問配列付きの 1 件として記録する。
推奨は、単一選択の質問で label に「(推奨)」または「(Recommended)」(括弧は全角・半角を許容し、英語の大文字小文字は区別しない)を含む選択肢、または MCP の `cockpit_add_decision` で `recommended: true` を明示した選択肢がちょうど 1 つのときに付け、description は判定に使わない。
同じセッションに未解決の同じ質問がある場合は、その id に後続の tool_use_id を結び付ける。
PostToolUse は `resolved`、PostToolUseFailure は `withdrawn` にし、どちらも `resolvedAt` を記録する。
終わった判断事項に、最初の呼び出しか判断事項を終えた呼び出し(`finishedByToolUseId` に保存し、waiting に戻っても残す)の PreToolUse か、終わった時刻より古い PreToolUse が届いても、状態と解決の内容を変えない(遅れて届いたか重複した開始の知らせのため)。
常駐サーバーの再起動の前に終わった判断事項と、イベントから作る前に MCP で終えた判断事項は、終わりのイベントがメモリーに無いので、同じ呼び出しの PreToolUse から作り直さず保存済みの状態を保つ。
ただし、開始と終わりがどちらもメモリーにある呼び出し(結び付いた出し直しの呼び出しを含む)で、終わりの時刻が保存済みの終わりの時刻以降のときは、イベントから作り直す。
MCP で終えた判断事項は `finishedByToolUseId` を書き換えないので、終えた時刻より新しい時刻で、結び付いた別の呼び出しの開始が重複して届くと、waiting に戻りうる。
サブエージェントの `agent_id` があるイベントは判断事項にしない。

タスクは `[{title, state, criteria: [{text, met}]}]` の配列で持つ。
`state` は `todo`、`doing`、`done` のいずれかにする。
MCP の `cockpit_set_tasks` は配列全体を置き換え、成功時に `tasksUpdatedAt` を更新する。
題は 200 文字、本文は 2,000 文字、タスクは 50 件、完了条件は 20 件、選択肢は 6 件までに制限する。

MCP サーバーは `src/mcp/server.js` で、JSON-RPC を stdio の行単位で扱う。
ツールは `cockpit_set_tasks`、`cockpit_add_decision`、`cockpit_update_decision`、`cockpit_add_pr`、`cockpit_skip_review` の 5 つである。
計画の変更は `ensureServerRunning` で常駐サーバーを確かめ、`secret` 付きで `/plan` に送る。PR の登録とクロスレビュー不要の記録は `/prs` に送る。
MCP書込みは登録核が発行したwriterのtoken、provider、native ID種別、host、HOME scope、native ID、contextと実行期間を照合する。
`ppid`と`CLAUDE_CODE_SESSION_ID`は書込み権限の根拠にしない。
MCPは`pending`宛てに認証済みwriterを渡し、常駐サーバーがprojection用session IDを内部で解決する。
未確認、不一致、終了済み期間を副作用なしで拒否する。
登録主体、旧Claude観測の互換境界と後続へのinterfaceは[正規会話の登録核](codex-registration-core.md)に定める。
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
`review` の値は ai-cross-review がレビューを回す直前に `node tools/cross-review.js route` で読む。agent-cockpit 側は保存するだけで、セッションへ差し込まない。

サブエージェントの経路は claude-codex-bridge の `codex-agent.sh` があるときだけ意味を持つ。`GET /api/state` は Claude のホーム(`CLAUDE_CONFIG_DIR`、無ければ `~/.claude`)か `~/.claude` のどちらかに `tools/codex-agent.sh` があるかを `integrations.codexAgent` で返し、画面は無ければサブエージェントの段と経路の札を出さない。`route.js` も同じ場所を確かめ、無ければ `SubagentStart` で何も差し込まない。`~/.claude` も見るのは、bridge が `CLAUDE_CONFIG_DIR` を見ずに `~/.claude/tools/` へ置く作りだからである。
クロスレビューの経路は ai-cross-review を使うリポジトリでだけ意味を持つ。`GET /api/state` は、稼働中のセッション(セッションファイルの `cwd`)と PR を登録したセッション(登録の記録の `cwd`)から worktree の根を探し、そのどれかに `tools/cross-review.js` があるかを `integrations.crossReview` で返す。セッションファイルが読めない環境でも、PR の登録があれば判定できる。判定は PR の `crossReview` と同じ探し方を使う。画面は偽ならクロスレビューの段を出さず、2 つの連携がどちらも無ければ経路の欄を出さない。

## 外部リンク

ダッシュボードの外部 HTTPS リンクと同じオリジンにある `/manual/` 以下のリンクは、画面が `POST /api/open-url` に `{url}` を送り、常駐サーバーが OS の既定のブラウザで開く。
トレイが開くダッシュボードは専用のプロファイルのブラウザなので、利用者がログインしているブラウザで開くためである。
書き込みの口と同じく画面用秘密値と `validRequiredUiOrigin` を照合する。URL は 2048 字以内で制御文字を含まず、空白と引用符が正規化後に残らないものだけを受ける。
`https:` は従来どおり受ける。`http:` はホストが `127.0.0.1` または `localhost` で、ポートが常駐サーバー自身と一致し、パスが `/manual/` 以下の場合だけ受ける。マニュアル URL は常駐サーバー自身の `http://127.0.0.1:<ポート>` を基準にパス、クエリ、ハッシュを組み立て直す。
開くときはシェルを通さず、Windows では `rundll32.exe url.dll,FileProtocolHandler <url>`、macOS では `open`、それ以外では `xdg-open` を引数で渡して起動する。
画面は、送れなかったときや失敗の応答のときは、今までどおりダッシュボードのウィンドウから開く。

## 秘匿

- `~/.claude/sessions/` は `*.json` だけを読む。`*.key` は読まない。
- `CLAUDE_CODE_MESSAGING_TOKEN` は、フック、常駐サーバー、ログのどこにも記録しない。
- 通常のツール入力は要約だけを持つ。`AskUserQuestion` は判断事項の表示に必要な質問項目だけを持ち、ツール入力の全文は常駐サーバーのメモリーにも置かない。

## 画面

- 設定画面の下端のボタン列には、利用者向けマニュアルへのリンクを置く。
- 2 秒ごとに `GET /api/state` を読む。
- セッションの `lastUpdatedAt` は、フックイベントの `lastActivityAt`、計画の `tasksUpdatedAt`、判断事項の `updatedAt` のうち最も新しい時刻とする。候補が無い場合は `lastActivityAt` を使う。
- 更新時刻(`lastUpdatedAt`、無ければ `sessionFileUpdatedAt`)から `display.idleHideMinutes` を過ぎたセッションは、プロダクト別と種類別の一覧から隠す。許可待ち、`waiting` または `provisional` の判断事項、稼働中のサブエージェント、状態が「作業中」のいずれかがあれば表示する。
- 更新の無いセッションを隠した件数は一覧の後に示す。「表示する」は設定や外したセッションの記録を変えず、開いているページの間だけ表示を切り替える。終わったものを隠す設定で除かれる通常のセッションは更新の無い件数に含めない。
- 外したセッションでは更新時刻と `hiddenAt` の遅い方を起点にする。
  条件を満たしたら「外したセッション」の件数と内訳から除き、「更新の無いセッション」に数える。
  「表示する」で一覧に戻せる。
- 更新の無いセッションだけが残るプロダクトは、プルリクエストか「前回見てから」の項目がある場合に表示する。
- プロダクト別では `product.key` ごとにまとめ、プロダクト名、取得できたブランチ名、0 件を除く許可待ちと判断待ちの件数を見出しに出す。1 プロダクトに複数セッションがあるときだけ、各まとまりにセッション名と状態を出す。
- セッション内は許可待ちと判断事項、タスクと完了条件、メインの作業行、サブエージェントの順に表示する。メイン行は状態、doing タスク、実行中ツール、最終イベントからの経過を示し、作業中の点は `prefers-reduced-motion` のとき点滅を止める。
- ツール名は札にし、コマンドやファイルのパスは別に表示する。
- サブエージェントの行には Agent ツールの説明を表示し、Claude と GPT のモデルを暖色と緑の札で矢印につなぐ。
- GPT の札にマウスを重ねると `codex_home` を表示する。
- 許可待ちのカードには対象のメインまたはサブエージェント、待ち時間、ツール名と入力の要約を表示する。許可操作の案内文はカードに出さない。
- 種類別では、許可待ちと判断事項を待ち時間の長い順に並べ、その後にタスクと完了条件、今やっていることを表示する。各項目にプロダクト名を付け、同じプロダクトに複数セッションがあるときはセッション名も付ける。
- 上部の件数タグは許可待ち、止めて待っている判断事項、推奨案を仮適用した判断事項、稼働中のサブエージェントを示す。マージできる PR があれば、その件数も表示する。タグで該当種類を隠せ、非表示の種類と件数を一覧の最下部で確認してすべて再表示できる。
- プロダクト別では上下移動、最上部への固定、畳む・開くを使える。固定と通常の境界を越える移動はできない。表示モード、並べ替え、固定、畳み、隠した種類、セクションの並び順などの表示設定は常駐サーバーに保存する。配色と「前回見てから」の表示モードはブラウザーの `localStorage` に保存する。利用できない場合も画面操作は使える。
- 待ち時間は 1 分ごとに表示を更新し、設定した閾値(1〜120 分、既定 15 分)を超えたものを強調する。解決済みと取り下げの判断事項、終了済みサブエージェント、完了タスクは折りたためる。
- 更新の無いセッションの判定は 1 分ごとの描き直し時点で行う。`display.idleHideMinutes` の既定値は 30 分で、5〜1440 分の整数を指定できる。
- `display.mergeResultHideMinutes` の期限判定は、画面を描き直すたびに行う。2 秒ごとの状態取得で期限を越えたことを検出し、既存の描き直し経路で結果行を隠す。警告行は閉じる操作まで残す。
- 予約取消の知らせとマージまたは衝突解消の依頼失敗メッセージは、それぞれの記録時刻から 1 分後に隠す。2 秒ごとの状態取得で期限を確認し、状態の版が変わらなくても期限切れの表示が変わったときは既存の描き直し経路を使う。
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

設定した閾値を超えた待ち時間の強調は `waiting` の判断事項だけに使う。

回答欄には「推奨案で OK」のチェック、選択肢、指示の入力欄、「回答を送る」を置く。

回答欄を出している判断事項では、選択肢そのものを押して答えに選べる。
単一選択の質問では 1 つ、複数選択の質問では複数を選べる。
選択肢を選ぶと「推奨案で OK」は外れ、「推奨案で OK」を選ぶと選んだ選択肢は外れる。
選んだ選択肢があるときは、回答欄に「送る答え: <label>」を出す。
複数の質問を持つ判断事項では、選ばなかった質問に推奨の label を使い、推奨が無ければ指示の文を使う。
推奨も指示も無い質問が残る間は「回答を送る」を押せない。

推奨は、単一選択の質問で label に「(推奨)」または「(Recommended)」(括弧は全角・半角を許容し、英語の大文字小文字は区別しない)を含む選択肢、または MCP の `cockpit_add_decision` で `recommended: true` を明示した選択肢がちょうど 1 つのときに付け、description は判定に使わない。

複数選択の質問では推奨を決めない。

推奨が無い質問を含む判断事項では「推奨案で OK」を無効にし、選択肢を押して選ぶか指示欄に答える案内を出す。
推奨がすべてある場合は、回答欄に OK で送る label を先に表示する。

質問文が重複する判断事項は `answers` のキーが重なるため、回答欄を出さずダイアログと同じ案内にする。
重複する質問文を含む呼び出しは、フックが待たずにデスクトップアプリのダイアログへ通す。

`POST /api/decisions/<id>/answer` は `{session_id, choice: "ok" | "pick" | null, note, picks}` を受ける。
`picks` は `choice` が `"pick"` のときだけ必須で、質問の順に並べた label の配列の配列にする。
label はその質問の選択肢にあるものだけを受け、単一選択の質問では 1 つまで、全体で 1 つ以上とする。
選ばなかった質問に推奨も指示も無い回答は 400 で拒む。

この口は `uiSecret` と待ち受け先の Origin を照合し、Origin が無い要求を拒む。

同一オリジンの `Sec-Fetch-Site` が付く場合は `same-origin` だけを受ける。

回答を再送した場合は最新の回答を有効にする。

送信時刻、フックへ渡した時刻、セッションに反映された時刻を回答欄に表示する。

離席中に出たメインセッションの `AskUserQuestion` では、フックが `{tool_use_id, questions}` を常駐サーバーへ送り、同じ質問文の未解決判断事項に束ねる。

同じ `tool_use_id` による再登録は冪等にし、判断事項を再利用したときは前の回答を破棄する。

締切は登録時刻から設定画面の「離席中に質問の回答を待つ時間」後(1〜30 分、既定 5 分)とし、常駐サーバーが持つ。登録後に設定を変えても、既に待っている質問の締切は変えない。

long-poll は 1 回につき最大 25 秒とし、30 秒間 poll が届かない場合は回答待ちを解除する。
解除時は、その判断事項に届いていた回答も破棄し、後続の `PostToolBatch` などから配信しない。
`away.js` は `PreToolUse` の `timeout` を 1830 秒にする。フックは常駐サーバーが返した締切に従い、30 秒の余裕を残して終了する。

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

作業中は `PostToolBatch` が 1 秒以内に常駐サーバーへ尋ね、未配信の回答を `additionalContext` に入れて配信済みにする。タスクが無いままメインツールを 5 回使ったか、タスク無しでサブエージェントを起動したときは登録を促す。タスク更新より後にサブエージェントが終了して 10 分経っても一覧が書き直されていないときも促す。同じセッションへの催促は 10 分間隔にし、催促の文は回答と同じ `additionalContext` に続けて入れる。

停止中は `Stop` の `asyncRewake` フックが 1 回最大 25 秒の long-poll を繰り返す。
回答が届いたら標準エラーへ書いて終了コード 2 でセッションを起こす。

メインの `PreToolUse`、`PostToolUse`、`PostToolUseFailure` が最後の lifecycle 時刻より新しければ、停止フックの待機を終える。

最後の lifecycle 時刻より古い `Stop` は世代を更新せず、待機せずに終わる。

停止フックは後続の `Stop`、`UserPromptSubmit`、`SessionEnd`、親プロセスの終了でも何もせず終わる。

`SessionStart` は `startup`、`resume`、`clear` のときだけ最後の lifecycle 時刻を消す。

`PostToolBatch` と `Stop` は `agent_id` のあるサブエージェント内では何もしない。

[導入手順](../setup.md) のフック登録例では `PostToolBatch` の timeout を 2 秒、`Stop` を 3600 秒、AskUserQuestion の `PreToolUse` を 1830 秒にする。

配信済みで未反映の回答は、`UserPromptSubmit` の `additionalContext` で最大 3 回差し込み直す。

待機質問への回答は `PostToolUse`、仮適用した判断事項への回答は `cockpit_update_decision` を受けた時点で反映済みにする。

フックが使う `POST /api/hooks/answers` は `secret` と Origin 不在を照合し、要求中の `session_id` と判断事項の所有セッションを一致させる。

回答本文は、常駐サーバーのメモリー、`store.json` の回答の記録(`decisionLifecycles`)、フックの出力にだけ置き、ログには書かない。
`store.json` に置くのは、配信済みの印を書く前に常駐サーバーが落ちたときに、再起動の後に同じ答えを重ねて差し込まないためと、送信済みで未配信の回答を再起動の後にも届けるためである(「保存」節)。

フック設定の例は [導入手順](../setup.md) に記載し、`~/.claude/settings.json` は自動で変更しない。

## 登録

フックの登録先の `~/.claude/settings.json` はリポジトリの外にあるので、自動では書き換えない。
追記する内容は [導入手順](../setup.md) に書き、開発者の確認を取ってから登録する。
登録は exec 形式(`command` と `args` を分ける)で書く。Windows ではフックのコマンドが PowerShell で解釈され、引用符付きの実行ファイルのパスが失敗するためである。
MCP サーバーは `claude mcp add --scope user` で登録し、スキルは `~/.claude/skills/agent-cockpit/` にコピーする。手順は [導入手順](../setup.md) に記載し、自動登録やコピーはしない。
