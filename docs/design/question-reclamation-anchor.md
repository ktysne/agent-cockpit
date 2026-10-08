# 質問の永久失効と移行アンカーの保存契約

## 対象と保証範囲

この文書は[容量回収計画](codex-capacity-reclamation.md)の段階1で定める保存契約であり、実装済みの形式ではない。
質問の永久失効を通常の journal と別の永続アンカーに保存する。
アンカーは本文回収後も残し、質問に限った拒否の根拠とする。
registry の execution を終了させず、通常指示の認可と runtime の稼働状態は変えない。
配信 checkpoint を共有する writer の保存結果が不明な場合は、その writer 全体を止める。

保証するのはプロセスクラッシュ後の復旧、後着通知、同じ識別子の再利用に対する拒否である。
電源断時の flush 保証、全ファイルの過去への巻戻し、移行中の旧 binary への切替は対象外である。
移行中は保存先ごとに排他起動し、アンカーを知らない旧 binary を起動しない。

## アンカーの形式

固定の保存先 `question-reclamation-anchor.json` を composition が渡す。
manifest に任意のファイルパスを持たせない。
新形式の質問 journal と checkpoint は同じ `storeId` を持ち、アンカーの欠落、破損、異なる `storeId` では質問の書き込みを開始しない。
アンカーを自動で初期化し直すことも認めない。
新規作成を認めるのは、全slotが未作成の初回作成、または存在する全slotが対応する旧schemaで、上限、構造、相関検査に合格した初回移行だけである。
いずれかがstore IDを要求する新schemaなら、欠落したアンカーを作り直さない。
全保存ファイルの削除と全ファイルの旧形式への巻戻しは初回状態と区別できず、保証対象外とする。

| フィールド | 値と検査 |
|---|---|
| `schemaVersion` | `1` |
| `revision` | 0以上の安全な整数。加算が範囲を超える更新は拒否 |
| `storeId` | 新規作成時に発行する小文字UUIDv4（36 ASCII文字）。移行と再起動で不変 |
| `retiredQuestionPeriods` | 完全identityとperiod IDの重複を許さない失効記録の配列 |
| `migration` | `null` または下記の単一移行記録 |

失効記録の identity は、既存の `provider`、`nativeIdKind`、`hostId`、`homeScopeId`、`nativeId` の全項目を持つ。
identity と period ID の検査と正規化には registry と同じ規則を使う。
加えて `retiredAt` に0以上の安全な整数のUnix時刻（ミリ秒）、`reason` に `startup-quarantine` または `confirmed-retirement` を持つ。
未知のフィールド、enum、重複した失効keyを拒否する。
初期の失効世代上限は質問の最大件数と同じ20,000件とし、満杯では新規の失効操作と新規質問の受付を止める。
通常のアンカーbyte上限 `B_anchor` は16,777,216 bytesとし、件数とbyteの両方を検査する。
質問の通常登録時から、その期間の失効記録を追加する将来の件数とbyteを予約する。
未消費の予約は質問journalの非退役period集合から導出し、復旧時も同じ完全keyで再計算する。
共有coordinatorで登録と失効を直列化し、アンカー実使用量と導出予約を合わせて通常上限を検査する。
同じ完全identityとperiod IDの予約は重複計上せず、上限を超える新期間の受付を拒否する。
既存の失効記録を消して枠を空けない。

同じ period で actor、connection generation、launch reference だけが変わっても失効は解除しない。
同じ native session/thread でも、trusted registration が新しい period を発行し、現在の binding を検証できれば新期間として受け付ける。
保存データから新しい period を作らず、IDが再利用されて失効keyに一致した場合も拒否する。
現在の composition は registration の `executionId` を period ID として使う。

## 移行記録

| フィールド | 値と検査 |
|---|---|
| `operationId` | 小文字UUIDv4（36 ASCII文字）。同じ移行の再開では不変 |
| `startedAt` | 0以上の安全な整数のUnix時刻（ミリ秒）。時刻のない旧質問の隔離起算点 |
| `phase` | `prepared`、`guarded`、`installing`、`completed` |
| `sources` | 固定slotの重複を許さないファイル記述子。最大3件 |
| `targets` | 下記の質問記述子。最大20,000件。質問IDとcommon key digestの重複を拒否 |

`migration` は旧形式から拒否情報を備えた新形式への置換だけを表し、7日保持の待機と本文回収を含めない。
`prepared` はアンカー保存済み、`guarded` は置換開始の永続化済み、`installing` はファイル置換中、`completed` は全target指紋確認済みを表す。
置換順は `checkpoint`、`instructions`、`questions` とし、構成されていないslotは省略する。
途中復旧はこの順に到達できるsourceとtargetの組合せだけを受け付ける。
`prepared` は全source、`guarded` と `installing` はtargetのprefixと残りsource、`completed` は全targetに限る。

slot は `questions`、`checkpoint`、`instructions` に限り、実際の保存先は composition の固定設定に対応付ける。
ファイル記述子は `sourcePresent`、旧 `schemaVersion`、`revision`、`sizeBytes`、`sha256` と、移行後の `targetSchemaVersion`、`targetRevision`、`targetSizeBytes`、`targetSha256` を持つ。
旧ファイルが無い場合は `sourcePresent: false`、旧versionとrevisionとdigestは `null`、旧sizeは0とする。
ファイルが無いことを、個別の配信が未作成である証拠には使わない。
移行後はファイルを削除する形式を許さず、各target fingerprintを事前に確定する。

version、revision、sizeは安全な整数の範囲で検査し、digestは小文字のSHA-256 hex 64文字に限る。
`sources.sha256` と `targetSha256` は保存する実byte列のdigestである。
質問記述子の `recordDigest` と `commonKeyDigest` は、各schemaで定義した正規化形式のdigestであり、実byte列のdigestと混同しない。
JSONのキー順や改行を変えたファイルを、同じsource fingerprintと読み替えない。

質問記述子は `internalQuestionId`、`commonKeyDigest`、`periodIndex`、`recordDigest`、`deliveryPresence`、`deliveryIntent`、`checkpointState` を持つ。
`periodIndex` は失効配列の有効なindexで、移行中は失効配列の追加、削除、並替え、置換を止める。
通常の質問と配信の記録は配列indexを永続参照せず、完全identityとperiod IDを保持する。
`deliveryIntent` は既存の4フィールドの相関または `null` とし、質問詳細との一致を検査する。
`checkpointState` の具体enumと質問の相関検査は[質問schema](common-question-reclamation-schema.md)に定める。

| `deliveryPresence` | 条件と復旧 |
|---|---|
| `none` | 未選択質問、または新schemaの配信未作成を示す永続証拠がある。新しい配信を作らず質問側だけを回収 |
| `checkpoint` | checkpointに対応配信があり、ID、digest、相関が一致する。質問と配信を順序どおり回収 |
| `indeterminate` | 作成有無を証明できない。unknownとして拒否情報を保存し、新作成と再送を禁止 |

旧形式の選択intentがあるのにcheckpointが無い場合は `indeterminate` とする。
新形式で作成中に停止した場合も、成功を確認できない限り `indeterminate` にする。
いずれも移行全体の失敗とはせず、曖昧な質問の再作成を拒否したまま保持と圧縮を行う。
対応配信の欠落を `none` に変更して回収を成功させない。
checkpoint全体の整合性が壊れている場合は、この記述子を使って通常指示やPR通知の不整合まで回復した扱いにしない。

## 失効とwriterの直列化

質問serviceと配送storeの独立queueの上位に、質問専用の共有gateを置く。
gateは対象の完全identityとperiod IDごとに `active`、`retiring`、`retired` を持つ。
失効を始める操作は次の順序とする。

1. 同期で `retiring` にし、新しい登録、回答、poll、timer、late answer、配送作成、復元、sendStartを遮断する。
2. 既に開始した対象操作をdrainし、質問と関連配信のsnapshotを固定する。
3. 失効記録と移行intentをアンカーに保存し、保存成功を確認する。
4. `retired` にし、移行または回収を続ける。保存失敗や結果不明でもgateを開け直さない。

送信操作はgateの世代番号を捕捉し、最終sinkを呼ぶ直前にも同期で再検査する。
再検査からsinkの呼び出しまで `await` を挟まない。
既にsinkを呼んだ配信を取り消せた扱いにはせず、結果不明ならunknownのまま保持する。
アンカー復旧前は質問gateを閉じ、未定義の旧periodを新期間として受け付けない。

質問journalの保存結果が不明ならそのserviceを、共有checkpointなら全kindのcheckpoint writerを、アンカーなら同アンカーの全質問gateと回収coordinatorを停止する。
形式移行中はmanifestの全slotに対応するwriterを止めてdrainし、通常指示とPR通知も同じcheckpointを書き換える間は停止対象とする。
全slotのdrainが完了してからsource snapshotとtarget byte列を固定し、その後にmanifestを保存する。
アンカー書込み結果が不明なら、移行中のslot writerも再開しない。
本文を消してから失効の保存を試す順序は使わない。

## 満杯からの移行とbyte上限

通常受付の上限 `N` と別に、アンカー用の移行枠 `M` と各データファイルの追加移行枠 `H` を設ける。
移行枠は通常受付に使えない。
移行専用の追加枠 `T_migration` は、受理可能な旧slotのbyte上限、件数上限、field制約を同時に満たす入力に対する固定上界とする。
必要追加量の上界を `Σ(c_s × N_s) + Qmax × Kq + Pmax × Kp + Kmanifest` で証明し、その右辺を固定枠 `T_migration` とする。
`N_s` は旧slotの許容byte上限、`c_s` は旧文字列の最大複製回数、`Qmax` と `Pmax` は各20,000件の質問と世代の上限である。
`Kq` と `Kp` は追加キー、digest、時刻、区切り、indentの最大byte数、`Kmanifest` は最大3slotの記述子とenvelopeの最大byte数である。
旧文字列をJSON文字列として二重escapeせず、旧文字列の合計byteが `N_s` 以下である制約を使う。
各記述子の独立した最大長を20,000倍した値だけを移行枠の根拠にしない。
係数、固定fieldのbyte数、最終の固定定数は段階2で実serializerに基づいて証明し、最大escapeのfixtureで確認する。
`T_migration` を利用者の自由な設定値にはしない。
移行中のアンカー1ファイルの上限 `M` は `B_anchor + T_migration` とする。
`M` はアンカー1ファイルの上界であり、atomic置換時の既存アンカー `A` と一時ファイル `M` の同時保持は別に計上する。
各データファイルの通常上限を `N_i`、追加枠を `H_i` とすると、保守的なピーク総量は `A + M + Σ(2N_i + H_i)`、`A ≤ M` なので上界は `2M + Σ(2N_i + H_i)` となる。
既存ファイルの占有量と専用追加予約を区別し、同じ既存byteを両方へ重複計上しない。
`H` は各ファイルの新schemaへの差分と、保持する旧詳細と拒否情報の重複分の最大byte数とする。
IDの最大長はUTF-16 code unitsであり、JSON escapeによるbyte増加を含める。
512 code unitsの文字列を512 bytesとは数えない。

移行時だけ `N + H` を許し、質問本文は7日を待ってから圧縮する。
初回移行の `startedAt` は各記録の `quarantinedAt` に一度だけ保存し、manifestの完了後も保持起算点として残す。
新形式の記録から保持中の追加枠の使用量を算出し、`migration` の有無で使用可否を決めない。
移行中の専用枠を診断に出し、7日経過前に満杯なら新規受付停止を維持する。
容量を空けるために保持期間を短縮しない。
新形式が通常枠に収束した後は、追加移行枠を通常受付へ転用しない。
再移行で `H` を再帰的に足して上限を増やすことも認めない。

旧readerで上限付き検査を行い、writer停止とsnapshot固定後にアンカーを保存してからデータファイルを新schemaへ置換する。
旧byte fingerprintか移行後fingerprintに一致するファイルだけを途中状態として受け付ける。
両方に一致しないファイル、異なる操作ID、欠落した必須アンカーは隔離し、自動で再構築しない。
`completed` を保存し、新schemaの拒否情報が保存済みであることを確認してから `migration` を `null` にできる。
全targetの指紋照合、`completed`、続く `migration: null` の保存成功を確認した後に通常writerを再開する。
`completed` と `null` の間で停止した場合は、writer未再開を前提にtarget指紋で復旧する。
以後は旧manifestのbyte指紋を適用せず、新schemaの構造と相関で復旧を検査する。
7日後の本文回収は各schemaの回収操作で管理し、形式移行のmanifestを残したまま通常writerを再開しない。
失効配列とstore IDは残す。
初回の旧質問から作る失効集合が `B_anchor` に収まることを、旧入力の上限と投影の容量式で段階2に証明する。
通常上限が満杯の既存アンカーへの追加移行は別の条件であり、永続失効集合が `B_anchor` に収まらない場合は拒否情報を保持して移行を保留する。
追加枠を永久失効集合の通常上限の拡張に使わず、新規受付とwriterの停止を維持する。
ENOSPCでは旧詳細を保持して停止し、先に本文を削除しない。

## 実装前の検証条件

段階2では自動回収を接続せず、拒否情報と移行のfixtureを確認する。
満杯の旧形式、Unicodeの最大escape、revision上限、保存境界のクラッシュ、新旧ファイルの混在、アンカーの欠落と取り違えを試験する。
件数満杯の移行成功と新規受付再開を分け、墓標で件数枠が満杯なら受付停止を維持する。
稼働を続ける同一native thread/sessionでも再登録が旧periodを維持する場合は拒否し、trusted registrationが新periodを発行した場合だけ受付できることを確認する。
再起動しただけで新periodが得られるとは仮定しない。
同periodのactorやgeneration変更、新trusted period、旧ID再利用、質問と通常指示が同じcheckpointを使う場合の停止範囲も確認する。
7日保持中の容量不足と、初回移行時刻の再起動後の不変を確認する。
これらのfixtureを実runtimeの成功として扱わない。
