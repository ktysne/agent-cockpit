# 常駐サーバー、フック、画面の設計

この資料は常駐サーバー、フック、画面の現在の構成と通信の仕様を定める。

## 構成

- Node.js 22 以上で、外部の依存を持たない。テストは `node:test` で書く。
- `src/server/` は常駐サーバー、`src/hooks/` はフックから呼ぶスクリプト、`src/web/` は画面である。
- 画面の見た目は [mock/index.html](../../mock/index.html) とそろえる。画面にはセッション、判断事項、タスク、サブエージェント、許可待ち、プルリクエストなどの状態を表示する。

状態の保持と保存要求は `src/server/state.js` の `DashboardState` が担う。
イベント列からのセッションの組み立ては `session-projection.js` に置く。
イベントは `hookAt` と `sequence` の順に並べ、通常のイベントは前段の共通処理、種類別の処理、後段の共通処理の順で適用する。
`BackgroundTaskEnd` はバックグラウンドタスクの終了処理だけを適用する。
適用時の副作用は渡されたセッションにだけ及び、保存要求は出さない。

「前回見てから」の行の組み立ては `since-seen.js` に置く。
このモジュールは時刻と候補を受けて行を作り、候補の取り出し、既読時刻の更新と保存要求は `DashboardState` が担う。
共有するプロダクトの検査と複製は `product-utils.js` に置き、これらのモジュールから `state.js` を参照しない。

## 置き場

常駐サーバーの置き場は `~/.agent-cockpit/` で、環境変数 `AGENT_COCKPIT_HOME` で差し替えられる。
テストは必ず一時ディレクトリへ差し替え、ポートは 0 で待ち受ける。開発機で動いている本物の常駐サーバーに触れないためである。

| ファイル | 中身 |
|---|---|
| `server.json` | `{pid, port, secret, uiSecret, startedAt}` |
| `away.json` | `{enabled, since, periods}`。不在、解析失敗、形式不一致は既定値で開始する。その他の読み取りエラーは数回読み直し、それでも読めなければ起動を失敗させる |
| `server.log` | 起動、停止、エラー。追記する。ツールの入力の要約は書かない |
| `server.log.1` | 1 つ前の `server.log`。常駐サーバーを起動するとき、`server.log` が 1 MB を超えていればこの名前に移し、前の `server.log.1` を置き換える |
| `diagnostics/<起動時刻>-<pid>.<区分番号>.jsonl` | 診断ログ。1 区分 2000 行、直近 10 起動、全体 30 区分まで |
| `diagnostics/hooks-pending.jsonl` | 常駐サーバーへ送れなかったフックの診断の記録。フックが追記し、256 KB を超える追記は捨てる。常駐サーバーがセッションの走査のたびに診断ログへ取り込む |
| `diagnostics/hooks-pending.jsonl.importing` | 取り込み中の `hooks-pending.jsonl`。この名前に移してから読み、読み終えたら消す。残っていれば次の取り込みで先に読む |
| `diagnostics/hooks-pending.lock` | `hooks-pending.jsonl` の追記と取り込みの排他。中身は持ち主の pid で、取り込む側は、持ち主が終わっているか、pid の無いまま 10 秒たったロックを消して取り直す |
| `start.lock` | 常駐サーバーの起動の排他。10 秒で失効する |
| `store.json` | 画面表示設定、タスク、判断事項と回答の記録、完了タスク、外したセッション、削除済みセッションの時刻、PR の記録、Codex のセッションの復旧の記録。不在は既定値で開始し、その他の読み取りエラーは数回再試行しても読めなければ起動を失敗させる |
| `store.json.broken-<時刻>` | 解析または形式が壊れた `store.json` の退避先。時刻は ISO 形式の `:` と `.` を `-` に置き換えたもの。退避に成功すれば保存の無い状態で起動し、失敗すれば起動を失敗させる |
| `tray.json` | タスクトレイの設定 `{notifyPendingCounts}`。許可待ちと判断待ちが増えたときに Windows の通知を出すかを持つ |
| `browser/` | タスクトレイがダッシュボードを Edge のアプリのウィンドウで開くときのプロファイル(`--user-data-dir`) |
| `agent-cockpit.ico` | ショートカットのアイコン。`src/tray/install-shortcut.ps1` がタスクトレイのスクリプトから書き出す |
| `routing.json` | 経路の設定。不在、破損、無効な値は既定値で開始し、その他の読み取りエラーは数回再試行しても読めなければ起動を失敗させる |
| `route-agents/*.json` | サブエージェント開始時の経路記録。24 時間使われていない記録は次の開始時に削除する |

## 起動と寿命

- フックと MCP サーバーは、`GET /health` の応答が `{app: "agent-cockpit", pid, startedAt, version, commit, sourceState}` で、app と pid と startedAt が `server.json` の識別情報と一致するとき、常駐サーバーが動いていると判定する。
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
- セッションファイルの定期取得は同時に一つだけ進め、取得中に重なった要求は同じ処理を共有する。終了処理は進行中の取得を待ち、終了処理を始めた後に完了した結果は状態へ反映しない。

## 導入の点検

`doctorCheck` を渡した常駐サーバーは、導入の診断を子プロセスで実行し、結果をメモリーに保持する。
起動の 90 秒後、画面からの要求、本体の SessionStart を契機に実行する。
SessionStart は最後のイベントから 10 秒まとめ、前の点検開始から 60 秒空ける。
定期の点検はしない。
呼び出しと出力の契約は [導入の整合の診断の設計](doctor.md#常駐サーバーからの点検) にある。

- `GET /api/state` の `doctor` は実行中か、生成時刻、失敗分類、件数、再起動待ちになった時刻だけを持つ。
- `GET /api/doctor` は最後に成功した点検の全文を返す。照合は `none` とし、期待値、観測値、書き換える対処の中身は省く。結果が無ければ null を返す。
- `POST /api/doctor/check` は照合を `ui` とし、画面用の秘密値と Origin を確かめる。実行中なら同じ実行を待ち、完了後の要約を返す。点検を有効にしていない場合は 409 と `{"error":"doctor-check-disabled"}` を返す。

## 更新の確認

公開するバージョンの正本は `vX.Y.Z` 形式の Git タグとし、リリース時に `package.json` の `version` を合わせる。
手元のバージョンは `package.json` から読む。
ブランチや worktree の HEAD に依存せず、稼働中のコードに付いたバージョンを確認できるためである。
固定の `https://github.com/ktysne/agent-cockpit.git` へ `git ls-remote --refs --tags` で問い合わせる。
チェックアウトの remote が fork や別の URL でも、配布元のバージョンを確認するためである。
正式なバージョンのタグだけを拾い、3 つの整数で比較し、最大のバージョンが手元より新しければ通知する。
`0.0.0` からの変更を見るリンクは、存在しないタグとの比較を避け、新しいタグの tree を指す。

確認は起動 1 分後、その後 6 時間ごとに行う。
git は対話を無効にし、15 秒の期限と 1MB の出力上限を設ける。
タイマーは `unref()` し、終了時に解除し、確認中の処理が終わってから診断ログを閉じる。
成功は結果を info で、失敗は分類だけを warn で診断ログに残す。
`update` は `{current, latest, available, checkedAt, succeededAt, error}` を基本項目として持ち、新しいバージョンがある場合は `prompt` と `compareUrl` も持つ。
`checkedAt` は最後に試した時刻、`succeededAt` は最後に成功した時刻、`error` は最後に試した確認の失敗分類で、成功後は `error` を `null` にする。
失敗時は前回成功した `latest`、`available`、`succeededAt` を残す。
公開したタグは通常取り下げないため、一度見つけた更新候補は一時的な確認失敗の後も有効である。
成功が一度もない場合は `latest` を `null`、`available` を `false`、`succeededAt` を `null` のままにする。

確認結果は `DashboardState` の snapshot に入れず、`/api/state` の `update` に並べる。
セッションの状態が変わったわけではないため、状態の `version` を進めない。
画面は版番号による描き直しの判定の外で、毎回通知を更新する。
依頼文とリンクは新しいバージョンがある場合だけサーバーが組み立て、依頼文の手順書の場所はサーバーのファイルの位置から求める。

画面の設定の「更新を確認」は `POST /api/update/check` で、定期の確認を待たずに今すぐ確かめる。
本文は JSON のオブジェクトだけを受け付け、画面用の秘密値と Origin を照合する。
応答は `/api/state` の `update` と同じ形で、確認の結果を返す。
確認の実行中に来た要求は、新しい git を起動せず同じ確認の結果を待つ。
確認を有効にしていないサーバー(`updateCheck` を渡していない場合)は `409` と `{"error":"update-check-disabled"}` を返す。
定期の確認の時機は変えない。

起動時のバージョンは `/api/state` の `runtime: {version, commit, sourceState, startedAt}` で渡す。
互換のため `appVersion` も残す。
画面のタイトルは `v1.4.0` の形でバージョンだけを出し、commit は出さない。commit は利用者が読む情報ではないためである。
診断の記録は、sourceState が release 以外で commit があれば `v1.4.0+c933f60` の形にする。
バージョンが無い場合は「バージョン不明」とする。
runtime を返さない旧サーバーでは appVersion を使う。
デモの常駐サーバーは `appVersion` を `null` にし、commit も読まずにバージョンを出さない。マニュアルと紹介ページの画像が、バージョンを上げるたびに変わらないためである。

listen 前には `.git` のファイルから commit だけを読む。
listen 後に info と同じ pid と startedAt で `{version, commit, pid, startedAt}` を確定し、以後変えない。
sourceState は別に持ち、listen 後に git のタグ照合と追跡ファイルの状態確認を各 5 秒の期限で並行して開始する。
判定中は pending、追跡ファイルに変更があれば dirty、注釈タグ `v<version>` の実体コミットが起動時 commit と一致すれば release、不一致なら diverged、タグが無い場合や読み取りの失敗時は unknown とし、一度確定した後は変えない。
startServer はこの判定を待たずに返し、close は判定と診断記録の完了を待つ。

確認を有効にするのは `startServer` に `updateCheck` を明示して渡した場合だけで、CLI の main が渡す。
テストとデモと撮影は既定で git を起動しない。
確認のテストは git の実行と時計を差し替え、ネットワークを使わずに時機と結果を確かめる。

再起動は外のプロセスで `src/client/restart-server.js` を実行する。
ダッシュボードの再起動待ちの帯から `POST /api/server/restart` を呼べる。
本文は JSON オブジェクトを受け付け、`auth: ui` の秘密値と同一 Origin の照合を使う。
`startServer` の `serverRestart` を明示した場合だけ有効にし、CLI は `{}` を渡す。dev では無効にする。
無効なら `409 Restart unavailable`、更新が不要なら `409 Restart not required`、開始から 60 秒以内なら `409 Restart in progress` を返す。
開始時刻は保存の書き出し前に記録し、60 秒で再試行できるようにする。
起動直前に `state.flushPersistence()`、`away.flushPersistence()`、`routing.flush()` と `diagnostics.writeRepeated()` を待つ。子が停止を見送ると旧サーバーが動き続けるため、診断ログの定期の書き出しを止める `diagnostics.flush()` は使わない。
`process.execPath` で再起動スクリプトに `--json --expect-pid <pid> --expect-started-at <startedAt>` を渡す。
子は `detached: true`、`windowsHide: true` とし、標準入力を無視し、出力を `server.log` に追記する。
作業場所は保存先とし、`childEnvironment` で除いた環境に `AGENT_COCKPIT_HOME` と `AGENT_COCKPIT_PORT` を渡す。
`spawn` を待って `unref` し、`202 {restarting: true}` を返す。失敗は開始時刻を解除して 500 を返す。
期待の pid または startedAt が `server.json` と違う場合、再起動スクリプトは停止も起動も行わず `stale` を返す。
画面は帯の中で実行中の行が消えることと許可待ちの件数を確認し、送信後は再起動中と表示する。
接続失敗でも待機を続け、`runtime.startedAt` が変われば通常の表示に戻す。30 秒で変わらなければ失敗とトレイからの再起動を案内する。再起動のボタンは `restartAvailable` が `true` のときだけ出し、サーバーが受け付けない間は押せないようにする。

既存の接続処理で `server.json` と `/health` の pid と startedAt とアプリ名を照合し、一致するプロセスだけを止め、終了を待ってから既存の起動処理を使う。
Windows では `process.kill(pid)` は対象を終了させるため、停止のシグナル処理による保存には頼らない。
照合の前に 1 秒待つ。更新を進める AI がその直前に MCP でタスクを書くことが多く、500ms のまとめ書きが済む前に止めるとその変更を失うためである。
照合の後に待つと、その間に pid が別のプロセスに使われたときに、照合していないプロセスを止めてしまう。
待った後の書き込みが失われ得るのは、トレイの再起動と同じ扱いにする(「保存」の書き方の項)。
最初の照合に失敗して止めずに起動処理へ進み、起動処理が元と同じ pid と startedAt のサーバーを返したときは、再起動していないので失敗を返す。
生存確認にはシグナル 0 を使い、終了を確認できなければ起動せずに失敗を返す。
起動後は期限つきで `/health` を取得し、起動処理が返した pid と startedAt、およびアプリ名を照合する。
このスクリプトのチェックアウトの `package.json` を JSON として読み取った version と、`readSourceCommit` で得た commit を期待値にする。
バージョンが無い応答や、バージョンまたは取得できた期待の commit が違う応答は `mismatch` とし、このフォルダーのコードで動いていないことを伝えて、別のフォルダーの常駐サーバーを確かめるよう案内する。
期待の commit を取得できなければ、バージョンだけを照合して成功にし、更新後のコードで動いているか確かめられないことを明示する。
更新用の再起動では sourceState が pending の間、最大 10 秒まで 1 秒以内の `/health` 要求で取り直す。
取り直しで app、pid、startedAt のいずれかが起動情報と合わなくなった場合は、その応答を `mismatch` とする。
sourceState が無い応答は取り直さず、期限内に確定しない場合は最後の応答を返して `releaseVerified` を false にする。
取り直し中に `/health` を取得できなくなった場合も最後の応答を返す。一時的な通信失敗で起動確認全体を失敗にしないためである。
`releaseVerified` は `result` が `ok`、`commitVerified` が true、sourceState が release の場合だけ true とする。
成功時は再起動したこととバージョンを出し、commit が未照合なら更新後のコードで動いているか確かめられないことを添える。
失敗は `stop-timeout`（旧サーバーの終了未確認）、`start-failed`（起動失敗または起動後の health 取得失敗）、`stale`（旧起動の再利用）、`mismatch`（起動情報、バージョン、コミットの不一致）に分ける。
`--json` は人向けの文を付けずに `{result, stoppedPid, pid, expected: {version, commit}, running: {version, commit, sourceState} | null, commitVerified, releaseVerified}` を 1 行で出し、失敗時は終了コード 1 を返す。
`restartServer` も成功時には同じ形を返し、失敗時の例外には分類を `result`、同じ形の情報を `details` に持たせる。
更新用の再起動は `releaseVerified` を返すために sourceState の確定を待つが、タスクトレイの `ensure-server.js --verify` は待たない。
リリースの `report` は server.json と `/health` の起動識別をタグの実体コミット取得前に確かめる。
公開したバージョンと手元の常駐サーバーの状態を案内し、バージョンとタグの実体コミットが一致して `releaseVerified` が true のときは公開したバージョンで動いていると伝える。
sourceState が dirty の場合は起動時に未コミットの変更があったことを伝え、その他の sourceState で同じコードと確認できない場合は常駐サーバーの再起動を案内する。
バージョンかコミットが一致しないときは稼働中のバージョンと再起動の案内を出す。稼働していない場合と照合できない場合も、それぞれの状態を知らせる。
この案内はサーバーを停止も再起動もせず、照合できなくてもリリースの成否を変えない。
これは [常駐サーバーの再起動の判断](../handover/2026-10-02.md#決定済みの判断)と同じく、常駐サーバー自身から代わりを起動せず、画面に再起動の口を増やさない構成である。
トレイの再起動は、確認ダイアログの前に `server.json` の PID が生存し、コマンドラインを読める場合に、`src\server\server.js` の起動元フォルダーを調べる。
別フォルダーの agent-cockpit なら停止も確認ダイアログも行わず、そのフォルダーのタスクトレイから再起動するよう通知する。
確認後に停止するのは、コマンドラインにこのチェックアウトの `server.js` を含むプロセスだけである。
起動は `ensure-server.js --verify` を使い、`server.json` の PID が切り替わったことを確かめた後に、起動元のフォルダーと `/health` の照合結果を見る。
別フォルダーの agent-cockpit が起動した場合は、照合の結果によらずフックの登録先を確認するよう案内する。同じコミットの別フォルダーでは照合が一致するためである。
それ以外で照合が一致すれば成功を通知する。このフォルダーから起動していてバージョンかコミットが違う場合は、再起動の途中でファイルが更新されたとみなして再起動を促す。
起動元のフォルダーを読めずに食い違う場合は、再起動を促し、続くときはフックの登録先を確かめるよう案内する。

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
- 画面は `uiSecret` を配信時に HTML の meta 属性から受け取る。`401` を受けたら常駐サーバーが再起動して秘密値が変わったとみなし、`GET /` を取り直し、埋め込まれた画面の版を現在の画面の初期の版と照合する。
  同じ版なら秘密値を差し替えて 1 回だけ送り直す。
  違う版なら秘密値を差し替えず、再送もしない。書きかけの回答が無ければ読み込み直し、あれば送信できないことと回答を控えてから読み込み直す案内を表示する。
  初期の版が空の旧配信では、秘密値を差し替えて 1 回だけ送り直す。
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
- `POST /api/sessions/<session_id>/estimate` は、現在の一覧に存在する状態不明の Claude セッションだけを推定する。provider の無い旧形式は既存の正規化で Claude として扱い、Claude 以外の provider は記録を読まず保存もしないで `422` を返す。存在しない ID は `404`、状態が不明でなければ `409` を返す。ID は `[A-Za-z0-9_-]` の 1〜100 文字に限る。
- Claude Code の会話記録の場所は、常駐サーバーが登録済みセッションの `cwd` と ID から `~/.claude/projects/<cwd の英数字以外を '-' に置換した値>/<session_id>.jsonl` として決める。画面からパスは受け取らない。解決したパスは `projects` の直下にある 1 階層のプロジェクトディレクトリ内に限る。
- 推定ではファイルの末尾 256KB だけを位置指定で読み、途中から読んだ場合は先頭の行を捨てる。assistant と user のうちサイドチェーンでない行を使い、会話本文は返さない。記録を読めない場合や対象行の形式が合わない場合は、推定不可として保存する。user の行の `content` は文字列のこともある。知らない種類の要素は推定に使わずに飛ばす。`isMeta` の user の行(スラッシュコマンドの出力など)は対象にしない。中断の行(`[Request interrupted` で始まる user の行)で終わる場合は `input` とする。長い cwd では Claude Code が記録の置き場の名前を縮めるので、場所が合わずに推定できないことがある。
- assistant の最後の行が `end_turn` で終わる場合、または `tool_use` を含まず stop reason も `tool_use` でない場合は `input` とする。user の行が最後なら `model`、それ以外の assistant の行なら `tool` とする。最後のツール名は末尾の読取範囲内で最後に現れる `tool_use` から求める。
- 推定結果はセッションごとにメモリーへ持ち、ターンの状態を確定するイベント(「状態」の項目)で消す。Notification などほかのイベントでは残す。読み取り中にイベントが届いて状態が分かったときは保存せず `409` を返す。結果を保存した後は `version` を進め、推定結果を応答と `GET /api/state` に含める。
- `POST /api/hidden-sessions` は `{action: "hide", session_id}` または `{action: "hide", session_ids}` で、一覧にあるセッションを状態にかかわらず外す。`session_ids` は ID を 1〜50 件含み、各 ID は `[A-Za-z0-9_-]` の 1〜100 文字に限る。知らない ID は無視し、1 件も一覧に無ければ `404` を返す。本文が仕様に合わない場合は `400` を返す。状態不明カードの「一覧から外す」とプロダクト見出しの「×」は同じ操作を使う。
- `{action: "clear"}` はすべて表示する。外した ID と時刻は `store.json` に保存し、セッションのイベントが届いたとき、またはセッションが終了扱いになったときに集合から削除する。`GET /api/state` では外したセッションに `hidden: true` と `hiddenAt` を付ける。
  `hiddenAt` は保存済みの `hiddenSessionUpdatedAt` である。
  時間経過による移動は画面の分類だけで行い、サーバーは外した集合から戻さない。

## 中断の検出

- Claude Code は利用者がターンを中断したときに Stop を送らないので、フックの状態は「作業中」「許可確認中」「許可待ち」のまま残る。会話記録には、中断の行(`[Request interrupted` で始まる user の行)が書かれる。
- 常駐サーバーは、セッションファイルを定期取得した後に、次をすべて満たす Claude のセッションだけ会話記録の末尾を読む。
  - フックの状態が「作業中」「許可確認中」「許可待ち」のいずれかである(ファイルで補った状態は対象にしない)。
  - セッションファイルの `status` が `idle` で、`statusUpdatedAt` がメインの最後の区切りのイベント(`agent_id` の無い UserPromptSubmit、Stop、SessionStart)の hookAt より新しい。バックグラウンドのサブエージェントのイベントの時刻とは比べない。
  - 前回読んだときの `statusUpdatedAt` と違う。同じ値なら読み直さない。会話記録を読めなかったときは記録せず、次の取得でもう一度読む。
    中断の行は `idle` より遅れて書かれることがあるので、末尾の行が中断の行でなく `statusUpdatedAt` より古いときは、`statusUpdatedAt` から 2 分の間は記録せずに次の取得で読み直す。
- 読み取りは sessionId ごとに同時に 1 つとする。記録の場所と末尾 256KB の読み方は、状態不明の推定と同じとする。
- 最後の対象行が中断の行で、その timestamp が最後の UserPromptSubmit の hookAt 以上なら、`hook_event_name` が `Interrupt` で `agent_id` の無いイベントを、その timestamp を hookAt として通常のイベントの取り込みに入れる。中断の行でなければ何もしない。Stop の取りこぼしは対象にしない。
- 状態を派生状態への直接の書き込みにしないのは、派生状態が全イベントから毎回作り直され、次のサブエージェントのイベントで消えるためである。合成したイベントは他のイベントと同じくメモリーにだけ置き、離席中の回答の配信の経路には流さない。

## サブエージェントの終了通知

- `TaskStop` などで止まったサブエージェントには `SubagentStop` が届かないことがあるので、常駐サーバーはメインの会話記録から終了の通知を読む。
- 読むのは、メインが止まっている(状態が「待機中(サブエージェント稼働中)」か「中断」)で、稼働中の Claude のサブエージェントがあるセッションとする。
  バックグラウンドの Codex に稼働中か終了未確認で結果を受けていない行がある場合は、メインの状態によらず読む。
  メインのイベント(`agent_id` を持たないもの)を受けて約 500ms 後に 1 回読み、その状態が続く間は 60 秒ごとに読み直す。サブエージェントのイベントでは読まない。
- 記録の場所と末尾 256KB の読み方は、状態不明の推定と同じとする。
- 対象の行は、`type` が `queue-operation`、`operation` が `enqueue` で、`content` が `<task-notification>` で始まるものだけとする。ツールの入出力や会話の本文に写った通知の文字列を、終了と取り違えないためである。
  enqueue の行を書かない古いバージョンの Claude Code では、通知を読み取れないので、手で「終了にする」を使う。
- 通知から `<task-id>`(`[A-Za-z0-9_-]` の 1〜64 文字)と `<status>`(`completed`、`killed`、`failed`、`stopped`)を読む。`stopped` は前のプロセスで終わらなかったバックグラウンドのエージェントの通知で、1 通に複数の `<task-id>` が並ぶので、すべてを読む。稼働中の Claude のサブエージェントに一致し、通知の時刻がそのサブエージェントの開始時刻より前でなければ、`SubagentStop` を合成して通常のイベントと同じ経路で処理する。

## バックグラウンドタスク

- provider が `claude` で `agent_id` の無い Bash または PowerShell の `PostToolUse` に `backgroundTaskId` があれば、メインのバックグラウンドタスクとして記録する。
  taskId、開始時刻、説明、ツール名、コマンドの要約を持つ。開始時刻は対応する `PreToolUse` の時刻とし、無ければ `PostToolUse` の時刻を使う。
  フックは説明を 200 文字まで、コマンドを既存のツール行と同じ改行の正規化と省略記号付きの 80 文字までにして送る。
- `pendingCodex` に載る Codex の起動、クロスレビュー、待ちの呼び出しは Codex の行に表示するため、この一覧には含めない。
  サブエージェントと provider が `codex` のセッションのバックグラウンドタスクも対象外にする。
- `UserPromptSubmit` の `backgroundTaskEnds` と、記録ファイルを読み直して作る `BackgroundTaskEnd` のどちらでも、一致する task-id の行を消す。
  終了状態は `completed`、`failed`、`killed`、`stopped` を扱う。
  task-id は起動ごとに一意なので、通知の時刻と行の開始時刻は比べない。フックの到着順によっては開始時刻が実際より遅れて記録され、短いタスクの通知を拒むためである。
  稼働中のタスクがある間は、メインが待機中でも記録ファイルの完了通知を読む。
  `TaskStop` の成功時の `stoppedTaskId` が一致したときと、`SessionEnd` でも行を消す。
- 「終了にする」は既存の `/api/closed-agents` と `closedAgents` の記録を使い、`background:<taskId>` を行の識別子とする。
  再投影でも閉じた行を除き、終了通知で行が消えたら閉じた記録も消す。
  常駐サーバーの再起動では、タスクと閉じた記録は失われる。保存形式は増やさない。
- メインが待機中で稼働中のタスクが N 件なら、状態を「待機中(バックグラウンドタスク N 件)」と表示する。集計では待機中として扱う。
  プロダクトごとの表示ではサブエージェントの後に「バックグラウンドタスク」の見出しと行を置き、種類ごとの一覧では経過時間の順に混ぜる。
  行にはラベル、セッションのタグ、「稼働中」、「終了にする」、経過時間、説明、ツール行を表示する。
  稼働中のタスクがあるセッションは、終了済みとして隠さない。
  更新の無いセッションの自動非表示からも除く。

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
| PreToolUse | `tool_name`、`tool_use_id`、入力の要約(80 文字まで。切り詰めた場合は末尾に「…」を付ける)。Agent ツールでは `tool_input.description`(200 文字まで)。メインセッションの `AskUserQuestion` では質問、見出し、選択肢の label と description、`multiSelect` も上限付きで送る。Bash と PowerShell では、コマンドの全文から見つけた Codex の起動の定義名を `codexLaunchDefinition` として送る(見つけ方は「サブエージェントのモデルと effort」の節) |
| PostToolUse、PostToolUseFailure | `tool_name`、`tool_use_id`。Agent ツールの PostToolUse では `tool_response.agentId`(256 文字まで)と `tool_response.resolvedModel`(160 文字まで)を送る。出力(PostToolUseFailure では `error` の文字列も)に含まれる Codex の監査行と結果行だけを送る。バックグラウンドへ移った Bash または PowerShell の `tool_response.backgroundTaskId` と、バックグラウンドタスクの出力ファイル(`<ID>.output`)を読んだ Read、`cat` などの Bash、`Get-Content` などの PowerShell、`TaskOutput` のバックグラウンドタスク ID も、決まった形(英数字、`_`、`-` の 64 文字まで)のときだけ送る。Codex の起動、クロスレビューの起動、`--wait` の Bash または PowerShell で、`tool_response.persistedOutputPath` が絶対パスでファイル名が `<英数字、_、->.txt` の形なら、出力の結果行の有無によらず、そのファイルの先頭と末尾の各 64KB から Codex の行を読み、出力から得た行より優先する。Claude Code は 30000 文字を超える出力の先頭だけを `stdout` に残して全文をこのファイルに置き、本物の結果行は出力の最後に出るためである(先頭に残った結果行は、最終報告に引用されたものでありうる)。`stderr` は見ない(bridge は Codex の行を標準出力へ出す)。PostToolUse の Codex の終了の判定は「サブエージェントのモデルと effort」の節に従う。メインセッションの `AskUserQuestion` の PostToolUse では、認識できた回答だけを送る。PR の URL を得た Bash または PowerShell の PostToolUse では、`tool_response.stdout` などから URL を出た順に抽出する。1 つのコマンドに `gh pr create` が複数あり、抽出した URL の数が実行回数と同じで、`gh pr create` 以外の `gh` を含まない場合は、2 件目以降を最大 9 件の `additionalPullRequests` に載せる。URL と `gh pr create` の対応は出た順でしか決められず、数が違うと作っていない PR を登録しうるためである。Bash の `commandCwd` は、1 件目では先頭の `cd <パス> &&`、2 件目以降では直前の `cd <絶対パス> &&` から解決する(変数展開、`~`、引用符なしの `\` や glob 文字、二重引用符の中の `\` を含むもの、4096 文字を超えるものは送らない)。PowerShell では `commandCwd` を送らない |
| Notification | 通知の種類、メッセージ(200 文字まで) |
| SubagentStart、SubagentStop | 共通の項目だけ |
| Stop、SessionEnd、UserPromptSubmit | 共通の項目だけ。UserPromptSubmit では、`prompt` が `<task-notification>` で始まるときだけ通知を全件読み、`status` が終わり(`completed`、`failed`、`killed`、`stopped`)のものの `task-id` と `status` を `backgroundTaskEnds` に載せる。開発者が入力に引用した通知を、終了と取り違えないためである。出力ファイルの読み取りは 8 件までとし、`output-file` が絶対パスで、ファイル名が `<task-id>.output` と一致する場合は、先頭と末尾の各 64KB から Codex の監査行、結果行、実行 ID の行だけを `codexOutput` に載せる。128KB 以下のファイルは全体を読む。出力ファイルが無い通知には `outputMissing` を付け、Codex の行を終了未確認にする。上限を超えて読まなかった通知と、出力を読めなかった通知は送らず、記録ファイルを読み直すサーバーの照合に任せる。出力に `waiting` があれば行を閉じてはならないためである。サーバーの照合は、セッションの一覧から `cwd` を得られなければ、フックが最初に送った `cwd` で記録ファイルを探す。サーバーが受ける `backgroundTaskEnds` は最大 32 件とする。プロンプト本文と `summary` は送らない |

`answer.js` から届く `PostToolBatch` は、常駐サーバーの受信時刻を使う状態イベントとして記録する。
サブエージェントの `PostToolBatch` は `agent_id` 付きで送り、状態イベントとしてだけ記録する。回答、知らせ、催促はメインにだけ渡すので、この要求には何も返さない。
入力の要約は、Bash なら改行と続く空白を空白一つに置き換えたコマンド、Read、Edit、Write ならファイルのパス、それ以外はツール名だけにする。
要約が80文字を超える場合だけ先頭79文字に「…」を付ける。画面幅による省略は CSS の `text-overflow: ellipsis` で行う。

PostToolUse の出力全文は送らない。
`event.js` は `tool_response` から `codex-agent: agent=` と `codex-agent: result=` の行だけを抽出する。
常駐サーバーは監査行からモデル、effort、`codex_home` を読み、結果行から実行結果を読む。

## 状態

セッションの `product` と Git ブランチは `cwd` から識別する。
ドライブ指定、バックスラッシュで始まる Windows パス、`//host/share` 形式の UNC は Windows として扱い、先頭が一つの `/` の絶対パスは POSIX として扱う。
Windows のルート相対パスは `\` で始め、相対パスは実行環境の規則で解決する。
プロダクトキーは Windows では大文字小文字を同一視し、POSIX では区別する。

セッションのイベントは `SessionEntries` に集め、2,000 件を超えたときに畳み込む。
次の畳み込みは、保持件数が 2,000 件または直前の畳み込み後の件数から 1,000 件増えた値の、大きい方を超えたときに行う。
削除するのは、開始と完了がそろい、メインなら最新の `Stop` または `UserPromptSubmit`、サブエージェントなら自身の最新の `SubagentStop` より両方の時刻が古いツール呼び出しだけである。
先頭、状態の区切り、質問、許可待ち、委譲、バックグラウンドタスク、モデルの情報、各サブエージェントの最初のイベントと最新のツール開始、最新の表示名とプロダクト、許可待ちの通知をまたぐ呼び出しは残す。
保持必須のイベントと区切りの無い実行中ターンは削除しないため、2,000 件は厳密な最大保持件数ではない。
ファイル不在で終了したセッションは、24 時間経過後の定期整理でイベントを先頭と Codex の再開イベントだけに縮め、終了時刻は再表示防止のため保持する。
1 日以上停止したセッションの途中のツールやサブエージェントは再開後に復元せず、登録を外した PR リポジトリの診断失敗とマージ済み head 補完試行の記録も削除する。
終了扱いにしたセッションのタスク出力とモデル観測のキャッシュも消す。
`SessionEnd` または一覧の不在による終了時に予約済み・実行中のモデル取得は完了まで保持し、最後の観測値を同じセッション ID の再開に引き継ぐ。
再開後の新しい観測値を、古い読み取り結果で上書きしない。

質問の副リスト、PR コマンドの呼び出し ID の集合、メインの最新の区切りと入力の時刻は受信時に更新する。
`DashboardState` の `verifyEntries: true` または `AGENT_COCKPIT_VERIFY_ENTRIES=1` で、全イベントからの再構築と表示および索引を照合する。
`npm test` と `npm run test:inprocess` はこの照合を有効にし、常駐サーバーでは既定で無効にする。

- タスク催促の記録はセッションごとにメモリーだけに持ち、`SessionEnd` で消す。
- イベントとイベントから組み立てるセッション状態はメモリーだけに持つ。MCP のタスクと判断事項、離席中の `AskUserQuestion` から作る判断事項、それらへの回答記録、完了タスク、外したセッション、削除時刻の `deletedSessions`、表示設定、クロスレビュー不要記録は `store.json` に保存する。判断事項の質問、状態、作成・更新・解決時刻、解決内容は `plans.decisions` に、回答と配信時刻は `decisionLifecycles` に置く。離席中の質問の `tool_use_id` と判断事項 ID の対応は `askDecisionBindings` に置く。この項目が無い旧形式の `store.json` は、結び付きが無いものとして読み込む。`crossReviewSkips` が無い旧形式は空として読み込む。表示設定は `GET /api/state` の `display` で配り、初回だけ画面が旧 `localStorage` の値をサーバーへ移す。`display.mode` は `product` または `kind` で、初期値は `kind` とする。`display.sectionOrder` は 5 種類のセクションを表示する順で、未知の値や重複を除いて `sinceSeen`、`judgment`、`prs`、`tasks`、`now` の順で不足分を補う。`display.hideFinished` は完了済みの情報を隠す設定で、既定は `true` で、古い保存ファイルでも `true` として補う。`display.mergeableCondition` は `operation`、`ci`、`cross-review` のいずれかで、旧形式では既定の `cross-review` として補う。テーマと「前回見てから」の表示モードはブラウザーごとの `localStorage` に残す。「前回見てから」の初期値は「表示する」とする。離席状態と期間は `{enabled, since, periods}` として `away.json` に保存し、起動時に読む。期間は `{start, end}` の数値ミリ秒で、離席中の期間の `end` は `null` にする。旧形式の `{enabled, since}` は、離席中なら `since` から現在まで、離席中でなければ期間なしとして読む。既読済みの期間、14 日の保持期限を過ぎた期間、50 件を超える古い期間を整理する。期間の記録だけが壊れているか食い違うときは、旧形式と同じく `enabled` と `since` から期間を作り直す。`enabled` と `since` が壊れているときは離席中ではない状態として扱う。
- 旧 `store.json` に残る `display.mergeAfterReviewDefault` は読み込み時に無視する。`mergeReservations` は登録セッション、リポジトリ、PR、方式、ブランチ削除の有無、予約時刻を `store.json` に保存する。旧 GitHub 自動マージ形式は予約として復元せず、そのまま捨てる。
- 表示設定 `display.importAppTasks` と `display.importAppTasksAsked` は真偽値で、既定はともに false とする。保存値の互換補正と確認の扱いは「タスクと判断事項」に記す。
- 表示設定 `display.idleHideMinutes` は更新の無いセッションを隠すまでの時間で、既定は 10 分、範囲は 5〜1440 分の整数とする。保存値が範囲外または整数でなければ読み込み時に 10 分へ戻し、書き込み時は拒む。
- 表示設定 `display.ghConcurrencyLimit` は GitHub CLI を同時に起動する上限数で、既定は 8、範囲は 1〜32 の整数とする。保存値が範囲外または整数でなければ読み込み時に 8 へ戻し、書き込み時は拒む。
- 表示設定 `display.awayAnswerWaitMinutes` は離席中の質問への回答を待つ時間で、既定は 3 分、範囲は 1〜30 分の整数とする。保存値が範囲外または整数でなければ読み込み時に 3 分へ戻し、書き込み時は拒む。
- `GET /api/state` は `{version, generatedAt, display, sessions, pullRequests, sinceSeen, away, persistence, update, doctor, appVersion, runtime, routing, integrations, uiVersion, installed, restartRequired, restartAvailable}` を返す。`update` と `appVersion` は「更新の確認」の節に記す。`uiVersion` は配信する HTML テンプレートのバイト列の SHA-256 先頭 16 桁で、秘密値と版の埋め込み前に計算する。
  本番では起動時に listen の前に HTML を読み、そのテンプレートと版を再起動まで固定する。
  起動時に読めなかった場合、`GET /` は読み込みに失敗している間 500 を返し、最初の成功時に固定する。
  `GET /` は固定したテンプレートへ秘密値と版を埋め込み、ディスクを読み直さない。
  `--dev` では `GET /` のたびに読み直し、版もディスクに追従する。
  画面はサーバーとの版の違いを検出し、書きかけが無ければ読み込み直す。
  `installed` は配置済みの `{version, commit, uiVersion}` で、HTML、JSON として読む `package.json`、Git の参照ファイルを同じ確認で観測する。
  各値は読めなければ `null`、最初の観測前は `installed` 全体を `null` とする。
  `restartAvailable` は再起動が有効で、開始から 60 秒以内でないときに `true` とし、状態の指紋にも含める。
  `restartRequired` は実行中と配置済みの両方が `null` でない項目に差があれば `true`、最初の観測前は `false` とする。
  `--dev` では `uiVersion` を比較しない。
  再起動待ちの間、画面は再起動で更新が反映されることを通知欄に表示する。実行中と配置済みのバージョンが異なる場合は配置済みのバージョンを示し、それ以外の差は更新したファイルが配置されたことを示す。
  状態不明のセッションには、推定済みなら `estimate`、一覧から外したなら `hidden: true` と `hiddenAt` を含める。`GET /api/away` は離席中だけを返す。`GET /api/tray` はトレイ用に `{permissionKeys, decisionKeys, awayEnabled}` を返し、PR や「前回見てから」の情報を計算しない。`version` は画面に出す状態が変わるたびに 1 増える。画面は 2 秒ごとに状態を取得する。
`POST /api/update/check` は今すぐのバージョンの確認で、「更新の確認」の節に記す。
- `GET /api/state` は計算済みの JSON 本文を、状態の指紋と有効期限が変わらない間だけ使い回す。
  指紋は `state.version`、PR の取得中の鍵の署名、整理後の離席状態、経路設定、更新確認の結果、画面の版、配置済みの状態、再起動待ちの判定、連携ツールの検出結果、ソースの状態から作る。
  配置済みの HTML、パッケージのバージョン、コミットは 5 秒、連携ツールは 10 秒を確認期限とし、状態の版が変わった場合も確認し直す。
  同時に要求が来たときは実行中の外部確認を共有する。確認中に版が変わっても待ち直さず、次の取得で確認し直す。イベントが続く間も応答を止めないためである。
  外部確認と離席期間の整理を済ませてから本文を同期で生成し、初回表示による既読時刻の初期化を含め、生成後の版で指紋を確定する。
- 本文の有効期限は生成から 30 秒以内とし、予約通知の消失、マージ履歴の保持期限、開いた離席期間へ未来の記録が入る時刻、離席期間の保持期限が先に来れば、その時刻で失効する。
  `ETag` は起動ごとの UUID と本文生成の連番を組み合わせる。
  期限で作り直す場合も新しい ETag を付け、再起動前の ETag は一致させない。
  `If-None-Match` が現在の ETag と一致するときは本文なしの `304`、一致しなければ JSON 本文付きの `200` を返す。
  応答の `Cache-Control: no-store` と安全のためのヘッダーは両方に付ける。
  画面は 2 秒周期を維持し、304 でも接続成功の時刻を更新する。
  前回の状態と ETag は切断中も保ち、通知の期限など時刻に応じた表示は前回の状態から描き直す。
- `AGENT_COCKPIT_VERIFY_STATE_CACHE=1` では、使い回す本文を再生成した本文と照合する。
  食い違いがあれば `state.cache.mismatch` を診断に記録し、新しい本文と ETag を返す。
  通常のテストでもこの照合を有効にする。
  `server.perf` の `stateCacheHitCount / stateCount` で使い回しの割合を確認できる。
- 識別子は `session_id`、`agent_id`、`tool_use_id` をそのまま使う。

## 保存

保存対象、書き込みの直列化と再試行、起動時の復元と期限切れの扱いは、この節と「表示設定」「マージ」の各節に記す。
通常の変更は最初の未保存変更から 500ms 後にまとめて書き出し、更新が続いても期限を延ばさない。
回答の配信状態など即時性が必要な記録と明示的な flush は、まとめ書きの期限を待たずに書き出す。

変更の適用とディスクへの保存は別の状態として扱う。
`AtomicJsonWriter` はファイルごとの最新の内容、要求版、保存済み版、失敗のコードと時刻を持ち、保存済み版が要求版に追い付くまで未保存分を保持する。
古い版の成功で新しい版の保存失敗を解除しない。
失敗後は 1 秒、5 秒、15 秒、以後 60 秒間隔で最新の内容を再保存する。
手動の再保存と正常終了時の flush は、別の変更が無くても未保存分を再試行する。

`GET /api/state` と回答の成功応答は `persistence` に `saved`、`pending`、`failed` の状態を返す。
未保存のファイルの論理名、版、エラーコード、失敗時刻だけを公開し、内容と保存先のパスは含めない。
画面は保存失敗を常時表示し、`POST /api/persistence/retry` で再保存できる。
この操作は画面用の秘密値と Origin を照合する。
回答など適用済みの変更は保存失敗でも成功応答とし、重複操作を促さない。
経路設定は保存成功後に採用するため、保存失敗時は要求を失敗として返し、再保存の内容も採用済みの設定へ戻す。
拒否した設定が自動再保存だけで有効になることを防ぐ。
外部の PR を変更する前の保存は失敗を呼び出し元へ返し、外部操作を止める。
画面からの再起動は先に保存を試み、未保存分が残る場合は理由を返して再起動しない。

| 状態 | 次の状態 |
|---|---|
| 保存済み | 変更を受けて未保存になる |
| 未保存 | 最新版の保存成功で保存済み、失敗で保存失敗になる |
| 保存失敗 | 再試行中も警告を保ち、最新版の保存成功で解除する |

セッションごとに次を持つ。

- プロダクト: 鍵はリポジトリのルートの絶対パス(Windows では小文字にする)、表示名はそのフォルダー名。`cwd` が `<ルート>/.claude/worktrees/<名前>` の下なら、`<ルート>` をリポジトリのルートとする。Codex の worktree(`cwd` が `<Codex のホーム>/worktrees/` の下)は、上へ探した `.git` のポインターの `gitdir:` が `<元のルート>/.git/worktrees/<名前>` を指し、その場所があるときだけ `<元のルート>` をリポジトリのルートとする。Codex のホームはサーバーの `codexHome`、`CODEX_HOME`、`~/.codex` の順で決める。畳めた結果は `cwd` ごとに 256 件まで控えて読み直さないので、worktree が消えた後も同じ鍵になる。起動時には、保存済みの PR 登録の製品も登録自身の `cwd` で同じ規則により畳み直し、畳めて鍵が変わる登録だけ書き換えて保存する。ポインターを読めない、形が違うときは `cwd` を鍵にする。開発者が手で作ったリンクした worktree は畳まない。ブランチ名は `cwd` から上へ探した `.git/HEAD` から読む。`.git` が worktree のポインター ファイルなら `gitdir:` の場所にある `HEAD` を読む。`ref: refs/heads/<名前>` はブランチ名、detached HEAD は短い SHA とし、読めなければ `null` にする。子プロセスは起動せず、ブランチ名の結果を同じ `cwd` ごとに 10 秒間キャッシュする。ブランチ名の読み取り対象は `.git` のポインターと `HEAD` に限り、どちらも 4 KB を上限とする。
- 最終イベント時刻: `lastActivityAt` にセッションの最新フック時刻を ISO 形式で持ち、メイン行の経過表示に使う。
- セッションファイル: `~/.claude/sessions/*.json` の `name` を題名に使い、有限の数値 `updatedAt` は ISO 形式にして `sessionFileUpdatedAt` に載せる。状態不明のセッションを隠す判定に使う。`status` は文字列の場合だけ先頭 50 文字を読み、文字列でない値は捨てる。項目が無い場合やファイルを読めない場合も動作を続ける。
- 状態: 作業中、待機中、待機中(サブエージェント稼働中)、中断、許可待ち、許可確認中、不明。ターンの状態は、agent_id の無い PreToolUse、PostToolUse、PostToolUseFailure、UserPromptSubmit、Stop、source が startup、resume、clear の SessionStart で確定する。許可待ち、許可確認中の順に優先し、それ以外で未確定なら「不明」にする。SessionStart の compact、Notification、サブエージェントのイベント、PostToolBatch では確定しない。イベント由来とセッションファイルだけの行のどちらも、「不明」でセッションファイルの status が idle なら待機中、対話セッションで busy なら作業中で補う。Stop を受けたときに稼働中のサブエージェントがあれば「待機中(サブエージェント稼働中)」にする。Interrupt(Codex のフックと、下の「中断の検出」が合成するもの)は Stop と同じ後始末をして、メインに中断の印を付け、状態を「中断」にする。稼働中のサブエージェントがあっても「中断」を優先し、許可待ちと許可確認中がそれより優先される。印は、後から届いたメインの UserPromptSubmit と、source が startup、resume、clear の SessionStart で外す。サブエージェントのイベントと、中断したツールの遅れた PostToolUseFailure などでは外さない。SessionStart の source が startup、resume、clear のときは、入力を待つ状態で始まるので待機中にし、メインの実行中のツールと許可待ちを外す。compact は自動の圧縮でターンの途中にも起きるので、直前の状態を保つ。SessionEnd を受けたら、hookAt 順に導出した結果に行が残らない場合だけ終了を記録して一覧から外す。SessionStart による再開より古い SessionEnd は捨て、回答と Stop の待ち、タスク催促の記録、実行時のキャッシュを終了の後始末で消さない。一度生きている一覧に載ったセッションファイルが 60 秒以上一覧から消えた場合も、不在による終了として一覧から外す。不在による終了は、セッションファイルが再び一覧に載ったときに解除する。SessionStart と、それ以外のイベントは、hookAt が終了判定時刻より後なら終了扱いを解除して受け付ける。SessionEnd による終了は解除しない。
- 実行中のツール: PostToolUse が来ていない `tool_use_id` ごとの、ツール名と要約と開始時刻。メインの Stop と UserPromptSubmit ではメインのツールを消し、PostToolBatch ではその時刻より前に始まった、同じエージェント(メインかサブエージェント)のツールを消す。拒否されたツールには PostToolUse も PostToolUseFailure も届かないためである。サブエージェントの PostToolBatch では、そのサブエージェントの、その時刻より前に始まった許可待ちも消す。メインの許可待ちは PostToolBatch では消さず、Stop と UserPromptSubmit で消す。
- サブエージェント: `agent_id` ごとに、`agent_type`、作業の説明、開始時刻、最後のツール、モデル、effort。
- `SubagentStart` が記録されていなくても、`SubagentStop` 以外のイベントで初めて届いた `agent_id` から行を作る。
  開始時刻はそのイベントの時刻とし、稼働中として扱う。
  `SubagentStop` 後のイベントでは行を作らず、稼働中にも戻さない。
  `codex:<tool_use_id>` の Codex 行はこの復元の対象外とする。
- サブエージェントを終了にするのは、`SubagentStop` を受けたとき、メインの `TaskStop` の `PostToolUse` の `tool_input.task_id`(無ければ非推奨の `shell_id`)が Claude のサブエージェントに一致したとき、終了通知から `SubagentStop` を合成したときである。
  どの場合も、そのサブエージェントの未完了のツールと許可待ちを消す。
  `SubagentStart` を受けたら稼働中に戻し、開始時刻をその時刻にする。
- `Agent` の `PostToolUseFailure` が `isInterrupt` を持つときは、その呼び出しに一意に結び付いた、稼働中でバックグラウンドに移っていない Claude のサブエージェントを終了未確認にする。
  メインの `Stop` と `Interrupt` でも、行のある同じ条件のサブエージェントを終了未確認にする。
  前面のサブエージェントは呼び出し元のターンより長く続かないためである。
  対象の未完了のツールと許可待ちを消し、その行が前面で起動した Codex も終了未確認にする。
  結び付けが無いか曖昧な呼び出し、行の無い agent_id、終了済みの行、バックグラウンドの行は対象にしない。
  遅れて届いた `Agent` の `PostToolUse` も hookAt 順で導出するため、`Stop` より前の応答ならバックグラウンドの行として稼働を保つ。
- タスク: `tasks` の全項目と、最後に書いた時刻 `tasksUpdatedAt`。
- 判断事項: AskUserQuestion の記録と MCP から登録した項目を `decisions` に持つ。計画に記録した判断事項の仮適用時刻は `plans.decisions.provisionalAt` に、回答記録で仮適用になった時刻は `decisionLifecycles.provisionalAt` に保存する。

## PR の表示

PR は Bash または PowerShell の `gh pr create`、GitHub MCP の作成応答、または MCP ツール `cockpit_add_pr` から登録し、`store.json` に保存する。
1 つのコマンドで `gh pr create` を複数回実行した場合は、出力の URL の数が実行回数と同じで、`gh pr create` 以外の `gh` を含まなければ、出た順にすべての PR を登録する。それ以外は最初の 1 件だけを登録する。
2 件目以降は、Bash で直前に `cd <絶対パス> &&` があれば移動先の cwd と product で登録し、推定できない場合と PowerShell はセッションの cwd と product を使う。
`gh pr create` が 1 回のコマンドと GitHub MCP ツールの応答では、URL が複数あっても最初の 1 件を登録する。
常駐サーバーは `gh` の保存済み認証を使い、60 秒ごとにリポジトリの状態を取得する。
レビュー状態と PR 群の再計算はリポジトリごとに直列化し、実行中の要求は次の 1 回にまとめる。
各要求は、要求後に開始する再計算の完了を待ち、その回の例外は待機した呼び出し元へ伝えるが、次の再計算は止めない。
レビュー記録の `lastReviewedSha` と `lastTriage.sha` のうち、ある SHA がすべて PR の base に含まれる場合は、前の PR の記録として未実施扱いにし、診断に `stale-record` を残す。`--uncommitted` のレビューは `lastReviewedSha` を据え置くので、片方だけでは判断しない。
base は PR のリポジトリに対応する remote の追跡ブランチを優先し、追跡 ref が無ければローカルの base を使う。
祖先関係の照合結果は 1 回の再計算で共有し、base を確認できない場合や記録の SHA が base に含まれない場合は記録を維持する。
squash マージでは元の SHA が base に残らないため、前の PR の記録を識別できない。
連携の有無の判定では、消えた cwd（`ENOENT`、`ENOTDIR`）も親を探索し、結果を10分間使い回す。
消えた worktree からたどった元のリポジトリの道具も検出に含めるためである。
実在する cwd は判定のたびに道具を確認し、既知の cwd から外れた項目はキャッシュから削除する。
定期取得が例外で失敗しても常駐サーバーは止めず、診断記録 `pr.refresh.failed` に残す。
登録と関連 PR のどちらにも、開いているか未確定の記録(`state` が `open`、`unknown`、`null`)が無いリポジトリは、最後に取得を始めてから 15 分経つまで定期取得を飛ばす。
初回の取得、登録の追加、確定操作の確かめ直しの取得(`refreshRepoFresh`)は間引かない。
`git push` または `gh pr` の後は、フックが送る `--repo` または `-R` の指定を優先し、指定がなければコマンドの `cd` 先、次にイベントの `cwd` から製品を決める。
指定したリポジトリ、またはその製品の `key` を持つ PR 登録があるリポジトリだけを `refreshRepoFresh` で取り直す。
対象リポジトリの取得が先に動いていれば、その完了後にコマンド後の状態を取り直す。
途中の `cd`、`git -C`、`--git-dir`、`--work-tree`、別々のリポジトリを指す複数の対象を含むコマンドは、フックが `refreshScopeUnknown` を付け、全体を取り直す。
取り直すリポジトリが決まらないとき(製品は決まってもその `key` の登録が無いときを含む)も全体を `refreshAfterCommand` で取り直す。下位のフォルダーと、`.claude/worktrees` の規則にも Codex の worktree 条件にも当てはまらない worktree の `cwd` は、登録の製品と `key` がずれるためである。
全体の取り直しは 5 秒に 1 回までにまとめ、その間に来た分は間隔の明けに 1 回だけ取る。先に動く取得は、終わるのを待ってから取り直す。
全体の取り直しでは、開いている PR が無いリポジトリは 60 秒に 1 回まで間引き、間隔が足りずに飛ばしたリポジトリは間隔が明けた時点の取得を 1 回だけ予約する。
確定操作の確かめ直しの取得は、その中で呼ぶ gh もすべて待ち行列で優先する。
同じリポジトリの取得が先に動いていれば、それを待つ間、そのリポジトリの gh を優先に引き上げる。
間引いたリポジトリの登録と表示は残し、登録と関連 PR が無くなったリポジトリの表示は従来どおり消す。
`PullRequestTracker.execute` を通る `gh` は表示設定 `display.ghConcurrencyLimit` の本数までとし、残りは待ち行列に入れる。上限は払い出しのたびに読み直す。下げても実行中の `gh` は止めず、実行数が新しい上限を下回ってから次を起動する。
開発者が画面で確定したマージ、base の付け替え、ブランチの削除とその結果の確認は、定期取得より待ち行列で優先する。
`gh` の 20 秒の期限は、待ち時間を含めず、起動してからの時間に掛ける。

ダッシュボードでマージした後の取り直しも、先に動いている取得の完了後に新しく取得する。
マージまたはクローズを登録に記録するたびに、メモリー上のリポジトリの世代を進め、その PR に記録した世代を保持する。
取得開始時に控えた世代より後の記録がある PR を除いたオープン一覧を、登録の所属更新とリポジトリの状態の置き換えに使う。
同じ取得で得たほかの PR の更新は反映する。

base と head の対応から関連するオープン PR を積み上げる。
レビューの記録の評価と各入口の方針は `src/shared/review-evaluation.js` に集める。
評価は保存せず、PR の取得とローカル記録の読み直しのたびに導出する。
画面へは生の `crossReview` を渡さず、`review = { evaluation, mergeCondition, display, reservation }` を渡す。
GitHub の承認状態は `githubReview` に分ける。

| 項目 | 入力、結果と優先順位 | 利用する入口 |
|---|---|---|
| 入力 | `record` は `selectCrossReview` で選んだ生の記録。`undefined` は未登録、`null` は記録なし、`unavailable` は確認不能、`notRequired` と `source: 'tool-absent'` は道具なし。`skip` と `deferral` は保存済みの不要と保留、`headSha` は PR の現在の head。`afterConvergence` はサーバーが分類した収束後の base 取り込み | `recalculateReviewGroups`、`selectCrossReview`、`mergeCandidate` |
| head と記録 | `headKnown` は 40 桁か 64 桁の完全な SHA か。`record` は `unregistered / none / unavailable / tool-absent / recorded`。`atHead` は `converged / halted / fixing / in-progress / stale`。SHA は小文字で比較する | `evaluateReview` |
| 今の結論 | `latest = { round, outcome, sha }`。triage と記録の round が同じときだけ outcome を採用し、それ以外は null と reviewedSha を使う。`rounds` は往復、上限、非対応数。`reviewedSha` と `conflict` の証拠も残す | `evaluateReview` |
| head の範囲 | `covered` は head 不明なら `unknown`、今の head の記録か判断があるか、収束後の分類が clean なら true。`pushedAfterConvergence` は今の往復の収束 SHA と現在の完全な head が異なるときだけ true。`awaitingConclusion` は往復が 1 以上で、以前の往復にだけ結論があるか、結論が無く記録の SHA が今の head と同じ場合の表示材料。札と待ち理由で結論の未記録と記録のコマンドを示す | `evaluateReview`、`reviewDisplay` |
| 判断の重ね合わせ | `decision = { kind, source, reason, next }`。道具なしは不要。現在の head の保留は、競合がなく atHead が stale のときだけ重ねる。現在の head の不要は atHead が converged でないときだけ重ねる。結論、往復、競合の証拠は重ね合わせても残す | `evaluateReview` |
| マージ条件 | 保留 → 不要 → 競合 → 確認不能 → 今の結論の順。不要は競合があっても met、保留と未登録は待つ。収束後の分類が clean なら met、resolved なら「競合の解消の確認待ち」、other と unknown は「クロスレビュー後に push あり」。CI の待ちは利用側で結合する | `mergeConditionReview` → `mergeConditionWaits`、`mergeablePullRequestCount`、画面の条件切り替え |
| Stop の催促 | 完全な head が分かり、判断と競合がなく、記録なしまたは recorded で stale のときだけ催促する。clean は催促せず、resolved は解消の差分だけのレビューか `cockpit_skip_review` を案内する | `reviewReminderNeeded` → `missingReviewRecords` |
| 予約のレビュー | 保留は wait `review-deferred`、競合は wait `review-conflict`、不要は wait `review-required`、今の往復の halted は cancel `review-halted`。次に非収束(前の往復の収束を含む)、head 不一致、収束 SHA の欠けを待ち、満たせば merge と `matchSha = latest.sha` を返す | `reservationReview` → `reservationMergeInput` |
| 予約の外側の条件 | 保留、競合、halted の取消を先に評価し、マージ先変更、残りのレビュー条件、CI、GitHub 承認、操作条件の順に確かめる。freshCandidate で取り直す前後に評価し、収束 SHA を `--match-head-commit` に使う | `reservationMergeInput` |
| 表示 | 保留 → 不要 → 競合 → 確認不能 → 今の結論の順で札と行を作る。不要の記録が収束の後の head に付いたときは、札を「収束後に不要と記録 (収束 <SHA>)」にして往復の数を残す。収束の無い head への不要だけを「レビュー不要」とする。古い head の fixing と halted も結論を表示し、覆っていなければ未記録の案内を添える。clean と resolved は下の分類表の札を表示する。head 不明は「head を確かめられない」 | `reviewDisplay` → `attachReviewState`、画面の `crossReviewLine` |
| 予約の表示 | 待ち文言は同じ評価から作る。不要の記録は予約マージを動かさないので、収束待ちではなく「レビュー不要の記録では収束後マージは動かない」と出す。clean は「base の取り込み後の head では収束後マージは動かない。手でマージする」と出す。道具なしには予約チェックを出さず、保存した不要には出す。既存の予約は出所によらず取り消せる | `reservationReviewDisplay` → 画面の `pullRequestReservationWaitReasons`、予約チェック |

収束 SHA と head が違う場合、サーバーは登録の worktree で `afterConvergence` を分類する。
PR のリポジトリと照合した remote の `refs/remotes/<remote>/<base>` だけを base とし、ローカルの base は参照しない。
SSH の別名ホストなどで照合できる remote が無いときは、道具の有無の判定と違って全 remote を候補にせず、`unknown` とする。別のリポジトリの base で判定すると、レビューを経ていない変更でマージの条件を満たすためである。
第 1 親の鎖が収束 SHA に着き、途中がすべて merge で、ほかの親が base の追跡ブランチの祖先である場合だけ、base の取り込みとする。
追跡ブランチは fetch まで古いので、下の段が base へマージされた後は、その段の head を取り込んだ merge が追跡ブランチの祖先にならない。
そのため、今の PR の base と同じブランチへマージ済みと GitHub が返した PR のうち、cockpit がマージコミットでマージしたと記録した PR の head(完全な SHA だけ、新しい順に `MAX_MERGED_BASE_HEADS` 件。サーバーが持つ一覧を使い、gh は呼び直さない)の祖先でも、base に入っているとみなす。
squash と rebase のマージ、方式の分からない GitHub での手のマージは使わない。head の途中のコミットが base に入らないので、取り消された変更を含む取り込みを `clean` にしうるためである。
手元に無い head は、その候補だけを外す。追跡ブランチも、マージ済みの head も祖先と確かめられなければ `other` とし、追跡ブランチが無く、マージ済みの head でも確かめられなければ `unknown` とする。
探索は `MAX_AFTER_CONVERGENCE_MERGES` で制限し、上限超過や通常のコミット、base 以外の取り込みは `other` とする。
各 merge の `git show --remerge-diff --format= --numstat` がすべて空なら `clean`、差分があれば `resolved` とし、ファイル数と追加行数と削除行数を merge ごとに合計した規模を返す。
コミット不足、git の失敗や時間切れ、remerge-diff が扱えない merge は `unknown` とする。
分類と merge 数、差分の規模、確認不能の理由は診断に残す。

| 収束後の分類 | head の範囲 | マージ条件 | 表示 | 予約の表示 |
| --- | --- | --- | --- | --- |
| clean | 競合なしの base 取り込みだけ | レビュー部分を満たす | ok「収束 <SHA> の後に base を取り込み(競合なし)」、往復は残す | base の取り込み後の head では収束後マージは動かない。手でマージする |
| resolved | 競合を解いた base 取り込みだけ | 競合の解消の確認待ち | warn「競合の解消の確認待ち (N ファイル、+A −D)」、解消の差分だけのレビューか不要の記録を案内する | 現在の head の収束待ち |
| other / unknown | それ以外 / 確認不能 | クロスレビュー後に push あり | 収束の後に変更あり | 現在の head の収束待ち |

不要と保留の優先順位は分類を追加しても同じとする。
resolved の head に不要を記録すると「収束後に不要と記録 (収束 <SHA>)」となる。
予約マージは clean でも収束 SHA と head の不一致を待ち、実行条件は緩めない。

モックは評価モジュールの本文を印の間に埋め込み、テストで原本との一致を確かめる。
モックの例示用の短縮 SHA は評価の入力で完全な SHA に広げ、画面では短縮形を使う。

セッションが登録したオープン PR で、worktree に `tools/cross-review.js` はあるがそのブランチの記録が無いもの(状態ファイルがまだ無いものを含む)は「レビュー未実施」とする。`tools/cross-review.js` が無い worktree の PR は、PR の head のコミットにも無いことを `git ls-tree` で確かめて「レビュー不要」とする。head のコミットにあれば、道具がある worktree と同じく状態ファイルを読む。worktree が道具の無い別のブランチへ切り替わっても、記録を「不要」で隠さないためである。head のコミットが手元に無いなどで確かめられないときは、PR の base ブランチを remote の追跡ブランチ(`<remote>/<base>`)のコミットで確かめ、どれかにあれば道具を使うリポジトリとする。見る remote は PR のリポジトリと一致する GitHub の remote で、GitHub の remote と判定できるものが無い(SSH の別名ホストなど)ときはすべての remote とする。ローカルの `<base>` は、PR のリポジトリと内容が違うことがあるので見ない。head と base のどちらでも確かめられないときは「確認できない」とする。状態ファイルの有無ではなく道具の有無で判定したまま、「レビュー不要」は道具が無いと確かめられたときだけにし、head を取り込んでいないだけで、使わないリポジトリの PR を「確認できない」にしないためである。登録の無い関連 PR とマージ済み PR にはレビュー行を出さない。状態ファイルの有無ではなく、追跡される `tools/cross-review.js` の有無で連携を判定する。
状態ファイルの本文の正規化と診断は `src/server/cross-review-state.js` の `parseCrossReviewState` が担う。
上流の ai-cross-review の固定 revision の検証データを `test/fixtures/cross-review-state/` に置き、契約テストで読み取り結果を確かめる。
`src/server/pull-requests.js` の `readCrossReviewState` は、ファイルの有無と読み取り失敗、道具の有無、古い記録かどうかの判断と収束後の取り込みの分類を担う adapter とする。
JSON の構文誤りは取得不能とし、診断のうち対象ブランチ自体、`round`、`dismissed` 自体の不正も取得不能とする。
それ以外の診断では正規化した値を使い、不正な `lastTriage` は `null`、非対応の件数は文字列でない要素と空白だけの要素を除いた数とする。
`lastReviewedSha` は前後の空白を除き、完全な SHA なら小文字、それ以外は `null` とする。
対象ブランチの記録が無ければ `null` を返す。

状態ファイルは、登録の `cwd` の worktree に加えて、同じリポジトリのほかの worktree からも探す。PR の head のブランチをチェックアウトしている worktree は記録の有無を問わず候補にし、それ以外の worktree はそのブランチの記録を持つときだけ候補にする。スタックを 1 つの worktree で積むと、下の段のブランチはどこにもチェックアウトされないためである。
登録の `cwd` が消えたときは、親へ上って見つかる worktree の根で下の remote の照合をしてから、PR の head のコミットに `tools/cross-review.js` があるかを確かめる。head のコミットを確かめられなければ、上と同じく base ブランチのコミットで確かめる。無ければ「レビュー不要」とし、あるか、どちらも確かめられなければ「確認できない」とする。消えた worktree の状態ファイルは読めないためである。このとき見つけた根も、ほかの worktree と同じ規則の候補にする。`git worktree list` で `prunable` の worktree(フォルダーが無い)は候補にしない。
登録や worktree の候補が複数あるときは、同じ worktree のパスを重複から除き、全登録の候補を集めてから一度だけ選ぶ。
別リポジトリの cwd から一致する checkout を探す経路も同じ選択を使う。
往復の記録、記録なし(レビュー未実施)、確認できない、道具なし(レビュー不要)の順に選び、今の head の記録を古い head の記録より優先する。
今の round の triage が今の head に対する結論なら、その outcome で分類する。
今の round の triage が無く、reviewedSha が今の head と一致する記録は進行中とする。
今の head の converged と halted または fixing が混在するときは、独立した worktree の round では前後を決められないので競合とする。
進行中との組み合わせは、進行中の round が収束した round より大きいときだけ競合とする。
競合のない同順位の記録は、今の head の収束を優先し、次に今の head のほかの記録、round の降順、worktree のパスの昇順で選ぶ。
競合の代表は halted、fixing、進行中、converged の順とし、同順位なら round の降順、worktree のパスの昇順にする。
`review.evaluation.conflict` に今の head の記録元を `{worktree, round, sha, outcome}` の一覧で残す。
競合、確認不能、道具なし、不要の重ね合わせと画面の案内は、上の評価と方針の表に従う。
登録の `cwd` と製品は、`commandCwd` があればそこから決める。
`cockpit_add_pr` は任意の `cwd` に checkout の絶対パスを受け取り、常駐サーバーへセッションの `cwd` と分けて `prCwd` として送る。
常駐サーバーは指定されたフォルダーを読めて、その remote が PR のリポジトリと一致するときだけ、登録の `cwd` と製品をそこから決める。
同じセッションで同じ PR を登録し直した場合も、この照合に通れば `cwd` と製品を付け直し、登録時刻などの既存の情報は保持する。
指定が無いか、読めないか、remote が一致しないときは、登録済みの場所を保持し、新規ならセッションの `cwd` を使う。
cwd の worktree の GitHub の remote のどれも PR のリポジトリと一致しないときは、クロスレビューを「確認できない」とし、その worktree をほかの worktree の候補からも外す。remote が読めないときや GitHub の remote が無いときは、この照合をしない。
登録の `cwd` の remote が不一致のときは、同じリポジトリ(owner/repo)の PR のほかの登録から、remote が一致する checkout を探す。
その checkout と `git worktree list` にある worktree を候補にし、それぞれの remote が PR のリポジトリと一致することを照合してから、状態ファイルを読む。
head と base の道具の有無も、見つけた checkout で確かめる。
兄弟のフォルダーなどのファイルシステムの走査は行わず、候補が見つからなければ「確認できない」のままにする。
表示設定 `display.mergeableCondition` は「マージ操作が可能」「CI が成功」「現在の head のクロスレビューが収束または不要」の各条件を選ぶ。
既定は最後の条件まで求める。
レビュー条件は上の表の `mergeConditionReview` を使い、操作可否は CI とクロスレビューを含めずに判定する。
選択条件を満たすかどうかでカードの緑表示、待ち条件と件数を決める。
操作可だが条件が残る場合も、確認欄に警告を出して開発者が実行できる。
クロスレビューの保留は `cockpit_defer_review` で owner、repo、number、headRefOid、reason、next(次の作業)を必須として受け付け、`store.json` の新しいキー `crossReviewDeferrals` に保存する。
キーが無い旧形式は空として読む。
登録元のセッションと最新の head を照合し、head の変更と PR 登録の保持期限で無効にする。
同じ head の不要記録と保留は、MCP と画面のどちらから記録しても後からの記録だけを残す。
保留を重ねる条件と予約の待ちは、上の評価と方針の表に従う。
レビューの往復と halted、waiting の判断事項は既存の状態から導き、保存する状態を増やさない。
通信不能は観測できないため、MCP の失敗応答で完了報告に書く内容を伝える。記録の前に拒否されたとき(入力不備、登録や head の不一致、PR の取り直しの失敗、常駐サーバーに届かない)は未記録であることと理由を書くよう伝える。時間切れ、応答の喪失、常駐サーバーの例外(500)と、記録を反映した後に保存を確かめられないとき(500)は、記録できたかを確かめられなかったとして、ダッシュボードで確かめるよう伝える。
クロスレビュー不要記録は PR の owner/repo/番号、head SHA、理由を `store.json` の `crossReviewSkips` に保存する。MCP の `cockpit_skip_review` は登録元セッションからのみ記録でき、ダッシュボードの操作は起動時の秘密値と必須 Origin を照合して記録または取り消す。どちらもサーバーが最新の PR head を取り直して照合し、別の head には適用しない。head が変われば記録を無効にし、PR 登録の保持期限に合わせて削除する。
不要の記録がある PR でも状態ファイルを読み、上の評価と方針の表に従って収束を優先する。
メインセッションの Stop 開始時だけ、登録先 repo の進行中の再取得を待ってからローカルのレビュー記録を読み直し、現在の head の記録が無い PR があればクロスレビューの実施、不要または保留の記録を促す。
`stop-start` は判定を待たずに generation を返し、判定は最初の `stop-poll` または `stop-check` で待つ。`stop-start` のフックは 1 秒で打ち切るため。
待機と読み直しの合計上限は 3 秒とし、失敗や時間切れでは催促せず Stop を続ける。`stop-check` のフックは、この上限に 2 秒を足した時間まで応答を待つ。Claude の `stop-poll` のフックは、この上限と long-poll の上限を足した時間まで待つ。
催促するレビュー状態は上の表の `reviewReminderNeeded` に従う。開発者の回答を待つ判断事項（waiting）があるセッションには催促しない。推奨を仮に適用した判断事項（provisional）は自走中に残り続けるので、抑止の条件にしない。
セッション内で開始した Codex クロスレビューまたは `review-claude` が実行中で、開始から 60 分以内なら催促を見送る。異常終了などで実行中の状態が残っても、開始から 60 分を過ぎれば催促する。
催促は Stop の generation に紐づけて返す。通常の通知キューには入れず、待機中の再取得完了やポーリングでは再判定しない。
ACK は配信済みとして数えるだけで、記録を完了したことにはしない。
最後の配信の後に UserPromptSubmit が届くか、配信から 30 分以上たった Stop で再び催促し、同じセッション、PR、head で 3 回までにする。
同じターンでは繰り返さず、ACK の無い配信は次の Stop で再送する。
上限後は block せず、画面で未記録と次の操作を示す。
セッション終了で配信の記録を消す。
本文に head SHA は含めず、現在の head と理由を `cockpit_skip_review` に渡すか、次の作業も添えて `cockpit_defer_review` で保留するよう促す。
ツールの成功を確かめてから完了報告し、失敗時はツールの応答に従って、未記録であることか、記録を確かめられなかったことを理由と一緒に報告する。
診断ログは配信した PR ごとに repository、番号、セッション ID の先頭 8 文字だけを残す。
MCP ツールは `POST /api/sessions/:session/prs`、カードの設定と取り消しは `POST /api/pull-requests/review-skip` を使う。画面からの要求は `uiSecret` と `validRequiredUiOrigin` を通し、登録キーと表示中の head SHA が最新状態と一致することを確かめる。
各プロダクトの PR 群には、リポジトリ全体の失敗をまとめた `error` とは別に、そのプロダクトのオープンの PR を数えきれていないことを示す `openStateUnknown` を付ける。PR の一覧を取得できなかったときと、そのプロダクトが登録した PR の状態を確かめられなかったときに真にする。
取得できないリポジトリ(存在しないリポジトリの PR を登録した場合など)のエラーは、原因の登録が残る限り出続ける。そのため、PR 群に、状態が `unknown` の登録と関連 PR の件数 `unregisterableCount` を付け、画面はエラーの枠に「このリポジトリの登録を外す」を出す。`POST /api/pull-requests/repository/unregister` は、秘密値と必須 Origin を照合したうえで、そのリポジトリの `unknown` の記録だけを消す。`open`、`closed`、`merged` の記録、マージの履歴、予約は消さない。
登録が保持期限などで消えたプロダクトの PR 群は、次の取り直しで配らなくなる。登録と関連 PR が 1 件も無くなったリポジトリは、取得した状態ごと捨てる。
積み直し待ちは、各オープン PR の base から同じブランチ名を head に持つオープン PR、次にマージ済み PR をたどって compare の base を決め、マージ済み PR の head SHA がその差分に残っているかで判定する。親とみなすのは、head SHA が差分にあり、base が比較経路に直接一致する PR、または候補 PR の後に同名 head の PR がマージされ、その base の鎖を比較経路までたどれる PR である。一覧が完全な場合は直接親と確認できた間接親を合わせ、マージ時刻が最も古い候補を選ぶ。同秒の同名headがある場合は順序を確定せず、確認不能とする。不完全な一覧では直接親だけを確定できる既存の扱いを維持する。間接探索は既定ブランチで止め、同名再利用の経路が複数成立する場合や一覧が不完全な場合は確認できない扱いにする(詳細は[計画書](../handover/2026-10-02.md)の「積み直し待ちの判定」)。
マージ済み PR と同じ名前のブランチが残り、現在の head がマージ時の head SHA と異なる場合、または `mergedHead.branchKept: true` で残す選択が記録されている場合は、その生きているブランチを compare の base にして追跡を止める。
既定ブランチに行き着かない場合は、行き着いたブランチとの差分を使う。
compare の失敗や 250 件超で全件を確認できない場合はマージ不可とする。
判定の詳細は[計画書](../handover/2026-10-02.md)の「積み直し待ちの判定」を正本とする。
ダッシュボードから即時マージする口は、秘密値と必須 Origin を照合し、登録済みスタックの一番下と現在の head をサーバーで確かめる。`gh pr merge` には画面で確認した `--match-head-commit` を渡す。PR 行の予約チェックからは画面で見た head、方式、ブランチ削除の有無を予約口に送り、条件がそろっていればクロスレビューの最後の `converged` 記録の SHA を `--match-head-commit` に渡してその場でマージする。個別 PR の確認欄は即時マージを実行し、スタックの確認欄は全構成員の一括予約を確定する。
予約チェックの表示は上の評価と方針の表に従う。
子 PR の base は head ブランチを削除する場合(自動削除を含む)だけ付け替え、残す場合と fork では付け替えない。
子の base を変える外部操作より先に、子と親の PR 番号および変更前後の base を `completed: false` で `store.json` に保存し、保存完了後に `gh pr edit` を呼ぶ。edit が成功した後に `completed: true` を保存する。保存に失敗した場合は edit せずマージを失敗させる。`completed: false` の記録は親への依存として残すが、表示する base と `retargetedFrom` には使わない。`completed` が無い旧形式の記録は完了済みとして扱う。retarget 記録を持つ子は、完了状態にかかわらず、親 PR が取得済みのマージ候補で `MERGED` と確認されるまで、即時・予約の両方でマージしない。マージできない理由には「親 PR #N のマージ確認待ち」を出す。親が open 一覧に無いだけ、未マージで closed、または取得失敗だけでは待ちを解除しない。親が未マージで closed の場合は再オープンしてマージする。確認後は現在の head、レビュー、CI、積み直し条件を再評価する。
`mergedHead` のない旧マージ済み記録は refresh ごとに最大 5 件を `gh pr view` で補完し、通知を再発火させず、失敗を画面へ出さずに同じプロセス内で 1 回まで再試行する。
表示設定 `pullDefaultBranchAfterMerge`（既定 false）がオンなら、既定ブランチへのマージを検出した後、そのブランチをチェックアウトしているローカルの作業ツリーを非同期で更新する。
登録済み PR の cwd から同じリポジトリの worktree を探し、追跡しているファイルに未コミットの変更があるものは更新しない。追跡していないファイルは見ず、取り込みと衝突するときは fast-forward の失敗として知らせる。
一致する remote から作業ごとに一意な一時 ref(`refs/agent-cockpit/`)へ取得して SHA を固定し、ブランチと変更の有無を確かめ直してから、その SHA を `git merge --ff-only` で取り込む。一時 ref は最後に消す。`FETCH_HEAD` は開発者の fetch で書き換わるので使わない。取得を待つ間のブランチの切り替えで別のブランチを進めないためである。同じ作業ツリーへの更新は直列化する。
初回の取得で検出したマージは、リポジトリの状態の保存より前に届くので、取得した既定ブランチをイベントで渡して判定する。
結果はマージ通知と同じセッション群へまとめて知らせ、更新の失敗でマージ処理を失敗させない。

取得と判定の詳細は[計画書](../handover/2026-10-02.md)の「マージの手順(常駐サーバー)」に記す。

## 前回見てから

プロダクトごとの既読時刻と CI 失敗への遷移時刻を `store.json` に保存し、既読後で、離席中の期間に起きたタスク完了、PR 作成、仮適用した判断、CI 失敗、PR マージを新しい順に表示する。
離席中の期間は開始時刻と終了時刻の両方を含む。
離席中なら終了時刻を現在時刻とし、離席解除後も既読にするまで期間と変化を残す。
既読の口は `POST /api/seen` とし、`uiSecret` と `validRequiredUiOrigin` を照合する。
初回表示時はその時点を既読時刻にする。
マージの項目は PR の登録に記録されたマージ時刻からも作る。
既読の時刻は、そのプロダクトを参照する記録が無くなったときに消す。
「前回見てから」の表示設定は画面だけで持ち(`localStorage`)、値は `show` と `hide` とする。`show` は離席中かどうかにかかわらず `sinceSeen` を表示し、`hide` は表示しない。保存済みの `always` と `away` は `show` に、`never` は `hide` に読み替え、未設定や不明な値は `show` とする。常駐サーバーは設定にかかわらず、離席中の期間に起きた変化の `sinceSeen` を返す。既読時刻がないプロダクトの起点は従来どおり初回表示時刻とする。規則は計画書の決定「「前回見てから」の表示の設定」を正本とする。
詳細は[計画書の「許可待ち、待ち時間、前回見てからの変化」](../handover/2026-10-02.md#許可待ち待ち時間前回見てからの変化)を正本とする。

## ダッシュボードからの PR マージ

書き込み口は `POST /api/pull-requests/merge`、`/reserve`、`/cancel-reservation` とする。
いずれも `uiSecret` と `validRequiredUiOrigin` を照合し、PR の記録キーから owner/repo を解決する。
即時マージは画面の SHA、許可方式、スタック最下段、現在のマージ操作条件を gh で取り直して確かめる。予約は方式とブランチ削除の有無を保存し、GitHub の自動マージ予約 API は呼ばない。同じリポジトリの即時マージと予約は到着順に待ち、リポジトリ、PR の順にロックを取り、一件ずつ実行する。予約確認もリポジトリ、PR の順にロックを取る。予約確認自身の処理中に再入した確認は重複実行せず、手動操作がリポジトリロックを保持または待機している場合は確認を保留し、手動操作の待機列が空いた後に再評価する。収束後マージの予約中でも即時マージを拒まない。一括予約中の PR への個別マージは、実行全体を中止するまで拒む。成功後はマージ検出処理が予約を消し、失敗した場合は予約を残す。
`/reserve` は保存直後にも同じ PR の予約条件を確認する。条件がそろっていれば、クロスレビュー収束記録の SHA を `--match-head-commit` に指定してその場でマージし、即時マージと同じ結果(`merged`、`branchDeleted`、`queued`、`warning`)を応答する。条件がそろっていなければ `reserved: true` と予約を応答する。
リポジトリの状態を取り直すたびに予約を確認する。
レビューの wait、cancel、merge と外側の条件の順序は「PR の表示」の評価と方針の表に従う。
サーバー停止中に条件がそろった場合は起動後最初の PR 状態取得で処理する。
画面からの予約取消と PR のクローズでもローカル予約を消し、画面と作成元セッションへ知らせる。
予約取消の知らせは記録時刻から 1 分で画面から隠し、常駐サーバーは期限を過ぎた知らせを配らない。
旧形式の GitHub 自動マージ予約は読み込み時に捨て、GitHub 側の取消 API は呼ばない。
マージ履歴、予約、リポジトリごとの前回方式は `store.json` に保存し、マージ履歴は 24 時間で消す。予約取消の通知はメモリーに持ち、該当 PR グループの `reservationNotices` で画面へ配る。
`delete_branch_on_merge` が有効なリポジトリではスナップショットに `autoDeleteBranch` を含め、確認欄に GitHub がブランチを削除することを示す。常駐サーバーによる削除では、マージした PR の head SHA とリモート ref を取得して照合し、一致する場合だけ GitHub GraphQL の `updateRefs` を `beforeOid` に期待 SHA、`afterOid` にゼロ SHA、`force` に `false` を指定して実行する。GitHub は参照の更新を原子的に適用し、`beforeOid` が一致しない場合は削除しない。ref が既に無い場合は削除済みとして扱い、警告を出さない。head SHA が変わった場合は削除を見送り、警告をマージ履歴・通知・画面へ残す。削除に失敗した場合も警告を残し、削除済みの場合だけ `branchDeleted` を真にする。
マージ操作の意図は gh の起動前に保存する。
gh が数値の終了コードを返し、強制終了もシグナルも無い場合、または gh の起動自体に失敗した場合は、意図を消して失敗を返す。
期限切れ、シグナル停止、出力上限超過、分類できない例外と、成功後の状態取得失敗は結果不明とし、意図を残して「マージの結果を確認できませんでした。次の取得で確かめます」と返す。
gh pr merge の呼び出しからマージ結果の処理完了までは専用の実行中の印を持ち、並行取得で同じ PR のマージを検出しても、登録の更新とマージ通知を行わず次の取得に委ねる。
後の取得でマージを検出した場合、保存した意図の head がマージされた head と一致すれば、その意図を方式、削除、積み直し通知、予約マージ結果に使う。
ブランチを削除する際は、リモート ref の head を照合する。
取得のたびに、オープンの PR に残る意図を突き合わせる。
このプロセスでマージを実行中でなく、取得開始時刻が意図の createdAt に gh の既定期限 20 秒を加えた時刻以降なら、意図を消す。
消した操作について「前回のマージ操作の結果を確認できませんでした」を既存の PR 行通知に一度記録し、記録から 1 分で隠す。
期限前に始まった取得では意図を消さず、マージキューの意図と予約の扱いは変えない。

結果は PR を登録したセッションへ PostToolBatch、UserPromptSubmit、Stop の回答配信経路で知らせる。レビュー収束後マージの結果には、ブランチ削除、base の付け替え、警告を保存し、既存のマージ結果 1 行と同じ形式で画面へ配る。画面には `warning` が空でない文字列か `headMismatch` が真の結果だけを表示し、`閉じる` 操作まで残す。予約マージ結果の `mergeResultClosedAt` は `POST /api/pull-requests/merge-result/close` で記録し、旧形式で項目が無い結果は未閉鎖として扱う。閉鎖時刻はマージ履歴と同じ 24 時間の保持期限で整理する。
gh の順序、失敗時の扱い、積み直し通知は[計画書](../handover/2026-10-02.md)の「マージの手順(常駐サーバー)」を正本とする。

### スタックの一括マージ

分岐のないオープン PR の鎖で、鎖の下から「マージできる段」が 2 件以上続くときに、その範囲を対象にした一括マージを表示する。
マージできる段とは、登録、fork、コンフリクト、head の変化、ドラフト、積み直し、CI の失敗と不明、GitHub のレビュー、別のマージ処理中、`stackMemberBlocker` の条件に加えて、クロスレビューの条件(`review.mergeCondition.met`)を満たす段である。
下から順に調べ、最初に満たさない段の 1 つ前までを対象にする。CI 実行中と GitHub の計算中は待つ段として対象に含める。
対象が鎖の全件なら「スタックをすべてマージ (N 件)」、鎖より少なければ「下から N 件をマージ (全 M 件)」とし、対象が 1 件以下ならボタンも理由も出さない。
スナップショットの `stackMerge` は、対象の `members`、鎖の件数 `total`、対象の外の最初の段 `stopAt: {number, reason}`(全件が対象なら null)、確認欄に並べる対象外の段 `excluded: [{number, title, reason}]` を持つ。`excluded` の理由は最初の段だけが `stopAt` と同じで、それより上の段は「下の段がマージできないため」とする。
鎖全体に効く条件(どれかの段の予約、マージコミットの不許可、リポジトリ設定の取得失敗)と、対象 20 件の上限は `blocker` に入れ、`available` は対象が 2 件以上で `blocker` が無いときに真にする。
確認欄には対象の段だけを下から順に番号、題、照合する head SHA、待機状態で並べ、対象外の段を「マージしない段」として理由とともに示す。対象が鎖より少ないときは、見出しとボタンに対象の件数を出す。
確認欄を開いた後に対象の件数、鎖の件数、head、登録キーが変わったら、開き直しを求めて実行を押せなくする。

方式はマージコミット、リモートブランチの削除は有効に固定する。
`POST /api/pull-requests/merge-stack` は `items: [{number, registration_key, headRefOid}]`、`method: 'merge'`、`deleteBranch: true`、確認欄に表示した `targetBranch` を受ける。
`items` は鎖の一番下から続く 2 件から 20 件とし、秘密値と必須 Origin を照合する。
リポジトリロック内で指定の構成員を取り直し、鎖の下からの連続と順序、登録キー、画面で見た SHA とマージ先、許可方式、既存予約や操作意図との重複、中止条件、各段のクロスレビューの条件を確かめる。
条件が崩れていれば何も予約せず 409 を返す。
指定の最上段より上の段は、予約もマージもしない。最上段のマージではブランチを削除するので、その直接の子の base だけが通常のマージと同じくマージ先へ付け替わり、それより上の段は変わらない。

予約は既存の `mergeReservations` に `kind: 'stack'`、`runId`、`order`、`total`(対象の件数)、確定時の `headRefOid` を付けて保存し、保存完了後に実行条件を確認する。
`kind` のない収束後マージ予約の評価は変えない。
一括予約は、確定時だけでなく、各段の実行前と子の base の付け替え後にも、その段のクロスレビューの条件を確かめ直す。満たさなくなった段(収束の後の push、記録の食い違いなど)があれば、待たずに残りの予約をすべて取り消す。
各段の実行前と子の base の付け替え後に条件を再検査し、スタックの一番下になった PR だけを保存済み SHA の `--match-head-commit` でマージする。
後続も中止条件を確認するため、下の PR が待機中でも子の異常を検出できる。

一覧の取得不能、親のマージ確認待ち、同じ実行の下の PR 待ち、GitHub の計算中、積み直し要否の確認中、CI 実行中は待機する。
待機と中止の分類には表示文言ではなく `operationBlockerCode` を使う。
head の変化、登録の消失、ドラフト、積み直し、コンフリクト、CI 失敗、レビューの変更要求や承認待ち、クロスレビューの条件の喪失、マージ先の不整合、実行外の親、クローズ、外部マージ、キュー入り、gh や base 付け替えの失敗では残りの予約を取り消す。
計算中の構成員がある場合は、通常の早い取り直しが尽きても 10 秒間隔で連続 60 回まで再取得し、その後は定期取得を待つ。

`POST /api/pull-requests/cancel-stack-merge` は `{runId}` で残りの予約を取り消す。
中止要求をメモリーに記録してからリポジトリロックを待ち、進行中の段は base 付け替え後の再評価で止める。すでに `gh pr merge` を呼んだ段は完了させてから残りを取り消す。
中止の通知は実行ごとに一通にまとめ、各段のマージ通知と結果は既存の経路で残す。
最後の段が入ったら完了結果を記録する。
完了と中止の結果は `store.json` の `stackMergeResults` に保存し、最大 100 実行を保持する。
結果行の「閉じる」は `POST /api/pull-requests/stack-merge-result-close` に `{runId}` を送り、閉鎖時刻も保存する。
実行中は構成員の個別マージ操作を隠し、最後の一件になっても進捗と中止操作を表示する。

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
- Bash と PowerShell の PreToolUse では、コマンドの全文から `codex-agent.sh <定義名>` の起動を探す。
  起動、待機、レビュー、経路の制御、PR の検出は、`src/shared/shell-commands.js` の共通規則で実行部分を分ける。
  区切り(`;`、`&&`、`||`、`|`、改行)ごとに、引用符の外の行コメントを区切りごと除く。
  Bash の `#` は語の先頭だけでコメントとし、PowerShell では `<# #>` のブロックコメントも除く。
  データとして渡す heredoc の本文と PowerShell のヒア文字列は除き、終端の後のコマンドの解析を続ける。
  標準入力をスクリプトとして読む Bash などのシェルへ渡す heredoc は、実行部分として扱う。
  コマンド置換 `$( )` の中身は、二重引用符の中にあっても別のコマンドとして探す。
  Bash の `\` と PowerShell の逆引用符は、それぞれのシェルのエスケープとして扱う。
  起動とレビューの検出では、括弧と、先頭の代入、`env`、`command`、`timeout`、`nohup` などの前置きを外し、`bash` などのシェルの引数と `-c`、`-lc` の文字列もたどる。
  PowerShell から呼ぶ `bash -c` の文字列は Bash の規則で分ける。
  引数や文字列の中の `codex-agent.sh`(`git diff -- tools/codex-agent.sh` など)と、定義名より前に `--new-prompt`、`--wait`、`--header-of` がある呼び出しは起動として扱わない。
  `-C <パス>`、`--effort <値>`、`--effort=<値>` が定義名より前にあれば、各オプションと値を除いた先頭の語を定義名にする。
  要約は 80 字で切られ、引数に現れたパスと起動を区別できないため、検出には全文を使う。
- 起動を見つけたら、Claude のホーム(`CLAUDE_CONFIG_DIR`、無ければ `~/.claude`)を先に、そこが `~/.claude` と異なる場合は後者も対象にして `gpt-agents/<定義名>.md` を探し、先に読めた定義の frontmatter から `codex_model` と `codex_reasoning_effort` を仮の値として持つ。
- Bash と PowerShell の PreToolUse では、要約の切り詰め前にコマンド位置にあるクロスレビュー起動も Codex 呼び出しとして扱う。
- `npm run review:codex` と `node tools/cross-review.js codex` は `codex-review`、`--fix` 付きと `npm run review:codex:fix` は `codex-subagent` の定義を使う。
  実行ファイルはパスと `.cmd`、`.exe` を正規化し、スクリプトの `./tools/` と `\` 区切りも受ける。
  `--help` または `-h` のある起動はレビューに数えない。
  `--no-codex-agent` 付きも同じ規則で定義名を選ぶ。
- `codex-agent.sh` の起動の PostToolUse は、結果行を受けたときに終了とし、結果行が無ければバックグラウンドで動いているものとして扱う。
- 起動の PostToolUseFailure は、結果行が無い場合、`isInterrupt` が真なら終了未確認にし、それ以外は終了にする。Claude のフック入力の `is_interrupt === true` を `isInterrupt` として受け、保存後の作り直しでも保持する。合成の Interrupt との順序や error の文言には依存しない。別の出力で結果を受けた行は、遅れて届いた中断で終了未確認に戻さない。
- 出力に結果行が複数あれば最後の行を使い、監査行と run 行は最初の行を使う。bridge は結果行を出力の最後に出し、それより前の結果行は最終報告に引用されたものでありうるためである。
- クロスレビューの起動の PostToolUse は、`backgroundTaskId` が無ければ結果行が無くても終了にする。クロスレビューの CLI はレビュアーの終了まで戻らず、差分が無いときと bridge を通らない直接起動では Codex の行を出さないためである。`backgroundTaskId` があれば、`codex-agent.sh` の起動と同じくバックグラウンドの行として完了通知で閉じる。
- クロスレビューの行では、`codex-agent: result=failed exit=3` の行を、呼び出しが失敗で終わったとき(PostToolUseFailure と、完了通知の status が `failed` のとき)だけ結果として扱う。それ以外では結果行が無いものとして扱い、バックグラウンドの出力を読んだ呼び出しのこの行では何もしない。bridge が終了コード 3 を返すと、クロスレビューの CLI は同じプロンプトで直接起動へ切り替えてレビューを続けるためである。
- Codex 呼び出しを開始したイベントに親の `agent_id` がある場合は、GPT のモデル、effort、`codex_home` を親の行へまとめる。
- 親が特定できないメインセッションからの呼び出しは、独立した行にする。
- 監査行が届いたらモデル、effort、`codex_home` を実際の値に置き換える。
- 結果行が `rate-limited` なら「GPT 不使用(利用上限)」、`unavailable` なら「GPT 不使用(使用不能)」を表示する。
- GPT 側の情報を取得できない場合は、モデルの札を表示しない。
- バックグラウンドで起動した Codex は、後続ツールの PostToolUse 出力に結果行が現れたとき、まず一致する実行 ID の行を終了にする。
  無ければ、出力を読んだバックグラウンドタスク ID が起動時に記録したバックグラウンドタスク ID と一致する Codex の行(親は問わない)を終了にする。
  どちらも一致しない場合は、同じ親のバックグラウンド行のうち、稼働中または終了未確認で、以下の条件を満たす候補が一つだけならその行を終了にする。
  結果行に実行 ID があるときは、行の実行 ID が未記録か一致し、実行 ID の定義名が行の定義と同じで、run 行の `started=` が行の開始の 1 秒前より前でないことを条件とする(`started=` は秒で切り捨てられている)。
  結果行に実行 ID が無いときは、出力ファイルの読み取りを示すバックグラウンドタスク ID があり、行の実行 ID とバックグラウンドタスク ID がどちらも未記録であることを条件とする。
  実行 ID も出力元のバックグラウンドタスク ID も無い結果行は、文書などからの引用と区別できないため割り当てない。
  別のバックグラウンドタスク ID を持つ行にも割り当てない。
  候補が複数なら行を終了にせず、終了未確認のまま残す。
  `--wait` の状態の行(`orphaned`、`unverified`)や停止の通知で終了未確認にした行は、ラッパーの出力に結果行が届かないので、この候補にしない(実行 ID の一致でだけ結果を受ける)。
- バックグラウンドタスクの完了通知は UserPromptSubmit とメインの記録ファイルの両方から取り込む。
  終了状態の通知の task-id が同じセッションのバックグラウンドタスク ID と一致する、稼働中か終了未確認で結果を受けていないバックグラウンドの Codex の行を終了にする。
  行にバックグラウンドタスク ID が無い場合だけ、出力ファイルの `codex-agent: run=` と行の実行 ID の一致で照合し、どちらかが無ければ終了にしない。
  記録ファイルから得た通知は、行の開始より古いものを使わない。
  出力ファイルは絶対パスでファイル名が `<task-id>.output` のものだけを読み、記録ファイルの経路では非同期に 1 回 8 件まで読む。
  先頭と末尾の各 64KB から結果行が得られれば既存の結果処理を適用し、結果行が無ければ監査行と実行 ID を反映して終了にする。
  ただし、`--wait` の状態の行があれば下の `--wait` の規則に従う。無いときは、通知の status が `killed` か `stopped` のとき、出力ファイルが無いとき、行にバックグラウンドタスク ID が無いときは終了未確認にする。bridge は起動元の Bash または PowerShell を止めても停止を Codex へ伝えず、Codex は動き続けるためである。
  記録ファイルの経路は内部イベント `BackgroundTaskEnd` を追加し、メインの状態、最終活動時刻、ターンの区切りを変えない。
  終了した行は次の読み取りの対象から外す。
  `BackgroundTaskEnd` と Claude の `Interrupt` は内部イベントとして、フックと `/api/events` からは受け付けない。
  Codex の `Interrupt` は実際のフックの通知なので、従来どおり受け付ける。
- 結果行が現れないままサブエージェントが `SubagentStop` を迎えたときは、バックグラウンドの Codex を終了未確認にする。
- PostToolUse を受けないまま呼び出し元が止まった Codex の起動(中断、フックの送信の失敗)は、終了未確認にする。前面のツールは呼び出し元のターンより長く続かないためである。
  メインは Stop(合成の Interrupt を含む)と、source が startup、resume、clear の SessionStart で、サブエージェントは `SubagentStop` で判定する。
  中断した起動は PostToolUseFailure で終了未確認になり、待っている起動の記録から外れる。
  記録に残るのはイベントが欠落した起動か並行する前面の起動なので、下の一意性の条件を満たしたときだけ run 行や `--wait` で引き取る。
  `--wait` の呼び出しは、止めても Codex がバックグラウンドで動き続けるので対象にしない。
  UserPromptSubmit では判定しない。バックグラウンドタスクの完了通知は、前面のツールの実行中にも UserPromptSubmit として届くためである。
  後から PostToolUse が並び、バックグラウンドで動いているものとして扱うときは、稼働中に戻す。合成の Interrupt の時刻は記録ファイルの時刻で、実際の PostToolUse より前に並ぶことがあるためである。
  ただし、呼び出し元のサブエージェントが止まった後なら戻さない。止まったサブエージェントのバックグラウンドの Codex は終了未確認にする規則と、並び順によらずそろえるためである。
- メインの `Stop` では、メイン直下のバックグラウンドの Codex を稼働中のまま残す。
- run 行に実行 ID と `started=` があり、その実行 ID の行も、出力のバックグラウンドタスク ID に一致する行も無いときは、欠落した起動を引き取る候補を探す。
  `Agent` の出力と、起動した呼び出し自身の出力は使わない。`Agent` の最終報告は別の実行の run 行を引用しうるためである。
  候補は、待っている起動の記録に残る行(`--wait` の記録を除く)と、バックグラウンドへ移った行のうち、Codex で、結果未受領、実行 ID なし、実行 ID の定義名と同じ定義の行とする。親は問わない。
  `started=` が行の開始の 1 秒前より前でない候補が合計で一つだけで、それが待っている起動の行なら、実行 ID を付けてバックグラウンドへ移す。出力のバックグラウンドタスク ID があり、行に無ければそれも付ける。稼働中と終了未確認の状態は変えない。
  待っている起動の記録は遅れた PostToolUse のために残し、呼び出し元が止まったときの前面起動の後始末では、バックグラウンドへ移った行を対象外にする。
- 「終了にする」は、終了未確認の行、メイン直下で稼働中のバックグラウンドの Codex の行、バックグラウンドで起動した稼働中の Claude のサブエージェントと Codex のネイティブの子の行に表示する。
  `Agent` ツールの `PostToolUse` が届いた時点でサブエージェントが稼働中なら、バックグラウンドで起動したものとみなす。
  バックグラウンドの起動の応答は `SubagentStart` より先に届くことがあるので、応答の `agentId` の行がまだ無く、停止済みでもなければ、その agentId で後から作る行をバックグラウンドの行にする。
  provider が codex のセッションの子は、SubagentStart でも他のイベントから作る場合でもバックグラウンドの行とする。spawn はすぐ戻り、子は親のターンより長く続きうるためである。
- 「終了にする」で閉じた行はスナップショットで終了として出し、未完了のツールと許可待ちを表示から除く。
  閉じた行を除いた稼働状態と許可待ちでセッションの表示状態を決め直す。
- 閉じた行の `agent_id` から `SubagentStop` 以外のイベントが届いたら、その行の閉じた記録を外す。
- 結果行で終了した行や、状態から消えた行の記録は破棄する。
- サブエージェントが `codex-agent.sh --wait <実行 ID>` を呼んだら、同じ Codex の実行が続いているものとして扱う。実行 ID は `<定義名>-YYYYMMDD-HHMMSS-<番号>` の形だけを受け、定義名は実行 ID の先頭から得る。同じ親の下で同じ定義の、バックグラウンドへ移って(終了未確認を含む)結果行をまだ受けていない行のうち最も新しいものを稼働中に戻し、この呼び出しの結果行で終了にする。`--wait` が結果行なしで抜けたときは、最後の状態の行で扱いを分ける。`waiting`(上限までに終わらない)か状態の行が読めないときは、Codex がバックグラウンドで動き続けている見込みなので稼働中に残す。`vanished` と `not-found` は終了、`orphaned` と `unverified` は終了未確認にする。結果行なしで失敗した起動は続きが無いので、候補にしない。バックグラウンドへ移った候補が無いときは、同じ親の下で同じ定義の、待っている起動の記録に残る行(起動の PostToolUse が欠けた行)が一つだけならそれをバックグラウンドへ移して引き取る。それも無ければ(常駐サーバーの再起動で起動のイベントが失われたときなど)、新しい行を作る。
- Codex の行には、分かったときに実行 ID を持たせる。起動時の Bash または PowerShell の出力にある `codex-agent: run=<実行 ID>` の行と、`--wait` の実行 ID から得る。バックグラウンドへ移った起動の出力には実行 ID が出ないことがあり、その行には `--wait` の時点で付く。バックグラウンドへ移った起動を実行した Bash または PowerShell のバックグラウンドタスク ID は行に記録し、そのバックグラウンドタスクの出力を後で読んだ呼び出しのバックグラウンドタスク ID と照合する。実行 ID を持たないバックグラウンドの Codex が同じ親の下に複数あっても、どの行の出力かを区別できるためである。コマンドの全文から出力ファイルが複数見つかる Bash または PowerShell は、出力が混ざって照合できないので使わない。Codex を起動した Bash または PowerShell も、出力はその起動のものなので、引数に出力ファイルのパスがあっても照合に使わない。途中の出力に `run=` の行があれば、結果行が無くても同じ行へ実行 ID を記録する。`--wait` の実行 ID と同じ行があれば、親を問わず、親と定義による選び方より先にその行を使い、呼び出した親の下へ付け替える。その行が既に結果行を受けていれば、行を作りも戻しもしない。終わった実行の結果を取り出し直す呼び出しで、行が増えないためである。親と定義で選ぶときは、実行 ID が分かっていて別の値の行を候補にしない。後続のツールの出力に結果行が出たときも、`run=` の行があれば同じ実行 ID の行に結び付け(既に結果を受けていれば何もしない)、照合できずに選んだ行にはその実行 ID を記録する。常駐サーバーを再起動すると行そのものが消えるので、この照合で再起動後の `--wait` を取りこぼすことはない。
- `--wait` は起動と同じ規則でコマンドの全文から探す(要約は 80 字で切られるため)。行継続を空白に置き換え、前置きとシェルの `-c` の文字列もたどり、起動の後ろの語が `--wait <実行 ID>` である最初の呼び出しから、実行 ID を 256 文字まで得る。ヒアドキュメントの本文、コメント、引数や文字列に書かれた手順は拾わない。同じ呼び出しで Codex を起動しているときは起動として扱い、`--wait` は見ない。
- 親の行の GPT の札は、稼働中の Codex の行を優先し、その中で最も新しいものを出す。
- メインセッションの `--wait` は、窓口の完了報告の後に最終報告を取り出す呼び出しなので、行を作りも戻しもしない。

## 許可待ち

- `PermissionRequest` は実行前の許可確認を示し、人間が操作できる画面の表示は保証しない。`permissionWaits` に `phase: checking` として保持し、セッションの作業状態に「実行許可を確認中」と表示する。
- Codex の標準登録は `PermissionRequest` を送る。Claude Code の標準登録にはこのフックがないため、`Notification` から許可待ちを表示する。Claude Code では、`PermissionRequest` を追加登録した場合と、通知後に許可待ちの継続を確認できなくなった場合に「実行許可を確認中」を表示する。
- Claude Code の `Notification` のうち `permission_prompt` を受けたとき、対応する有効な待ちを `phase: prompted` とする。候補のツールが一意なら対象へ結び付け、複数なら対象を断定せず確認済み通知を表示する。時間の経過だけでは `prompted` にしない。
- 候補が複数ある通知は、通知時点の候補集合を内部に保持する。その一部が完了または失敗したら、許可待ちが続くと断定できないため `checking` に戻す。判断欄と通知からは外し、作業状態の表示を保つ。候補が一つに減っても自動では対象を確定せず、新たな `permission_prompt` を受けたときだけ `prompted` に戻す。
- `prompted` だけを判断欄、許可待ちの件数、タブの件数、トレイの通知に含める。カードには「Claude Code の <プロダクト> 「<セッション>」で許可または拒否を選んでください。」の 1 行で、操作先のアプリとセッションを示す。Codex のセッションではアプリ名を Codex にする。元の画面で答える判断事項も同じ形で「〜で回答してください。」と示す。ダッシュボードに承認操作は設けない。
- Codex は利用者が操作する許可画面の表示を観測する経路がないため、許可要求を `checking` のまま扱う。保存済みの状態に `phase` がない場合も、人間の判断待ちには含めない。トレイが旧 API へ接続した場合も、`phase` がない許可待ちは通知しない。
- 対象を特定した許可待ちは、同じ対象の PostToolUse、PostToolUseFailure、UserPromptSubmit、Stop を受けたときに解消する。
- 完了、停止、新しい入力の後に届いた通知は、既存の要求も実行中のツールの候補もなければ待ちを再生成しない。

## タスクと判断事項

確認依頼は `cockpit_add_decision` の `waiting` と `verify.steps` で登録する。
`source: "mcp"` の waiting はダイアログを持たないため、画面から回答できる。
ask 由来の質問と離席時の扱いは変えない。
`verify`、`launchRequestedAt`、選択肢の省略可能な `next` は既存の `plans.decisions` に保存し、旧形式では省略されたまま読む。

画面の `POST /api/verify/launch` はセッションと判断事項の ID だけを受け、未解決の確認依頼を照合してから `answerDelivery.notifySessions` で ID を含む固定文を通知する。
未配達の同じ通知があれば 409 にし、回答欄は使わない。
セッション自身が起動し、MCP の `cockpit_report_launch` から `verify.launched = { url | process, at }` を書く。
この書き込みも既存の MCP の秘密値とセッション照合を通し、URL は http と https のみ受け、判断事項の状態は変えない。

セッションの cwd から linked worktree を探し、snapshot に `worktree` を載せる。
未解決の確認依頼がある間だけ git でブランチ、base、先行数と未コミット数を読み、root ごとのキャッシュと実行中の Promise を共有する。
同期 snapshot はキャッシュを返し、5 秒以上古ければバックグラウンドで更新して `state.touch()` で知らせる。
失敗とタイムアウトでは前回値を保ち、未取得の行は画面で「読み取り中」とする。

`POST /api/worktree/terminal` は判断事項かセッションの ID だけを受け、サーバーが cwd から root を引く。
両方の画面の口で起動ごとの UI 秘密値と Origin を照合し、パスやコマンドは受けない。
表示設定 `display.terminal` は `auto`、`windows-terminal`、`pwsh`、`powershell`、`cmd` から選び、既定は `auto` とする。
`auto` は Windows Terminal、PowerShell 7、Windows PowerShell の順に候補を探し、コマンドプロンプトは自動選択しない。
Windows Terminal は LOCALAPPDATA 配下の絶対パスの `wt.exe` に `-w new -d <root>` を shell なしで渡す。
PowerShell とコマンドプロンプトは絶対パスの `cmd.exe` から `start` で起動し、root は作業ディレクトリとしてだけ渡す。
PowerShell は `-NoExit` を付け、コマンドプロンプトには付けない。
PowerShell 7 は ProgramFiles 配下を先に探し、次に PATH の絶対パスのディレクトリを探す。
どの端末も名前だけで起動せず、worktree のパスをコマンド行に入れない。
短時間の同じ root の起動は間引く。
選んだ端末が無い場合は自動選択へ落とさず、worktree 削除済みの場合や Windows 以外の場合と同様に理由付きの 4xx を返す。
パスと確認手順のコピーはブラウザーだけで行う。

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
デスクトップアプリ上で却下した質問には終了フックが来ないため、後続のメインセッションの UserPromptSubmit、Stop、Interrupt、別の tool_use_id の PreToolUse で `waiting` の質問を `withdrawn` にする。
受信済みの最新の質問開始より後の時刻のイベントだけを使い、同じ質問の出し直しは既存の判断事項へ結び付ける。
`provisional` と、フックの回答待ちを扱った `decisionLifecycles` の記録がある質問は対象から外す。
回答待ちの期限は再起動で消えるため、期限や回答の有無だけではなく記録の存在を保護の根拠にする。
後続イベントによる取り下げは `finishedByToolUseId` と終了時刻に加え、推定の印を兼ねる根拠イベントの `hookAt` を `inferredWithdrawalHookAt` に保存する。
この項目がない保存済みの判断事項は、推定による取り下げとして扱わない。
質問の開始が区切りより遅れて届いた場合も、開始を受けたときに、その開始より後の時刻の区切りがすでに届いていれば、その場で推定の取り下げにする。
`inferredWithdrawalHookAt` には、開始より後の区切りのうち最も早いものの `hookAt` を入れる。
再起動後は記録がメモリーに無いため、遅れて届いた開始は次の区切りまで判断待ちに残る。
記録の圧縮で区切りの PreToolUse が消えている場合は、根拠は後の Stop か UserPromptSubmit になる。
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

タスクは `[{title, state, criteria: [{text, met, doing?}]}]` の配列で持つ。
`state` は `todo`、`doing`、`done` のいずれかにする。
完了条件の `doing` は省略可能な真偽値であり、`met` が true なら達成、`met` が false で `doing` が true なら作業中として表示する。
保存時は `doing` が true の完了条件だけに `doing` を記録する。
Claude のメインセッションで設定 `importAppTasks` がオンのとき、アプリの 1 つの一覧を cockpit の 1 つのタスクとし、各項目をその完了条件として取り込む。
設定は既定でオフであり、明示的にオンのときだけ取り込む。
Codex、サブエージェント、オフのときは取り込まない。
表示設定には真偽値 `importAppTasksAsked`（既定 false）を保存する。
この値が true でない保存値は、`importAppTasks: true` があってもオフとして読む。
ダッシュボードは未確認ならページを開いている間に一度だけ確認ダイアログを出し、Esc で閉じた場合も「取り込まない」として保存する。
確認への回答や設定画面からの切り替えで `importAppTasks` を更新すると、正規化する前に `importAppTasksAsked` を true にする。
あとから設定画面で取り込みの有無を変更できる。
取り込みが無い場合の `cockpit_set_tasks` は配列全体を置き換える。
Codex には取り込める段階の一覧が無いため、設定にかかわらず `cockpit_set_tasks` で登録する。

今のタスクは、タスク配列の最後の要素が done でない場合の、その要素である。
モデルは依頼ごとに `cockpit_set_tasks` で題と state だけを 1 件登録でき、criteria は省略できる。
アプリの一覧を一度でも取り込んだセッションのプランには `appTasks: true` を保存する。
印の無いプランは、アプリの各項目を別のタスクとして保存した旧形式でありうる。
そのため、常駐サーバーが items も一覧の置き換えもまだ受けていないセッションに items が届いたら、保存済みのタスクを捨ててから取り込む。
ただし、完了条件が空で done でないタスクが 1 件だけなら、題の待ちとして引き継ぐ。
捨てるタスクを done にしないのは、偽の完了を出さないためである。
差分が先に届くと受付で印が付くので、印の有無は、そのセッションの取り込みの記録を作った時点のものを使う。
この印があるセッションで 1 件だけを渡す `cockpit_set_tasks` は、題の前後空白を除いて完全一致する既存タスクを更新する。
印の無いセッション(取り込みの無い CLI など)と、2 件以上を渡す呼び出しは、配列全体を置き換える。
置き換えたときは、置き換えた一覧と書き込み時刻をそのセッションの取り込みの基準にし、それより前の `hookAt` の items と差分は退ける。
取り込みがオンのときは、題と一覧が同じ応答で届いても完了条件を失わないよう、置き換えた一覧の今のタスクが完了条件の空の題なら、次の 2 つで完了条件を入れる。
保存済みの今のタスクが自動の題で完了条件を持つときは、その完了条件を引き継ぐ。
置き換える前の基準より後で、置き換えより前に作られた items が後から届いたときは、その items を受け入れる。
そうした items が複数届いたときは、到着順に依らず `hookAt` が最も新しいものを使う。
置き換えの後に通常の items か 1 件のまとめ書きが届いたら、それより前に作られた items は受け入れない。
完了済みの題を done 以外で更新したときは、そのタスクを末尾へ移し、他の未完了タスクを done にする。
criteria が空または省略なら既存の完了条件を保ち、空でなければ置き換える。
同じ題が無く、今のタスクが自動の題か完了条件が空なら、その題を変更する。
それ以外は未完了の既存タスクを done にして末尾に追加する。
渡されなかった既存タスクは消さない。

メインの `PostToolUse` の `mcp__ccd_turn__update_plan` は items を完了条件へ変換する。
content を text とし、completed は met:true、in_progress は met:false と doing:true、pending は met:false とする。
すべて completed ならタスクを done、それ以外は doing にする。
今のタスクの完了条件が空なら scope にかかわらずそこへ入れる。
それ以外で scope が new_task か今のタスクが無い場合、未完了タスクを done にし、完了条件を保ったまま、新しいタスクを末尾に足す。
先に登録された題だけのタスクが題の待ちとなり、それが無ければセッション名、さらに無ければ「作業」を使う。
自動の題には autoTitle:true を保存し、モデルの題で改名したら印を消す。
題が重なるときは「 (2)」「 (3)」を付け、接尾辞を含めて 200 文字に収める。
それ以外の items は今のタスクの完了条件を置き換える。

advance:true は最初の作業中の完了条件を達成にし、その後ろの最初の未着手を作業中にする。
作業中が無ければ最初の未着手を開始する。
done と start は 1 始まりの完了条件番号で達成と作業中を指定し、範囲外は無視する。
今のタスクが無ければ差分を無視し、同じ呼び出しに items があれば差分を使わない。
`mcp__ccd_turn__wrap_up` の PostToolUse は今のタスクの完了条件をすべて達成にして done にする。
wrap_up の入力本文とツールの結果文は取り込まない。
items は 12 件、content は 200 文字までとし、不正な形や content の重複は全体を無視する。

フックは到着順が入れ替わるため、セッションごとに最新の items とそれより後の差分をメモリーで保持し、hookAt 順に再構成する。
同じ tool_use_id と基準より古い items は無視する。
基準が無ければ保存済みタスクと tasksUpdatedAt を固定した基準にし、それより後の差分だけを適用する。
記録はセッション終了、削除、importAppTasks の切り替えで捨てる。
取り込み後は通常の登録と同じく tasksUpdatedAt と催促管理を更新する。
保存済みデータに autoTitle が無ければモデルが登録した題として扱う。
タスクが 50 件を超えたら古い done から捨て、完了条件は 20 件までを保つ。
完了条件が空のタスクでは件数と一覧を表示せず、操作列の最小幅を維持する。
題は 200 文字、本文は 2,000 文字、タスクは 50 件、完了条件は 20 件、選択肢は 6 件までに制限する。

MCP サーバーは `src/mcp/server.js` で、JSON-RPC を stdio の行単位で扱う。
ツールは `cockpit_set_tasks`、`cockpit_add_decision`、`cockpit_update_decision`、`cockpit_report_launch`、`cockpit_add_pr`、`cockpit_skip_review`、`cockpit_defer_review` の 7 つである。
`cockpit_report_launch` は判断事項の `id` と、`url`(http か https)または `process` のどちらか一方を受け取る(扱いは「タスクと判断事項」の節)。
`cockpit_add_pr` は PR の `url` に加え、任意の `cwd`(絶対パスの文字列、4096 文字まで)を受け取る。
計画の変更は `ensureServerRunning` で常駐サーバーを確かめ、`secret` 付きで `/plan` に送る。PR の登録とクロスレビュー不要または保留の記録は `/prs` に送る。
MCP が渡す `ppid` と `CLAUDE_CODE_SESSION_ID` のうち、常駐サーバーはまず `ppid` から `~/.claude/sessions/*.json` に対応する session ID を探し、見つからない場合に環境変数の ID を使う。どちらも無ければ書き込みを拒否する。
委譲した Codex の thread への書き込みは、403 の `error: "Codex session delegated"` で拒否し、MCP は委譲元の Claude のセッションが記録するので呼ばなくてよいと、エラーにせずに返す(詳細は [委譲した Codex の表示](codex-delegation.md))。
他の環境変数値や `CLAUDE_CODE_MESSAGING_TOKEN` は MCP の結果、ログ、常駐サーバーへの要求に含めない。
`cockpit_add_decision` は質問を 1 つ持つ判断事項を作り、`cockpit_update_decision` は `provisional` または `resolved` と `resolution` を記録する。
成功時の MCP 応答は、保存した後の一覧を短く示す。

`SessionStart` の source が `compact` または `resume` のとき、`away.js` は `/context` からタスクと未解決判断事項の要約を読む。
離席中の文脈も必要な場合は、同じ `additionalContext` にまとめる。
メインの `SessionStart` と `UserPromptSubmit` では、常駐サーバーに届かない場合もタスク登録の決まりを `additionalContext` に足す。

## 経路の設定

`routing.json` に `{agents, review}` を保存し、値は `default`、`codex`、`claude` のいずれかとする。欠落、破損、無効な値の場合は両方を `default` として読む。読み取りエラーは数回読み直し、それでも読めなければ常駐サーバーの起動を失敗させる。
書き込みは `POST /api/routing` だけで受け付け、画面用秘密値と `validRequiredUiOrigin` を照合する。
ファイルは `AtomicJsonWriter` が一時ファイルから rename して保存する。

`GET /api/state` は現在の経路を返す。
`event.js` は Claude セッションの `SubagentStart` のうち、bridge の窓口種別と `codex-review` だけを扱う。
bridge の窓口種別では `agents`、`codex-review` では `review` の設定を `route` として送る。
bridge があり、`route-agents/` に記録があれば記録値を優先する。
route.js を登録していない環境でも現在の設定値を送るため、画面の札を登録漏れの診断に使える。
bridge が無ければ `route` を送らない。
`event.js` は記録を書き換えない。
画面は起動時の値と現在値が異なる稼働中の行に「変更前」を表示する。

同期フック `route.js` は `impl-hard`、`impl-standard`、`impl-light`、`codex-subagent` の開始時に `agents` の値を `route-agents/` へ記録し、`codex-review` の開始時には `review` の値を記録する。
どちらも `default` を含めて開始時の値を記録する。
Codex または Claude が選ばれていれば、値に対応する文脈を `additionalContext` へ差し込む。`default` は記録だけを行い、差し込みも拒否もしない。
そのほかの agent_type は記録も差し込みもしない。
記録名は session ID と agent ID を小文字の 16 進数文字列にして作り、一時ファイルから rename して保存する。
`PreToolUse` はこの記録を参照するため、起動後に設定を変えても稼働中の経路は変わらない。
記録された経路が Claude の場合だけ `codex-agent.sh` 呼び出しを拒否する。
同じサブエージェントの `SubagentStart` が再び届いても記録は上書きせず、終了時にも消さない。
再開したサブエージェントの経路を初回のまま保つためである。
`route.js` が記録を読むたびに更新時刻を進め、開始時に 24 時間使われていない記録を削除する。
記録の読み書きに失敗したフックは応答を返さない。

同期フックは `routing.json` の読み取りエラーを数回再試行し、合計 200ms 未満で打ち切る。それでも読めなければ `SubagentStart` に応答せず、`route-agents/` に経路記録を作らない。
`review` の値は ai-cross-review がレビューを回す直前に `node tools/cross-review.js route` で読む。
`codex-review` は開始時の値を記録し、`default` では agent-cockpit から文脈を差し込まない。

サブエージェントの経路は claude-codex-bridge の `codex-agent.sh` があるときだけ意味を持つ。`GET /api/state` は Claude のホーム(`CLAUDE_CONFIG_DIR`、無ければ `~/.claude`)か `~/.claude` のどちらかに `tools/codex-agent.sh` があるかを `integrations.codexAgent` で返し、画面は無ければサブエージェントの段と経路の札を出さない。`route.js` も同じ場所を確かめ、無ければ `SubagentStart` で何も差し込まない。`~/.claude` も見るのは、bridge が `CLAUDE_CONFIG_DIR` を見ずに `~/.claude/tools/` へ置く作りだからである。
クロスレビューの経路は ai-cross-review を使うリポジトリでだけ意味を持つ。`GET /api/state` は、稼働中のセッション(セッションファイルの `cwd`)と PR を登録したセッション(登録の記録の `cwd`)から worktree の根を探し、そのどれかに `tools/cross-review.js` があるかを `integrations.crossReview` で返す。セッションファイルが読めない環境でも、PR の登録があれば判定できる。判定は、各 `cwd` から親へ上って見つかる worktree の根に `tools/cross-review.js` があるかで行う。画面は偽ならクロスレビューの段を出さず、2 つの連携がどちらも無ければ経路の欄を出さない。

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
- 2 秒ごとに `GET /api/state` を読む。前の取得で応答本文の読み込みが終わっていない間は、次の定期取得を飛ばす。
  要求と本文の読み込みは 10 秒で打ち切り、操作後の明示的な更新は新しい要求として始める。
  新しい要求の結果を反映した後は、それより古い要求の成功や失敗で画面の版と接続状態を更新しない。
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
- 確認済みの許可待ちのカードには対象のメインまたはサブエージェント、待ち時間、ツール名と入力の要約、操作先のアプリとセッションを示す 1 行の案内を表示する。未確定の許可確認は作業状態だけに表示する。
- 種類別では、未回答の項目(許可待ちと、有効な回答がない `waiting` の判断事項)を先に表示する。
  `awaitingAnswerUntil` が有効な判断事項は期限の近い順にし、その後に期限の無い項目を待ち時間の長い順にする。
  待ち時間の起点は許可待ちが `startedAt`、判断事項が `createdAt`。
  続けて、仮進行中の判断事項を `provisionalAt` (なければ `updatedAt`) から待ち時間の長い順に表示し、回答を送信済みの判断事項を最後に表示する。
  同順位はセッション ID と項目 ID の順にする。
  その後にタスクと完了条件、今やっていることを表示する。
  各項目にプロダクト名を付け、同じプロダクトに複数セッションがあるときはセッション名も付ける。
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

離席中のメインセッションの `mcp__ccd_turn__wrap_up` も、`ask` があれば同じ登録、待機、終了の処理を使う。
`ask` を質問、`actions[].label` を選択肢、`actions[].message` を選択肢の説明、先頭の選択肢を推奨とし、`recap` を判断事項の説明に添える。
出どころは既存の `ask` とし、判断事項の表示形式と保存形式は変えない。
`AskUserQuestion` と違い、同じ質問文の未解決判断事項には束ねず、呼び出しごとに別の判断事項にする。束ねると、遅れて届いた前の呼び出しの PostToolUseFailure が次の呼び出しの回答待ちを消すため。
在席中、`ask` の無い呼び出し、サブエージェントの呼び出しでは出力しない。

wrap_up への回答は `updatedInput` にせず、拒否理由で選んだ label と message、開発者の指示を返す。
拒否理由は「開発者の回答の知らせです」で始め、回答した判断事項は終了処理で解決済みにする。
時間切れは「推奨の適用の知らせです」で始め、先頭の選択肢と message を伝え、推奨を適用して作業を続け、判断待ちとして最後の報告に書くよう案内する。
選択肢が無ければ「推奨を判断できないため、判断待ちとして最後の報告に書いて作業を続ける」と案内する。
いずれも作業を終えたら `ask` を付けずに wrap_up を呼び直すよう伝える。
拒否された呼び出しには PostToolUse が来ないため、回答の解決は終了処理で記録する。
PostToolUseFailure では、同じ呼び出しの判断事項の記録に回答期限が無く、仮適用または送信済みの回答があれば、意図した拒否として判断事項を残す。
それ以外は中断として判断事項を取り下げ、回答待ちを released にして回答期限を消す。
投影と回答待ちの後始末は、常駐サーバーが既存の判断事項の記録から求めた同じ基準を使い、isInterrupt の印には頼らない。
`ask` の無い wrap_up の PostToolUse による区切りの記録は従来どおり更新する。

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

作業中は `PostToolBatch` が 1 秒以内に常駐サーバーへ尋ね、未配信の回答を `additionalContext` に入れる。回答の受領はフックが応答本文を解析した後の ACK で確定する(下記「配信」)。タスクが無いままメインツールを 5 回使ったか、タスク無しでサブエージェントを起動したときは登録を促す。タスク更新より後にサブエージェントが終了して 10 分経っても一覧が書き直されていないときも促す。一覧が空でなく全件 `done` のときは、メインの新しい `UserPromptSubmit` 後に一覧が書き直されないままメインツールを 5 回使うか `Agent` を起動した時点で、新しい依頼か前の続きかを確かめる案内を返す。同じターンで一覧を書き直した場合や `todo` / `doing` が残る場合は案内しない。この案内は 1 つのターンで 1 回だけにする。同じセッションへの催促は 10 分間隔にし、催促の文は回答と同じ `additionalContext` に続けて入れる。

Claude の対話セッションの停止中は、`Stop` の `asyncRewake` フックが 1 回最大 25 秒の long-poll を繰り返す。
回答が届いたら標準エラーへ書いて終了コード 2 でセッションを起こす。

メインの `PreToolUse`、`PostToolUse`、`PostToolUseFailure` が最後の lifecycle 時刻より新しければ、停止フックの待機を終える。

最後の lifecycle 時刻より古い `Stop` は世代を更新せず、待機せずに終わる。

停止フックは後続の `Stop`、`UserPromptSubmit`、`SessionEnd`、親プロセスの終了でも何もせず終わる。

`SessionStart` は `startup`、`resume`、`clear` のときだけ最後の lifecycle 時刻を消す。

`PostToolBatch` と `Stop` は `agent_id` のあるサブエージェント内では何もしない。

[導入手順](../setup.md) のフック登録例では `PostToolBatch` の timeout を 2 秒、`Stop` を 3600 秒、AskUserQuestion の `PreToolUse` を 1830 秒にする。

未反映の回答は、`UserPromptSubmit` の `additionalContext` で受領 ACK を最大 3 回記録するまで差し込み直す。同じ要求 ID の再送は既存の配信記録を再生し、追加の ACK 回数に数えない。

Claude の待機質問への回答は、回答を含む `PostToolUse` を受けた時点で `reflectedAt` を記録する。
Codex の質問は `ask-finish` の回答を拒否理由として返し、判断事項を解決済みにする。
その ACK はフックが回答を受領した確認にとどまるため、`reflectedAt` は記録しない。
仮適用した判断事項への回答は `cockpit_update_decision` を受けた時点で `reflectedAt` を記録する。

フックが使う `POST /api/hooks/answers` は `secret` と Origin 不在を照合し、要求中の `session_id` と判断事項の所有セッションを一致させる。

回答本文は、常駐サーバーのメモリー、`store.json` の回答の記録(`decisionLifecycles`)、フックの出力にだけ置き、ログには書かない。
`store.json` に回答、未 ACK 通知、要求ごとの配信記録を置き、ACK 済みの回答状態と本文を再起動後も保つ。同じ要求の再送は保存済みの配信記録から回復し、別の要求は未 ACK の内容を受け取れる(「保存」節)。

配信状態の共通受付、状態遷移の表、各入口との対応は [フック回答配信の共通受付](answer-delivery.md) に定める。

出力を含むフック応答は、セッション、action、要求 `id` ごとの配信記録に固定する。
同じ要求の再送には、配信記録の保持期間内なら同じ配信 ID と本文を返す。
空の応答と待機中の応答は記録しない。
異なる要求が同じ未 ACK の内容を同時に取得した場合は、双方に同じ内容を返してよい。どちらかの ACK で該当内容を保留から外すが、もう一方の既存配信記録は期限まで再生できるため、runtime への厳密な一度だけの適用は保証しない。
配信記録は 10 分間保持し、1 セッションにつき 128 件を上限とする。
容量を空けるときは ACK 済みの記録から除き、未 ACK の記録しか残っていない場合は取得要求を 503 で拒む。
期限切れの配信記録を除いても、未 ACK の回答と通知は保留状態に残り、別の要求で再配信できる。

タスク更新とクロスレビュー記録の催促も、回答と通知と同じ配信 ID の ACK を受けてから配信済みにする。
組み立てた時点ではメモリー上の配信中の記録にとどめ、同じ要求 ID の再試行には同じ配信 ID と本文を返す。
ACK が無いまま次のメインのツール区切り、入力、Stop または別の取得要求へ進んだ場合は、催促の配信中の記録を取り消し、次の機会に再判定する。
取り消した配信への遅い ACK は、催促の配信済みの記録を進めない。

フックは応答本文を解析した後、配信 ID を指定して受領 ACK を送る。
呼び出し元が絶対期限を指定しない場合、ACK は応答本文の解析後から最大 300 ms 待つ。
呼び出し元が絶対期限を指定した場合は、その期限を ACK にも適用する。
ACK が失敗しても、解析済みの出力を runtime へ返す。
ACK が記録するのは受領であり、回答をセッションが反映した時刻(`reflectedAt`)は更新しない。
回答を訂正するたびに UUID の版を新しくし、ACK は配信時の版が現在の回答と一致するときだけ `deliveredAt` を更新する。
`UserPromptSubmit` の再送回数は、その要求の受領 ACK が初めて記録されたときだけ増やす。

Stop の応答を再送する前に、現行の世代とセッション終了条件を確認する。
古い世代または終了済みセッションの配信記録は再生しない。

未 ACK のセッション通知は `store.json` に保存し、ACK が一致した通知 ID だけを取り除く。
未 ACK 通知に時間期限は設けず、セッションあたり 20 件まで保持する。
上限に達したときは追加を拒み、拒否した理由と件数を含む保留通知を保存して、後続のフックへ伝える。
明示的なセッション削除と保持期限による保存記録の削除では、そのセッションの未 ACK 通知、overflow 集計、配信記録も削除する。
通知だけが残る保存セッションも最後の通知更新時刻から 14 日間保持し、その後の定期整理で削除する。
配信記録の期限切れは定期整理で全セッションを対象に削除し、回答と通知の保留状態には影響させない。
旧形式の `store.json` に配信記録や通知が無い場合は、空として復元する。

フック設定の例は [導入手順](../setup.md) に記載し、`~/.claude/settings.json` は自動で変更しない。

### Claude と Codex の単発実行

一回で完結する Claude と Codex の呼び出し元は、起動する子プロセスの環境に `AGENT_COCKPIT_NONINTERACTIVE=1` を設定する。
Claude Code 2.1.302 の `-p` は `asyncRewake` フックの終了を待つため、回答の到着を待ち続けると呼び出し元が結果を回収できない。
実行形態は呼び出し元が明示し、Claude の非公開環境変数やフックの端末接続から推測しない。

この指定がある Claude の `Stop` は、`stop-check` で未配信の回答・通知とレビュー記録の催促を一度確認する。
返す内容があれば標準エラーへ書いて終了コード 2 で続行させ、無ければ終了コード 0 で終える。
新たな回答の到着を long-poll で待たず、レビュー記録の確認には上の応答上限を使う。
`AGENT_COCKPIT_NONINTERACTIVE=1` の `PostToolBatch` はタスク催促を求めず、`SessionStart` と `UserPromptSubmit` もタスク登録を案内しない。
Codex の `Stop` も同じマーカーを受け取り、`stop-check` を一度だけ行う。
未配信の内容があれば既存のJSON形式で返し、無ければlong-pollへ入らず終了する。
マーカーを指定しない対話セッションは、停止中の待機を続ける。

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
| `GET /api/diagnostics` | なし | `{runs: [{id, startedAt, count, current, sources, runtime}], version, responseRuntime}`。現在の起動を先頭に返す |
| `GET /api/diagnostics?run=<起動>` | なし | `{entries, version, runtime, responseRuntime}`。区分を古い順に連結する |
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
