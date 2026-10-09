# 質問と配信記録の容量回収計画 (#209)

## この計画の位置づけ

この文書は容量回収の契約と段階ごとの実装順序を定める。
実装と検証の現在地は[Codex対応の引き継ぎ](../handover/codex-support.md)で管理する。
#283 の方式Aにより、再起動前の質問は隔離され、回答と再送が拒否される。
隔離では容量が戻らないため、拒否情報を保持したまま記録を小さくする仕組みを追加する。
実 runtime の適合確認と、#216 の設定画面および標準起動への接続は未完了である。

## 旧保存形式の制約

質問の kernel は質問詳細だけを持ち、未選択質問の common key を拒否する独立した記録を持たない。
配信 ledger は logical tombstone と配信詳細の論理 key 集合が一致することを要求する。
質問 service は、対応する質問詳細が無い配信を孤立記録として拒否する。
このまま詳細だけを削除すると、再登録を許すか、復旧時の整合性検査に失敗する。

保存の置換はファイルごとに行う。
質問 journal と配信 checkpoint の同時 commit、および電源断時の fsync 保証は現行方式では得られない。
回収では途中状態を正規の schema で表し、復旧時に同じ回収操作を続ける必要がある。

## 保持する拒否情報

**墓標**は、本文を持たず、同じ記録の再登録と再送を拒否する永続記録である。
質問の墓標には、common key、内部質問 ID、内容 digest、固定された実行と配信の相関、回収理由、配信状態、終端結果の種別を保持する。
未選択質問にも墓標を作り、同じ key の同じ内容も再登録しない。
実行相関と digest の検査は、詳細の回収後も省略しない。

配信側は、詳細を伴う墓標と回収済みの墓標を区別する version 付き schema を導入する。
既存の集合一致検査を単に外さず、回収済みの記録でも attempt ID の再利用と相関の不一致を拒否する。
質問側と配信側の対応が欠落した状態は、回収成功に読み替えない。

確定終端の本文は既定で7日保持する。
再送を防ぐ墓標は7日で消さない。
`sending` と `unknown` は経過時間だけで成功、未送信、回収可能な終端へ変えない。
本文の圧縮と配信結果の確定は別の操作として扱う。
方式Aで隔離した質問の unknown を圧縮する場合は、`deliveryState: unknown`、`terminalResultKind: null`、再送禁止、後着通知による更新禁止を保存する。
`sending` と `accepted` は既存の復旧契約に従って unknown にする。
確定終端の墓標は結果の種別を返せるが、本文と回答内容は返さず、同内容の再登録も拒否する。
方式Aの後着更新禁止を通常指示や PR 通知へ広げず、それらの既存の遅延通知の受付契約を保持する。

## 回収操作と途中からの復旧

回収対象の変更と送信開始を直列化したうえで、次の順で保存する。

1. 質問側に拒否情報、回収操作 ID、対象相関を保存する。
2. 配信 checkpoint を、拒否情報を保持した回収済み形式へ移す。
3. 質問の詳細を削除し、同じ atomic 更新で質問の墓標を残す。

| 質問側 | 配信側 | 復旧の扱い |
|---|---|---|
| 回収準備と詳細 | 詳細と従来の墓標 | 同じ操作 ID で checkpoint の回収を続ける |
| 回収準備と詳細 | 回収済み墓標 | 質問詳細の回収を続ける |
| 回収済み墓標 | 回収済み墓標 | 完了済みとして再送を拒否する |
| 回収準備または回収済み墓標 | 配信未作成の証拠があり、配信なし | 未選択質問または配信を作成していない質問として、配信を新規作成せず質問側の回収だけを続ける |
| 回収準備または回収済み墓標 | 作成有無が不明で、配信なし | indeterminateの拒否情報を保存し、新作成と再送を禁止したまま隔離質問の本文を回収する |
| 回収済み墓標 | 配信詳細 | 保存順序上あり得ない組として隔離し、送信、再登録、回収継続を拒否する |
| 回収準備も墓標も無い通常の質問 | 回収済み墓標 | 保存順序上あり得ない組として隔離し、送信、再登録、回収継続を拒否する |
| 作成済みと確認した必要記録の欠落、相関や digest の不一致 | 任意 | 対象を隔離し、送信、再登録、回収継続を拒否する |

回収済みの質問は、availableまたはunknownのまま本文圧縮済みか、結果種別を持つ確定終端かを schema で区別する。
永久失効した質問のavailableは送信権限を表さず、墓標であることを先に検査してclaim、sendStart、後着更新を拒否する。
圧縮によって取消、成功、未送信確定を生成しない。
配信未作成の正常な記録と、作成済み配信の欠落を同じ扱いにしない。
回収準備の配信期待は `none`、`checkpoint`、`indeterminate` として固定し、`none` の証拠がある記録だけ配信なしを正常として扱う。
旧形式の選択済みintentだけでは配信未作成を証明できないため、対応checkpointが無ければ `indeterminate` として新作成と再送を拒否する。
新形式では配信作成の段階を永続化し、作成中に停止した場合も成功を推定しない。

保存結果が不明な場合は関係する writer の書き込みを停止する。
再起動後も記録された操作 ID を使い、新しい配信を作らず冪等に回収を続ける。
上の手順は質問に関連する配信が対象である。
通常指示は instruction journal の意図と復旧情報が、回収後の ledger から配信を再生成しない契約を段階1で定める。
PR 通知は alias、宛先履歴、論理墓標からの参照を同じ段階で整理する。
通常指示と PR 通知にも、拒否情報を先に保存する順序と途中状態を定義してから段階3で回収を実装する。

## 容量予約と診断

予約量には、まだ増え得る状態遷移の最大量、墓標、回収準備、相関、revision の増加、移行中の重複保持を含める。
進行中の操作を確定する容量を優先し、上限に近づいたら新規受付を抑える。
件数、使用量、予約量、残量、回収待ち件数と失効世代数を診断に出す。
満杯の旧 schema から移行するため、通常受付に流用できない移行専用の予約枠を別に確保する。
移行枠の上界式と証明条件を段階1で定める。
段階2では旧schemaのbyte、件数、field制約を同時に満たす入力を実serializerで測り、拒否情報、操作情報、隔離時刻、重複保持に必要な固定byte上限を確定して検証する。
新規受付を止め、専用枠で移行 intent を永続化し、新 schema の拒否情報を保存して検査してから旧本文を削る。
起動時は通常 journal より先に intent を読み、操作 ID の不一致や破損では移行を進めない。
移行中と記録された intent が欠落した場合も、通常受付へ戻さない。
正常完了の commit を確認するまで intent を削除しない。
旧形式の通常上限が満杯でも移行枠を使って脱出できることを段階2で検証する。
個別墓標にも最大 byte 数と件数の上限を設け、世代集約が未実装の段階では上限で新規受付を止める。
論理 byte の上限は、ディスク容量不足時の保存成功を保証しない。
一時ファイルと旧ファイルが同時に存在する書き込みについても、故障時に拒否情報を失わないことを検証する。
ディスク不足時は旧詳細を保持して移行を止める。
intent の追加による保証は、プロセスクラッシュ後の整合性に限定する。
電源断も保証対象にする場合は、拒否情報の flush と保存順序の保証を別途設計する。

## 世代の集約

**永続失効世代**は、特定の実行期間に属する記録を今後受け付けないことを保存した記録である。
個別墓標を消せるのは、同じ拒否を包含する世代の失効が保存され、登録、配信、後着通知、復旧の全入口で旧世代を拒否できる場合だけである。
文字列の period ID に大小関係を仮定した watermark は使わない。
最初は厳密な失効世代集合を上限付きで保持し、上限では新規受付を止める。
失効世代をさらに集約するには、永続的な単調世代の導入を別途設計する。
通常の再起動と後着通知に対する拒否は試験対象とするが、全保存ファイルを失効以前へ巻き戻す操作まで防ぐ保証は含めない。
失効の契機は、方式Aの再起動時に旧質問を隔離する時点、または対象期間の停止と恒久的な切り離しを証拠で確認した時点とする。
再起動時の隔離では、同じ期間全体の共通質問を失効させる。

### 質問世代の拒否包含の分析

段階4の入口では、整合したanchorと三つのstoreのsnapshotから、失効periodで包含できる質問の拒否と残存する拒否義務を分析する。
完全identityとperiodを失効集合へ照合し、別provider、host、home、native IDと別periodへ失効を広げない。
形式移行中のsnapshotや不明な質問の二候補は分析対象にしない。
既存のcreation状態とcheckpoint cacheの三つの照合理由は許容するが、退役などの修復が必要なsnapshotは拒否する。
許容した場合も、修復した保存候補ではなく正規化した元のsnapshotを分析する。

同じ共通質問keyの再登録と旧periodの送信と後着更新は、periodを失効した拒否の対象になる。
一方、deliveryAttemptIdとinternalQuestionIdの全体での再利用拒否、配信結果の照会、store間の相関検査は別の義務として保持する。
別periodの質問や通常指示で旧attempt IDを再利用できないことは、旧質問periodの失効だけでは説明できない。
PR通知のtargetに対する論理keyの拒否も、sourceの質問periodへ置き換えない。

この分析は保存候補や削除許可、受付再開の許可を返さない。
本文を回収した記録についても、拒否を包含した分析結果だけで個別墓標を削除しない。
個別件数枠の解放には、残存する拒否索引と結果照会、相関検査の保存契約を確定してから、保存順序とcold復旧を別途実装する必要がある。

| ID | 期待条件 |
|---|---|
| QRC01 | 既存creation/cacheの三理由以外の不正や必要な修復をnot-coveredとして隠さない |
| QRC02 | 同じ完全identityと失効periodの複数質問を包含し、別identityとperiodを拒否対象へ広げない |
| QRC03 | retainedとreclaimedの本文状態を区別し、未作成のattemptの拒否義務を捏造しない |
| QRC04 | 旧attemptを別kindや別periodで再利用した反例から、global attempt拒否を残す |
| QRC05 | 通常指示とPR通知とresultの拒否を質問世代の包含として扱わない |
| QRC06 | 既存gateとledgerを独立したoracleにし、期待値を新分析APIで生成しない |
| QRC07 | immutableな分析情報だけを返し、保存、墓標削除、受付再開と新authorityを接続しない |

### 墓標の共有表現と復元の実験

個別墓標の集約に先立ち、失効質問periodの記録を共有表現へ移し、元の観測値を復元できるかを検証する。
対象は完全identityとperiodが失効集合にあり、質問本文の回収が完了したsnapshotに限定する。
この実験は補修候補を必要としないreadyなsnapshotだけを受け取り、拒否包含分析で許容したcreation状態やcache照合も対象から外す。
未完了の対象があれば候補を生成しない。
配信記録がある場合は既存のquestion graveを対象にし、配信詳細を実験の都合で回収しない。

共有するのは質問のidentityとperiod、および完全に一致する配信墓標のsourceRefとtargetRefである。
残る項目はすべて保持し、単なるdigestへ置き換えない。
状態照会で返す墓標、internalQuestionIdとattempt IDの全体重複拒否、論理keyと相関の情報を復元の比較対象にする。
internalQuestionIdの保持は元記録の完全一致とStoreWriteの一意性検査で間接的に確認し、同じIDの再登録をruntimeで直接試す検証とは区別する。
CPが無いintentから配信墓標は生成せず、未選択とindeterminateの区別、lookupのnullを保持する。

復元は元の整合済みsnapshotと候補を同時に受け取るpure実験に限定する。
共有参照を展開し、元の対象記録とのcanonicalな完全一致と既存StoreWrite検査を要求する。
候補は作成時のsnapshotに拘束するtokenではなく、展開時に渡したsnapshotとの一致を検証するデータである。
対象外の記録、順序、revisionとgrantは元の値を保つ。
返すのは復元した対象記録と比較結果だけで、保存snapshotや削除許可は返さない。
この一致を、元snapshotなしで動く永続decoderの安全性証明として流用しない。

byte比較は同じcompact JSONのUTF-8で測り、候補の辞書とwrapperも含める。
全snapshot、対象記録、候補のサイズを区別し、候補の方が大きい場合も測定結果として扱う。
対象記録の比較側には元recordを保持するarrayのwrapperだけを置き、追加のformat名や重複したidentityを含めない。
元snapshotと候補と展開コピーが同時に存在するため、この実験はメモリー節約や永続容量の削減を実現しない。
件数枠、将来予約、grantの解放と移行時の容量保証は別の証明を必要とする。

| ID | 期待条件 |
|---|---|
| QGP01 | 完全snapshot検査と対象の失効、本文回収完了を前提にする |
| QGP02 | 元の合法記録をoracleにし、全観測項目をlosslessに往復する |
| QGP03 | CPなしのlookup nullと未選択またはindeterminateの区別を保持する |
| QGP04 | 既存runtimeとgateで重複拒否と新規IDまたは別periodの対照を確認する |
| QGP05 | 候補の欠落、未知field、重複、参照差替えと範囲外索引を、元snapshotから作り直した候補との完全一致検査で拒否する。単独decoderの索引検査の証拠にはしない |
| QGP06 | 入力を変更または凍結せず、返却を深く凍結する |
| QGP07 | serialized byte比較と実保存、件数枠、メモリーの削減を区別する |

合法fixtureでは、対象質問5件、配信墓標3件、CPなしintent1件、未選択1件、論理墓標3件を使い、sourceとtargetの辞書は2項目になった。
available、unknown、cancelled_before_sendの照会値を含めて往復を確認した。
commit `3937095` のfixtureを同じcompact JSONで測定したサイズは次のとおりである。

| provider | 対象record (byte) | 候補 (byte) | 差 (byte) | 全snapshot (byte) |
|---|---:|---:|---:|---:|
| Claude | 11,087 | 8,917 | 2,170 | 20,674 |
| Codex | 11,043 | 8,905 | 2,138 | 20,530 |

短い識別子と同じsourceおよびtargetを使ったfixtureの測定であり、合法最大の上界や一般の圧縮率ではない。
全snapshotは元の値を測定したもので、候補への永続置換は行っていない。
最大field、参照が全固有の場合、複数capsuleと移行時の重複保持は後続で測定する。

### 単体recordの検査と上界

元snapshotとの往復実験に続き、回収済みの質問reservationと配信graveの局所相関を単独で検査する入口を用意する。
`normalizeReclaimedQuestionPair`は、既存のrecord単位normalizerと相関検査、隔離後と終端後の7日保持の検査を再利用する。
配信ありでは同じattempt、logical key、完全参照、digest、状態と本文回収操作を要求し、配信なしではnoneとindeterminateを区別する。
返すのは正規化した記録だけで、anchorの永久失効、checkpoint全体からの不存在、全記録のID一意性や削除許可は認定しない。
論理墓標の単体normalizerも公開し、既存ledger全体の件数枠を単体recordの合否へ流用しない。
既存snapshotの検査分岐と受理上限は保つ。
不正な入力はTypeErrorで拒否し、messageは既存record normalizerとsnapshot整合検査の分類を引き継ぐ。
後続capsuleの入口ではこれらを一括して不正入力として扱い、局所例外のmessageから保存や復旧の許可を決めない。

| ID | 期待条件 |
|---|---|
| QRP01 | 両providerの回収済みavailable、unknownと各確定終端を状態を変えずに正規化する |
| QRP02 | 未選択と選択済みのnone、indeterminateを区別し、CPなしから配信を生成しない |
| QRP03 | 単体codecが受理する記録でも、attempt、参照、digest、session、状態と本文回収操作の不一致をpairで拒否する |
| QRP04 | 隔離後と終端後の7日保持の各境界を検査し、未回収または準備中の予約は受理しない |
| QRP05 | getterとProxyのtrapを実行せず、循環、過深入力、不正な配列と非JSON値を拒否する |
| QRP06 | 呼び出し元の記録を変更または凍結せず、局所検査と全snapshotの証拠範囲を分ける |
| QRP07 | 最大長候補の実測とnullable branchを含む保守的な構造上界を区別する |

回収済みrecordには質問本文がなく、残る識別子、digest、UUIDと整数には有限の上限がある。
識別子は最大512 UTF-16 code unitで、JSON文字列の安全側の上界は引用符を含めて`6 × 512 + 2` byteとする。
合法fixtureのserializer実測と、fieldの型から導く解析上界を区別する。
最大長だけを各fieldへ代入すると相関や保持期限を壊すため、状態と時刻の整合も既存の検査で確認する。

保守的な構造上界には、質問のintentとexternal resolution、配信のacceptedとapplied correlationをすべて非nullで含むfield treeを用いる。
各文字列にはenum、digestとUUIDも含めて3,074 byteを割り当て、安全な非負整数には16桁、booleanには5 byte、nullには4 byteを割り当てる。
固定のproperty名、comma、indentと末尾LFを別に数える。
この2-space pretty JSONの上界は、質問reservation一件が90,224 byte、question grave一件が161,394 byteとなる。
相関条件を外して最大のbranchを組み合わせた上側の境界であり、この量を持つ合法な一件が存在するという主張ではない。
CPのowner targetと質問本文は対象外で、nullableな小さいbranchは同じfield tree以下に収まることを試験する。
単体normalizerを通した大きなQとCPの測定入力は別々の記録で、同じpairや完全snapshotの合法性を測定結果から推論しない。
正式capsuleのwrapper、辞書、配列indentと索引の桁数を含めた総量は、後続codecで独立に計算する。

後続の単体capsule形式では、件数とserialized byteの固定上限を独立に検査する。
byteが先に上限へ達する場合も拒否し、件数上限までの任意の合法recordを収容する契約にはしない。
各配信はsourceとtargetを一つずつ参照するため、それぞれの参照辞書の件数は配信件数以下に制限できる。
この上限は単体形式の資源政策であり、通常slotの予算やgrantを増やす許可にはならない。
全capsuleと通常記録の合計、移行時の重複保持と保存用一時ファイルは、別の容量検査を必要とする。

### 単体質問capsuleと選択ペアの検査

質問capsuleは、回収済みreservationの完全identityとperiodをwrapperに移し、残るfieldを各entryに保持する独立形式である。
配信capsuleは、回収済みquestion graveの完全なsourceとtarget参照をファイル内辞書へ移し、各entryから索引で参照する。
展開結果は既存のreservationとgraveの形へ戻す。
論理墓標は配信capsuleへ移さず、checkpoint全体の正本に残す。
このcodecは元snapshotを入力にせず、capsule自身のfieldと展開した単体recordを検査する。

両wrapperは形式版1、圧縮操作のUUID、store UUID、完全identityとperiodを持つ。
圧縮操作はwrapperの対応を識別し、各recordに残る本文回収操作を置き換えない。
質問entryはinternalQuestionId、配信entryはdeliveryAttemptIdのordinal昇順で一意に並べる。
入力の配列を並べ替えて補修せず、objectのfield挿入順だけを正規化する。
参照辞書はroleごとの初出順とし、同値参照の重複、未使用参照、不正索引を拒否する。

形式の受理上限は、質問と配信それぞれ最大256件、各ファイルの2-space pretty JSONと末尾改行を合わせて1,048,576 byteである。
配信capsuleがある場合は両形式とも1件以上とし、質問がすべてnoneまたはindeterminateなら配信capsuleをnullで渡す。
件数とbyteは独立して検査するため、最大長recordを256件収容できるという保証にはしない。
参照辞書は各roleとも配信entry数以下に制限する。
bytes decoderはJSONの解析前にraw byte上限を照合し、正規化後にも同じ実encoderの出力上限を照合する。
JSONの重複keyは既存parserに従って最後の値を採用し、解析結果をexact schemaで検査する。

単一entryの保守上界は、単体recordの最大構造をcapsuleへ写像し、全wrapper、完全参照辞書、索引、追加indentと末尾改行を含めて計算する。
可変文字列は512 UTF-16 code unitsのescape上界、数値は最大桁を使い、nullableな枝も構造へ含める。
この構造解析による上界はQ 96,657 byte、CP 186,690 byteで、各1 MiB以内である。
到達可能な最大値とは区別し、合法な最大長候補のencode成功と実byte境界を別の試験で確認する。

選択ペアの検査は、両wrapperのstore、圧縮操作、identityとperiodを照合し、checkpoint presenceの質問と配信graveを一対一で対応させる。
各組は単体recordの相関検査を使い、noneとindeterminateに配信を補わない。
呼出し元は、選択したgraveに必要な論理墓標だけを最大256 groupで渡す。
groupは既存のlogical tuple（kind、sourceExecutionId、logicalMessageId、revision、targetLaunchKey）で識別し、sourceLaunchKeyとpayload digestを値として照合する。
同じgroup、sourceLaunchKeyとdigestのgraveは一つの墓標を共有し、欠落、余剰、重複、値の矛盾を拒否する。
同groupでsuperseded_before_send以外のgraveは最大1件とする。
選択墓標は保存されないcontextの集合なので、入力の並び順を要求しない。
この入力が実checkpoint全体の正しい部分集合であることは、後続の全体検査で確認する。
返却の`scopeLimitations`は、アンカー退役、全体ID一意性、contextの正しい部分集合、全体logical集合、合計容量、永続化復旧、配信履歴とnative相関の再利用が未検証であることを固定の項目で示す。

plain-data検査はprimitiveと共有参照の各出現を含めて訪問数を数え、新入口では100,000回までに制限する。
256件のQとCP、各role256固有参照、256論理group、非nullのaccepted/applied相関とexternalResolutionを含む最大ノード構造のpairは31,517訪問で収まる。
nullableなscalarはnullでも他の値でも一訪問と数え、questionで非nullにできないfieldはnullのままとする。
既存の三引数入口は既定1,000,000回とし、Proxyとgetterを実行せず、循環と過深入力を拒否する。
この予算は再帰走査を制限するもので、巨大objectのown key列挙や、入力済み文字列の保持まで含むCPUとメモリーの上限ではない。
選択論理墓標はファイルではないため、ファイル用1 MiB上限は適用せず、件数、各fieldの既存上限、訪問予算で検査する。

| ID | 確かめる条件 |
|---|---|
| QCC01 | 両providerで元recordの全observableを展開後も保持し、元snapshotなしにdecodeする |
| QCC02 | 配列順、entry識別子、参照辞書の初出順と一意性、不正索引を検査する |
| QCC03 | wrapperと本文回収操作の相関、pairで各保持期限、noneとindeterminateを検査する |
| QCC04 | 任意順の選択墓標に必要groupの閉包を要求し、同groupの異なる値と複数の非superseded記録を拒否する |
| QCC05 | 実encoderのbyte境界と件数境界を独立に検査する |
| QCC06 | getterとProxyを実行せず、共有参照の反復も訪問予算へ含める |
| QCC07 | caller入力を変更または凍結せず、局所検査の成功から削除権限を発行しない |

保存接続では、通常recordと全capsule間の一意性、全履歴、native item相関の再利用拒否、対象外も含む論理墓標の整合、全容量と一時保存ピークを検査する。
capsuleのattempt順は元ledgerの履歴順を表さないため、後続outer形式で元の順序を保存する方法を決め、superseded履歴の検査を行う。
旧readerが新outer版を拒否する条件、保存途中の故障とcold復旧、アンカーの退役証拠、件数枠の解放も別のgateとして残す。
単体codecと選択ペアの成功を、これらの全体条件の成立へ読み替えない。
単体codecは局所schemaを検査し、隔離後と確定終端後の保持期限は選択ペアから既存のrecord相関検査へ委ねる。
公開pair入口は不正入力を一つのTypeErrorへ統一し、意図したcapsule byte超過だけをRangeErrorで返す。
いずれの例外messageも保存や回復の許可を表さない。

### 永続集約への条件

復元実験の後は、codecと相関検査、移行plannerと容量上界、ファイル間の保存とcold復旧、件数枠と診断を分けて実装する。
元snapshotを必要としないdecoderには、正規field、索引範囲、重複、参照、状態、digestと操作の対応の独立検査が要る。
通常記録と集約記録をまたぐIDの重複と、論理墓標のgroup集合の一致も検査する。
新しい外側schemaを導入したときは、旧readerが明示的に拒否することを確かめる。

最初の移行対象は、質問とcheckpointのgrantが解除済みで、形式移行、退役の修復、本文回収準備とwriterの停止がないsnapshotに限定する。
非対象slotのgrantを移行予算へ流用しない。
対象外記録と論理groupを共有する記録は、初版の集約から除外する。
全groupの移転と拒否情報の保持を証明するまでは、論理墓標を削除しない。

拒否証拠と全対象を質問側の準備記録へ先に保存し、checkpointの移転、質問側の完了の順に進める。
各途中状態を正規形式として表し、coldで同じ操作だけを継続する。
操作や参照の不一致、必要な証拠の欠落、保存結果不明では再作成せず停止する。
独立索引のbyteと件数にも上限を置き、満杯では新規受付を停止する。
旧記録と準備情報の重複保持、atomic更新の一時ファイルと将来増分を含め、移行時の容量上界を実serializerで確認してから保存へ接続する。
実験候補のサイズだけをこの上界に採用しない。

## 採用した回収条件

| 判断 | 採用内容 | 比較した別案と影響 |
|---|---|---|
| 永久失効する範囲 | 完全 identity と period ID で特定した期間の共通質問だけを失効させる。通常指示には広げない | 個別質問の墓標だけを保持すれば同じ期間の新しい質問を受け付けられるが、世代への集約で容量を減らせない。方式Aは保存済み質問の隔離なので、期間全体の拒否は追加の判断となる |
| 隔離した非終端記録の本文保持期間 | 永続化した隔離時刻から既定7日とし、拒否情報を保存できた記録は unknown も本文を圧縮する。unknown は結果不明のまま再送と後着更新を拒否する。隔離時刻が無い既存記録は新 schema への移行時刻を起算点として一度だけ保存する | 無期限保持では調査材料を残せるが、本文と予約量による容量圧迫が続く。移行直後の期限切れ扱いでは既存の調査材料をすぐ失う |

この2点は開発者が承認済みで、[実装計画の決定済みの判断](codex-implementation-plan.md)に記録する。
自動回収と世代全体の拒否は、以下の段階的な実装と検証に従って導入する。

段階1の具体形式は[質問schema](common-question-reclamation-schema.md)、[配信schema](delivery-reclamation-schema.md)、[永久失効と移行アンカー](question-reclamation-anchor.md)に定める。
局所codec、純粋な旧形式投影、store間照合と容量計算を独立した入口として実装している。
保存境界の故障注入と実runtimeの確認は後続で行う。

## 段階的な実装と完了条件

| 段階 | 作業 | 完了条件 |
|---|---|---|
| 1 | 全配信 kind の回収 schema、互換移行、拒否範囲、保持期間、途中状態と保存順序の契約 | 上の判断を確定する。配信期待の固定と未作成の証拠、通常指示の journal と ledger の整合、PR 通知の参照、移行枠と墓標の容量式、失効の契機を定義する |
| 2 | 独立墓標、予約、旧 schema 移行、全入口での再利用拒否 | 自動回収を無効にしたまま、未選択質問、同内容、ID 再利用、最大容量を確認する。満杯の旧形式を拒否情報を失わず移行でき、件数枠が満杯なら受付停止を維持する試験に合格する |
| 3 | 確定終端、隔離質問、通常指示、PR 通知の回収 | 各保存境界の故障注入と再起動を両 provider の fixture で確認する。保存順序上不可能な2組を隔離し、配信未作成の正常経路も確認する。unknown と後着通知が再送を起こさない |
| 4 | 世代失効と集約、残るメモリー台帳と claim の回収 | 拒否範囲を保ち、#206 の履歴と claim を含めた容量回収を確認する。個別墓標の件数枠を解放し、通常指示、PR通知、resultのunknownが占有し続ける枠の扱いも確定する |

各段階は通常のスタック式 PR とクロスレビューで進める。
fixture の合格を実 runtime の適合確認と区別する。
#209 全体の容量回収条件を満たした後に、#216 の設定画面と標準起動への接続を判断する。

### 段階2のPR分割

既存形式を既定で維持し、自動回収を無効にしたまま次の順で接続する。
新形式へ書き換えた保存先を旧writerへ戻すfallbackは設けない。

| 順序 | 範囲 | 完了条件 |
|---|---|---|
| 1 | 新schemaの検証、変換、容量計算を独立した入口に追加 | 既存readerとwriterの既定形式を変えず、旧形式、最大長、不正相関、独立墓標のfixtureを確認 |
| 2 | アンカーstore、移行coordinator、専用枠 | テスト用compositionでwriter停止と各保存境界のクラッシュを確認。製品起動から呼ばない |
| 3 | 質問gate、serviceとdelivery storeの新形式対応 | アンカー対応compositionで旧periodの拒否、新periodの受付、全送信入口のguardを両providerのfixtureで確認 |
| 4 | 明示的なnative factoryへの移行と稼働の統合 | 満杯の旧形式でも拒否情報を失わず移行し、件数枠が満杯なら新規受付停止を維持する。余裕のある旧形式では再起動後の新質問受付を確認。標準起動と設定画面には接続しない |

### 新schema入口の内部分割

段階2のPR1は、共通基盤を先に固定してから次の順で積む。
各codecは他codecを直接importせず、上位の照合層で組み合わせる。

| 順序 | 範囲 | 完了条件 |
|---|---|---|
| 1a | strict helper、UTF-8 byteと指紋、容量算術 | getter、未知field、疎配列、不正UTF-8、escape、整数overflowを確認。既存readerとwriterへ接続しない |
| 1b | 質問journal v2とreservationのcodec | detail、墓標、準備の正確なfield集合と局所不変条件を確認。保存接続と外部照合は1d以降 |
| 1c | ledger v2、checkpoint v3、instruction journal v2のcodec | variant、終端時刻、指示準備、本文なし形式を確認 |
| 1d | アンカーcodec、store間照合、旧形式の投影、grantと固定H/T | 保存境界、不正相関、最大容量のpure fixtureと解析的上界を確認 |

1aは元byteの指紋と正規化後のbyteの指紋を別に返し、schema固有のdigestの代わりにしない。
正規化serializerはrootの深さを0とし、objectのfieldとarrayの要素へ降りるたびに1増やす。
深さ64を超える入力は不正形式として拒否し、後続codecの最大合法shapeがこの範囲内に収まることをfixtureで確認する。
元byteの解析は既存readerと同じJSON.parseを使い、重複keyは後に書かれた値を採用する。
保存先へ書く前の最終容量検査と移行coordinatorはPR2で実装する。
固定H/Tの数値は新shapeとserializerが揃う1dで確定し、最大fixtureだけを任意入力の容量証明として扱わない。
1aだけで新schema対応や段階2を完了扱いにしない。

本文回収の実行は段階3以降に残す。
段階2と3では個別墓標が件数枠を消費し続けるため、満杯からの移行成功は新規受付の再開を保証しない。
件数枠の回収と継続受付は段階4で確認し、#209を先行部分だけで完了扱いにしない。

### 段階3のPR分割

質問と通常指示はそれぞれのjournalに準備を保存するため、配信種別ごとに保存順序と復旧を検証してから自動実行を接続する。
マージ可能になったPRを通知した後も、レビュー済みheadから後続ブランチを積む。
開発者が下から通常mergeで取り込み、未マージの親を持つPRは親ブランチをbaseにする。

| 順序 | 範囲 | 完了条件 |
|---|---|---|
| 1 | 隔離質問の本文回収 | 明示factoryで退役済み期間を指定して実行し、質問準備、配信墓標、質問詳細削除の3保存境界と、準備済み操作の起動時再開を両providerのfixtureで確認する |
| 2 | 通常指示の確定終端回収 | instruction準備、checkpoint墓標、envelope削除を同じ操作IDで進め、unknownの保持と有効な後着通知を確認する |
| 3 | PR通知とresultの確定終端回収 | checkpoint内の本文と拒否情報を1回のatomic保存で墓標へ置き換え、alias、履歴、保存済みowner、logical tombstoneを保持し、再利用と再送を拒否する |
| 4 | 自動実行、追加枠の解放、停止範囲の分離 | 時計逆行、close、各writerとの競合を確認し、通常枠で完結するgrantを解放する。質問単独の保存結果不明で他kindを継続できる境界を実装し、横断検証する |

保存結果不明時は原則として全writerを止め、再起動による照合まで本文削除や配信を続けない。
例外は、下記の限定した標準質問rename故障を二通りのsnapshotへ絞れる場合である。
質問の公開状態を不明とし、旧状態と候補状態の両方で有効な非質問の更新だけを継続する。
共有checkpoint、anchor、清掃結果不明と一般のreadback故障は全停止を維持する。
明示回収だけでは段階3を完了扱いにせず、標準起動と設定画面への接続、実runtime確認も別に残す。

本文回収後の範囲は、次の順で分けて検証する。

| 順序 | 範囲 | 完了条件 |
|---|---|---|
| 4a | 明示的なgrant解放 | 対象slotの全将来予約が通常枠に収まる場合だけgrant全体をatomic保存で解除し、readback後に同じleaseの予約を縮小する |
| 4b | 質問journalの結果不明時の局所停止 | 失敗保存の旧snapshotと候補snapshotを保持し、双方で整合する通常指示・PR通知・resultの更新だけを継続する。共有checkpointの結果不明は全停止する |
| 4c | 自動実行 | 明示構成でopt-inし、single-flightの期限再判定、手動操作との競合、close時のdrain、局所停止下の継続とgrant解放を確認する |

grant解放は現在のfile byteだけで判定せず、固定相関の補完を含む全将来予約を通常枠と照合する。
明示入口と停止・保存の契約は[配信回収schema](delivery-reclamation-schema.md#migration-grantの明示解放)のGAR01〜GAR06に従う。
質問journalの局所停止では、不確かなsnapshotを正常な保存状態として公開せず、そのslotのgrantと必要leaseを保持する。
候補を限定できない破損、anchorまたは共有容量の障害まで、質問journalの停止分離へ一般化しない。
最初の局所停止は標準atomic writerの限定したrename失敗に絞り、旧状態と候補状態の双方を照合する。
清掃結果不明、readbackと任意writerの失敗は全停止を維持し、anchor、全grantとleaseを凍結する。
詳細は[配信回収schema](delivery-reclamation-schema.md#質問journalの限定した保存結果不明)のQWI01〜QWI06に従う。
自動実行は既存回収入口をqueue内で再判定して使い、unknownの終端化や質問期間の新規失効を行わない。
明示factoryの`autoReclaim`は既定offとし、設定した間隔のone-shot timerで有限な数の回収APIを呼ぶ。
局所停止時は質問と全grant解放を省き、closeでは保存guardを閉じてから実行中処理を待つ。
設定、処理量と故障時の契約は[配信回収schema](delivery-reclamation-schema.md#明示構成の自動回収)のARS01〜ARS06に従う。

### 段階2の固定容量上界

固定上界は旧sourceの実byte列を対象とし、compact JSON、指数表記、重複keyを含めて検査する。
重複keyはJSON.parseで採用された最後の値のtokenだけを容量証明へ割り当て、捨てられたtokenのbyteを無視する。
正規化したJSON文字列の内容byteは、対応する元tokenの内容byte以下である。
引用符、backslash、controlのescapeは同じ長さか短くなり、Unicode escapeはUTF-8 literalへ短縮する場合がある。
単独surrogateは元JSONにもescapeが必要で、UTF-8として不正な元byteは入力検査で拒否する。

移行アンカーへ複製する可変文字列は、質問の内部ID、intentのattemptとlogical ID、完全identityとperiod IDである。
失効periodごとに代表質問を1件選べば、これらを旧questionsの異なるfield出現へ各1回以下で割り当てられる。
したがって、アンカーの係数は `c_questions=1`、`c_checkpoint=c_instructions=0` とする。
実serializerの構造費を次の値で抑え、`T_migration = 34,518,968`、`M = 51,296,184` bytesとする。

| 構造費 | byte上界 |
|---|---:|
| 質問記述子 `Kq` | 608 |
| 失効period記録 `Kp` | 279 |
| 最大3slotを含むwrapper `Kmanifest` | 1,752 |

`T_migration = 16,777,216 + 20,000 × 608 + 20,000 × 279 + 1,752` である。
構造費の測定では可変identifierの内容を空にし、数値を16桁へ、enumを最長へ置く。
この測定用skeletonは合法fixtureではなく、可変文字列以外のbyteを数える道具である。
最大escapeの合法fixtureは別途検証する。

初回の失効集合が通常アンカー枠へ収まることも、旧sourceの制約から求める。
一意なperiod数を `n`、代表質問からコピーするidentityとperiodの文字列内容byte合計を `V` とすると、旧compact構造の下界は `S_questions ≥ 47 + 664n + V` である。
通常アンカーは `A ≤ 163 + 279n + V` と抑えられるため、`n ≥ 1` なら `A ≤ S_questions ≤ B_anchor` となり、空集合なら `A ≤ 163` となる。
下界の測定も、identifierの内容と数値を最小へ緩和した構造解析であり、実際に受理するfixtureとは区別する。

各slotの固定 `H_i` は、`H_i = (a_i − 1)C_i + n_i F_i + W_i` の保守上界を採用する。
`a_i` は旧sourceの構造、既存可変文字列のコピー、compactからprettyへの増加、指数表記から最大16桁への増加を覆う係数である。
scalarの最大深さを `D_i` とすると、旧構造1byteあたりのpretty化を `2D_i + 2` で抑え、`a_i = max(16, 2D_i + 2)` とする。
旧可変文字列の最大コピー数3はこの係数以下である。
新fieldの構造費、別source由来の文字列、将来の相関は `F_i` で別に計上する。
`W_i` はgrantを含むwrapperの構造費である。

| slot | `D_i` | `a_i` | `n_i`上界 | `F_i` | `W_i` | 固定`H_i`（bytes） |
|---|---:|---:|---:|---:|---:|---:|
| questions | 8 | 18 | 20,000 | 4,997 | 461 | 385,153,133 |
| checkpoint | 8 | 18 | `min(20,000, floor(C_checkpoint / 945)) = 17,753` | 32,161 | 600 | 856,167,505 |
| instructions | 7 | 16 | `min(20,000, floor(C_instructions / 819)) = 20,000` | 365 | 441 | 258,958,681 |

checkpointとinstructionの旧record構造の下界945と819を使い、件数とsource byteの制約を同時に適用する。
questionsの `F_i` はcheckpoint由来のsession ID、checkpointの `F_i` は将来のacceptedとapplied correlationの識別子を含む。
これらの新しいidentifierは最大512 UTF-16 code unitsのescape費を計上する。
隔離した旧questionは本文を固定するため、回答とlateAnswersの将来成長を加えない。
異なる合法境界の新規構造費を同時に加える場合は解析上界として扱い、その組を合法snapshotとは呼ばない。

この `H_i` をそのままgrantやload/writeの許容量にはしない。
grantは受理した旧sourceごとに合法な移行、保持、回収のprojectionを測り、既定のsource基準式で発行する。
構造費と固定値は `src/server/reclamation-capacity-bounds.js` の測定と対応fixtureで再現する。

予約量はrecordごとのvariant差分とroot・ledger revisionの最大桁増分を合算する保守的な上界であり、将来snapshot全体を複製しない。
checkpoint単体では質問が退役periodに属するかを判定できないため、未終端の質問deliveryにもapplied相関と終端時刻の将来成長を予約する。
instruction journal単体の予約計算はcheckpointの現在stateを持たないため、終端と準備の構造を保守的に計上する。
instructionの作成前・作成中の状態文字列の成長は、準備期限をsafe integerで表せるかにかかわらず予約する。
呼び出し側が渡す候補は内部候補との最大値に加え、候補の省略で予約量を減らさない。
この予約量は厳密な到達可能最大値や回収許可を表さず、回収操作のstateと時刻はstore間照合で別に検査する。
