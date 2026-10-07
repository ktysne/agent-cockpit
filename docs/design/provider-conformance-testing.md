# Claude/Codex適合試験

## 目的と対象

ClaudeとCodexで同じ結果を期待するCockpit機能は、機能を実装するたびに適合試験を追加する。
適合試験は各関連IssueとPRの完了条件にする。
全機能の実装後に、両runtimeを接続する横断統合試験を行う。
最初に全機能分の試験基盤を作り切らず、実装対象に合わせて段階的に増やす。

この文書が扱うのは、両providerで共通結果を期待するCockpit側の機能契約である。
LLMが生成する文面や、providerの能力差そのものは同等性の対象にしない。
CLI、アプリ、daemonの版を厳密に一致させず、検証に使った版と確認した能力を記録する。
runtime更新後は、代表的な接点を再試験する。

Issue #184の共有契約文書は状態遷移の参照モデルである。
参照モデルの合格は、実adapterや実runtimeの適合を証明しない。
[共有契約の固定版](https://github.com/ktysne/agent-cockpit/blob/a2da27f1f51e932a0184cea72da38fc89b1c5c5f/docs/design/codex-shared-contract.md)を参照する。

## 機能ごとのシナリオ定義

実装開始前に、対象機能について共通結果、仕様上許容する差、未確認を区別する。
Claude側とCodex側で適用する共通シナリオには共有IDを付け、関連Issue、観測点、期待値、許容差、能力条件を定義する。
期待値は仕様、合意済みモック、または明示した製品要件から決める。
片方の実装をもう片方へコピーした結果や、両者の出力比較だけを期待値の根拠にしない。

| シナリオID | 機能とIssue | 区分 | 能力条件 | 操作 | 観測点と期限 | 共通期待値 | 許容差 | 禁止副作用 |
|---|---|---|---|---|---|---|---|---|
| 実装前に機能ごとに定義 | 対象機能と関連Issue | 共通結果、仕様差、未確認 | 実行条件 | 入力と操作 | 状態・宛先・期限 | 仕様に基づいて実装から独立に定める | 意味を変えない差だけ記載 | 起きてはならない副作用 |

ClaudeとCodexの両方が対象機能を実装するまでは、未実装側を未確認とする。
未確認を成功や同等と扱わない。
段階的な開発はできるが、共通結果を期待する対象機能は両adapterがシナリオに合格した時点で同等対応完了とする。

## 検証層

適合試験は次の三層で構成する。

| 層 | 確認内容 | 成功の意味 |
|---|---|---|
| 共通コア | providerに依存しない状態遷移、配送台帳、保存形式 | 共通ロジックがシナリオの期待値に合う |
| 両adapterを通す共通適合 | 同じシナリオをClaude adapterとCodex adapterへ適用する | 両adapterが共通機能契約を満たす |
| 少数の実runtime試験 | 実際のClaudeとCodexへ接続し、代表接点を確認する | 記録したruntime版と能力条件で接続・観測できた範囲を確認する |

共通コアの成功だけでadapterやruntimeの適合を主張しない。
fixtureを使った試験と実runtime試験の結果を分けて記録する。
機能の実装中は対象に関わる層を追加し、全体完成後に横断runtime統合試験を行う。

## 観測する不変条件

各シナリオは、入力だけでなく処理中と処理後の観測点を定義する。
対象機能に応じて、次の事項を検証する。

- 意図した会話、実行、通知先へだけ配信する。
- 送信回数と状態遷移が期待値に一致する。
- 保存と復旧後も宛先、世代、配送結果を誤って復活させない。
- 禁止した副作用は0回である。
- 途中の取消、handoff、終了、再接続後も不変条件を保つ。
- transportの受付とruntimeでの入力適用を別の結果として扱う。

誤配信、重複、送信後の応答喪失を、単に最終画面の一致だけで合格にしない。
元の宛先、送信回数、状態履歴、禁止副作用も検証する。

## 差の正規化とイベント順

非決定なIDや時刻は、比較に必要な範囲でだけ正規化する。
意味のある状態差やunknown状態を正規化で消さない。
無害な固有イベントの到着順を一致させる前提にしない。
必要な観測点、期限、順序制約をシナリオの契約として定義する。

## シナリオの選択

対象機能に必要なケースを選び、実害のある差の再発でシナリオを追加する。
すべての機能へ一律に不要なケースを網羅しない。
候補には正常系、誤配信、重複、取消前後、送信後の応答喪失や再起動、owner handoff、旧期間と新期間の分離がある。
適用しない候補は、その機能の契約上不要である理由を記録する。

## Codex native pendingの表示

`ID-F08-NS09`はCodex nativeの質問要求と許可要求をCockpitで表示するシナリオである。
Codexのowned runnerが受け取った要求を製品HTTP経路へ通し、実storeを使うfixtureで確認する。
共通期待値は、待機中の指示作成と送信が0回であること、HTTPに種別と件数だけを含めること、下書きを保持することである。
HTTP、safe snapshot、UIには要求本文、request ID、item ID、内部revisionを公開しない。
同じ状態への繰り返しGETは要求を消費せず、pending中は新しい指示の作成と送信を拒否する。
pendingが消えた後も、現在のownerとnative contextを再確認できない場合は`unverified`を維持する。
Claude nativeの質問要求と許可要求はunsupportedまたは未確認として扱い、Cockpit独自の`cockpit_wait`をこのシナリオの成功に数えない。
回答や許可の製品APIは追加せず、fixtureの成功を実runtimeの能力や質問への回答完了の証明に拡張しない。

HTTP経路は[実factoryのCodex fixture](../../test/native-instruction-service-http-target.test.js)で確認する。
runnerの件数投影と置換時失効は[runner test](../../test/owned-native-runner.test.js)、入力保持と通知は[web test](../../test/instruction-web.test.js)と[render test](../../test/web-render.test.js)で確認する。
このcheckpointでは関連6ファイルのin-process test 260件が成功した。
実Codex runtimeは未実施であり、Claude native waitはunsupportedまたは未確認である。

## 実行と結果の記録

自動適合試験は既存の npm test 経路へ統合する。
CIがある場合は同じ経路から実行する。
実runtime試験の未実行、失敗、skipを自動試験の成功に含めない。
PRには対象シナリオID、関連Issue、ClaudeとCodexそれぞれの結果、共通期待値、仕様差または非該当理由、fixtureと実runtimeの区別を記録する。
実行したruntime版と能力条件、未確認の理由、担当Issue、採用前に確認する条件も記録する。

## featureをmainへ提出する前の条件

featureをmainへ提出する前に、採用対象の共通機能について両adapterの適合試験、必要な実runtime接点試験、横断runtime試験の成功を確認する。
採用対象に残す機能の未確認項目は解消する。
未確認項目を残す場合は、開発者が承認した対象範囲の縮小または代替仕様によって採用対象から外し、理由、担当Issue、確認条件を記録する。

## actor生存とcontext認可の適合

#171-Bと#180-Aでは、main actor、canonical period、owned processの生存とcontext認可を別々に観測する。
共通scenario ID-F04-B04、ID-F04-N06〜N14は両製品registration、launch、runtime adapterを通し、context終端、fresh context、owner chain、確定source失効、unknown connectionを検証する。
独立した期待値、観測点、期限、禁止副作用は[codex-runtime-binding-core.md](codex-runtime-binding-core.md)と[native-launch-composition.md](native-launch-composition.md)で定義する。
fixtureの成功は、real runtimeでの長寿命main actorや同periodの複数contextの実証へ合算しない。
送信開始保存後のpayload認可は、opaque handleとowner chainを同期検査するcomposition facadeを採用条件にする。
送信開始保存中のcontext失効はID-F05-N01で、両providerの実file storeとdelivery adapterへ固定trusted facadeを注入して確認する。
葉のraw kernel proofが単独で有効でも、ancestor chainが失効したときはpayload sinkを0回に保つ。
復旧後のunknownは自動再送せず、追加のcontextStateを保存schemaへ取り込まない。

ID-F04-N13のcontext callbackは両providerで同じraw authority失効を拒否する。
固定wait返信はCodexの実owned runnerとfake pipeを通すfixtureであり、実modelやログイン後runtimeの能力を証明しない。
Claude固定waitはunsupportedのままで、共通callback試験の成功をClaude wait能力へ拡張しない。

ID-F04-N14とID-F05-N02では最後のancestor callbackからのraw葉失効を両providerで検査する。
canonical revisionとprivate proof capabilityの最終検査はcallbackを呼ばず、失効後のproof返却とpayload sinkを0回に保つ。

## 実runtimeの回帰記録

sourceSHA `6151af8f3b557db4c99e20a5a077e55927b0f3a2`で全体npm testは1421/1421件が通過し、fail、cancelled、skipped、todoは0件だった。
2026年10月7日、同sourceSHAのcanonical revisionsとcallbackなしの最終proof guardを含むv1経路をClaude Code 2.1.291の隔離HOMEで回帰確認した。
standaloneの一回のassistant contextでproofとwriterの認可を確認し、終端後はactorとcanonical periodがactive、contextStateがendedとなり、旧proofとwriterを拒否した。
owned stop後のchild exitとclose、通常Codex/Claude認証ファイルの不変、隔離認証artifactの新規作成0件を確認した。
結果はexcludedな`.cross-review/native-live-binding-probe-results-claude-lifecycle-8fa31cf9-e215-4ede-a087-39e2ae17bc68.json`に保持する。
実probeはstandaloneだけであり、最後のancestor callbackからの失効注入、複数context、delegated、handoff、reconnect、Codex waitはこの結果で実証していない。
