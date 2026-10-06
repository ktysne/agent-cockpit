# Codex連携の共有契約

## 目的と適用範囲

この文書は、Codex連携の会話識別、実行期間、所有者引継ぎ、入力配信の境界を定める共有契約の正本である。
本番実装では、旧PoCの個別モデルを直接接続せず、この契約へ変換するadapterを設ける。
各PoCの固定SHAにある測定と当時の判断は証拠として残し、後述の対応表により現在の契約上の意味を区別する。
共有契約モデルは状態遷移を検証する参照モデルであり、本番実装ではない。
collectorとbridgeの認証、実nativeイベントの相関、実UI操作、製品storeの耐障害性は未検証である。
画面の表示先はAgent Cockpitのダッシュボードとする。
Codex内部ブラウザへの表示は対象にしない。
CLI、アプリ、daemonの厳密な版一致を導入条件にしない。
使用版と確認した能力を記録し、更新後に不具合が起きた場合はその時点で調査する。

## 用語と識別

**conversationId**は、`provider`、`nativeIdKind`、`hostId`、永続的な`homeScopeId`、`nativeId`を照合して発行する内部会話IDである。
native ID単独では会話を識別しない。
HOME scopeが異なる会話、providerまたはnativeIdKindが異なる会話を統合しない。
**periodId**は、所有runnerまたは認証済みadapterが新しい開始を確認して発行する会話内の実行期間IDである。
同じnative会話のresumeでも、確認済みの旧期間が終了し、新しい開始が証明された場合は別のperiodIdを発行する。
observerとしてのresume、既存threadへの参加、CLI接続、collector再接続、compactionだけでは新しいperiodIdを発行しない。
新期間の開始を証明できない入力は`unverified`として保留し、名前の付け替えや履歴の読み出しだけで解消しない。
**connectionGeneration**は、collectorまたはtransportの接続世代であり、再接続時に更新する。
connectionGenerationはconversationIdやperiodIdの代用にしない。
接続世代が変わったら稼働証拠を無効にし、現行の認証済み登録と照合するまで返却と配信を保留する。
**origin**は起動分類であり、`standalone`、`delegated`、`review`のいずれかを表す。
`purpose`は`agent`、`cross-review`、`pr-creator`のいずれかを表す実行目的であり、originとは別に保存する。
**originBinding**は、`origin`が`standalone`の場合は`null`である。
`delegated`または`review`の場合は起動元親Aを表す不変の`{periodId, actor: {kind, id}}`を保持する。
`kind`は`agent`または`tool-use`とする。

**executionBinding**は子実行自身Cの不変宛先`{periodId, actor}`である。
`periodId`が指すconversationは子のprovider、nativeIdKind、hostId、homeScopeId、nativeIdと整合し、actorはその期間のagentまたはtool-useでなければならない。
同じexecutionBindingの実行を別executionとして重複登録し、実宛先の識別をすり替えない。

**currentOwner**は現在の結果返却先Bを表し、親periodIdと同じactor形式で保持する。
`ownerGeneration`はcurrentOwnerの世代を表し、認証済みhandoffでのみ更新する。
`originBinding`と`executionBinding`はhandoffで変更しない。

native ID、PID、cwd、時刻、直近に観測したthreadだけから、欠けたprovider、host、HOME scope、period、親子関係を推測しない。

## 旧PoCから共有契約への対応

次のリンクは対象PoC文書の固定SHAを指す。#163と#164は#162から分岐した別PRであり、単一HEADに両方の記録が含まれるとは限らない。
過去の測定値と試験結果は各固定SHAの記録として保持し、現在の契約を説明する正本にはしない。

| 固定PoC文書 | 旧モデルまたは測定 | 共有契約での扱い |
|---|---|---|
| [#158](https://github.com/ktysne/agent-cockpit/blob/f646a7f9d1aa93d049aa03380b3fa39b52771eda/docs/poc-codex-158.md) | 同じapp-server上のloaded threadへobserverとして再参加する | observer resumeや接続更新だけでは新しいperiodIdを発行せず、既存期間の登録を再照合する |
| [#159](https://github.com/ktysne/agent-cockpit/blob/4cc1d4aac00cc91f2d97fe5999c122b06620a3e9/docs/poc-codex-159.md) | handoffで親bindingを可変parentへ置き換える | 起動元のoriginBindingを不変に保ち、認証済みhandoffでcurrentOwnerだけを更新する。旧モデルを直接接続しない |
| [#162](https://github.com/ktysne/agent-cockpit/blob/b03ccdaff00fde22371e1bc1eb394de134b09d65/docs/poc-codex-162.md) | parentを含むbinding全体が不変で、正当なhandoff後の復旧照合が拒否される | originBindingとcurrentOwnerを分けて保存し、復旧時は現行の登録とhandoff証拠で別々に照合する |
| [#163](https://github.com/ktysne/agent-cockpit/blob/84ef60e2ae2bdff10956181a147703ced7e65df8/docs/poc-codex-163.md)、[#164](https://github.com/ktysne/agent-cockpit/blob/8a4e62312753bf49079423f3577fa7c38874bbe6/docs/poc-codex-164.md) | providerと`sessionId`を親終了の識別に使う一方、会話と内部実行期間の写像が未定義 | native IDの実使用を仮定せず、conversationIdとperiodIdを明示登録して終了を期間単位にする |
| [#160](https://github.com/ktysne/agent-cockpit/blob/26ea5e0e122ad708346d615fbbc30d0b69f9a4b5/docs/poc-codex-160.md) | send-startを区別せず、`claimed`後もack前なら取消を確定して遅延ackを拒否する | `claimed`だけでは送信開始を判定せず、一つの台帳で取消とsend-startを裁定して受付と適用を分ける |
| [#157](https://github.com/ktysne/agent-cockpit/blob/4386015a9f7f17803294ef5551a85716121d8602/docs/poc-codex-157.md)、[#161](https://github.com/ktysne/agent-cockpit/blob/10d445afa1a1e9f51f072fd4f33e1a2f302038ab/docs/poc-codex-161.md) | 測定時の版と、旧導入条件に残る厳密な版一致 | 測定時の版は履歴として保持する。現在の導入条件は厳密一致を求めず、版と能力を記録して不具合時に調査する |

旧PoCのフィールドをこの表だけで機械的に読み替えて製品へ渡してはならない。
adapterはprovider、nativeIdKind、HOME scope、`origin`、`originBinding`、periodIdを明示的に検証し、不明値を補完しない。

## providerとnativeIdKindの対応

provider名とnativeIdKindは、認証済みvendor登録が示す組だけを受け入れる。

| 正規provider | nativeIdKind | 入力例 |
|---|---|---|
| `codex` | `thread` | Codex thread ID |
| `claude` | `session` | Claude session ID |

旧PoCの`claude-code`は、認証済みvendor登録がClaudeを示す場合だけ正規provider`claude`へ明示変換する。

任意のprovider文字列を自動で正規化したり、nativeIdKindをprovider名から補完したりしない。

## 所有者とhandoff

実行レコードは`origin`、`purpose`、不変の`originBinding`と`executionBinding`、`currentOwner`、`ownerGeneration`、実行状態を分けて保持する。
handoffは同じ子実行の所有者変更として、`handoffId`、`expectedOwnerGeneration`、`newOwnerGeneration`、変更後ownerを照合する。
同じ`handoffId`と同じ内容の再通知は冪等に扱う。
同じIDで内容が異なる通知、古いgeneration、期待ownerが現在値と異なる通知は拒否する。
generationの数値が大きいことだけを認証や正当性の根拠にしない。
認証済みhandoffだけがcurrentOwnerを変更でき、handoffで子実行を再起動したり、結果や終了を生成したりしない。
保存と復旧では`originBinding`と`currentOwner`の両方を保持する。
復旧後はcurrentOwnerとgenerationを現行の認証済み登録に照合するまで、結果返却と入力配信を保留する。
現在のhandoffを証明できた場合は`originBinding`を変えず`currentOwner`だけを更新する。
親periodIdの終了は、その期間に属する全agentへ不可逆に適用する。
agentまたはtool-useの終了、client退出、collector切断、threadの未loaded状態は親periodIdの終了を意味しない。

`currentOwner`のperiodIdが終了した場合は結果返却と配信を保留し、子の終了を推測しない。

終了済みownerから新ownerへの自動handoffは行わない。
新しいperiodIdへ同じnative会話を関連付けても、旧期間の終了、子、配信記録を復活させない。
遅延イベントは対象periodIdを証明できる場合だけその期間へ記録する。

### 切断中のhandoffを復旧へ取り込む

旧owner Aが切断中に新owner Bへ正当に引き継いだ場合は、通常の`reconcileExecution`と分けた`reconcileHandoff`で遷移証拠を取り込む。

この照合は、不変execution情報（`executionBinding`を含む）と`originBinding`、保存済みowner Aとgeneration、期待する旧owner/generation、新owner/generation、handoffId、現在接続世代、新ownerの認証済みlive projectionを一組として扱う。

保存済みowner A/generationに対するCASに成功し、handoffIdの冪等性と内容一致を確認できた場合だけ受け入れる。

generationは一つずつ連続して進め、複数handoffがある場合は認証済みの遷移を順に適用する。

証拠済みhandoffの取り込みに旧owner Aのactive状態、freshな接続、currentProofを要求しない。

遷移を取り込んだ後はcurrentProofを無効化し、子C自身と新owner Bの現在状態を再照合するまで返却と配信を保留する。

この経路でも、送信開始済みのquestionやresultを新ownerへ再送しない。

## 実行ごとの現在証拠

conversationId、periodId、connectionGenerationが現行と照合できても、その実行の配信可否は証明されない。

`currentProof`は、`origin`（`launchId`、`runId`、`attemptId`、provider、origin、purpose、`originBinding`）、子自身の`executionBinding`、`currentOwner`、`ownerGeneration`、`ownerConnectionGeneration`と`executionConnectionGeneration`を束ねる認証済み証拠である。

起動登録で実行ごとの証拠を発行し、handoff、再接続、復旧では既存証拠を無効化する。

`reconcileExecution`が対象実行の現在登録を再照合して新しい証拠を発行するまで、その実行への返却と入力配信を保留する。

periodIdだけの照合や会話のresumeだけで`currentProof`を復活させない。

## 結果返却とPR通知

子の結果返却先は返却記録を作る時点のcurrentOwnerとgenerationへ固定する。
送信開始前に所有者が変わった場合、未送信を台帳で証明して旧記録を無効化できるときに限り、新宛先の返却記録を作れる。
送信中、受付済み、または送信結果が不明な返却をhandoffを理由に新ownerへ再送しない。
遅延ackは元の返却記録へ相関し、新ownerへの配送証拠に転用しない。
PRの作成元は作成したcanonical execution/attemptとその`originBinding`へ結び付け、handoffで履歴を書き換えない。
PR通知先は明示登録した正規executionまたはattemptに固定し、終了した作成元や旧ownerから新ownerへ自動転送しない。
作成元Cや旧owner Aのproofは配信条件にしない。

通知先資格には委譲先Dの`currentProof`を要求し、その証拠にはD自身のbindingと、Dの`currentOwner` Eがactive/freshであることを含める。

Eが終了した場合はD宛通知を保留し、Dの終了や別targetへの転送を生成しない。

認証済みhandoff後にDと新ownerを再照合できた場合は同じD宛の未送信通知だけを再開し、送信開始済み通知は再送しない。
| 種別 | 固定する宛先 | 照合条件 |
|---|---|---|
| instruction | 指示を届ける実行自身の`executionBinding` | 完全宛先と同attemptの専用送信能力が現行である |
| question | 質問を発行した子自身の`executionBinding` | 子の`currentProof`とcurrentOwnerが再照合済みであり、対象native質問が特定できる |
| result | 記録時点の`currentOwner`と`ownerGeneration` | 現在ownerがliveとして再照合済みである |
| PR notification | `targetId`が指す`targetExecution={launchId, runId, attemptId}` | 通知先自身の`executionBinding`と`currentProof`が現行である |
配送台帳は`instruction`、`question`、`result`、`pr-notification`の種別を持ち、各deliveryの宛先を作成時に固定する。
子の結果返却とPRイベント通知は異なる配送として管理する。
通知先を変更するときは、送信前の明示的な再登録と、旧宛先への未送信証明を必要とする。

通常指示の送信方針、停止standaloneの専用認可、受付と入力適用の相関は[通常指示の配信契約](instruction-delivery.md)に従う。

## 論理メッセージと配送試行

`logicalMessageId`とrevisionは一つの内容を識別し、`deliveryAttemptId`はその宛先への個別配送試行を識別する。

配送台帳の主キーは`deliveryAttemptId`であり、instruction、question、resultは種別、`executionId`、`logicalMessageId`、revisionの組で重複を調べる。

別executionの同名messageは互いに干渉しない。

登録APIは`createInstructionDelivery`、`createQuestionDelivery`、`createResultDelivery`、`createPrNotification`を使い、各記録に`executionId`を結び付ける。

同じinstruction、question、resultのrevisionに`sending`、`accepted`、`unknown`、`applied`の記録が一つでもあれば、新しい`deliveryAttemptId`を発行して再送しない。

`available`または`claimed`を未送信として確認できる場合に限り、`supersedeUnsentDelivery(deliveryAttemptId)`でpayloadを破棄し、旧記録を`superseded_before_send`として永続化した後、同じlogical keyに新しい宛先への明示的な試行を作成できる。

利用者が`cancelled_before_send`にしたquestion revisionは、同じrevisionのまま復活させない。

PR通知先は`registerPrNotificationTarget`で登録し、`targetId`を正規execution/attemptへのaliasとして解決する。正規宛先は`targetExecution={launchId, runId, attemptId}`で保持する。重複keyは正規event IDである`logicalMessageId`、revision、canonical execution/attemptで構成する。異なる正規targetなら同じeventを通知できるが、同じ正規targetへの別名登録による重複試行は禁止する。

handoffによってPR通知のtargetIdを変換したり、別targetへ自動転送したりしない。

## 質問と単一配送台帳

質問は親ownerではなく質問を発行した子Cの`executionBinding`へ送る。

親ownerが未確認または終了済みなら質問配信を保留するが、その状態だけで子の終了や質問の解決を生成しない。

認証済みhandoffの取込み後、子Cと新owner Bの現在状態を再照合できれば、質問の宛先は同じCのまま配信を再開できる。

questionの送信開始後は、handoffや再接続を理由に再送しない。

子Cまたはowner Bのどちらかが再接続した場合は、その接続世代に対応する`currentProof`を失効させ、両者を再照合する。
回答の選択履歴と配送状態は別の属性として保持するが、取消とsend-startの勝敗は一つの配送台帳が決める。
`available`またはローカル予約のみの`claimed`は、取消を確定し、同じdeliveryのsend-startを拒否できる。
`sending`、`accepted`、`unknown`では取消要求だけを記録し、未送信が証明できないため取消確定や自動再送を行わない。
`accepted`はtransportが受け付けた状態であり、入力が適用された証拠ではない。
`applied`は取消で巻き戻さず、適用証拠と取消要求履歴を両方残す。
`sendStart(deliveryAttemptId)`は台帳の`executionId`から対象実行を特定し、`currentProof`を内部照合した後に`sending`を永続化する操作である。
永続化に成功した後にだけruntime向けtransportへ回答payloadを渡す。
send-startの保存に失敗した場合、payloadを一切渡さず配信を開始しない。
取消とsend-startは単一writerまたは同等の直列化境界で競合を解決し、状態確認とpayload露出の間に取消が割り込めないようにする。
MCPの登録と状態照会は回答payloadを返さない。
回答を取得するpollは配送操作としてsend-startを通し、同じdeliveryから二度payloadを返さない。
native質問応答は対象thread、turn、item、質問IDを照合してからsend-startを保存し、元UIの解決が先なら送信しない。通常指示への変換は#175の配送契約を使い、質問の取消状態だけで許可要求へ変換しない。
runtimeの受付、pipe書込み成功、MCP応答を入力適用の証拠とみなさない。
適用は対象periodId、要求、delivery、回答revisionまたはdigest、native turnやitemなど取得可能な相関値で確認する。
必要な相関値を取得できない経路は`accepted`または`unknown`に留める。

## 失敗、復旧、再照合

状態をsnapshotへ保存して復旧するときは、過去の稼働証拠を無効化し、現在の認証済み登録、periodId、owner generation、接続世代を再照合する。
復旧時に`sending`または`accepted`で適用未確認の配送は`unknown`へ移し、自動再送しない。
`available`または`claimed`を未送信として再予約できるのは、payloadが露出していない保存契約と現在宛先を再確認できる場合に限る。
切断、timeout、プロセス終了だけでは未送信を証明しない。
古いperiodId、別delivery、異なるrevisionのackは拒否し、相関が一致する遅延適用証拠は取消要求後でも保持する。
保存に失敗したときはruntimeへ回答payloadを渡さず、画面でも取消確定、受付済み、適用済みへ進めない。
照合できない状態は`unverified`または`unknown`として理由とともに保留する。

## 採用前の検証

共有契約モデルでは永続化snapshotを通したhandoff、復旧、競合、遅延イベントの試験を行う。

契約モデルの確認には次のコマンドを使う。

```text
node --test --test-isolation=none poc/codex-cross-contracts/contract-model.test.js
```

このモデルの合格は契約状態の整合を示す範囲に限り、製品store、collector認証、実runtime、OS権限、UIの合格へ広げない。

| Issue | 採用前に検証する責務 |
|---|---|
| #166 | provider、nativeIdKind、host、HOME scope、conversationIdと`executionBinding`の正規化、一つの実宛先への重複登録防止 |
| #167 | 正規IDのhook登録、親期間終了と取消状態の表示、欠落・重複イベント、モックと画面の整合 |
| #170 | 管理app-server接続、元CLIの権限維持、切断中イベント、再接続、所有プロセスの終了 |
| #171 | 認証済み起動登録と`originBinding`/`executionBinding`/`currentOwner`の境界、切断中handoffの証明取込み、実親子の照合 |
| #174 | questionの子自身への宛先、owner不在時の保留、取消/send-startの実時間競合、native質問と元UIの照合 |
| #175 | 登録・送信・受付・適用の相関、宛先固定、曖昧な結果の再送抑止 |
| #177 | snapshot復旧、実行とowner両方のcurrentProof失効、保存後handoff取込み、payload再取得とrevision/digest照合、未送信台帳と現行宛先の再照合 |
| #179 | PR作成元と通知先の分離、正規execution/attemptへのtarget alias解決、event/revision/canonical targetでの重複排除、応答喪失、終了後通知 |
| #180 | vendor別runner、実native IDとprofile、tool有効時の権限、実Claude cancelと子孫終了 |

各Issueはこの文書を参照し、実測できた範囲と未確認の範囲を記録してから採用を判断する。
ユーザーの判断が必要な導入設定が判明した場合は、導入手順の前提として具体的に示す。
