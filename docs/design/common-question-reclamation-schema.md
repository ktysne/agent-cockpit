# 共通質問の回収 schema

この文書は[容量回収計画](codex-capacity-reclamation.md)の段階1における質問 journal の保存契約である。
形式移行と世代失効の外側契約は[質問回収アンカー](question-reclamation-anchor.md)、配信 record の保存契約は[配信回収 schema](delivery-reclamation-schema.md)を正本とする。
以下は実装前の契約であり、実装済み形式やruntime適合の証拠ではない。

## 現行形式と上限

| 項目 | 現行値 |
|---|---|
| journal | schemaVersion 1、正確な外形は schemaVersion、revision、questions |
| 件数 | 最大20,000 record。journal作成時のmaxRecordsは1から20,000 |
| byte | 既定と設定可能な最大は16,777,216 byte |
| serialize | JSON.stringify(value, null, 2)にLFを1つ追加し、UTF-8 byte数で検査 |
| revision、時刻 | 0以上の安全な整数 |
| identifier | trim済み、制御文字なし、最大512 JavaScript UTF-16 code unit |
| 質問本文 | 1 recordに最大4問、各問の選択肢は最大6件 |
| 文字数上限 | 質問文と説明、自由記述は各2,000 code unit、選択肢labelは200 |
| lateAnswers | 最大10件 |
| timeoutMinutes | 1から30 |

identityはprovider、nativeIdKind、hostId、homeScopeId、nativeIdの5項目である。
providerとnativeIdKindの組はclaude/sessionまたはcodex/threadに限る。
actor.kindはagentまたはtool-use、categoryはordinary、selection.sourceはmanualまたはaway-defaultである。
質問本文、回答、遅延回答の長さを512-byteとして計算しない。
JSON escape後のUTF-8 byteを実serializerで計上する。

現行recordの正確なfield順とvalidatorは[kernel](../../src/server/common-question-kernel.js#L5)にある。
現行上限、serializer、将来遷移byte予約は[journal](../../src/server/common-question-journal.js#L13)にある。
質問と配信の起動照合、同一内容のlive重複処理は[service](../../src/server/common-question-service.js#L344)にある。
配信状態、claimの正規化、質問recordとの厳密比較は[delivery ledger](../../src/server/delivery-ledger.js#L5)にある。

現行のcontentDigestは、categoryと正規化questionsを持つobjectのJSON UTF-8 SHA-256 lowercase hexである。
payloadDigestはquestionId、revision、正規化answersのobjectを同じ方法でdigestする。
配信intentはdeliveryAttemptId、logicalMessageId、revision、payloadDigestの4項目である。
selectionとdeliveryIntentは現行v1で両方nullまたは両方non-nullでなければならない。

v1はselectionとintentをjournalへ保存した後に配信checkpointを作る。
そのため、選択intentがありcheckpointが無い状態だけでは、配信未作成と作成済み記録の消失を区別できない。
現行serviceは起動した質問を隔離する一方、intentに対応するcheckpointが無い場合の扱いを新schemaで厳密化する。

## journal v2

v2の外形はschemaVersion、storeId、revision、questions、reservationsの5項目だけを許す。
schemaVersionは2、storeIdはアンカーと同じ小文字UUIDv4、revisionは0以上の安全な整数とする。
質問journalとcheckpointは同じstoreIdを持つ。
アンカーの欠落・破損・storeId不一致では質問serviceと全質問gateを停止する。
checkpoint自身のstoreId不一致では共有checkpoint writer全体を停止する。
形式migration中はmanifest対象slotと同checkpointを使う全kindのwriterを停止したままにする。
自動初期化、旧形式への暗黙変換、未知fieldの無視をしない。

questionsは本文を保持するdetail recordの配列である。
現行v1 recordの全fieldと意味を維持し、v2では次の2 fieldを必須に追加する。

| field | 値と不変条件 |
|---|---|
| deliveryCreationState | not_created、creating、checkpointed、indeterminateのいずれか。intentとの組合せは後述の表に従う |
| quarantinedAt | nullまたは0以上の安全なUnix時刻ミリ秒。対象periodを隔離するとき一度だけ設定し、再起動で更新しない |

v2ではautoApplyEnabledAtRegistrationも必須booleanとする。
v1だけは現行validatorとの互換のため欠落値をfalseとして正規化する。
v1の他のrecord field、contentDigest、selection、deliveryIntent、externalResolution、lateAnswers、cancelledAtの意味と検査は維持する。

reservationsは本文回収後も残す質問墓標の配列で、1質問につき1件だけ持つ。
予約は質問登録時にdetailと同じjournal revisionで作り、その後のdetail更新と同じrevisionで相関fieldを更新する。
予約の正確なfield集合を次に固定する。

| field | 値と不変条件 |
|---|---|
| internalQuestionId | detailと同じidentifier。全reservationsで一意 |
| identity、periodId、questionId | 現行の完全identityとperiod、公開question ID。組は共通keyそのもの |
| contentDigest | detailと一致するlowercase SHA-256 hex 64文字 |
| executionId、conversationId、launchRef、executionBinding | detailの実行相関projection。binding.periodIdはperiodIdと一致 |
| createdAt、revision | detailと一致する安全な整数 |
| selectionSource、selectedAt | 未選択なら両方null。選択済みならmanualまたはaway-defaultと選択時刻 |
| deliveryIntent | 現行4 fieldの完全な相関objectまたはnull。detailと完全一致 |
| deliveryCreationState | detailと同じ4値enum。配信作成の永続段階を示し、ledger stateを代替しない |
| checkpointState | nullまたは既存8 state enumの値。checkpointedでは検証済みledger state、indeterminateではunknown |
| sourceClaimsDigest、sessionId | checkpointed時だけ両方を保持。未作成または不確定では両方null |
| externalResolution、cancelledAt | detailの値と一致。externalResolution単独から配信終端を推定しない |
| terminalResultKind | applied、cancelled_before_send、superseded_before_send、nullのいずれか。reservationに保存したcheckpointStateから導く |
| quarantinedAt | detailと一致。nullまたは隔離時刻で、隔離後は不変 |
| bodyState、reclaimedAt | retained/nullまたはreclaimed/時刻の組。detail配列との一対一対応を示す |

予約は回答、質問文、選択肢、自由記述、遅延回答を保持しない。
bodyStateがretainedなら同じinternalQuestionIdのdetailが1件あり、全共通fieldとdigestが一致する。
bodyStateがreclaimedならdetailがなく、reclaimedAtが安全な整数である。
selectionSourceとselectedAt、externalResolution、cancelledAtは本文を消した後も監査・状態照合に必要な最小情報として残す。
terminalResultKindはcheckpointStateがappliedならapplied、cancelled_before_sendなら同値、superseded_before_sendなら同値、それ以外はnullとする。
unknown、available、claimed、sending、accepted、not_created、indeterminateはnullである。

reservationsの共通keyは完全identity、periodId、questionIdであり、SHA-256 digestだけを一意性検査に使わない。
同じcommon keyまたはinternalQuestionIdの予約重複、detailとの不一致、未知field、未知enum、疎配列を拒否する。
retained reservation一件に対するdetailは1件、reclaimed reservationに対するdetailは0件である。
questionsにある全detailは同一internalQuestionIdのretained reservationと一対一に対応する。
maxRecordsはreservationsの永続件数上限にも適用するため、本文圧縮で件数枠を空けない。

## 配信作成とcheckpointの相関

deliveryCreationStateとcheckpointStateは別の状態軸である。
deliveryCreationStateは質問intentとcheckpoint recordの保存境界、checkpointStateは配信ledgerの既存stateを表す。

| 条件 | intent | creation state | checkpoint state | anchor deliveryPresence |
|---|---|---|---|---|
| 未選択 | null | not_created | null | none |
| 選択済み、作成開始前 | 4 field | not_created | null | none |
| creatingを保存した同じ稼働操作が継続中 | 4 field | creating | null | migration snapshot対象外 |
| 保存済checkpointに完全一致するattemptがある | 4 field | checkpointed | 実在する8 state | checkpoint |
| v1 intentあり、checkpointにattemptがない | 4 field | indeterminate | unknown | indeterminate |
| v2 creatingの再起動後にattemptがない | 4 field | indeterminate | unknown | indeterminate |

checkpointStateの許容enumはavailable、claimed、sending、accepted、applied、unknown、cancelled_before_send、superseded_before_sendである。
not_createdはintentがnullまたは選択済みintentだけを持ち、checkpointStateはnullとする。
creatingは選択済みintentを必須とし、同じ稼働操作が配信作成を継続している間だけ使う。
indeterminateは選択済みintentとcheckpointState unknownを必須とし、作成・送信・再送を永久に禁止する。
checkpointedはintent、checkpointState、sourceClaimsDigest、sessionIdを必須とする。

reservationのcheckpointStateとterminalResultKindは最後に観測したledger stateのcacheであり、checkpointの各遷移とjournalを二file同時commitできない。
questionがactiveでanchorにperiod失効が無い間は、復旧時に静的相関とledger自身の状態・correlation検査を行い、cacheとの差を直ちに不整合としない。
差がある場合はledgerの現在recordと完全相関を照合し、既存の合法なstate transitionまたは再起動時のclaimedからavailable、sending/acceptedからunknownへの復旧変換だけを認める。
unknownからaccepted/appliedへの遷移は完全一致する後着correlationがある場合に限り、periodをretiringにする前だけ認める。
applied、cancelled_before_send、superseded_before_sendから別stateへの後退は拒否する。
通常のperiod retirementでは対象question操作をdrainし、checkpoint snapshotをメモリー上で固定してから、quarantinedAtとsnapshotを反映した質問journal bytesを作る。
この場合はanchorへperiod失効を先に保存し、次に質問journalを保存する。
retired anchorとdetail retainedの組は、この順序の中断として受け付け、checkpointとの静的相関を検査した後に同じsnapshotをjournalへ冪等に反映する。
この中断復旧では状態cacheの初期差だけを起動拒否の理由にせず、correlation不一致や不可能なstate後退は拒否する。
schema migrationでは全writerを停止したsource snapshotからtarget bytesとfingerprintを先に作り、anchor保存後にcheckpoint、instructions、questionsの順で置換する。
anchor migration targetのcheckpointStateとreclaimed bodyのcheckpointStateは固定snapshotであり、保存済みstateとcorrelationが完全一致しなければならない。
bodyState=reclaimed後は配信stateの進行を許さず、ledgerとreservationのsnapshot不一致は復旧を拒否する。

質問periodをretiringにした後のclaim、sendStart、payload再取得、accepted/applied、late answerは、ledger状態を見る前に質問墓標で拒否する。
通常復旧後に残る隔離非終端stateはavailableまたはunknownに限り、7日後に同じstateのまま墓標化できる。
availableは送信許可を意味せず、圧縮時にcancel、success、未送信の確定結果を追加しない。
通常のperiod隔離は対象質問と質問配送だけをquestion gateで止める。
同じledgerを使う通常指示とPR通知のwriterは継続できる。
schema migrationではcheckpoint全体を置換するため、anchorが列挙する全slotと同checkpointを使う全kindのwriterをdrainして止める。

再起動時にcreatingと完全一致するattemptがcheckpointに存在するなら、その保存済みattemptだけを根拠にcheckpointedへ正規化できる。
この判定は配信作成保存の確認であり、send、retry、再送の許可ではない。
creatingでattemptが欠落するならindeterminateへ固定し、新規attemptを作らない。
attemptが見つかっても1 fieldでも相関不一致なら不整合として起動を拒否する。
checkpointedで記録したattemptが欠落した場合も不整合であり、noneやindeterminateへ読み替えない。

sourceClaimsDigestはdelivery ledgerのnormalizeClaimsが返す10 field順のcanonical objectを、空白なしJSONにしたUTF-8 SHA-256 lowercase hexとする。
field順はlaunchId、runId、attemptId、provider、nativeIdKind、hostId、homeScopeId、origin、purpose、originBindingである。
JSON.stringifyの前に既存normalizeClaimsと同じenum、identifier、binding検査を行い、Unicode正規化は加えない。
質問配送ではsourceとexecution targetのclaimsが完全一致するため、予約のsourceClaimsDigestは両側に共通の証拠となる。
sessionIdはdelivery sourceとtargetのsessionIdに一致する512 code unit以下のidentifierである。

checkpointedの相関検査はintent4 field、kind=question、sourceExecutionId=periodId、source/target claims digest、source/target identity、launchRef、executionBinding、actor、conversationId、sessionIdを照合する。
target.kindはexecution、target.periodIdは質問periodId、target.actorはexecutionBinding.actorでなければならない。
payloadDigestはdetailのquestionId、intent.revision、selection.answersから再計算し、record revisionとも一致させる。
acceptedCorrelationとappliedCorrelationは配信checkpointの完全objectで検査し、質問墓標では相関digestへ置換しない。

移行と通常復旧のanchor presenceはnone、checkpoint、indeterminateに限定する。
noneは未選択、または新v2のnot_createdという永続証拠だけに使う。
checkpointはattemptの存在と全相関が一致する場合だけ使う。
不在をnoneにして回収を続けること、indeterminateを配信未作成とみなすこと、checkpointed欠落をunknownへ薄めることを禁止する。

## 旧schema移行とdigest

旧質問journal v1は、anchor migrationが固定したsource fingerprintに一致する場合だけ移行入力として読む。
sourcePresent=falseはファイル全体が無いことを示すだけで、個別質問の配信未作成を証明しない。
checkpoint slotが無い、または質問attemptが無い場合の選択intentはindeterminateへ移す。

| v1の質問 | v2への移行 |
|---|---|
| selectionとintentがnull | deliveryCreationState=not_created、checkpointState=null、deliveryPresence=none |
| intentと完全一致checkpointが存在 | checkpointedとcheckpointのstate、claims digest、sessionIdを保存 |
| intentはあるがcheckpoint attemptが無い | indeterminate、unknown、deliveryPresence=indeterminate |
| checkpointにattemptがあるが全相関一致しない | migration拒否。serviceを起動しない |
| selectionとintentの片側だけがnull | v1自身のschema違反として拒否 |

checkpoint recoveryによりsendingまたはacceptedが見つかった場合は、既存delivery契約どおりunknownへ戻す。
claimedはavailableへ戻し、他の既存stateはledgerのvalidatorとrecovery規則に従う。
質問が隔離された後はunknownを成功へ変更せず、後着accepted/applied、late answer、pollからの再配送を拒否する。
externalResolutionは元の証拠digestとresolvedAtを維持し、terminalResultKindに変換しない。

recordDigestはanchor migration targetのquestions recordをschemaごとのnormalizerで正規化し、UTF-8のJSON.stringify(normalizedRecord)をSHA-256 lowercase hexにする。
v1のfield順はkernelの現行RECORD_FIELDSそのままを使い、v1で欠落可能なautoApplyEnabledAtRegistrationはfalseへ補完してdigest対象に含める。
v2のfield順はv1 record順を維持し、deliveryCreationStateをdeliveryIntent直後、autoApplyEnabledAtRegistrationの後にquarantinedAtを置く。
v2 digestにはdeliveryCreationState、quarantinedAt、補完後の全既存fieldを含める。
storeId、reservation、anchor、JSON indent、末尾LFはrecordDigestに含めない。
anchor sources.sha256とtargetSha256は実ファイルbyte列のdigestであり、recordDigestと混同しない。

commonKeyDigestは現行questionKeyと同じtupleを使う。
identity field順の5値を配列にし、その配列、periodId、questionIdの順に並べた3要素JSONをUTF-8 SHA-256 lowercase hexにする。
このdigestはanchor descriptorの重複検査用であり、journal内のkey equalityでは完全値比較を行う。

## 隔離、保持、本文回収

対象periodの永久失効は、完全identityとperiodIdを組にしてanchorへ保存する。
失効対象はその期間の共通質問だけであり、通常指示、registry execution state、native processを終了させない。
同periodでactor、launchRef、connection generationが変わっても失効を解除しない。
trusted registrationが検証した新periodは受付可能だが、同じcommon keyの永続reservationは内容が同一でもquestion_conflictで拒否する。
予約のない質問でも失効済みperiodならquestion_period_retiredで拒否する。
question_period_retiredは新規service error codeであり、現行registerはlive keyで内容一致ならexistingを返す。

新形式のperiod隔離ではanchor.retiredAtをquarantinedAtとしてdetailとreservationに反映する。
旧recordに時刻が無い場合は移行anchor.startedAtをquarantinedAtとして一度だけ保存する。
anchorの失効後にdetailが残る中断復旧も同じanchor時刻を使い、本文を回収済みに見せない。
どの場合もquarantinedAtを再起動や移行完了で更新しない。
manifestのcompletedやmigration=nullへの移行で保持期限を再起算しない。
非終端state availableまたはunknownの本文期限はquarantinedAt + 604,800,000 millisecondsで導き、期限時刻を別に保存しない。
terminal state applied、cancelled_before_send、superseded_before_sendではcheckpoint.terminalAtからの7日とquarantinedAtからの7日のうち遅い期限を使う。
従ってterminalの保持期限はmax(quarantinedAt + 604,800,000, terminalAt + 604,800,000)である。
terminalAtはcheckpoint v3内のledger v2 recordが初回の確定終端stateと同じ更新で保存し、question reservationには重複しない。
旧terminal recordのterminalAtが無い場合はmigration.startedAtを一度だけ保存する。
terminalAtがないterminal checkpointは本文回収を拒否する。
期限計算の加算結果がNumber.MAX_SAFE_INTEGERを超える場合、安全なUnix時刻を得られない場合、保持起算点より前の時刻が観測された場合、または時計rollbackを検知した場合は本文回収を延期する。
時計の大幅な進みで実時間の7日未満にdeadlineへ達する事象は保証対象外とする。

期限前は質問文、選択肢、answers、lateAnswers.answersを保持する。
隔離済み質問は期限後に限って本文を圧縮でき、圧縮は形式移行manifestとは別operationとする。
配信checkpointのreclaimed variantと全相関を先に保存し、次に同じ質問journal revisionでdetailを削除しbodyState=reclaimedとreclaimedAtを保存する。
未選択またはnot_createdなら配信を作らず質問だけを圧縮する。
indeterminateまたはcheckpointedかつunknown/availableの配信は観測済みstateを凍結し、terminalResultKind=null、再作成・再送・後着更新禁止を墓標へ残して本文を圧縮できる。
terminal stateの配信はcheckpoint.terminalAtとquarantinedAtの双方の7日条件を満たすまでdetailを保持し、期限後もterminalResultKindを元stateに一致させる。
圧縮で配送をcancel、success、未送信へ遷移させない。
checkpointedが指すattemptの欠落、相関違い、checkpoint保存結果不明ではdetailを削除しない。
本文圧縮の保存失敗または結果不明時は質問writerと対象gateを閉じ、既存本文を削除済みと推測しない。

bodyState=reclaimedのreservationは永久に残す。
予約の共通key、internalQuestionId、contentDigest、intent、execution projection、配信stateは同じ内容の再登録・同attempt再利用・遅延通知を拒否するため保持する。
reservationの件数上限20,000またはbyte上限に達したらquestion_quarantine_capacityを返し、新規受付を停止する。
本文圧縮、世代失効、detail削除によってreservationの件数枠やkey枠を再利用しない。
段階2と3は個別reservationを残す。
段階4でperiod墓標へ個別reservationを集約する場合は、全登録・配送・後着通知・復旧入口で同じ拒否を証明する別schemaと実装を定めてから行う。

## 復元拒否と応答

startup restoreはv2 exact-key validation、上限、dense array、ID重複、common-key重複、detail-reservation対応、全digest、anchor storeId、retired period、checkpoint相関の順に検査する。
既知のv1はanchorの移行source fingerprintが完全一致するときだけ変換し、それ以外のunknown version、field、enum、fingerprintを拒否する。
移行中のfileはanchorが許すsource/target fingerprintとphaseの組だけを受け付ける。
record revisionの後退、source fileの予期しない欠落、checkpointed attemptの欠落、delivery orphan、相関不一致は自動修復しない。

| 条件 | 応答と動作 |
|---|---|
| anchor欠落、破損、storeId不一致、schema違反 | service readinessを失敗させ、質問書込みと関連復旧を停止 |
| 選択済みでindeterminate | 質問は隔離済みとして応答し、新規deliveryと再送を拒否 |
| 失効済みperiodへの登録 | question_period_retiredを返し、recordを作らない |
| 永続reservationと同じcommon keyの登録 | 内容digest一致でもquestion_conflictを返し、既存結果を返さない |
| 隔離中または圧縮済みquestionへの回答、poll、cancel、late answer、resolution | question_quarantinedを返し、保存と配送を行わない |
| checkpointedの欠落、mismatch、孤立question delivery | question_delivery_mismatchまたはquestion_journal_missing_for_deliveryで起動を拒否 |
| capacity/byte reservation超過 | question_quarantine_capacityまたはjournal_too_largeで新規受付と圧縮を拒否 |

本文回収後も予約を使ってquestion_quarantinedを返すため、圧縮をquestion_not_foundや再登録可能状態に見せない。
起動を拒否したときはdashboardのrecovery blocked状態にし、空journalへ初期化して通常受付を続けない。
通常指示とPR通知のaccepted/applied遅延受け入れ規則はこの質問専用墓標で変更しない。

## byte予約と完了条件

実使用byteはv2 journal全体を現行serializerと同じindent、LF、UTF-8で直列化したbyte数とする。
予約byteは次の合計とし、設定上限16,777,216 byteを超えるjournal更新を拒否する。

    reserveBytes = serializedJournalBytes
                 + revisionGrowthBytes
                 + Σ max(0, worstFutureDetailBytes - currentDetailBytes)
                 + Σ max(0, maxReservationBytes - currentReservationBytes)

revisionGrowthBytesはrevisionをNumber.MAX_SAFE_INTEGERの16桁へ拡張したserializer差分とする。
worstFutureDetailBytesは現行assertCapacityReservedと同じ最大回答、lateAnswers 10件、取消、externalResolution、revision増加を反映したrecordをjournal内と同じindentで測る。
maxReservationBytesはnullable fieldを最大合法値へ投影したreservationを同じserializerで測る。
最大値には512 UTF-16 code unitのidentifierを含むJSON escape、64 lowercase hex digest、安全な整数、最長enum、UUIDv4を含める。
配信checkpointのaccepted/applied correlationと最大payload byteは配信schemaの予約式で数え、質問journal式へ重複計上しない。
質問journal側の最大回答、遅延回答、intent、予約projectionは平均値で割り引かない。
`maxRecords`と16MiBは別上限であり、両方を満たす容量保証と誤認しない。
移行専用枠M、各source/targetの追加保持H、実byte fingerprintの扱いは[anchor](question-reclamation-anchor.md)に従う。

段階1の完了条件は、v1/v2の正確なfield集合とdigest、creation stateとcheckpoint stateの組、全相関、anchor presence、移行拒否条件、7日保持起算、墓標保持、byte予約、応答codeが実装前に固定されていることである。
段階2では自動圧縮を有効にせず、v1の全移行ケース、満杯journal、最大escape、保存境界のクラッシュ、同内容再登録、ID再利用、indeterminateの再送抑止をfixtureで検証する。
fixtureの成功をClaudeまたはCodex実runtimeの適合と扱わない。
