# Owned native instruction dispatch

## 固定する認可

instruction ownerは同attemptのprivate source capabilityに閉じる。
metadataはdeliveryAttemptId、revision、payloadDigest、nativeContentDigest、source、target、mode、expectedTurnIdの8キー、commandはinputを加えた9キーだけを持つ。
clientRequestIdはdeliveryAttemptIdと同一にする。
sourceとexecution targetは完全なidentity、claims、actor/period、launch/run/attempt、conversation/sessionを照合する。
opaque capability、current read lease、native receiptを公開JSONから再構築しない。
readonly source facadeにはwriterや汎用RPCを追加しない。

workingは固定expected turnのCodex steerだけを認可し、Claude workingはunsupportedとする。
stoppedの明示startはmatching native terminalを確認したstandaloneだけへ同native thread/sessionで送る。
context終了後も同actorのopaque life handleを保持し、kernelのcallback-free actor lifetime検査で確認する。
context proofとauthorizeWriterの認可を緩和せず、actor-only capabilityをproof、steer、delegated、reviewへ転用しない。
early terminalでactorが未attestならactor lifetimeの証拠を作らない。
source/detach/period/actor失効、fresh確認前、wait、review、ended delegatedはwriteを拒否する。
再接続後にstoppedのfresh証拠を確認できない場合もunknown/unsupportedのまま保持する。

serializer、metadata callback、stdin/write取得は最終guardより前に完了する。
canonical registration/launch stamp、private proofまたはactor lifetime、source/lease/connection/epoch/ownerの最終確認から、capability消費とcaptured stdin writeまでawait、callback、getter、serializerを挟まない。
write開始後にだけack Promiseを返す。
受付はapplied証拠と区別し、native完全input receiptをfixed source/target/request/turn/itemへ相関する。
Claude echo、外部verified値、部分inputからappliedを作らない。

## 独立した適合期待

| ID | 操作と観測点 | 期待値と禁止副作用 | 期限・許容差・能力条件 |
|---|---|---|---|
| ID-F08-NI01 | active fixed expected turnへのCodex steer。両provider実runner fakepipeと実kernel。 | write1、turn/start0、別thread0。Claude workingはunsupported/write0。 | fixture5秒。同期write同callstack、差0。Codexsteerのみ、Claudeunsupported。 |
| ID-F08-NI02 | matching terminal後のstandalone明示start。actor lifetimeとcanonical period。 | 同native/period/attemptへstart1、旧context proof流用0、新contextだけattest。early terminal actor未確認はwrite0。 | prepare/ack各5秒。write1/別thread0、差0。matchingterminalとattested actor必須。 |
| ID-F08-NI03 | review、ended delegated、wait、clone/foreign capability、誤HOME/native/period/source、fresh前cache。 | write0、fallback0、actor/proof創作0。 | 同期guard同callstack、write許容差0。opaque source/lease全条件必須。 |
| ID-F08-NI04 | send-start相当境界後のsource/period/context/actor/owner失効。 | 同期sink write0、unknown、retry0。service/storeは別担当で、本fixtureはsink契約境界を使用。 | 同期sink同callstack、write許容差0。保存後の再認可が必須。 |
| ID-F08-NI05 | 最後のmetadataまたはstdin/write getter内で失効。 | stamp/private最終guardによりwrite0、既存新能力破壊0。 | 最終guard同callstack、write許容差0。callback期後のcanonical/privatecheck必須。 |
| ID-F08-NI06 | start itemがackより先、terminalがstart ackより先。 | ack turn一致後のみcandidateを採用。terminal先着はnegativeのみ、active proof0。 | ack5秒、candidateTTL60秒。turn/item/clientId完全一致、部分一致0。 |
| ID-F08-NI07 | write false、throw、ack timeout、受付のみ。 | backpressureを再送しない。実write開始累計1以下、accepted/applied区別、unknown retry0。 | ack5秒。再送許容差0。actualwrite開始と応答/適用を分離。 |
| ID-F08-NI08 | lease/connection新世代とold cap/late item。 | old write/evidence0、同numeric generationだけの認可0。 | fixture5秒。old write/evidence許容差0。同physical source/privateepoch必須。 |
| ID-F08-NI09 | capability/evidence容量と期限。 | 128件、256KiB、60秒を超えて保持せずunknown。callback subscriberはwrite call返却後だけ、write1へ相関。 | cap/候補128件・256KiB・TTL60秒。上限の超過許容差0。 |

fixture結果と実native接続結果は別に記録する。
Codex clientUserMessageIdからitem.clientIdへの実対応と、Claude同contextの真正入力証拠はlive採用gateとして残す。

Codex 0.160.1のinstalled schemaは、隔離HOMEで`codex app-server generate-json-schema --out <directory>`を実行して再生成できる。
TurnSteerParamsはexpectedTurnId必須でclientUserMessageIdを持ち、TurnStartParamsもclientUserMessageIdを持つ。
ItemStarted/CompletedのuserMessageはclientId/content/idを持つ。
Textのtext_elements省略はschema既定の空配列へnative parserだけで補完し、非空span、未知キー、不完全本文は拒否する。
生成結果ファイルはPRの検証記録とし、公開契約の正本にはしない。
expectedTurnId/clientUserMessageIdとuserMessage itemのclientId/content/idはinstalled schemaで確認済みだが、clientIdの実対応は未確認である。
missing clientIdはappliedへ昇格させずaccepted/unknownに留める。
ownerのack戻り値は実Promiseであり、thenableを受け付けない。
next-user-inputはnative ownerではunsupportedとし、明示alternativeの台帳操作は別サービスで扱う。

## Trusted owner API と寿命

composition.createInstructionOwner(admissionReceipt)は同admissionのownerを冪等に返す。
prepareInstructionDispatch(metadata)は本文なしのopaque capabilityを返し、checkInstructionDispatch(capability, metadata)は同期booleanで認可する。
dispatchInstructionNow(capability, command)は最終guardから同callstackでwriteを開始し、その後にackの実Promiseを返す。
subscribeInstructionEvidence(listener)はlistener(capability, evidence)を購読し、解除関数を返す。
ackはclientRequestId/nativeTurnId/nativeItemId、evidenceはsource/target/clientRequestId/nativeTurnId/nativeItemId/inputだけを持つ。

prepare時のcanonical revision、owner/context/private proofまたはactor lifetime認可を保持し、dispatch時の新captureだけで別世代を認可し直さない。
start後のevidenceは新contextのproofを検査する一方、元のopaque loan/source/connection/epoch/current-owner generationを別のscope guardで保持する。
checkSourceとcheckLeaseはprivate state/WeakMapだけを読み、最終scope検査後にもcanonical revisionを再照合する。
serviceでsend-startを永続保存した後は、同ownerのcheckと同期dispatchを呼び、途中await後の消費では再gateを必須とする。

read-only source facadeのAPIは増やさない。
writerは同child controllerがsource capabilityへ一度だけ結び付ける別のprivate accessorから取得する。
RPC IDはlifecycleを小整数、readを2^32以上2^48未満、instructionを2^48以上のsafe整数へ分離する。
発行していないresponseは成功扱いにせず、既存protocolのfail-closedを維持する。

capability、消費済みdelivery ID、native item帰属はsource lifetimeで128件に制限し、上限後はfail-closedにする。
本文と候補receiptは全source合計256KiB/候補128件/TTL60秒に制限し、期限後に本文・候補・receiptを解放する。
IDとitemの帰属tombstoneは期限後も保持し、同delivery retryやitemの別requestへの再帰属を認可しない。
ack timeoutやwrite errorの後着responseはpositive contextへ昇格させず、早期terminalはnegativeだけを採用する。

## Fixture検証記録

専用fixture 46件を含むrunner/source/collector/composition/runtime関連251件が通過した。
全体のnpm testは1530件すべてが成功し、失敗、skip、cancelはなかった。
専用fixtureは両providerの実runnerと実kernelをfake stdioへ接続し、NI01..NI08のwrite/actor/proof/evidenceを直接観測する。
delegated/reviewの親だけはtrusted lifecycle fixtureであり、対象childは実runnerである。
NI09の期限とglobal容量は別module instanceの制御clockでprivate APIを呼び、productionへtest専用clockを追加していない。
service永続化は同期sink契約境界で検査し、実store/serviceの結合検証は別担当の採用gateとする。
実native実行はこのfixture結果に含めない。

## 実nativeで確認した範囲

実装コミット3969d72でClaude CLI 2.1.291を隔離HOMEへ起動した。
同じowned process/sessionでmatching terminal後のstandalone startが受け付けられ、同じidentityと実行期間のまま別contextへ進んだ。
spawnは1回、writerのdispatchは1回、観測contextは2件だった。
古いproofとwriterは拒否され、終了後もactorと実行期間はactive、各contextはendedだった。
通常Codex/Claude認証ファイルの変化と、隔離HOMEの認証artifact作成はいずれもゼロだった。
owned childの終了とcloseを確認した。

この実行は受付と次contextを確認したもので、Claude echoからappliedを認定していない。
Claude working steer、真正inputの適用証拠、delegated、handoff、再接続の採用gateは未確認である。
Codexの実client ID対応は本人ログイン後の実接続結果で別に記録する。