# 通常指示の配信契約

## 適用範囲と未接続の能力

通常指示は専用台帳、サービス、provider adapter、入力証拠correlator、HTTPとダッシュボードで扱う。
nativeへの送信能力は所有プロセスと接続世代を管理するruntimeの責務とする。
既存writerFor/authorizeWriterは登録の認可であり、指示送信能力ではない。
read-only sourceへ汎用RPCを追加しない。
未接続時はinstruction_dispatch_unavailableとして保留し、fixtureを実native配信成功と記録しない。
合同検証ではmodeごとのnative能力を確認する。next-user-inputが未対応のownerへは送信せず、保存済みmodeをstartへ暗黙に置き換えない。
runtime担当が同一sourceへの明示入力開始をcanonical modeとdigestのまま実装し、契約適合試験を通した後に接続する。

## 保存する指示

ledger kindはinstruction、targetはsource自身のexecutionTarget、logical keyはkind/sourceExecutionId/logicalMessageId/revisionである。
canonical clientRequestIdはdeliveryAttemptIdである。
既存v1のdelivery必須fieldは増やさず、payloadは次の厳密JSON envelopeをUTF8で保存対象digestへ変換する。

```json
{"schemaVersion":1,"mode":"steer","expectedTurnId":"native-turn","input":[{"type":"text","text":"指示本文","text_elements":[]}]}
```

modeはsteer/start/next-user-inputだけとする。
steerのexpectedTurnIdは必須、start/next-user-inputはnull。
inputは1個のtext要素のみ。空、未知field、非text、不明text_elementsを拒否し、省略や部分一致でdigestを計算しない。
ledger payloadDigestはenvelope全体のUTF8sha256。
nativeContentDigestはJSON.stringify(input)のUTF8sha256であり、ledger digestと混同しない。
startは利用者の明示選択でstopped standaloneのみ、next-user-inputは未送信standaloneの明示別送のみ。
steerの失敗をstartへ自動fallbackしない。
生成だけで送信せず、sendは別の明示操作。

## trusted owner injection

createProviderInstructionAdapter(provider,{deliveryAdapter,nativeOwner})へruntimeが所有する非HTTPのオブジェクトを渡す。
trusted ownerは以下の限定interfaceを実装する。

- prepareInstructionDispatch(metadata): 非同期可。完全target、dispatch mode、expectedTurnId、clientRequestId、両digestを受け、opaque capabilityを返す。本文は受け取らない。
- checkInstructionDispatch(capability,metadata): 同期boolean。生のJSONやverified flagで認可せず、所有source/connection世代/同period/launch-run-attempt/actor/現在turnと待機条件を再確認する。
- dispatchInstructionNow(capability,command): 同期で最後の認可とnative writeを開始し、その後の応答Promiseを戻せる。commandは固定metadata＋inputで、任意method/threadを指定できない。一回だけ使用可。
- subscribeInstructionEvidence(listener): 認証済みsource由来evidenceをlistener(capability, evidence)へ渡し、unsubscribeを返す。

metadataのtargetはledgerの完全targetとsource claimsで固定する。
capabilityの生オブジェクトはHTTP、dashboard、checkpoint、ログへ出さない。
ownerはevidenceを通知するたびに同owned source、接続世代、lease、period、actorを照合する。切断や所有変更で失効したcapabilityに対する遅延callbackを通知しない。
storeのverifyInstructionTarget(delivery)はadapterの同期verifyDeliveryTarget(delivery)へ注入する。
capabilityを用意する前のverifyはfalseで、send操作開始時にprepareし、store.sendStartへ同期sinkを渡す。
storeでsending保存後にverify→sinkの同期最終check→native writeまでawaitを挟まない。
送信後ack処理はsink外の非同期経路。Promiseを返すだけで書込みを後回しにする実装は契約違反である。

working/active delegatedはexpected turn付きsteerだけ。
reviewへの通常指示とended delegatedは拒否する。
startはturn終了済みだがcanonical periodは未終了、同attempt/owned接続が再認証済みのstandaloneだけ。
質問/許可待ち、旧period、切断、能力世代の差替えは保留する。

## normalized response/evidence

accepted responseは{clientRequestId,nativeTurnId,nativeItemId:null}を固定capabilityの応答として取り込む。
steerは期待turnと一致、startは応答で新turnを確定する。
受付だけでappliedへ進めない。
evidenceはcapability所有sourceと結び付く完全target/sourceClaims、clientRequestId、nativeTurnId、nativeItemId、nativeContentDigestを持つ。
adapterはnativeの完全inputを正規化してdigestを計算し、非text/要素差異は一致と扱わない。
adapterはprepareが返した同一opaque capability参照をWeakMapで照合し、未知または別sourceのcapabilityを拒否する。
native writeを開始する前の証拠は採用せず、writeの同期呼出し中に届く証拠からpending entryへ相関する。
受付前evidenceのbufferは最大128件、256KiB、60秒まで。超過/期限切れは未適用試行をunknownにし、自動再送しない。
旧source/period/differentidentityは拒否する。適用保存開始前に同requestの内容/turn矛盾を検出した場合はunknownで閉じ、後着一致で解除しない。
既にappliedは巻き戻さず、矛盾診断だけを残す。
同nativeitemを別requestへ再利用せず台帳のitem所有検査を使用する。
restore時はcapability/bufferを復元しない。sending/acceptedは既存storeでunknown、未送信だけ明示sendに必要な再認証が可能。

CodexCLI0.160.1のschemaではTurnStart/TurnSteerにclientUserMessageId、steerにはexpectedTurnIdがある。
ItemStartedNotificationのthreadId/turnIdとUserMessageThreadItemのid/content/clientIdが相関候補である。
clientUserMessageIdからitem.clientIdへの対応はschema存在だけでは証明できず実native確認gateとして残す。
Claudeも同attempt/contextの入力証拠と完全digestを証明できるまではaccepted/unknownに留める。

## runtimeとの接続schema

prepareInstructionDispatchとcheckInstructionDispatchは、次の固定metadataを受け取る。
sourceとtargetは台帳に保存した完全な実行情報である。
clientRequestIdにはdeliveryAttemptIdを使用する。

```js
{
  deliveryAttemptId, revision, payloadDigest, nativeContentDigest,
  source, target, mode, expectedTurnId
}
```

dispatchInstructionNowのcommandはmetadataにinputを加えたobjectである。
任意のmethodや送信先threadを指定するキーは設けない。
subscribeInstructionEvidenceのlistenerには同一capability参照と次のobjectを渡す。

```js
{
  source, target, clientRequestId, nativeTurnId, nativeItemId,
  input: [{ type: 'text', text, text_elements: [] }]
}
```

sourceにはlaunchRef、claims、identity、executionBinding、conversationId、sessionIdを含む。
claimsにはlaunch/run/attempt、provider/nativeIdKind/hostId/homeScopeId、origin/purpose/originBindingを含む。
identityはprovider/nativeIdKind/hostId/homeScopeId/nativeId、executionBindingはperiodIdとactorである。
targetはkindがexecutionのsource自身の実行情報で、executionBindingをperiodIdとactorに展開する。
完全inputのdigestはadapterとcorrelatorが計算し、digestだけを根拠とした反映確認は受け付けない。

prepareと受付応答の待機上限は各5秒とする。
送信開始保存後は同期verify、envelope照合、同期owner check、correlatorとadapterのdispatchingへの遷移、ownerの同期writeの順に進める。
受付を保存している間も入力証拠を上限付きで保持する。
送信前に届いた証拠は採用しない。
## 共通scenarioと独立期待

| ID | 操作、観測点 | 独立期待、禁止副作用 |
|---|---|---|
| I01 | 両providerのworking steer | 固定native/period/attempt/expected turnへwrite1、start0 |
| I02 | stopped standalone明示start | 同native/period/attemptへstart1、別thread0 |
| I03 | delegated/review/end/wait/切断/誤HOME | write0、steer→start fallback0 |
| I04 | sending保存失敗/保存中能力失効 | payload露出0、write0、再送0 |
| I05 | native応答喪失/復旧 | unknown、別request発行0、write累計1 |
| I06 | 受付のみ | accepted、applied0 |
| I07 | 受付前後の完全入力証拠 | matching target/request/turn/item/contentだけapplied、write1 |
| I08 | 部分内容/旧period/他source/item再利用 | 誤applied0、矛盾はunknown、別送0 |
| I09 | bounded buffer超過/TTL | unknown、際限ないメモリ保持0 |
| I10 | explicit alternative UNSENT standalone | 旧supersede保存後だけ新instruction、旧送信0、保存失敗時新規0 |
| I11 | lateanswer明示変換 | UNSENT instruction1、自動write0、質問/許可応答0 |
| I12 | HTTP Origin/secret/full scope | 不正requestのcreate/write0、本文漏洩0 |
| I13 | 旧3kind checkpoint/最大correlation容量 | 旧fixture復旧、改変instructiontarget拒否、終端保存容量維持 |

製品file store＋両実adapterのfixture試験と、実native同sourceでの能力、入力相関確認を別々に記録する。
実nativeの不足能力はruntime実装を結合したlocal integration branchで確認し、GitHub mergeを行わない。


## 指示ジャーナルと復旧

送信方針を再起動後も照合するため、サービスはcheckpointと別の専用ジャーナルへ作成意図を先に保存する。
作成意図は固定ID、source projection、envelopeとdigestを含み、opaque capabilityとproofは保存しない。
ジャーナル保存後にinstruction台帳を作るため、保存失敗時は台帳作成とnativeへの本文露出を行わない。
同deliveryAttemptIdの再要求は保存済み意図と完全一致した場合だけ同じ台帳へ回収する。
本文を保存するファイルは0600、最大20,000件かつ16MiBとし、状態応答とログへ本文を出さない。
available/claimedの復旧後は利用者の明示sendで現在能力を準備し、元digestを照合してからpayloadを復元する。
sending/acceptedは既存checkpoint復旧でunknownにし、自動再送しない。

## ダッシュボードの対象表示

HTTP組立はlaunchRegistryの公開snapshotとregistrationRegistryを完全照合し、対象候補のlaunchRef、sessionId、executionId、identity、originを表示する。
expected turnを利用者に手入力させないため、信頼済み組立は同期instructionTargetState(launchRef)を任意注入できる。
返す表示情報はstatus（working/stopped/waiting/unverified）、nativeTurnId、reasonとし、未接続はunverifiedとして表示する。
このprojectionは送信権限を持たず、prepareと書込み直前のopaque能力照合を省略できない。

## 適用証拠の採用と永続化の境界

correlatorのapplyingは保存待ちであり、反映確定ではない。
台帳writerがprovider、instruction kind、配送相関、遷移候補を検証した後、保存開始直前に同期beginCommitを呼ぶ。
beginCommitは同一pending entry、source token、証拠、applying状態、未失効を検査し、成功時にcommittingへ一回だけ進める。
false、例外、Promise、thenableは保存を開始せず拒否する。
この成功が証拠採用の線形化点であり、保存呼出しまでawaitを挟まない。

service queue、get、store writerの待機中に届いた矛盾は、この境界より前なのでunknownで閉じる。
境界を越えて保存中に届いた矛盾は後着診断として保持し、終端を二重に確定しない。
TTL、応答喪失、closeもcommitting中の保存結果を先回りして確定しない。
appliedは保存成功後にだけ公開する。
保存失敗や結果不明時はappliedの成功を通知せず、unknownまたはwriter blockedとして再送を禁止する。
既存question/result/PR通知のrecordAppliedにはこのinstruction専用guardを適用しない。

## 送信前の本文確認

保存と送信は別の操作とし、保存済み指示の本文、対象、送信方法、保存時刻を確認してから送信する。
本文を含む状態応答は公開しないため、同一タブで作成した指示の確認用本文だけをsessionStorageに保持する。
確認用本文が失われた指示は送信できない状態にし、識別子だけを見て送信させない。
送信後は受付済みと入力反映済みを別々に示し、結果不明の指示には再送操作を出さない。
late answerはジャーナルのindexとdigestを照合して未送信指示へ変換し、変換操作では送信を開始しない。
