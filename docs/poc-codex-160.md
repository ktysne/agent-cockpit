# Codexの質問回答と実行許可の分離PoC

## 目的と範囲

[Issue #160](https://github.com/ktysne/agent-cockpit/issues/160)の検証記録。
通常の判断に対する回答と、離席期限後に推奨で仮に進む動作を試作する。
実行許可、ネットワーク許可とコネクターの操作確認は自動回答の対象に含めない。
表示先はAgent Cockpitのダッシュボードとする。

本書は最小試作の調査結果であり、本番対応の完了を意味しない。
専用HOMEの固定fixtureと注入時計による状態試験を、実時間の待機や既存デスクトップの実測と分けて扱う。
通常HOME、既存チャットと既存bridgeは変更しない。

## 検証環境

2026-10-06の開始時に、CLI、アプリ同梱実行ファイルとdaemonの配置済み実行ファイルがすべて`0.160.0`であることを確認した。
#158の管理app-server接続と#159の登録済みnative宛先照合を前提にする。
通常daemonで保存済みthreadを読めることを、既存デスクトップの稼働実行を制御できることとは扱わない。

## 検証計画

1. ネイティブ質問の入力と回答を生成スキーマと固定fixtureで調べ、モードごとの利用可否を記録する。
2. 共通質問モデルを試作し、単一選択、複数選択、自由記入、保留、キャンセルと推奨を検証する。
3. 期限前、期限ちょうどと期限後の回答、元UIとの競合、遅い回答と二重回答を検証する。
4. 長いMCP待機と短いpollを比較し、実時間の測定範囲と1〜30分の時計注入試験を明示する。
5. 実行許可と通常の判断を分離し、不明な由来の質問を自動適用しないことを確認する。
6. 選択回答と推奨の仮適用を区別し、採用方式と本番実装の範囲を記録する。

## ネイティブ質問の入力契約

0.160.0の生成スキーマでは`isBlocking`が必須で、`autoResolutionMs`は非推奨の項目である。
質問はID、headerとquestionを持ち、optionsは配列またはnull、isOtherとisSecretは任意である。
複数選択を指定する項目はない。
応答は質問IDから`{answers: string[]}`への対応である。
配列型の存在だけでは、元UIが複数選択へ対応する証拠にならない。

Planを指定する`turn/start.collaborationMode`はexperimentalの項目である。
0.160.0の`app-server generate-json-schema --experimental`で生成したスキーマでは、modeに`plan`または`default`、settingsにmodelを指定する契約を確認した。
通常の生成スキーマに項目がないことを、ランタイムで利用不可である証拠にはしない。

現行の[公式app-server資料](https://learn.chatgpt.com/docs/app-server)では、通常質問のほかにアプリ操作の許可も質問経路を使うと説明されている。
要求メソッドや選択肢の文言だけで通常判断と認定せず、発行元と関連するitemを照合する必要がある。
公式資料の`autoResolutionMs`の説明と対象版スキーマとの差は、対象版の実測で確認する。

## 結果と採用判断

共通質問MCPをDefaultの通常判断の標準とする。
ネイティブ質問はPlanで選択と自由記入の回答を確認できたが、本番での由来の識別と元UIとの競合を確認するまで自動回答へ取り込まない。
ダッシュボード配送、実UI競合と実時間の最大待機を確認していないため、Issueの採用方式の合格条件は未達である。

| ケース | 判定 | 根拠と残る条件 |
| --- | --- | --- |
| 1. モード別のネイティブ質問 | 条件付き | 専用app-serverのPlanで選択・自由記入を確認。Defaultのapp-serverとexecでは利用不可。既存デスクトップ、対話TUIとnon-blockingは未確認。 |
| 2. ネイティブと共通MCPの比較 | 条件付き | 共通MCPはDefaultのexecで登録・pollが成功。ネイティブはPlanに限定。本番の由来認証は未実装。 |
| 3. 質問形式 | 条件付き | 共通モデルは1〜3問、単一・複数選択、自由記入、保留と推奨を扱う。native実測は単一の選択または自由記入で、複数選択の元UIは未確認。 |
| 4. 期限と回答競合 | 条件付き | 注入時計とモデルで期限前・同時・後、遅い回答、二重回答、キャンセルと競合を確認。実UIのRPC競合は未確認。 |
| 5. 最大待機とtimeout | 条件付き | 即時pollは成功。2秒設定で2.6秒遅延はtimeout。1〜30分の期限境界は時計注入のみで、実時間・フック・切断は未確認。 |
| 6. 許可要求の除外 | 条件付き | 共通モデルは許可カテゴリと不明な由来を拒否し、MCPに許可応答APIはない。本番collectorでのアプリ操作の分類は未確認。 |
| 7. 選択と仮適用の区別 | 実現可能 | 共通モデルとMCP固定fixtureでchosenとprovisionalを別に保持。本番保存と表示は未実装。 |

関連テスト44件が成功した。
`npm test`は829件中827件成功し、失敗2件は既存の日時依存問題[Issue #168](https://github.com/ktysne/agent-cockpit/issues/168)だった。
全体テストのログは`poc/out/poc160-full-tests.log`に保存した。

共通モデルの状態試験は15件成功した。
1・5・30分それぞれについて、注入時計で期限の1ms前、期限ちょうどと1ms後を確認した。
3問すべてに明示的な単一選択の推奨がある場合は全件を仮適用し、1問でも推奨が欠ける場合は全件を回答待ちのままにした。
元UIとダッシュボードの回答競合、保留、キャンセル、外部解決と配送のclaim／ackは、メモリー上のモデルの検証である。
実UIや実RPCで同じ結果になることは未確認である。

共通MCPの`selected`と`fallback`は、Codex CLI 0.160.0の専用HOMEで実行した。
両方で登録とpollが各1回完了し、返却されたthread IDは`thread.started`のIDと一致した。
登録は`pending`を返し、選択注入は`chosen`と選択回答1件、時計を期限の1ms後へ進めた試験は`provisional`と仮回答1件を返した。
固定Responses fixtureは、既知のfunction-call IDに対応するpoll出力を構造的に取得した。
`tool_timeout_sec=2`の設定で、pollから次のResponses要求までの時間は選択注入で7ms、時計注入で10msだった。
MCPの書き込み注記による拒否は観測しなかった。

この結果は実ダッシュボードからの回答、実時間の1分待機や実モデルの判断を示さない。
brokerの配送claimとackも実行していない。
各実行後に専用configを復元し、使用したruntime HOMEを削除した。

`long-poll`ではpollだけを2,600ms遅延させた。
登録は成功し、poll itemは2,006msで明示的なtimeoutとして失敗した。
次のResponses要求でも、同じfunction-call IDの出力にtimeoutエラーがあることを確認した。
登録結果のthread照合は成功したが、poll結果は返らなかったため、その結果のthread IDは未観測である。
この試験はtimeoutを観測できたことを示し、回答の到達成功ではない。
専用configの復元とruntime HOMEの削除は成功した。

## 共通MCPの再現手順

```powershell
$pocCodexBinary = 'C:/Users/mss02968/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
node poc/codex-questions/run-common-mcp.js --codex-path $pocCodexBinary --out poc/out/poc160-common-selected-new --mode selected
node poc/codex-questions/run-common-mcp.js --codex-path $pocCodexBinary --out poc/out/poc160-common-fallback-new --mode fallback
node poc/codex-questions/run-common-mcp.js --codex-path $pocCodexBinary --out poc/out/poc160-common-timeout-new --mode long-poll
```

出力先は未使用の`poc/out/`配下を指定する。
runnerは専用HOMEとローカル固定Responses fixtureを作り、MCP timeoutだけを2秒に設定する。
認証情報を通常HOMEからコピーせず、終了後に専用設定とruntime HOMEを片付ける。
結果の`common-mcp-results.json`には識別子、状態、件数、時間と照合結果を保存する。
生の質問や回答本文は保存しない。

## 共通質問の試作方針

質問の登録と短いpollを分け、各MCP呼び出しを即時に返す方式を比較対象とする。
[公式MCP資料](https://learn.chatgpt.com/docs/extend/mcp)では、`tool_timeout_sec`の既定は60秒である。
1〜30分の離席期限をそのまま単一MCP呼び出しの待機時間にすると、個別設定との整合が必要になる。
短pollを続ける場合も、質問と配送IDの重複排除、明示的な待機状態と中断時の処理が必要になる。

期限はサーバーの受信時刻で判定し、期限ちょうどを期限到達として扱う。
推奨の自動適用は、現在も離席中で、すべての質問が一意に推薦された単一選択で埋まる場合に限定する。
推奨がない質問、複数選択や自由記入を推測で埋めない。
選択された回答と、推奨を仮に適用した結果は別の状態として記録する。
仮適用後の遅い回答は新しい指示の候補として記録し、同じ質問への2回目の適用に使わない。
後続指示の実配送は#161で検証する。

質問はhost、HOME scope、native threadとrequest IDの組み合わせで分離する。
同じ内容の再登録には最初の期限を返し、異なる内容の同ID登録は拒否する。
保留は回答ではなく、期限を延長しない状態として記録する。
離席解除後は自動適用せず、期限後に再び離席した場合は次の状態照合で期限を再評価する。

元UIとダッシュボードの回答は、同じ内部の勝敗判定を通す。
外部の要求解決を観測して内容を取得できない場合は、内容を推測せず外部解決済みとして扱う。
配送の確保と受領確認を分け、中断や外部解決で未受領の配送を止める。
このモデルだけでは、異なるクライアントの実RPC競合や本番配送の成功を証明しない。

## ネイティブ質問の最初の実測

モードを上書きしない管理app-serverと、`exec --json --ephemeral -s read-only`の双方で、固定Responses fixtureへの要求に`request_user_input`の宣言があった。
最初のfixtureは単一選択と自由記入の2問を指定したが、自由記入を指定する項目をツール引数で確認できず、`free_form_schema_unsupported`として呼び出しを発行しなかった。
どちらもターンは完了したものの、ネイティブ質問のRPCや回答は未観測である。
この結果を質問ツール全体の利用不可とは扱わない。
単一選択だけの別ケースと、Plan／Defaultのモード差を続く試験で調べた。

単一選択だけの別fixtureを実行し、モードを上書きしない管理app-serverとexecの双方で呼び出しを発行した。
既知のfunction-call IDに対応する出力を、本文を保存せずに分類したところ、両方で`default_mode_unavailable`を観測した。
ターンとCLIプロセスは完了しても、質問は実行されておらず、ネイティブ質問のRPCは0件だった。
モデルに公開された引数は`questions`で、各問にはheader、id、optionsとquestionがあり、isOther、isSecretとisBlockingはなかった。
ネイティブRPCの生成スキーマにある項目が、モデル向けツールにも公開されるとは限らない。
Defaultでの通常判断は共通MCPを標準とし、ネイティブ質問の取り込みはPlanで確認した範囲に限定する。

最初のPlan試験では、要求したモードと通知で観測したモードがともに`plan`で、fixture modelも一致した。
質問RPCが1件あり、threadとturnが一致し、nativeの`isBlocking`はtrueだった。
RPCのitem IDはResponsesのoutput item IDではなく、fixtureが発行したfunction-call IDに対応した。
モデル引数にない`isOther`は、native RPCではtrueになっていた。
最初の試作はoutput item IDとisOther=falseを想定していたため応答せず、ターンがtimeoutした。
これはPlanの利用不可の証拠ではなく、実測で確認した識別と既定値に試作を合わせる必要があることを示す。
この試験の失敗結果は保持した。

その後の専用Plan試験では、選択回答と自由記入を別々の実行で確認した。
どちらも要求と観測のmodeがplanで、既知のfunction-call ID、thread、turn、質問IDと選択肢を照合した。
nativeのisBlockingとisOtherはtrueで、isOtherはモデルの入力にはなくランタイムが付けた値だった。
自由記入はnativeのisOther=trueを確認した場合だけ、候補外の固定文字列を返した。
各実行で回答送信1件、同じ質問の解決通知1件、ターン完了と正確な質問IDごとの回答マップを確認した。
専用設定の復元とruntime HOMEの削除も成功した。
固定fixtureの既知の呼び出しとの照合は、本番の任意の質問の由来を認証する仕組みではない。

モデルのツール引数にisBlockingがないため、non-blockingを指定できることは未確認である。
最初の混合fixtureの失敗は自由記入をモデル引数で指定できなかった結果であり、Planのnative自由記入全体が利用不可という結果ではない。

```powershell
node poc/codex-questions/native-runner.js --codex-path $pocCodexBinary --out poc/out/poc160-plan-choice-new --timeout-ms 30000 --blocking true --question-profile single --answer-kind choice --mode plan
node poc/codex-questions/native-runner.js --codex-path $pocCodexBinary --out poc/out/poc160-plan-text-new --timeout-ms 30000 --blocking true --question-profile single --answer-kind free-text --mode plan
node poc/codex-questions/run-native-exec.js --codex-path $pocCodexBinary --out poc/out/poc160-exec-single-new --question-profile single
```

結果は`poc/out/poc160-native-plan-choice-20261006-0344/`と`poc/out/poc160-native-plan-free-text-20261006-0345/`、execの拒否分類は`poc/out/poc160-native-exec-single-diagnostic/`に保存した。

共通質問MCPでは由来と分類を内部で固定し、呼び出し引数から変更させない。
これらの値は呼び出し契約を表すもので、外部入力の認証を代替しない。
許可要求へ応答するAPIを設けず、本番では認証されたcollectorとnative宛先照合を別に実装する。
質問の分類が不明な場合は、通常判断として回答しない。

## 待機と配送の制約

今回のMCP実測は、即時pollと2秒のtimeout境界までである。
1〜30分の実時間待機、複数回のpollを続けた状態、フックの最大待機と切断後の復元は未確認である。
注入時計による期限判定の成功だけでは、これらの耐久性を証明できない。

現行の[公式フック資料](https://learn.chatgpt.com/docs/hooks)では、フックのtimeoutとMCP側のtimeoutがそれぞれ説明されている。
このPoCではフックを回答待ちの経路に使わず、対象版のフックを30分待機させる試験もしていない。
本番で短pollを採用する場合は、応答待ちを明示し、間隔に上限とbackoffを設ける必要がある。
モデルが回答待ちのままpollを続ける方法と、停止後に起こす方法は#161、未受領や切断後の復旧は#162で検証する。

poll結果の返却と、その結果が次のResponses入力に含まれることを、brokerの受領ackとは扱わない。
回答の識別子を維持し、受領済みの回答を再適用しない本番契約は、別途必要である。

## 未確認の理由と追加検証

#158で既存デスクトップの稼働threadへの接続を確認できていないため、今回は所有する専用app-serverで通信契約を調べた。
実装時は管理app-serverで起動するセッションを導入の前提とし、実TUIとダッシュボードの二つのクライアントで同じ質問への回答競合を検証する。
nativeの複数質問、複数選択とnon-blockingは、それぞれの入力契約と元UIの対応を確認してから追加する。
対応不明の形式は単一選択に変換しない。

本試作は永続化と復旧を実装しないため、切断を最大待機の成功として扱えない。
#161で実行中と停止後の後続指示、#162で未受領の回答、切断・再起動と識別子の復元を検証する。
本番導入前には1・5・30分の実時間試験を実施し、poll間隔、モデルの待機継続と中断時の回復を確認する。
フックを長時間の回答待ちには使わず、短い状態通知に限定する方針である。

本番では認証された共通MCP、質問状態の保存、ダッシュボード回答、期限の評価と受領確認を追加する。
Planのnative取り込みは発行元itemと通常判断の由来を証明できる場合に限定し、アプリ操作の許可と不明な要求を除外する。
推奨の仮適用を実行許可の代替にはしない。
