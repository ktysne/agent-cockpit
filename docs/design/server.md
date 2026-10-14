# 常駐サーバー、フック、画面の設計

この資料は常駐サーバー、フック、画面の現在の構成と通信の仕様を定める。

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
| `server.log` | 起動、停止、エラー。追記する。ツールの入力の要約は書かない |
| `server.log.1` | 1 つ前の `server.log`。常駐サーバーを起動するとき、`server.log` が 1 MB を超えていればこの名前に移し、前の `server.log.1` を置き換える |
| `diagnostics/<起動時刻>-<pid>.<区分番号>.jsonl` | 診断ログ。1 区分 2000 行、直近 10 起動、全体 30 区分まで |
| `diagnostics/hooks-pending.jsonl` | 常駐サーバーへ送れなかったフックの診断の記録。フックが追記し、256 KB を超える追記は捨てる。常駐サーバーがセッションの走査のたびに診断ログへ取り込む |
| `diagnostics/hooks-pending.jsonl.importing` | 取り込み中の `hooks-pending.jsonl`。この名前に移してから読み、読み終えたら消す。残っていれば次の取り込みで先に読む |
| `diagnostics/hooks-pending.lock` | `hooks-pending.jsonl` の追記と取り込みの排他。中身は持ち主の pid で、取り込む側は、持ち主が終わっているか、pid の無いまま 10 秒たったロックを消して取り直す |
| `start.lock` | 常駐サーバーの起動の排他。10 秒で失効する |
| `store.json` | 画面表示設定、タスク、判断事項と回答の記録、完了タスク、外したセッション、削除済みセッションの時刻、PR の記録、Codex のセッションの復旧の記録 |
| `store.json.broken-<時刻>` | 読み込めなかった `store.json` の退避先。時刻は ISO 形式の `:` と `.` を `-` に置き換えたもの。退避した後は保存の無い状態で動く |
| `tray.json` | タスクトレイの設定 `{notifyPendingCounts}`。許可待ちと判断待ちが増えたときに Windows の通知を出すかを持つ |
| `browser/` | タスクトレイがダッシュボードを Edge のアプリのウィンドウで開くときのプロファイル(`--user-data-dir`) |
| `agent-cockpit.ico` | ショートカットのアイコン。`src/tray/install-shortcut.ps1` がタスクトレイのスクリプトから書き出す |
| `routing.json` | 経路の設定 |
| `route-agents/*.json` | サブエージェント開始時の経路記録。24 時間使われていない記録は次の開始時に削除する |

## 起動と寿命

- フックと MCP サーバーは、`GET /health` の応答が `{app: "agent-cockpit", pid, startedAt}` で `server.json` と一致するとき、常駐サーバーが動いていると判定する。
  `/health` の試行期限は全体の期限の残りか 500ms の短いほうにする。
  `/health` の応答が何も届かないまま期限を過ぎ、`server.json` を読めた場合は、記録されたポート（無ければ既定ポート）へ `127.0.0.1` で TCP 接続する。
  `/health` が応答したのに識別が一致しない場合と、応答が届いた後に本文が期限に間に合わない場合は、別のアプリがその番号を使っているので、TCP 接続の判定をせず、読んだ情報も使わない。秘密値とイベントの本文を別のアプリへ送らないためである。
  TCP 接続の試行期限は全体の期限の残りか 200ms の短いほうにする。
  接続できた場合は起動せず、読んだ情報を使う。
  接続できない場合は `start.lock` を取って状態を再確認し、同じ TCP 接続の判定を経てから起動する。
  `server.json` が無いか読めない場合は、従来どおり起動する。
  Windows は pid の再利用が速いため、pid だけでは判定しない。
- 起動は `detached`、`windowsHide: true`、`stdio` は `server.log` の fd、`unref()` で行う。`cwd` は常駐サーバーの置き場にする。worktree を `cwd` にすると Windows がそのディレクトリをロックし、worktree を消せなくなるためである。
- 起動するときの環境から `CLAUDE_CODE_` で始まる変数と `GH_TOKEN`、`GITHUB_TOKEN`、`GH_ENTERPRISE_TOKEN` を除く。受付トークンと GitHub の環境変数トークンを常駐サーバーへ渡さないためである。
- `server.json` は待ち受けに成功した後にだけ書き、一時ファイルへ書いてから名前を変えて置く。同時に起動して `EADDRINUSE` で負けた側は、このファイルに触れずに終わる。終了時は、ファイルの pid が自分のときだけ消す。
- SessionStart 以外のフックで接続が拒否され、`server.json` の情報とポートの待ち受けが確認できないときは、`start.lock` を排他作成できた 1 本だけが起動し直す。
- 終了するのは、生きているセッションがその時点で 0 件で、かつ直近 30 分に要求(フック、画面、`/health`)が 1 つも無いときだけにする。`~/.claude/sessions` が無いときは、Claude Code を使わない環境としてセッションのファイルが無いものと扱う。それ以外の理由で読めないときは終了しない。画面を開いている間はポーリングが要求になるので終了しない。

## 更新の確認

公開する版の正本は `vX.Y.Z` 形式の Git タグとし、リリース時に `package.json` の `version` を合わせる。
手元の版は `package.json` から読む。
ブランチや worktree の HEAD に依存せず、稼働中のコードに付いた版を確認できるためである。
固定の `https://github.com/ktysne/agent-cockpit.git` へ `git ls-remote --refs --tags` で問い合わせる。
チェックアウトの remote が fork や別の URL でも、配布元の版を確認するためである。
正式な版タグだけを拾い、3 つの整数で比較し、最大の版が手元より新しければ通知する。
`0.0.0` からの変更を見るリンクは、存在しないタグとの比較を避け、新しいタグの tree を指す。

確認は起動 1 分後、その後 6 時間ごとに行う。
git は対話を無効にし、15 秒の期限と 1MB の出力上限を設ける。
タイマーは `unref()` し、終了時に解除し、確認中の処理が終わってから診断ログを閉じる。
成功は結果を info で、失敗は分類だけを warn で診断ログに残す。
失敗した回は通知を隠し、次の確認時機に試し直す。

確認結果は `DashboardState` の snapshot に入れず、`/api/state` の `update` に並べる。
セッションの状態が変わったわけではないため、状態の `version` を進めない。
画面は版番号による描き直しの判定の外で、毎回通知を更新する。
依頼文とリンクは新しい版がある場合だけサーバーが組み立て、依頼文の手順書の場所はサーバーのファイルの位置から求める。

画面の設定の「更新を確認」は `POST /api/update/check` で、定期の確認を待たずに今すぐ確かめる。
本文は JSON のオブジェクトだけを受け付け、画面用の秘密値と Origin を照合する。
応答は `/api/state` の `update` と同じ形で、確認の結果を返す。
確認の実行中に来た要求は、新しい git を起動せず同じ確認の結果を待つ。
確認を有効にしていないサーバー(`updateCheck` を渡していない場合)は `409` と `{"error":"update-check-disabled"}` を返す。
定期の確認の時機は変えない。

手元の版は `/api/state` の `appVersion` で渡し、画面はウィンドウのタイトルにだけ「Agent Cockpit v1.0.0」の形で出し、見出しは名前だけにする。
デモの常駐サーバーは `appVersion` を `null` にして版を出さない。マニュアルと紹介ページの画像が、版を上げるたびに変わらないためである。

確認を有効にするのは `startServer` に `updateCheck` を明示して渡した場合だけで、CLI の main が渡す。
テストとデモと撮影は既定で git を起動しない。
確認のテストは git の実行と時計を差し替え、ネットワークを使わずに時機と結果を確かめる。

再起動は外のプロセスで `src/client/restart-server.js` を実行する。
既存の接続処理で `server.json` と `/health` の pid と startedAt とアプリ名を照合し、一致するプロセスだけを止め、終了を待ってから既存の起動処理を使う。
Windows では `process.kill(pid)` は対象を終了させるため、停止のシグナル処理による保存には頼らない。
照合の前に 1 秒待つ。更新を進める AI がその直前に MCP でタスクを書くことが多く、500ms のまとめ書きが済む前に止めるとその変更を失うためである。
照合の後に待つと、その間に pid が別のプロセスに使われたときに、照合していないプロセスを止めてしまう。
待った後の書き込みが失われ得るのは、トレイの再起動と同じ扱いにする(「保存」の書き方の項)。
最初の照合に失敗して止めずに起動処理へ進み、起動処理が元と同じ pid と startedAt のサーバーを返したときは、再起動していないので失敗を返す。
生存確認にはシグナル 0 を使い、終了を確認できなければ起動せずに失敗を返す。
これは [常駐サーバーの再起動の判断](../handover/2026-10-02.md#決定済みの判断)と同じく、常駐サーバー自身から代わりを起動せず、画面に再起動の口を増やさない構成である。
トレイの既存のコマンドライン照合はそのままにし、このスクリプトでは起動時刻を含む既存の health 照合を使う。

## 通信と照合

- 待ち受けるのは 127.0.0.1 だけにする。案内する URL も `http://127.0.0.1:<port>/` に統一する。
- すべての要求で、`Host` が `127.0.0.1:<port>` か `localhost:<port>` であることを確かめる。DNS リバインディングで別のページから読まれないようにするためである。
- 読み取りは `GET`、書き込みは `POST` にする。書き込みはすべて `X-Cockpit-Secret` の一致を求める。
- `POST /api/sessions/<session_id>/plan` は、`/api/events` と同じ `secret` と Origin 不在を求める。`session_id` は英数字と `-` だけを使い、128 文字までにする。
- `GET /api/sessions/<session_id>/context` は Host を照合し、離席状態、タスクの題と状態、未解決判断事項の id、題、状態を返す。秘密値は求めない。
- フックからの書き込みは、`Origin` ヘッダーが無く、`Sec-Fetch-Site` が `cross-site` でないことを求める。ブラウザは `POST` に必ず `Origin` を付けるので、別のページからの書き込みをこれで弾ける。`/api/away` は画面用秘密値を照合し、Origin が無いか待ち受け先の Origin と一致すること、および `Sec-Fetch-Site` が `cross-site` でないことを求める。ほかの画面からの書き込みは、`Origin` が自分の origin で、`Sec-Fetch-Site` が無いか `same-origin` であることを求める。
- 秘密値は起動ごとに 2 つ作り、`server.json` に書く。`secret` はフックと MCP サーバー用で、`/api/events` だけが受け付ける。`uiSecret` は画面とトレイ用で、`/api/away` などの画面からの操作だけが受け付ける。画面には `uiSecret` だけを埋めるので、画面を読めてもイベントは偽造できない。
- `POST /api/away` は `uiSecret` を先に照合し、`Origin` が無いか、待ち受けポートに対する `http://127.0.0.1:<port>` または `http://localhost:<port>` であることを確かめる。画面は同一オリジンのページだけが読めるよう、`uiSecret` を HTML の meta 属性へ埋め込み、CORS ヘッダーは返さない。DNS リバインディングは全要求の Host 照合で防ぐ。
- 状態不明のセッションへの書き込み(`/api/sessions/<session_id>/estimate` と `/api/hidden-sessions`)も、ほかの画面からの書き込みと同じく `uiSecret` を照合し、`Origin` が自分の origin であることを求める。`Origin` が無い要求を通すのは、トレイが呼ぶ `/api/away` だけにする。画面は `401` のとき `/` を取り直し、新しい秘密値で 1 回だけ再送する。
- 全応答に `X-Frame-Options: DENY` と `Content-Security-Policy: frame-ancestors 'none'` を付け、別のページが画面を iframe に埋めて操作させる経路を塞ぐ。
- 127.0.0.1 に接続できる同じマシンの他の利用者やプロセスは、`GET /` で `uiSecret` を得て画面と同じ操作ができる。単一の利用者の開発機で使う前提とし、画面からの操作はフックのイベントより狭い範囲に留める。
- 開発用の口は `/api/dev/` の下に置き、`--dev` で起動したときだけ有効にする。
- 書き込みの本文は 64KB を上限とし、超えたら拒否する。
- フックと MCP サーバーからの書き込みは、`401` か接続の拒否を受けたら `server.json` を読み直して 1 回だけやり直す。秘密値は常駐サーバーの起動ごとに変わるためである。
- 画面は `uiSecret` を配信時に HTML の meta 属性から受け取る。`401` を受けたら常駐サーバーが再起動して秘密値が変わったとみなし、`GET /` を取り直して新しい値で 1 回だけ送り直す。
- 要求の処理は `src/server/server.js` のルート表で決める。行ごとに、メソッド、パス、照合の種別(`hook`、`ui`、`ui-optional-origin`、`none`)、本文を読むか、ID の検査を持つ。
- 前段は、Host、ルートの決定の後に、秘密値(`401`)、Origin(`403`)、ID の検査、本文の順で行う。照合の種別が決まるのはルートを決めた後なので、照合の前に ID や本文の妥当性を応答して漏らさない。
- ハンドラーは機能ごとに `src/server/routes/` へ置き、前段を通った要求だけを受ける。ハンドラーは照合を持たず、新しい書き込み口はルート表に行を足して照合の種別を選ぶ。

## 状態不明のセッション

- ターンの状態を確定するイベントが届いていない行は「不明」にする。
  セッションファイルの `status` が `idle` なら「待機中」で補い、画面で終了にしたものを除く稼働中のサブエージェントがあれば「待機中(サブエージェント稼働中)」にする。
  `busy` なら「作業中」で補う。ただし非対話のセッション(`kind` が `interactive` 以外)は補わず、「非対話の実行中」を保つ。
  それ以外の値や項目の欠落では補わない。補った行には、セッションファイルの `statusUpdatedAt`(無ければ `updatedAt`)を `statusSince` として載せ、画面は経過時間と更新の無いセッションを隠す判定に使う。
  ファイルの `status` で補える間は保存した推定結果を消し、後で「不明」に戻っても古い推定を出さない。
- 常駐サーバーは、定期取得したライブセッションファイルの一覧から消えたイベント由来のセッションを、最後に一覧で確認してから 60 秒経過した時点で終了扱いにする。一度も一覧に載らなかったセッションは対象にせず、一覧を読めなかった取得では判定しない。時刻には `syncSessionFiles` の `now` を使う。
- `POST /api/sessions/<session_id>/estimate` は、現在の一覧に存在する状態不明のセッションだけを推定する。存在しない ID は `404`、状態が不明でなければ `409` を返す。ID は `[A-Za-z0-9_-]` の 1〜100 文字に限る。
- 会話記録の場所は、常駐サーバーが登録済みセッションの `cwd` と ID から `~/.claude/projects/<cwd の英数字以外を '-' に置換した値>/<session_id>.jsonl` として決める。画面からパスは受け取らない。解決したパスは `projects` の直下にある 1 階層のプロジェクトディレクトリ内に限る。
- 推定ではファイルの末尾 256KB だけを位置指定で読み、途中から読んだ場合は先頭の行を捨てる。assistant と user のうちサイドチェーンでない行を使い、会話本文は返さない。記録を読めない場合や対象行の形式が合わない場合は、推定不可として保存する。user の行の `content` は文字列のこともある。知らない種類の要素は推定に使わずに飛ばす。`isMeta` の user の行(スラッシュコマンドの出力など)は対象にしない。中断の行(`[Request interrupted` で始まる user の行)で終わる場合は `input` とする。長い cwd では Claude Code が記録の置き場の名前を縮めるので、場所が合わずに推定できないことがある。
- assistant の最後の行が `end_turn` で終わる場合、または `tool_use` を含まず stop reason も `tool_use` でない場合は `input` とする。user の行が最後なら `model`、それ以外の assistant の行なら `tool` とする。最後のツール名は末尾の読取範囲内で最後に現れる `tool_use` から求める。
- 推定結果はセッションごとにメモリーへ持ち、ターンの状態を確定するイベント(「状態」の項目)で消す。Notification などほかのイベントでは残す。読み取り中にイベントが届いて状態が分かったときは保存せず `409` を返す。結果を保存した後は `version` を進め、推定結果を応答と `GET /api/state` に含める。
- `POST /api/hidden-sessions` は `{action: "hide", session_id}` または `{action: "hide", session_ids}` で、一覧にあるセッションを状態にかかわらず外す。`session_ids` は ID を 1〜50 件含み、各 ID は `[A-Za-z0-9_-]` の 1〜100 文字に限る。知らない ID は無視し、1 件も一覧に無ければ `404` を返す。本文が仕様に合わない場合は `400` を返す。状態不明カードの「一覧から外す」とプロダクト見出しの「×」は同じ操作を使う。
- `{action: "clear"}` はすべて表示する。外した ID と時刻は `store.json` に保存し、セッションのイベントが届いたとき、またはセッションが終了扱いになったときに集合から削除する。`GET /api/state` では外したセッションに `hidden: true` と `hiddenAt` を付ける。
  `hiddenAt` は保存済みの `hiddenSessionUpdatedAt` である。
  時間経過による移動は画面の分類だけで行い、サーバーは外した集合から戻さない。

## 中断の検出

- Claude Code は利用者がターンを中断したときに Stop を送らないので、フックの状態は「作業中」か「許可待ち」のまま残る。会話記録には、中断の行(`[Request interrupted` で始まる user の行)が書かれる。
- 常駐サーバーは、セッションファイルを定期取得した後に、次をすべて満たす Claude のセッションだけ会話記録の末尾を読む。
  - フックの状態が「作業中」または「許可待ち」である(ファイルで補った状態は対象にしない)。
  - セッションファイルの `status` が `idle` で、`statusUpdatedAt` がメインの最後の区切りのイベント(`agent_id` の無い UserPromptSubmit、Stop、SessionStart)の hookAt より新しい。背景のサブエージェントのイベントの時刻とは比べない。
  - 前回読んだときの `statusUpdatedAt` と違う。同じ値なら読み直さない。会話記録を読めなかったときは記録せず、次の取得でもう一度読む。
    中断の行は `idle` より遅れて書かれることがあるので、末尾の行が中断の行でなく `statusUpdatedAt` より古いときは、`statusUpdatedAt` から 2 分の間は記録せずに次の取得で読み直す。
- 読み取りは sessionId ごとに同時に 1 つとする。記録の場所と末尾 256KB の読み方は、状態不明の推定と同じとする。
- 最後の対象行が中断の行で、その timestamp が最後の UserPromptSubmit の hookAt 以上なら、`hook_event_name` が `Interrupt` で `agent_id` の無いイベントを、その timestamp を hookAt として通常のイベントの取り込みに入れる。中断の行でなければ何もしない。Stop の取りこぼしは対象にしない。
- 状態を派生状態への直接の書き込みにしないのは、派生状態が全イベントから毎回作り直され、次のサブエージェントのイベントで消えるためである。合成したイベントは他のイベントと同じくメモリーにだけ置き、離席中の回答の配信の経路には流さない。

## サブエージェントの終了通知

- `TaskStop` などで止まったサブエージェントには `SubagentStop` が届かないことがあるので、常駐サーバーはメインの会話記録から終了の通知を読む。
- 読むのは、メインが止まっている(状態が「待機中(サブエージェント稼働中)」か「中断」)で、稼働中の Claude のサブエージェントがあるセッションとする。
  背景 Codex に稼働中か終了未確認で結果を受けていない行がある場合は、メインの状態によらず読む。
  メインのイベント(`agent_id` を持たないもの)を受けて約 500ms 後に 1 回読み、その状態が続く間は 60 秒ごとに読み直す。サブエージェントのイベントでは読まない。
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
- `POST /api/events` は `store.json` の保存完了を待たずに `202` を返す。フックの 1 秒期限内に応答するためであり、応答直後にサーバーが停止するとそのイベントの保存が失われるが、イベント自体はメモリーにだけ置いているため失われる情報は小さい。
- SessionStart フックは、`additionalContext` でダッシュボードの URL を 1 行返す。メインセッションが `preview_start {url}` で開く契機にする。

送る項目は次のとおりである。

| イベント | 送る項目 |
|---|---|
| 共通 | `session_id`、`hook_event_name`、`cwd`、`agent_id`、`agent_type`、`hookAt` |
| PreToolUse | `tool_name`、`tool_use_id`、入力の要約(80 文字まで。切り詰めた場合は末尾に「…」を付ける)。Agent ツールでは `tool_input.description`(200 文字まで)。メインセッションの `AskUserQuestion` では質問、見出し、選択肢の label と description、`multiSelect` も上限付きで送る |
| PostToolUse、PostToolUseFailure | `tool_name`、`tool_use_id`。Agent ツールの PostToolUse では `tool_response.agentId`(256 文字まで)と `tool_response.resolvedModel`(160 文字まで)を送る。出力(PostToolUseFailure では `error` の文字列も)に含まれる Codex の監査行と結果行だけを送る。背景へ移った Bash の `tool_response.backgroundTaskId` と、背景タスクの出力ファイル(`<ID>.output`)を読んだ Read、`cat` などの Bash、`TaskOutput` の背景タスク ID も、決まった形(英数字、`_`、`-` の 64 文字まで)のときだけ送る。PostToolUse の Codex は結果行を受けたときに終了と判定し、監査行だけなら背景で動いているものとして扱う。メインセッションの `AskUserQuestion` の PostToolUse では、認識できた回答だけを送る。PR の URL を得た Bash の PostToolUse では、コマンド先頭の `cd <パス> &&` から解決した絶対パスを `commandCwd` として送る(変数展開、`~`、引用符なしの `\`、二重引用符の中の `\` を含むもの、4096 文字を超えるものは送らない) |
| Notification | 通知の種類、メッセージ(200 文字まで) |
| SubagentStart、SubagentStop | 共通の項目だけ |
| Stop、SessionEnd、UserPromptSubmit | 共通の項目だけ。UserPromptSubmit では、`prompt` が `<task-notification>` で始まるときだけ通知を全件読み、`status` が終わり(`completed`、`failed`、`killed`、`stopped`)のものの `task-id` と `status` を `backgroundTaskEnds` に載せる。開発者が入力に引用した通知を、終了と取り違えないためである。出力ファイルの読み取りは 8 件までとし、`output-file` が絶対パスで、ファイル名が `<task-id>.output` と一致する場合は、先頭と末尾の各 64KB から Codex の監査行、結果行、実行 ID の行だけを `codexOutput` に載せる。128KB 以下のファイルは全体を読む。サーバーが受ける `backgroundTaskEnds` は最大 32 件とする。プロンプト本文と `summary` は送らない |

`answer.js` から届く `PostToolBatch` は、常駐サーバーの受信時刻を使う状態イベントとして記録する。
サブエージェントの `PostToolBatch` は `agent_id` 付きで送り、状態イベントとしてだけ記録する。回答、知らせ、催促はメインにだけ渡すので、この要求には何も返さない。
入力の要約は、Bash なら改行と続く空白を空白一つに置き換えたコマンド、Read、Edit、Write ならファイルのパス、それ以外はツール名だけにする。
要約が80文字を超える場合だけ先頭79文字に「…」を付ける。画面幅による省略は CSS の `text-overflow: ellipsis` で行う。

PostToolUse の出力全文は送らない。
`event.js` は `tool_response` から `codex-agent: agent=` と `codex-agent: result=` の行だけを抽出する。
常駐サーバーは監査行からモデル、effort、`codex_home` を読み、結果行から実行結果を読む。

## 状態

セッションのイベントは `SessionEntries` に集め、2,000 件を超えたときに畳み込む。
次の畳み込みは、保持件数が 2,000 件または直前の畳み込み後の件数から 1,000 件増えた値の、大きい方を超えたときに行う。
削除するのは、開始と完了がそろい、メインなら最新の `Stop` または `UserPromptSubmit`、サブエージェントなら自身の最新の `SubagentStop` より両方の時刻が古いツール呼び出しだけである。
先頭、状態の区切り、質問、許可待ち、委譲、背景タスク、モデルの情報、各サブエージェントの最初のイベントと最新のツール開始、最新の表示名とプロダクト、許可待ちの通知をまたぐ呼び出しは残す。
保持必須のイベントと区切りの無い実行中ターンは削除しないため、2,000 件は厳密な最大保持件数ではない。

質問の副リスト、PR コマンドの呼び出し ID の集合、メインの最新の区切りと入力の時刻は受信時に更新する。
`DashboardState` の `verifyEntries: true` または `AGENT_COCKPIT_VERIFY_ENTRIES=1` で、全イベントからの再構築と表示および索引を照合する。
`npm test` と `npm run test:inprocess` はこの照合を有効にし、常駐サーバーでは既定で無効にする。

- タスク催促の記録はセッションごとにメモリーだけに持ち、`SessionEnd` で消す。
- イベントとイベントから組み立てるセッション状態はメモリーだけに持つ。MCP のタスクと判断事項、離席中の `AskUserQuestion` から作る判断事項、それらへの回答記録、完了タスク、外したセッション、削除時刻の `deletedSessions`、表示設定、クロスレビュー不要記録は `store.json` に保存する。判断事項の質問、状態、作成・更新・解決時刻、解決内容は `plans.decisions` に、回答と配信時刻は `decisionLifecycles` に置く。離席中の質問の `tool_use_id` と判断事項 ID の対応は `askDecisionBindings` に置く。この項目が無い旧形式の `store.json` は、結び付きが無いものとして読み込む。`crossReviewSkips` が無い旧形式は空として読み込む。表示設定は `GET /api/state` の `display` で配り、初回だけ画面が旧 `localStorage` の値をサーバーへ移す。`display.mode` は `product` または `kind` で、初期値は `kind` とする。`display.sectionOrder` は 5 種類のセクションを表示する順で、未知の値や重複を除いて `sinceSeen`、`judgment`、`prs`、`tasks`、`now` の順で不足分を補う。`display.hideFinished` は完了済みの情報を隠す設定で、既定は `true` で、古い保存ファイルでも `true` として補う。`display.mergeableCondition` は `operation`、`ci`、`cross-review` のいずれかで、旧形式では既定の `cross-review` として補う。テーマと「前回見てから」の表示モードはブラウザーごとの `localStorage` に残す。「前回見てから」の初期値は「離席中のみ」とする。離席状態と期間は `{enabled, since, periods}` として `away.json` に保存し、起動時に読む。期間は `{start, end}` の数値ミリ秒で、離席中の期間の `end` は `null` にする。旧形式の `{enabled, since}` は、離席中なら `since` から現在まで、離席中でなければ期間なしとして読む。既読済みの期間、14 日の保持期限を過ぎた期間、50 件を超える古い期間を整理する。期間の記録だけが壊れているか食い違うときは、旧形式と同じく `enabled` と `since` から期間を作り直す。`enabled` と `since` が壊れているときは離席中ではない状態として扱う。
- 旧 `store.json` に残る `display.mergeAfterReviewDefault` は読み込み時に無視する。`mergeReservations` は登録セッション、リポジトリ、PR、方式、ブランチ削除の有無、予約時刻を `store.json` に保存する。旧 GitHub 自動マージ形式は予約として復元せず、そのまま捨てる。
- 表示設定 `display.idleHideMinutes` は更新の無いセッションを隠すまでの時間で、既定は 10 分、範囲は 5〜1440 分の整数とする。保存値が範囲外または整数でなければ読み込み時に 10 分へ戻し、書き込み時は拒む。
- 表示設定 `display.awayAnswerWaitMinutes` は離席中の質問への回答を待つ時間で、既定は 3 分、範囲は 1〜30 分の整数とする。保存値が範囲外または整数でなければ読み込み時に 3 分へ戻し、書き込み時は拒む。
- `GET /api/state` は `{version, generatedAt, display, sessions, pullRequests, sinceSeen, away, update, appVersion, routing, integrations, uiVersion}` を返す。`update` と `appVersion` は「更新の確認」の節に記す。`uiVersion` は `src/web/index.html` の内容の SHA-256 先頭 16 桁で、ファイルの更新時刻か大きさが変わったときに再計算する。`GET /` の HTML にも同じ版を埋め込み、画面は版の違いを検出して読み込み直す。状態不明のセッションには、推定済みなら `estimate`、一覧から外したなら `hidden: true` と `hiddenAt` を含める。`GET /api/away` は離席中だけを返す。`GET /api/tray` はトレイ用に `{permissionKeys, decisionKeys, awayEnabled}` を返し、PR や「前回見てから」の情報を計算しない。`version` は画面に出す状態が変わるたびに 1 増える。画面は 2 秒ごとに状態を取得する。
`POST /api/update/check` は今すぐの版の確認で、「更新の確認」の節に記す。
- 識別子は `session_id`、`agent_id`、`tool_use_id` をそのまま使う。

## 保存

保存対象、書き込みの直列化と再試行、起動時の復元と期限切れの扱いは、この節と「表示設定」「マージ」の各節に記す。

セッションごとに次を持つ。

- プロダクト: 鍵はリポジトリのルートの絶対パス(Windows では小文字にする)、表示名はそのフォルダー名。`cwd` が `<ルート>/.claude/worktrees/<名前>` の下なら、`<ルート>` をリポジトリのルートとする。ブランチ名は `cwd` から上へ探した `.git/HEAD` から読む。`.git` が worktree のポインター ファイルなら `gitdir:` の場所にある `HEAD` を読む。`ref: refs/heads/<名前>` はブランチ名、detached HEAD は短い SHA とし、読めなければ `null` にする。子プロセスは起動せず、同じ `cwd` の結果を 10 秒間キャッシュする。読み取るファイルは `.git` のポインターと `HEAD` に限り、どちらも 4 KB を上限とする。
- 最終イベント時刻: `lastActivityAt` にセッションの最新フック時刻を ISO 形式で持ち、メイン行の経過表示に使う。
- セッションファイル: `~/.claude/sessions/*.json` の `name` を題名に使い、有限の数値 `updatedAt` は ISO 形式にして `sessionFileUpdatedAt` に載せる。状態不明のセッションを隠す判定に使う。`status` は文字列の場合だけ先頭 50 文字を読み、文字列でない値は捨てる。項目が無い場合やファイルを読めない場合も動作を続ける。
- 状態: 作業中、待機中、待機中(サブエージェント稼働中)、中断、許可待ち、不明。ターンの状態は、agent_id の無い PreToolUse、PostToolUse、PostToolUseFailure、UserPromptSubmit、Stop、source が startup、resume、clear の SessionStart で確定する。許可待ちを優先し、それ以外で未確定なら「不明」にする。SessionStart の compact、Notification、サブエージェントのイベント、PostToolBatch では確定しない。イベント由来とセッションファイルだけの行のどちらも、「不明」でセッションファイルの status が idle なら待機中、対話セッションで busy なら作業中で補う。Stop を受けたときに稼働中のサブエージェントがあれば「待機中(サブエージェント稼働中)」にする。Interrupt(Codex のフックと、下の「中断の検出」が合成するもの)は Stop と同じ後始末をして、メインに中断の印を付け、状態を「中断」にする。稼働中のサブエージェントがあっても「中断」を優先し、許可待ちだけがそれより優先される。印は、後から届いたメインの UserPromptSubmit と、source が startup、resume、clear の SessionStart で外す。サブエージェントのイベントと、中断したツールの遅れた PostToolUseFailure などでは外さない。SessionStart の source が startup、resume、clear のときは、入力を待つ状態で始まるので待機中にし、メインの実行中のツールと許可待ちを外す。compact は自動の圧縮でターンの途中にも起きるので、直前の状態を保つ。SessionEnd を受けたら一覧から外す。一度生きている一覧に載ったセッションファイルが 60 秒以上一覧から消えた場合も、不在による終了として一覧から外す。不在による終了は、セッションファイルが再び一覧に載ったときに解除する。SessionStart と、それ以外のイベントは、hookAt が終了判定時刻より後なら終了扱いを解除して受け付ける。SessionEnd による終了は解除しない。
- 実行中のツール: PostToolUse が来ていない `tool_use_id` ごとの、ツール名と要約と開始時刻。メインの Stop と UserPromptSubmit ではメインのツールを消し、PostToolBatch ではその時刻より前に始まった、同じエージェント(メインかサブエージェント)のツールを消す。拒否されたツールには PostToolUse も PostToolUseFailure も届かないためである。サブエージェントの PostToolBatch では、そのサブエージェントの、その時刻より前に始まった許可待ちも消す。メインの許可待ちは PostToolBatch では消さず、Stop と UserPromptSubmit で消す。
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
常駐サーバーは `gh` の保存済み認証を使い、60 秒ごとにリポジトリの状態を取得する。
登録と関連 PR のどちらにも、開いているか未確定の記録(`state` が `open`、`unknown`、`null`)が無いリポジトリは、最後に取得を始めてから 15 分経つまで定期取得を飛ばす。
初回の取得、登録の追加、確定操作の確かめ直しの取得(`refreshRepoFresh`)は間引かない。
`git push` または `gh pr` の後の取り直し(`refreshAfterCommand`)は全リポジトリが対象になるので、開いている PR が無いリポジトリは 60 秒に 1 回まで間引く。
間隔が足りずに飛ばしたリポジトリは、間隔が明けた時点の取得を 1 回だけ予約する。
確定操作の確かめ直しの取得は、その中で呼ぶ gh もすべて待ち行列で優先する。
同じリポジトリの取得が先に動いていれば、それを待つ間、そのリポジトリの gh を優先に引き上げる。
間引いたリポジトリの登録と表示は残し、登録と関連 PR が無くなったリポジトリの表示は従来どおり消す。
`PullRequestTracker.execute` を通る `gh` は同時に 4 本までとし、残りは待ち行列に入れる。
開発者が画面で確定したマージ、base の付け替え、ブランチの削除とその結果の確認は、定期取得より待ち行列で優先する。
`gh` の 20 秒の期限は、待ち時間を含めず、起動してからの時間に掛ける。
base と head の対応から関連するオープン PR を積み上げる。クロスレビュー状態は各オープン PR のスタック木の `crossReview` に `round`、`max`、`dismissed`、`reviewedSha`、`triage` を設定する。`triage` は状態ファイルの `lastTriage` を `{round, sha, outcome}` に検証したもので、`sha` は 40 桁か 64 桁の小文字、`outcome` は `fixing`、`converged`、`halted` のいずれか。無いか形が合わなければ `null` とする。表示の規則は計画書の決定「クロスレビューの結論の表示」を正本とする。セッションが登録したオープン PR で、worktree に `tools/cross-review.js` はあるがそのブランチの記録が無いもの(状態ファイルがまだ無いものを含む)は「レビュー未実施」とする。`tools/cross-review.js` が無い worktree の PR は「レビュー不要」とする。登録の無い関連 PR とマージ済み PR にはレビュー行を出さない。状態ファイルの有無ではなく、追跡される `tools/cross-review.js` の有無で連携を判定する。
状態ファイルは、登録の `cwd` の worktree に加えて、同じリポジトリのほかの worktree からも探す。PR の head のブランチをチェックアウトしている worktree は記録の有無を問わず候補にし、それ以外の worktree はそのブランチの記録を持つときだけ候補にする。スタックを 1 つの worktree で積むと、下の段のブランチはどこにもチェックアウトされないためである。
登録の `cwd` と製品は、`commandCwd` があればそこから決める。`cockpit_add_pr` で登録し直しても、登録済みの `cwd` と製品は変えない。
cwd の worktree の GitHub の remote のどれも PR のリポジトリと一致しないときは、クロスレビューを「確認できない」とし、その worktree をほかの worktree の候補からも外す。remote が読めないときや GitHub の remote が無いときは、この照合をしない。
表示設定 `display.mergeableCondition` は「マージ操作が可能」「CI が成功」「現在の head のクロスレビューが収束または不要」の各条件を選ぶ。既定は最後の条件まで求める。収束は `lastTriage.round` と現在の round が一致し、`lastTriage.sha` と現在の head が一致する場合だけ有効とする。操作可否は CI とクロスレビューを含めずに判定し、選択条件を満たすかどうかでカードの緑表示、待ち条件と件数を決める。操作可だが条件が残る場合も、確認欄に警告を出して開発者が実行できる。
クロスレビュー不要記録は PR の owner/repo/番号、head SHA、理由を `store.json` の `crossReviewSkips` に保存する。MCP の `cockpit_skip_review` は登録元セッションからのみ記録でき、ダッシュボードの操作は起動時の秘密値と必須 Origin を照合して記録または取り消す。どちらもサーバーが最新の PR head を取り直して照合し、別の head には適用しない。head が変われば記録を無効にし、PR 登録の保持期限に合わせて削除する。
MCP ツールは `POST /api/sessions/:session/prs`、カードの設定と取り消しは `POST /api/pull-requests/review-skip` を使う。画面からの要求は `uiSecret` と `validRequiredUiOrigin` を通し、登録キーと表示中の head SHA が最新状態と一致することを確かめる。
各プロダクトの PR 群には、リポジトリ全体の失敗をまとめた `error` とは別に、そのプロダクトのオープンの PR を数えきれていないことを示す `openStateUnknown` を付ける。PR の一覧を取得できなかったときと、そのプロダクトが登録した PR の状態を確かめられなかったときに真にする。
取得できないリポジトリ(存在しないリポジトリの PR を登録した場合など)のエラーは、原因の登録が残る限り出続ける。そのため、PR 群に、状態が `unknown` の登録と関連 PR の件数 `unregisterableCount` を付け、画面はエラーの枠に「このリポジトリの登録を外す」を出す。`POST /api/pull-requests/repository/unregister` は、秘密値と必須 Origin を照合したうえで、そのリポジトリの `unknown` の記録だけを消す。`open`、`closed`、`merged` の記録、マージの履歴、予約は消さない。
登録が保持期限などで消えたプロダクトの PR 群は、次の取り直しで配らなくなる。登録と関連 PR が 1 件も無くなったリポジトリは、取得した状態ごと捨てる。
積み直し待ちは、各オープン PR の base から同じブランチ名を head に持つオープン PR、次にマージ済み PR をたどって compare の base を決め、マージ済み PR の head SHA がその差分に残っているかで判定する。親とみなすのは、head SHA が差分にあり、base が比較経路に直接一致する PR、または候補 PR の後に同名 head の PR がマージされ、その base の鎖を比較経路までたどれる PR である。一覧が完全な場合は直接親と確認できた間接親を合わせ、マージ時刻が最も古い候補を選ぶ。同秒の同名headがある場合は順序を確定せず、確認不能とする。不完全な一覧では直接親だけを確定できる既存の扱いを維持する。間接探索は既定ブランチで止め、同名再利用の経路が複数成立する場合や一覧が不完全な場合は確認できない扱いにする(詳細は[計画書](../handover/2026-10-02.md)の「積み直し待ちの判定」)。
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
結果は PR を登録したセッションへ PostToolBatch、UserPromptSubmit、Stop の回答配信経路で知らせる。レビュー収束後マージの結果には、ブランチ削除、base の付け替え、警告を保存し、既存のマージ結果 1 行と同じ形式で画面へ配る。画面には `warning` が空でない文字列か `headMismatch` が真の結果だけを表示し、`閉じる` 操作まで残す。予約マージ結果の `mergeResultClosedAt` は `POST /api/pull-requests/merge-result/close` で記録し、旧形式で項目が無い結果は未閉鎖として扱う。閉鎖時刻はマージ履歴と同じ 24 時間の保持期限で整理する。
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
- Agent ツールの PostToolUse の `agentId` が既存の結び付けと異なるか、結び付けが曖昧なら、その ID からサブエージェント行を引き直して結び付けを更新する。
- PostToolUse の `resolvedModel` は、その行のモデルに反映する。
- Agent 呼び出しの説明は、PostToolUse で Agent の実行中ツールを消す前に、対象の行へ書く。SubagentStart の時点の結び付けは到着順で誤ることがあるので、既に説明があっても呼び出し自身の説明で上書きする。
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
- 背景タスクの完了通知は UserPromptSubmit とメインの記録ファイルの両方から取り込む。
  終了状態の通知の task-id が同じセッションの背景タスク ID と一致する、稼働中か終了未確認で結果を受けていない背景 Codex の行を終了にする。
  行に背景タスク ID が無い場合だけ、出力ファイルの `codex-agent: run=` と行の実行 ID の一致で照合し、どちらかが無ければ終了にしない。
  記録ファイルから得た通知は、行の開始より古いものを使わない。
  出力ファイルは絶対パスでファイル名が `<task-id>.output` のものだけを読み、記録ファイルの経路では非同期に 1 回 8 件まで読む。
  先頭と末尾の各 64KB から結果行が得られれば既存の結果処理を適用し、結果行が無ければ監査行と実行 ID を反映して稼働中と終了未確認の印を外す。
  記録ファイルの経路は内部イベント `BackgroundTaskEnd` を追加し、メインの状態、最終活動時刻、ターンの区切りを変えない。
  終了した行は次の読み取りの対象から外す。
  `BackgroundTaskEnd` と Claude の `Interrupt` は内部イベントとして、フックと `/api/events` からは受け付けない。
  Codex の `Interrupt` は実際のフックの通知なので、従来どおり受け付ける。
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
デスクトップアプリ上で却下した質問には終了フックが来ないため、後続のメインセッションの UserPromptSubmit、Stop、別の tool_use_id の PreToolUse で `waiting` の質問を `withdrawn` にする。
受信済みの最新の質問開始より後の時刻のイベントだけを使い、同じ質問の出し直しは既存の判断事項へ結び付ける。
`provisional` と、フックの回答待ちを扱った `decisionLifecycles` の記録がある質問は対象から外す。
回答待ちの期限は再起動で消えるため、期限や回答の有無だけではなく記録の存在を保護の根拠にする。
後続イベントによる取り下げは `finishedByToolUseId` と終了時刻に加え、推定の印を兼ねる根拠イベントの `hookAt` を `inferredWithdrawalHookAt` に保存する。
この項目がない保存済みの判断事項は、推定による取り下げとして扱わない。
推定で取り下げた呼び出し(`finishedByToolUseId`。出し直しがあれば最新の呼び出し)の PostToolUse / PostToolUseFailure が遅れて届き、その `hookAt` が推定の根拠より前なら、保存状態を終了フックの結果と終了時刻へ訂正し、推定の印を消す。
出し直し前の呼び出しの終了フックは、最新の呼び出しの結果を説明しないので訂正に使わない。
PostToolUse は `resolved` と回答内容、PostToolUseFailure は `withdrawn` と `resolution: null` を保存する。
推定の根拠と同時刻か、それより後の終了フックでは取り下げを変えない。
推定の取り下げと訂正後の状態は、再起動後やイベントからの作り直しでも保つ。
終わった判断事項に、最初の呼び出しか判断事項を終えた呼び出し(`finishedByToolUseId` に保存し、waiting に戻っても残す)の PreToolUse か、終わった時刻より古い PreToolUse が届いても、状態と解決の内容を変えない(遅れて届いたか重複した開始の知らせのため)。
常駐サーバーの再起動の前に終わった判断事項と、イベントから作る前に MCP で終えた判断事項は、終わりのイベントがメモリーに無いので、同じ呼び出しの PreToolUse から作り直さず保存済みの状態を保つ。
ただし、取り下げ済みの呼び出しを除き、開始と終わりがどちらもメモリーにある呼び出し(結び付いた出し直しの呼び出しを含む)で、終わりの時刻が保存済みの終わりの時刻以降のときは、イベントから作り直す。
MCP で終えた判断事項は `finishedByToolUseId` を書き換えないので、終えた時刻より新しい時刻で、結び付いた別の呼び出しの開始が重複して届くと、waiting に戻りうる。
サブエージェントの `agent_id` があるイベントは判断事項にしない。

タスクは `[{title, state, criteria: [{text, met}]}]` の配列で持つ。
`state` は `todo`、`doing`、`done` のいずれかにする。
MCP の `cockpit_set_tasks` は配列全体を置き換え、成功時に `tasksUpdatedAt` を更新する。
題は 200 文字、本文は 2,000 文字、タスクは 50 件、完了条件は 20 件、選択肢は 6 件までに制限する。

MCP サーバーは `src/mcp/server.js` で、JSON-RPC を stdio の行単位で扱う。
ツールは `cockpit_set_tasks`、`cockpit_add_decision`、`cockpit_update_decision`、`cockpit_add_pr`、`cockpit_skip_review` の 5 つである。
計画の変更は `ensureServerRunning` で常駐サーバーを確かめ、`secret` 付きで `/plan` に送る。PR の登録とクロスレビュー不要の記録は `/prs` に送る。
MCP が渡す `ppid` と `CLAUDE_CODE_SESSION_ID` のうち、常駐サーバーはまず `ppid` から `~/.claude/sessions/*.json` に対応する session ID を探し、見つからない場合に環境変数の ID を使う。どちらも無ければ書き込みを拒否する。
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

ダッシュボードの外部 HTTPS リンク(利用者向けマニュアルを含む)は、画面が `POST /api/open-url` に `{url}` を送り、常駐サーバーが OS の既定のブラウザで開く。
トレイが開くダッシュボードは専用のプロファイルのブラウザなので、利用者がログインしているブラウザで開くためである。
書き込みの口と同じく画面用秘密値と `validRequiredUiOrigin` を照合する。URL は 2048 字以内で制御文字を含まず、空白と引用符が正規化後に残らないものだけを受ける。
受けるのは `https:` だけである。常駐サーバー自身を含め、`http:` の URL は開かない。
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
- 更新時刻(`lastUpdatedAt`、無ければ `statusSince`、それも無ければ `sessionFileUpdatedAt`)から `display.idleHideMinutes` を過ぎたセッションは、プロダクト別と種類別の一覧から隠す。許可待ち、`waiting` または `provisional` の判断事項、稼働中のサブエージェント、状態が「作業中」のいずれかがあれば表示する。
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
- プロダクト別では上下移動、最上部への固定、畳む・開くを使える。固定と通常の境界を越える移動はできない。表示モード、並べ替え、固定、畳み、隠した種類、セクションの並び順などの表示設定は常駐サーバーに保存する。種類別では 5 つの欄を設定順に並べる。プロダクト別ではセッション内の判断、タスク、今の 3 欄を設定順に並べ、「前回見てから」と PR は 3 欄すべてより前ならセッション群の上、それ以外は下に置く。同じ側では設定順に並べ、PR の区切りはセッション群との間で PR 側に置く。配色と「前回見てから」の表示モードはブラウザーの `localStorage` に保存する。利用できない場合も画面操作は使える。
- 待ち時間は 1 分ごとに表示を更新し、設定した閾値(1〜120 分、既定 15 分)を超えたものを強調する。解決済みと取り下げの判断事項、終了済みサブエージェント、完了タスクは折りたためる。
- 更新の無いセッションの判定は 1 分ごとの描き直し時点で行う。`display.idleHideMinutes` の既定値は 10 分で、5〜1440 分の整数を指定できる。
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

回答欄には選択肢、指示の入力欄、「回答を送る」を置く。

回答欄を出している判断事項では、選択肢そのものを押して答えに選べる。
単一選択の質問では 1 つ、複数選択の質問では複数を選べる。
推奨を受け入れる場合も、推奨の札が付いた選択肢を選ぶ。
選んだ選択肢があるときは、回答欄に「送る答え: <label>」を出す。
複数の質問を持つ判断事項では、選ばなかった質問に推奨の label を使い、推奨が無ければ指示の文を使う。
推奨も指示も無い質問が残る間は「回答を送る」を押せない。

推奨は、単一選択の質問で label に「(推奨)」または「(Recommended)」(括弧は全角・半角を許容し、英語の大文字小文字は区別しない)を含む選択肢、または MCP の `cockpit_add_decision` で `recommended: true` を明示した選択肢がちょうど 1 つのときに付け、description は判定に使わない。

複数選択の質問では推奨を決めない。

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

締切は登録時刻から設定画面の「離席中に質問の回答を待つ時間」後(1〜30 分、既定 3 分)とし、常駐サーバーが持つ。登録後に設定を変えても、既に待っている質問の締切は変えない。

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

## 診断ログの経路

記録と画面の仕様は [診断ログ](diagnostics.md) にある。
レベルは表示設定の `diagnosticsLevel` に保存し、`POST /api/display` で変える。

| 経路 | 認証 | 応答または本文 |
|---|---|---|
| `GET /api/diagnostics` | なし | `{runs: [{id, startedAt, count, current}], version}`。現在の起動を先頭に返す |
| `GET /api/diagnostics?run=<起動>` | なし | `{entries, version}`。区分を古い順に連結する |
| `POST /api/diagnostics` | MCP は secret と Origin 無し、画面は uiSecret と同一 Origin | `{entries: [{msg, data}]}`。本文は 16 KiB、記録は 8 件まで。応答は `202 {accepted: true}` |
| `POST /api/diagnostics/delete` | uiSecret と同一 Origin | 本文は `{run}` または `{all: true}`。応答は `{ok: true}` |

起動識別子の形式が違うと `400` を返す。
削除と追記は同じキューで処理し、現在の起動を削除した後は新しい区分に追記する。
外部の識別子、鍵、値は `src/client/diagnostic-events.js` で照合し、出どころとレベルはサーバーが決める。
`POST /api/events` の `diagnostics` は先頭 8 件まで照合する。
フックの送信失敗の退避は起動時とセッションの定期走査で取り込む。

`src/server/diagnostics.js` は `Diagnostics` と起動識別子の `RUN_PATTERN` を公開する。
常駐サーバーが使う操作は `record(level, tag, msg, data)`、`listRuns()`、`readRun(run)`、`deleteRuns({run, all})`、`flush()` である。
`record` は許可した識別子と鍵だけを保存し、書き込みに失敗しても呼び出し元へ例外を返さない。
未知の要求経路は `unknown`、セッションと判断の ID は `:id`、マニュアルの相対パスは `:path` として残し、クエリーは残さない。
