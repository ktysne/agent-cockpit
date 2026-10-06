# ClaudeとCodex混在時のPRとレビュー通知PoC

[Issue #164](https://github.com/ktysne/agent-cockpit/issues/164)と[親計画 #156](https://github.com/ktysne/agent-cockpit/issues/156)の検証記録。
PoCの調査完了、採用条件の達成、本番機能の完成を区別する。
本番モジュールの変更と実際の開発PRのマージは対象に含めない。

## 開始点と隔離

開始点は#162の最終コミット`b03ccdaff00fde22371e1bc1eb394de134b09d65`、ブランチは`codex/poc-164-pr-review-notifications`。
`D:/Desktop/Develop/agent-cockpit`から専用Codex管理worktreeを作成し、既存チェックアウトを切り替えていない。
#163の未コミット変更、`poc/codex-vendor-routing/`、`docs/poc-codex-163.md`は取り込まない。
変更先を本PoCのディレクトリと本書に限定する。
新worktreeに`.codegraph/`がないため、規約に従い索引の新規作成を省略した。

試験の保存先は新規の`poc/out/poc164-*`、Cockpitの待受は`127.0.0.1`のポート`0`で分離する。
専用Codex HOME、MCP fixture、Cockpit認証、偽gh、出力を分け、通常ホームとdaemon、既存チャットを変更しない。
認証情報と会話本文を文書、Issue、コミットに残さない。

## 使用環境

2026-10-06（日本時間）の開始時に、Node `v24.15.0`、Codex CLI `0.160.1`、Claude CLI `2.1.291`を取得した。
Codexアプリのパッケージ版は`26.930.6422.0`、アプリ同梱runtimeは`0.160.0`だった。
通常daemonはサンドボックス内で接続制限、サンドボックス外でも接続拒否となったため、稼働版は未確認。
厳密な版一致を要求せず、使用した実行ファイルごとの版を記録する。

## 証拠の区分

仮契約のモデル試験、既存本番モジュールへの偽gh注入、専用サーバーのHTTP、実Codex runtimeのMCP、実レビュアーの出力を別々に記録する。
fixtureのproviderと親子登録は、Claudeまたは本番bridgeがその起動を行った証拠にはしない。
通知のキュー登録、宛先選択、通信受付、入力適用は別の状態であり、受付後の適用未確認を成功とせず、自動再送しない。
表示先はAgent Cockpitダッシュボードで、Codex内部ブラウザへの表示は対象外。
画面の変更はなく、既存モックのマージ確認とレビュー収束後予約の仕様を試験の基準にする。

## #163と照合する契約

#163の実装を直接importせず、`fixture-contract.js`に#164が必要とする最小契約を定義する。
以下は仮契約による試験であり、#163実連携の成功とは扱わない。
モデルの更新入力は信頼済みfixture callerを前提とし、起動登録やexit証拠の送信元認証は本番adapterの追加試験に残す。

| 契約 | #164が照合する条件 |
|---|---|
| 実行の帰属 | launchId、runId、attemptId、provider、親session/agent/tool-use、scope付きvendor native IDの明示的対応 |
| 観測の統合 | shell、native子、外部runnerは登録済みの同じ正規実行へ結ぶ。PID、cwd、時刻の近さで推測しない |
| 起動時の固定 | vendor、model、effort、transportのsnapshotを開始時に保持する。設定更新は次の起動にだけ適用 |
| 結果と終了 | 結果受領、子終了確認、親返却を区別する。終了未確認と親終了後を成功または再開にしない |
| cancel | 要求と確定を区別し、取消要求中も通常の配送を保留する |
| 通知 | PRイベントと正規宛先attemptを照合し重複を防ぐ。終了した子へ遅い通知を再送しない |

## 判定と採用条件

| Issueのケース | 判定 | 根拠と未確認の範囲 |
|---|---|---|
| 1：Claude、独立Codex、Claude配下CodexのPR登録 | 条件付き | 既存stateは同一PRを3つのfixture sessionへ登録し、同session再登録を1件にできた。provider/run/attempt/native IDは残らず、共通識別の本番実装が必要。仮契約のMCP/gh経路統合と実runtimeのmetadataは別判定 |
| 2：review分類、往復、結論、収束head、routing | 条件付き | 仮契約でpurpose=reviewと起動時routingを固定し、shell/native/externalの観測を同一実行へ統合する。本番review collectorと#163 runnerの実連携は未確認 |
| 3：メインと子の作成元、親の稼働、停止、終了 | 条件付き | 仮契約で作成元と登録者を分離し、結果受領/子終了/親返却とcancel要求/確定を別々に照合。本番PR登録はこれらの識別を持たず、実Claude親子は未確認 |
| 4：マージ結果、衝突、積み直し | 条件付き | 既存コード＋偽ghで3方式を確認。squash/rebaseは上PRへ積み直し依頼、merge commitでは出さない。衝突依頼は終了sessionを除くが、マージ通知は終了sessionにも追加される。本番通知台帳が必要 |
| 5：元実行への配信、再接続、通知重複 | 条件付き。実vendor適用は未確認 | 既存notifySessionsへ同じ通知を2回追加すると2件届く。仮契約でイベントと宛先attemptを照合する。通信受付/適用、既存デスクトップと実UI競合は成功扱いしない |
| 6：最下段、画面head、収束head | 実現可能（既存コード＋偽ghの境界） | head/base/非最下段/gh直前head変更/子base変更後の親base変更でmerge呼出し0。予約後の新headが最新レビューで収束した場合はそのSHAを--match-head-commitに指定。実GitHubマージは行っていない |
| 7：古い収束、未レビューcommit、予約取消、遅い通知 | 条件付き | 既存予約はstale convergenceと未レビューheadでmerge0、予約取消もmerge0。仮契約は最新roundと終了済み宛先を照合。本番の遅いマージ通知抑制は未実装 |

既存コードで合格したマージ境界と、provider/配信の本番未対応を分けて採用する。
本番対応は[Issue #179](https://github.com/ktysne/agent-cockpit/issues/179)へ切り出した。
#166/#171の識別と#175/#177の配信復旧を共用し、#179を別途二重計上しない。

## 既存コードの実測

`poc/out/poc164-existing-final/existing-probe-result.json`で18ケースを測定した。
Claude、独立Codex、子Codexという3ラベルは合成したsessionで、実vendorの起動ではない。
同sessionの再登録は1件、異なるsessionの登録は3件となり、provider/run/attempt/native IDの項目はなかった。

手動head不一致、base不一致、非最下段、gh直前のhead変更、子base付替後の親base変更は409で、fake gh mergeは0件だった。
子base付替後に不一致が発覚したケースは、子PRのbase付替1件がすでに発生している。
予約の古い収束と未レビューheadは予約を保持してmerge0、取消は予約取消通知を追加してmerge0だった。
予約後にheadを新しい完全SHAへ変え、そのheadを最新roundで収束させた場合は、mergeが1回、その収束SHAの照合が成功した。

squashとrebaseでは上のPRへ`git rebase --onto`による積み直し依頼が追加され、merge commitでは追加されなかった。
同じmanagerへの同じマージ検出は重複を抑えた。
終了済みsessionにもマージ結果通知は追加されたが、衝突解消依頼では終了sessionを除外した。
同じ通知を別々に2回`notifySessions`へ渡すと、受取側の文字列には2件あった。
これらは本番不足を再現した測定であり、通知機能の合格とは扱わない。

gh成功後のPRがOPENならqueuedでmerged=false、通知0件だった。
gh成功後に状態を取得できないと502、merge intentを保持し、完了通知は0件だった。
不明なマージ方式から積み直し方式を推測しない。

専用CockpitのHTTPはstate取得200、fixture PRのsnapshot取得成功、秘密値なし401、異なるOrigin403、Origin欠落403、不正Host400、cross-site403、現行UI秘密値と正しいOrigin200だった。
受理された予約manager呼出しは1件、実gh呼出しは0件。
HTTPサーバー終了と専用fixtureの後処理を確認した。
この測定はHTTP snapshotと認証境界の確認であり、実ダッシュボードの描画と実操作を確認した証拠にはしない。

## 初回試行と修正

既存probeの初回はfixture homeDir未作成による保存writerの失敗だった。
その後、共有PRオブジェクトへのhead変更が後続caseに漏れ、OPEN/未確認試験がhead不一致で止まった。
`poc164-existing-d`の結果はこの測定不備を含み、queued成功の証拠に使わない。
PRをfixtureごとにコピーし、開始時刻を注入した`poc164-existing-final`で再測定した。

モデル試験の初回は20件中16件成功で、通知先と積み直し先の未登録、非同期アサーション、並び順期待値に試験側の不備があった。
native probe単体試験の初回は9件中8件成功で、残りはWindowsパスのTOMLエスケープを確認する正規表現の不備だった。続く試行では終了確認テストのPID前提が合わず1件失敗し、試験入力を直した。
これらを既知#168の時計依存失敗や実vendorの不具合へ分類しない。

新worktreeにCodeGraph索引はなかった。
担当が試したCLI同期は共有索引lockへのEPERM、MCP exploreはTransport closedで失敗した。
索引の新規作成は行わず、通常のコード読取りで検証した。

## 親計画への反映案

親#156の本文は#163の担当も更新するため、本PoCから同時上書きしない。
#164の結果と本番改修Issueを本Issueへ先に記録し、担当が反映できる状態にする。
全体の概算26〜42人日、管理app-server接続の追加5〜10人日を維持する。
切り出す本番Issueは既存の共通provider/親子、PR/レビュー、通知配信の対応範囲に含め、追加として二重計上しない。

## 導入条件と追加試験

共通provider/native識別と認証されたrunner起動登録は、本番MCPの#166とbridgeの#171に依存する。
Codex向け通知の適用確認は、管理app-serverの#170、配信台帳の#175、復旧照合の#177と同じ宛先契約を使う。
利用者の導入設定だけで既存のClaude向けセッション解決や通知台帳を補えるとは判定しない。

管理app-serverを採用する場合は、専用HOME、接続するCLI、信頼済みMCP、認証されたcollectorを導入手順で示す必要がある。
通常ホームの設定はこのPoCで変更していないため、現時点で利用者へ設定変更を要求しない。
本番コードを実装した後に、実Claude、独立Codex、Claude配下Codexを同時に起動し、MCPとgh出力の同一PRをダッシュボードで照合する。
通知は親の稼働、停止、終了、子の終了、cancel中、再接続、受付応答喪失を実vendorで比較し、同じ入力itemまで照合する。
終了未確認を終了済みへ、通信受付を入力適用へ推測で置き換えない。

[OpenAIのapp-server公式資料](https://learn.chatgpt.com/docs/app-server)は`mcpServer/tool/call`とthread単位の通信を説明している。
本PoCではインストール済みruntimeの実測を優先し、公式資料だけを実測成功の根拠にはしない。
MCPの追加metadataと実行の親子対応の継続的な取得は、本番導入時に再検証する。


## 実Codex runtimeの測定

専用HOMEとapp-serverで`initialize`、独立した2つの`thread/start`、それぞれの`mcpServer/tool/call`を実行した。
initializeが報告したruntimeは`0.160.1`。
MCPの`_meta.threadId`は2回とも開始したnative thread IDと一致し、異なるnative IDを2件取得した。MCPのmetadataキーはprogressTokenとthreadIdで、CODEX_THREAD_ID/SESSION_ID/AGENT_ID/TURN_IDの4つの環境変数はなかった。
同じfixture PRキーへの呼出しは2回、集約したPRキーは1件、metadata欠落は0件だった。

MCPサーバーはthreadごとに別プロセスで起動し、各プロセス内の登録結果はそれぞれcreatedだった。
プロセス横断の集約は観測結果の比較であり、本番Cockpitの重複排除が動いた証拠ではない。
直接RPCを使い、推論モデルを呼んでいないため、モデルとeffortの実推論metadataは対象外。
Claude起源、親agent/tool-useとnative子の関係、実gh pr createの出力はこのnative試験では取得していない。

専用app-serverは強制終了せずexit code 0で終了した。
MCPの開始PID2件について、試験後に両方が存在しないことを確認した。
stdin閉鎖とexit通知は0件で、終了確認の根拠は所有するfixtureの開始PIDが存在しない観測である。
PIDは実行の帰属や別runの結合に使っていない。
専用HOMEにauth.jsonはなく、専用tempの後処理も成功した。
通常daemonと既存チャットは変更していない。

結果は`poc/out/poc164-native-a/native-results-*.json`。
stdoutは7,959 bytes、stderrは420 bytesで、記録上限超過とcapture不正行は0件だった。
stderr本文、認証、会話本文を共有記録に含めない。

## 再現手順

新しい`poc/out/poc164-*`出力先を使う。
出力先が存在すると拒否されるため、再試行ごとに別名を指定する。

```powershell
node --test --test-isolation=none poc/codex-pr-review-notifications/*.test.js
node poc/codex-pr-review-notifications/existing-probe.js --out poc/out/poc164-existing-repro-a
node poc/codex-pr-review-notifications/native-probe.js --codex-path <Codex実行ファイルの絶対パス> --out poc/out/poc164-native-repro-a
```

existing probeはNodeだけを使い、18ケースの結果を`existing-probe-result.json`へ保存する。
native probeは別HOME、別作業ディレクトリ、限定した子環境とSTDIOを使い、GitHubや推論APIを呼ばない。
MCPへの直接RPCを実行しても、本番MCPを導入したことにはならない。
各試行の`success`と`cleanup`、ケース別の回数と判定を確認する。

## #163との照合状況

最初の照合時点（2026-10-06 17:04、日本時間）は#163の結論が未共有だった。
その後、[Draft PR #181](https://github.com/ktysne/agent-cockpit/pull/181)の公開文書をcommit `66f89395b010e5aeddb5565ce1b1eba4b8a8af50`で読み、仮契約と照合した。
さらに最終commit `84ef60e2ae2bdff10956181a147703ced7e65df8`の変更文書と2往復目の収束コメントを読み、#163が調査完了として閉じられたことを確認した。
作業中モジュールのimportと#163のファイル変更は行っていない。

| 照合対象 | 確認結果と#164側の扱い |
|---|---|
| launch/run/attempt、親、native帰属 | 明示識別を要求する方針は一致。#163はClaude sessionIdとCodex threadIdを区別し、provider/ID種別/host/HOMEのscopeを要求する。#164のopaqueなscope/nativeIdは最小fixtureであり、本番adapterでそのscopeへ写像してから結ぶ |
| 起動時routing固定 | vendor/model/effort/transportを固定し、新規起動だけ設定を変える方針は一致。#163でも実runtimeの共通routing自動適用は未確認 |
| 結果、終了、親返却 | 受領/終了/返却の分離は一致。known exit後に初めて来た結果を拒否する条件を#164へ追加。#164の終了更新は明示fixture入力であり、実exit証拠の妥当性を検証したものではない |
| cancel | 要求/確定を分け、終了証拠なしに確定しない条件を#164へ追加。#163のowned Node終了試験は実Claude稼働中cancelの証拠ではない |
| shell/native/外部runner統合 | 明示bindingで結び、PID/cwd/時刻で推測しない方針は一致。#163も本番collector/bridgeの統合と実runの重複排除を未確認としている |

#163の共有結果は固定課題のClaude実測とCodex native子の結果受領を含むが、#164のPR登録または通知適用を測った証拠ではない。
#163の本番改修[Issue #180](https://github.com/ktysne/agent-cockpit/issues/180)と#179でlaunch登録とexit/cancel証拠を接続する。
予約と起動許可、vendor別native schemaは#163側の責務で、#164のfixtureは本番の完了を仮定しない。
親session終了はprovider/sessionId単位で全agentへ反映し、子登録前の終了も保持する最小fixtureを#164へ追加した。親終了を子終了やcancel確定の証拠に置き換えない。
実行providerと起動時vendorは一致を要求する。externalは合成した第三providerで、Claude外部runnerの実providerをexternalへ書き換える意味ではない。
実イベントの写像、実review起動と通知先の受付/適用は引き続き未確認。
独立したPR境界、HTTP、実runtimeのMCP metadataの調査は完了できる。

## 試作の保存とgh出力境界

モデルのsnapshotは実行、通知台帳と親session終了台帳を保存し、PR一覧、レビュー台帳、予約の永続復旧を実装しない。
結果はresult IDとdigestで照合し、終了後の初回結果を拒否する。終了前に受領した同一結果の再通知だけを冪等として保持する。
受付不明の通知はunknownへ固定し、再起動後の稼働確認まで配送しない。
終了済み親と実行を稼働中へ戻さず、再起動を繰り返しても終了状態を保持する。
これらは#162の未確認入力を自動再送しない条件を引き継ぐfixture試験である。

`gh-output-adapter.js`は登録済み実行と明示的source item/native bindingが一致する、成功済み`gh pr create`の合成出力だけを受ける。
Codexのwork目的だけを受け、独立または委譲の作成元を保持する。Claudeとreview目的の実行はこのCodex専用adapterで拒否する。
上限64 KiB、完了状態、exit code 0、唯一のGitHub PR URLを確認し、同じitemとPRの再通知は登録を増やさない。
複数PR URL、欠落binding、別attempt/native ID、不成功または未完了の実行は拒否する。
このadapterは仮の正規eventを受ける試作であり、Codex実eventのcommand文字列からargvを抽出する本番collectorと実gh呼出しは未確認。


## 調査の結論

PRのGitHub処理とマージ前の照合は共用する方式を条件付きの採用候補とする。
作成元と登録経路の識別、review専用の分類、実行の終了を照合する通知台帳は本番改修#179と#180で接続する。
既存処理の通知重複と終了後通知の再現、境界試験、実runtime metadata、#163の共有文書照合により、独立したPoC調査としての結果を揃えた。
本番の採用合格、本番機能完成、実vendorへの通知適用は未達である。

今回の実装者はCodex。
指定により同ベンダーCodex経路でクロスレビューを行い、実行直前に現在のrouteを毎回読む。
既存設定を変えず、実際のmodel、effort、CLI版、対象head、指摘と対応、収束は本PRの往復別コメントに記録する。
調査の結論を本番機能のレビュー収束または本番PRのマージ許可とは扱わない。

## レビュー前の検証集計

コード確定後の関連試験は51件すべて成功（model 30、gh output 11、native 9、existing probe 1）。
existing probeの1テストは18ケースの観測結果をまとめて検査する。
全体`npm test`は971件中969件成功、2件失敗、約15.05秒だった。
失敗は既知[Issue #168](https://github.com/ktysne/agent-cockpit/issues/168)の`test/pull-requests.test.js:617`と`test/server.test.js:184`の時計依存で、新規PoC失敗とは分ける。
子プロセスを起動できる実行環境で全体検証したため、ensure-serverも実行した。

主セッションが担当の書き込み完了前に関連試験を始めた試行は、途中のテストファイルを読み構文エラーになった。
`poc164-focused-final.log`はその途中試行であり、合否の根拠には使わない。
確定後の関連結果は`poc/out/poc164-focused-frozen.log`、全体結果は`poc/out/poc164-full-final-test.log`。
raw記録はコミットせず、文書の集計とPRの検証記録で共有する。

## クロスレビューの実測

今回の実装者はCodexで、指定により同ベンダーCodex経路を実行した。
レビュー開始直前のrouteはcodex。
既定のcodex-agent.sh bridgeはbashが見つからず起動できなかったため、スキルの`--no-codex-agent`で直接起動した。
既存route、model定義、通常ホームの設定は変更していない。
実レビュアーはCLI`0.160.0`、`gpt-6.1-sol`、effort`medium`、read-only。
専用app-server測定のruntime`0.160.1`とは用途を分ける。

1往復目の対象headは`477534c88fa9d4103efaed6abe8e1de9e5f59e9c`。
PRのbase `origin/codex/poc-162-recovery-reconciliation`からの差分187.1 KiBを省略せず確認し、要修正3件と提案1件を受領した。
指摘は複数上位PRのrestack通知ID衝突、app-server stdin errorの未処理、応答待ちのbase変更見落とし、MCP設定見出しの検査だった。
通常hookのPostToolUse/Stop警告を伴ったが、CLIは終了コード0で指摘を保存した。
この警告を専用runtimeの故障またはレビュー収束とは扱わない。

[Draft PR #182](https://github.com/ktysne/agent-cockpit/pull/182)のスキル生成コメントへ指摘、裏取り、対応、関連検証、各往復の結論を記録する。
収束headはPRの最後のconvergedコメントと状態記録を参照する。

## 指摘対応後の実runtime再測定

stdin error対応後のnative probeを新規出力`poc/out/poc164-native-final/`で再実行した。
app-server `0.160.1`、2 RPC成功、同一PRキー1件、異なるnative thread ID2件、両threadとMCP metadataの一致、欠落0件を再確認した。
app-serverは強制終了なしのexit 0、MCPの所有PID2件は終了後に不在、専用HOMEのauth.jsonなし、temp後処理成功。
stdoutは8,027 bytes、stderrは420 bytes、出力上限超過なし。
本番Cockpitの重複排除、モデル呼出し、Claude起源、親子関係、通知適用の未確認は維持する。

入力切断の単体試験は模擬した子とpipeの異常系を含む。
通常経路の実Codex再測定と、模擬のstdin error伝播を別の証拠として扱う。

## 1往復目の対応後の検証

restack通知IDへ上位PRの正規キーを含め、同じrunが複数上位PRを担当しても通知を欠落させない。
merge呼出前のbaseとheadを固定し、応答後の不一致はunknownとして完了と積み直し通知を抑止する。
stdinのerrorをRPCと通知の共通失敗へ接続し、通常の結果保存とcleanupへ進める。
provider/vendor一致、親session全体の不可逆な終了、登録前終了、復元後の通知/再開拒否は#163最終契約と照合した。

修正後の関連60件はすべて成功、skipは0件（model 35、gh output 11、native 13、existing probe 1）。
結果は`poc/out/poc164-review-1-fixed-test.log`。
レビュー修正は専用PoCだけなので関連試験を再実行し、既存本番テストを含む全体集計はレビュー前の971件中969件成功を参照する。

追加の実Node子はstdin pipeを先に閉じ、READY後のRPC書込1回を確認してから制御pipeで終了させた。
保留RPCはapp_server_exitedで拒否され、finallyで所有する子のcloseを確認した。
実EPIPEは観測できず、stdin error伝播は模擬pipe試験と区別する。
初回の追加fixtureは子スクリプトの改行エスケープ不備でREADY未到達だった。
続くfd0閉鎖だけの試行はWindowsのwriterへ切断が伝わらずtimeoutとなり、実EPIPE成功の証拠には使わない。
READYと書込を観測した後のtimeoutや未分類をskipで隠さない試験にした。
