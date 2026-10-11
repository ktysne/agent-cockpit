# Claude wait再接続の限定観測

#314は、collector再接続で失効したwaitの後に実Claudeが進めるかを確認する。
過去の[短時間実測](native-handoff-live-reconciliation.md#再接続の短時間実測)はwait失効とprocess生存までを確認し、通常のsettle要求と次contextの取得を行っていない。
現在の[wait契約](owned-native-claude-wait.md)を維持した手動観測器で、この不足を測る。
この観測器は製品の認可や待機の実装を変更しない。
実行前監査で見つけた[Windows home環境の不一致](https://github.com/ktysne/agent-cockpit/issues/372)は、既存owned runnerのHOMEPATHを修正して対応する。

## 正規操作と観測の区別

実registration、launch、runtime kernel、composition、owned runnerとcollectorを使う。
wait ownerの通知callbackはhandleをメモリーに保持するだけにし、callback完了後に通常のsettleWaitを一度だけ呼ぶ。
通知回数は単一listenerへのcallback回数として記録する。
失効したhandleの拒否も有効な観測結果であり、拒否後にraw HTTP、runner内部操作や別promptで救済しない。

settleの受付、新contextのnative到着、通知後checkpointのcurrent fresh proof、物理停止は独立の観測である。
settleがtrueでもCLIへの応答到着と次contextを証明したとは扱わない。
collectorの世代増加やprocess生存からcontextやproofを作らない。
native到着は同期callbackで保持し、proofはwait transitionの完了後にsetImmediateのcheckpointで確認する。
このcheckpoint前にcontextが終わればproofを取り逃し得るため、未確認から過去のproof不存在を導かない。
Bの後にCが到着した場合もあり、checkpointのcurrent proofがBに対応するとは扱わない。
proof未測定はnullとし、測定済みの確認結果と区別する。
公開観測口から直接測れないresponse writeは未観測として記録し、settle回数を実response回数へ読み替えない。

## 実行の範囲

defaultとpreflightはCLIをspawnせず、認証secretを取得せず、networkと通常HOMEの認証や設定へアクセスしない。
指定した実行ファイルの存在確認は行うが、versionの取得はlive時だけにする。
明示live実行は固定profile cockpit-native-wait-v1と固定promptを使い、任意tool、CLI引数、MCP設定を受け取らない。
promptのnonceだけは各caseで生成する48桁のhexとし、識別子を結果へ記録しない。
実行したCLI版を記録し、過去の2.1.292との一致は要求しない。
認証は既存の承認済みreadonly取得か環境OAuthをメモリーで渡し、新ログインや認証コピーをfallbackにしない。

controlとreconnectは別processと別専用rootで行う。
controlはAの有効baseline proofを確認して通常settleし、distinct context Bの到着と通知後checkpointのcurrent fresh proofを観測する。
controlが成立しなければreconnectを起動せず比較不能とする。
reconnectはAの保持後にcollectorをdisconnect/connectし、旧handleのcurrent判定と通常settle一回の結果、その後のBを期限付きで観測する。
再接続前のhandle有効性、disconnectの成立とconnectの成立を確認できない場合はsettleせずunknownにする。
current判定とinvalidation通知は別に記録し、通知が発火しなくても旧handleの判定とsettleを行う。
invalidationNotificationObservedはreconnectでだけ計測し、controlのfalseは非観測の初期値である。
固定理由と段階fieldは限定診断であり、接続失敗の原因を一意に証明しない。
Bなしやunsupportedは未確認として残し、自動再送しない。
実runtimeが未実行ならfixtureの成功で#314を完了扱いにしない。
観測器のstatusがobservedでも、再接続後のB取得や実runtime適合が成功したとは扱わない。
これはcontrolの条件、旧handleへの正規操作とcleanupを観測できたという分類である。

## 実行方法

`node tools/manual/claude-wait-reconnect-probe.js` は無spawnのpreflightだけを行う。
既存のOAuthを呼出側から環境へメモリーで渡し、`node tools/manual/claude-wait-reconnect-probe.js --live` で明示実行する。
tokenを引数やファイルへ保存しない。
liveは実行ファイル確認、隔離したversion取得、control、reconnectの順で進む。
前提不足や停止未確認では後続を起動せず、固定理由と観測結果をJSONで返す。
観測器の終了codeはpreflightがreadyまたは実行結果がobservedなら0、それ以外は1、不正引数は2である。

## 所有と終了

rootはリポジトリの既知ignored親に新規作成し、home、cwd、temp、cacheとconfigを配下へ固定する。
child環境は既存runnerの固定allowlistと隔離設定を確認し、親のHOMEを変更しない。
WindowsではHOMEDRIVEとHOMEPATHの結合が絶対pathとなり、指定HOMEとUSERPROFILEへ一致することを検証する。
例外と期限切れでもcomposition stopを一度開始し、child exit、close、owned child inactiveとwait endpoint inactiveをそれぞれ確認する。
全条件を確認した後に、生成時とcleanup時に解決した自己rootだけを削除する。
停止未確認ならrootを保持し、次runを開始しない。
停止Promiseの解決やkill返却だけを終了証拠にしない。

## 記録の境界

runtime結果は実runtime版、case、phase、固定理由、boolean、counterと未観測nullをallowlistで投影する。
実測記録には別のmanifestとしてsource revision、script hashと固定profileを記録する。
native ID、handle、nonce、token、環境値、認証情報、HTTPのURLとheader、stdout/stderr、入力と応答本文、例外messageとstackを記録しない。
context A/Bの同一性はメモリー内で比較し、識別子を保存しない。
hash対象はscriptとsanitized resultに限定する。
raw frameや秘密を含む値のhashを共有証拠へ残さない。
未実行、期限到達、認証取得不可、比較不能と停止未確認を成功や同等へ読み替えない。

## fixtureと採用条件

[provider適合試験](provider-conformance-testing.md)のID-F314-WRP01〜WRP08を実装前に記録する。
fixtureは観測器の計測と終了条件を確かめ、実CLI能力の証明とは分ける。
専用ファイルのnode --test報告件数はsubtestを含む19件で、すべて成功した。
baseline proof欠落の分岐と、観測終了後のcallback guardへ直接到達するfixtureは未確認であり、source監査の結果と区別する。
disconnectがdisconnected以外を返す場合とconnectがconnected以外を返す場合は、実装上settle前にunknownへ進む。
この2分岐を直接通すfixtureは未実行で、当該分岐のsettle回数0、物理停止確認とroot削除の組合せを検証した証拠はない。
collector.connectの同期throw、controlのsettle拒否後の待機省略とliveの部分root作成失敗も直接fixtureでは未確認である。
finallyへの到達は物理停止やroot削除の成功と別であり、停止確認が成立しなければrootを保持する。
これらの未到達分岐と実runtimeの成功は、専用fixture19件の合格に含めない。
停止処理の開始前に観測を閉じ、製品callbackを維持したまま遅延通知による結果の変更を防ぐ。
既存fakepipeで旧waitの拒否を確認しても、実Claudeがその後に進むという期待を捏造しない。
実測でparserの非対応、認証失敗、隔離不能またはcontrol未達が見つかったら固定分類で停止し、製品修正へ範囲を広げない。
常駐server、tray、ensure、PRマージと未収束#364の管理protocolを操作しない。

## 実Claudeの観測結果

2026-10-11、Windows、Node 24.15.0、Claude 2.1.296で明示live観測を一度実行した。
source revisionは`b4410883c9ccd4d80e5336de0611e1f318deccca`、profileは`cockpit-native-wait-v1`である。
script SHA-256は`8f5d0852e960d3cb3356d7001b7ded254daa8082f3eba5f82f13a9c2486f7d8d`、sanitized result SHA-256は`9cd1ddee9524dc8dd5e1e97ddf1fb351a05953e945b45a3f2244ad9a17b3e38a`である。

| 観測 | control | reconnect |
| --- | --- | --- |
| wait通知回数 | 1 | 1 |
| 操作前handle有効 | true | true |
| collector切断・再接続 | 対象外 | 正規操作で成立 |
| 再接続後旧handle有効 | 対象外 | false |
| settle試行回数・受付 | 1・true | 1・false |
| distinct context到着 | true | 90秒の観測期間内に到着せず |
| proof checkpoint・fresh current proof | 完了・true | 未到達・null |
| child exit・close・child inactive・endpoint inactive | すべてtrue | すべてtrue |
| 自己root削除 | true | true |

reconnectのinvalidation通知はfalseで、controlは非観測の初期値である。
実response writeは両caseで未観測nullのままである。
観測器全体のstatusはobservedだが、再接続後の進行と#314の完了を示さない。
失効後の通常settle拒否と観測期間内のB未到着を確認した結果であり、再接続後の進行方法は未解決である。
旧handleの再送、raw操作、新promptによる救済は行っていない。
