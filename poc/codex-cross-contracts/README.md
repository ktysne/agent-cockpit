# Codex横断契約モデル

この資料とモデルはIssue #184の指摘を検証するための契約参照である。
本番のcollector、bridge、runtime、認証、耐障害storeは実装しない。
モデルのverified入力は信頼済みfixtureを表し、ネットワーク認証の検証ではない。
checkpoint()は上限付きJSON形式と復元遷移を検証するための値であり、本番storeの永続性を示さない。
テストの回答payloadは合成値であり、checkpointや状態照会には含めない。
共有契約の正本は [docs/design/codex-shared-contract.md](../../docs/design/codex-shared-contract.md) である。
payloadをcheckpointに保存しないため、復元後の未送信payload再取得と内容照合は本モデルの対象外であり、復元後は再送出できない。本番側で実装・検証する。

## 会話と実行期間

正規会話IDはprovider、nativeIdKind、hostId、安定したhomeScopeId、nativeIdの組である。
codexのnativeIdKindはthread、claudeはsessionに固定する。
旧claude-code表記は認証済みadapterが明示変換した場合だけ受け入れ、モデルは別名を推測しない。
homeScopeIdは再接続後にも照合できる不透明なscope IDであり、ホームの実パスではない。

内部periodIdは所有権が確認された実行期間ごとに発行し、native IDとして扱わない。
observerによるresume、compaction、collector再接続は実行期間を作らない。
接続世代は接続再開のたびに進み、期間IDとは独立している。
期間終了はその期間の全agentとtool-useを不可逆に終了させる。
終了後の同一会話は、終了済み期間を指定した明示的owned-resumeで新しい期間を得る。
開始か再参加かを証明できない入力は新しい期間へ自動割当しない。

## 起動帰属と現在の所有者

executionの不変欄はlaunchId、runId、attemptId、provider、起動分類origin、目的purpose、originBinding、executionBindingである。
originはstandalone、delegated、reviewのいずれかであり、purposeはagent、cross-review、pr-creatorのいずれかである。
組合せはstandaloneとagentまたはpr-creator、delegatedとagent、reviewとcross-reviewに限る。
standaloneのoriginBindingはnullとし、delegatedとreviewは起動元の期間IDとactorを固定する。
executionBindingは子自身の不変宛先であり、そのperiodのconversation providerはexecution providerと一致しなければならない。
同じexecutionBindingを複数executionへ登録せず、起動元とPR作成元の履歴もhandoff後に書き換えない。

現在の所有者はcurrentOwnerに期間IDとagentまたはtool-useを保持し、単調増加するownerGenerationで変更を識別する。
handoffにはhandoff ID、期待する世代、新しい世代、明示した新所有者を要求する。
同じIDと同じ内容は冪等であり、同IDの異内容、古い世代、期待世代の不一致を拒否する。
新所有者は稼働中の期間として照合できなければならない。
切断中のhandoffはreconcileHandoffでのみ取り込む。保存済みowner/generationに対するCAS、immutable identity、現行のexecution/new-owner接続世代、新ownerの認証済みlive projectionを照合し、generationを1つずつ進める。
この復旧経路は旧ownerのactive状態やproofを要求しないが、取り込み後はcurrentProofを失効させ、子と新ownerをreconcileExecutionで再照合するまで配信を保留する。

配信を許可するcurrentProofは、immutable originとexecutionBinding、currentOwner、ownerGeneration、ownerConnectionGeneration、executionConnectionGenerationを一組として照合する。
新規execution登録時にproofを作り、handoff、再接続、復元時に無効化する。
reconcileExecutionは起動元と現在の所有者および世代が一致した場合だけproofを再発行する。
conversationやperiodだけの照合、別executionの照合では配信を許可しない。

## 質問、結果、PR通知の配送

質問、結果、PR通知は一つの台帳へ記録する。
論理メッセージIDと配送試行IDは別の値として扱い、質問と結果の重複範囲はexecution、論理ID、revisionで決める。
質問は発行した子のexecutionBindingへ固定し、送信前はcurrentOwnerもactive/freshである必要がある。handoff後の再照合で同じ子宛の未送信質問を再開できる。
結果は作成時のcurrentOwnerとownerGenerationへ固定し、owner変更後は旧記録をsuperseded_before_sendとして保存してから新しい試行を作る。
PR通知のtargetIdは正規execution/attemptへのaliasであり、重複範囲は論理event ID、revision、canonical target execution/attemptで決める。同じ宛先への別aliasで重複させず、異なる明示targetへの通知は許可する。
PR送信は通知先execution自身のcurrentProofを要求する。作成元executionのlive proofは要求しない。終了したtargetから他のownerへ自動転送しない。

claimはローカル予約だけを行い、metadataだけを返す。
send-startは台帳にsendingを保存した後に初めてpayloadを返す。
保存が失敗した場合は状態をcommitせず、payloadも返さない。
availableまたはclaimedの送信前記録はsupersedeUnsentDeliveryで台帳へ明示保存した後だけ置換できる。
cancelled_before_sendは同じrevisionで復活させず、新しい明示要求かrevisionを必要とする。
sending、accepted、unknown、appliedはhandoffを理由に新しい宛先へ再送しない。
acceptedは輸送受付を表し、appliedは入力適用の相関証拠を表す。
send-start前に質問取消が確定した場合はpayloadを返さない。
send-start後の取消はcancelRequestedとして記録し、遅れて届く適用証拠を保持する。
復元時はsendingとacceptedをunknownへ変え、適用を確認できない配送を自動再送しない。unknown/appliedを含む同一論理revisionは別deliveryAttemptIdでも重複登録しない。

## 固定済みPoCとの関係

各リンクは監査時に固定したPoC文書のcommitを指す。
このモデルは過去の計測値を書き換えず、旧モデルの契約をそのまま本番へ連結しない。
下表の固定SHAは既存の証拠を特定するために記録し、新しい結合モデルの試験結果と混同しない。

| PoC | 固定文書 | 新契約で扱う境界 |
|---|---|---|
| #157 | [4386015a](https://github.com/ktysne/agent-cockpit/blob/4386015a9f7f17803294ef5551a85716121d8602/docs/poc-codex-157.md) | native会話IDのresume後保持と内部実行期間IDを分ける |
| #158 | [f646a7f](https://github.com/ktysne/agent-cockpit/blob/f646a7f9d1aa93d049aa03380b3fa39b52771eda/docs/poc-codex-158.md) | observer再参加をowned-startと区別する |
| #159 | [4cc1d4a](https://github.com/ktysne/agent-cockpit/blob/4cc1d4aac00cc91f2d97fe5999c122b06620a3e9/docs/poc-codex-159.md) | 可変handoff先と不変起動元を分離する |
| #160 | [26ea5e0](https://github.com/ktysne/agent-cockpit/blob/26ea5e0e122ad708346d615fbbc30d0b69f9a4b5/docs/poc-codex-160.md) | claim後でもsend-start前の取消だけを確定する |
| #161 | [10d445a](https://github.com/ktysne/agent-cockpit/blob/10d445afa1a1e9f51f072fd4f33e1a2f302038ab/docs/poc-codex-161.md) | send-start後の取消要求と受付/適用証拠を分ける |
| #162 | [b03ccda](https://github.com/ktysne/agent-cockpit/blob/b03ccdaff00fde22371e1bc1eb394de134b09d65/docs/poc-codex-162.md) | 復元時にoriginとcurrentOwner双方を再照合する |
| #163 | [84ef60e](https://github.com/ktysne/agent-cockpit/blob/84ef60e2ae2bdff10956181a147703ced7e65df8/docs/poc-codex-163.md) | native IDで親期間を終了せず、期間全体で終了を管理する |
| #164 | [8a4e623](https://github.com/ktysne/agent-cockpit/blob/8a4e62312753bf49079423f3577fa7c38874bbe6/docs/poc-codex-164.md) | 結果返却先と明示PR通知先を同じ配送規則にしない |

## 試験

実行コマンド:
```sh
node --test --test-isolation=none poc/codex-cross-contracts/contract-model.test.js
```
試験はchild質問とresultの宛先分離、切断中handoffのsnapshot復旧、二つの接続世代の再照合、遅延終了、restore後のunknown再送抑止、質問取消との競合、保存失敗、PR aliasのcanonical重複排除とtarget固定を確認する。
試験合格は新しい契約モデルの内部整合だけを示す。
実認証、実collectorやbridge、native runtimeの相関、UI競合、本番storeの耐障害性は本番Issueで別に検証する。
