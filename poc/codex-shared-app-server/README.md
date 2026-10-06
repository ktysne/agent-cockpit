# 共有 app-server の読み取り PoC

この PoC は、既存の Codex app-server control socket に別クライアントから接続し、既知の2スレッドのメタデータを読み取れるか調べる。
Codex CLI の stdio JSONL と control socket の WebSocket framing を区別し、Windows の socket path は codex app-server proxy に渡す。

公式仕様では app-server の control socket は WebSocket で、initialize の後に JSON-RPC request を送る。
thread/read の includeTurns を false にすると、rollout のターン本文を含めずスレッド概要を返す。
参照: [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## 読み取り範囲

collector は固定された既知の親スレッドと子スレッドだけを thread/read で読む。
thread/list は既知のスレッド名を検索し、useStateDbOnly を true にして rollout の走査を避ける。
thread/loaded/list は結果の総数と既知IDとの一致だけを残す。
thread/read は includeTurns を false にする。

collector が出力するのは、既知ID、名前の有無と固定名との一致、状態、source種別、許可した親子IDとUUID、ページ数、件数、切り詰め有無、app-server版、およびRPC errorの数値codeと安全カテゴリだけである。
タイトル、preview、ターン本文、パス、初期化応答のホームディレクトリ、WebSocket frame、認証値は出力しない。
server request には応答せず、methodとIDだけをcallbackに渡して件数を数える。
通知callbackにはmethodと、UUID形式のthread/turn ID、限定形式のitem ID、schemaで定義されたitemType/statusだけを渡す。

## 実行

CODEX_HOME には既存のディレクトリを指定する。
安全のため、ディレクトリはリポジトリの poc/out 配下に置き、シンボリックリンクを含めない。
collector はCLI子プロセスへこの専用CODEX_HOMEと実行に必要な環境変数だけを渡す。
TEMPとTMPも専用CODEX_HOMEへ向ける。

```powershell
New-Item -ItemType Directory -Force poc/out/poc158/collector-home | Out-Null
node poc/codex-shared-app-server/collector.js --cli 'C:\path\to\codex.exe' --socket 'C:\Users\<user>\.codex\app-server-control\app-server-control.sock' --codex-home (Join-Path (Get-Location) 'poc\out\poc158\collector-home')
```

initialize と initialized だけを確かめる場合は、最後に --initialize-only を付ける。
既定のtimeoutは各handshakeとrequestあたり15秒である。
initialize応答の構造を検証し、userAgentから抽出した版が0.160.0と一致する場合だけ成功扱いにする。

プログラムから分離したapp-serverへ接続する場合は、`connectViaTcp` または `connectViaWebSocket` を使う。
接続先は明示した127.0.0.1のTCP portに限り、64桁の16進 capability tokenを `Authorization: Bearer` headerで送る。
tokenはclient内だけで使い、ログや返却値へ含めない。
この低レベルhelperでは呼び出し側がmethod allowlistを指定できるが、通常のCLI collectorは読み取り専用allowlistのままである。

## managed app-server の実測

managed runner は専用homeを `poc/out` 内に作り、Codex CLI 0.160.0 の app-server を `127.0.0.1` のWebSocketで起動する。
通常homeの設定を変更せず、fixture設定、capability token、実行結果を専用出力先に置く。

```powershell
node poc/codex-shared-app-server/run-managed.js --codex-path 'C:\path\to\codex.exe'
node poc/codex-shared-app-server/run-managed.js --codex-path 'C:\path\to\codex.exe' --serve
node poc/codex-shared-app-server/run-managed.js --codex-path 'C:\path\to\codex.exe' --serve-pending-turn
```

1行目は初期化、スレッド再開、2クライアント間のturn共有を確認して終了する。
`--serve` は同じ確認を終えた後も server と2つのクライアントを保持し、`Ctrl+C` まで待機する。
`--serve-pending-turn` は `untrusted` approval policyで承認待ちのturnを作り、CLI接続後の要求解決とturn状態を記録する。
runnerは承認要求へ応答しないため、接続したCodex TUIで承認を解決する。
TUIが要求を承認すればturnの完了を、取り消せば両クライアントが同じturnの `interrupted` 終端を観測したことを確認する。
`--serve` と `--serve-pending-turn` は同時に指定できない。

serveモードは stdout に ready file の相対パスを出力する。
ready file にはloopbackのhostとport、専用home、作業ディレクトリ、対象thread ID、token file pathが入り、token値は入らない。
同じ対象threadを開くCodex TUIを接続するには、ready fileのhost、port、token fileを使う。
CLIは `--remote` でWebSocketへ接続し、`--remote-auth-token-env` で指定した環境変数からtokenを読む。
token値を引数やログへ出さない。

```powershell
$ready = Get-Content -Raw '<ready-file-path>' | ConvertFrom-Json
$env:CODEX_REMOTE_TOKEN = Get-Content -Raw $ready.token_file
codex --remote ("ws://{0}:{1}" -f $ready.host, $ready.port) --remote-auth-token-env CODEX_REMOTE_TOKEN
Remove-Item Env:CODEX_REMOTE_TOKEN
```

このPoCは `ws://127.0.0.1:<port>` にだけ接続し、`Authorization: Bearer` headerでcapability tokenを渡す。
OpenAI Docsは、TUIの `--remote` 接続とWebSocketのtoken認証を説明している。[Codex App Server](https://learn.chatgpt.com/docs/app-server)
serverのtoken fileはrunner終了時に削除されるため、runnerを止めてから接続を再開することはできない。
実機では、承認待ちの途中から参加した2つ目の監視クライアントは要求の再通知と解決通知を受け取ったが、開始時点の `waitingOnApproval` 通知は受け取らなかった。
このため、結果は開始時の待機と解除の遷移を開始クライアントで確かめ、2つ目のクライアントには同じturn IDと終端状態を要求する。

cleanupはfixture設定の追加部分が残っている間だけ、その設定差分を取り除く。
CLIが設定末尾へTUIやhookの状態を追加した場合は、その追記を残してfixture設定だけを除去する。
fixture設定の適用済みprefixが編集されていた場合は、そのファイルを上書きせずcleanup失敗として記録する。

## 実測結果

0.160.0 の既存 control socket にproxy経由で接続し、initialize、thread/list、thread/loaded/list、既知IDのthread/readが成功した。
読み取りを再接続しても、このPoCが出力するsnapshot項目は同じだった。
thread/loaded/list は0件で、親と子のthread/readは両方とも found だったが、状態は notLoaded だった。
thread/read は親のsourceをvscode、子のsourceをsubAgentとして返し、子のparentThreadIdとforkedFromIdは親IDと一致した。
親のthread/readは固定名と一致したが、子では一致しなかった。両方のthread/readはturnsを返さなかった。

thread/list は固定名をsearchTermに指定しても0件だった。
0.160.0 schemaはsearchTermを抽出済みスレッド名の部分一致として説明するが、この実測では一覧検索の結果とthread/readの結果が一致しなかった。
一覧に無いことをスレッド不在の根拠にはできない。
この結果は指定socketが既知IDの保存済みメタデータを返したことを示すが、そのスレッドが同じapp-serverで読み込み済みであることや、同じ実行中会話を共有していることまでは示さない。

schema生成物と実測ログは無視対象の poc/out/poc158/ に保存する。
fixture tests は WebSocket upgrade/accept、masked client frame、分割UTF-8、fragmented message、ping/pong、request ID相関、本文を含む応答の射影、timeout、CODEX_HOME制約を確かめる。

```powershell
node --test --test-isolation=none poc/codex-shared-app-server/collector.test.js
node --test --test-isolation=none poc/codex-shared-app-server/managed.test.js
```
