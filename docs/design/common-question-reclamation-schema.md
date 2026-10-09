# 共通質問の回収 schema

この文書は[容量回収計画](codex-capacity-reclamation.md)の段階1における質問 journal の保存契約である。
形式移行と世代失効の外側契約は[質問回収アンカー](question-reclamation-anchor.md)、配信 record の保存契約は[配信回収 schema](delivery-reclamation-schema.md)を正本とする。
局所 schema の codec は実装済みである。保存処理への接続、形式移行、容量検査、runtime 適合は未確認である。

## 質問 journal v2 の局所 codec

`src/server/common-question-reclamation-codec.js` は、外部 store の照合と保存操作を行わない独立した入口である。
`normalizeQuestionJournalV2Local` は journal と grant の局所構造、detail と reservation の対応、重複 ID と共通 key を検査する。
`normalizeQuestionDetailV2` と `normalizeQuestionReservation` は単体の構造を検査する。
`questionRecordDigest` と `questionCommonKeyDigest` は以下の正規化順序で compact JSON の digest を返し、`encodeQuestionJournalV2Local` は pretty JSON と末尾 LF の UTF-8 bytes、byte 数、ファイル指紋を返す。
入力の getter と toJSON、継承された toJSON、暗黙の文字列変換は実行しない。

Local 入口の成功は、アンカー・checkpoint・旧 source との照合、追加枠の発行資格、固定 `H_questions`、予約 byte の検証を意味しない。
これらの検証と旧形式の投影は 1d へ残す。
回収準備の checkpointState はこの文書の構造契約である 8 state を受け付け、退役後に到達可能な状態は外部照合で制限する。
過去の snapshot に対する操作 ID や相関の不変性、7 日保持の経過、回収可否もこの単体 codec では判定しない。
既存 reader、writer、service、標準起動からこの入口は呼ばない。

## 現行形式と上限

| 項目 | 現行値 |
|---|---|
| journal | schemaVersion 1、正確な外形は schemaVersion、revision、questions |
| 件数 | 最大20,000 record。journal作成時のmaxRecordsは1から20,000 |
| byte | 通常上限`B_questions`（`N = B_questions`）の既定値と設定可能な最大は16,777,216 byte。旧v1 schemaの固定上限`C_questions`も16,777,216 byte |
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

v2の外形はschemaVersion、storeId、revision、questions、reservations、migrationAllowanceの6項目だけを許す。
schemaVersionは2、storeIdはアンカーと同じ小文字UUIDv4、revisionは0以上の安全な整数とする。
通常はmigrationAllowance=nullとし、初回v1 sourceの追加容量を保持する場合だけ厳密なgrant objectを保存する。
grant objectはoperationId、sourceSchemaVersion、sourceSizeBytes、sourceSha256、maxExtraBytes、eligibleQuestionIdsを持つ。
operationIdはanchor migrationと同じoperationの小文字UUIDv4、sourceSchemaVersionは1、sourceSizeBytesは旧v1 schemaの固定上限`C_questions`以下の安全な非負整数、sourceSha256は旧fileの実byteに対するlowercase SHA-256 hex 64文字とする。
旧sourceは`sourceSizeBytes`が`C_questions`以下で、旧schema、fingerprint、相関の検査を通る必要がある。移行開始にはさらに実source byte `S`が現在設定`B_questions`以下であることを求める。`S`が`B_questions`を超える場合はsourceを保持して容量診断を出し、破損扱いにしない。設定を戻した後にsource検査と将来projectionを再実行する。
maxExtraBytesはsource検査時に一度計算して固定する安全な整数で、1からH_questions以下とし、grant無しの最大projectionが通常上限N以内ならgrantをnullにする。
eligibleQuestionIdsはsource v1のinternalQuestionIdを全て一度だけ並べたdense arrayで、各値は既存identifier規則に従い、最大20,000件とする。
未知field、重複ID、不正UUID、source version/size/digestの不一致を拒否する。
形式migration coordinatorだけが、アンカーのquestion source fingerprintと完全一致したv1 snapshotからgrantを発行できる。
grantのsource情報、maxExtraBytes、eligibleQuestionIdsは発行後不変で、部分発行、差替え、IDの追加・再利用、複数grantの積上げを認めない。
段階4の集約でeligibleQuestionIdsの一部に対応するreservationが無くなってもgrantを不正とはしないが、現在grantの追加枠`G`を使うdetail/reservationは必ずgrant内のIDでなければならない。
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
| reclamation | nullまたは厳密な回収準備 object。必須fieldはoperationId、preparedAt、deliveryPresence、checkpointState |

予約は回答、質問文、選択肢、自由記述、遅延回答を保持しない。
bodyStateがretainedなら同じinternalQuestionIdのdetailが1件あり、全共通fieldとdigestが一致する。
bodyStateがreclaimedならdetailがなく、reclaimedAtが安全な整数である。
reclamationはexact-key objectで、operationIdは小文字UUIDv4の36 ASCII文字、preparedAtは0以上の安全なUnix時刻ミリ秒とする。
deliveryPresenceはnone、checkpoint、indeterminate、checkpointStateはnullまたは配信ledgerの8 state enumに限る。
noneは未選択またはv2 not_createdとcheckpoint不在を同一snapshotで確認した記録だけに使い、checkpointState=nullとする。
checkpointは完全相関したcheckpoint attemptが存在する記録だけに使い、checkpointStateはその復旧後snapshotの8 stateのいずれかとする。
indeterminateは旧intentまたはcreatingの作成有無を確定できない記録に使い、checkpointState=unknownとする。
retainedかつreclamation=nullは未準備、retainedかつnonnullは同operationの回収準備済み、reclaimedではnonnullを必須とする。
回収準備後のcheckpointStateは固定snapshotであり、後着通知などによる進行を認めない。
同じreservationのdeliveryIntentが持つattempt ID、revision、payloadDigestと全実行相関を固定し、準備後の差替えを拒否する。
reclaimed後もreclamation.operationId、preparedAt、deliveryPresence、checkpointStateを変更しない。
reclaimedAtはpreparedAt以上の安全な整数であり、detail削除と同じquestion journal更新で保存する。
selectionSourceとselectedAt、externalResolution、cancelledAtは本文を消した後も監査・状態照合に必要な最小情報として残す。
terminalResultKindはcheckpointStateがappliedならapplied、cancelled_before_sendなら同値、superseded_before_sendなら同値、それ以外はnullとする。
checkpointStateがunknown、available、claimed、sending、accepted、nullの場合、terminalResultKindはnullである。
terminalResultKindはterminal outcomeの分類であり、deliveryCreationStateのnot_created、creating、checkpointed、indeterminateとは別field・別状態軸である。

reservationsの共通keyは完全identity、periodId、questionIdであり、SHA-256 digestだけを一意性検査に使わない。
同じcommon keyまたはinternalQuestionIdの予約重複、detailとの不一致、未知field、未知enum、疎配列を拒否する。
retained reservation一件に対するdetailは1件、reclaimed reservationに対するdetailは0件である。
questionsにある全detailは同一internalQuestionIdのretained reservationと一対一に対応する。
questions.lengthはreservations.length以下、reservations.lengthはmaxRecords以下とする。
同じmaxRecords上限をdetail数と永久reservation数へ適用し、本文圧縮では件数枠を空けない。
通常登録時は新しいdetailとreservationだけでなく、reservation.reclamationの最大objectを含む将来のbyteも予約する。

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
| v2 creatingの再起動後または共有question gateのdrain完了後にattemptがない | 4 field | indeterminate | unknown | indeterminate |

v2のnot_createdと同intentのcheckpoint attemptが同時に存在する組は保存順序上不可能であり、起動時と回収時の両方で拒否する。
not_createdをcheckpointedへ読み替えない。creatingは再起動または共有question gateのdrain完了後に、完全一致attemptがあればcheckpointedへ復元する。

checkpointStateの許容enumはavailable、claimed、sending、accepted、applied、unknown、cancelled_before_send、superseded_before_sendである。
not_createdはintentがnullまたは選択済みintentだけを持ち、checkpointStateはnullとする。
creatingは選択済みintentを必須とし、同じ稼働操作が配信作成を継続している間だけ使う。
共有question gateのdrainは[アンカーの失効とwriterの直列化](question-reclamation-anchor.md#失効とwriterの直列化)に従う。
対象periodの新しい登録、回答、poll、timer、late answer、配送作成、復元、sendStartを遮断し、受付済みqueue待機操作も含めて完了または副作用なしの拒否を確定させる。
形式移行では、これに加えて全manifest slotのwriterを停止してdrainする。
回収準備のsnapshotにはcreatingを残さない。共有question gateをdrainし、完全一致attemptがあればcheckpointed、無ければindeterminateへ確定する。
indeterminateは選択済みintentとcheckpointState unknownを必須とし、作成・送信・再送を永久に禁止する。
checkpointedはintent、checkpointState、sourceClaimsDigest、sessionIdを必須とする。

reservationのcheckpointStateとterminalResultKindは最後に観測したledger stateのcacheであり、checkpointの各遷移とjournalを二file同時commitできない。
questionがactiveでanchorにperiod失効が無い間は、復旧時に静的相関とledger自身の状態・correlation検査を行い、cacheとの差を直ちに不整合としない。
差がある場合はledgerの現在recordと完全相関を照合し、既存の合法なstate transitionまたは再起動時のclaimedからavailable、sending/acceptedからunknownへの復旧変換だけを認める。
unknownからaccepted/appliedへの遷移は完全一致する後着correlationがある場合に限り、periodをretiringにする前だけ認める。
applied、cancelled_before_send、superseded_before_sendから別stateへの後退は拒否する。
通常period退役は[アンカーの失効とwriterの直列化](question-reclamation-anchor.md#失効とwriterの直列化)に従い、対象操作をdrainしてcheckpoint snapshotを固定した後、失効記録をanchorへ保存し、対象checkpointを正規化して保存してから、`quarantinedAt`とsnapshotを反映した質問journalを保存する。
退役時は対象question deliveryの`claimed`を`available`へ、`sending`と`accepted`を`unknown`へ正規化する。attempt、digest、相関、cancel要求は保持し、終端stateと他kindのrecordは変更しない。
checkpointの保存結果が不明なら、共有checkpointの全kind writerを停止する。
失効済みanchorと未更新journalの組は、通常退役、`reclamation=null`、`bodyState=retained`の中断に限り、gateを閉じたまま再開する。既存checkpointの完全相関とreservation cacheからの合法なstate到達経路を検査し、複数の合法遷移を経たcheckpointも退役時snapshotとしてjournalへ保存できる。
この復旧では保存済みcheckpointだけを採用し、anchor失効後に届いた新しいaccepted/applied evidenceは受け付けない。checkpointとcacheの相関不一致、終端stateの後退、`not_created`と同intentのattemptの併存は拒否する。
`reclamation`が設定済み、`bodyState=reclaimed`、または形式migrationの固定targetではcheckpointとcacheを完全一致させ、cache差を修復しない。
全対象journalのsnapshot保存が成功するまでgateを閉じたままにする。checkpointまたはjournalの保存結果が不明なら対象writerを停止し、本文を保持して再送しない。
schema migrationでは全writerを停止したsource snapshotからtarget bytesとfingerprintを先に作り、anchor保存後にcheckpoint、instructions、questionsの順で置換する。
anchor migration targetのcheckpointStateとreclaimed bodyのcheckpointStateは固定snapshotであり、保存済みstateとcorrelationが完全一致しなければならない。
bodyState=reclaimed後は配信stateの進行を許さず、ledgerとreservationのsnapshot不一致は復旧を拒否する。
回収準備時はreservation.checkpointStateとreclamation.checkpointStateを同じ固定snapshotへ更新し、以後両値を一致させて保持する。

質問periodをretiringにした後のclaim、sendStart、payload再取得、accepted/applied、late answerは、ledger状態を見る前に質問墓標で拒否する。
通常復旧後に残る隔離非終端stateはavailableまたはunknownに限り、7日後に同じstateのまま墓標化できる。
availableは送信許可を意味せず、圧縮時にcancel、success、未送信の確定結果を追加しない。
通常のperiod隔離は対象質問と質問配送だけをquestion gateで止める。
同じledgerを使う通常指示とPR通知のwriterは継続できる。
schema migrationではcheckpoint全体を置換するため、anchorが列挙する全slotと同checkpointを使う全kindのwriterをdrainして止める。

再起動時にcreatingと完全一致するattemptがcheckpointに存在するなら、その保存済みattemptだけを根拠にcheckpointedへ正規化できる。
この判定は配信作成保存の確認であり、send、retry、再送の許可ではない。
creatingで再起動またはgate drain後にもattemptが欠落するならindeterminateへ固定し、新規attemptを作らない。
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
質問slotがsourcePresent=falseならmigrationAllowance=nullとし、旧source由来のgrantを発行しない。
checkpoint slotが無い、または質問attemptが無い場合の選択intentはindeterminateへ移す。

| v1の質問 | v2への移行 |
|---|---|
| selectionとintentがnull | deliveryCreationState=not_created、checkpointState=null、deliveryPresence=none |
| intentと完全一致checkpointが存在 | checkpointedとcheckpointのstate、claims digest、sessionIdを保存 |
| intentはあるがcheckpoint attemptが無い | indeterminate、unknown、deliveryPresence=indeterminate |
| checkpointにattemptがあるが全相関一致しない | migration拒否。serviceを起動しない |
| selectionとintentの片側だけがnull | v1自身のschema違反として拒否 |

v1 record一件ごとにv2 detail一件とreservation一件を作る。
移行で作る各reservationもbodyState=retained、reclamation=nullから回収を始めるための最大reclamation objectを将来byteとして予約する。
anchorのretiredQuestionPeriodsは完全identityとperiodIdの一意な組ごとに一件だけ作り、複数questionが同periodに属するときは共有する。
各migration targetのperiodIndexはその完全一致entryを指し、対象配列を移行中に並べ替えない。
旧recordに隔離時刻が無い場合はmigration.startedAtをquarantinedAtへ一度だけ保存する。
v1 intentとcheckpointが完全一致していてもsendingまたはacceptedなら既存recoveryを先に適用し、checkpointState=unknownとして固定する。
v2 not_createdと同intentのattemptが見つかった場合は移行を拒否し、checkpointedへ補正しない。

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
未失効periodの終端question deliveryは汎用ledger回収の対象外とする。
質問本文の回収はperiod失効後に限り、anchorの退役時刻を`quarantinedAt`へ保存し、質問専用の3境界でsnapshotを保持する。圧縮は形式移行manifestとは別operationとする。
回収準備、配信grave化、質問detail削除は下記の3保存境界に従う。
未選択またはnot_createdなら配信を作らず質問だけを圧縮する。
indeterminateまたはcheckpointedかつunknown/availableの配信は観測済みstateを凍結し、terminalResultKind=null、再作成・再送・後着更新禁止を墓標へ残して本文を圧縮できる。
terminal stateの配信はcheckpoint.terminalAtとquarantinedAtの双方の7日条件を満たすまでdetailを保持し、期限後もterminalResultKindを元stateに一致させる。
圧縮で配送をcancel、success、未送信へ遷移させない。
checkpointedが指すattemptの欠落、相関違い、checkpoint保存結果不明ではdetailを削除しない。
本文圧縮の保存失敗または結果不明時は質問writerと対象gateを閉じ、既存本文を削除済みと推測しない。

回収は同じoperationIdで次の3境界を順に保存する。

1. 質問journalにreservation.reclamationを設定し、detailをretainedのまま残す。operationIdとpreparedAtをここで一度だけ発行し、deliveryPresenceとcheckpointStateを固定する。
2. deliveryPresence=checkpointなら対応deliveryを同operationIdのreclaimed variantとしてcheckpointへ保存する。deliveryPresence=noneまたはindeterminateではattemptを作成せずcheckpointを変更しない。
3. 質問journalからdetailを削除し、bodyState=reclaimed、reclaimedAt、同じreclamationを一度に保存する。

各保存の結果が不明なら関係writerを止め、再起動後に保存済みoperationIdと厳密な相関で境界を判定する。
新しいoperationIdを発行して再開せず、保存境界間のoperationId違い、snapshot state違い、相関違いを拒否する。
checkpointedを示す質問と配信detail/graveの欠落は不整合であり、新規attemptを作って補わない。
noneまたはindeterminateの対象attemptが途中で現れた場合も矛盾として拒否し、graveを新規作成しない。

| 質問journal | checkpoint | 復旧動作 |
|---|---|---|
| retained、reclamation=null | 厳密なdetail、またはnone/indeterminateの証明と一致 | deadline、gate、snapshotを再検査して境界1を開始 |
| retained、準備済み | 元detailがsnapshot/correlationと一致しgraveなし | 同じoperationIdで境界2を続ける。checkpointState不一致は拒否 |
| retained、準備済み | 同じoperationIdのgraveが全相関/state一致 | 境界3で質問detailを削除 |
| reclaimed、準備済み、deliveryPresence=checkpoint | 同じoperationIdのgraveが全相関/state一致 | 完了済みとして拒否情報を維持 |
| reclaimed、準備済み、deliveryPresence=none/indeterminate | 対応attemptなし | 完了済みとして拒否情報を維持 |
| retained、準備済み、deliveryPresence=none/indeterminate | 対応attemptなし | 境界3でdetailを削除 |
| reclaimed、準備済み、deliveryPresence=checkpoint | attemptまたはgrave欠落、別operationId、相関/state不一致 | question_delivery_mismatchで起動拒否 |
| any | not_createdだが同intentのattemptあり、none/indeterminateなのにattemptあり、または孤立grave | invalid_journalまたはquestion_delivery_mismatchで起動拒否 |
| reclaimed、reclamation objectの必須operationId欠落または形式違反 | 任意 | invalid_journalで起動拒否し、operationIdを新規発行しない |

graveのreclamation.operationIdは質問reservationの同fieldと一致する。
reclaimedAtは質問側と配信側のそれぞれの保存時刻であり、両者の時刻一致は要求しないが、各値はpreparedAt以上の安全な整数である。

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
| 回収境界のoperationId、snapshot、存在証拠の不一致 | invalid_journalまたはquestion_delivery_mismatchで起動を拒否し、attemptを作成・修復しない |
| 新規登録candidate全体がmaxRecordsまたは通常byte上限Nを超過 | question_quarantine_capacityを返し、新規recordを作らない。固定上界`H_questions`とgrant枠`G`を適用しない |
| 既存migration/retention loadまたは次writeがN + Gを超過 | journal_too_largeで対象writerを停止し、質問detailと拒否snapshotを保持する |
| 既存journalの予約byteがNを超えるがN + G以内 | grant対象の既存操作である場合に限り、圧縮と回収境界を続ける |

本文回収後も予約を使ってquestion_quarantinedを返すため、圧縮をquestion_not_foundや再登録可能状態に見せない。
起動を拒否したときはdashboardのrecovery blocked状態にし、空journalへ初期化して通常受付を続けない。
設定変更で保存済みjournalの実byteまたは予約byteが現在の`N + G`を超えた場合は、schema適合済みのrecordを破損扱いにせず保持し、容量診断を出して受付と対象writeを停止する。設定復元後にschema、digest、checkpoint相関、将来予約を再検査してから再開する。
通常指示とPR通知のaccepted/applied遅延受け入れ規則はこの質問専用墓標で変更しない。

## byte予約と完了条件

実使用byteはv2 journal全体を現行serializerと同じindent、LF、UTF-8で直列化したbyte数とする。
`B_questions`は現在設定の通常byte上限で、既定値と設定可能な最大値は16,777,216 byteである。`N = B_questions`とし、`N`を旧schema固定上限の別名には使わない。
`C_questions = 16,777,216` byteは旧v1 schemaの固定byte上限であり、旧sourceの妥当性検査に使う。
`Q`は移行対象の旧snapshot、`S(Q)`はその旧fileの実byte、`H_questions`は旧schemaで有効な全sourceから求める固定保守上界、`G`は保存grantの`maxExtraBytes`である。grantがnullなら`G=0`とする。
通常受付の候補journal全体の予約byteが`N`を超える登録を拒否する。
移行と保持・回収の既存journal load/writeは、grantがある場合に限り`N + G`まで許す。
grant内の追加枠で行う移行・回収の拒否snapshotと各保存境界は、`N + G`以内で保存できる場合に維持する。

    reserveBytes = serializedJournalBytes
                 + revisionGrowthBytes
                 + Σ max(0, worstFutureDetailBytes - currentDetailBytes)
                 + Σ max(0, maxReservationBytes - currentReservationBytes)

revisionGrowthBytesはrevisionをNumber.MAX_SAFE_INTEGERの16桁へ拡張したserializer差分とする。
worstFutureDetailBytesは現行assertCapacityReservedと同じ最大回答、lateAnswers 10件、取消、externalResolution、revision増加を反映したrecordをjournal内と同じindentで測るが、service/gateが今後の状態遷移を受理するactive detailだけに適用する。
隔離済みまたはretiredのdetailは本文を変更しないためcurrentDetailBytesを使い、回収済みreservationはdetail成長を予約しない。
maxReservationBytesは状態別に合法な将来projectionを同じserializerで測る。active reservationは選択・配信相関と最大reclamation objectを含め、隔離済みreservationは未設定reclamation objectだけを追加予約し、準備済み・reclaimed reservationは固定相関を再予約しない。
最大値には512 UTF-16 code unitのidentifierを含むJSON escape、64 lowercase hex digest、安全な整数、最長enum、UUIDv4を含める。
最大reclamation objectは36 ASCII文字のoperationId、16桁までのpreparedAt、最長deliveryPresence、最長ledger state、field名、引用符、comma、JSON indentを含め、実serializerで測る。
通常登録とv1移行の両方で、detail/reservation作成時から将来reclamationを最大値で予約する。
配信checkpointのaccepted/applied correlationと最大payload byteは配信schemaの予約式で数え、質問journal式へ重複計上しない。
質問journal側の最大回答、遅延回答、intent、予約projectionは平均値で割り引かない。
`maxRecords`、現在設定上限`B_questions`、旧schema上限`C_questions`は別条件として検査する。

## 質問journalの移行追加枠

`H_questions`は、旧schemaで有効なsnapshot `Q`の実source byte `S(Q)`が`C_questions`以下で、件数、全field validator、質問とdeliveryの相関検査を通る全sourceから求める、sourceとの差分の最大追加予約byteの固定保守上界である。現在設定`B_questions`による移行可否とは独立し、runtime load/write枠としては使わない。
各有効な旧source snapshot `Q`をv2へ移し、全質問detailと同数のreservation、`quarantinedAt=migration.startedAt`、全reservationの最大reclamation予約、`migrationAllowance`、revision増分を含むtarget projectionを実serializerで測る。
計算ではsourceの全detailを保持し、`reserveBytes`の状態別detail/reservation projectionを適用する。
同じ計測を回収の3境界それぞれの完全なquestion-journal projectionでも行い、境界間の最大値だけを使う。境界2はcheckpointだけを保存するためquestion journal byteは境界1と同じである。
`P_questions(Q,b)`を、source snapshot `Q`から作る将来予約込みjournal projectionを境界`b`でserializerにより測ったbyte数とする。`H_questions = max(0, max_{Q,b}(P_questions(Q,b) - S(Q)))`とし、`Q`は旧schemaで有効な全source、`b`は移行targetと回収境界1、2、3を表す。
最大reclamation objectと将来増分は`reserveBytes`内で一度だけ計上し、最大shape展開のbyteへ重ねて加えない。
grant本体と最大`eligibleQuestionIds`配列もprojectionに含める。固定値の数値は段階2でserializer fixtureにより決める。
循環参照を避けるため、`H_questions`の計算中はgrant内の`maxExtraBytes`を最大の16桁safe integerとしてprojectionする。

現在設定`B_questions`内の有効なsource snapshot `Q`について、まずgrantをnullとした移行target、保持、回収の全境界と将来予約の最大projectionを測る。
その最大値が`B_questions`以内ならgrantをnullとし、追加枠を発行しない。
`B_questions`を超える場合だけgrant込みで再測定し、受け取った有効な旧source `Q`について、`G = maxExtraBytes = max(0, max_b(P_questions(Q,b) - S(Q)))`を一度計算して固定する。
`b`と将来予約の計上方法は上の固定上界と同じとし、grant内の数値は16桁の最大幅でprojectionして自己参照を避ける。
このsource基準の`G`は通常上限`B_questions`を基準にした最小追加量より大きくなり得る。その余裕は当該sourceの既存移行、保持、回収に限って使い、固定`H_questions`も同じsource基準の上界として維持する。
未使用分を新規受付へ転用しない。算出値が`H_questions`を超えれば移行を拒否する。
grantがある間、移行・保持中の既存journal load/writeと回収3境界に`N + G`を適用する。
journalの現在・次snapshotが`N`を超えても`N + G`以内なら、既存の拒否snapshotを維持し、回収境界1を含む既存操作を続けられる。
grantを越える場合はquestion writerと対象gateを停止し、source/detailと拒否情報を削らず保持する。
新規question候補はgrant対象recordを除外せず、既存全detail/reservationの全将来予約を含む候補journal全体が通常上限`N`以内の場合だけ受け付ける。
新規受付に固定上界`H_questions`もgrant枠`G`も使用せず、既存grant対象のIDは`eligibleQuestionIds`に含まれるsource IDに限定する。

質問journalの物理peakは論理上界`H_questions`と保存grant`G`へ含めない。
旧sourceと一時targetの同時保持、atomic置換を含む物理peakは[アンカーの満杯からの移行とbyte上限](question-reclamation-anchor.md#満杯からの移行とbyte上限)に従う。

anchor migrationが`null`になっても`migrationAllowance`を保持し、`G_questions_used`はgrantがある場合に各起動と変更前のrecordから`max(0, reserveBytes - N)`として再計算する。grantがnullなら`G_questions_used=0`として全load/writeを`N`以内に制限する。
使用量は`maxExtraBytes`以下でなければならず、migration phaseの有無や記録済みカウンターで代用しない。
grant内のsource fingerprint、ID集合、上限は不変とし、追加grantやHの再帰積上げをしない。
対応する形式移行が完了してanchorの`migration === null`となり、`migrationAllowance=null`にした後の全体将来予約が通常上限`N`以内で、進行中の回収をgrant無しで完結できる場合だけ、journal更新一回でgrant全体をnullにする。
manifestがprepared、guarded、installing、またはcompletedのままなら、通常枠に収まっていてもgrantを消さない。

旧journalの形式移行は、通常の質問受付可否と分けて完了判定する。
旧questions.lengthがmaxRecordsと等しい場合も移行枠で全detailと同数のreservationを安全に保存し、移行を完了できる。
その後もreservations.length=maxRecordsの間は新質問登録を停止し、本文圧縮で件数枠を空けない。
count上限に余裕がある旧journalだけ、manifestを完了してmigration=nullを保存した後、既存全recordの将来予約と新候補1件を合わせたjournal全体が通常上限`N`以内なら登録を再開する。
アンカーの移行枠`M`とslot別保持上界`H_i`を新規受付へ流用しない。
形式移行が完了したこと自体を受付再開の証拠にせず、個別reservationの件数枠回収は段階4の世代集約まで行わない。

段階1の完了条件は、v1/v2の正確なfield集合とdigest、creation stateとcheckpoint stateの組、全相関、anchor presence、移行拒否条件、7日保持起算、墓標保持、byte予約、応答codeが実装前に固定されていることである。
段階2では自動圧縮を有効にせず、v1の全移行ケース、満杯journal、最大escape、保存境界のクラッシュ、同内容再登録、ID再利用、indeterminateの再送抑止をfixtureで検証する。
fixtureの成功をClaudeまたはCodex実runtimeの適合と扱わない。
