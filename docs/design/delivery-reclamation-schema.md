# 配信記録の回収 schema

この文書は[容量回収計画](codex-capacity-reclamation.md)の段階1で定める配信側の保存契約である。
実装時は[質問回収アンカー](question-reclamation-anchor.md)の`storeId`と移行fingerprintを共有する。

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
| 通常指示journal | 2 | anchorと同じ`storeId`、必須`migrationAllowance`（null可） |
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
この節の通常枠 `B_i` は保存先の設定済みbyte上限であり、ピーク式の旧ファイル実byte `N_i` と区別する。

| field | 値と検査 |
|---|---|
| `operationId` | anchor migrationと同じoperationの小文字UUIDv4 |
| `sourceSchemaVersion` | checkpointでは2、instruction journalでは1 |
| `sourceSizeBytes` | 対応する旧source slotの固定実byte size。安全な整数で`0..B_i`。旧source schemaの制約も満たす |
| `sourceSha256` | 対応するanchor source fingerprintと同じ、旧source実byteの小文字SHA-256 hex 64文字 |
| `maxExtraBytes` | 正の安全な整数でslot固有の`H_i`以下。算出値0ならgrantはnull。発行後不変 |
| `eligibleAttemptIds` | dense array。重複のない最大20,000件のidentifierで、各512 UTF-16 code unit以下 |

移行coordinatorだけが、旧sourceのschema、size、SHA-256がanchorの固定fingerprintと一致した後にgrantを発行する。
checkpoint grantのrosterは旧checkpoint v2 ledgerに存在したdelivery attempt ID、instruction grantのrosterは旧journal v1に存在したinstruction attempt IDから固定する。
grantのoperation ID、source fingerprint、rosterを後から追記・差替え・再利用せず、同じsourceへのpartial grant積上げやgrantの重ね掛けを拒否する。
受け取った有効な旧source `S`について、`maxExtraBytes = max(0, max_b(projectedReserveBytes_i(S,b) - sourceSizeBytes(S)))`を一度計算して固定する。
`b`はそのslotの移行、保持、回収の各到達可能snapshotと許可された将来遷移を表す。
`projectedReserveBytes_i`は実serializer byte、grantとroster、まだ使用していない合法な将来増分を一度だけ含め、別々の到達状態の最大値を使い、合計しない。
計算中はgrant内の数値を16桁の最大幅でprojectionして自己参照を避ける。
算出値が0またはsourcePresent=falseならgrantをnullにし、固定`H_i`を超えれば移行を拒否する。
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
| `detail` | 現行delivery fields、必須`terminalAt`、このdiscriminatorを保持する |
| `reclaimed` | `terminalAt`と拒否、相関、参照情報を残し、detailを削除したrecord |

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
前者は`applied`、`cancelled_before_send`、`superseded_before_send`だけに、後者は退役済みquestion periodの`available`または`unknown`だけに許す。
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
questionの失効periodはanchorが別に拒否するため、同じkeyの再attemptをこの例外で許さない。
anchorが失効済みにしたperiodのquestion graveはledger stateより先に拒否判定し、登録、claim、sendStart、payload復元、後着更新を拒否する。
`available`や`unknown`を成功、取消、未送信確定へ読み替えず、対応する質問記録の`terminalResultKind`は`null`のまま保つ。

相関の固定項目はattempt ID、revision、payload digest、target period ID、client request IDである。
相関のattempt IDとclient request IDはrecordのattempt IDと一致し、revisionとpayload digestはrecordと一致し、target period IDはtargetRefのperiod IDと一致する。
accepted correlationとapplied correlationのnative turn IDとnative item IDは既存の互換条件で検査する。
appliedにはnative turn IDとnative item IDの両方を必須とし、native item IDだけがある相関を拒否する。
`available`はfrozenなまま保持し、`unknown`と`terminalResultKind: null`を含む対応質問記録も変更しない。
他kindのunknownはdetailを保持し、正しい相関の後着通知によるaccepted/appliedへの更新を現行どおり許す。

instruction journal v2は既存record fieldsに`deliveryCreationState`を加え、`not_created`、`creating`、`checkpointed`、`indeterminate`を使う。
新規instruction intentは`not_created`を保存し、checkpoint作成前に`creating`を保存して、matching detailまたはgraveのcheckpoint保存後に`checkpointed`を保存する。
再起動時の`creating`はattemptと全相関が一致するcheckpoint recordがあれば`checkpointed`へ復元し、欠落なら`indeterminate`へ固定して再生成しない。
一部または全相関が一致しないcheckpoint recordは不整合として拒否する。
`checkpointed`はdelivery作成保存の証拠であり、sendまたはretryの許可ではない。
移行するv1 instruction intentはcheckpoint recordと全相関が一致するときだけ`checkpointed`へ移す。
v1 intentがcheckpointに無い場合は保存順から未作成と消失を区別できないため`indeterminate`へ移し、そのattemptを再生成しない。
この不明状態は個別attemptの拒否であり、質問periodの永久失効や通常指示の認可変更ではない。
`checkpointed`なのにcheckpointでattempt IDが見つからない場合はjournalとcheckpointの不整合としてserviceを停止する。
`reclaimed`を`get(attemptId)`の不在として返さず、serviceはgraveを既存deliveryとして照合する。
graveのpayload digest、source identityとbindingがjournalと一致しない場合も再生成せず、復元を拒否する。

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
| `applied` | `terminalAt`から7日後に回収できる。隔離questionは`quarantinedAt`からも7日を経てから圧縮する。失効済みquestion periodでは同じ結果の後着も拒否し、他のapplied graveだけ同一結果を冪等に受け付ける |
| `cancelled_before_send`、`superseded_before_send` | `terminalAt`から7日後に回収できる。隔離questionは`quarantinedAt`からも7日を経てから圧縮し、相関はnullのまま保つ |
| 退役periodの`available` question | `quarantinedAt`から7日後に本文を圧縮できる。stateはavailableのまま保持し、grave優先でclaim、sendStart、payload復元、後着更新を拒否する |
| 退役periodの`unknown` question | `quarantinedAt`から7日後に本文を圧縮できる。stateはunknown、質問側`terminalResultKind`はnullのまま保持し、後着更新を拒否する |
| `unknown` instruction、`unknown` PR通知、`unknown` result | 詳細を保持したままunknownを保ち、正しい後着相関を受け入れる。期限で終端化や本文圧縮を行わず、結果が終端になった後にgrave化する |
| `claimed` | 回復時はavailableへ戻す。これだけで終端とせず、時間経過だけでreclaim対象へ変えない |
| `available`、`sending`、`accepted`の他kind | 終端扱いにしない。時間経過だけでreclaim対象へ変えない |

`TERMINAL_RETENTION_MS`は7日分の604,800,000ミリ秒である。
通常の終端graveは`terminalAt`から7日以上経過し、拒否に必要なlogical tombstoneと相関が整合するときだけ作る。
隔離questionの終端recordは`terminalAt`とquestion journalの`quarantinedAt`それぞれから7日以上経過してから圧縮する。
したがって隔離済みterminal questionの最短圧縮時刻は`max(terminalAt, quarantinedAt) + TERMINAL_RETENTION_MS`であり、片方の起算が遅い場合も7日を保つ。
退役questionの非終端`available`または`unknown`は`terminalAt`を要求せず、`quarantinedAt + TERMINAL_RETENTION_MS`だけで本文回収できる。
安全な整数範囲を超える加算や時計が起算時刻より前に戻った場合はdetailを残し、起算時刻を更新しない。
判定は保存されたUnix時刻に基づき、大幅な時計前進後も実時間で7日が経過したことの保証はしない。

checkpoint復旧時は現行どおり`claimed`を`available`へ戻し、`sending`と`accepted`を`unknown`へ戻す。
退役periodのquestion grave対象は復旧後の`available`または`unknown`だけとし、`claimed`はこの既存回復で`available`になった後に扱う。
period退役だけを理由に`cancelled_before_send`や成功結果を新しく作らない。
墓標化は終端化ではないため、`sending`を送信済みまたは未送信へ推定せず、unknownの結果も成功へ読み替えない。
途中のdetailをgraveへ置換する操作はcheckpoint writer queue内で一件ずつ行い、保存結果が不明なら共有checkpointを使う全kindのwriterを止める。
質問journalだけの保存結果が不明な場合は質問writerと対象質問gateを止め、通常指示とPR通知のwriterまで一律に止めない。

移行開始時にanchorへoperation IDと各source fingerprintを固定する。
各fileはsource fingerprintとtarget fingerprintのどちらかに完全一致した場合だけ途中状態として認める。
phaseはアンカー共通契約の`prepared`、`guarded`、`installing`、`completed`を使う。
全manifest slotのwriterをdrainして停止してから置換を始め、全target fingerprintを検証して`completed`を保存する。
続けて`migration: null`の保存成功を確認してからwriterを再開する。
schema移行中はcheckpointを共有する通常指示とPR通知のwriterも停止する。
7日後の本文回収はこのmigrationとは別operationであり、本文の保持期限をmigration phaseに含めない。
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
| questionsの旧source `N_questions` | 16,777,216 bytes | 質問journalの最大byte上限 |
| checkpointの旧source `N_checkpoint` | 16,777,216 bytes | 既定1,048,576 bytes、設定上限16,777,216 bytes |
| instructionsの旧source `N_instructions` | 16,777,216 bytes | instruction journalの最大byte上限 |
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

`RHS = Σ_s(c_s × N_s) + Qmax × Kq + Pmax × Kp + Kmanifest`

`c_s`は旧source slotごとの旧文字列の最大複製回数で、無次元の整数とする。
`N_s`は上表の旧source slotごとの許容serialized byte上限である。
`Kq`は質問記述子1件、`Kp`は失効period記録1件の固定構造byte上界である。
`Kmanifest`はmigration wrapperと最大3 slotのsource/target fingerprint descriptorのbyte上界である。
`Kq`と`Kp`にはschema field、固定enum、digest、時刻、delimiter、pretty indentを含める。
sourceから複製する可変文字列は`c_s × N_s`で数え、`Kq`と`Kp`へ重ねて数えない。
旧sourceのJSON escapeは`N_s`に含め、escapeを二重計上しない。
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

`H_checkpoint`はcheckpointの有効な最大source snapshotをv3へ投影したときの最大追加byteである。
実recordに保存する`terminalAt`、variant、grave metadata、revision増分、合法な後着遷移で増え得る相関、最大20,000件のeligible attempt ID roster、`migrationAllowance` objectと、移行中の旧詳細との一時重複を含める。
退役済みquestionのavailableとunknownは凍結しているため、後着相関の増分を予約しない。
`H_instructions`はinstruction journalの有効な最大source snapshotをv2へ投影した最大追加byteである。
store ID、delivery creation state、revision増分、最大envelope、最大20,000件のeligible instruction ID roster、`migrationAllowance` objectと移行中の一時重複を含める。
`H_questions`は[質問journalの移行追加枠](common-question-reclamation-schema.md#質問journalの移行追加枠)の正本に従い、anchorの`T_migration`へ二重計上しない。
各`H_i`は旧byte上限、件数、全recordの相関条件を同時に満たすsnapshotの実serializer差分から求める。
`serializedTargetMax_i`も同じ有効snapshot制約で測り、全件へ独立最大長recordを配置する非実現構造を使わない。
通常kindのunknownはdetailのまま保持し、後着相関も受け付けるため、通常checkpoint容量を引き続き消費する。
このunknown detailはquestion用の圧縮`H`へ含めず、回収量として見積もらない。
#206のmemory ledgerとclaimの回収、および非question unknownの長期占有は段階4の未完了範囲である。

`A`は既存anchorの実byte（初回作成時は0）、`N_i`は各旧data fileの実byte、`H_i = max(0, serializedTargetMax_i - N_i)`とする。
atomic置換中は既存anchor `A`と一時anchor `M`、各旧data file `N_i`と一時target `N_i + H_i`が同時に存在し得る。
総ピーク上界は`A + M + Σ(2N_i + H_i)`である。
旧source `A`と`N_i`は既存fileが占有する通常容量に含め、追加予約へ二重計上しない。
追加予約は`M + Σ(N_i + H_i)`で、一時targetの全byteを保持できる枠を別に確保する。
`H_used_i`は現行recordsをdetail/grave variantへ投影した実serializer byteから算出し、manifestの有無に依存させない。
`migration: null`後も`H_used_i`が残る間は通常`B_i`にgrantの`maxExtraBytes`を加えたload/writeを許し、圧縮で通常budget内へ収束するまでgrant対象の既存recordを保持、更新できるようにする。
grantがnullなら全load/writeを通常`B_i`内に制限する。固定`H_i`は発行上限であり、保存されたgrantの値を拡張する根拠にしない。
`H_i`を新規受付の予約や通常容量として使わず、次の移行でHを再帰的に加算しない。
この枠を許さなければ、通常上限いっぱいの旧形式へ必須fieldを足せない。
容量不足時は旧sourceと拒否情報を保持し、migrationと受付を再開しない。
7日経過前に通常上限を超える場合も新規受付を止め、本文保持期限を短縮しない。
