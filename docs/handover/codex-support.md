# Codex対応の計画(2026-10-10)

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
独立 codec と fixture、関連50件・既存関連59件・修正後の全体2,027件の検証は成功した。[PR #320](https://github.com/ktysne/agent-cockpit/pull/320) は Claude のクロスレビューが2往復で収束し、featureへマージ済みである（merge SHA `66b3c6a`）。
このheadを起点に `codex/reclamation-contract-209-20261009` で #209 段階2の1d（アンカーcodec、store間照合、旧形式の投影、grantと固定H/T）を実装した。
Astra監査とClaudeの指摘を修正し、修正後の全体2,102件は成功した。[PR #321](https://github.com/ktysne/agent-cockpit/pull/321) はClaudeのクロスレビューが3往復で収束し、featureへマージ済みである（merge SHA `7427105`）。
このheadを起点に `codex/reclamation-migration-store-209-20261009` で、段階2のPR2としてアンカーstore、移行coordinator、専用枠と保存境界検証を実装した。
関連試験は42件成功・1件skip、修正後の全体試験は2,144件成功・1件skip・失敗0件である。
[PR #322](https://github.com/ktysne/agent-cockpit/pull/322)のClaudeクロスレビューは2往復で収束し、featureへマージ済みである（merge SHA `557e547`）。
このheadを起点に `codex/reclamation-service-guards-209-20261009` で、段階2のPR3として既存writerの新形式対応、質問gate、受付guardとserviceの接続を実装した。
両providerのservice適合試験14件、実サービス再起動を含む保存故障18ケースは成功した。[PR #323](https://github.com/ktysne/agent-cockpit/pull/323)のClaudeレビュー指摘を修正し、最終の全体試験は2,228件成功・1件skip・失敗0件である。
再開とcloseの競合、初回の指示保存結果に関する任意提案も適用した。
Claudeクロスレビューは3往復で収束し、PR #323はfeatureへマージ済みである（merge SHA `977e4fe`）。
このheadを起点に `codex/reclamation-native-factory-209-20261009` で、段階2のPR4として明示的なnative factoryの移行と起動、停止を統合した（[PR #324](https://github.com/ktysne/agent-cockpit/pull/324)）。
作成中から未作成への巻き戻しは単調遷移契約により採用せず、保存済みの完全相関checkpointがある指示だけ作成済みへ回復する。
PR4では、instruction journalのprepareResume待ち中にcloseが完了しても受付フラグを戻さず、閉鎖後の公開操作がbackendの保存やnative作成を呼ばないことを確認した。
新しいfactoryでの起動時に隔離済みの質問を保存済み相関で照合し、古い実行を再認可しない。
両providerのnative factory適合試験は、Claudeの任意提案を反映した追加試験を含め27件成功した。
レビューの任意提案を反映後の最終全体試験は2,256件成功、1件skip、失敗0件である。
Claudeクロスレビューは3往復で収束し、PR #324はfeatureへマージ済みである（merge SHA `f64db23`）。
skipはWindowsで実symlinkを作成する権限が無い試験であり、注入fixtureによるsymlink拒否は成功した。

段階3は質問、通常指示、PR通知とresult、自動実行と停止範囲の分離の順に分割する。
最初の質問回収は `codex/reclamation-body-coordinator-209-20261009` で、退役済み期間の明示回収と準備済み操作の起動時再開を実装した（[PR #325](https://github.com/ktysne/agent-cockpit/pull/325)）。
関連保存遷移試験32件、両providerのnative factory試験44件、全体2,310件（head `39c9123`）が成功し、環境依存の1件はskip、失敗は0件である。
その後の表示2項目の補強は、両providerの関連2件で確認した。
Claudeのクロスレビューは3往復で収束し、PR #325は親ブランチへマージ済みである（merge SHA `cad5403`）。
この内容はPR #324のmergeでfeatureへ集約されている。
通常指示の確定終端回収は `codex/instruction-body-reclamation-209-20261009` で、PR #325のレビュー済みheadを起点に着手し、マージ済みfeatureの`f64db23`へ同期した。
3保存境界と準備済み操作の冷起動復旧、墓標への互換相関追記を実装し、既存の観測権限を復活させない条件を確認する。
関連47件、両providerの実factoryとservice listenerの36件、全体2,366件（head `88ea774`）は成功し、環境依存の1件はskip、失敗0件である。
[PR #326](https://github.com/ktysne/agent-cockpit/pull/326)はfeatureをbaseとし、Claudeのクロスレビューは3往復で収束し、featureへマージ済みである（merge SHA `598c218`）。head `e8d94f3`では、store停止の直接回帰試験を含む32件と、factory関連36件が成功した。製品コードは全体検証済みの`88ea774`から変わっていない。
現保存層の全writer停止を維持し、質問単独失敗時の停止範囲の分離は後続に残す。
個別墓標の件数枠を空ける世代集約は段階4であり、本文回収だけで#209を完了扱いにしない。
PR通知とresultの確定終端回収は、PR #326のレビュー済みhead `3b93ee4`から`codex/terminal-delivery-body-reclamation-209-20261010`へスタックして着手し、親のマージ後にfeatureの`598c218`へ通常mergeで同期した。
checkpoint内の本文と拒否情報を1回の保存で墓標へ置き換え、aliasと履歴、保存済みowner、logical tombstone、件数枠とgrantを保持する。
明示factoryにはresult送信前の`verifyResultOwner`が未接続のため、resultのapplied回収は正規の保存済みcheckpointを使うcold fixtureで検証する。
送信前owner照合と実vendorへの結果返却は[#180-B](https://github.com/ktysne/agent-cockpit/issues/180)の未接続範囲であり、この回収fixtureを実result送信の成功に数えない。

### 通常指示の本文回収の確認範囲

IRB01〜IRB07の期待条件は[配信回収schema](../design/delivery-reclamation-schema.md#明示回収と後着相関の受付)に置く。
applied墓標への保存成功はtrusted provider adapter経路で確認し、serviceの通知権限を再発行する正例とは区別する。
Claudeのapplied状態は完全相関する保存済みcheckpointのcold fixtureであり、Codexのapplied状態はfake native evidenceを通して作る。

| provider | IRB05を含む通知権限のfixture確認 | 未確認 |
|---|---|---|
| Codex | 実際に登録されたservice listenerで、既存tokenによる受付、重複の保存なし受付、token欠落と不一致、観測終了、service close、共有保存queue待機中のwitness失効を確認 | 実runtimeの7日後通知と観測寿命 |
| Claude | 保存済みappliedのcold回収、trusted storeの相関追記、既存adapter観測のtoken照合と終了後失効、service listenerのtoken欠落での拒否を確認 | 旧tokenを持つ通知の観測不在による拒否、service listenerの受付成功、実nativeのappliedと7日後通知。Codexの合成試験へ混ぜて成功扱いにしない |

Codexのservice合成試験は、native fixtureの実際のACKとitem evidenceを取得し、ACKのservice受付を保留したままtrusted storeで終端を保存する。
回収用の時計だけを7日進めて墓標を作り、保持していたACKを同じtokenでserviceへ渡す。
実時間の観測期限、cleanup、権限照合は変更せず、墓標から新しい観測を作らない。

既存adapter観測のtoken照合と終了後失効は、両providerの単体試験8件に含める。
Windowsの実symlink試験1件は作成権限によりskipで、注入fixtureによる拒否は成功した。

### PR通知とresultの本文回収の確認範囲

期待条件は[配信回収schema](../design/delivery-reclamation-schema.md#pr通知とresultの明示本文回収)のTDB01〜TDB06に置く。
両providerの実factoryとファイル保存の関連5件は成功し、両kindの3確定終端、期限境界、非終端の延期、12保存故障境界とfresh起動、相関補完と再送拒否を確認した。
PR通知のappliedはtrusted provider adapterの遷移で作り、resultのappliedと一部の非終端は正規の保存済みcheckpointをcold起動で読み込む。
resultの実送信、異なるownerへのfactory返却、実runtimeの7日後通知の成功証跡には数えない。
最終試験差分`ac1b2d4`と同じ試験内容でnative5件が成功した。PR #327の製品コードは同PRの全体検証headから変わっていない。`ac1b2d4`から同PRの最終更新はレビュー結果の文書記録だけである。`logical_conflict`の試験について、resultの再作成はliveの取消済み墓標で`logical_conflict`と保存なしを確認する。このcodeはlogical tombstoneの拒否と共通で、拒否した層は区別しない。cold appliedでは先行するprovider照合の拒否と保存なしを確認し、墓標による拒否へ読み替えない。
非公開callback accessの再入と寿命はstore単体の試験で確認し、factory facadeへ試験用の保存口を公開しない。
別ownerと非null grantの保全は、純粋な回収計画・参照投影・容量予約の関連25件で確認した。追加のowner世代試験を含む回収計画5件も成功し、accepted handoffで現在ownerが世代6へ進んだ後も、保存済みresultのownerと世代5を保持する。
store/runtime関連39件と最終追加store/context7件は成功した。head `f589250`の全体`npm test`は2,389件成功、1件skip、失敗0件である。skipはWindowsの実symlink作成権限に依存する1件で、注入fixtureの拒否は成功した。

### migration grant解放の確認範囲

期待条件は[配信回収schema](../design/delivery-reclamation-schema.md#migration-grantの明示解放)のGAR01〜GAR06に置く。
PR #327の最終head `bacfa41`から`codex/reclamation-grant-release-209-20261010`をスタックし、featureへのmerge `ea908c2`を内容一致の確認後にfast-forwardで取り込んだ。
pure plannerの関連6件で、実source由来の全3slotのgrant、現在byteが収まっていても将来予約が超える場合の保持、上限ちょうどでの解放、manifestと未設定slotの拒否を確認した。
対象以外の合法なcreating状態はrawのまま保持し、正規化による修復を保存しない。

中核の関連writer54件とcontext・service・conformance57件は成功した。
leaseの3件で、保存後の縮小、旧予約を保持した縮小拒否、予約状態不明による全停止を確認した。
最終guardと質問関連18件も成功し、callback寿命、再入と実I/O直前のservice guardを確認した。
これらの件数は重複を含むため合算しない。
Astraの読み取り監査では必須指摘がない。実factory/fileの関連31件も成功し、全3slot・両providerの18保存故障境界、close中のwrite drain、同じleaseのreadback後縮小と各writer scopeのwarm状態、保存なしのfresh起動を確認した。
高levelの新規受付操作と実native送信は未確認で、実factoryの既存回収入口・scopeとfake process/fileの検証に限定する。
Claude R1の保存前拒否と質問adapter停止を修正し、実退役処理との競合、および両providerの質問serviceとcheckpoint storeのI/O前close拒否を追加確認した。実factory/fileの関連35件は成功した。
修正head `dfd536b`の全体`npm test`は2,442件成功、1件skip、失敗0件（全2,443件、exit0）だった。skipはWindowsの実symlink作成権限に依存する1件で、注入fixtureの拒否は成功した。
[#328](https://github.com/ktysne/agent-cockpit/pull/328)はClaude R3でblockerと要修正0件に収束した。最終sourceは全体試験head `dfd536b`と同一で、close拒否後の停止assertを補強したhead `7a473c7`は関連4件に成功した。

この変更は件数枠の解放、自動実行、質問journalの局所停止、標準起動と設定画面への接続を含まない。
fixtureの予約状態不明を実OSの容量喪失や実runtimeの故障へ読み替えない。

### 質問journalの限定した保存結果不明

質問journalの局所停止は、標準atomic保存のrename再試行がEPERMまたはEBUSYで尽き、tempの後始末まで確認できた場合に限る。
元のadapter、例外instance、保存候補bytesを内部で照合し、旧snapshotと候補snapshotの両方が有効で、grantとslot構成が同じ場合だけ質問を不明状態にする。
質問の公開読取、dashboard、保存を拒否し、anchorと全slotのgrant解放を凍結する。
非質問の保存は共通I/O queueで最新状態を取得し、両方の質問snapshotに対して同じ更新が有効か保存前に検査する。
一般のreadback不明、custom保存経路、checkpoint保存故障、質問grant解放故障は全停止のままである。
復帰にはfresh instanceでの完全なcold照合が必要で、同じinstanceの再開は許可しない。

純粋validatorの13件、persistenceの20件成功と1件skip、contextの40件、質問serviceの16件、局所停止の関連5件は成功した。
これらには重複があるため合算しない。
実factoryと実サービスのnative fixtureは両providerの12件に成功し、rename前の旧bytesとrename後の候補bytesを検査した。
局所停止後の公開instruction取消と7日後の本文回収、grantと容量leaseと質問checkpoint行の保持、低層のgrant消去拒否後の継続を確認した。
全停止のcheckpoint故障と質問grant解放故障はfresh cold起動で保存実体を照合し、追加送信とファイル書換えなしに復帰した。
質問のrename成立後の復帰では、既存のcold復旧契約に従って候補内の質問を隔離するため、必要なjournalとanchorの修復保存を行う。
このcold復旧を含む最終12件も成功し、全grantの保持、追加native送信なし、診断読取後と2回目のfresh起動後のbytes安定を確認した。
低層の不正candidate試験は、公開操作で片方のworldだけが不正になる再現例を示すものではない。
局所停止中のPR通知とresultの継続は、共通validatorと共有保存入口の読み取り監査で確認した設計条件であり、種別ごとの専用native fixtureでは未確認である。
Claude R1はblockerと要修正0件で、任意提案に従い本文回収の最終質問rename故障を両providerで4件追加した。
最終native fixtureは16件成功し、checkpoint墓標に対応するprepared質問をcold復旧で回収し、operation ID、anchorと全grant、2回目の起動後のbytes安定と追加送信なしを確認した。
同instanceのstart拒否はPromiseで返す契約にそろえ、関連2件に成功した。
修正head `b7c92f5`の全体`npm test`は2,485件成功、1件skip、失敗0件（全2,486件、exit0）だった。
Claude R2もblockerと要修正0件で、故障fixtureと観測assertの任意提案を補強した。
補強後のnative16件、persistence20件成功と同じsymlink権限の1件skipを確認した。productionは全体試験head `b7c92f5`と同一である。
[#329](https://github.com/ktysne/agent-cockpit/pull/329)はClaude R3でblockerと要修正0件に収束した。最終の確認差分は`b463189`で、以降は引き継ぎ文言だけを更新した。
マージ順は#328、#329で、次は既定offの自動回収schedulerを同じスタック上で進める。

実装head `cf6e991`の全体`npm test`は2,481件成功、1件skip、失敗0件（全2,482件、exit0）だった。
skipはWindowsの実symlink作成権限に依存する1件で、注入fixtureの拒否は成功した。

注入したrename故障とfake native processの試験であり、実OS由来の故障や実vendor送信の証拠にはしない。
明示構成の自動回収は、既定offのschedulerとして実装中である。
件数枠の解放、標準起動と設定画面への接続は後続である。

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
| #209 | 配信 checkpoint と質問 journal が満杯になる | 4 | #301、#302、#307(段階 2 の 1a)、#319(1b)、#320(1c)、#321(1d)、#322(PR2)、#323(PR3)、#324(PR4)、#325(質問本文回収)、#326(通常指示本文回収)、#327(PR通知/result本文回収)、#328(grant解放)、#329(質問局所停止)、#330(明示自動回収) | grant解放はレビュー収束。段階3の限定した質問局所停止は#329でレビュー収束。自動実行は#330でレビュー収束。段階4の拒否包含分析は#331でレビュー収束。世代集約が後続 |
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
| #311 | MCP の書き込みがタイムアウト以外の通信エラーの後に再送され、判断事項が二重に登録されうる | 4 | #368 | MCP専用policyとfetch開始境界による結果不明時の再送抑止はレビュー収束。実runtimeは未確認 |
| #312 | provider 別の表示墓標が保存に増え続け、状態取得のたびに全件を走査する | 4 | #369、#370、#371 | 計測、session索引、保持契約と反例fixtureはClaudeレビュー収束、Ready。診断getterのcopy化は開発者の確認待ち。GCの全入口拒否境界と件数上限は未解決 |
| #313 | 配信台帳と checkpoint のプロセス間の writer 排他が無い | 4 | #360、#362、#364、#365、#366、#367 | 限定排他primitive、codec、result storeと内部shutdown coordinatorはレビュー収束。停止全体の#364はDraftで判断待ち。製品管理protocolとwriter接続を後続gateに残す。#210のfsyncとは別 |
| #314 | Claude の owned 実行で native wait 中に collector が再接続すると wait が無効のままになる | 3 | PR #373で観測器と実測を追加。通常解放は進行、再接続後旧handle拒否と90秒B未到着を確認。進行方法は未解決 | #174の後続(handoffとreconnect)と範囲が重なりうる |
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

独立した作業PRは最新のfeatureを起点にfeatureをbaseにする。
未マージの変更に依存する後続も最新featureから作成し、依存先のレビュー済みheadを通常mergeしてfeatureをbaseにする。
連続する作業はスタック式に積み、開発者が下から通常 merge で取り込む。
マージ可能になった時点で通知し、マージ待ちで止まらず後続を積む（2026-10-09の開発者指定）。
親のマージ後は、レビュー済みheadがfeatureの祖先であることを確認して後続へ通常mergeで同期する。
マージは開発者が行い、PR 番号、head、base は GitHub で確かめた値だけを書く。

| 順 | 対象 | 作業 | PR と base | 状態(2026-10-09 確認) |
|---:|---|---|---|---|
| 1 | 整理 | PoC の削除、資料の集約、Issue の分類 | [#309](https://github.com/ktysne/agent-cockpit/pull/309)、base: feature | マージ済み（2026-10-09、merge SHA `3c4fee8`） |
| 2 | main 同期 | PR #305 を feature へ取り込む | [#318](https://github.com/ktysne/agent-cockpit/pull/318)、base: feature | マージ済み（2026-10-09、merge SHA `394daa9`）。関連347件・監査後107件成功、Claude レビュー1往復で収束 |
| 3 | #209 段階 2 の 1b | 質問 codec | [#319](https://github.com/ktysne/agent-cockpit/pull/319)、マージ時base: feature | マージ済み（2026-10-09、merge SHA `f9e45c6`）。関連39件・全体1,997件成功、Claude レビュー1往復で収束。外部 store 照合と容量条件は1dへ残す |
| 4 | #209 段階 2 の 1c | 配信 codec | [#320](https://github.com/ktysne/agent-cockpit/pull/320)、base: feature、起点 `f9e45c6` | マージ済み（2026-10-09、merge SHA `66b3c6a`）。関連50件・既存関連59件・修正後の全体2,027件成功。Claude レビュー2往復で収束 |
| 5 | #209 段階 2 の 1d | store 間照合と互換投影 | [#321](https://github.com/ktysne/agent-cockpit/pull/321)、base: feature | マージ済み（2026-10-09、merge SHA `7427105`）。全体2,102件成功。Claudeレビュー3往復で収束 |
| 6 | #209 段階2のPR2 | アンカーstore、移行coordinator、専用枠 | [#322](https://github.com/ktysne/agent-cockpit/pull/322)、base: feature | マージ済み（2026-10-09、merge SHA `557e547`）。全体2,144件成功・1件skip、Claudeレビュー2往復で収束。テスト用compositionまでで、製品起動へ接続しない |
| 7 | #209 段階2のPR3 | 質問gate、serviceとdelivery storeの新形式対応 | [#323](https://github.com/ktysne/agent-cockpit/pull/323)、base: feature | マージ済み（`977e4fe`）。最終全体2,228件成功・1件skip、Claudeレビュー3往復で収束。native factoryと実runtimeは未接続 |
| 8 | #209 段階2のPR4 | 明示的なnative factoryへの移行と稼働の統合 | [#324](https://github.com/ktysne/agent-cockpit/pull/324) | featureへマージ済み。全体2,256件成功、1件skip。Claudeレビューの記録はPRコメントを参照。標準起動と設定画面は未接続、実runtimeは未検証 |
| 9 | #209 段階3と段階4 | 本文回収、自動実行、世代集約 | [#325](https://github.com/ktysne/agent-cockpit/pull/325)、[#326](https://github.com/ktysne/agent-cockpit/pull/326)、[#327](https://github.com/ktysne/agent-cockpit/pull/327)、[#328](https://github.com/ktysne/agent-cockpit/pull/328)（base: feature）、[#329](https://github.com/ktysne/agent-cockpit/pull/329)（base: #328）、[#330](https://github.com/ktysne/agent-cockpit/pull/330)（base: #329） | 質問と通常指示の本文回収はfeatureへ集約済み。#326のmerge SHAは`598c218`。PR通知とresultは#327でfeatureへ集約済み（merge `ea908c2`）で、全体2,389件成功・1件skip（head `f589250`）。Claude R1の引き継ぎ表修正と拒否理由の試験補強を反映した。R2の任意提案を反映し、Claude R3でblocker・要修正0件に収束した。最終試験差分`ac1b2d4`と同じ内容でnative5件成功。明示grant解放は#328で実装し、Claude R1の必須指摘を修正、R3でblockerと要修正0件に収束した。全体2,442件成功・1件skip（head `dfd536b`）、最終assert補強の関連4件成功（head `7a473c7`）。質問journal局所停止は#329でClaude R3に収束し、全体2,485件成功と1件skip、最終補強のnative16件とpersistence20件成功を確認した。既定offの自動実行は#330でレビュー収束。全体2,525件成功と1件skip（source `a787e89`）、最終補強の単体19件成功（`4f69c03`）。段階4の拒否包含分析は[#331](https://github.com/ktysne/agent-cockpit/pull/331)（base: #330）でレビュー収束。全体2,528件成功・1件skip（head `bab5d51`）。拒否索引候補から既存grave形へのpure復元実験は[#332](https://github.com/ktysne/agent-cockpit/pull/332)（base: #331）でClaude R2に収束。全体2,544件成功・1件skip（source `3937095`）、R1試験補強の関連12件成功（`2e05f46`）。単体recordの相関検査とbyte上界は[#333](https://github.com/ktysne/agent-cockpit/pull/333)（base: #332）でClaude R2に収束。全体2,562件成功と1件skip（source `b9b15fb`）、R1補強のbyte試験7件成功（`9506be4`）。単体Q/CP capsule codecと選択ペアは[#334](https://github.com/ktysne/agent-cockpit/pull/334)（base: #333）でClaude R3に収束。修正後の全体2,596件成功、1件skip（source `060f516`）。試験補強`f2b84fb`は関連15件成功。通常recordとcapsuleの全体検査は[#335](https://github.com/ktysne/agent-cockpit/pull/335)（base: #334）でClaude R3に収束。全体2,619件成功と1件skip（source `22bb7de`）、Claude R1の試験補強で関連21件とadmission 18件が成功（`f1befd4`）。R2とR3はblockerと要修正0件。R2任意補強の関連21件も成功（`8be5320`）。外側Q3/CP4 codecと結合検証は[#336](https://github.com/ktysne/agent-cockpit/pull/336)（base: #335）でClaude R1のblockerと要修正0件。全体2,667件成功、1件skip（source `0412f2a`）。旧raw移行計画は[#337](https://github.com/ktysne/agent-cockpit/pull/337)（base: #336）でClaude R2に収束。全体2,685件成功・1件skip（source `81f97a1`）、試験補強25件成功（`1faeb04`）。永続化にはcodec、容量上界、保存とcold、件数枠の条件を別々に満たす |
| 10 | #216 段階 3 | 設定画面と標準起動への接続 | 未作成 | 未着手。順 9 の回収条件を満たした後 |
| 11 | #211 の実 runtime | 128 件の境界、明示停止、遅延 resolved | 未作成 | 未着手。「実 runtime 確認の計画」の #211 の節 |
| 12 | #216 の実 runtime | trusted 設定、導線、二重登録の確認 | 未作成 | 未着手 |
| 13 | #175 の実 runtime | 実 Codex の質問待ちと許可待ち、Claude の native 検出 | 未作成 | 未着手 |
| 14 | #217 の実 runtime | 60 秒超の遅延適用の測定 | 未作成 | 未着手 |
| 15 | 残る本実装 | #210、#212、#214、#215、#180-B、#179、#177-B/C、#213、#167-B | 未作成 | 未着手。順序は計画書「依存関係と実装単位」に従う。#209、#210、#212、#216 は本番サービスを有効にする前に終える |
| 16 | #218 | G2、G4、横断適合の照合と最終 main PR | 未作成、base: main | 未着手 |

順 11〜14 は順 3〜10 と並行してよい。
ただし #216 の実 runtime(順 12)は順 10 の後にする。

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
| 回収factoryの停止未確認後の所有 | process寿命中に保持するか、明示再確認APIを同時に作るか。推奨の終端保持を二段階終了で仮採用する。後着通知やtimeoutで解放せず、同process中は同pathを再取得できない。再確認と詳細診断は別作業 | #209の二段階終了。自走中の推奨判断 |
| 表示記録の診断propertyのmutation互換 | projectionDisplaySettingsを内部Mapとして直接変更できる挙動を維持するか、copyを返して索引との整合を守るか。既知callerは読取りだけのため、推奨のcopy化をPR #370で仮採用した。開発者の確認待ち | #312の[session索引](../design/projection-display-index.md)。自走中の推奨判断 |
| writer lockの残留回復 | 自動stale takeoverを作るか、即時拒否と全participant停止後の手動回復に限定するか。推奨は後者で、設計上仮採用する。現行トレイの強制再起動はmarkerを残すため、標準接続前にgraceful停止と最終解放確認を実装する。残留時は起動拒否とし、PID/TTLによる奪取やトレイの自動削除は行わない。製品接続は未実装 | #313の[排他設計](../design/writer-ownership-exclusion.md)。自走中の推奨判断 |
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

## 明示構成の自動回収scheduler

`codex/reclamation-scheduler-209-20261010`は#329の収束head `3f6a3ca`を起点とする。
`reclamation.autoReclaim`の省略とfalseはoffで、明示した`intervalMs`と`maxOperationsPerPass`だけで起動する。
標準起動と設定画面へは接続しない。

各passは退役した質問period、確認済み終端配信とgrantを候補にし、既存の直列化された明示回収APIで最新状態を再検査する。
件数予算はAPI呼び出し回数であり、書き込み回数や処理時間の上限ではない。
closeはtimer停止後、passの完了を待たずにcontextの書き込みを閉じる。
質問の局所不確実性では質問と全grantを固定し、既知の不確実性以外の例外では自動回収を止める。

scheduler単体19件と既存context/factory接続73件は成功した。
両providerのfactory試験18件と既存の質問局所停止の回帰試験16件は成功した。
CP確認済みcancelled resultとPR通知の自動本文回収を含むが、実native送信は未確認である。
初版の全体試験はhead `5a43bc1`で2,521件成功、1件skip、失敗0件だった。
Claude R1の大量skip候補の検証回数を修正し、19件の単体試験で上限とcursorの継続を確認した。
timer設定故障時のcold起動後始末も両providerで確認した。
修正後の全体試験はsource head `a787e89`で2,525件成功、1件skip、失敗0件だった。
消失候補を200件と100 passへ増やした最終補強も、単体19件で成功した。
Claude R2はsourceに実害なし。スタックの運用手順と任意提案を反映し、R3でblockerと要修正0件に収束した。
skipは既存のファイルsymlink権限制約である。
[#330](https://github.com/ktysne/agent-cockpit/pull/330)は#329をbaseにしたレビュー収束済みのスタックPRである。
マージ順は#328、#329、#330とする。
各親をfeatureへマージした後、子へ通常mergeで取り込み、子PRのbaseをfeatureへ付け替えてからマージする。
親ブランチをbaseにしたまま子をマージしない。モデルはPRをマージしない。
タイマーとprovider processのfixtureによる合格を、実runtimeの7日連続運転の成功と扱わない。
後続は段階4の質問世代に対する拒否包含のpure検証で、墓標削除や既存のattempt拒否を弱める処理は先に接続しない。

## 質問世代の拒否包含分析

`codex/question-period-rejection-coverage-209-20261010`は#330の収束head `dde14cb`を起点とする。
段階4の最初の作業は、失効periodが包含する質問の拒否をpure分析し、全体IDと結果照会など残すべき義務を示すことである。
完全snapshotの照合、複数質問の肯定例、別kindと別periodのattempt ID衝突の反例をpure APIと試験へ実装した。
ClaudeとCodexの正規化済みfixtureとstrict入力の3件が成功した。
availableのgraveの状態照会義務と、CP記録がないindeterminateの対照例も確認した。
入力不変とnested freezeを検証した。
全体試験はhead `bab5d51`で2,528件成功、1件skip、失敗0件だった。
Claude初回レビューの許容三理由の試験不足を補強し、関連7件が成功した。
自己遷移検査と補修候補生成のAPIを区別して、元の入力値が分析されることを確認した。
PR通知とresultの実レコードを追加しても、質問の分析行は変わらなかった。
Claude R2とR3でblockerと要修正0件に収束した。
最終補強は関連7件で成功し、PR/resultの追加をStoreWrite遷移と分析出力全体の一致で確認した。
マージ順は#328、#329、#330、#331。各親をfeatureへ集約した後、子へ通常mergeで取り込み、baseをfeatureへ付け替えてからマージする。
次は拒否索引候補から既存grave形へのpure projectionを検証する。
墓標削除、件数枠解放、受付再開、保存schemaと標準起動の変更はまだ接続しない。

## 質問墓標の復元実験

`codex/question-grave-projection-experiment-209-20261010`は#331の収束head `4f06ee4`を起点とする。
失効periodの回収済み質問を共有表現へ移し、元snapshotとの完全一致、状態照会と拒否動作をpure検証する。
共通参照の辞書化以外の項目は落とさず、CPなしintentから配信を生成しない。
元snapshotを必要とする往復実験であり、新しい永続codecやruntimeの拒否索引には接続しない。
pure実装と両providerの関連12件が成功した。
対象質問5件と配信墓標3件のfixtureでは、候補と対象recordの差はClaudeで2,170 byte、Codexで2,138 byteだった。
元recordの状態照会、旧attemptとlogical keyの拒否、別periodの対照を既存runtimeとgateで確認した。
入力候補を凍結しないように展開前に複製し、値の不変と全nested値の非freezeを確認した。
非対象store IDの不一致と、補修が必要な状態を両APIが拒否することも確認した。
全体試験はhead `3937095`で2,544件成功、1件skip、失敗0件だった。
Claude R1の論理墓標oracleの指摘を修正し、R2でblockerと要修正0件に収束した。
最終試験補強`2e05f46`で関連12件が成功した。製品コードは全体検証した`3937095`から変わっていない。
件数枠解放、実保存の縮小、移行容量とメモリー節約は未実施として扱う。

## 単体recordの相関検査とbyte上界

`codex/question-capsule-record-bounds-209-20261010`は#332の収束head `ad9dc5e`を起点とする。
既存のrecord単位normalizer、質問とgraveの相関、隔離後と終端後の保持期限を使う限定入口を追加した。
配信なしの未選択と選択済みnone、indeterminateを保ち、null入力を全checkpointからの不存在の証明にはしない。
既存snapshotの検査経路は置き換えず、保存schemaとruntimeの形式は変更しない。
両providerの関連pair試験12件とbyte上界試験6件が成功した。
単体recordの最大長候補は、2-space pretty JSONでClaudeのQ 44,566 byte、CP 109,624 byte、CodexのQ 44,564 byte、CP 109,620 byteだった。
測定したQとCPは別々の単体入力であり、同じpairの合法性を測定値から推論しない。
全nullable branchを含む保守的な構造上界はQ 90,224 byte、CP 161,394 byteで、正式capsuleのwrapperや辞書を含む上界ではない。
Astraの読取監査でsourceの必須修正はなかった。
全体npm testはhead `b9b15fb`で2,562件成功、1件skip、失敗0件だった。
指定ClaudeクロスレビューはR2でblockerと要修正0件に収束した。
R1のtest helper補強と測定値assertは`9506be4`でbyte試験7件が成功した。
製品コードは全体検証した`b9b15fb`から変わっていない。
後続は固定の件数とbyte上限を持つ単体Q/CP capsule codecとpair検査で、保存接続と件数枠解放はさらに別のgateとする。

## 単体質問capsuleと選択ペア

`codex/question-rejection-capsule-codec-209-20261010`は#333の収束head `1510a02`を起点とする。
回収済みQ/CPの単体codecと、対象に必要な論理墓標だけを受け取るペア検査を実装する。
各ファイル1 MiBと各capsule256件を独立した受理上限とし、最大長recordを256件収容する保証にはしない。
getterとProxyを実行しない検査に訪問予算を加え、共有参照の各出現も数える。
元snapshotとの比較だけで合否を決めず、保存byteからも独立に正規化する。
契約と後続gateは[容量回収計画](../design/codex-capacity-reclamation.md#単体質問capsuleと選択ペアの検査)に置く。
[#334](https://github.com/ktysne/agent-cockpit/pull/334)は#333をbaseとする。
初回head `56d9d33`の全体試験は2,589件成功、1件skip、失敗0件だった。
Claude R1の要修正2件と任意提案4件を`060f516`で適用し、同groupの非superseded件数、非保存contextの任意順受付、例外の統一を修正した。
操作IDと保持期限の試験、fixture builderの共通化も同headへ反映した。
修正後の全体試験は2,596件成功、1件skip、失敗0件で、Claude R2はblockerと要修正0件だった。
R2の任意提案を`f2b84fb`で適用し、保持期限の成功側対照、両providerの状態境界、容量超過入力の相関を補強した。関連pair試験15件が成功した。
Claude R3もblockerと要修正0件だった。
任意提案のCP capsuleとpairでの早期grave拒否assertを同じ箇所へ追加し、関連15件の成功を確認した。文書の時制も修正した。
製品コードは全体検証した`060f516`から変わっていない。
後続の独立入口は、`codex/question-capsule-whole-validation-209-20261010`の[PR #335](https://github.com/ktysne/agent-cockpit/pull/335)で実装し、Claude R3でblockerと要修正0件に収束した。baseは#334である。
通常recordと複数capsuleを宣言された順序で復元し、全体ID、logical集合、履歴とnative相関の再利用、アンカー退役を検査する。
通常CPの全論理墓標から選択contextを導き、復元raw snapshotのreadyと同じrawストアの自己遷移checkedを、どちらも理由0件で要求する。
実保存byteと将来予約量は各slotのencoderとmeasurerで別途検査し、アンカーの退役予約も通常上限へ照合する。
既存件数と将来予約を含む通常容量の上限を維持し、同じ操作IDを共有する複数chunkもrecordの全体一意性で検査する。
契約は[容量回収計画](../design/codex-capacity-reclamation.md#通常recordと複数capsuleの全体検査)に置く。
`22bb7de`で関連18件とadmission 6件が成功し、全体試験は2,619件成功、1件skip、失敗0件だった。
Claude R1の必須指摘に従い、上限超過時の早期拒否とアンカー将来容量の試験を補強した。
`f1befd4`で関連21件とadmission 18件が成功し、Claude R2はblockerと要修正0件だった。
上限ちょうどの将来予約、padded anchorと全slot null、provider混在の両方向を追加し、関連21件が成功した（`8be5320`）。
Claude R3もblockerと要修正0件だった。
製品コードは全体検証した`22bb7de`から変わっていない。
保存接続、cold復旧、件数枠の解放と実runtime確認は未実施である。

#336は`codex/question-capsule-file-codecs-209-20261010`で、基点は#335の`7926537`である。
質問journal v3とcheckpoint v4へcapsuleを埋め込む局所codecと、chunk UUIDで両ファイルを対応させる全体検査を追加する。
通常recordの配列は全順序の部分列とし、metadata配列順を保持する。
新形式の現在byteと復元した旧形の将来予約を別に照合する。
契約は[容量回収計画](../design/codex-capacity-reclamation.md#capsuleを埋め込む外側ファイルcodec)に置く。
`0412f2a`で質問journal 11件、checkpoint 14件、結合検証8件が成功した。
同じ製品コードの全体試験は2,667件成功、1件skip、失敗0件で、Claude R1はblockerと要修正0件だった。
skipはWindowsの実symlink権限によるもので、注入したsymlinkの拒否は確認済みである。
保存とcold復旧へは接続していない。
次は旧rawファイルと新形式の対応を検証するpure移行plannerで、新形式の将来予約と一時保存ピークは別の後続検証に残す。

その移行plannerは[#337](https://github.com/ktysne/agent-cockpit/pull/337)の`codex/question-capsule-migration-plan-209-20261010`で、基点は#336の`1e7cbf2`である。
旧rawのfingerprint、退役scopeの選択とlogical groupの閉包、決定的なchunk分割、元の全順序と復元内容の一致を検証する。
instructionsの有効なgrantを保持し、質問とcheckpointの変換へ流用しない。
契約は[容量回収計画](../design/codex-capacity-reclamation.md#旧rawファイルからの移行計画)に置く。
新形式の将来予約、prepareとatomic保存ピーク、実保存とcold、件数枠の解放は未達のまま残す。
`81f97a1`で個別18件と全体2,685件が成功し、1件skip、失敗0件だった。
Qの257件と1 MiBの分割、raw Iの16 MiBと有効grantの境界を確認した。
CP capsuleの1 MiBによる分割と独立した件数境界は未確認である。
Claude R1はblocker0件、試験の検出力について要修正2件だった。
nullの対応、grant付きの合法source、選択の重複・空集合、CP-null正常系、回収状態と退役証拠、CP出力ファイルの実byteが通常上限BとB−1になる境界を補強し、個別25件が成功した。
両CP境界の旧wholeもready、自己遷移と容量条件を通り、raw byteの超過による拒否とは区別できている。
退役証拠のない回収済みsourceは旧wholeで拒否されるため、plannerの局所条件だけを通る合法sourceは存在しない。
製品コードは全体検証した`81f97a1`から変わっていない。
Claude R2はblockerと要修正0件で収束した。
任意提案のうちCPの境界を指す文言を明確にした。退役済み未回収fixtureの条件をassertへ追加する案は、現在のfixtureを確認済みであり、今回は非対応とした。

続く既存更新の容量検証は[#338](https://github.com/ktysne/agent-cockpit/pull/338)の`codex/question-capsule-existing-update-capacity-209-20261010`で、基点は#337の`e2a399d`である。
新外側の現在byteに、旧復元形の非負なrecord成長とrevision成長を加える局所helperを実装している。
保証は、通常recordのID、件数、所属、capsule、順序とmetadataを固定した既存field更新に限定する。
保存へ接続する前に、実際の前後状態がこの固定構造を守るguardを別に検証する。
アンカーと全storeの整合、新規受付、prepareとatomic保存ピーク、保存とcold、件数枠の解放と実runtimeは後続である。
個別9件、構文と差分検査、CodeGraph同期と調査が成功した。
テスト側の復元内容と全配列順が独立旧fixtureと一致し、helperのbyte測定がその旧測定と一致することを確認した。
helper内部の復元順序を直接観測した試験ではない。
最大escapedfieldの代表更新とrevision成長を確認したが、全候補variantの実更新は未確認である。
Claude R1はblockerと要修正0件に収束した。`c73836e`で全体2,701件成功、1件skip、失敗0件。skipはWindows実symlink権限による。

後続の更新guardは`codex/question-capsule-existing-update-validation-209-20261010`で、基点は#338の`ae1a455`である。
構造不変だけでは旧容量候補の操作範囲を認定できないため、初版で許可するfieldを限定する。
no-opとwrapper revision、選択済み通常質問のlateAnswers追記、非質問の通常deliveryの状態と相関の進行を対象にする。
質問record revision、selection、held、question delivery、本文回収は固定する。
両時点の全体整合、真の旧before/after遷移、新予約fitと次状態実byteの照合も要求する。
契約は[容量回収計画](../design/codex-capacity-reclamation.md#固定構造の既存更新の検査)に置く。
個別14件が成功し、最後のテスト変更後にQ/CPそれぞれの容量境界1件を再確認した。
capsule metadata、Q/CP順序とheldは両jointと真の旧遷移が受理するcontrolから、新guardの拒否を確認した。
Q/CPのB境界は一方だけを旧予約量へ下げ、他方の新予約fitと旧全体遷移成功を保って、新予約だけが超えることを確認した。
Q detailとreservationのrevision増加は両jointを通るが旧遷移で拒否され、新whitelistの独立検出証拠にはしていない。
行追加と削除、非capsule CP metadata、revision逆行、cache不整合の独立controlは未確認である。
構文と差分検査、CodeGraph変更後同期と調査が成功した。
[PR #340](https://github.com/ktysne/agent-cockpit/pull/340)の`3f5798b`で追跡済みの全テストをNode runnerへ渡し、2,715件成功、1件skip、失敗0件を確認した。skipはWindows実symlink権限による。
Claude R1はblockerと要修正0件に収束した。後続prepareの未追跡ファイル2件は、このPRと全体検証に含めていない。
whitelistの各条件を単独で外した否定controlは未確認で、代表的な受理と候補外更新の拒否を確認した範囲にとどめる。

共通raw JSON codecが背後のArrayBufferの独自byteLength getterを呼ぶ問題を[Issue #339](https://github.com/ktysne/agent-cockpit/issues/339)へ起票した。
intrinsicで取得したbufferをBuffer.fromへ直接渡す経路で1回の呼び出しを再現した。
`codex/raw-arraybuffer-getter-isolation-339-20261010`で標準Uint8Array viewを経由する独立コピーへ変更した。
offsetを持つsubclass viewに入力自身と背後ArrayBufferの独自getterを置き、対象byteだけのparseとhash、getter実行0回を回帰試験で検査する。
[PR #341](https://github.com/ktysne/agent-cockpit/pull/341)の`27ba27f`でraw codec個別12件と追跡済み全体2,716件が成功、1件skip、失敗0件だった。skipはWindows実symlink権限による。
Claude R1はblockerと要修正0件に収束した。後続prepareの未追跡source/testはこのPRと全体検証に含めていない。
この修正を基点に、後続prepare manifestを別ブランチで検証する。

prepare manifestは`codex/question-capsule-prepare-manifest-209-20261010`で、基点は#341の`b07e63b`である。
操作、store、source/targetの指紋、完全scopeの選択集合、使用chunk割当順と通常上限を独立v1形式で保持する。
局所codecは有限件数とfield上限、全入口の実pretty JSON 16 MiB政策を検査する。
byte証拠の検査は保存された選択とUUID、上限でraw plannerを再実行し、全source/target指紋と渡されたtarget byte列の完全一致を要求する。
成功は渡された材料の一致だけであり、保存許可や復旧許可ではない。
後続は旧Q/CPの元byte列を保持する質問側の明示prepared形式を検証する。
anchor/Iは固定した外部正本として扱い、既存Q3へ未知fieldを足さない。実保存、排他、atomicピーク、cold継続とruntimeは後続に残る。
個別10件が成功し、#339で失敗していたsource backing ArrayBuffer getterも0回で検査を通った。
両providerと混在、CPなし、raw空白と重複key、指紋とstore・選択・target byteの改変、件数と文字列予算、compact rawは収まるがpretty encodeが超過する全入口の拒否、getter/Proxy非実行と入力不変を確認した。
構文と差分、CodeGraph変更後同期と調査も成功した。
[PR #342](https://github.com/ktysne/agent-cockpit/pull/342)の`f7e7894`で追跡済み全体の再実行は2,726件成功、1件skip、失敗0件だった。skipはWindows実symlink権限による。
初回は既存issuer統合テストがファイル単位で失敗したが、単独10件と全体再実行では成功し、原因は未特定である。初回ログも保持した。
Claude R1はblockerと要修正0件に収束した。Bの改変はbyte証拠だけでは検出せず、信頼する設定の正本との照合は保存接続時に別途要求する。
後続prepared materialの未追跡source/testはこのPRと全体検証に含めていない。

prepared materialは`codex/question-capsule-prepared-material-209-20261010`で、基点は#342の`3b6a07b`である。
旧Q/CPのraw byte列をcanonical base64で保持し、manifestと固定した外部anchor/Iから同じtargetを再生成する独立codecを実装する。
通常journalへ未知fieldを追加せず、現loaderやwriterへは接続しない。
16 MiBの外側受理政策を、manifestの入れ子indentとbase64長を含めて文字列生成前に検査する。
局所検査と完全材料検証を分け、通常上限B、durable可用性、保存とcoldの成功を認定しない。
専用テスト12件が成功し、そのうちraw getterの1件は最終補強後にも成功した。構文、差分、CodeGraph同期と調査も成功した。
CPなし、両providerと混在、raw空白と重複keyの保持、有効I grantとB+G境界、指紋と外部材料変更、getter/Proxy/SAB、入力不変を確認した。
16 MiBちょうどと+1は局所codecの境界fixtureで検査したもので、完全検証を通るQ2の意味を示す試験ではない。
合法な旧sourceが外側上限を超える作成controlでは、base64文字列の生成0回で拒否することを確認した。
`d87c6f6`の追跡済み全体は2,738件成功、1件skip、失敗0件だった。skipはWindows実symlink権限による。
Claude R1はblockerと要修正0件。任意提案のevidence正常controlと完全材料検証のI容量境界を補強し、対象2件が成功した。
製品コードは全体検証した`d87c6f6`から変更していない。
[PR #343](https://github.com/ktysne/agent-cockpit/pull/343)のClaude R2もblockerと要修正0件に収束し、試験補強後の`8400b3c`で専用12件が成功した。
IのB-1拒否は公開材料検証の結果であり、内部の拒否層を直接観測した試験ではない。
後続boundaryの未追跡source/testはこのPRと全体検証に含めていない。

境界分類は`codex/question-capsule-migration-boundary-209-20261010`で、基点は#343の`a2814ef`である。
正規material参照と外部anchor/Iを完全検証し、現在Q/CPを旧・準備済み・CP移転後・完了のbyte完全一致で分類する。
CPなしは準備状態を一つに畳み、未知の混在組や意味一致だけの別byteを拒否する。
返却は分類、CPの有無、observed指紋と四正本の現在logical byte表で、書き込みやlease、保存・再開の命令を返さない。
既存atomic writerはbackupを作らず同じtempでrenameを再試行するが、cleanup失敗とcrashの残留物、別process、注入writer、fsync不在があり、この表の合計を真の保存ピークへ読み替えない。
個別8件が成功し、両providerと混在の4境界、CPなしの3境界、非正規旧rawの完全一致、同サイズで意味一致するCP再formatの拒否、混在pairと材料改変、getter/Proxy/SAB、raw byte境界と入力不変を確認した。
有効I grantがある場合も実I byteを合計へ加算する。構文、差分、CodeGraph変更後同期と調査も成功した。
追跡済みテストを明示した全体検証は、`e2aaf17`で2746件成功、失敗0件、既存Windows symlink権限による1件skipだった。
Claude R1はblockerと要修正0件に収束した。
CPなしの同一byte入力を別名で再実行する試験と、detachそのものの試験は追加していない。
上限+1入力の拒否は確認したが、上限照合層やparse前の拒否を独立に観測した試験ではない。
後続容量評価の未追跡source/testは、このPRと全体検証に含めていない。

条件付き容量評価は`codex/question-capsule-migration-capacity-209-20261010`で進め、基点は#344の`2dcdbf3`である。
完全材料検証と期待する通常上限の値一致を前提に、旧容量の成立と、新しい準備材料/target将来予約の枠不足を区別する。
四正本の期待current表、旧と新の将来予約を保持するprotected表、単一tempを足した候補を返す。
この表は実filesystemの観測や取得済みleaseを示さない。
全writer停止、元anchor/I不変、単一操作、未知orphan不在などの仮定は固定値として返し、呼び出し元のbooleanで認定しない。
専用9件が成功し、準備材料E=B/E=B+1、新QとCPの将来予約F=B/F=B+1を完全材料検証が成功する対照で確認した。
有効I grantのB+G一致、旧rawの空白と重複key、全境界とtempの加算、CP不在、getter/Proxy/SAB、入力不変も確認した。
構文と差分の確認、CodeGraph変更後同期と調査は成功した。
上限+1のゼロ埋め入力の拒否は、parse/copy前の照合を独立に観測した証明ではない。
初回個別試験は結果を取得できなかったため合否不明とし、session 17849の再実行9/9を採用する。
追跡済み全体テストは`91ed430`で2755件成功、失敗0件、既存Windows symlink権限による1件skipだった。
指定ClaudeのR1はblockerと要修正0件に収束した。
I固有の期待上限不一致とB+G+1の独立拒否対照は、この専用試験では未確認である。
後続workspaceの未追跡helper/testは、このPRと全体検証に含めていない。
実保存と限定復旧は専有実験directoryでの次段階とする。

保存fixtureは`codex/question-capsule-migration-workspace-209-20261010`で進め、基点は#345の`e426538`である。
任意の既存directoryを開くproduction coordinatorは作らず、fake fixtureを内部mkdtempへseedするtest helperで三保存境界を検証する。
元予約を保持した共有budgetへ条件付き表の全量を別leaseとして追加し、原anchor/I不変と各境界のbyteをreadbackで照合する。
source_unpreparedでは復旧のwriteを行わず、材料のある既知境界だけを同操作として継続する。
最終新形式は整合性を確認しても過去operationのprovenanceを不明として返す。
専用試験は25件成功、失敗0件、symlink作成EPERMによる1件skipだった。
child-processを起動できない初回経路の未実施を分け、昇格実行で別processの限定復旧と6保存faultを確認した。
before-renameの残留tempではfresh openを拒否し、after-rename-before-readbackでは観測した既知byte境界から再開した。
容量不足の移行writeなし、停止後の同instance再試行拒否、close/drain、凍結facade、欠落と改変と未知entryも確認した。
3ファイルの構文、空白、CodeGraph変更後同期と調査は成功した。
追跡済み全体テストは`d8cf39c`で2780件成功、失敗0件、既存とworkspaceのWindows symlink権限による2件skipだった。
指定Claude R1の要修正2件をtest側で修正し、関連テストは25件成功、失敗0件、Windows symlink権限による1件skipだった。
全所有childの終了確認後に所有rootを回収する。
seed済み四正本を読み直し、helperとは別にslot別max合計と全候補maxで予約を集計し、facadeの実測と照合する。
slot別の計測値はcapacity moduleの出力に依存し、同module自体の算定誤りを検出する独立oracleではない。
helper本体は変えていないため、全体検証は上記commit、修正後は関連テストの結果を併記する。
fresh-processはclaude、faultはclaudeとcodex、I grantはclaudeで確認したため、全providerと全条件の組合せは未確認である。
fixtureのpause通知はIPC親の有無に依存し、同process試験のpause待ちは約1秒のpoll上限を持つ。
closeや呼び出し前提違反が一般のblocked診断になる限界を残し、runtimeの破損診断へ読み替えない。
標準runtime、外process排他、OS耐久性は未達として扱う。

## 回収機能のレビュー済みPRと後続

2026-10-11のGitHub照合では、次のPRはすべてfeature向けで未マージである。
#347〜#349、#351〜#354、#356〜#358はReadyとして扱える。
#348と#349のbaseはfeatureへ統一し、headの内容は変更していない。

| PRとhead | 内容 | 検証とレビュー |
|---|---|---|
| [#347](https://github.com/ktysne/agent-cockpit/pull/347)、`2228696` | capsule移行状態の読み取り専用inspection | source `8ed160c`で全体2804成功、失敗0、Windows権限skip3。追加test後のClaude R3で必須0 |
| [#348](https://github.com/ktysne/agent-cockpit/pull/348)、`5457dce` | fixture専有の既存更新backend | source `8c335d5`で全体2829成功、失敗0、Windows権限skip3。補強後関連27成功、Claude R3で必須0 |
| [#349](https://github.com/ktysne/agent-cockpit/pull/349)、`c05c564` | fixture限定操作とclose/reopen/dispose | `604dddd`で全体2850成功、失敗0、Windows権限skip3。補強後関連22成功、Claude R2で必須0 |
| [#351](https://github.com/ktysne/agent-cockpit/pull/351)、`62e18b2` | 明示的回収factoryの操作受付停止と終了追跡 | source `4db527e`で関連248成功、全体2802成功、失敗0、Windows実symlink権限skip2。標準挙動subset26成功、Claude R1で必須0 |
| [#352](https://github.com/ktysne/agent-cockpit/pull/352)、`2ea0c83` | main #350の配布物同期 | 関連2件、CLI定義読み取り5条件、構文、空白、上流同期check成功。Claude R1で必須0。アプリsource無変更 |
| [#353](https://github.com/ktysne/agent-cockpit/pull/353)、`36c1c63` | native起動の段階別取消検証 | `cd39352`で全体2794成功、失敗0、Windows実symlink権限skip2。test補強後`1912130`で関連192成功、Claude R2で必須0。製品source無変更 |
| [#354](https://github.com/ktysne/agent-cockpit/pull/354)、検証source `b70816d` | lease単位のnative read協調取消 | 関連120成功、全体2836成功、失敗0、Windows実symlink権限skip2。修正後関連120成功、source無変更、Claude R2で必須0 |
| [#356](https://github.com/ktysne/agent-cockpit/pull/356)、検証source `f449304` | collectorの恒久受付停止とprivate drain | 関連145成功、全体2849成功、失敗0、Windows実symlink権限skip2。Claude R2で必須0。#354の後に取り込む |
| [#357](https://github.com/ktysne/agent-cockpit/pull/357)、検証source `d253639` | native startとcollectorのfactory終了追跡 | `9379162`で全体2885成功、失敗0、Windows実symlink権限skip2。test補強後はlifetime52成功、全体未再実行、製品source無変更。Claude R3で必須0。#356の後に取り込む |
| [#358](https://github.com/ktysne/agent-cockpit/pull/358)、検証source `bbd9d15` | native readの取消前write故障分類 | 関連123成功、固定head `d12453b`で全体2889成功、失敗0、Windows実symlink権限skip2。Claude R1で必須0。#357の後に取り込む |

#347、#348、#349はこの順でマージする。
#351、#352、#353はそれぞれこの系列と独立して取り込める。
#352はfeature `c731abe`とmain `518b946`を祖先として残す通常mergeで、配布物4ファイルを取り込む。
アプリ全体テストは重複実行せず、#351のfeature baseに対する証跡を参照する。
配布物の関数冒頭コメントの補足は上流向けの任意候補であり、手編集しない。

#351のfactory fixture15件とgate単体7件は、共通queue、回収core、schedulerで新受付を同期停止し、受付済み操作の成功、取消または失敗による終了を確認する。
context.closeの保存禁止とready拒否はticketのdrain前に開始する。
適合条件は[ID-F209-L01](../design/provider-conformance-testing.md)にある。
acceptedへの実到達と登録済みlistenerの後着拒否は両providerで確認するが、後着経路はlistener直接呼出しでありadapter/router全体を通さない。
保存中closeはunknownを両provider、appliedをCodexで確認する。
Claude live appliedと両providerの実runtimeは未確認である。

#353の追加14件は、通常起動profileの実runnerとcompositionを保持点で確認する。
R1の必須指摘に対応し、全11stageで後着解放前後のwrite履歴を直接比較した。
適合条件は[ID-F209-S01](../design/provider-conformance-testing.md)にある。
Codex login、thread、turnの個別write callback保留とwait profile固有待機は未確認である。
最終headの文書記録とtestのみの補強を、製品sourceの全体検証結果と分けて扱う。

## native read取消の現在地

`codex/native-read-lease-cancellation-209-20261011`は最新feature `c731abe`から作成し、#351、#352、#353のレビュー済みheadをこの順で通常mergeした。
作業開始時のheadは`57cd63f`であり、製品sourceにmerge conflictはなく、設計と引き継ぎ資料の両方の内容を保持した。
この後続PRは#351、#352、#353の取り込み後にマージする。
#347〜#349の未マージsourceはこのブランチへ取り込んでいない。

PR #354に、lease解放またはsource無効化によるCodex native readラッパーの協調取消を実装した。
既存のleaseとrequest tokenを先に失効させ、対象readだけをunknownへ終了させる。
取消権限はsource内部に保持し、正常完了したreceiptとinstruction transportの境界を維持する。
適合条件とfixture結果は[ID-F209-R01](../design/provider-conformance-testing.md)にある。
source `b70816d`で追加20件を含む関連120件と全体2836件が成功し、失敗0、全体はWindows実symlink権限skip2である。
実Claude/Codex runtimeのread取消は未実施である。
Claude R2はblockerと要修正なしで収束した。
修正後`2dd659a`の関連120件も成功し、製品sourceは全体検証済みheadから変わっていない。
loaded-list後のmicrotask取消は次RPC不送信を確認するが、内部continuationの各境界は独立計測していない。

ラッパー終了とraw callbackの終了を分け、epochやdetachをI/O終了の証拠にしない。
次はcollectorのprivate drainとfactory ticketへの接続を進める。
collector単独の追跡とfactory接続は別PRに分ける。
取消前のstdin write故障分類は[Issue #355](https://github.com/ktysne/agent-cockpit/issues/355)に記録し、read取消とは分けてPR #358で対応した。
協調writer ownership、新schemaの通常接続、実runtime、電源断耐久性と件数枠解放は未達である。

## owned collector終了追跡の現在地

`codex/native-collector-private-drain-209-20261011`は最新feature `c731abe`から作成し、PR #354のレビュー済みhead `45eea5d`を通常mergeした。
開始時のheadは`e574863`で、#351〜#354を祖先として保持する。
この後続PRは#354の取り込み後にマージする。

collectorの内部制御と最外側処理の追跡を実装した。
PR [#356](https://github.com/ktysne/agent-cockpit/pull/356)はReadyで、#354の後に取り込む。
sourceの検証対象は`f449304`である。
実装前に[ID-F209-C01](../design/provider-conformance-testing.md)を定義した。
通常disconnect後の再接続と公開APIを保ち、恒久停止、非協調readのdrain保留、同期再入を確認する。
factory ticket接続とcloseの停止順はこの段階に含めない。
関連するcollectorとcompositionの145件が成功し、失敗とskipは0件である。
固定head `f449304`の全体テストは2849件成功、失敗0、Windows実symlink権限skip2である。
ticket解放例外の失敗判定を修正し、Claude R2はblockerと要修正0件で収束した。
非協調readは明示解放までdrainを保留し、通常disconnectのPromise契約と接続待ちの表示を維持する。
実runtime、raw provider I/Oの終了、factory closeとの接続は未確認である。
次は明示的回収factoryへstartとcollectorのticketを接続し、全native停止の開始後にserviceとdrainを合流する。

## native factory終了追跡の後続

`codex/native-factory-private-drain-209-20261011`は最新feature `c731abe`を起点に、PR #356のレビュー済みhead `f394c37`を通常mergeした。
開始headは`358f512`で、#351〜#354と#356を祖先として保持する。
マージ順は#356の後である。
PR [#357](https://github.com/ktysne/agent-cockpit/pull/357)はReadyで、source検証対象は`d253639`である。
実装前に[ID-F209-L02](../design/provider-conformance-testing.md)を定義した。
明示的回収modeでstartとcollectorの処理を追跡し、全native停止の開始をservice待機より先に行う。
生成済み資源の準備失敗は同期throwを保ち、後始末とticketの終了を別途待つ。
標準mode、contextの保存禁止開始と物理停止の照合条件を維持する。
実装済みで、補強前の関連4ファイル108件が成功し、失敗とskipは0件である。
最初のtest-only監査修正後もlifetime51件が成功した。
Claude R1の任意提案を反映後はlifetime52件だけを再実行し、すべて成功した。
補強後の全体テストは未再実行で、検証source `d253639`以降に製品sourceの差分はない。
固定head `9379162`の全体テストは2885件成功、失敗0、Windows実symlink権限によるskip2である。
Claude R1はblockerと要修正が0件で、標準modeの例外保持を補強し、既存保持点の観測を照合した。
R2の検証範囲記載の指摘を反映し、全体検証と補強後の関連検証を区別した。
Claude R3はblockerと要修正が0件で収束した。
構築中のclose再入による後着collector回収はprivate injectionであり、通常製品のcallback到達性を示さない。
実runtime、raw I/Oと保存ownership解放順は対象外である。
read write故障分類はPR #358で修正した。
次はcontextの二段階終了を設計し実装する。
contextの保存禁止開始と保存所有権の最終解放を分け、factoryの未終了処理が残る間の所有権保持を検証する。
process間の協調lockは方式と参加writerの決定後に別PRで扱い、process内の終了順確認を排他保証へ読み替えない。

## native readのwrite故障分類の後続

[Issue #355](https://github.com/ktysne/agent-cockpit/issues/355)は、取消前のreadonly RPC write故障が一般のRPC拒否へ変換され、runnerがrunningのままになる不具合を扱う。
`codex/native-read-write-failure-355-20261011`を最新feature `c731abe`から作成し、PR #357のレビュー済みhead `a69bb80`を通常mergeした。
開始headは`bc9a331`で、マージ順は#357の後である。
PR [#358](https://github.com/ktysne/agent-cockpit/pull/358)はReadyで、検証sourceは`bbd9d15`である。
実装前に[ID-F209-R02](../design/provider-conformance-testing.md)を定義した。
制御済みのwrite故障と論理取消だけを保持し、provider拒否、timeoutと失効generationの契約を維持する。
FakeChildと実owned sourceの関連123件は成功し、失敗0件である。
固定head `d12453b`の全体テストは2889件成功、失敗0、Windows実symlink権限によるskip2である。
Claude R1はblockerと要修正が0件で収束した。
実runtimeと実stdio故障は未実施である。

## 回収factoryの二段階終了の後続

`codex/reclamation-two-phase-close-209-20261011`を最新feature `c731abe`から作成し、PR #358のレビュー済みhead `f6056a8`を通常mergeした。
開始headは`31d0f0a`で、マージ順は#358の後である。
実装前に[ID-F209-O01](../design/provider-conformance-testing.md)と[二段階終了の契約](../design/native-instruction-service-integration.md#明示的回収factoryの二段階終了)を定義した。
停止未確認時はprocess寿命中に所有を保持し、再closeや後着通知で自動解放しない案を、自走中の推奨として仮採用する。
保存失敗と終了未確認は分け、独立に終了を確認できた保存失敗では所有を解放する。
所有保持時だけ回収factory.closeのtop-level codeを変え、元理由をAggregateErrorのcauseとerrorsに保持する。
通常のwriteとreadbackが終わる前にpersistenceを閉じず、公開facadeから最終解放へ迂回しない。
process間排他は[#313](https://github.com/ktysne/agent-cockpit/issues/313)の範囲へ残す。
実runtime、電源断耐久性と新schema writer接続も未実装または未確認として残す。
検証source`ed9e1b1`をコミットし、固定headで全体検証と指定Claudeレビューを行う。
PR [#359](https://github.com/ktysne/agent-cockpit/pull/359)はfeature向けReadyで、#358の後にマージする。
関連9ファイルの237成功、失敗0、Windows実symlink権限skip1は最終stop記録の補強前である。
監査補強後のcontextとfactory112件、最終context49件とcoordinator管理終了2件はすべて成功した。
次は#313の参加writer、ファイル単位の所有、取得前I/O禁止とcrash後の回復条件を設計し、primitiveとwriter接続を分ける。
固定head `5a3d50f`の全体テストは2792成功、119失敗、Windows実symlink権限skip2だった。
本文回収とgrant解放の試験helperのprivate control引継ぎを補強し、未知leaseの再起動拒否を含む4試験群120件、factory lifetime72件、question write隔離16件が成功した。
修正後の固定headで全体再検証とClaude増分レビューを行った。
Claude R1はblockerと要修正が0件だった。
互換補強後の固定head `30f6e85`は全体2911成功、失敗0、Windows実symlink権限skip2だった。
Claude R2もblockerと要修正が0件で、最終の軽微な整形後の構文確認と未知lease2件も成功した。
レビューは2往復で収束し、PR #359はマージ可能である。
マージ順は#351→#352→#353→#354→#356→#357→#358→#359で、モデルはマージしない。

### 保存writerのプロセス間排他

`codex/writer-exclusion-design-313-20261011`を最新feature `c731abe`から作り、PR #359の最終head `8fa81f5`を通常mergeした。
起点は`05e6f79`で、[排他設計](../design/writer-ownership-exclusion.md)と適合試験計画を先に記録する。
PR [#360](https://github.com/ktysne/agent-cockpit/pull/360)の設計sourceは`ddbcc5e`で、R1/R2対応は`83dd295`と`bc1db69`である。
製品src/testは親#359から不変。文書差分の指定Claudeレビューを3往復行った。
Astraの助言を反映し、per-file sidecarを共通単位にし、factoryの全file set取得とstandalone参加をそろえる。
private primitive、標準writer接続、factory接続と横断試験は後続であり、#313を完了扱いにしない。
専有Windows probeは競合同時取得、正常marker残留、大小文字とjunction alias、hardlinkの反例を確認した。
対応filesystemの検出、未対応aliasの拒否、実process crashと実runtimeは未確認で、製品排他成功へ数えない。
設計PRのレビュー後は、候補環境の基礎操作を確認し、限定path向けprivate primitiveと実process fixtureに進む。
Claude R1はblocker0件、要修正3件で、トレイ再起動の接続条件、lease/sidecar/Mapの解放順と一般path接続前のfilesystem/alias検証を明記して再レビューする。
一般保存先と標準再起動への接続は限定primitiveの完了に含めず、W11の停止/再起動とW12のcaller同期失敗を後続の完了条件にする。
Claude R2で見つかったensureの反復起動と接続/有効化の曖昧さを、standalone接続前にW08と停止/ensureの先行fixture試験を行い、接続PR自身でW11の製品統合条件を満たす順序へ修正する。
短命状態fileや内部optionの方式は未採用で、実writer接続より先に拒否応答と再起動の手段を固定して試験する。
R3はblocker0件、要修正1件で、設計一ファイルの手順5/6へfactoryと全参加writerのW11再確認を追記した。
3往復後の局所修正ルールに従い、主セッションが文書整合を確認して収束とする。製品fixtureと実runtimeは未実行のままである。
PR #360はレビュー修正後にマージ可能とし、順序は#351→#352→#353→#354→#356→#357→#358→#359→#360である。

### 限定fixture向けの排他primitive

`codex/writer-exclusion-primitive-313-20261011`を最新feature `c731abe`から作り、PR #360の最終head `4d7bf51`を通常mergeした。
起点は`a456aea`で、実装前にP01〜P10のprimitive期待条件を記録した。
Astraの実装前監査に従い、内部prepare/acquireと同一close Promiseを使い、製品callerを作らない。
opaque集合は入力を固定する仕組みであり、一般pathのfilesystem判定やproducer停止の証明器とは扱わない。
専有fixtureではWinAPIでC:\のNTFSとcase-sensitive無効を照合し、同fixtureのwx/write/close/EEXIST/unlink/再取得を確認した。
primitiveと実process fixtureを実装し、関連試験は19件成功、失敗0件、新規4ファイルの構文確認も成功した。
[PR #362](https://github.com/ktysne/agent-cockpit/pull/362)の実装head `7a4e23f`で全体検証は2,930件成功、失敗0件、Windowsの実symlink試験2件skipだった。
指定Claude R1はblockerと要修正が0件で収束した。提案から自己待ちの検出範囲、診断nonce、実process試験の範囲を文書へ明記した。
PRは#360の後にマージする。実装と試験のソースを固定したまま、検証結果と文書明確化を記録する。
一般pathのW08、停止/ensureの方式、writer接続、W11の製品統合と両provider runtimeは後続のままである。
停止の前提調査で[Issue #361](https://github.com/ktysne/agent-cockpit/issues/361)を起票した。
serverとnative終了wrapperが失敗理由のtruthinessを判定するため、falsyなthrow/rejectを成功と取り違える。
通常serverの専有loopback fixtureでは5種類すべての初回/再closeがresolveした。native wrapperは静的確認のみである。
この修正はprimitiveと別PRへ分け、全writer停止通知の接続前に失敗の有無と理由を分離して検証する。

### shutdown失敗保持の修正

`codex/shutdown-falsy-failure-361-20261011`を最新feature `c731abe`から作り、PR #362の最終head `d3b79d5`を通常mergeした。
起点は`87890c0`で、S01〜S03の失敗理由とcleanup継続の期待値を実装前に記録した。
通常serverの失敗状態を理由から分離し、native server wrapperは既存のfailure captureを使う。
公開closeの形、終了順、診断値を維持し、起動失敗cleanupと標準native stopはこの修正に含めない。
起動失敗cleanupの追加shutdown理由にもtruthiness判定があり、falsyな追加理由をAggregateErrorへ含めない箇所を静的確認した。起動の元の失敗はthrowされるため、今回のclose成功への取り違えとは分けて後続で検証する。
関連試験は通常server87件とnative factory38件が成功し、失敗とskipは0件だった。変更4ファイルの構文確認も成功した。
[PR #363](https://github.com/ktysne/agent-cockpit/pull/363)の実装head `2ec748b`で全体検証は2,969件成功、失敗0件、Windowsの実symlink試験2件skipだった。
指定Claude R1はblockerと要修正が0件で収束した。提案は範囲と既存契約を確認し、実装変更を加えなかった。
PRは#362の後にマージし、#361の完了はfeatureへの取り込み後に照合する。

## 起票していない候補

調査で見つけたが、任意の最適化や計測前の性能案、将来の条件であるため Issue にしていないもの。
着手するときに Issue を起票する。

| 候補 | 出所 |
|---|---|
| capsule移行plannerの候補encode反復と全選択delivery走査を計測し、runtimeへ接続する前に最適化の要否を決める | PR #337のClaude R1任意提案。現状はpure処理で、計測と最適化は未実施 |
| 外側codecの結合検査で正規化とencodeを繰り返す費用を計測し、検証済み結果を内部で再利用する | PR #336のClaude R1任意提案。未検査値を信頼する公開入口は増やさない |
| 復元実験、拒否包含分析と質問保存のplain-data preflightを共通化する。例外分類と入力の上限の差を先に照合する | PR #333のClaudeレビュー提案。現在の検査経路は保つ |
| 隔離診断が呼ばれるたびに容量の予約量を計算し直す(標準起動へ接続する前に #209 で考慮する) | PR #293 の[コメント](https://github.com/ktysne/agent-cockpit/pull/293#issuecomment-6060612725) |
| 未知の kind のセッションを非対話として扱う(許可リスト化するか) | PR #306 の[コメント](https://github.com/ktysne/agent-cockpit/pull/306#issuecomment-6065761647) |
| 結果不明のときの「状態確認」の案内が全操作で同じ 1 文 | PR #252 の[コメント](https://github.com/ktysne/agent-cockpit/pull/252#issuecomment-6045370091) |
| main の全 worktree 探索のキャッシュ(計測後に判断) | PR #276 の[コメント](https://github.com/ktysne/agent-cockpit/pull/276#issuecomment-6056840655) |
| 設定変更で service を作り直す入口を足すときは、保存済み質問が隔離される契約を見直す | PR #290 の[コメント](https://github.com/ktysne/agent-cockpit/pull/290#issuecomment-6059799864) |
| native factoryの起動と後始末がともに失敗したときの上位error codeと表示。現在はAggregateErrorのcauseとerrorsで原因を保持する（標準起動の接続時に設計する） | PR #324の[Claudeレビューの任意提案](https://github.com/ktysne/agent-cockpit/pull/324#issuecomment-6081237323) |
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
| [停止結果codec](../design/stop-ensure-record-codec.md)、[限定result store](../design/stop-ensure-result-store.md)、[限定shutdown coordinator](../design/stop-ensure-shutdown-coordinator.md) | #313の製品管理protocolから独立した内部moduleとfixture |
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

指定Claude R2は要修正0件で収束した。childのcreated通知前に失敗した場合の未知rootは自動削除しない。
PR #328〜#345の17件はレビュー済みheadとmerge commitを統合ブランチで照合し、後続ブランチへ差分なしの通常mergeで取り込んだ。

### 停止結果codecの独立実装

停止全体のPR #364は3往復でも本文/適合表と未確認所有scopeの起動判断の2件が残り、Draftでマージ不可である。
推奨はscope新規launch禁止、管理者による検出とW09手動回復を定義し、適合表をそろえて追加レビューすることで、再開の判断を待つ。
初回の純粋codecには残存指摘の影響がないため、レビュー済み#363最終headを通常mergeした別branchで先行する。
未収束の#364は取り込まない。
[codec設計](../design/stop-ensure-record-codec.md)とC01〜C07の独立期待条件を実装前に記録した。
純粋codecと関連試験を実装し、IDの固定長を明示してBuffer実byte長の検査を補強した。関連17件と構文確認は成功した。
ブランチはcodex/stop-record-codec-313-20261011、PR #365のbaseはcodex/feature-codex-supportで、全体試験head `6884318`とtest補強後のレビューhead `7894492`をGitHubと照合した。
同headの全体試験は2,986件成功、失敗0件、Windows実symlink2件skipだった。
指定Claude R1はblocker0、要修正1件で、合法JSONによる4097 byte上限超過と偽装Bufferの反例を補強し、関連17件と構文確認が成功した。
全体試験headから製品src不変を確認し、test入力の補強だけのため全体は反復しなかった。
Claude増分R2はblockerと要修正0件で収束した。結果記録だけの最終追記ではsrc/testを変えず、全体試験と追加レビューを反復しない。
PR #365はマージ可能で、#363の後に取り込む。未収束#364は前提にせず、次はbounded result storeの内部fixtureへ進む。
ファイル保存、private controller、管理排他、ACL、tray/ensure接続、全writerと実providerは未実装または未確認のままである。

### 停止結果storeの内部fixture

最新featureからcodex/stop-result-store-313-20261011を作り、codec PR #365最終head aa48d7b115076bfc37ac7f269921781a6ddfa8d2を通常mergeした。
未収束PR #364は取り込まない。
[限定store設計](../design/stop-ensure-result-store.md)とR01〜R12を実装前に記録した。
AstraへFS失敗境界を相談し、close不明時のtemp削除禁止、short I/O、親消失の分類とlocal latchの容量境界を採用した。
Luna Maxへstoreとexpected-ID helperの実装を委譲し、編集停止後に差分を監査した。
関連44件、4ファイルの構文確認と差分checkは成功した。
実temporary rootで両kindの保存と読取りを確認し、fake filesystemで不明結果と限定cleanupを確認した。
PR #366のhead/baseをgitとGitHubで照合し、固定head `df4fdbd`で全体試験と指定Claudeレビューを行った。
npm test（process隔離、concurrency 2）は3,013件成功、失敗0件、Windows実symlink2件skipだった。
inprocess全体実行は出力停滞の調査後にrootが中断し、再開した出力を停止した判断が早かったため未完了として保持する。
単独の既存PR試験1件と同file153件は成功した。その結果で未完了の全体実行を合格にせず、同headの隔離全体試験で確認した。
指定Claude R1はblockerと要修正が0件で収束し、任意提案4件を判断した。
cleanupFailed:falseの意味、字句的path比較と設計の時点依存記述を文書だけで明確化した。
追加のread open/契約外I/O返値などの故障分岐試験は後続候補として残す。
結果記録と文言調整だけの最終追記ではsrc/testを変えず、全体試験と追加レビューを反復しない。
PR #366はマージ可能で、#365の後に取り込む。未収束#364は除外する。
次は単一instanceの内部shutdown coordinatorを別branchで先行し、手続き結果と通知結果を分けて検証する。
製品caller、管理protocol、ACL、一般filesystem、全writerと実runtimeへは接続しない。

### 停止手続きの内部coordinator

最新featureからcodex/stop-shutdown-coordinator-313-20261011を作り、PR #366最終head e18606c5aa377f3fb52b4ba6a4d69835ed357286を通常mergeした。
未収束PR #364は取り込まない。
[限定coordinator設計](../design/stop-ensure-shutdown-coordinator.md)とQ01〜Q10を実装前に記録した。
Astraへ先行範囲を相談し、手続きと通知の二軸、callback前の予約、falsy理由保持と自己待ちの限界を採用した。
通知自体が確認できない場合はnotification_unconfirmedとcleanupFailed:nullにし、storeの既知unknownと区別する。
Luna Maxがmoduleと関連試験の2ファイルを実装し、編集停止後に差分を監査した。
関連fixture試験36件と構文確認2件は成功し、失敗とskipは0件である。
CodeGraphで製品callerがないことを確認した。
PR [#367](https://github.com/ktysne/agent-cockpit/pull/367)をfeature向けDraftで作成し、固定head `1766a90` で全体試験と指定Claudeレビューを行った。
全体試験は3,049件成功、失敗0件、Windows実symlink権限によるskip2件である。
Claude R1はblocker0件、要修正1件で、callback内のassertが実装に捕捉されるテストを外側の観測値検証へ補強する。
実装本体の必須修正はなく、procedureが返すPromiseの信頼前提とfactoryのaccessor拒否試験も明確にする。
レビュー補強後の関連試験37件と構文確認は成功した。
全体試験のheadからsrcは不変で、testと文書の変更をClaudeの増分レビューで確認する。
補強head `6d629df` のClaude R2はblockerと要修正が0件で、2往復で収束した。
PR #367はマージ可能で、#366の後に取り込む。
最終変更は検証結果と文書の整理だけで、実装と補強済み試験は増分レビュー時から不変である。
次は停止設計の判断待ちに依存しない#311のMCP書き込み再送抑止へ進む。
製品停止、HTTP、既存public close、scope/current/attempt、ACLとwriter所有には接続しない。

### MCP書き込みの結果不明の再送抑止

最新featureからcodex/mcp-unknown-write-retry-311-20261011を作り、PR #367最終head `ec2c3b6d5a196bf0f36a4a09ea84dd02c9e48e32`を通常mergeした。
未収束PR #364を取り込まず、停止管理protocolから独立した#311へ進む。
Astraへ設計を相談し、MCP専用policy、fetch呼出し直前の開始境界、認証拒否後の既存retry維持を採用した。
[MCP結果不明の契約](../design/mcp-write-outcome.md)とM01〜M08の適合期待値を実装前に記録した。
Luna Maxが送信clientとMCPの接続、関連試験の4ファイルを実装し、編集停止後に差分を監査した。
同期fetch throw、JSON待ちtimeoutと401の既定policy対照、効果後の実HTTP切断も補強した。
関連試験48件と構文確認4件は成功し、失敗とskipは0件である。
両providerのwriter fixtureで効果後の切断とJSON解析失敗を確認し、POSTと効果はそれぞれ1回、追加ensureとrefreshは0回だった。
PR [#368](https://github.com/ktysne/agent-cockpit/pull/368)の固定head `f045d13` で全体検証と指定Claudeレビューを行った。
全体試験は3,060件成功、失敗0件、Windows実symlink権限によるskip2件である。
指定Claude R1はblockerと要修正が0件で、1往復で収束した。
開発者の連続作業をスタックする指示に従い、#367の後に積んでいる。
PR #368はマージ可能で、#367の後に取り込む。
最終変更は検証結果と文書範囲の明確化だけで、実装と試験は固定headから不変である。
既定readServerInfoは内部で失敗を捕捉するが、注入したreadInfoが401後にthrowした場合は保守的に結果不明へ分類する制限がある。
次は#312の表示墓標の件数、走査量と状態取得時間を、仕様を変えない専有fixtureで先行計測する。
実Cockpitの冪等性と両provider実runtimeの成功とは扱わない。

## 表示墓標の先行計測の現在地 (#312)

PR #368のレビュー済み最終head `1d5b51f` を最新feature起点の計測ブランチへ通常mergeした。
#368はReadyで、取り込み順は#367の後である。
停止全体の未収束PR #364は含まない。
[計測設計](../design/projection-display-baseline.md)とID-F312-D01〜D08の期待値を実装前に記録した。
Luna XHighが専用手動scriptと関連試験を実装し、rootが差分を監査した。
route計測からsinkのJSON解析を除外し、providerの曖昧性と同IDの別provider削除保持、CLI診断の補強後に関連5件と構文確認2件が成功した。
全15条件とCodex N sweep4条件の先行計測は完了し、N=10000、S/P各8では両providerとも160000 recordを訪問した。
時間と範囲は計測設計へ記録した。
固定headで全体検証と指定Claudeレビューを行った。
保持期間、容量、索引と回収条件は今回決定しない。
PR [#369](https://github.com/ktysne/agent-cockpit/pull/369)はReadyで、#368の後にマージ可能である。
固定head `2a9d84c` の全体試験は3,065件成功、失敗0件、Windows実symlink権限skip2件だった。
Claude R1の要修正1件で復元fixtureの書き戻し混入が見つかり、正規順と書き戻し0回の検査を加えた。
関連6件は成功し、全19条件の再計測後の値とscript hashを更新した。
旧計測値を正規store復元の証拠として採用せず、修正後の固定head `58e8615` を再検証した。
全体試験は3,066件成功、失敗0件、Windows実symlink権限によるskip2件である。
指定Claude R2はblockerと要修正0件で収束した。
最終変更は検証結果と計測対象の文書補足だけで、sourceとtestは再検証headから不変である。
次はレビュー済み#369を通常mergeして、保持条件を変えないsession別参照索引を実装する。

## 表示記録のsession索引の現在地 (#312)

最新featureからcodex/projection-display-index-312-20261011を作り、Readyの#369最終head `a890ee2` を通常mergeした。
未収束#364を含めない。
Astraの設計助言に基づきcanonical Mapの内部所有とsession別key Setを採用する。
[索引設計](../design/projection-display-index.md)とID-F312-E01〜E09を実装前に記録した。
診断getterはMapとrecordのcopyを返すため、返却Mapの変更でstateを変更する内部propertyの互換挙動は維持しない。
既知callerの読取りを維持する推奨案として自走中に仮採用し、PRで判断できる形にする。
保持条件を変えず、旧全件走査oracleとの一致と計測modelの更新を検証する。
Luna Maxがstate、内部collectionと独立索引試験を実装し、Luna XHighが計測toolと試験を更新した。
両担当の編集停止後にrootが監査し、関連84件と最後の空bucket補強試験1件が成功した。
旧基準と同じ19条件の再計測でmanifest、件数と保存byte数が一致した。
時間と索引構築の費用は索引設計へ記録した。
PR [#370](https://github.com/ktysne/agent-cockpit/pull/370)の固定head `3bfd407` で全体試験と指定Claudeレビューを行った。
全体試験は3,069件成功、失敗0件、Windows実symlink権限によるskip2件である。
Claude R1はblockerと要修正0件で収束した。
PR #370はReadyで、#369の後にマージ可能である。
最終変更は検証結果と文書の範囲補足だけで、src/test/toolsは固定headから不変である。
診断getterのcopy化は推奨を仮採用した内部互換境界であり、開発者にPRで確認してもらう事項として残す。
次はAstraの助言に基づき保持契約と反例fixtureを進める。
現在の認証や停止だけで古いsnapshotの再登場を永久拒否したとは扱わず、製品GCは追加しない。

## 表示記録の保持条件の現在地 (#312)

最新featureからcodex/projection-display-retention-312-20261011を作り、Readyの#370最終head `5adbf40` を通常mergeした。
Astraへ回収条件を相談し、現在の証拠だけでは一般GCの安全性を証明できないと確認した。
[保持契約](../design/projection-display-retention.md)とID-F312-R01〜R08をfixture実装前に記録した。
現在のstateとrouteで情報を忘れた候補との反例を検証し、製品回収と新しい世代拒否APIは追加しない。
#209の世代と表示identityの対応、永続拒否境界と#313の保存所有が後続の依存であり、未収束#364を採用した前提にはしない。
Luna Maxが反例fixtureを実装し、編集停止後にrootが監査した。
関連8件と、両providerへ補強した不在後再登場とhidden選好の関連2件が成功した。
PR [#371](https://github.com/ktysne/agent-cockpit/pull/371)の固定head `d57d84e` で全体試験は3,077件成功、失敗0件、Windows実symlink権限によるskip2件である。
指定Claude R1の文書要修正1件と任意の範囲補足を修正し、R2はblockerと要修正0件で収束した。
PR #371はReadyで、#370の後にマージ可能である。
src/test/toolsは全体試験headから不変で、製品GCと件数上限の解決は後続に残す。
次は#314の実Claude wait解放と次context取得の観測準備を進める。
fixtureを実runtimeの確認へ読み替えず、認証と専用rootの境界を確認して実測入口を準備する。

## Claude wait再接続の観測準備の現在地 (#314)

最新featureからcodex/claude-wait-reconnect-observation-314-20261011を作り、Readyの#371最終head `a51c944` を通常mergeした。
過去のignored実測harnessは現worktreeと元リポジトリに残っていなかった。
Astraへ既存APIでの実現性を相談し、通常wait ownerによる一回のsettleと独立したB観測を採用する。
[限定観測設計](../design/claude-wait-reconnect-probe.md)とID-F314-WRP01〜WRP08を実装前に記録した。
fixed profileの観測器と明示live実行器を準備し、製品の認可を緩めない。
失効後の拒否、Bなし、control未達は有効な未確認の結果として残す。
実CLIと通常認証の境界を監査し、停止を確認した自己rootだけをcleanupする。
実測と観測器のfixtureを分け、#314と#174の実runtime gateは完了扱いにしない。
実行前の環境監査でWindowsのHOMEPATHの先頭separator欠落を再現し、[#372](https://github.com/ktysne/agent-cockpit/issues/372)へ記録した。
既存owned runnerとversion childのhome指定を補正し、両providerのfake-spawnで結合値を検証してからliveへ進む。
Luna MaxとLuna Highの編集停止後にrootが監査し、専用fixture18件を含む関連277件が成功した。
構文確認4件と差分検査も成功し、無spawnのpreflightで既知CLIの存在を確認した。
baseline proof欠落と観測終了後callbackの直接fixtureは未確認として残す。
固定headの全体試験と指定Claudeレビュー後に実測し、実runtime結果を別に記録する。
PR [#373](https://github.com/ktysne/agent-cockpit/pull/373)の初回固定head `db648b9` は全体3,095件成功、失敗0件、Windows実symlink権限によるskip2件だった。
Claude R1の要修正3件を反映し、再接続前の有効性と切断・接続の成立を必須にした。
通知は単一listenerで数え、製品callbackの戻り値を維持する。
専用fixtureは補強後19件成功し、修正後の固定head `b4c5e69` の全体試験は3,096件成功、失敗0件、Windows実symlink権限によるskip2件だった。
Claude R2の要修正1件は切断・接続失敗分岐の未確認記載であり、提示された文書補足案をAstraへ相談して採用した。
sourceとtestを維持した文書補足をR3で確認し、blockerと要修正0件で収束した。
PR #373はReadyで、#371の後にマージ可能である。
Claude 2.1.296の隔離live観測を固定head `b441088` で一度行い、controlで次contextとfresh current proofを確認した。
reconnectは旧handle失効と通常settle拒否を確認したが、90秒以内に次contextは到着しなかった。
両processのexit・close、childとendpointの非稼働、自己root削除を確認した。
実response writeは未観測で、観測器のobserved分類を#314の完了へ読み替えない。
manifestと観測範囲は限定観測設計に置き、再接続後の進行方法は後続に残す。
最終更新は検証と実測結果の文書のみで、src/test/toolsは全体試験headから不変である。

## 質問登録の保存後失効の現在地 (#210)

最新featureからcodex/question-registration-cancel-210-20261011を作り、Readyの#373最終head `abe949b` を通常mergeした。
Astraが現行registerの保存後再検証失敗と、正規接続復帰後に自動回答候補へ戻り得る経路を確認した。
旧Issue本文で診断された再起動時の質問隔離とstate表示全体の例外は既対応であり、今回の対象に含めない。
[保存後失効と取消の設計](../design/question-registration-cancellation.md)とID-F210-QRF01〜QRF06を実装前に記録した。
初回保存成功後の再検証失敗だけを同queue内で取消し、補償保存の未知結果はblockして配送0を維持する。
既存period gate、予約とcapsule、旧質問quarantineを維持し、保存権限を緩めない。
gate閉鎖のservice fixtureと実kernelの競合、実provider適合は区別する。

QRF07を追加し、取消済み同ID・同内容の再登録を既存question_cancelledで拒否する。
通常取消にも適用し、未取消duplicateのexisting成功と内容不一致の先行拒否を維持する。
関連123件と固定source head `572e628` の全体3,116件が成功し、失敗0件、Windows実symlink権限のskip2件だった。
指定Claude R1の再登録成功誤認を修正し、R2の旧schema文書の未取消条件を補正した。
指定Claude R3はblockerと要修正0件で収束した。
PR #374はReadyで、既存Readyスタックの#373の後にマージ可能である。
最終更新は現在地と検証結果の文書のみで、src/test/toolsは全体試験headから不変である。
MCP409文言の取消理由の粒度不足、実provider適合、登録履歴全体の再照合は後続に残す。
次は#212の注入registry構成で終了済み登録の不在保護を解除する修正へスタックして進む。
