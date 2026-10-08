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
未使用capabilityの60秒期限と、受付応答を確定する5秒期限は維持する。
ACK未確定のタイムアウトは後着証拠による回復の対象にしない。
ACK確定後は、終了通知と閉鎖操作を上下に伝えられるowned native経路に限り、観測期限後のunknown相関と入力を現在turnの終了まで保持する。
観測期限ではunknownを一度通知し、同じsource token、実行、thread、turn、request、入力全文に一致する後着証拠だけを保存してappliedへ進める。
終端、停止、source失効、明示的RPC拒否、不一致では受付を閉じ、入力予約を回収する。
保持するunknownも128件と256KiBの容量制約に含め、容量を増やしたり自動再送したりしない。
閉鎖通知を持たない既存ownerは60秒で相関を回収する。
閉鎖操作は同じcapability、metadata、source tokenを照合し、古いcontextの完了で後続contextを閉じない。
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
beginCommitは同一pending entry、source token、証拠、applying状態、矛盾がないことを検査し、成功時にcommittingへ一回だけ進める。
false、例外、Promise、thenableは保存を開始せず拒否する。
この成功が証拠採用の線形化点であり、保存呼出しまでawaitを挟まない。

service queue、get、store writerの待機中に届いた矛盾は、この境界より前なのでunknownで閉じる。
境界を越えて保存中に届いた矛盾は後着診断として保持し、終端を二重に確定しない。
TTL、応答喪失、closeもcommitting中の保存結果を先回りして確定しない。
観測期限はapplyingに入った証拠の保存待ちも打ち切らない。
appliedは保存成功後にだけ公開する。
保存失敗や結果不明時はappliedの成功を通知せず、unknownまたはwriter blockedとして再送を禁止する。
既存question/result/PR通知のrecordAppliedにはこのinstruction専用guardを適用しない。

## 送信前の本文確認

保存と送信は別の操作とし、保存済み指示の本文、対象、送信方法、保存時刻を確認してから送信する。
本文を含む状態応答は公開しないため、同一タブで作成した指示の確認用本文だけをsessionStorageに保持する。
確認用本文が失われた指示は送信できない状態にし、識別子だけを見て送信させない。
送信後は受付済みと入力反映済みを別々に示し、結果不明の指示には再送操作を出さない。
late answerはジャーナルのindexとdigestを照合して未送信指示へ変換し、変換操作では送信を開始しない。

## 画面の保存要求と復旧

入力と保存済み指示の確認は、既存の判断事項カードと同じ見出し、説明、自由記入欄、操作と状態表示の配置を使う。
枠のない区画の中で、追加指示の入力カードを先に、保存済み指示のカードを後に置く。
カードを別のカードの中に入れず、操作欄には下書き、保存中、保存結果を表示する。
会話の行に対応する実行が一意な場合は宛先と送信方法を表示し、選択肢が一つだけのプルダウンは置かない。
実行先が複数ある場合だけ、既存の選択肢の部品で宛先を明示選択する。
選択した実行先が現在の候補に一件だけ存在することを照合し、候補の追加や並べ替えで宛先を変更しない。
編集中に宛先、実行期間、世代、送信方法が変わった場合は、下書きを保持して保存を止める。
本文がある下書きで状態変化を観測した後は、元と同じ状態に戻っても明示確認まで保存を再開しない。
候補が複数ある場合や対象が消えた場合も、別の実行へ自動的に付け替えない。
実行先が一つに確定した場合、または複数の候補から明示選択した場合は、現在の宛先と送信方法を表示し、開発者が明示的に確認した後に同じ本文で下書きを続けられる。
正常に取得した状態を受け取るたび、本文のある下書きの対象を照合する。カードを畳んだり非表示にしたりしても、観測した不一致を保持する。
状態の取得間隔の間に起きて観測できなかった変化は画面では保証できないため、保存と送信の時点でもサーバーで実行先を再検証する。
この操作では保存済み指示を変更せず、待機や結果不明による保存と送信の保留も解除しない。
本人への質問待ち、許可待ち、結果不明の間も入力は保持し、保存と送信を保留する。
保存後は本文、宛先、送信方法を確認してから明示的に送信し、保存済みの送信方法を状態変化に合わせて書き換えない。

差し替えの保存要求は、最初の送信前に旧指示ID、対象、実行期間、新指示ID、logical ID、revision、本文、modeを固定する。
保存結果が不明な間は本文を変更せず、同じ要求で保存結果を確認する。
旧指示がsuperseded_before_sendになっても、未完了要求の復旧表示を残す。
応答の対象と新指示の情報が固定要求と一致した後にだけ確認用本文を登録し、復旧要求を解消する。
snapshotに新指示IDが現れたことだけでは本文との対応を確定しない。

UI版変更による自動再読み込みは、指示の入力、IME変換、保存などの操作中、復旧可能な未完了要求がある間は保留する。
保存成功後に残る選択値と、終了した実行の単なる下書きは保留理由にしない。
配送記録とstate versionが同じでも、本文を含まない対象の状態、turn、候補、診断の投影が変わったら表示を更新する。

| ID | 操作、観測点 | 独立期待、禁止副作用 |
|---|---|---|
| I14 | 配送記録と版を固定して対象状態・turn・候補・診断だけ変更 | 表示と操作可否を更新し、native write0 |
| I15 | 旧superseded保存後の新保存失敗・成功応答喪失 | 固定した同一要求だけ明示retry、応答一致前preview0、native write0 |
| I16 | 指示・差し替えの入力、IME、操作中にUI版変更 | 自動reload0、入力保持。成功後の選択値だけでは保留しない |
| I17 | 復旧要求の保存上限・保存失敗・改変された応答 | ローカル保存失敗ではPOST0、改変応答ではpreview0。本文保持、明示整理を案内 |

配送記録が欠けた差し替えの保存確認は、固定要求と旧・新記録の対象、論理ID、revisionが一致する場合だけ許可する。
画面で保持した新revisionは、旧revisionの直後の値でなければならない。
旧記録は `superseded_before_send`、新記録は `unavailable` かつ理由が `instruction_delivery_missing`、診断は同じ理由による `blocked` である必要がある。
現在の対象は同じ停止中の独立実行でなければならない。
他の保存エラーや照合不一致を、この例外で許可しない。

この確認操作は、サービス内部の書き込み停止を解除しない。
checkpointの書き込みに失敗したプロセスでは、書き込み停止によって再試行が拒否される。
正常なcheckpointを再起動で読み直した後、同じ要求のジャーナルを再利用して未送信の配送記録を補完する。

保存応答が一致しても、本文previewのタブ内保存が完了するまで固定要求を削除しない。
本文previewは、保存値の読み戻しが一致したときだけ永続化成功とする。
失敗した場合は、サーバーへの保存確認とタブ内の本文保存を分けて表示し、固定要求と本文を保持する。

| ID | 条件 | 期待する結果 |
| --- | --- | --- |
| I18 | 旧指示と新journalの保存後、新deliveryのcheckpoint保存だけ失敗し、同じファイルから再起動する | 同プロセスは書き込み停止を維持し、再起動後の固定要求確認で未送信を復旧する。native writeは0回 |
| I19 | 固定要求の保存は成功し、本文previewの保存だけ例外または読み戻し不一致になる | 固定要求と本文を保持する。タブ再読込後も復旧し、本文previewの永続化成功後にだけ固定要求を削除する |

通常指示と後続回答の指示化では、サーバーの保存応答が成功した後、本文previewの永続化だけが失敗する場合がある。
この場合は、保存済みのinstruction投影と送信時の本文を、タブ内の本文保存待ちとして保持する。
保存待ちは、保存要求中の予約と合わせて64件まで保持する。
上限に達した場合は、新しいサーバー保存を開始せず、入力内容を保持する。
保存待ちの復旧操作は、ローカル保存と読み戻しだけを行う。
現在の実行先、turn、modeからサーバーへの要求を組み直さない。

通常指示の保存済み本文とIDは、本文保存待ちへ移した後に入力欄から消す。
その後に新しく入力した下書きは、古い本文の復旧操作で変更しない。
後続回答は質問ID、回答のindex、digestとの対応を保持し、同じ回答の再操作では本文保存だけを確認する。

本文保存待ちがある間は自動再読み込みを保留する。
本文はまだタブ内に永続化できていないため、保存前にタブを閉じると復元できないことを復旧欄に表示する。

| ID | 条件 | 期待する結果 |
| --- | --- | --- |
| I20 | 通常指示・後続回答のサーバー保存成功後、本文preview保存だけ失敗し、対象のturn・mode・状態を変更する | 明示した本文保存操作で初回本文を復旧し、サーバーPOSTは初回の1回だけ。新しく編集した通常下書きは変更しない |
