# Codex共有app-server接続のPoC

## 目的と範囲

[Issue #158](https://github.com/ktysne/agent-cockpit/issues/158)の検証記録。
稼働中のデスクトップや対話CLIと、外部の状態収集クライアントが同じ実行を参照できるかを確認する。
同じホームの履歴が読めることと、稼働中の実行へ接続できることを分けて判定する。
表示先はAgent Cockpitのダッシュボードとする。

#157から、providerとnative thread IDの照合、親session IDと子agent IDの保持を引き継ぐ。
許可要求の開始だけでは終端を保証できず、共有接続からの要求解決と状態照合は未確認である。
本書は調査中の記録であり、本番対応の完了を意味しない。

## 検証環境

開始時のCLIと共有daemonは`0.160.0`だった。
`codex app-server daemon version`でCLI、managed package、実行中app-serverの3つの版を照合した。
デスクトップ同梱ランタイムは#157と同じ実行パスを使う。
別の`.codex-subagent`にあるランタイムは対象に含めない。

通常ホームのフックとMCPの一時検証設定は#157の終了時に復元済み。
接続の初期検証では通常設定の編集、daemonの再起動、threadのresumeやターン開始を行わない。
プロセスの確認では実行パスと既知の接続フラグの有無だけを記録し、コマンド引数全体を出力しない。

## 接続形式

[公式App Server資料](https://learn.chatgpt.com/docs/app-server)では、STDIOはJSONL、Unix control socketはHTTP Upgrade後のWebSocketとされている。
ローカルCLIの`app-server proxy --help`は、稼働中control socketへSTDIOのバイト列を中継すると説明している。
中継先がWebSocketの場合、STDIOへJSONLを送るだけでは初期化できるとは限らない。
#157での15秒の初期化タイムアウトは、正しいWebSocket接続の失敗として扱わない。

初期のcollectorは接続と読み取りに限定する。
`initialize`、`initialized`、`thread/list`、`thread/loaded/list`と、既知の検証threadへの`thread/read`だけを使う。
`thread/read`には`includeTurns: false`を指定し、本文・ツール入出力を取得する試験と分ける。
結果は既知の検証IDと許可した識別・状態フィールドだけへ変換する。
取得した全thread一覧、会話本文、認証値を保存しない。

## ケース別の状態

| ケース | 状態 | 次の確認 |
|---|---|---|
| 共有daemonへのWebSocket初期化 | 実現可能 | proxy経由のHTTP Upgradeと初期化が成功 |
| 検証デスクトップの一覧・loaded・read | 条件付き | 親子のメタデータは読めたが、両方notLoaded。共有daemonのloaded件数は0 |
| 元UIと対話CLIの同時接続 | 条件付き | 指定サーバーへのCLI接続、同turnの完了と設定維持が成功。既存デスクトップは未成立 |
| ツール・ターン・要求解決の購読 | 条件付き | item通知、同turnの完了、許可とキャンセル時の同要求IDの解決を2接続で観測 |
| 接続・切断による元UIへの影響 | 条件付き | CLI退出後も対象threadはloaded。追加threadの出所は未確定 |
| 別HOMEと管理app-serverの代替 | 条件付き | 保存後の同thread再参加、2接続への通知と対話CLIの継続が成功 |

`thread/read`は公式資料上、threadをメモリーへ読み込まず、購読も開始しない。
読み取り成功だけではイベント配信の成功と判断しない。
通常APIと実験的APIは、使用する版の生成スキーマと実応答を照合して記録する。

## 共有daemonでの実測

`app-server proxy --sock`へHTTP Upgradeを送り、WebSocket上の`initialize`と`initialized`が成功した。
`experimentalApi: false`で、通常APIの読み取りを行った。
元のJSONLだけの試験と異なり、初期化は1秒以内に完了した。
従って、#157のタイムアウトを根拠に共有接続そのものを不可能とは判断しない。

#157で作成したデスクトップの親・ネイティブ子に対する`thread/read`は成功した。
両方のstatusは`notLoaded`で、`turns`の本文は返らなかった。
親の名前は検証名と一致した。
子には親thread IDとfork元IDがあり、`sessionId`は子自身のIDだった。
`sessionId`だけから親子の関係を推定しない。

`thread/loaded/list`は打切りなしの1ページで0件を返した。
現在の共有daemonから既存デスクトップの稼働threadを参照できたという証拠は得られていない。
履歴の読み取り成功を、同じ実行の共有やイベント購読の成功と扱わない。
この試験では`resume`、ターン開始、質問や許可への回答を行っていない。

`thread/list`の検証名検索と`useStateDbOnly: true`では一致が0件だった。
同じIDへのreadは成功しているため、検索の0件をthread不在とは扱わない。
一覧の検索対象と状態DBの条件は追加確認が必要である。

## 購読と起動時の条件

`0.160.0`の生成スキーマには`thread/subscribe`がなく、`thread/unsubscribe`がある。
`thread/start`はその接続を自動購読する。
`thread/resume`は稼働中のthreadへ再参加できるが、未ロードのthreadでは実行を読み込む。
また、model、cwd、approval policy、sandboxなどの上書き項目を持つため、購読だけの読み取りAPIとは扱わない。
設定上書きを省略した場合も元UIへ影響しないかは、同じサーバーでの実測が必要である。
別のサーバーから同じthreadをresumeする方式は採用しない。

公式資料の`codex --remote unix://`は、接続先app-serverを指定する起動方法の候補である。
通常の引数なしTUIや既存デスクトップが、同じdaemonへ自動接続することを保証するものではない。
設定ファイルを変更するだけで既存デスクトップを共有接続へ切り替えられるかも、現時点では未確認である。

## 隔離した管理app-serverの起動

認証情報と既存の状態DBをコピーしない専用`CODEX_HOME`で、同じ`0.160.0`を起動した。
私有Unix socketの起動は、パスの指定形式を変えても終了コード1となった。
通常daemonのUnix socketには接続できているため、この結果からWindowsのUnix socket全体を利用不可とは判断しない。
短いHOMEでの再検証と起動エラーの分類が残る。

`app-server --listen ws://127.0.0.1:<port> --ws-auth capability-token --ws-token-file <file>`では起動できた。
専用トークンをHTTP UpgradeのAuthorization headerで送り、2クライアントとも初期化に成功した。
初期化応答のHOMEと版が、専用HOMEと`0.160.0`に一致することを照合した。
トークンの値は証跡へ保存せず、終了時に専用ファイルを削除する。

最初の試験では、Aの`thread/start`に続くBの`thread/resume`がRPCエラー`-32600`となった。
エラーの安全な分類は`thread_not_persisted`だった。
この時点ではターンを開始しておらず、履歴の保存前に再参加する順序では成立しなかった。
起動と認証の成功を、同じ実行への再参加や購読の成功と扱わない。
ターン開始直後の再参加も`-32603`となり、安全な分類では原因を特定できなかった。
保存が完了する前の参加を標準手順にしない。

この試験の終了時には、管理サーバーとfixtureの停止、専用設定の復元、元のfixture設定のハッシュ一致、トークンファイルの削除を確認した。

## 保存後の再参加と通知

最初の固定応答ターンが正常完了した後、Bが同じサーバーの同threadをresumeする順序では成功した。
`experimentalApi: false`で、resumeには`threadId`と`excludeTurns: true`だけを指定した。
model、cwd、承認方針、sandboxの上書きは指定していない。

Aの開始応答とBのresume応答では、承認方針、cwd、model、model provider、sandbox、ephemeralの6項目が一致した。
承認方針は`on-request`、sandboxは`read-only`、ephemeralはfalseを維持した。
loaded一覧は両接続とも1件で、開始したthreadを含んだ。

その後にAが開始した第2ターンは、両接続で同じturn IDの正常完了を観測した。
Bにはitem開始と完了が各2件、turn開始と完了が各1件、thread状態変更が2件届いた。
最初のターンのMCP呼出しはBの参加前に行われたため、Bがそのツール通知を受けたとは扱わない。
要求解決の通知は、この許可要求のない試験では検証できない。

両接続を切断してから接続し直すと、同じサーバーのloaded一覧に同threadが1件残っていた。
再接続ではresumeとターン開始を行っていない。
最終的に、サーバー停止、fixture停止、専用設定の復元、元設定のハッシュ一致、トークン削除がすべて成功した。
実測の識別子と件数だけを残す結果JSONは、無視対象の`poc/out/poc158-managed-first/`へ保存した。

## 対話CLIとの同時接続

AとBを接続したまま、対話CLIを同じWebSocketへ接続し、同threadをresumeした。
CLIから固定入力を送ると、AとBに同じ新規turn IDが届き、両方で正常完了まで観測した。
CLIの終了コードは0だった。
CLI退出後、設定照合のためのresumeより先にloaded一覧を読むと、両接続とも対象threadを含んでいた。
その後の上書きなしresumeでも、開始時の設定6項目が一致した。

remote resumeに`--sandbox`や`--ask-for-approval`を付けると、同じ設定値でも権限上書きとして拒否された。
サーバー側で設定した権限を使い、CLIからこれらの引数を渡さない。
トークンは`--remote-auth-token-env`が指定する環境変数だけで渡す。
誤った専用トークンは`handshake_rejected`となり、初期化前に接続が拒否された。

CLIで既知の検証フックを信頼すると、専用HOMEのconfig末尾にフック信頼情報とTUI設定が追加された。
最初の後処理は完全一致を条件としていたため、復元を拒否した。
修正版は検証用設定のprefixが完全一致する場合だけ検証用の差分を除去し、CLIの追記をそのまま保つ。
prefixの変更は上書きせず、後処理の失敗として記録する。
再検証では検証用設定の除去、CLI追記の保持、元のfixture設定のハッシュ一致、サーバー停止、トークン削除が成功した。
この試験で通常HOMEは変更していない。

CLI接続前のloaded件数は1件だったが、退出後と再接続後は2件だった。
対象threadが維持されたことと、追加threadが生じたことを分けて記録する。
追加試験でも1件増え、本文なしのreadで`source: vscode`、`status: idle`と判明した。
追加threadの親IDは対象threadに一致せず、本文は返らなかった。
私有サーバーの結果であり、このsourceだけから通常デスクトップの接続とは判断しない。
作成理由は特定できておらず、同threadの二重実行とも断定しない。

CLIに表示されたモデルmetadata不足の警告は、固定応答fixtureの架空モデル名によるものだった。
固定応答の表示を実モデルの応答品質の検証とは扱わない。

## 元CLIでの許可とキャンセル

別の専用HOMEと管理サーバーで、`untrusted`と`read-only`を指定して固定コマンドのturnを開始した。
コマンドは`Write-Output POC157; exit 7`であり、許可後の非ゼロ終了を確認するための検証入力である。
Aで許可要求と`waitingOnApproval`を観測した後、本文なしのreadとBの上書きなしresumeが成功した。
Bには同じ保留中の要求が再配信され、その後に接続した元CLIにも確認画面が表示された。
collectorは許可へ回答せず、turnの割込みも行っていない。

CLIで今回だけ許可すると、固定コマンドが実行され、両接続で同じturnが`completed`となった。
コマンドの非ゼロ終了と、モデルのturnの正常完了は別の状態として扱う。
独立した試験でCLIの確認画面をEscでキャンセルすると、両接続で同じturnが`interrupted`となった。
キャンセル後のfixture要求は増えず、固定コマンド後のMCPと最終応答へ進まなかった。

どちらの試験も、各接続に`serverRequest/resolved`が1件届いた。
2接続への同じ要求を重複排除すると、許可要求IDは1件、解決済み1件、未解決0件だった。
Aでは`waitingOnApproval`の開始と解除を観測し、最後に観測したフラグは非activeだった。
Bでは要求の再配信と同IDの解決通知を受けたが、開始フラグの取得は確認していない。
途中参加したBには開始時の状態通知が届かなかったため、要求の再配信だけから開始状態の通知まで保証しない。
本番collectorは接続時の状態照合と、その後の要求解決通知を組み合わせる必要がある。

CLI退出後のloaded一覧と読み取りだけの再接続では、対象threadが1件残っていた。
両試験で検証用設定の除去、CLI追記の保持、元設定のハッシュ一致、サーバー停止とトークン削除が成功した。
固定応答fixtureによる元CLIの許可とキャンセルの検証であり、すべての質問やアプリ操作の許可要求を網羅した結果ではない。

## 管理app-serverの再現手順

検証にはNode.jsと、検証対象の`0.160.0`のCodex実行ファイルを使う。
通常HOMEの認証情報や状態DBを専用HOMEへコピーする必要はない。
固定応答のローカルfixtureを使うため、実モデルへのリクエストは送らない。
出力先はリポジトリ内の`poc/out/`へ限定する。

```powershell
node poc/codex-shared-app-server/run-managed.js --codex-path 'C:\path\to\codex.exe' --out poc/out/poc158-managed-reproduction
```

通常の実行では、2接続での同thread再参加、次のturnの正常完了、設定維持と後処理を検証して終了する。
対話CLIとの同時接続は、同じコマンドへ`--serve`を追加する。
起動後に表示される`ready_file`は専用HOME、接続先、thread IDとトークンファイルの置き場を含む私有ファイルである。
このファイルとトークンは公開しない。

対話CLIにはその専用HOMEを設定し、トークンファイルを読み込んだ環境変数を指定して接続する。
remote resumeへ権限上書き引数は渡さない。

```powershell
codex resume <ready_fileのthread_id> --remote ws://127.0.0.1:<port> --remote-auth-token-env POC158_REMOTE_TOKEN --no-alt-screen
```

専用HOMEで既知の検証フックを信頼し、固定の検証入力を送る。
ターンの完了後にCLIを終了し、最後に管理プロセスへCtrl+Cを送る。
管理プロセスは、設定照合のresumeより先にloaded状態を記録し、CLI由来のturnを両接続で観測したかを集計する。
後処理は検証用設定だけを除去し、CLIが追加した設定を保持する。

## 導入方式の判断

既存デスクトップへの共有daemon接続は、現在の結果だけでは標準方式にできない。
保存済みの識別情報は読めたが、対象がloadedではなく、稼働中の同じ実行から通知を取得した証拠がないためである。
接続設定の追加だけでこの条件を満たせるとは確認していない。

対話CLIは、Agent Cockpit側が管理するapp-serverへ`--remote`で接続する起動方法を導入の前提にできる。
その場合は同じサーバーの同threadを参照すること、保存前のresumeを避けること、権限設定をサーバー側で固定することが必要になる。
WebSocketの接続方式は実験的なtransportであり、`experimentalApi: false`で通常APIを使用できたことと、transportの安定性は分けて扱う。

既存デスクトップには#157で確認したフックとMCPによる識別情報の書き込みを使い、取得できないイベントは未確認として表示する。
collectorの切断中はリアルタイム通知を取得できない。
再接続時のloaded/readによる照合と、切断中の通知を復元できるかの検証は、本番の接続管理で別途必要になる。
次の入力時の配信や双方向連携の可否は、後続PoCで確認する。
本番の接続管理、購読と許可待ち状態照合は[Issue #170](https://github.com/ktysne/agent-cockpit/issues/170)へ切り出した。

## テスト結果と残る制約

初回の試作追加時点（`a359271`）の`npm test`は753件中751件成功した。
その時点でcollectorの20件と管理runnerの11件は成功している。
レビュー対応後の管理runner関連テストは18件すべて成功した。
全体テストは初回の結果であり、最終差分での全体成功を示すものではない。
既存のPR衝突処理の2件は、固定登録時刻と実時計の混在による14日の保存期限切れで失敗した。
対象2件の限定再実行でも再現し、テストプロセスの時計を固定登録時刻へ揃えた切り分けでは2件とも成功した。
PoCの差分に本番コードの変更はなく、この問題は[Issue #168](https://github.com/ktysne/agent-cockpit/issues/168)で別途扱う。

既存デスクトップの稼働実行への接続、一覧の名前検索が0件となる条件、私有Unix socketの起動失敗、追加idle threadの作成理由とworktreeの識別は未確認である。
いずれも今回の成功例から一般化せず、再検証が必要な制約として残す。
質問要求、アプリ操作の許可と切断中のイベント復元は、この固定コマンド試験に含めない。

レビュー指摘への対応後、実nativeサーバーへの接続直後にSIGINTイベント、fixtureの後処理中にSIGTERMイベントを注入する試験を行った。
起動中の処理は`interrupted_by_signal`で終了し、所有サーバーとfixtureの停止、専用設定の復元、元設定のハッシュ一致、トークン削除とハンドラー解除が成功した。
シグナルのハンドラーを制御して検証した結果であり、OSによる強制終了や電源断後の復旧を保証するものではない。

クロスレビューはagent-cockpitの経路設定に従いCodexで3往復実施し、3回目は指摘なしで収束した。
レビューでは静的確認を行い、実行検証の結果は上記の試験記録と分けて扱った。
