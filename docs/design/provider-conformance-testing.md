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
