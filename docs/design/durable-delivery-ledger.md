# 配信台帳と登録checkpointの基盤

## 対象と採用境界

この文書は#175-Aの配信台帳と#177-Aの保存境界を定める。
#175は台帳の意味と操作、#177は検証済みcheckpointと復元を担当する。
同じ製品storeが両者を接続し、取消とsend-startを直列化する。
通常transport、native質問、結果runner、PR通知画面、完全handoff復旧は後続Issueで接続する。
両providerの製品adapterを通すfixture試験を実runtime配信成功と合算しない。

## 所有と組立

新規src/server/delivery-ledger.jsは台帳schemaと状態遷移を所有する。
新規src/server/durable-checkpoint.jsは登録保存schema、検証、原子的ファイル置換を所有する。
新規src/server/durable-delivery-store.jsは製品store、操作直列化、payload保管と両provider adapterを所有する。
既存json-storage.jsのatomicWriteJsonを再利用する。
共有state、events、server、MCP、collector、166/171核は変更しない。

信頼済みdaemon組立だけがlive registryとproof resolverをstoreへ注入する。
HTTP、MCP、checkpointのverified booleanや公開proof要約をauthorityとして扱わない。
#170は接続、actor照合、opaque proofの保持を所有する。
questionとPR通知はruntimeRegistry.get/snapshotとresolveProof(launchRef)を読み、registry.checkCurrentProofを使用直前に呼ぶ。
resultは固定ownerのkind別trusted verifierを要求し、子終了後の返却を子のactive proofで代用しない。
result verifierが未接続なら拒否し、実native owner認証は#170/#175-B統合ゲートとする。
resolverは同期で、Promise、欠落、例外は配信保留とする。
保存した接続世代は観測情報であり、live証拠を代替しない。

## 宛先と論理key

executionIdは#166のperiodIdであり、launch/run/attemptとは別に保持する。
questionとresultのkeyは種別、source executionId、logicalMessageId、revisionである。
PR通知のkeyはlogicalMessageId、revision、正規target launch/run/attemptであり、aliasによって重複できない。
deliveryAttemptIdは個別試行の主キーであり、同ID同内容の再登録だけを冪等として扱う。
内容はUTF-8文字列のSHA-256 digestで固定し、同revisionの内容すり替えを拒否する。

questionは発行した実行自身のexecutionBindingへ固定する。
resultは作成時点のcurrentOwnerとownerGenerationへ固定する。
PR通知は明示登録したtargetIdから正規targetExecutionとexecutionBindingへ固定する。
起動元、不変executionBinding、現在ownerを混同せず、handoffによる自動転送を作らない。
送信直前のlive recordと固定したtargetを照合し、resultは記録時owner世代も一致させる。
questionとPR通知は正当handoff後も同じ未送信targetへ再開でき、新しいowner世代のfresh proofを要求する。

availableまたはclaimedだけが未送信である。
未送信のsupersedeを保存してから明示した別試行を作れる。
sending、accepted、unknown、appliedがある同keyには新試行を作らない。
cancelled_before_sendの同revisionを復活させない。
既存試行の状態確認や冪等再登録でpayloadを返さない。

## APIの境界

台帳moduleは純粋な検証と遷移関数を提供し、payloadとprivate handleを返さない。
製品storeの入口は`createDurableDeliveryStore({filePath, registrationRegistry, launchRegistry, runtimeRegistry, resolveProof, verifyResultOwner, atomicWrite?, limits?})`とする。
`ready`が復元を完了し、`flush()`はqueueの完了を待ち、`close()`は同じ保存先の所有を解放する。
provider入口は`createProviderDeliveryAdapter(provider, store)`とする。
question/resultの作成入力は`{launchRef, deliveryAttemptId, logicalMessageId, revision, payload}`とする。
PR通知の作成入力は`{sourceLaunchRef, targetId, deliveryAttemptId, logicalMessageId, revision, payload}`とし、作成元と通知先を別に解決する。
PR target登録入力は`{targetId, launchRef}`とする。
送信は`sendStart(deliveryAttemptId, trustedSink)`、相関保存は`recordAccepted(id, correlation)`と`recordApplied(id, correlation)`とする。
保存入口は`createDurableCheckpointStore({filePath, atomicWrite?, maxBytes?, maxRecords?})`の`load()`と`save(checkpoint)`とする。
checkpoint v1は`{schemaVersion, revision, registrations:{conversations,executions,launches,runtimeLaunches,connections,actors,handoffs}, ledger:{schemaVersion,revision,deliveries,notificationTargets,logicalTombstones}}`である。
pure台帳は`createEmptyLedger`、`validateLedger`、`createDelivery`、`registerPrTarget`、`transitionDelivery`、`recoverLedger`、`getDelivery`、`snapshotLedger`を提供する。
storeはcreateQuestionDelivery、createResultDelivery、registerPrNotificationTarget、createPrNotification、claim、cancel、supersedeUnsentDelivery、sendStart、recordAccepted、recordApplied、markUnknown、rehydratePayload、captureRegistrations、get、snapshotを提供する。
全mutationを同じwriterへ通し、保存成功後にだけ状態を公開する。
getとsnapshotはpayloadを含めず、private handleも含めない。
provider adapterはquestion/resultでsource、PR通知でtargetの完全identityのprovider/nativeIdKindを検査する。
作成後のclaim、取消、送信、受付、適用、unknown化、payload再取得も同じprovider境界を要求する。
PR作成元は通知先と異なるproviderを許し、通知先を作成元へ自動変換しない。
ownerは異providerも許し、子providerの制約を結果宛先へ誤適用しない。

sendStartは現行proof、固定宛先、内容一致、未送信を確認し、sendingを保存する。
保存成功後にproofと固定宛先を同期再検査し、同じ同期処理内でtrusted sinkを一度だけ呼びpayloadを渡す。
Promiseでpayloadを返して後から送るAPIは設けず、sinkへの引渡し後の例外もunknownとする。
保存待ちの間にproofを失効したらpayloadを露出せずunknownへ倒す。
unknownの追加保存が失敗してもsendingの保存が残るため自動再送しない。
sending保存の失敗では状態を進めずpayload露出と送信を0回にする。

取消が先ならcancelled_before_sendを保存し、sendStartを拒否する。
cancelled_before_sendまたはsuperseded_before_sendの保存成功後に、使用できなくなったpayloadをメモリーから解放する。
保存失敗時は未送信状態とpayloadを保持する。
send-startが先なら取消要求だけを保存し、未送信確定を作らない。
appliedの取消でも適用終端を保持し、取消要求履歴を残す。
受付応答とpipe書込み成功を適用証拠とみなさない。
recordAcceptedとrecordAppliedは完全なdelivery ID、revision、digest、固定target period、native相関を照合する。
異なるdelivery、期間、内容、再利用itemを拒否し、受付のみでappliedへ進めない。
相関はdeliveryAttemptId、revision、payloadDigest、targetPeriodId、nativeTurnId、nativeItemId、clientRequestIdを持つ。
この台帳のcanonical clientRequestIdはdeliveryAttemptIdに固定し、最初の受付または適用でも異なるrequest IDを拒否する。
wireのRPC IDやnative client IDが異なる場合は、#175-Bのtrusted adapterが送信時の対応を保持してcanonical requestへ照合する。
受付時はnative turn/itemが未取得ならnullを許し、turnだけ既知の受付も保持する。適用時は両native IDを要求する。
item所有は完全identity、期間、native turn/itemの組で照合し、別providerやHOMEの同名itemと混同しない。
認証済みnative相関を供給する主体は#170/#175-Bとし、Aのfixture成功を実native認証と扱わない。

## 保存と復元

checkpointはversionと単調なstore revision、登録projection、台帳、PR target aliasだけを持つ。
登録projectionは166の完全identityとconversation/execution/session ID、状態、171-Aの不変claimsとbinding、171-Bの完全不変claimsとcurrentOwner/ownerGenerationを別のlaunches/runtimeLaunchesへ保持する。
接続履歴はscopeと内部generation、actorは同scope/generationとの対応を保持し、connectionId自体を復元資格に使わない。
adopt直後でactor認証が未完了のruntime記録も、canonical periodと不変bindingの参照を確認して履歴へ保存する。
actor履歴の欠落をlive証拠として補完せず、送信時はkind別の現行検証を別に要求する。
観測metadata、秘密値、環境変数、会話全体、payload、writer token、connection/actor/proof handleは保存しない。
書き出すschemaを許可リストで構成し、checkpoint入力の未知キー、未知版、過大入力、重複ID、dangling reference、binding不整合を拒否する。
byte上限は既定1MiB、設定上限16MiBとし、登録projectionは合計50,000件までとする。
台帳は配信20,000件、PR alias10,000件、論理墓標20,000件までとし、保存byte上限も同時に適用する。
上限到達時は送信済みkeyや終端を間引かず、新規登録を拒否する。
製品storeは登録と復元時に、既存配信の取消・最大長の受付/適用相関・遅延受付・復元状態・revision桁数が必要とするserialized容量を予約する。
未知のnative IDはJSONエスケープの最大byte数で測り、計測用cloneだけを使うため保存schemaに予約値は追加しない。
実ファイルがハード上限内でも将来の確定操作の容量を確保できない場合は、明示した容量エラーで復元を拒否する。

保存結果が不明なI/O失敗ではstoreを書込み停止にし、旧メモリーからsending墓標を消す後続保存を拒否する。
同じ保存先は一つのstore instanceが所有する。
保存は同じdirectoryの一時ファイルからatomicWriteJsonで置換し、validation失敗または置換前のI/O失敗では直前の有効保存を保持する。
置換の成否が不明な失敗では、disk上の履歴を空台帳や古いbackupへ自動で巻き戻さない。
読み取り前にbyte上限を確認し、途中のファイル拡大も読み取り後に検査する。
本基盤が保証するのはAPI保存成功、原子的置換、プロセス障害後の論理境界であり、電源断に対するfsync保証は別に扱う。

復元したactive期間とbound実行はunknownとして保持し、ended終端は保持する。
現在proofは保存せず、復元結果もproofを持たない。
接続はinactiveで、認証済みregistryのauthorityを発行しない。
sendingとacceptedはunknown、applied、cancelled_before_send、superseded_before_sendは終端を保持する。
claimedはavailableへ戻すが、payload再取得と内容照合、現行宛先照合を終えるまでsendStartを拒否する。
rehydratePayloadは保存済みdigestと現行宛先の証拠を照合して、未送信payloadをメモリーへ戻す。
sendStartでも保存前後に証拠を再検査するため、再取得時の確認だけでは配信を許可しない。
保存したowner世代から複数世代進んだsnapshotの取り込みは拒否し、実行を自動で付け替えない。
保存後の連続handoff取り込みとlive registryの安全な再組立は#177-B/Cで扱う。

## 実装前の共通scenario

期待値は共有契約の宛先固定、取消とsend-startの境界、復元時の証拠失効から定める。
ClaudeとCodexの実registration/launch/runtime adapterと製品delivery adapter、実ファイルstoreを通す。
issuerとtransportの入力はfixtureであり、実CLI/native認証は未確認として残す。
共通登録APIにはperiod終了操作がないため、F05-A05の製品adapter試験は子actor終了後の独立owner返却を観測する。
canonical period終了後の実adapter配信は未確認とし、保存層のended期間fixture試験と合算しない。
各scenarioの期限は5秒、IDと時刻以外の許容差は0とする。
禁止副作用は実sendStartのpayload取得回数、接続したtransport spyへの実呼出し、実checkpoint byte内容、registry snapshotとwriter認可から観測する。

| ID | 操作と観測点 | 共通期待値と禁止副作用 |
|---|---|---|
| ID-F05-A01 | question、result、PR aliasを作成し保存後read | questionは子、resultは記録owner/gen、PRは明示target。payloadと秘密値の保存0、alias重複0 |
| ID-F05-A02 | claim後cancelとsendStartを両順序で競合 | cancel先は露出/送信0。send先は一度だけ露出、取消要求のみ、二度目露出0 |
| ID-F05-A03 | sending保存を失敗させ、再読取 | 直前有効保存と公開状態を保持。payload露出/送信0、取消確定の偽表示0 |
| ID-F05-A04 | send保存を保留し子またはowner接続を失効 | 保存後の再checkで露出/送信0。sending/unknown履歴を保持、再送0、period新設0 |
| ID-F05-A05 | 子終了後のresultと、owner handoff後の未送信question/PRをkind別に送信 | resultは固定ownerの独立live照合だけで送信できる。question/PRは同じ子targetへfresh proof後だけ送信し、自動宛先変更0 |
| ID-F06-A01 | send-start保存直後に書込み前障害を作り新storeでload | unknown、proofなし、payloadなし。自動再送0、同key別attempt拒否 |
| ID-F06-A02 | accepted、applied、cancelled、endedを保存しload | acceptedはunknown、適用/取消/終了終端は保持。受付から適用への推測0 |
| ID-F06-A03 | 未送信をloadしpayloadを違う内容/正しい内容で再取得 | digest違い拒否。正しい内容だけでは送信不可、fresh proof後だけ一度送信 |
| ID-F06-A04 | 別period/delivery/revision/digestまたは再利用itemのack | 状態と保存に変化0。正しく相関した遅延適用証拠だけ取消要求とともに保持 |
| ID-F11-A01 | snapshotへbinding変更、未知キー/版、破損、上限超過を投入 | validationで拒否、既存有効保存保持。private handle/writer発行0 |
| ID-F11-A02 | handoff後のbinding履歴と、adopt直後でactor未attestの実行を保存/load | 固定値とowner履歴保持、現行proof失効、unknown投影。未attest履歴や古いowner/接続から資格発行0 |
| ID-F11-A03 | 最大長相関を予約できる最小容量で新規登録と既存確定を試す | 新規登録は拒否してbyte/状態を保持。既存applied・遅延accepted・取消・再読取りは上限内で成功 |

handoff後の固定値とowner/genの保存・復元はID-F05-A05でも観測する。

## 確認結果

純台帳10件、保存層19件、両provider共通scenario12件が成功した。
全体のnpm testは1,221件成功、失敗・skip・todoは0件だった。
F06-A01はsendingの実保存後かつsink露出前の障害、F11-A01は破損・未知版・実byte過大fileの読取り拒否を確認した。
F05/F06の送信回数は製品storeが同期呼出しするsinkで観測し、F11では実fileのbyte一致とwriter呼出し回数を観測した。
認証入力とsinkはfixtureであり、native transportの適用成功を確認した結果ではない。
canonical period終了後の実adapter経路は未確認で、actor終了の結果と分けて扱う。
## 残る採用条件

G3は両adapterと製品storeを通す上記scenarioで確認する。
#170の実collector、#175-Bの実transport、#174のnative質問、#179の通知、#180の結果返却、#177-B/Cの完全復旧は残る。
公開read recordやcheckpointからverifiedを復活させず、実runtimeの使用直前proof確認を各統合で追加する。
通常HOMEと外部bridgeの変更、merge、mainへのpushは含めない。
先行部分だけで#175または#177全体を閉じない。
