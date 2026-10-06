# Codex連携の本実装計画

## 目的と適用範囲

この計画は、Codex連携の本実装を順序立て、Issue内の依存関係と統合ゲートを明確にする。
ここに記載したゲートIDは計画上のscenario候補であり、テストコードや実測結果ではない。
各実装Issueで入力、観測点、期限、期待値、許容差、能力条件を確定してから試験を実装する。

ClaudeとCodexで同じ結果を期待する機能は、本実装に合わせて機能単位の適合試験を追加し、関連IssueとPRの完了条件にする。
共通コア、両adapterを通す共通適合、少数の実runtime試験を段階的に追加し、全体完成後に横断runtime統合試験を行う。
期待値は実装から独立に仕様に基づいて定める。
LLMが生成する文面やproviderの能力差は同等性の対象にしない。
試験手順と結果の扱いは[Claude/Codex適合試験方針](https://github.com/ktysne/agent-cockpit/blob/f4460762641d9eef6c0eb0c2c9c55df4f625532e/docs/design/provider-conformance-testing.md)を正本とする。

Codexの共有契約は固定版の[共有契約文書](https://github.com/ktysne/agent-cockpit/blob/a2da27f1f51e932a0184cea72da38fc89b1c5c5f/docs/design/codex-shared-contract.md)を参照する。
この契約のモデルは参照用であり、実adapterやruntimeの適合を証明しない。
過去のPoCは固定SHAの証拠として扱い、本製品に機能が実装済みとはみなさない。

## 実装の進め方

Issueを新たに分割せず、各Issue内にA/B/Cのマイルストーンを置く。
マイルストーン単位でPRを分けても、先行部分だけでIssueを完了扱いにしない。
本実装の作業ブランチとPRは最新のcodex/feature-codex-supportを起点とし、feature向けに集約する。
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
## 工数の扱い

初期段階の概算26〜42日と管理5〜10日は、残作業の見積もりではない。
Issue間の同じ基盤作業を二重加算しない。
新しい数値見積もりは推測せず、実装着手時にIssue内マイルストーンへ分解して更新する。