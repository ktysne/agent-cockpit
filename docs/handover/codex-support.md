# Codex対応の計画(2026-10-09)

agent-cockpit を Codex デスクトップと Codex CLI にも対応させる作業の、全体の流れ、現在地、次の作業、判断待ち、資料の一覧を 1 か所に集めた資料である。
作業は集約ブランチ `codex/feature-codex-support` で進め、一通り完成するまで main には入れない。
main の変更は同期 PR で随時 feature へ取り込む。
この資料は日付ごとに新しく作らず、PR のマージ、Issue のクローズ、開発者の決定のたびにその場で更新する。
更新した日付は各表の「状態」の列に書く。
起点は feature の 8c701b1(PR #307 のマージ)で、PoC と旧引き継ぎ資料はこのコミットを最後に削除した。

対象から外したもの:

- 旧版 Codex との互換対応。版の厳密な一致は開始条件にせず、使用した版を記録して差で問題が起きたら都度対応する(#156 の結論)。
- cloud や SSH 先の別 host に collector を置く構成(計画書「接続前提と未確認境界」)。
- 既存デスクトップの稼働中セッションへ共有接続する経路。未確認のままで、managed CLI を採用候補にしている。

実装の責務、依存関係、統合ゲート、決定済みの判断の正本は [Codex連携の本実装計画](../design/codex-implementation-plan.md) にある。
この資料は進みと順序を扱い、計画書の内容を繰り返さない。

## 現在地と次にやること

Codex 対応は、調査(#156)、PoC(#157〜#164)、集約(PR #165〜#187)、本実装(fixture で契約を検証して feature へ集約)まで進み、実 runtime 確認と main 採用が残っている。
2026-10-08 に開発者が決めた案 A により、fixture で検証した変更は feature に集約済みで、実 runtime の未確認は feature から main への採用条件として残る。

PR #309 は 2026-10-09 に feature へマージ済みで、merge SHA は `3c4fee8` である。
main の PR #305（別のリポジトリで作った PR の登録）は、作業ブランチ `codex/sync-main-305-20261009` で `origin/main` の `8a0314c` を通常 merge している。
競合解消と関連テストは完了し、Claude のクロスレビューは 1 往復で収束した。[PR #318](https://github.com/ktysne/agent-cockpit/pull/318) は feature へマージ済みで、merge SHA は `394daa9` である。

作業開始時の GitHub 照合では、Codex 対応 Issue の状態は対応表と一致し、open PR は 0 件だった（2026-10-09）。現在の作業 PR は以下の対応順序表で追跡する。

同期 PR の head を起点に、#209 段階 2 の 1b（質問 codec）の独立した検証モジュールと fixture を実装した。
関連テスト39件と全体テスト1,997件は成功した。[PR #319](https://github.com/ktysne/agent-cockpit/pull/319) は Claude のクロスレビューで blocker・要修正がなく、1往復で収束した。
[PR #319](https://github.com/ktysne/agent-cockpit/pull/319) も feature へマージ済みで、merge SHA は `f9e45c6` である。
この head を起点に `codex/delivery-reclamation-codec-209-20261009` で #209 段階2の1c（配信 codec）を実装した。
独立 codec と fixture、関連45件・既存関連59件・全体2,022件の検証は成功した。[PR #320](https://github.com/ktysne/agent-cockpit/pull/320) はクロスレビュー前である。

## 全体の流れ

| 段階 | 内容 | 対象 | 状態(2026-10-09 確認) |
|---|---|---|---|
| 0 調査 | 対応の可否、機能差、方式の決定 | #156 | 調査は完了。本実装の親 Issue として開いたままにし、main 採用のときに閉じる |
| 1 PoC | 8 件の実現性確認 | #157〜#164 | 完了(closed)。記録はコミット 8c701b1 の固定参照(「資料の一覧」) |
| 2 集約 | PoC の stack、規約、共有契約、計画書を feature へ | PR #165〜#187 | 完了 |
| 3 本実装 | G1〜G7 の共通核、両 adapter、fixture での適合試験 | #166、#167、#170、#171、#174、#175、#177、#179、#180 | feature に集約済み。Issue は実 runtime 確認が済むまで閉じない。#179 と #180-B は未着手 |
| 4 監査対応 | #184 と #223 の監査で見つかった退行と計画の問題 | #207〜#218、#223 | #208、#219〜#222 は完了(closed)。残りは「Issue の対応表」 |
| 5 実 runtime 確認 | provider ごとの必須確認(「実 runtime 確認の計画」) | #175、#211、#216、#217、#209、#210、#212 | 未着手 |
| 6 main 採用 | 最終 PR と採用ゲートの照合 | #218 | 未着手。PoC の削除と `npm test` の対象指定は済み |

## Issue の対応表

Codex 対応の Issue はマイルストーン「Codex対応」で分類し、GitHub 側の入口は追跡 Issue [#310](https://github.com/ktysne/agent-cockpit/issues/310) に置く。
main 側の不具合(#292、#308 など)にはマイルストーンを付けない。
「主な PR」はコードの在りかを探す入口で、状態の正本は GitHub である。

| Issue | 内容 | 段階 | 主な PR | 残っていること(2026-10-09 確認) |
|---|---|---|---|---|
| #156 | 調査の親 Issue | 0 | | main 採用時に閉じる |
| #166 | MCP の書込先を provider と native thread ID で照合する | 3 | #188(A)、#202 | #166-B(delegated MCP 登録の接続)。#207 と担当を分ける |
| #167 | Codex フックを共通イベントへ変換する | 3 | #190(A)、#192 | #167-B(mock、画面、導入手順の最終結合)。最後に行う |
| #170 | managed app-server と remote CLI の接続、購読、許可待ちの照合 | 3 | #192、#198 | 実 runtime(G2)の確認。#214、#215 の残りと連動 |
| #171 | bridge の起動登録と native 識別の結合 | 3 | #189(A)、#191(B の核)、#194 | bridge 側(claude-codex-bridge)の変更は判断待ち |
| #174 | 共通質問 MCP、離席期限、回答配送 | 3 | #196、#197、#200 | 1 分、5 分、30 分の実時間待機と native 質問と元 UI の競合の確認 |
| #175 | 通常指示を同じ実行へ配信し、受付と適用を分ける | 3 | #199、#201、#202、#204、#205、#257 | 実 Codex の質問待ちと許可待ち(NS09)、Claude の native 検出 |
| #177 | 親子対応と配信記録の保存、再接続時の照合 | 3 | #193(A)、#203、#206 | #177-B/C(対象機能の復旧の統合、全体復旧) |
| #179 | 混在実行の PR 登録と review 帰属 | 3 | | 未着手。#166、#167、#170、#171、#175、#177、#180 の境界が接続した後 |
| #180 | 共通 dispatcher と vendor 別 runner | 3 | #194、#195(先行部分) | #180-B(dispatcher、両 vendor runner、cancel、結果返却) |
| #207 | feature の本番起動で Claude の MCP 書込みが拒否される | 4 | #234、#238 | 既定 composition の接続、実 runtime 試験(Claude 側の担当) |
| #209 | 配信 checkpoint と質問 journal が満杯になる | 4 | #301、#302、#307(段階 2 の 1a)、#319(1b)、#320(1c) | 1c のレビューとマージ、1d store 間照合、段階 3 の自動回収の接続 |
| #210 | 再起動や書込み失敗で質問サービスが止まったまま戻らない | 4 | #236(部分) | 再照合後の checkpoint 更新、同じ start の再送の扱い |
| #211 | owned runner が native 要求の件数上限で落ちる | 4 | #227、#269、#273、#274 | 実 runtime での上限境界、明示停止、遅延 resolved の確認 |
| #212 | イベント投影が欠落を検出すると固まる | 4 | | collector の復帰証拠と指示 projection の接続条件の確認 |
| #213 | 合成するセッション行が親へ寄らない | 4 | #230(mock 案) | 実装。#167-B、#171-B、#177-B と連動 |
| #214 | managed app-server の要求期限と異常終了時の残留 | 4 | #232(部分) | 異常終了時に app-server が残る件 |
| #215 | owned runner の起動が毎回ログインなどを前提にする | 4 | | 認証保存先の分離、機能名の列挙と環境変数の見直し、`.cmd` 対応 |
| #216 | 共通質問の自動適用が申告に依存する | 4 | #258、#279、#284(段階 1)、#286(段階 2)、#290、#293 | 段階 3(設定画面と標準起動への接続)。#209 の回収条件が前提 |
| #217 | 通常指示の適用証拠を 60 秒しか待たない | 4 | #257 | 実 Codex で 60 秒超の遅延適用の測定 |
| #218 | feature を main へ入れる条件 | 6 | #228、#231 | 証跡の置き場、bridge 側の起票、最終 PR |
| #223 | 監査の親 Issue | 4 | | Sub Issue(#207〜#218)が閉じたら閉じる |
| #311 | MCP の書き込みがタイムアウト以外の通信エラーの後に再送され、判断事項が二重に登録されうる | 4 | | 2026-10-09 起票。結果不明の書き込みを再送しない |
| #312 | provider 別の表示墓標が保存に増え続け、状態取得のたびに全件を走査する | 4 | | 2026-10-09 起票。計測してから回収条件と索引を決める |
| #313 | 配信台帳と checkpoint のプロセス間の writer 排他が無い | 4 | | 2026-10-09 起票。#210 の fsync とは別 |
| #314 | Claude の owned 実行で native wait 中に collector が再接続すると wait が無効のままになる | 3 | | 2026-10-09 起票。#174 の後続(handoff と reconnect)と範囲が重なりうる |
| #315 | 隔離された旧共通質問が画面に出ず、回答できない理由を利用者が知れない | 4 | | 2026-10-09 起票。#216 の段階 3 と一緒にモックで確かめる |

main 側の不具合として #316(idle で補った後の古い推定の再表示)と #317(マニュアルの回答画像が等倍)も 2026-10-09 に起票した。マイルストーンは付けていない。

## 決定済みの判断

実装の判断は計画書の「決定済みの判断」が正本で、ここには作業の進め方の判断だけを置く。

| 項目 | 決定 | 理由 |
|---|---|---|
| 集約先と main への合流(2026-10-09 再確認) | feature で一通り完成させるまで main に入れない。作業 PR は feature を base にし、main の変更は同期 PR で随時取り込む | 開発者の指示。本番未接続のモジュールを main に入れないため |
| 進みの正本(2026-10-09) | この資料と GitHub(マイルストーン「Codex対応」、PR)を正本にし、メモリーには書かない | 開発者の決定。資料が複数あると次のセッションがどれを信じるか決められないため |
| PoC の扱い(2026-10-09) | `poc/` 全体、`docs/poc-codex-*.md`、runtime probe を feature から削除し、コミット 8c701b1 の固定参照を残す | 開発者の決定。差分の約 3.5 万行が PoC で、最終差分の確認を妨げていたため |
| 用済みの資料(2026-10-09) | 実装済みの計画と引き継ぎは削除し、固定参照だけを残す。資料は削除せずに残す場合も `docs/archive/` のような置き場は作らない | 開発者の決定。履歴に残るので参照には困らず、生きている資料だけが見えるようにするため |
| 案 A(2026-10-08) | fixture で契約を検証した変更を feature に集約し、実 runtime 未確認を main への採用条件として残す | 開発者の決定。レビュー済みコードの確認起点をそろえるため。fixture の合格を実 runtime の合格と読み替えない |

## 対応順序、ブランチ、PR

作業 PR は最新の feature を起点に feature を base にする。
連続する作業はスタック式に積み、開発者が下から通常 merge で取り込む。
マージは開発者が行い、PR 番号、head、base は GitHub で確かめた値だけを書く。

| 順 | 対象 | 作業 | PR と base | 状態(2026-10-09 確認) |
|---:|---|---|---|---|
| 1 | 整理 | PoC の削除、資料の集約、Issue の分類 | [#309](https://github.com/ktysne/agent-cockpit/pull/309)、base: feature | マージ済み（2026-10-09、merge SHA `3c4fee8`） |
| 2 | main 同期 | PR #305 を feature へ取り込む | [#318](https://github.com/ktysne/agent-cockpit/pull/318)、base: feature | マージ済み（2026-10-09、merge SHA `394daa9`）。関連347件・監査後107件成功、Claude レビュー1往復で収束 |
| 3 | #209 段階 2 の 1b | 質問 codec | [#319](https://github.com/ktysne/agent-cockpit/pull/319)、マージ時base: feature | マージ済み（2026-10-09、merge SHA `f9e45c6`）。関連39件・全体1,997件成功、Claude レビュー1往復で収束。外部 store 照合と容量条件は1dへ残す |
| 4 | #209 段階 2 の 1c | 配信 codec | [#320](https://github.com/ktysne/agent-cockpit/pull/320)、base: feature、起点 `f9e45c6` | `codex/delivery-reclamation-codec-209-20261009` で独立 codec と fixture を実装済み。関連45件・既存関連59件・全体2,022件成功。クロスレビュー前（2026-10-09） |
| 5 | #209 段階 2 の 1d | store 間照合と互換投影 | 未作成、1c の上 | 未着手 |
| 6 | #209 段階 3 | 自動回収の接続 | 未作成 | 未着手。独立墓標と移行の検証を終えた後 |
| 7 | #216 段階 3 | 設定画面と標準起動への接続 | 未作成 | 未着手。順 6 の回収条件を満たした後 |
| 8 | #211 の実 runtime | 128 件の境界、明示停止、遅延 resolved | 未作成 | 未着手。「実 runtime 確認の計画」の #211 の節 |
| 9 | #216 の実 runtime | trusted 設定、導線、二重登録の確認 | 未作成 | 未着手 |
| 10 | #175 の実 runtime | 実 Codex の質問待ちと許可待ち、Claude の native 検出 | 未作成 | 未着手 |
| 11 | #217 の実 runtime | 60 秒超の遅延適用の測定 | 未作成 | 未着手 |
| 12 | 残る本実装 | #210、#212、#214、#215、#180-B、#179、#177-B/C、#213、#167-B | 未作成 | 未着手。順序は計画書「依存関係と実装単位」に従う。#209、#210、#212、#216 は本番サービスを有効にする前に終える |
| 13 | #218 | G2、G4、横断適合の照合と最終 main PR | 未作成、base: main | 未着手 |

順 8〜11 は順 3〜7 と並行してよい。
ただし #216 の実 runtime(順 9)は順 7 の後にする。

## 実 runtime 確認の計画

fixture で検証した変更を main へ採用する前に残る、実 runtime の確認である。
実 runtime の記録は fixture の記録と分け、実行していない組み合わせを成功と扱わない。
最初に、製品の composition の入口と既存の試験が実際に通る経路を調べ、必要な runtime 操作、ログ、証拠の採り方を各 Issue の完了条件に合わせて確定する。
機能の未接続や試験手段の不足が見つかったら、接続の実装と runtime 確認を分けた差分案を作り、開発者の確認後に着手する。

### provider ごとの必須確認

「必須」は main 採用前にその provider で確認する範囲である。
「仕様上不要」は該当 Issue の対象外という意味で、共通の適合条件を免除しない。

| 機能 | Codex | Claude | 実 runtime の状態と境界 |
|---|---|---|---|
| ID-F08-NS09 の native 質問と許可待ち | 必須 | 仕様上不要(Codex 固有) | 未実施。Claude の native 検出は次の行で確認する |
| 実 Claude の native 要求検出(#175、接続前提 #207) | 仕様上不要 | 必須 | 未実施。起動順修正後の Claude runtime の結果が必要 |
| #211 の Codex ID 保持上限 | 必須 | 仕様上不要(#211 の対象は Codex の `usedNativeRequestIds`) | 未実施。Claude owned wait の別の 128 件寿命上限は #174/#175 の採用確認に残す |
| 製品からの native 待ち実行の明示停止 | 必須(#211) | 共通製品停止の適合対象(Cockpit が起動し所有した実行のみ) | 未実施。物理停止を provider ごとに確認し、一方の成功を他方へ流用しない。外部起動と bridge 所有の実行は Claude の停止対象外 |
| #216 の共通質問と opt-in 導線 | 必須 | 必須(legacy 質問経路を変えない) | 未実施。両 adapter の登録元、適用時設定、重複防止を個別に照合する |
| #217 の ACK 後 60 秒超の入力証拠 | 必須 | 仕様上不要 | 未実施。Claude の fixture は Codex の runtime gate の証拠にならない |
| 通常指示の配送、G2/G4 の共通境界 | 必須 | 必須 | 未実施。受付と適用、再接続と currentProof、質問と通常指示を provider ごとに記録する |

結果は成功、失敗、未実施または観測不能に分け、未実施や観測不能が残る必須項目を main 採用済みと扱わない。

### 実行前の接続と証拠の確認

対象ソースの SHA、製品の起動入口、設定値の由来、既存テストの初期化、実 runtime へ届く観測点を先に特定する。
fixture が内部関数を直接呼ぶ場合は、製品 composition を通る検証とは分けて記録する。
遅延適用試験の前に、対象 adapter の接続で `recoverAfterExpiry` が `true` になる条件を確認する。
`false` の場合は現行仕様では期限後の回復が成立しないので、試験を合格扱いせず仕様判断待ちとする。

各試験記録には、scenario ID、provider、runtime の名前と版、OS、host の識別子、Cockpit の source SHA、script と結果の hash、fixture か実 runtime かの区分、手順、観測結果、合否を残す。
host 名などの個人情報は共有用の記録で伏せ、認証情報、質問本文、ローカルの秘密のパスを保存しない。
未確認と観測不能は `unknown` と記録し、失敗や成功へ読み替えない。
sanitize した summary と manifest は `docs/evidence/` の追跡対象か Issue の添付に残し、レビューで再照合できるようにする(置き場は判断待ち)。
raw frame、token、実際の質問や入力の本文は共有用の証拠に含めない。

### #211 の上限、停止、resolved

上限は実 runtime に 129 件の要求を生成させず、fixture と製品入口を通る境界試験で 127 件、128 件、129 件相当を確認する。
次の表は 2026-10-08 に開発者が承認した代替仕様の期待値である([承認の記録](https://github.com/ktysne/agent-cockpit/pull/263#issuecomment-6054884939))。
件数は pending の件数ではなく、同一実行世代で ID の再利用を防ぐために保持する詳細記録の数とする。
解決済みの要求も保持件数に含み、byte 単位の保存予約は #209 の試験と分ける。

| 条件 | 保持件数 | ID の残枠 | 期待する動作 |
|---|---:|---:|---|
| 重複しない ID を 127 件受信 | 127 | 1 | 上限例外による runner の異常終了なし。未解決の native 待ちがある間は追加指示を送らない |
| 128 件目を受信 | 128 | 0 | 上限内で詳細を保持し、待ちの解消を推測しない |
| 129 件目相当を受信 | 128 | 0 | 詳細記録を追加保持せず、定数サイズの容量超過保留を表示する。runner の異常終了と追加指示の配送は 0 回 |
| 容量超過後の resolved、turn 終了 | 128 | 0 | 容量超過保留を解除せず、同じ実行への送信を再開しない。ID の再利用防止記録を上限回避のために削除しない |
| 開発者による明示停止 | 旧世代を隔離 | 新世代で 128 | 旧 process の exit と close、非稼働、旧イベントの分離を確認した新しい実行だけが新規受付できる |

この案は寿命累計の上限到達で runner が落ちることを防ぐ代替仕様で、turn 単位の回収による連続運転は達成していない。
現行の resolved は turn ID を含まないので、turn 終了だけで ID 集合を消すと、同じ thread で再利用された ID を遅い通知が誤解除するおそれがある。
runner の保持 ID 上限、web/mock の native pending 件数上限、managed transport の未完了 RPC 上限はそれぞれ別で、同じカウンターとして扱わない。
実 runtime では通常発生する少数の native 待ちだけを扱い、境界件数の証拠とは分ける。

明示停止は、実 Codex の owned runner が native 要求を待っている代表実行から行う。
実 Claude では Cockpit が起動し所有した実行を停止し、外部起動と bridge 所有の実行は対象外とする(所有の判定は #207 の担当と照合する)。
停止後に process の exit と close、非稼働を観測し、終了証拠を対象 context と照合して同名や後続の実行の終了を取り違えない。
status や保留レコードの削除だけでは物理停止の証拠にしない。
停止に失敗した場合と対象との一致を確認できない場合は、送信と再送を保留する。

遅延 resolved は、既知の待ちを失効させた後に resolved を遅らせ、同じ実行に後続の待ちを作ってから到着させる。
遅い通知が失効済みの要求だけを消費し、後続の待ちを解除せず、未知または不一致の通知が送信保留を解除しないことを確認する。

### #216 の設定、導線、composition

設定値は開発者が制御する trusted source から読み、モデルが質問本文や tool 引数で申告する値を採用しない。
設定の既定値と有効化の方法を製品の設定導線で確認し、既存デザインの質問カードを使った操作を記録する。
製品の標準起動から質問を登録し、推奨の自動適用が既定 off で、明示 opt-in の後だけ設定が作用することを確認する。
同じ問いが legacy の Claude `decision-answers.js` と新しい共通経路に同時に登録または配信されないことを、質問 ID と配信台帳の観測で確かめる。
既存 Claude の legacy 設定と離席動作を変える場合は、別の判断と Issue を必要とする。

段階 1(専用設定、#284)と段階 2(注入用 factory、#286)は実装済みで、標準起動を自動的に切り替えず、横断する二重登録防止の完成とも扱わない。
段階 3(設定画面と標準起動への接続)は、#209 の隔離記録の回収条件を満たした後に着手する。
段階の定義は [旧差分案(固定参照)](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/handover/2026-10-08-common-question-composition-plan.md) にある。

### #175 の実 Codex 質問・許可と Claude native 検出

Codex の質問待ちは、実 Codex で判断を必要とする質問を出し、本体が回答待ちになる操作で再現する。
自然文で質問を出すだけでは native 要求の証拠にならないので、実際の server request を観測できる能力と操作を先に確認する。
同一実行の待ちの種類と件数、下書きの保持、追加指示の保存と送信の拒否を製品 HTTP と画面で確認する。
繰り返しの GET で要求を消費しないこと、元の UI での解決後も現在 binding を再検証できない間は unverified を保つことを確認する。
owned app-server で本人が回答できる元 UI との接続は未確認である。
回答者との接続が確認できない場合は、送信保留と明示停止だけを確認し、回答による復帰は未確認として残す。

Codex の許可待ちは、本体が許可を求める操作で再現する。
現行の owned runner は never/read-only 固定で、許可待ちの再現能力を証明できない。
製品 runner の `approvalPolicy: 'never'` と `readOnly` は維持し、通常の起動入口から権限を広げない。
専用 profile を作る場合は test harness だけから選べる形にし、製品入口、モデル引数、通常設定から選べないことを実装 PR で確かめる。
試験は隔離 HOME と隔離 cwd で行い、tool 実行 sandbox のネットワークを無効にし、隔離 cwd 内の無害な固定操作を 1 つだけ許す。
隔離 HOME の認証は本人が別途ログインして用意し、新規ログインも試験 profile の起動も計画の作業では行わない。
専用 profile で要求が出ても製品が native 要求を観測できる証拠にはならず、NS09 の製品 gate は通常の製品 composition で別に確認する。
専用 profile を実装する PR では、[owned-native-wait-profile](../design/owned-native-wait-profile.md) に製品の固定契約との違い、選択境界、隔離条件、NS09 との関係を追記する。
Cockpit から許可を出せる経路や、許可待ちを質問応答で解除する経路があれば不合格とする。

Claude の native 検出は、実 Claude で権限または質問を必要とする操作を行い、対象セッションの native 待ちと正規 binding が Cockpit に現れるかを確認する。
#207 の製品経路と観測能力を照合してから行い、writer の実装を重複させない。
以前の Claude の記録は起動順修正前の結果なので、修正後の runtime 版と source SHA を記録して再実施する。
検出できない場合は、未検出の観測点と原因候補を記録し、既存の実行を消したり新たな許可を代行したりしない。

### #217 の 60 秒超過、ACK、遅延適用

実 Codex で、無害な固定の処理を 90 秒以上同じ turn で継続し、その開始後早い時点に通常指示を一度送る。
60 秒以内に証拠が届いた場合は遅延 gate を未確認とする。
実 runtime で自然に遅れて届いた証拠と、harness で配送を遅らせた結合試験の結果は区別し、後者だけで実 Codex の遅延 gate を確認済みにしない。
計測の起点は対象 delivery の ACK 確定を観測した時刻、到着時刻は同一 turn、同一要求、同一本文に対応する native 入力証拠を受け取った時刻とする。

相関器の 60 秒の証拠待ち期限で台帳が unknown を記録し、その後、試験打切り前に同一 turn、同一 delivery、同一本文に完全一致する適用証拠で unknown から applied へ進むことを確認する。
到着時刻だけで合格にせず、適用証拠の保存、台帳の状態遷移、送信回数と再送 0 回を照合する。
ACK 確定前に期限を越えた試験は無効とし、その delivery を再送しない。
試験打切りは ACK 確定から 30 分、または対象 turn の終了時刻の早い方とし、実装と試験を始める前に確定する。
ACK 未確定、別 turn、別 source、本文不一致の証拠では台帳を applied へ進めない。

### main 採用前の最終準備条件(#218)

G2 は実接続、再接続世代、currentProof の失効を runtime で確かめる。
G4 は質問の固定宛先、owner 保留、late answer、通常指示との transport 分離、受付と適用の区別を保つ。
横断確認は両 provider の適合を機能単位で記録してから行い、未実行の provider や runtime を同等と扱わない。
本文が Codex 側の SQLite に残る経路は隔離 HOME で実行し、終了後に cleanup する(#215)。

| Issue | fixture での証拠 | 製品境界での証拠 | 実 runtime での証拠 | 実装から独立した合格条件 |
|---|---|---|---|---|
| #209 | 合成した記録で、予約上限、保持証拠の最大量、終端本文の 7 日保持、再送防止墓標の保持、sending/unknown の非回収を検証する | 標準 composition から件数、予約 byte 数、残容量、閾値を診断する。閾値到達時は新規受付を抑え、進行中記録の確定に要る予約を維持する | 隔離 HOME で代表的な実 runtime 記録を作り、unknown を再送せず保持する | 予約量が許された遷移と証拠の最大量を覆う。閾値、容量不足時の抑止、墓標保持は fixture と独立の仕様値で判定する |
| #210 | 不完全 conversation の再照合後に `incompleteConversationIds` から除かれ、同じ store を新 kernel で開いて同じ start を再送しても保存が恒久拒否されないことを確認する | 標準起動経路で Cockpit の隔離 store を復旧し、journal、checkpoint、同一 start の扱いを観測する | 実 provider で作った未完了 session を再起動後に再照合し、旧期間へ再送しない | 対象 conversation と checkpoint の差分を固定し、再照合前後の ID 集合、保存結果、delivery 再送数 0 を照合する |
| #212 | currentProof に結び付く snapshot watermark と terminal 境界で、replay、再 gap、古い世代の証拠を拒否する | 製品 collector の復帰経路で snapshot から projection までの watermark、terminal 状態、指示 projection を観測する | 対象 provider を再接続し、currentProof を持つ復帰 snapshot だけが projection へ反映されることを確認する | 接続世代、snapshot watermark、terminal 記録、指示 projection の相関を保存前後で照合する。公開しない native ID は共有証拠で別名か hash にする |

別 repository や通常 HOME への変更は、対象、導入手順、cleanup を明記し開発者が確認した後に行う。
bridge 側の正本、契約、試験が必要な変更は Cockpit 側だけで完了としない。
Claude 担当の #207 は標準起動、既存 writer、native 検出の責任を維持し、Codex 担当は同じ Claude registry や不在判定を重複実装しない。

## 判断待ち

| 事項 | 選択肢と推奨 | 出所 |
|---|---|---|
| 証跡の置き場 | sanitize した実 runtime の summary と manifest を `docs/evidence/` に置くか、Issue に添付するか。推奨は `docs/evidence/`(レビューで再照合しやすい) | #218 の対応 4 |
| bridge 側の変更の起票 | #171 と #180 で bridge(claude-codex-bridge)に要る変更(起動前の launch 登録、`--wait` の世代つき owner 移譲、dispatcher 向けの契約、試験と導入文書)を bridge の Issue にするか。推奨は、変更内容が確定した時点で起票し、それまでは #171 のコメントで追う | #218 の対応 5、計画書「接続前提と未確認境界」 |
| NS09 の許可待ちを観測できないときの扱い | 製品の never/read-only のまま観測できない場合、採用範囲から外すか、test harness 専用の profile を作るか。推奨は専用 profile(製品入口から選べない形) | 「#175 の実 Codex 質問・許可と Claude native 検出」 |
| 停止済みの実行のカードの数え方 | 判断待ちの件数に停止済みのカードを含めるか。推奨は含めない(操作できないものを件数に出さない) | PR #274 の[コメント](https://github.com/ktysne/agent-cockpit/pull/274#issuecomment-6056718578) |
| non-blocking の native 質問の待ち中の追加指示 | 送信を止めたままにするか、送ってよいか。推奨は実測するまで止めたままにする | PR #204 の本文 |
| 電源断の保証 | 拒否情報の flush と保存順序の保証を電源断にも広げるか。推奨は広げない(現状はプロセスのクラッシュ後に限る) | [容量回収計画](../design/codex-capacity-reclamation.md)「容量予約と診断」 |
| 作業中の Claude への追加指示 | Codex の steer に当たる Claude の working steer は unsupported である。仕様差として受け入れるか、経路を設計するか。推奨は仕様差として受け入れ、Claude には待機中の次の入力だけを届ける。#175 の[コメント](https://github.com/ktysne/agent-cockpit/issues/175#issuecomment-6029239396)が残条件として挙げている | [Owned native instruction dispatch](../design/owned-native-instruction-dispatch.md)「固定する認可」 |
| 再起動前の共通質問への回答の再開 | #283 は A 案(旧質問を隔離し、回答も再送もしない)で閉じた。旧質問へ回答を再開する B 案を採るか。推奨は採らない。採るなら provider ごとに未解決の証拠を取得できるかの調査から始める | [旧復旧計画(固定参照)](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/handover/2026-10-08-common-question-recovery-plan.md) |
| #156 を閉じる時期 | main 採用時か、本実装の Issue が全部閉じた時か。推奨は main 採用時 | |

## 落とし穴

- native 待ちは Codex または Claude 本体の本人操作待ちで、Cockpit から許可を与える意味ではない。
- `unknown` を手動で消して再送できるようにすると二重入力を防げないので、停止確認と unknown 解除を同じ操作にしない。
- 128 件上限は実モデルに大量要求を出させず、fixture と製品境界で確かめる。
- fixture、product composition 試験、実 runtime 試験は異なる証拠で、結果を合算して実 runtime 成功としない。
- 既存の実 Codex run4 の `unknown` を消去または成功へ書き換えない。
- Claude の既存実測は起動順修正前で、修正後の実 runtime 結果として流用しない。
- 実行寿命の上限、墓標、容量予約を増やす試験は、通常 HOME や既存の保存記録を再利用しない。
- 汎用の stack-check は既定ブランチ main を前提として feature 集約を警告する。採用ゲートを満たす前に、その警告だけを理由に作業 PR の base を main へ付け替えない。
- `npm test` は `test/**/*.test.js` だけを流す。`test/` の外にテストを置くと流れない。
- 子プロセスを起動できない環境(Codex の Windows サンドボックス)では `npm run test:inprocess` を使う。`test/ensure-server.test.js` はそこでは失敗する。
- #209 の codec 共通基盤(1a)は Node 標準機能だけを使い、時計、乱数、registry、ファイル保存を呼ばない。strict helper は own data property を検査し、getter や toJSON を実行しない。

## 起票していない候補

調査で見つけたが、任意の最適化や計測前の性能案、将来の条件であるため Issue にしていないもの。
着手するときに Issue を起票する。

| 候補 | 出所 |
|---|---|
| 隔離診断が呼ばれるたびに容量の予約量を計算し直す(標準起動へ接続する前に #209 で考慮する) | PR #293 の[コメント](https://github.com/ktysne/agent-cockpit/pull/293#issuecomment-6060612725) |
| 未知の kind のセッションを非対話として扱う(許可リスト化するか) | PR #306 の[コメント](https://github.com/ktysne/agent-cockpit/pull/306#issuecomment-6065761647) |
| 結果不明のときの「状態確認」の案内が全操作で同じ 1 文 | PR #252 の[コメント](https://github.com/ktysne/agent-cockpit/pull/252#issuecomment-6045370091) |
| main の全 worktree 探索のキャッシュ(計測後に判断) | PR #276 の[コメント](https://github.com/ktysne/agent-cockpit/pull/276#issuecomment-6056840655) |
| 設定変更で service を作り直す入口を足すときは、保存済み質問が隔離される契約を見直す | PR #290 の[コメント](https://github.com/ktysne/agent-cockpit/pull/290#issuecomment-6059799864) |
| deleteSession のたびの snapshot 再計算(計測後に判断) | PR #252 の[コメント](https://github.com/ktysne/agent-cockpit/pull/252#issuecomment-6045000236) |
| 積み直し判定で間接候補の番号表示が正確でない | PR #261 の[コメント](https://github.com/ktysne/agent-cockpit/pull/261#issuecomment-6054038985) |
| 失効世代を集約する永続的な単調世代(#209 段階 4 の範囲) | [容量回収計画](../design/codex-capacity-reclamation.md)「世代の集約」 |
| Claude の wait の継続で文字列形式の tool_result を受け付けない(未観測) | [owned-native-claude-wait](../design/owned-native-claude-wait.md)「Context の継続」 |
| PR 通知の alias を削除するときの alias 墓標(#209 の範囲) | [配信記録の回収 schema](../design/delivery-reclamation-schema.md)「PR通知のaliasと履歴」 |
| Claude の local issuer をより強い証拠方式へ差し替える前提条件 | [claude-local-issuer](../design/claude-local-issuer.md)「採らなかった方式」 |
| owned runner が 128 件の上限に達するたびに明示停止が要る。turn 単位の回収で連続運転するには、resolved で turn を識別できる方式の確認が先(2026-10-08 の決定で #211 の対象外) | 計画書「決定済みの判断」の #211 の行 |
| 実 Codex の NS12 試験が unknown で終わった原因(run2 の observer digest mismatch、run3 と run4 の `scenario_gate_not_met`)の切り分け。harness は PoC と一緒に削除したので、再試験のときに #218 の採用ゲートの記録として扱う | [Native writer と通常指示サービスの接続](../design/native-instruction-service-integration.md)「NS12 Codex runtime観測」 |
| PR #252 のレビューで「後続で追跡」とされた、保存済み子 PR の合算と fork の branchKept の差(main 側)。症状の記録が残っておらず、再現できたときに起票する。手がかりは `src/server/pull-request-merge.js` の `branchKept` | PR #252 の[コメント](https://github.com/ktysne/agent-cockpit/pull/252#issuecomment-6045000236) |

Claude の local issuer の未確認(Claude CLI、`/clear`、他 OS、session file の読取の遅延)は、#207 の[コメント](https://github.com/ktysne/agent-cockpit/issues/207#issuecomment-6066708704)に確認項目として置いた。
Claude の owned wait の共通質問サービスへの接続は #174 の[コメント](https://github.com/ktysne/agent-cockpit/issues/174#issuecomment-6066707834)、native owner の next-user-input は #175 の[コメント](https://github.com/ktysne/agent-cockpit/issues/175#issuecomment-6066708249)に残条件として置いた。

## 資料の一覧

生きている資料は次のとおりである。

| 資料 | 役割 |
|---|---|
| この資料 | 全体の流れ、現在地、順序、判断待ち |
| [Codex連携の本実装計画](../design/codex-implementation-plan.md) | 責務、依存関係、統合ゲート G1〜G7、決定済みの判断、採用条件 |
| [Codex連携の共有契約](../design/codex-shared-contract.md) | 用語、識別、所有者、handoff、結果返却の契約 |
| [Claude/Codex適合試験](../design/provider-conformance-testing.md) | 機能ごとの scenario、検証層、結果の扱い |
| [正規会話の登録核](../design/codex-registration-core.md)、[起動登録と不変 binding の核](../design/codex-launch-binding-core.md)、[現行 owner と native 照合の核](../design/codex-runtime-binding-core.md)、[Provider event projection](../design/codex-event-projection.md) | #166、#167、#171 の核の設計 |
| [マネージドランタイムの観測](../design/managed-collector.md)、[Native launch composition](../design/native-launch-composition.md)、[同 owned source の collector 結合](../design/owned-native-source-collector.md) | #170、#171-B、#180-A の接続 |
| [配信台帳と登録 checkpoint の基盤](../design/durable-delivery-ledger.md)、[通常指示の配信契約](../design/instruction-delivery.md)、[Native writer と通常指示サービスの接続](../design/native-instruction-service-integration.md)、[Owned native instruction dispatch](../design/owned-native-instruction-dispatch.md) | #175、#177-A の配信と保存 |
| [共通質問と回答配信](../design/common-questions.md)、[共通質問の自動適用設定](../design/common-question-settings-module.md)、[Claude owned native wait](../design/owned-native-claude-wait.md)、[ネイティブ runner の actor 寿命と固定 wait profile](../design/owned-native-wait-profile.md) | #174、#216、#211 の質問と待ち |
| [Native 登録履歴の受動復旧](../design/native-recovery-checkpoint.md)、[Claude の delegated handoff と proof 再照合の実測](../design/native-handoff-live-reconciliation.md) | #177-B の復旧 |
| [質問と配信記録の容量回収計画](../design/codex-capacity-reclamation.md)、[共通質問の回収 schema](../design/common-question-reclamation-schema.md)、[配信記録の回収 schema](../design/delivery-reclamation-schema.md)、[質問の永久失効と移行アンカー](../design/question-reclamation-anchor.md) | #209 の回収 |
| [Claude の writer の発行](../design/claude-local-issuer.md) | #207 の Claude 側 |
| [docs/handover/2026-10-02.md](2026-10-02.md) | cockpit 本体(main 側)の計画書。Codex 対応の進みは書かない |

削除済みの資料と PoC は、コミット 8c701b1 の固定参照で読む。
製品実装済みの根拠にはしない。

| 固定参照 | 内容 |
|---|---|
| [`poc/`](https://github.com/ktysne/agent-cockpit/tree/8c701b1e8a5718eccff69f84775f21171b6663d0/poc) | cockpit 本体の PoC(直下の 8 ファイル)と Codex 対応の PoC(`codex-*` の 8 ディレクトリ)の再現一式 |
| [`docs/poc-codex-157.md`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/poc-codex-157.md) | #157 Codex のフックと MCP 識別 |
| [`docs/poc-codex-158.md`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/poc-codex-158.md) | #158 共有 app-server 接続 |
| [`docs/poc-codex-159.md`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/poc-codex-159.md) | #159 委譲実行の識別 |
| [`docs/poc-codex-160.md`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/poc-codex-160.md) | #160 質問回答と実行許可の分離 |
| [`docs/poc-codex-161.md`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/poc-codex-161.md) | #161 指示配信と停止後再開 |
| [`docs/poc-codex-162.md`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/poc-codex-162.md) | #162 切断と再起動後の復旧 |
| [`docs/poc-codex-163.md`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/poc-codex-163.md) | #163 ベンダーをまたぐ委譲経路 |
| [`docs/poc-codex-164.md`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/poc-codex-164.md) | #164 混在時の PR とレビュー通知 |
| [`tools/probes/common-question-runtime.js`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/tools/probes/common-question-runtime.js) | 隔離 runtime の初期化確認の probe(テストは `test/common-question-runtime-probe.test.js`) |
| [`docs/handover/2026-10-08-runtime-gates.md`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/handover/2026-10-08-runtime-gates.md) | 実 runtime 確認計画の元。生きている内容はこの資料の「実 runtime 確認の計画」へ移した |
| [`docs/handover/2026-10-08-common-question-composition-plan.md`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/handover/2026-10-08-common-question-composition-plan.md) | #216 の段階 1〜4 の差分案 |
| [`docs/handover/2026-10-08-common-question-recovery-plan.md`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/handover/2026-10-08-common-question-recovery-plan.md) | #283 の復旧方式(A 案を採用)の契約 |
| [`docs/handover/2026-10-09-capacity-codec.md`](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/handover/2026-10-09-capacity-codec.md) | #209 段階 2 の 1a〜1d の分割と判断 |

## 次のセッションの開始用プロンプト

```text
agent-cockpit の Codex 対応を続けてください。
docs/handover/codex-support.md を読み、「全体の流れ」「Issue の対応表」「対応順序、ブランチ、PR」の表を GitHub(マイルストーン「Codex対応」の Issue と open PR)と git で照合し、食い違いがあれば表を直してください。
main に feature へ未同期の変更があれば、先に同期 PR を feature へ積んでください。
その後、「対応順序、ブランチ、PR」の最初の「未着手」の行に着手してください。
作業 PR は最新の codex/feature-codex-support を起点に feature を base にし、PR をマージしないでください。
fixture の合格を実 runtime の合格と読み替えず、未実施を成功に数えないでください。
PR のマージや Issue のクローズをしたら、この資料の表を同じ PR で更新してください。
```
