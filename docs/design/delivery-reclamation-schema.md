# 配信記録の回収 schema

この文書は[容量回収計画](codex-capacity-reclamation.md)の段階1で定める配信側の保存契約である。
実装時は[質問回収アンカー](question-reclamation-anchor.md)の`storeId`と移行fingerprintを共有する。

## 局所 codec の入口と境界

`src/server/delivery-reclamation-codec.js` は、新形式を保存処理へ接続せず検査する独立した入口である。
`normalizeDeliveryRecordV2Local` と `normalizeDeliveryLedgerV2Local` は variant、終端時刻、相関、論理墓標、PR alias を検査する。
`normalizeCheckpointV3Local` は外側3・内包ledger 2の構造と、同じcheckpoint内の登録履歴・配信参照を照合する。
`normalizeInstructionRecordV2Local` と `normalizeInstructionJournalV2Local` は envelope、digest、回収準備、本文なし形式、重複を検査する。
`encodeDeliveryLedgerV2Local`、`encodeCheckpointV3Local`、`encodeInstructionJournalV2Local` は、対応する検査後のpretty JSONに末尾LFを付けたUTF-8 bytes、byte数、SHA-256指紋を返す。

getter、toJSON、継承されたtoJSON、入力値の暗黙の文字列変換は実行しない。
復旧用state変換、旧versionの補完、保存、回収操作は行わない。
既存reader、writer、service、標準起動からこの入口は呼ばない。

Local入口の成功は、アンカーや質問journalとの照合、instruction journalとcheckpointの照合、grantの発行資格、固定H/Tや容量予約の検証を意味しない。
これらと旧形式の投影は上位の `reclamation-store-consistency.js`、`reclamation-migration-projection.js`、`reclamation-capacity-bounds.js` で扱う。
配信detail/graveのclaimsまたはdigestとlaunch履歴の一致は、checkpoint内の一意なlaunch履歴との照合で保証する。ledger単体ではclaimsを保持するaliasとの照合と、各recordの局所整合を検査する。
7日保持の局所時刻条件は検査するが、外部質問journalの隔離時刻による期限や、過去のsnapshotからの遷移不変性はこの入口だけでは判定しない。
fixtureの成功は実runtime適合の証拠ではない。

## 現行形式と容量上限

| 保存先 | 現行形式 | 現行上限 |
|---|---|---|
| 配信ledger | `schemaVersion: 1`、`revision`、`deliveries`、`notificationTargets`、`logicalTombstones` | delivery 20,000件、alias 10,000件、logical tombstone 20,000件。各payload入力は1MiBまで |
| 配信checkpoint | 外側`schemaVersion: 2`、`revision`、`registrations`、`ledger` | 既定1MiB、設定可能な最大16MiB、registration record 50,000件 |
| 通常指示journal | `schemaVersion: 1`、`revision`、`instructions` | 20,000件、最大16MiB |
| 指示envelope | `schemaVersion: 1`、`mode`、`expectedTurnId`、`input` | 本文64KiB、直列化後70KiB |

現行の配信レコードはattempt ID、kind、logical ID、revision、source、target、payload digest、state、cancel flag、accepted correlation、applied correlationを持つ。
ledgerにはpayload本文を保存せず、入力本文から作ったSHA-256 digestだけを保存する。
logical tombstoneはattempt IDを持たず、kind、periodまたはlaunch tuple、logical ID、revision、payload digestで論理重複を拒否する。

通常指示journalのrecordはattempt ID、launch reference、logical ID、revision、source projection、envelope、envelope digest、native content digest、作成時刻を持つ。
指示envelopeとdelivery ledgerは別ファイルであり、journal intentの保存後に配信記録を作る。

`MAX_IDENTIFIER_LENGTH`は512 UTF-16 code unitであり、512 byteではない。
現行のidentifier検査は単独surrogateを拒否しないため、512個のU+D800を含むIDはJSON上で`\ud800`が512回に展開され、引用符を含めて3,074 byteになる。
revisionと時刻は安全な整数で、最大値は16桁である。
配信相関は`deliveryAttemptId`、`revision`、`payloadDigest`、`targetPeriodId`、`nativeTurnId`、`nativeItemId`、`clientRequestId`の7項目を持つ。
相関内の5つのIDが最大長、revisionが最大値、digestが64桁の場合、相関objectはminified JSONで15,572 byte、単独の2-space JSONで15,601 byteになる。
`reserveCheckpointBytes`は送信後に増える状態、revision、accepted correlation、applied correlationを見積もり、終端前送信状態ではない配信1件ごとに相関objectを2つ予約する。

上限は独立しているため、件数上限まで保存できる保証にはならない。
指示journalは1件最大70KiBのenvelopeだけを数えても、16MiBでは234件までしか収まらず、sourceやIDのbyteがさらに減らす。
配信payloadを1件1MiBで保持する想定と20,000件の同時保証は成立せず、1MiB payloadを20,000件保存するには本文だけで20,971,520,000 byteを要する。

根拠は`src/server/delivery-ledger.js`の上限、正規化、回復処理、`src/server/durable-checkpoint.js`のcheckpoint上限、`src/server/durable-delivery-store.js`の予約byte計算、`src/server/instruction-delivery-journal.js`のjournal上限、`src/server/instruction-envelope.js`の本文上限である。

## 新形式のversionと識別

| 保存先 | 新version | 新しい必須識別子 |
|---|---:|---|
| 配信checkpoint | 外側3、内包ledger 2 | anchorと同じ`storeId`、必須`migrationAllowance`（null可） |
| 通常指示journal | 2 | anchorと同じ`storeId`、必須`migrationAllowance`（null可）、instruction recordの`recordType` |
| 配信ledger内のrecord | 2 | 各recordの`recordType` |

`storeId`と回収`operationId`は小文字UUIDv4に固定する。
新形式のcheckpoint、指示journal、anchorは同一の`storeId`を持つ。
通常起動時はcheckpoint v3とledger v2、指示journal v2だけを読む。
checkpoint v2とledger v1、指示journal v1は、anchorが固定したsource fingerprintと一致するときだけ移行入力として読む。

anchorのsource slotは`questions`、`checkpoint`、`instructions`の固定3種を使う。
checkpoint slotのsource fingerprintは外側version 2とcheckpoint revisionを記録し、内容検査では内包ledger version 1も確認する。
checkpoint slotのtargetは外側version 3かつ内包ledger version 2である。
instructions slotはversion 1から2へ移す。
sourceとtargetのbyte sizeとSHA-256は保存した実byte列で検査し、JSONを再直列化した値で代用しない。
質問以外の配信対応はanchorの`targets`へ追加せず、3つのsource/target fingerprintとcross-store相関検査で確定する。

## 移行後の追加枠grant

checkpoint v3のouter objectとinstruction journal v2のtop-level objectは、必須field `migrationAllowance` を持つ。
値は `null` または次のexact-key objectとし、field欠落、未知field、重複ID、不正値を拒否する。
この節の通常枠 `B_i` は保存先の現在設定byte上限である。
旧schemaの固定上限 `C_i`、初回移行で指紋に固定するsource実byte `S_i`、移行後も保存する追加枠 `G_i`、固定追加枠上界 `H_i` はそれぞれ区別する。

| field | 値と検査 |
|---|---|
| `operationId` | anchor migrationと同じoperationの小文字UUIDv4 |
| `sourceSchemaVersion` | checkpointでは2、instruction journalでは1 |
| `sourceSizeBytes` | anchorが固定した旧source実byte `S_i`。安全な整数で、対応する旧形式の固定最大値`C_i`以下 |
| `sourceSha256` | 対応するanchor source fingerprintと同じ、旧source実byteの小文字SHA-256 hex 64文字 |
| `maxExtraBytes` | 正の安全な整数でslot固有の固定上界`H_i`以下。これを保存grant `G_i`とする。grant無しの最大projectionが通常枠内ならnull。発行後不変 |
| `eligibleAttemptIds` | dense array。重複のない最大20,000件のidentifierで、各512 UTF-16 code unit以下 |

移行coordinatorだけが、旧sourceのschema、`S_i`、SHA-256がanchorの固定fingerprintと一致し、かつ`S_i ≤ B_i`の場合にgrantを発行する。
checkpoint grantのrosterは旧checkpoint v2 ledgerに存在したdelivery attempt ID、instruction grantのrosterは旧journal v1に存在したinstruction attempt IDから固定する。
grantのoperation ID、source fingerprint、rosterを後から追記・差替え・再利用せず、同じsourceへのpartial grant積上げやgrantの重ね掛けを拒否する。
固定上界`H_i`は、旧schemaの最大入力制約`C_i`、件数、field制約を満たす全snapshotを対象に、source実byteから増えるprojection差分の保守上界として段階2で固定する。
まずgrantをnullとした受理済み旧source `S_i`のprojectionを、移行、保持、回収の全境界と合法な将来予約について測る。
その最大値が通常上限`B_i`以内ならgrantをnullとし、追加枠を発行しない。
通常上限を超える場合だけgrant込みで再測定し、受け取った有効な旧source snapshot `X_i`について、`G_i = max(0, max_b(projectedReserveBytes_i(X_i,b) - S_i))`を一度計算して`maxExtraBytes`へ固定する。
`b`はそのslotの移行、保持、回収の各到達可能snapshotと許可された将来遷移を表す。
`projectedReserveBytes_i`は実serializer byte、grantとroster、まだ使用していない合法な将来増分を一度だけ含め、別々の到達状態の最大値を使い、合計しない。
計算中はgrant内の数値を16桁の最大幅でprojectionして自己参照を避ける。
sourcePresent=falseならgrantをnullにする。
`G_i`はこのsource基準で発行した保存grantであり、load/write上限は`B_i + G_i`とする。
未使用分を新規受付へ転用しない。
固定`H_i`は`G_i`の上界であり、load/write上限として直接使わない。
算出値が固定`H_i`を超えれば移行を拒否する。
`S_i`が現在の`B_i`を超える場合はgrantを発行せず、sourceを保持して診断に上限超過の理由を出す。設定を必要な容量へ戻した後、schema、相関、将来予約を再検査すれば再開できる。
設定縮小だけで保存済みgrantをschema破損と扱わず、grantは不変に保つ。
現在の容量検査に通らなければ書込みを始めず、writer停止、保存データ保持、容量不足診断とし、設定復元後の再検査で再開する。
非null grantの`maxExtraBytes`が0または固定`H_i`を超えるobjectも拒否する。

`eligibleAttemptIds`は移行時点の上限対象を固定するrosterであり、移行後のrecordsと件数が完全一致する必要はない。
保持期限などで旧recordが削除されてもrosterを縮めず、追加枠を使えるのはroster内IDに対応する現存recordだけとする。
新しいattempt、registration、notification aliasなどは追加枠の対象外とし、既存全記録の将来予約を含む候補全体が通常`B_i`内の場合だけ受け付ける。
`migrationAllowance` object、roster、schema wrapperの必須追加byteは対応する`H_i`の計算に含める。

anchor migrationが`null`になってもfile内の`migrationAllowance`を維持する。
対応する形式移行が完了してanchorの`migration === null`となり、各現存recordとその未完了state transitionと相関予約が通常`B_i`内で完結でき、file全体も通常byte budgetに収まるときだけ、grantの削除と通常budget検査を同じatomic file saveで行う。
manifestがprepared、guarded、installing、またはcompletedのままなら、通常枠に収まっていてもgrantを消さない。
移行manifestの完了だけではgrantを消さず、grantを部分更新または後続migrationで積み増してHを再拡張しない。

## ledger v2のrecord variant

ledger外側は`schemaVersion`、`revision`、`deliveries`、`notificationTargets`、`logicalTombstones`を保つ。
`deliveries`は次の2 variantを含み、同じattemptを両方へ置かない。

| `recordType` | 内容 |
|---|---|
| `detail` | 現行delivery fields（payload本文は含まない）、必須`terminalAt`、このdiscriminatorを保持する |
| `reclaimed` | `terminalAt`と拒否、相関、参照情報を残し、detailの詳細projectionを削除したrecord |

どちらのvariantもexact-key objectとし、variantに定めたfieldの欠落、未知field、別variantのfieldを拒否する。
ledgerのどちらのvariantにもpayload本文は含めず、`payloadDigest`だけを保存する。
`reclaimed`は`deliveryAttemptId`、`kind`、`logicalMessageId`、`revision`、`sourceExecutionId`、`payloadDigest`、`state`、`terminalAt`、`cancelRequested`、`ownerGeneration`、`acceptedCorrelation`、`appliedCorrelation`を保持する。
stateは元のdelivery stateそのものを残し、`reclaimed`という新stateを作らない。
`terminalAt`は全recordで必須fieldとし、`applied`、`cancelled_before_send`、`superseded_before_send`では安全なUnix時刻ミリ秒、それ以外では`null`とする。
最初に終端stateへ変える更新はtrusted clockを一度読み、state、終端相関、`terminalAt`、checkpoint revisionを同じatomic checkpoint保存に含める。
重複通知、相関の追記、再起動、schema移行、grave化は既存`terminalAt`を書き換えない。
v1の終端recordには`migration.startedAt`を一度だけ補完し、非終端recordは`null`にする。
payloadDigestと相関内payloadDigestはpayload本文だけのdigestのまま保ち、`terminalAt`を含めない。
anchorのtarget byte sizeとSHA-256は`terminalAt`を含む実checkpoint bytesから計算する。
`sourceRef`は`launchRef`、`launchKey`、`sourceClaimsDigest`、`identity`、`executionBinding`、`conversationId`、`sessionId`を持つ。
`launchKey`は`[launchId, runId, attemptId]`で、`sourceClaimsDigest`は[質問schema](common-question-reclamation-schema.md)「配信作成とcheckpointの相関」の正規化claimsを`JSON.stringify`したUTF-8 bytesに対するSHA-256 lowercase hex 64文字である。
claimsのkey順は`launchId`、`runId`、`attemptId`、`provider`、`nativeIdKind`、`hostId`、`homeScopeId`、`origin`、`purpose`、`originBinding`とし、Unicode正規化は行わない。
`targetRef`は`kind`、`launchRef`、`launchKey`、`targetClaimsDigest`、`identity`、`periodId`、`actor`、`conversationId`、`sessionId`を持つ。
owner targetでは`launchRef`、`launchKey`、`targetClaimsDigest`を`null`にし、execution targetでは正規化済みtargetの値を保持する。
`identity`はprovider、native ID種別、host ID、home scope ID、native IDの5項目である。
`executionBinding`はperiod IDとactorの組であり、actorはkindとIDを持つ。
`reclamation`はUUIDv4の`operationId`、0以上の安全な整数`reclaimedAt`、固定enumの`reason`を持つ。
`reason`は`terminal_retention`または`retired_question_period`とする。
`terminal_retention`は非question kindの`applied`、`cancelled_before_send`、`superseded_before_send`だけに許し、指示journalの回収もこのcoordinatorが所有する。
`retired_question_period`は質問専用coordinatorが所有し、anchorの失効period、質問journalの隔離snapshot、準備済みreclamation operationと同じoperation IDを照合できるquestion deliveryだけに許す。
許可stateは復旧後の`available`または`unknown`、および`applied`、`cancelled_before_send`、`superseded_before_send`である。
questionのreclaimed variantでは質問journal側のprepareと`quarantinedAt`を必須とし、questionのactive terminal detailはgeneric coordinatorで回収しない。
退役後の`available`または`unknown`は`terminalAt`を要求せず、質問schemaの保持期限を満たした後に同じstateで回収する。
generic terminal-retention coordinatorはquestionのdetail、grave、質問journalを作成・更新しない。
全可変identifierは既存validatorと同じ512 UTF-16 code unit上限を使う。
墓標化では`source`と`target`のraw claimsを残さず、必要な投影値とclaims digestへ置換する。

sourceRefとtargetRefをdigestだけに縮めない。
質問、指示、PR通知、結果の既存照合に使うidentity、period、launch、execution binding、actor、conversation、sessionを保存し、同じclaims正規化規則の`sourceClaimsDigest`と`targetClaimsDigest`で全fieldの一致を検査する。
相関objectは既存7 fieldと同じ完全な値を保持し、native IDを相関digestへ置き換えない。
これにより通常指示とPR通知の遅延accepted/applied通知を現行どおり検査できる。

## 再利用拒否と復元検査

validatorはv2の全objectで既知のfieldだけを受け付け、dense array、enum、識別子、digest、相関、record variantを完全検査する。
未知version、未知field、疎配列、同一attemptの重複、detailとgraveの重複、相関違い、dangling reference、違うstore IDを読み替えず拒否する。
v2でterminal stateなのに`terminalAt`が欠落またはnull、またはnonterminal stateに値があるrecordは拒否し、migration以外で時刻を補完しない。
`deliveries`内でdetailとgraveを合わせたattempt IDは全件一意である。
logical keyごとの`logicalTombstones`はdetailとgraveを合わせたrecord groupに過不足なく対応し、全recordのpayload digestと一致する。
同じattempt IDの再利用は同一内容でも拒否する。
同じlogical keyの新attemptは、現行契約どおり全旧attemptが`superseded_before_send`の場合だけ許す。
question periodの永久失効は質問schemaとanchorが拒否するため、このgeneric例外で質問を再試行または圧縮しない。

相関の固定項目はattempt ID、revision、payload digest、target period ID、client request IDである。
相関のattempt IDとclient request IDはrecordのattempt IDと一致し、revisionとpayload digestはrecordと一致し、target period IDはtargetRefのperiod IDと一致する。
accepted correlationとapplied correlationのnative turn IDとnative item IDは既存の互換条件で検査する。
appliedにはnative turn IDとnative item IDの両方を必須とし、native item IDだけがある相関を拒否する。
他kindのunknownはdetailを保持し、正しい相関の後着通知によるaccepted/appliedへの更新を現行どおり許す。
終端後の重複通知は通常detailとgraveの両方で既存の冪等相関検査を通す。
許可される後着証拠はcheckpointへ追記できるが、attempt、digest、source/target、終端state、`terminalAt`を変更せず、質問退役後の通知拒否とも混同しない。

instruction journal v2は既存record fieldsに`deliveryCreationState`を加え、`not_created`、`creating`、`checkpointed`、`indeterminate`を使う。
v2のtop-levelは`schemaVersion`、`revision`、`storeId`、`migrationAllowance`、`instructions`を持つ。
各instruction recordは`recordType: detail`または`recordType: reclaimed`で識別し、未知のfieldを拒否する。
`detail`はv1の全fieldに`deliveryCreationState`と`reclamation`を加え、通常の新規instructionは`deliveryCreationState: not_created`、`reclamation: null`で保存する。
新規作成はintentを`not_created`で保存し、checkpoint作成を始める前に`creating`を保存する。
checkpoint detailの保存後にattemptと全相関が一致することを確認して`checkpointed`を保存する。
`creating`の再起動時は、attemptと全相関が一致するcheckpoint detailがある場合だけ`checkpointed`へ復元し、attemptが無ければ`indeterminate`へ固定して再生成しない。
一部または全相関が一致しないcheckpoint detailまたはgraveは不整合として拒否する。
`not_created`または`indeterminate`と同じattemptのcheckpoint detail/graveが共存する状態は拒否し、`checkpointed`でattemptが欠落する状態も拒否する。
`checkpointed`はdelivery作成保存の証拠であり、sendまたはretryの許可ではない。
移行するv1 instruction intentはcheckpoint recordと全相関が一致するときだけ`checkpointed`へ移す。
v1 intentがcheckpointに無い場合は保存順から未作成と消失を区別できないため`indeterminate`へ移し、そのattemptを再生成しない。
この不明状態は個別attemptの拒否であり、質問periodの永久失効や通常指示の認可変更ではない。
`reclaimed`を`get(attemptId)`の不在として返さず、serviceはgraveを既存deliveryとして照合する。
通常指示は質問periodの永久失効対象にせず、質問用のquarantinedAtや退役規則を適用しない。

instruction journal v2の`detail`と`reclaimed`は次のexact-key shapeを持つ。

| variant | 必須field |
|---|---|
| `detail` | `recordType`、`deliveryAttemptId`、`launchRef`、`logicalMessageId`、`revision`、`source`、`envelope`、`envelopeDigest`、`nativeContentDigest`、`createdAt`、`deliveryCreationState`、`reclamation` |
| `reclaimed` | `recordType`、`deliveryAttemptId`、`launchRef`、`logicalMessageId`、`revision`、`source`、`envelopeDigest`、`nativeContentDigest`、`createdAt`、`deliveryCreationState`、`reclamation`、`reclaimedAt` |

`reclamation`は`null`または次のexact-key prepare objectである。

| field | 値と検査 |
|---|---|
| `operationId` | 同じinstruction attemptのcheckpoint graveと一致する小文字UUIDv4 |
| `preparedAt` | 0以上の安全な整数のUnix時刻（ミリ秒） |
| `terminalState` | `applied`、`cancelled_before_send`、`superseded_before_send`の固定snapshot |
| `terminalAt` | checkpoint detailと一致する0以上の安全な整数のUnix時刻（ミリ秒） |

`detail.reclamation`は新規作成時に`null`とし、準備保存でだけnonnullにできる。
準備objectは`deliveryCreationState: checkpointed`のinstructionに限り許し、終端state、終端時刻、通常detailが持つ不変fieldを固定する。
attempt ID、logical ID、revision、launch reference、source projection、envelope digest、native content digest、作成時刻はinstruction detailの既存fieldをsnapshotとして使い、checkpoint値との比較のために複製しない。
`source`はv1 journalと同じ正規化projectionを保ち、claims、identity、execution binding、conversation ID、session IDの完全値を比較に使う。
checkpoint detailまたはgraveとの照合では、attempt、kind、logical ID、revision、payload digest、source projection、sourceから導くcanonical target、state、terminalAtを検証する。
accepted/applied correlationはその時点の有効な相関を保持し、準備後もattempt、revision、digest、target、terminal result、terminalAtを変えない有効な後着証拠の追記だけを許す。
そのためinstruction準備は質問retirementの全状態freezeと異なり、質問のfreeze規則を通常指示へ適用しない。

`reclaimed`は`envelope`を持たず、上表の他fieldを保持する。
その`deliveryCreationState`は`checkpointed`、`reclamation`はnonnull、`reclaimedAt`は`preparedAt`以上の安全な整数でなければならない。
`detail`でnonnullだったreclamationと、`reclaimed`側のreclamationは全fieldが一致し、`reclaimedAt`を再起動や通知で変更しない。
instruction journalはこのreclaimed recordをattemptの恒久的な再利用拒否として保持する。

通常指示の本文回収は、checkpointの確定terminal stateと`terminalAt`から7日以上経過した場合に限る。
`preparedAt`は0以上の安全な整数のミリ秒時刻で、回収準備を記録する。
`preparedAt`は`terminalAt + TERMINAL_RETENTION_MS`以後でなければならない。
期限は既存`terminalAt + TERMINAL_RETENTION_MS`から判定し、時計が`terminalAt`より前に戻ったときや安全な整数で期限を表せないときはdetailを残して準備を延期する。
通常指示にquestion periodの期限や一般的なperiod失効を適用せず、`not_created`、`creating`、`indeterminate`、available、claimed、sending、accepted、unknownのdetailは期限で回収しない。
通常指示の終端回収は次の3保存境界を同一operation IDで順に進める。

1. instruction journalのdetailへprepare objectを保存する。envelopeとdetailは残す。
2. checkpoint writer queueで対応する終端detailを`reason: terminal_retention`のgraveへ置換して保存する。
3. 対応するprepare objectを保ったままinstruction journalのdetailをreclaimedへ置換し、同じ保存で`reclaimedAt`を記録する。

最初の保存結果が不明ならinstruction writerを止める。
checkpoint保存結果が不明ならcheckpointを共有する全kindのwriterを止め、instruction serviceも再開しない。
最後のinstruction journal保存結果が不明ならinstruction writerを止める。
質問用anchor migrationとは別operationであり、同じcheckpoint保存結果不明の範囲だけを共有する。

| instruction journal | checkpoint | 復旧動作 |
|---|---|---|
| prepare済みdetail | 全相関と固定終端snapshotが一致するterminal detail | 同じoperation IDで境界2を続ける |
| prepare済みdetail | `terminal_retention`かつ同じoperation IDのgraveが全相関と終端snapshot一致 | 同じoperation IDで境界3を続ける |
| reclaimed | `terminal_retention`かつ同じoperation IDのgraveが全相関と終端snapshot一致 | 完了済みの拒否記録として維持する |
| prepare済みdetail | checkpoint attempt不在、state/time不一致、または相関不一致 | journal/checkpoint不整合として拒否する |
| prepareなしのdetail | `terminal_retention` grave | 保存順にないため拒否する |
| reclaimed | terminal detail、checkpoint record不在、別operation IDのgrave、またはsource/target/state/time不一致 | journal/checkpoint不整合として拒否する |
| reclaimed | prepare object欠落または不正 | journal schema違反として拒否する |
| `detail.reclamation: null` | attemptに対応するquestion専用grave | coordinator種別が異なるため拒否する |

question deliveryのgraveは[質問schema](common-question-reclamation-schema.md#隔離保持本文回収)の質問journal prepare objectと同じoperation IDを持ち、`reason: retired_question_period`で識別する。
generic instruction-retention coordinatorはquestion専用graveを新規作成・更新せず、その回収を通常の終端期限表へ含めない。

### 明示回収と後着相関の受付

通常指示の明示回収はinstruction service、checkpoint、context I/Oのqueueを順に取得し、3保存境界が終わるまで保持する。
各境界では最新snapshotへ対象slotだけを差し込み、無関係な作成途中の記録を冷起動の修復値へ置き換えない。
callback accessはそのcallback内だけで使い、待機中の保存も実書込みの直前に寿命とcloseを照合する。
準備済みの冷起動復旧は全writerの再開前に行い、保存結果不明後は同じinstanceで再開しない。

静的な照合はjournalの完全sourceからcheckpointのsourceとcanonical target、および墓標のsourceRefとtargetRefを導く。
claimsのdigestは正規化済みfieldの固定順で求め、元objectのfield順やtoJSONを根拠にしない。
この照合は保存済み記録の整合検査であり、native通知や再送の権限を発行しない。

通常指示のapplied墓標は、固定相関が一致するacceptedの互換追記と、完全一致するappliedの重複だけを受け付ける。
既存の非nullのnative IDを差し替えず、終端状態と時刻、墓標の時刻、refs、digest、回収operationを変更しない。
変更が無ければ保存とrevision更新を行わず、変更時は台帳全体を検査して相関の重複も拒否する。
applied墓標の容量予約には、固定applied相関からacceptedへ補完できる最大増分を含める。
保存済みgrantを増額せず、通常枠とgrantの合計に収まらなければ保存内容を保持して更新を拒否する。
取り下げと送信前置換の墓標にはacceptedとappliedを追加せず、質問の退役墓標も更新しない。
payloadの復元、claim、send、unknown化、取り下げは墓標から受け付けない。

serviceが準備済み記録や墓標への通知を受ける場合は、既存adapterのcontextとsourceTokenが有効かを保存前と書込み直前に照合する。
本文操作の適格性を広げず、墓標から新しいcapability、token、観測、timerを作らない。
終了済み観測は拒否し、終了時のcleanupを画面表示の適格性に依存させない。
7日後も任意のnative通知が届くことは保証せず、保存層の相関更新と、既存権限で到着したservice通知の確認を区別する。

段階3の明示構成は既存保存層の全writer停止を維持する。
instruction journalの単独保存結果不明でも全writerを停止し、instructionだけを止める契約の分離は後続で実装する。
自動実行、grant解放、墓標件数枠の解放、標準起動への接続はこの明示回収に含めない。

明示構成の適合試験は、実ファイル保存とfixtureのnative processを通して次の条件を確認する。
実ClaudeとCodexの通知到着や7日後の観測寿命の確認とは区別する。

| ID | 確認条件 |
|---|---|
| IRB01 | 確定終端から7日未満、unknown、作成未完了は保存せず保留し、期限到達後に3保存で本文を回収する |
| IRB02 | 各保存境界の失敗後は新instanceが同じ操作IDで再開し、未準備のeligible記録は自動回収しない |
| IRB03 | 本文とcheckpointの静的相関が不一致なら、起動時に保存とnative送信を行わず拒否する |
| IRB04 | applied墓標への互換accepted追記と完全一致appliedは保存層で成立し、差替えと他の墓標への追記は拒否する |
| IRB05 | cleanup後のservice通知は保存されず、既存観測の照合でtoken不一致、close、待機中の失効を拒否する |
| IRB06 | 時計逆行、期限の整数overflow、close、callback access失効時は次の保存を行わない |
| IRB07 | 無関係な記録、alias、履歴、logical tombstone、件数枠、grantを保持し、後着相関の最大増分を予約する |

純粋な計画、静的照合、容量予約とstore照合の関連試験は47件、実factoryとファイル保存を通る試験は34件成功した。
Claudeのapplied状態は完全相関する保存済みcheckpointのcold fixtureであり、Codexのapplied状態はfake native evidenceを通して作る。
applied墓標への保存成功はtrusted provider adapter経路で確認し、serviceの通知権限を再発行する正例とは区別する。
観測cleanup後の拒否と共有保存queue待機中のwitness失効は、Codexのguarded store入口で確認した。
既存adapter観測のtoken照合と終了後失効は、両providerの単体試験で確認した。
これらは実runtimeの7日後通知や、墓標からの観測再開の証跡には含めない。

## PR通知のaliasと履歴

現行PR通知の論理keyはkind、logical ID、revision、target launch tupleで決まり、source execution IDはkeyに入らない。
既存deliveryには入力の`targetId` aliasが保存されず、logical tombstoneにはtarget launch tupleだけが保存される。
この互換規則を保ち、graveの`targetRef.launchKey`を既存`logicalTombstones.targetLaunchKey`へ対応させる。
移行では実際に入力されたaliasを推測して記録しない。
`notificationTargets`のaliasと`registrations`のlaunch履歴はv2でも維持し、graveまたはlogical tombstoneが参照するlaunch tupleがある間は削除しない。
aliasを将来削除する場合は、同じtarget IDの別targetへの再割当を拒否するalias墓標を別途定義する。
aliasまたは履歴の不足、同じtupleに対する異なるprojection、target launch keyの不一致はPR通知を隔離し、再送しない。

## 回収対象と途中復旧

| state | detail削除の扱い |
|---|---|
| 非questionの`applied`、`cancelled_before_send`、`superseded_before_send` | instruction、PR通知、resultのgeneric coordinatorが`terminalAt`から7日後に回収できる |
| active periodのterminal question | generic coordinatorの対象外であり、期限経過後もdetailを保持する |
| 退役periodのquestion | 質問専用coordinatorだけが回収する。本文回収時には`quarantinedAt`とquestion prepareを必須とし、terminalなら`terminalAt`からも7日を経る |
| `unknown` instruction、`unknown` PR通知、`unknown` result | 詳細を保持したままunknownを保ち、正しい後着相関を受け入れる。期限で終端化や本文圧縮を行わず、結果が終端になった後にgeneric coordinatorが回収する |
| `claimed` | 起動時のcheckpoint回復でavailableへ戻す。これだけで終端とせず、時間経過だけで回収対象へ変えない |
| `available`、`sending`、`accepted`の非question kind | 終端扱いにせず、時間経過だけでgeneric回収対象へ変えない |

`TERMINAL_RETENTION_MS`は7日分の604,800,000ミリ秒である。
非questionの終端graveは`terminalAt`から7日以上経過し、拒否に必要なlogical tombstoneと相関が整合するときだけ作る。
questionの保持期限は[質問schema](common-question-reclamation-schema.md#隔離保持本文回収)に従い、active questionにgeneric terminal retentionを適用しない。
安全な整数範囲を超える加算や時計が起算時刻より前に戻った場合はdetailを残し、起算時刻を更新しない。
判定は保存されたUnix時刻に基づき、大幅な時計前進後も実時間で7日が経過したことの保証はしない。

checkpoint復旧時は現行どおり`claimed`を`available`へ戻し、`sending`と`accepted`を`unknown`へ戻す。
question period退役では質問専用gateを閉じてqueueをdrainし、anchorへの失効保存後に対象question deliveryだけを`claimed`から`available`、`sending`または`accepted`から`unknown`へ正規化する。
対象questionのattempt、payload digest、相関、cancel要求を保持し、既にterminalなstate、terminal result、`terminalAt`は変更しない。
このcheckpoint snapshotを質問journalへ保存する前に質問本文を回収しない。
question period退役の操作と途中復旧は[アンカーの失効とwriterの直列化](question-reclamation-anchor.md#失効とwriterの直列化)および[質問schema](common-question-reclamation-schema.md#配信作成とcheckpointの相関)に従う。
回収準備前のretained questionだけは、完全相関と合法なstate遷移経路を満たすcheckpointの現在値を採用し、復旧正規化snapshotを質問journalへ保存できる。
prepare済みquestion、reclaimed question、schema migrationの固定targetはsnapshotのstateと相関が完全一致しなければならず、退役後に新しい通知を取り込まない。
question専用coordinatorは通常指示やPR通知など他kindのcheckpoint stateを正規化しない。
途中のdetailをgraveへ置換する操作はcheckpoint writer queue内で一件ずつ行い、保存結果が不明なら共有checkpointを使う全kindのwriterを止める。
質問journalだけの保存結果が不明な場合は質問writerと対象質問gateを止め、通常指示とPR通知のwriterまで一律に止めない。
checkpoint共有writerの停止範囲はschema migrationの全slot drainとは別であり、質問回収operationの不明結果だけで他kindのstateを変更しない。

移行開始時にanchorへoperation IDと各source fingerprintを固定する。
各fileはsource fingerprintとtarget fingerprintのどちらかに完全一致した場合だけ途中状態として認める。
phaseはアンカー共通契約の`prepared`、`guarded`、`installing`、`completed`を使う。
全manifest slotのwriterをdrainして停止してから置換を始め、全target fingerprintを検証して`completed`を保存する。
続けて`migration: null`の保存成功を確認してからwriterを再開する。
schema移行中はcheckpointを共有する通常指示とPR通知のwriterも停止する。
7日後の本文回収はschema migrationとは別operationであり、本文の保持期限をmigration phaseに含めない。
questionの本文回収はさらに質問専用coordinatorに限定し、generic terminal-retention operationへまとめない。
隔離された質問に旧形式の`quarantinedAt`が無い場合は`migration.startedAt`を一度だけ保存し、manifest削除後もその時刻を保持する。
checkpoint v2からv3への変換では、外側revisionとledger revisionを最大安全整数まで予約し、相関とstateの増加分を実serializerで検査する。
instruction journal v1からv2への変換では、journal revisionの増加分とstore ID、creation state、envelope全体の保存byteを予約する。
移行の再開では新しいoperation IDやsource snapshotを発行せず、target fingerprintが不一致なら隔離する。
ファイルごとのatomic置換であり、anchor、checkpoint、journalを横断する同時commitを仮定しない。

## 移行専用枠のbyte計算

現行checkpoint serializerは`JSON.stringify(value, null, 2) + "\n"`である。
新schemaのbyte数は、同じpretty serializerと改行を含む実保存byteから測る。
旧形式の移行入力には、保存先ごとの既存byte上限、件数上限、構造検査を同時に適用する。

| 枠またはsource slot | 固定上限 | 根拠 |
|---|---:|---|
| 通常アンカー`B_anchor` | 16,777,216 bytes、失効period 20,000件 | [質問回収アンカー](question-reclamation-anchor.md) |
| questionsの旧source `C_questions` | 16,777,216 bytes | 質問journalの最大byte上限 |
| checkpointの旧source `C_checkpoint` | 16,777,216 bytes | 既定1,048,576 bytes、設定上限16,777,216 bytes |
| instructionsの旧source `C_instructions` | 16,777,216 bytes | instruction journalの最大byte上限 |
| 質問記述子`Qmax` | 20,000件 | アンカーの移行target上限 |
| 失効period記録`Pmax` | 20,000件 | 通常アンカーの失効period上限 |

登録時には完全identityとperiod IDごとに、そのperiodを失効させる将来の記録1件分の件数とserialized byteを予約する。
同じkeyの予約は重複計上せず、anchorにはpending reservation fieldを追加しない。
予約はquestion journalのreservationsにある非退役の完全identityとperiod IDの集合から導き、再起動時と登録・失効操作前に再計算する。
共通coordinatorで対象periodの操作を直列化し、anchorの実byteと未消費予約の件数・byteを合わせて上限検査する。
anchorに失効記録を保存したperiodは未消費集合から除き、そのrecordの実byteで将来予約を満たしたものとする。
現在のアンカー実byteと全未消費予約を合わせて`B_anchor`または20,000件を超える新しいperiodは受け付けない。
予約分を含めて上限を検査するため、質問受付後に失効記録を追加できなくなる状態を作らない。

移行anchorの追加枠は次式の右辺を段階2で証明して固定する。

`RHS = Σ_s(c_s × C_s) + Qmax × Kq + Pmax × Kp + Kmanifest`

`c_s`は旧source slotごとの旧文字列の最大複製回数で、無次元の整数とする。
`C_s`は上表の旧source slotごとの許容serialized byte上限である。
`Kq`は質問記述子1件、`Kp`は失効period記録1件の固定構造byte上界である。
`Kmanifest`はmigration wrapperと最大3 slotのsource/target fingerprint descriptorのbyte上界である。
`Kq`と`Kp`にはschema field、固定enum、digest、時刻、delimiter、pretty indentを含める。
sourceから複製する可変文字列は`c_s × C_s`で数え、`Kq`と`Kp`へ重ねて数えない。
旧sourceのJSON escapeは`C_s`に含め、escapeを二重計上しない。
`c_s`と各`K`の値は任意設定にせず、採用schemaの実serializerから段階2で決める。

段階2では、各旧slotのbyte、件数、field、相関の制約を同時に満たす最大fixtureをserializerで検査し、任意の受理可能sourceに対する必要追加byte `need` が`RHS`以下であることを証明する。
その右辺を固定`T_migration`とし、`T_migration = RHS`とする。
全recordに512文字IDを同時に複製したり、実現できない独立最大構造を重ねたりして上限を水増ししない。
`Qmax × Kq`と`Pmax × Kp`は固定構造の予約であり、最大長の旧文字列を各recordへ追加複製する前提を含まない。

移行中のanchor 1 fileの上限は`M = B_anchor + T_migration`とする。
`M`は通常の失効集合と一時的なmigration情報を含むanchorのserialized byte上限であり、独立最大長recordを20,000倍した値だけから算出しない。
移行完了時には失効集合が20,000件かつ`B_anchor`以内に収まることを必須とする。
初回の旧question sourceから作る失効集合も`B_anchor`に収まることを段階2で証明する。
通常受付の予約があるため、定義どおりの登録から失効への投影でbyte上限を超えないこともfixtureで確認する。
既存anchorが満杯で追加の失効集合が`B_anchor`に収まらない場合、追加枠を恒久容量へ転用しない。
sourceとmigrationの拒否情報を保持し、manifestを完了扱いまたはnullにせず、migrationと新規受付を停止したままにする。
固定枠を黙って拡張しない。

| 要素 | 最大長の根拠 | byte計算 |
|---|---|---:|
| 既存identifier | 512 UTF-16 code unit。単独surrogateはJSONで6文字へescape | JSON stringの引用符を含め3,074 byte |
| storeId、operationId | 小文字UUIDv4 | 36 ASCII文字。JSON stringは38 byte |
| revision、時刻、`terminalAt` | `Number.MAX_SAFE_INTEGER` | decimal 16文字 |
| SHA-256 digest | lowercase hex固定 | JSON stringは引用符込み66 byte |
| 最大相関object | 現行7 field、最大5 ID、revision 16桁、digest64桁 | compact 15,572 byte、単独pretty 15,601 byte |
| 最大reserved state | 現行state enum中の最長値 | `superseded_before_send`、22文字 |

`H_checkpoint`は旧schemaの固定上限`C_checkpoint`、件数、field、相関条件を同時に満たすsourceから、checkpoint v3の有効な移行、保持、回収projectionへ増える最大byteの固定上界である。
`terminalAt`、variant、grave metadata、revision増分、合法な後着遷移で増え得る相関、最大20,000件のeligible attempt ID roster、`migrationAllowance` objectと、移行中の旧詳細との一時重複を含める。
question deliveryのgrave用fieldもこのschema上限へ含めるが、その作成と更新は質問専用coordinatorが行う。
退役後のquestion相関は質問専用gateでfreezeするため、その後着増分を予約しない。
`H_instructions`は旧schemaの固定上限`C_instructions`、件数、field、相関条件を同時に満たすsourceから、instruction journal v2の有効な移行、保持、回収projectionへ増える最大byteの固定上界である。
store ID、record variant、delivery creation state、revision増分、最大envelope、最大20,000件のeligible instruction ID roster、`migrationAllowance` object、detail用prepare object、reclaimed variantの`reclaimedAt`とoperation metadata、移行中の旧詳細との一時重複を含める。
通常の新規instructionも、新規受付時の`B_instructions`予約にdetailからprepare済みdetail、reclaimed recordまでの最大将来projectionを含める。
同じattemptのcheckpoint予約にはterminal stateと`terminalAt`、grave化後に合法な後着相関が増える分を含め、新規記録にはどのslotのgrantも使わない。
`H_questions`は[質問journalの移行追加枠](common-question-reclamation-schema.md#質問journalの移行追加枠)の正本に従い、anchorの`T_migration`へ二重計上しない。
各`H_i`は固定上限`C_i`内の有効な旧snapshot、件数、全recordの相関条件を同時に満たすprojectionの実serializer差分から段階2で固定する。
実source `S_i`ごとのgrant `G_i`はその上界内で別途発行し、`B_i + G_i`までのload/writeにだけ使う。
`serializedTargetMax_i`も同じ有効snapshot制約で測り、全件へ独立最大長recordを配置する非実現構造を使わない。
通常kindのunknownはdetailのまま保持し、後着相関も受け付けるため、通常checkpoint容量を引き続き消費する。
このunknown detailはquestion用の圧縮`H`へ含めず、回収量として見積もらない。
#206のmemory ledgerとclaimの回収、および非question unknownの長期占有は段階4の未完了範囲である。

`H_i`は各data slotの旧schema全域から証明する固定追加枠上界であり、特定sourceの実byteとの差分や現在のload/write上限ではない。
初回source `S_i`の指紋、固定`H_i`、保存grant `G_i`、現在設定`B_i`は混ぜず、anchorの容量契約に従って検査する。
`migration: null`後もgrant `G_i`が残る間は、実source `S_i`から発行した対象IDの既存recordに限り`B_i + G_i`までのload/writeを許す。
実projection差分が`G_i`内にある間はgrant対象recordの保持、状態遷移、回収を続け、grantがnullなら全load/writeを通常`B_i`内に制限する。
`H_i`を新規受付の予約や通常容量として使わず、次の移行でHを再帰的に加算しない。
容量不足時は現在保存されているsourceまたはtargetと拒否情報を保持し、migrationと受付を再開しない。
7日経過前に通常上限を超える場合も新規受付を止め、本文保持期限を短縮しない。

初回移行と移行後再書込みの物理peak、追加予約の切替えは[アンカーの容量式](question-reclamation-anchor.md#満杯からの移行とbyte上限)を正本とする。
