# Codex連携の本実装計画

## 目的と適用範囲

この計画は、Codex連携の本実装を順序立て、Issue内の依存関係と統合ゲートを明確にする。
ここに記載したゲートIDは計画上のscenario候補であり、テストコードや実測結果ではない。
各実装Issueで入力、観測点、期限、期待値、許容差、能力条件を確定してから試験を実装する。

ClaudeとCodexで同じ結果を期待する機能は、本実装に合わせて機能単位の適合試験を追加し、関連IssueとPRの完了条件にする。
共通コア、両adapterを通す共通適合、少数の実runtime試験を段階的に追加し、全体完成後に横断runtime統合試験を行う。
期待値は実装から独立に仕様に基づいて定める。
LLMが生成する文面やproviderの能力差は同等性の対象にしない。
試験手順と結果の扱いは[Claude/Codex適合試験方針](provider-conformance-testing.md)を正本とする。

Codexの共有契約は[共有契約文書](codex-shared-contract.md)を参照する。
この契約のモデルは参照用であり、実adapterやruntimeの適合を証明しない。
過去のPoCは固定SHAの証拠として扱い、本製品に機能が実装済みとはみなさない。

## 決定済みの判断

| 日付 | 判断 | 理由と適用範囲 |
|---|---|---|
| 2026-10-08 | fixtureで契約を検証した変更は `codex/feature-codex-support` へ集約する。実runtime未確認はfeatureからmainへ採用する条件として残す。 | fixtureはコードと契約の回帰を確かめるが、製品compositionや実runtimeの挙動までは証明しないため。#175、#211、#216、#217は、この集約だけでは閉じない。fixtureの成功を実runtimeの成功へ読み替えない。 |

この判断はG2の実接続条件を緩和しない。
再接続時の接続世代更新と旧currentProofの失効は、対象runtimeで別途確かめる。
G4では質問応答と通常指示のtransportを分け、質問の宛先、owner保留、late answer、受付と適用の区別を維持する。
fixtureでこれらの境界を検証しても、実runtimeの適合を確認したことにはならない。

## 実装の進め方

Issueを新たに分割せず、各Issue内にA/B/Cのマイルストーンを置く。
マイルストーン単位でPRを分けても、先行部分だけでIssueを完了扱いにしない。
本実装の作業ブランチとPRは最新のcodex/feature-codex-supportを起点とし、feature向けに集約する。
開発者がスタック式の作業を指定した場合は、featureを祖先に持つ先行作業ブランチを取り込み、その先行PRのheadブランチをbaseにする。
先行PRの取り込み後は後続PRのbaseと差分を再確認する。
全Issue、統合検証、レビューの完了後だけfeatureからmainへの最終PRを作成し、開発者の承認後に取り込む。

## 依存関係と実装単位

Issue間の前提と、同一Issue内の先行マイルストーンを分けて管理する。
以下の「並行可」は、先行interface、保存schema、ファイル責務を固定した範囲に限る。共有state/storeの同時変更を別担当へ並行して渡さない。特に#166、#167、#171は同じstate入口に触れやすいため、Issueが異なるだけでは並行作業を始めない。

| Issue / 段階 | 責務と完了境界 | 先行条件・並行条件 |
|---|---|---|
| #166-A | 正規会話ID、実行期間ID、共通の認証済み登録核、Claude互換登録と最小共通適合試験を実装する。登録可能な主体、観測から検証済みへ昇格する主体、証拠metadata、trust boundaryを#170/#171と先に合意する。自己申告IDだけでは認証済みにしない。MCPから未確認IDを受けた場合は拒否または保留する。 | 最初に着手する基盤。 |
| #166-B | delegated MCP登録を共通核へ接続する。 | #171の認証済み登録と起動帰属が接続した後。 |
| #167-A | 正規IDを読み取るprojectionの基礎を作る。 | #166-A後。#171-Aと並行可。 |
| #171-A | bridgeが扱うbindingと認証済み起動登録の核を作る。 | #166-A後。#167-Aと並行可。 |
| #170 | 管理CLIのcollector、接続、切断中の記録、再接続を実装する。 | #166-Aと#167-A後。薄い接続を早期に実runtimeで確認する。 |
| #171-B | 実native binding、起動証拠、current owner、handoffと再照合を接続する。 | #170と#171-Aを使い、#180全体の完成を待たず実証拠を早期に確認する。 |
| #177-A | #166/#171の登録保存、接続世代、currentProof失効、checkpointと保存基盤を実装する。 | #166-A/#171-Aのidentityとbinding、および#175-Aとの保存interfaceを先に固定する。 |
| #175-A | 質問、結果、PR通知の宛先分離、論理key、revision、delivery attempt、取消、send-start、受付、適用、unknownの共通台帳を実装する。 | #177-Aと永続化interfaceを先に固定する。永続化を含む適用は#177-Aと接続する。 |
| #174 | 質問、poll、離席deadlineの共通処理を同じ配送台帳へ接続する。質問応答transportは通常指示と分ける。 | #166-A、#167-Aの基礎、#175-A、#177-A後。managed transportなしの共通MCPは検証できる。native由来と元UI競合は#170を能力条件として追加する。#175-Bとの並行実装は台帳interface固定後に限る。 |
| #175-B | 通常指示の生成、送信、適用確認を実装する。 | #170、#175-A、#177-A後。回答後の後続指示はこの統合後に扱う。 |
| #180-A | ClaudeとCodexの薄い実接続を早期に用意する。認証済み開始、実native binding、現状照合を確認する。 | #170/#171-Bと並行し、実証拠検証を後段まで遅らせない。#180全体の完成は待たない。 |
| #180-B | dispatcher、両vendor runner、cancel、結果返却の完全なruntime経路を実装する。 | #171-B、#175-B、#177-A後。 |
| #179 | PR/reviewの正規帰属と明示通知先を実装し、共通通知台帳を再利用する。 | #166、#167、#170、#171、#175、#177、#180の必要な境界が接続した後。 |
| #177-B/C | 対象機能の復旧、handoff、payload再取得、質問・PR・結果返却を段階的に統合し、全体復旧を最後に結合する。 | 各対象機能と#177-Aの保存基盤後。 |
| #167-B | mock、画面、導入手順の最終結合を行う。 | #170と対象機能のprojectionが揃った後。 |

#170、#171、#180の薄い実接続は早期ゲートである。
managed CLIの接続、認証済み開始、実native binding、世代照合を少数機能で確かめる。
vendorごとのrunner、cancel、全runtime機能を先行して完成させる必要はない。

#175-Aと#177-Aは、実配信開始前に台帳と保存の境界を共同で確定する。
send-startの永続化成功後にだけpayloadを露出し、保存失敗時は送信を開始しない。
unknown状態を復元しても自動再送を0回にする。
この安全境界の適合が確認できるまで、実配信を採用しない。

## 統合ゲートとscenario候補

scenario IDは各Issueで引き継ぎ、同じ共通期待値をClaude adapterとCodex adapterの双方に適用する。
ここに示す期待値は概要であり、期限、観測点、能力条件、許容差は実装前に詳細化する。

| ゲート | 対象 | scenario候補 | 通過に必要な証拠 |
|---|---|---|---|
| G1 正規登録 | #166-A、#167-A、#171-A | ID-F01 正規化とHOME分離、ID-F02 重複・未確認登録の拒否 | 共通核と両adapterで同じ会話/期間境界を示し、未確認入力をverifiedへ昇格させない。 |
| G2 実接続 | #170、#171-B、#180-A | ID-F03 認証済み開始とnative binding、ID-F04 再接続時の接続世代・currentProof失効 | 実runtimeで登録証拠と接続世代を照合し、再照合前の配信を保留する。 |
| G3 永続配信台帳 | #175-A、#177-A | ID-F05 取消/send-start競合、ID-F06 送信後応答喪失・保存復旧・unknown時の再送抑止 | 両adapterの宛先、回数、状態遷移、永続化後payload露出を確認し、禁止再送・副作用を0回にする。 |
| G4 質問と通常指示 | #174、#175-B | ID-F07 質問を発行した子への固定宛先、ID-F08 owner保留、late answer、通常指示の別transport | 質問と指示を区別し、owner不在だけで子の終了や質問解決を作らず、受付と適用を分ける。 |
| G5 起動・停止と結果 | #171、#180-B、#177-B/C | ID-F09 standalone開始、停止、結果返却、ended delegated拒否 | 対応機能の#177-B/C復旧部分を先行提供できる。全機能復旧の完成は待たず、対象turnとcurrent ownerを検証し、終了済みdelegated/reviewを再開しない。 |
| G6 PR/review通知 | #179、#175-A、#177-B/C | ID-F10 canonical target、creator/current ownerの分離、応答喪失 | 対応機能の#177-B/C復旧部分を先行提供できる。全機能復旧の完成は待たず、正規宛先への明示通知、重複排除、送信開始後の再送禁止、自動転送なしを確認する。 |
| G7 全体復旧 | #167-B、#177-B/C、関連Issue | ID-F11 checkpoint復旧、handoff、旧期間/新期間分離、画面と導入 | 共通機能双方の結果と横断runtime試験を確認し、未確認を成功に含めない。 |

## 共通の安全条件

対象機能に応じ、正常系に加えて誤配信、重複、取消前後、送信後の応答喪失と再起動、owner handoff、旧期間と新期間の分離を選ぶ。
適用しない候補は、その機能の契約に照らして理由を記録する。
追加scenarioは実害のある差の回帰に基づき、不要な全組合せを網羅しない。

質問の宛先は質問を発行した正規execution自身とし、親への結果返却先と混同しない。
結果返却先は記録時点のcurrent ownerとowner generationに固定する。
PR通知は正規化した明示targetへ送る。
send-start後に取消要求を記録したdeliveryについて、対象runtime、delivery、revisionを照合できた適用証拠だけを後から履歴に保持する。送信前取消の確定を適用済みと扱わない。
unknownや送信開始後結果不明のdeliveryを自動再送しない。
transportの受付とruntimeの入力適用は別々に検証する。

比較では非決定なIDと時刻だけを正規化する。
意味差やunknownを隠さない。
無害な固有event順は一致させず、契約上必要な観測点、期限、順序だけを定める。

## 接続前提と未確認境界

managed CLIは確認済みの採用候補であり、既存desktopの稼働セッションへ共有接続する経路は未確認である。
基本hooks/MCPの観測不足はunknownとして扱う。
desktop接続中の配信や自動再開を成功として扱わない。
取得不能時の代替は、未送信を証明できる場合に限る。未送信の元deliveryを明示的に無効化し、利用者が明示選択したstandalone次入力へ切り替える。送信済みまたはunknownの配信を再送せず、明示選択なしに代替を開始しない。
対象範囲の縮小や代替仕様の採用には開発者の承認を要し、この計画だけでscopeを縮小しない。
queue/add/startの因果、expected-turnへのsteer、停止したstandaloneの同一thread再開始、終了済みdelegated/reviewの拒否を対象機能のscenarioで検証する。

導入時は、ローカルCodex CLIと必要に応じてClaude CLI自身の認証、対象HOMEでのhook信頼設定、MCP/skill設定、bridge専用HOMEの別scope、managed CLI専用HOMEとtoken、remote起動を確認する。
dashboardは共用する。
必要な設定は実装時にsetup.mdへ反映する。
この計画時点では新規導入、HOME変更、daemon再起動を行わない。
cloudやSSH先の別hostにcollectorを置く構成は対象外とする。
bridge側を変更する#171/#180は、Cockpit側だけで完了扱いにせず、bridge側の正本、契約、試験を担当するrepositoryも更新対象に含める。ホームへ置いたスクリプトの写しを正本として恒久変更しない。
別repositoryや通常HOMEへの変更は、本実装時に対象と導入手順を明確にし、開発者の確認後に行う。現時点でrepository外の導入や設定変更は行わない。

## 実装時に確認する入口

既存ファイル名は責務を探す入口であり、実装APIの確定ではない。
各Issue着手時に現行コードと適合試験から責務と境界を再確認する。
ここでは具体的なAPI schemaや内部関数の分割を固定せず、実装時に現行コードと両adapterの適合条件から決める。
MCP入口はsrc/mcp/server.js、正規IDと状態・event・保存はsrc/server/session-ids.js、state.js、events.js、json-storage.jsが目安となる。
回答配信とhookはsrc/server/decision-answers.js、src/hooks/event.js、answer.js、away.jsを調べる。
PRの帰属・取得・mergeはsrc/server/pull-requests.js、pull-request-merge.jsを調べる。
tools/cross-review.jsはvendored copyである。
変更が必要なら上流で対応し、この計画段階で不要なupstream作業を始めない。

## 集約順と最終採用ゲート

Codex実装前の推奨集約順は、独立時計の#183、規約の#186、共有契約の#185である。
その後、既存PoC stackを#165、#169、#172、#173、#176、#178の順に集約し、#178の後で#181と#182を集約する。
#182は#163の結論との整合も確認するため、運用上は#181の後に置く。
本計画PRは規約PRの後なら独立して集約できる。
PoC stackは通常のmerge commitで元headの祖先を保ち、先行PRが未取り込みの間は累積差分を記録する。
取り込みのたびに後続PRの差分を再確認する。

本実装の推奨開始ゲートは、関連PRがfeatureへ承認付きで集約され、統合チェックを通過していることである。
未マージPoCの固定資料を参照した契約設計や計画準備は進めてよいが、PoCを採用済みまたは本製品へ実装済みと扱わない。
少なくとも#183、#186、#185と本計画の資料が参照可能であることを確認する。
PoC固定資料は契約準備に参照できるが、製品実装済みとは表現しない。
docs/development.mdには#185、#186、本計画の入口リンクを保ち、競合は内容を照合して解決する。

どのPRも自動mergeしない。
作業PRは最新featureを起点にfeatureをbaseとし、全作業後にだけmain向けPRを出す。
既存の127.0.0.1、secret/Origin照合、許可表示のみ、head一致と開発者確認に基づくmerge条件を維持する。
dashboardの既定branch向けmerge制限を迂回しない。
この計画作業ではmerge、main push、force pushを行わない。

## 検証証跡と最終採用

既存Issueが定めた追加検証を維持し、対象機能の共通scenarioを加える。
#174では、実runtimeの1分、5分、30分待機やnative質問と元UIの競合を代表接点として確認する。
各PRにscenario ID、両adapterの結果、fixtureと実runtimeの区別、確認したruntime版と能力、未確認の担当Issueを記録する。
関連テストは各実装段階で実行し、全体のnpm testは統合checkpointでまとめて実行する。
子プロセスを開始できない環境ではAGENTS.mdのin-process手順を使い、そこで実行できないテストは未確認として合否と分ける。
main提出前に、採用対象の共通機能で両adapterの適合試験、必要な実runtime接点試験、横断試験の成功を確認する。
採用対象に残る未確認は解消し、残す場合は開発者承認のscope縮小または代替仕様で採用対象から外して追跡する。
代替によって再送禁止、認証、宛先固定などの安全境界を緩和しない。

## 採用条件と未完了範囲

本節の条件は採用ゲートであり、計画やfixtureだけで製品機能の完了を証明しない。
最終PRに含める採用範囲は、次の条件を満たす。

- #207では、既定オプションで起動するClaudeだけの製品結合試験を行い、writerやregistryを直接注入せず、未登録の旧fallbackを製品入口に残さない。
- 既定のClaude writer compositionをMCPとhookの製品経路へ接続し、認証済み開始から入力反映までを確認する。
- 未構成時は現行画面を保ち、採用範囲の画面では既存部品とデザインを再利用してmockと一致させ、#221の機能別UIを構成済みの採用機能だけに表示する。
- G2のID-F04で再接続時の接続世代更新と旧currentProof失効を実runtimeで確認し、対象機能ごとにClaudeとCodexの両adapter適合、必要なruntime接点、復旧と投影回復を記録する。
- #216の新しい共通質問経路の推奨自動適用は、開発者が明示的に有効化した場合だけ行う。

### 質問と追加指示の画面

質問の回答、追加指示の入力、保存済み指示の確認は、合意済みモックの「あなたの判断が必要なこと」のカードを踏襲する。
見出し、説明、選択肢、自由記入欄、操作と状態表示の配置には既存部品を使う。
回答と追加指示は見出しと操作名で区別し、共通質問の保留、取消、期限、遅延回答の状態管理は各経路に残す。

会話の行で宛先が一意な場合は、その実行と現在使える送信方法を表示し、選択肢が一つだけのプルダウンを置かない。
実行先が複数ある場合は、既存の選択肢の部品で明示選択し、選択した対象を下書きに固定する。
編集中に対象の実行、世代、送信方法が変わった場合は、下書きを保持して保存を止める。
状態の受信で観測した変化は、カードの表示状態によらず明示確認まで保持する。
保存済み指示の宛先と送信方法を現在の状態へ付け替えない。
本人への質問待ち、許可待ち、結果不明の間は追加指示の保存と送信を保留し、結果不明の指示を再送しない。
native由来の待ちの種類と件数から質問本文や回答能力を推測しない。

この画面の合意はnative質問への回答、許可操作、実行の停止を実装済みとする根拠にはならない。
#221の中断表示と会話行の集約などの担当範囲は、質問と追加指示の部品統一とは分けて追跡する。

NS12のCodex CLI 0.160.1 run4では、本人認証、同一owned processでのstartとsteer、送信前の永続保存、適用相関を観測したが、全体結果は `steer_delivery_validation` の `scenario_gate_not_met` で `unknown` だった。
固定記録はsource head `e83cf3d116e50c8f2afe8c3436de9606d9917220`、script SHA-256 `7C232D52B0BD892487D355809EEF290AADC97AE9294798E04308A97797CC7B04`、summary SHA-256 `5714A0A8FA8C9346922DE651C3C65AB6A5317376370C860BCEA30329D3F5055C` である。
この結果はG2のID-F04再接続やcurrentProof失効を確認しておらず、frozen unknownを維持する。
PR202で記録したClaudeの実runtime結果は起動順修正前のもので、修正後のruntime確認は未実施である。

#206の受動復旧は登録履歴を戻す範囲に限られ、#210の質問serviceに対するlaunchとruntime再照合を証明しない。

#206のreplay claimと実行履歴も、#209の容量予約および終端回収の対象に含める。
claimと履歴の保持量を無制限に増やさず、終端記録の回収と容量予約の上限に反映する。

#210では、不完全な会話履歴を再照合した後に、その会話を永続checkpointの`incompleteConversationIds`から除く規則を定める。
新しいkernelで通常のstoreを開いて同じstartを再送する場合も、checkpoint replay claimの不一致で保存が恒久的に拒否されないよう、復旧後の扱いを定める。

[#207の実機確認](https://github.com/ktysne/agent-cockpit/issues/207#issuecomment-6039522384)では、Windows Desktop Claude 2.1.289の2セッションで、MCPとexec形式hookの直接の親が同じ`claude.exe`であり、親PIDがsessionsファイル名と一致した。
sessionsファイルから取得できるClaude親プロセスの開始時刻はPID再利用の確認候補に限り、今回の試験で検証した証拠ではない。
親プロセスの照合にはexec形式hookから直接親を確認できる経路を使う。
文字列形式hookはshellを介してbash toolと区別できないため受け付けず、shell形式へのfallbackを設けない。
hookを起動するNode実行ファイルは絶対パスで指定し、その設定手順をClaude側の実装で定める。
再開でnative session IDが変わる場合は#213の会話対応を使い、subagentは同じ親プロセス配下でも`agent_id`で区別する。
`/clear`、Claude CLI、他OS、session file読取の遅延は未確認である。

#209では、unknownから許される遷移と保持証拠が増やす最大量を予約し、件数、予約量、残容量、閾値を診断する。
容量が尽きた場合は新規受付を抑え、進行中の確定記録に必要な領域を確保する。
診断だけで保持証拠の上限や保存予約の容量保証を代替しない。
確定終端の本文を削除し、表示用詳細は既定7日保持する。
再送防止に必要な墓標を本文削除と同じatomic更新に含め、7日で削除しない。
旧epochを永続的に拒否し、再利用や巻戻しができない境界が成立するまで墓標を回収しない。
sendingやunknownを時間だけで回収しない。

#211では、native要求の待機表示と同じ実行を止める製品経路を確認する。
authority失効は物理停止を証明しないためpendingを消して配信を再開せず、停止が未確認または失敗した場合も再送を0回にする。
待機中のturn終了、遅延resolved、停止失敗を個別に検証する。
PR205の表示fixtureは物理停止の証拠に含めない。
PR230のマージはnative待ち表示案への合意を意味しない。
PR205の設計資料は、native waiting状態の戻り値と質問・許可情報の読取範囲を実装に合わせて更新する。

#217では、未使用capabilityの期限とACK確定後の適用証拠の受付期間を分ける。
閉鎖通知を上下に伝えるowned native経路だけ、ACK確定後の相関を同じturnの終了まで保持する。
観測期限ではunknownを一度記録し、完全一致する後着証拠を保存してappliedへ進めるが、再送はしない。
ACK未確定のタイムアウトと失効・不一致からの回復は認めず、保持中のunknownも既存の容量上限を消費する。
閉鎖通知のないownerは60秒回収を維持する。
両providerのfixture結果を、実Codexで60秒を超える処理中に送った指示の適用確認として扱わない。
この実runtime確認は#175と#217の完了条件として残す。

#215では、Cockpit専用の認証保存先を実行HOMEから分け、各runでHOMEを分離する。
Codex CLI 0.160.1のサポート済み認証経路で、読込と更新、権限、並行refresh、認証直列化を確認するまでは、毎回ログインを暫定経路として残す。
通常HOME全体は製品実行に流用しない。
SQLiteに本文が残る経路は隔離HOMEでのみ許容する。
owned processのexitとcloseを確認して非稼働を確かめた後にHOMEを削除し、次回runでは所有を検証した残留物だけを安全に掃除する。
認証専用scope、稼働中process、外部pathは掃除しない。

#213ではconversationIdごとに1行を表示し、委譲された子を親へまとめる。
内部execution、period、古い質問の宛先は維持する。
#216の新しい共通質問serviceとMCPは、ClaudeとCodexの両方で推奨自動適用を明示opt-inとし、既定off、最短待ちを既定5分とする。
登録時opt-inと適用時の現在設定がともに有効であることを条件とする。
離席開始を起点に質問期限と開発者の最短待ちの長い方を待つ。
期限前の一時的なbinding不成立でもpolicy期限timerを維持し、期限後にbindingだけが不成立なら30秒ごとに再確認する。
registry上の実行状態と現在接続中actorのbindingを確認し、OS processの生存を証明しない。
離席時点で期限が過ぎた質問には適用しない。
既存Claude hookの`decision-answers`と離席設定は変更対象外とする。
native `AskUserQuestion`と許可要求はlegacy経路だけで扱い、共通質問へ再登録しない。
MCPモデル引数からopt-inを指定させない。
trusted設定の供給元と製品導線は未実装で、現状はservice注入だけであり、製品既定はoffである。
現行のlegacy hookと共通MCPには共有native質問source keyやproducer側の排他的経路選択がなく、厳密な横断二重登録防止は未達である。
共通の登録・配送入口を一つに選ぶ完了条件は維持する。
製品compositionのruntime試験と設定移行・利用者告知が終わるまで達成扱いにしない。
期限やordinary分類のモデル申告だけで自動適用しない。
有効な現在binding、開発者設定、古い質問の除外を条件とする。

実Codexの未確認挙動に依存する新規G4経路を抑え、Cockpit内の修正を並行して進める。
#207の設計と既定テストを早期に進め、#209、#210、#212、#216は本番サービスを有効にする前に完了する。
#202と#204は既存headを保ち、通常のmerge commitと統合検証を行う。
`e83cf3d`は既存3往復を維持し、承認済み第4回reviewの例外を記録する。
新しいbranchやstate resetでreview回数上限を回避しない。
モデルはfeature PRをmergeしない。

#218の文書条件と#219のtargeted CLAUDE更新は、製品実装やruntime証拠の完了を意味しない。
最終main PRでは`poc/`全体と`tools/probes/common-question-runtime.js`、`test/common-question-runtime-probe.test.js`を除く。
`npm test`と`npm run test:inprocess`の対象を`test/**/*.test.js`に明示し、PoCの固定SHA参照を文書に残す。
この削除は最終main PRの準備段階に限り、現feature branchではPoCを保持する。
sanitize済みsummaryおよびmanifestの追跡整備も後続条件として残す。

### 監査Issueと対応段階

| 監査Issue | 対応段階 |
|---|---|
| #207 | Codex側は#166-Bのdelegated MCP親子binding、#171-B/#180-Aの証拠schemaとruntime接点、#177-Aの復旧後resume/projection、kernel API契約を担当する。Claude側は#202、#205、#227のマージ後にissuer、MCP、hooks、activeな実行だけを不在判定から保護する処理、subagent対応、既定composition、実runtime試験を実装する。 |
| #208 | #167-B、#175-B |
| #209 | #177-A/B/C、#174、#175-A、#179 |
| #210 | #177-B/C、#174、#175-A |
| #211 | #170、#175-B |
| #212 | #167-A、#170、#177-B |
| #213 | #167-B、#171-B、#177-B |
| #214 | #170 |
| #215 | #170、#180-A、#175-B |
| #216 | #174 |
| #217 | #175-B |
| #218 | #156の集約条件、#167-B |
| #219 | 独立した運用文書PR |
| #220 | #171、#174と横断する文書整備 |
| #221 | #167-B、#174、#175-B |
| #222 | #175-Bの追加レビューと統合確認 |

## 工数の扱い

初期段階の概算26〜42日と管理5〜10日は、残作業の見積もりではない。
Issue間の同じ基盤作業を二重加算しない。
新しい数値見積もりは推測せず、実装着手時にIssue内マイルストーンへ分解して更新する。
