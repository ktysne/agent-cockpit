# 質問の永久失効と移行アンカーの保存契約

## 対象と保証範囲

この文書は[容量回収計画](codex-capacity-reclamation.md)で定める保存契約である。
局所codec、旧sourceの純粋な投影、store間照合と容量計算の入口を実装している。
独立した保存層と移行coordinatorをテスト用compositionへ追加し、明示的な依存注入で質問serviceと通常writerを新形式へ接続する。
native factoryと通常起動への接続は後続の範囲である。
質問の永久失効を通常の journal と別の永続アンカーに保存する。
アンカーは本文回収後も残し、質問に限った拒否の根拠とする。
registry の execution を終了させず、通常指示の認可と runtime の稼働状態は変えない。
配信 checkpoint を共有する writer の保存結果が不明な場合は、その writer 全体を止める。

保証するのはプロセスクラッシュ後の復旧、後着通知、同じ識別子の再利用に対する拒否である。
電源断時の flush 保証、全ファイルの過去への巻戻し、移行中の旧 binary への切替は対象外である。
移行中は保存先ごとに排他起動し、アンカーを知らない旧 binary を起動しない。

## 独立した検証入口

`src/server/question-reclamation-anchor-codec.js` はアンカー単体の構造、固定slot、失効key、migration descriptorを検査する。
`src/server/reclamation-migration-projection.js` は旧sourceのraw bytesを検査し、新schemaの局所targetと容量候補を返す。
Local投影はgrantの発行資格やwriterの再開を判定しない。
`src/server/reclamation-migration-plan.js` の `planInitialReclamationMigration` はraw sourceと通常上限から、検査済みsource由来のgrant、固定したtarget指紋、初回の移行計画を生成する。
全slot未作成ではmanifestを持たない空schemaの初期化計画を返し、存在する旧sourceの移行ではprepared manifestを返す。
`src/server/reclamation-store-consistency.js` はアンカーと新schemaのstoreを組み合わせ、相関と保存境界を検査する。
`inspectReclamationMigrationSnapshot` は固定slot順のtarget prefixとsource suffixを照合し、sourceから未設置targetを再構成する。
active manifestはcompletedでも`reconciliation-required`を返し、manifest削除前の稼働を許可しない。
`validateReclamationTransition` は前後snapshotを比較し、準備記録、操作ID、退役質問の状態、grantの不変条件を検査する。
`validateReclamationStoreWrite`は稼働中のstore更新を原形で照合し、creatingや合法なcacheの遅れを冷起動の修復候補へ置き換えない。
期間退役の入力とアンカー更新には対象だけを検査する専用入口を使い、対象外のinstruction journalを修復しない。
ここでの`ready`はschemaと相関の整合を表し、保存済みであることやwriterを再開できることは表さない。

各入口は時刻、UUID、source bytes、通常byte上限を呼び出し元から受け取り、時計、乱数、ファイル保存、registry、runtimeを呼ばない。
これらの純粋な検証入口は、新形式を明示したservice compositionからも使用する。
既存readerとwriterの既定形式、標準起動は変更しない。

## 保存層と移行coordinator

`src/server/reclamation-persistence.js` はcompositionが固定した保存先を所有し、上限付きの実byte読取とatomic置換を行う。
アンカーのbasenameは `question-reclamation-anchor.json` に固定し、dataの保存先は構成したslotの固定mapから取得する。
manifestから保存先を取得せず、重複保存先とsymlinkを拒否する。
保存先のディレクトリはcompositionがあらかじめ作成する。
祖先にsymlinkがある保存先は、compositionがディレクトリをrealpathで解決してから渡す。
同一プロセス内の保存先所有を検査するが、別プロセスをまたぐwriter排他は#313の範囲であり、排他起動を前提とする。
保存対象は検査したbyte列の複製であり、保存時にJSONのキー順や改行を変えない。
書込み失敗後は同じstoreからの再書込みを止め、一時ファイルの清掃で保存済みsourceやtargetを削除しない。
既定のatomic writerはrenameのEPERM／EBUSYだけを50、100、200msの間隔で再試行する。
再試行を使い切った失敗、その他のI/O失敗、rename後の例外は停止対象とする。

`src/server/reclamation-capacity-reservation.js` は論理的な追加byte予算をleaseとして確保する。
予約の拡張に失敗した場合は旧予約を保持し、移行前後の予約を別leaseで二重計上しない。
各atomic置換の実fileと一時fileが同時に存在する量を計算し、その最大値から現在の実占有量を引いた追加量を予約する。
slotのraw byte、正規化したbyte、全将来予約を通常上限と保存grantへ照合し、固定Hを許容量に使わない。
この予算はOSの空き容量や保存成功の保証ではない。

`src/server/reclamation-migration-coordinator.js` の `start` は共有gateを同期で閉じ、全構成writerへ同期stopを適用してからdrainを待つ。
stopの一部が失敗しても残りのwriterを止める。
stopがPromiseを返す場合は全stopの完了を待ち、成功・失敗にかかわらず全writerをdrainする。
アンカーを先に読み、drain後のsourceと固定manifestを照合する。
途中移行は同じoperation ID、起算時刻、sourceとtargetの指紋、grantを使い、固定順のtarget prefixだけを復旧する。
各保存後に再読取と指紋確認を行い、全targetを実ファイルから再検査してcompletedを保存する。
manifestをnullにする前にも、アンカー全体の一致と全targetの指紋を再検査する。
manifestのtarget sizeは読取り前に固定C+H上界を検査し、未検証のサイズを読取上限に使わない。
completed後は旧phaseとpost上界をともに満たす予約を先に確保し、nullの保存成功と再読取を確認してからpost予約へ縮小する。
各writerの再開準備には検証済みの全snapshotを個別に複製して渡し、全準備の成功後に共有gateを開く。
このgateはwriter全体の停止状態を表し、件数枠と通常予約に基づく新規質問の受付許可はservice側のguardで検査する。

I/O、指紋、容量確保、停止、再開準備の失敗ではgateを閉じたままにする。
rename後の例外と再読取の失敗は保存結果不明として扱い、同じinstanceのstartを再試行に使わない。
明示的なcloseで未完了I/Oとdrainを待ち、保存先所有とleaseを解放してから、新instanceで固定保存状態を検査する。
移行coordinator単体は、通常アンカーで再照合が必要な状態を修復せず、writerを止めて診断する。
以下のservice contextが、通常アンカーに対する許可済みの冷起動修復を先に行う。

全slot未作成時の初期化は、dataを固定順に作成してから通常アンカーを最後に保存する。
部分作成後に停止した新schemaとアンカー欠落の組は、初回作成と読み替えず自動復旧を拒否する。
保存済みファイルを削除したり、必須slotへ空schemaを補って再開したりしない。
この制限を含む保存境界のfixtureは[適合試験](provider-conformance-testing.md#旧保存形式の移行と容量予約)で定める。

## 新形式のservice接続と期間gate

`reclamation-service-context.js`が保存層、容量leaseと質問期間gateを共有する。
serviceとwriterは`reclamation: { backend, periodGate }`を明示した場合だけ新形式を使用する。
新形式の保存先を旧readerやwriterで開き直すfallbackは持たない。
contextは全writerをstopして受理済みのローカル処理をdrainし、保存状態を検査してから再開準備を行う。
公開操作はqueue追加前と実行時にbackendの共通稼働gateを検査し、全writerの準備が済むまでは拒否する。
再開準備はqueueやreadyを待たず検証済みsnapshotを直接設置する。
外部native sinkのPromise完了はdrainの対象に含めず、送信開始済みで結果が不明な記録はunknownを保持する。

質問期間gateのkeyは完全identityとperiod IDである。
actor、generation、launchの変更だけでは失効した期間を再開しない。
質問操作はqueue投入前にtokenを取得し、queue実行時、保存直前、native sink直前に同じtokenを検査する。
共有I/O queueで待った保存にも同じtoken検査を渡し、保存層のAPIを呼ぶ直前に同期で再検査する。
保存開始前の失効は無副作用で拒否し、開始済みのatomic I/Oを物理的に取り消す保証は持たない。
失効開始後に新しいtokenを取り直して先行操作を通すことは認めない。
独立reservationと墓標の拒否は、質問詳細の検索や状態検査より先に行う。

live退役はgateを同期で閉じ、質問queue、checkpoint queueの順に対象期間の操作を直列化する。
ロック中は公開queueへ再入せず、専用accessでsnapshotを検査して直接保存する。
アンカーの失効保存と再読取を先に行い、対象質問のcheckpoint、質問journalの順に同じ失効時刻を保存する。
claimedはavailableへ、sendingとacceptedはunknownへ移し、attempt、digest、相関と取消状態を保持する。
対象外の質問と通常指示、PR通知は変更せず、instruction journalのcreating復旧をlive退役へ混ぜない。
checkpointの保存結果が不明なら共通writerを停止し、後着通知で質問の送信権限を復活させない。

冷起動では保存済み質問の全期間を方式Aで失効させる。
既存の失効時刻を保持し、局所形式とstore間照合が許可する修復候補だけを保存する。
正常アンカーの修復と途中移行は分け、途中移行のoperation ID、時刻、grantを再発行しない。
修復と移行は同じleaseをresizeして使い、追加容量を二重に予約しない。

質問journalの配信作成段階とcacheは質問serviceが更新する。
intentをnot_createdで保存し、creatingを保存してからcheckpointを作成する。
成功したcheckpointの完全相関を確認してcheckpointedとcacheを保存する。
checkpointだけが先へ進んだ合法なcacheの遅れは許容し、serviceの観測時、冷起動または退役時に照合する。
creatingで停止し、対応checkpointが無い場合はindeterminateとして新作成を拒否する。
通常指示も自身のserviceが作成段階を保存し、checkpoint writerから別journalを書き換えない。

新規ID、registration、aliasの受付は全candidateの将来予約が通常上限B以内であることを要求する。
新しい質問期間を受け付ける前に、全reservationの期間を失効記録へ移す将来量もアンカーの通常枠へ予約する。
既存の対象記録の遷移だけに固定grant Gを使用し、既存のreservationと墓標を欠落させたりIDを再利用したりしない。
件数上限には本文のある記録と墓標をともに数える。
terminalAtは初めて確定終端になるcheckpoint保存で固定し、後着通知や再起動で更新しない。
この接続は自動回収、本文削除、grant削除を実行しない。

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
局所codecは `sources` の入力順を問わず、`checkpoint`、`instructions`、`questions` の固定順へ正規化する。
途中状態の到達可能性もこの固定順で検査し、`targets` と失効配列の順序は `periodIndex` の参照を保つため維持する。
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
旧sourceが存在するslotの移行target revisionはsource revisionに1を加え、未作成slotは0から始める。
checkpoint内のledger revisionも移行で1を加え、安全な整数で表せない場合はsourceを保持して移行を拒否する。
`sources.sha256` と `targetSha256` は保存する実byte列のdigestである。
質問記述子の `recordDigest` と `commonKeyDigest` は、各schemaで定義した正規化形式のdigestであり、実byte列のdigestと混同しない。
JSONのキー順や改行を変えたファイルを、同じsource fingerprintと読み替えない。

質問記述子は `internalQuestionId`、`commonKeyDigest`、`periodIndex`、`recordDigest`、`deliveryPresence`、`deliveryIntent`、`checkpointState` を持つ。
`recordDigest` は投影後のv2 detailのdigestであり、旧sourceの検査には実byte列のsource fingerprintと旧schemaのvalidatorを使う。
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
2. 受付済みqueue待機操作も含む対象操作を、完了または副作用なしの拒否までdrainし、質問と関連配信のsnapshotを固定する。
3. 失効記録をアンカーに保存し、保存成功を確認する。初回schema移行を伴う場合だけ固定source/targetのmigrationも同じ更新に保存し、通常period退役ではmigration:nullを維持する。
4. 通常period退役では、対象質問のcheckpoint状態を正規化して保存し、質問journalへquarantinedAtと隔離snapshotを保存してから`retired`にする。形式移行は固定manifestの手順を使う。保存失敗や結果不明でもgateを開け直さない。

通常退役の正規化と途中復旧は[質問schema](common-question-reclamation-schema.md)に従い、claimedをavailable、sending/acceptedをunknownへ変更する。
対象質問のattempt、digest、相関、cancel要求を保持し、他kindの状態を変更しない。
gateの世代を捕捉済みの操作は再取得せず、最終sinkの世代検査を守って完了させる。再取得が必要な操作は副作用なしで即時拒否し、queue待機中に無条件で実行しない。
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

容量の記号は次のように区別する。

| 記号 | 意味 |
|---|---|
| `B_i` | 各slotの現在設定の通常byte上限。質問schemaの`N`は`B_questions`の別名 |
| `C_i` | 旧schemaの固定byte最大値。保存grantのsource size検査と固定Hの定義域に使用 |
| `S_i` | 初回移行で固定した旧fileの実byte。現在設定内のsourceだけ移行を開始 |
| `H_i` | 旧schemaの有効入力全体から証明する、sourceとの差分の固定保守上界 |
| `G_i` | 保存grantのmaxExtraBytes。grantなしなら0 |
| `M` | 移行中のアンカー1fileの最大byte。`B_anchor + T_migration` |

アンカー用の移行枠`M`とデータslotの追加枠を通常受付とは別に確保する。
移行枠は通常受付に使えない。
移行専用の追加枠 `T_migration` は、受理可能な旧slotのbyte上限、件数上限、field制約を同時に満たす入力に対する固定上界とする。
必要追加量の上界を `Σ(c_s × C_s) + Qmax × Kq + Pmax × Kp + Kmanifest` で証明し、その右辺を固定枠 `T_migration` とする。
`C_s` は旧slotの許容byte上限、`c_s` は旧文字列の最大複製回数、`Qmax` と `Pmax` は各20,000件の質問と世代の上限である。
`Kq` と `Kp` は追加キー、digest、時刻、区切り、indentの最大byte数、`Kmanifest` は最大3slotの記述子とenvelopeの最大byte数である。
旧文字列をJSON文字列として二重escapeせず、旧文字列の合計byteが `C_s` 以下である制約を使う。
各記述子の独立した最大長を20,000倍した値だけを移行枠の根拠にしない。
係数、固定fieldのbyte数、最終の固定定数は段階2で実serializerに基づいて証明し、最大escapeのfixtureで確認する。
`T_migration` を利用者の自由な設定値にはしない。
移行中のアンカー1ファイルの上限 `M` は `B_anchor + T_migration` とする。
`M` はアンカー1ファイルの上界であり、atomic置換時の既存アンカー `A` と一時ファイル `M` の同時保持は別に計上する。
初回形式移行の全phaseの保守的ピーク上界は`2M + Σ(2S_i + H_i)`とする。
アンカーの現在実byteはphase更新で増えるため、初回の`A`を全phaseの既存file量として固定しない。
初回移行の追加予約上界は `M + Σ(S_i + H_i)` とする。
manifestをnullにした後は、通常設定上限 `B_i` と保存済みgrant `G_i=maxExtraBytes`（nullなら0）を使い、各slotの旧fileと一時fileの上界を `2 × (B_i + G_i)` とする。
アンカーを含む全fileの同時保持について、移行後の保守的ピーク上界は `2B_anchor + Σ(2 × (B_i + G_i))`、追加予約上界は `B_anchor + Σ(B_i + G_i)` とする。
これらは初回移行の式を置き換えるphase別上界であり、初回の予約へ加算しない。
移行後の予約へ切り替える前に必要な容量を確保し、確保できなければ各slotで現在保存済みのsourceまたはtargetと拒否情報を保持してwriterを停止する。
実際の直列atomic置換では、他の保存済みfileの実byteと置換対象の現file実byteに、今回の一時fileのbyte上界を加えた量を各phaseで検査し、その最大値だけを確保する。
既存fileの占有量を追加予約へ二重計上せず、同時に一時fileを保持するphaseを除いてphase別予約を合計しない。
`H` は各ファイルの新schemaへの差分と、保持する旧詳細と拒否情報の重複分の最大byte数とする。
IDの最大長はUTF-16 code unitsであり、JSON escapeによるbyte増加を含める。
512 code unitsの文字列を512 bytesとは数えない。

load/writeの上限は`B_i + G_i`とし、固定`H_i`をそのまま許容量にしない。
grantは移行完了後も保持と回収の既存操作に残し、質問本文は7日を待ってから圧縮する。
初回移行の `startedAt` は各記録の `quarantinedAt` に一度だけ保存し、manifestの完了後も保持起算点として残す。
新形式の記録から保持中の追加枠の使用量を算出し、`migration` の有無で使用可否を決めない。
通常上限を超えるslotには、各schemaの `migrationAllowance` をtarget byte列に保存する。
grantはcoordinatorだけがsource fingerprintを照合して発行し、初回の対象ID集合を固定する。
manifestを `null` にした後もgrantを残し、対象IDの追記、差替え、再利用、複数grantの積み上げを拒否する。
保存された `maxExtraBytes` を固定 `H_i` より大きい値へ読み替えず、grant外の新規記録には追加枠を適用しない。
対象slotのgrantが共に存在する間は同じ移行操作IDを要求するが、追加枠が不要なslotまたは収束後にgrantを消したslotは `null` を許す。
対応する形式移行が完了してanchorの`migration === null`となり、全記録の将来予約が通常枠に収まり、以後も通常枠で既存操作を完結できるときだけ、そのslotのgrant全体をatomicに `null` にできる。
manifestがprepared、guarded、installing、またはcompletedのままなら、通常枠に収まっていてもgrantを消さない。
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
