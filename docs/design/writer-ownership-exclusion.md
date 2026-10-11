# 保存writerのプロセス間排他

## 設計の位置づけ

この文書は#313の参加条件と後続実装の完了条件を定める。
共通所有単位、取得前の保存内容I/O禁止、子writerの権限と自動奪取禁止を設計上採用し、具体的なOS検出とprimitiveは未実装とする。
現行製品はmodule内Mapで同一pathのwriterを拒否するが、別processの更新は直列化できない。
本案だけで#313を完了したとは扱わず、全参加writerの接続と実process試験が必要である。

## 共通の所有単位

協調protocolの排他単位はcanonical source fileに対応するsidecarとする。
factoryはanchorと全configured slotを一つの私有ownerの集合として取得する。
canonical keyは対応条件の範囲で解決するkeyであり、任意OSのfile identityを統一できるとは扱わない。
集合は既存ファイルだけでなく所有期間中に作成し得る保存先を含み、取得後に拡張しない。
各ファイルの取得は順次行い、集合全体を原子的に取得したとは表現しない。
全取得の成功前はsourceのload、fingerprint、migration、temp書込みとprovider起動を禁止する。

standaloneとfactoryで同じ所有単位とcanonical化を使う。
child用capabilityはownerが作る対象file限定のprivate参照とし、公開option、保存済みmetadataとbooleanを取得済み所有や解放権限の根拠にしない。
directoryのroot lockとper-file lockを混在させると、両ownerが競合を認識せず同じ保存先へ書けるため、混在させない。
取得するkeyは固定順に並べ、同一keyの入力重複は取得前に拒否する。

| 参加箇所 | 所有対象 | 解放権限 |
| --- | --- | --- |
| standalone checkpoint | checkpoint保存先 | 自身のprivate ownerがtail終了後に解放 |
| standalone instruction journal | instruction保存先 | 自身のprivate ownerがtail終了後に解放 |
| standalone question journal | question保存先 | 自身のprivate ownerがtail終了後に解放 |
| reclamation persistence | anchorと全configured slot | factoryから管理される最終解放だけ |
| standalone reclamation persistence/context/coordinator | anchorと全configured slot | standalone ownerが実停止とdrain後に解放 |
| reclamation backendと各journal | 対応slotのcapabilityを借用 | source sidecarを再取得せず、最終解放もしない |
| migration、atomic writer、readback | ownerが取得済みの保存先 | owner終了の確認対象で、独立した解放権限を持たない |

参加表はsourceの全入口を照合してから確定する。
公開低層constructor、移行と修復tool、旧versionとの共存も照合対象にする。
接続途中は参加したwriter間だけの部分保証である。
製品全体の排他を必要とする入口は全参加完了まで有効化せず、未参加writerとの共存を保証しない。
新capsule schemaの本番writerと標準modeへの回収接続は、本案の採用だけでは有効にしない。

## 取得と競合拒否

最小候補はNodeのexclusive createを使う即時競合拒否である。
既存の同期返却形式を維持するため、取得だけ同期実行する案を優先する。
競合、権限、親directory未作成など、新しい取得失敗は同期throwとなり、既存callerのtry/catch対応を接続PRで確認する。
対応filesystemを限定し、constructorが成功する前に全取得を終える。
非同期取得を裏で開始した状態でsource I/Oを許可しない。
取得準備に必要なdirectory作成とpath metadata検査は、source内容のloadやfingerprintと区別する。
初版は呼出し側が親directoryを準備済みであることを要求し、取得primitive自身はdirectoryを作成しない。
親未作成は同期拒否する。標準起動のdirectory準備との接続はcallerごとに検証する。

markerが存在すれば、metadataが空、不正、読取り不可でも取得を拒否する。
PID、TTL、host名は所有を奪う根拠にしない。
metadataにはprotocol version、ランダムowner nonceと最小の診断情報だけを置き、秘密値を含めない。
sidecarの名前空間を予約し、その名前を通常sourceとして受け付けない。

## 部分取得と解放

各stepは未作成、exclusive create成功、metadata完了、解放済み、解放不明を区別する。
途中で競合したらsource I/Oを開始せず、その取得試行が作ったmarkerだけを逆順にrollbackする。
create失敗と作成後のmetadata失敗を同じcatchで無条件unlinkしない。
rollback失敗は元の取得失敗とともに記録し、残留所有を無かったことにしない。

releaseはprivate capability内で一度だけ実行し、再呼出しは保存した結果を返す。
成功を確認する前にreleased状態を公開しない。
unlink失敗または結果不明は旧ownerを終端状態にし、自動retryを行わない案を採用候補とする。
結果不明ではmarkerがdiskに残ることまで保証せず、process間の所有保持を確認済みとは報告しない。
unlink前に旧producerとI/Oの終了を確認し、旧ownerからの再書込みと再unlinkを禁止することで新ownerを保護する。
producerの停止を確認できなければunlinkを試みない。
factoryのreleaseはPR #359の全終了確認後にだけ接続する。
public close、子writerと旧ownerから最終解放へ迂回できないことを試験する。

回収ownerの最終解放は容量leaseの解放成功確認、全sidecarのunlink成功確認、module内Map解放の順とする。
standaloneで容量leaseを持たないwriterは、tail終了確認、sidecarのunlink成功確認、対応するMap解放の順とする。
sidecar解放の失敗または結果不明ではMapを保持し、回収factoryのcloseは原因を含む`reclamation_ownership_retained`を返す。
drain確認後は一件のunlink失敗で打ち切らず、残る自己markerも逆順に一度ずつ処理し、全失敗を集約する。
一部sidecarや容量leaseは既に解放され得るため、Map保持を全容量やdisk所有の保持と読み替えない。
旧ownerは終端状態のままとし、再closeによる追加unlinkやMap解放を行わない。

tokenの読取りとunlinkの間に原子的な条件付き削除は無い。
このため、稼働ownerのmarkerを第三者が削除または置換しないことを協調protocolの前提にする。
任意のfilesystem編集に対する排他とは主張しない。

## 対応範囲を決める条件

canonical parentとbasenameだけではhardlinkの別名を統一できない。
sourceのhardlinkを拒否する案を優先し、所有中に第三者がhardlinkを追加しない前提も必要である。
全sidecar取得後、source内容I/O前に既存sourceのnlinkを検査し、複数linkなら当該試行が作ったmarkerをrollbackして拒否する。
未作成sourceにはnlink検査を要求せず、取得後の第三者によるnamespace変更は協調前提の対象外とする。
symlink、junction、短縮名、case-sensitive directory、network mountとWindowsのpath namespaceの扱いは実装前に確定する。
代替stream、末尾のdot/space、device名を含む非対応入力の拒否条件も、製品接続前に確認する。
同じfile identityを共通keyへ解決するか、検出して拒否する手段が実証できない入力は対応済みと扱わない。

| 項目 | 現在の証拠 | 製品接続前の条件 |
| --- | --- | --- |
| 同じsidecarの同時取得 | Windowsの専有fixtureで一勝、一件EEXIST | 製品primitiveと実process barrierで再確認 |
| 正常process終了後のmarker | 同fixtureで残留と再取得拒否 | crashと再起動条件を別に確認 |
| hardlink | nlink2、別名sidecarの両取得という反例 | 対象OSで拒否検出と全入口の一貫性を確認 |
| 旧ownerのrelease再呼出し | probe内の小関数だけで確認 | 製品capabilityで新ownerを消さない試験 |
| OSとfilesystem | win32、Node v24.15.0、別専有fixture一件のvolume照合はC:\のNTFS | 一般pathのfilesystem種別、対応範囲、検出不能時の拒否を確定 |
| aliasとmanual recovery | 助言と反例の整理のみ | path identityと全停止境界を実証 |

追加の専有fixtureでは既存名の大小文字違いと親junction aliasが同じrealpathとdev/inoへ解決された。
未作成basenameの大小文字違いは、一方の作成後に他方のwxがEEXISTとなった。
正常handle closeではmarkerが残り、明示unlink成功後の再取得は成功した。
directoryのcase-sensitive設定、短縮名、networkと全aliasの対応をこの結果だけで保証しない。

後続の別専有fixtureではGetVolumePathNameWとGetVolumeInformationWでそのfixtureのvolumeを`C:\`、filesystemをNTFSと照合した。
同じfixtureのread-only fsutil照会はcase-sensitive属性が無効と報告し、wx、metadata write、close、残留時EEXIST、unlink後の再取得を観測した。
この追加証拠も当該fixtureに限り、他rootの検出や製品のfilesystem gateを実装済みとは扱わない。

Nodeのwxは既存pathを拒否するが、network filesystem全般の排他保証へ拡張しない。
primitive開始前は公式仕様と専有probeで候補環境の基礎操作を確認する。
primitive PRの完了前は製品primitiveと実process fixtureで競合と故障を確認する。
初版primitiveは内部で準備した限定pathを対象にし、一般の製品pathを受け付ける接続前にfilesystemとaliasの拒否を検証する。
filesystem種別を検出して限定する手段は未確定であり、一般pathへの製品接続の阻害条件として残す。

## 残留markerの回復

最小版はlive unlock APIと自動stale takeoverを提供しない案を優先する。
markerが残れば起動を拒否し、回復の責任者が全participant、子process、再起動監視を停止する。
新しい取得が始まらないことと既存ownerの終了を確認できなければ、markerを削除しない。
PIDや時間の経過だけで停止を証明しない。

回復対象は特定したsource setのmarkerに限定し、未知rootの一括削除を行わない。
markerの除去はデータの整合性を保証しない。
次ownerは集合取得後に、保存形式に応じたanchor、intent、readbackとcold recoveryを行ってから保存を再開する。
standalone checkpointにreclamation anchorを要求するものではない。
専有fixtureの停止確認と、実運用の責任者による全停止確認は別の条件として記録する。
本案の設計作業は、実データのmarker削除や外部process停止を許可するものではない。

## 標準起動と再起動への接続条件

現在のトレイ再起動は`src/tray/tray.ps1`で常駐サーバーを`Stop-Process -Force`により終了する。
この終了ではwriterのcloseによるmarker除去を期待できず、排他接続後は通常の再起動でも次の取得が拒否される。
標準writerへ接続する前に、トレイがgraceful停止を要求し、全writerの終了と最終解放の成功を確認してから再起動する手段を決め、実装と試験を行う。
停止要求のAPIと完了通知の方式は未決で、停止要求の送信やprocess終了だけを解放成功の証明にしない。
HTTPの停止要求口を作る場合は、既存書込み口と同じHost、起動ごとの秘密値とOriginの照合条件を守る。
Windowsのgraceful停止はprocessの強制終了やシグナルに依存せず、明示した停止手段を使う。
完了通知は対象の旧server instanceに結び付け、server.jsonの消失を成功の証拠にしない。
停止が失敗または完了未確認なら再起動手順を失敗にし、次の通常起動へ進めない。
停止失敗、強制終了またはcrash後にmarkerが残れば、次の起動は保存writerの取得を拒否する。
永続化を省いたまま通常動作を続ける縮退起動は、自走中の推奨として採らない仮判断である。
トレイは残留markerを自動削除せず、全停止と新規起動禁止を確認した手動回復を必要とする。
この接続条件を満たすまで標準起動へ排他を有効化しない。

フックとMCPからのensureによる自動起動も、標準接続前の確認対象とする。
保存writerの取得拒否を認識したensureは、hook eventごとに再起動とhealth待ちをdeadlineまで繰返さず、拒否理由を保ったまま速やかに失敗を返す。
拒否状態の伝達、表示と手動回復後の再試行条件は手順3の着手時に設計として固定し、本書へ追記してから実装する。未確認の短命状態fileをここで実装方式として採用しない。
拒否理由と回復操作を表示し、その表示が元のhook処理を長時間妨げないことを確認する。
ensureはmarkerを自動削除せず、拒否状態から成功した旧/新server instanceへ誤って状態を引き継がないことも試験する。

## 実装を分ける順序

1. 参加表、保証範囲、未確認条件と回復手順を設計PRにする。
2. 内部で準備した限定path向けprivate primitiveと実process fixtureを別PRで実装し、W01〜W07のprimitiveに対応する競合と故障を確認する。writer終了やfactoryの条件は接続段階へ残す。
3. 一般保存先のfilesystem判定とW08のalias拒否を実証し、検出不能なら取得前に同期拒否する。W11に必要なgraceful再起動とensureの拒否応答を先行実装し、fixtureで試験する。
4. 手順3の全前提を満たした後にstandalone保存入口へ接続し、取得前I/O、W12の同期失敗処理と実markerによるW11の統合条件を確認する。接続PR自身の完了条件に全結果を含め、接続済みで再起動条件が未達の状態を製品へ入れない。
5. factory全file setと二段階終了へ接続し、子backendの解放迂回を拒否する。W04の全終了確認とW06のMap保持/close結果を製品層で確認し、factoryの全markerを含めてW11を実markerで再確認する。再起動条件が未達の接続を製品へ入れない。
6. 全参加writerを横断して異processの共有保存先を拒否し、全参加writerの最終解放を含むW11を再確認して#313の完了条件を確認する。

fixture専用段階には製品callerを作らず、先行fixtureの成功をW11の製品統合確認へ読み替えない。

試験は同時取得、部分競合、metadata write失敗、rollback失敗、release失敗、旧release再呼出し、crash残留、alias拒否、取得後再読込みを含む。
standalone各constructorと移行/修復callerの親directory準備、取得時の同期throwの処理と起動失敗時のcleanupを接続PRの完了条件として照合する。
標準standaloneのunlink失敗は原因を保持し、既存closeとのエラー互換を接続PRで固定する。回収factory専用のエラーcodeを暗黙に標準writerへ広げない。
fixtureと実Claude/Codex runtimeの結果は別に記録する。
fsyncと電源断耐久性は#210の境界を維持し、排他成功から推定しない。

## 自走中の仮判断

即時競合拒否、自動奪取なし、解放不明時の旧owner再利用と自動retry禁止を推奨候補にする。
永続化を省いた縮退起動は採らないことも、本計画の仮判断として扱う。
残留時に停止と手動回復を必要とする可用性制約は、開発者の判断事項として引継ぎ資料へ記録する。
現在のprobeは方式候補の証拠であり、製品排他の成功結果ではない。

## 参照する公式仕様

Nodeの[filesystem flags](https://nodejs.org/api/fs.html#file-system-flags)でwxの既存path拒否とnetwork filesystemの制限を確認する。
Windowsのvolume特定候補は[GetVolumePathNameW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumepathnamew)と[GetVolumeInformationW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationw)である。
directory単位の設定は[Case Sensitivity](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity)を参照し、volumeの対応flagだけで現行設定を判断しない。
これらのAPIを製品へ接続した結果は無く、依存と配布への影響も実装前に確認する。
