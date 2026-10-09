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

独立した作業PRは最新のfeatureを起点にfeatureをbaseにする。
未マージの変更に依存する後続はレビュー済みheadを起点にし、その親ブランチをbaseにする。
連続する作業はスタック式に積み、開発者が下から通常 merge で取り込む。
マージ可能になった時点で通知し、マージ待ちで止まらず後続を積む（2026-10-09の開発者指定）。
親のマージ後に、親headがfeatureの祖先であることを確認してから後続PRのbaseをfeatureへ移す。
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
| 9 | #209 段階3と段階4 | 本文回収、自動実行、世代集約 | [#325](https://github.com/ktysne/agent-cockpit/pull/325)、[#326](https://github.com/ktysne/agent-cockpit/pull/326)、[#327](https://github.com/ktysne/agent-cockpit/pull/327)、[#328](https://github.com/ktysne/agent-cockpit/pull/328)（base: feature）、[#329](https://github.com/ktysne/agent-cockpit/pull/329)（base: #328）、[#330](https://github.com/ktysne/agent-cockpit/pull/330)（base: #329） | 質問と通常指示の本文回収はfeatureへ集約済み。#326のmerge SHAは`598c218`。PR通知とresultは#327でfeatureへ集約済み（merge `ea908c2`）で、全体2,389件成功・1件skip（head `f589250`）。Claude R1の引き継ぎ表修正と拒否理由の試験補強を反映した。R2の任意提案を反映し、Claude R3でblocker・要修正0件に収束した。最終試験差分`ac1b2d4`と同じ内容でnative5件成功。明示grant解放は#328で実装し、Claude R1の必須指摘を修正、R3でblockerと要修正0件に収束した。全体2,442件成功・1件skip（head `dfd536b`）、最終assert補強の関連4件成功（head `7a473c7`）。質問journal局所停止は#329でClaude R3に収束し、全体2,485件成功と1件skip、最終補強のnative16件とpersistence20件成功を確認した。既定offの自動実行は#330でレビュー収束。全体2,525件成功と1件skip（source `a787e89`）、最終補強の単体19件成功（`4f69c03`）。段階4の拒否包含分析は[#331](https://github.com/ktysne/agent-cockpit/pull/331)（base: #330）でレビュー収束。全体2,528件成功・1件skip（head `bab5d51`）。拒否索引候補から既存grave形へのpure復元実験は[#332](https://github.com/ktysne/agent-cockpit/pull/332)（base: #331）でClaude R2に収束。全体2,544件成功・1件skip（source `3937095`）、R1試験補強の関連12件成功（`2e05f46`）。単体recordの相関検査とbyte上界は[#333](https://github.com/ktysne/agent-cockpit/pull/333)（base: #332）でClaude R2に収束。全体2,562件成功と1件skip（source `b9b15fb`）、R1補強のbyte試験7件成功（`9506be4`）。単体Q/CP capsule codecと選択ペアは[#334](https://github.com/ktysne/agent-cockpit/pull/334)（base: #333）でClaude R3に収束。修正後の全体2,596件成功、1件skip（source `060f516`）。試験補強`f2b84fb`は関連15件成功。通常recordとcapsuleの全体検査は[Draft #335](https://github.com/ktysne/agent-cockpit/pull/335)（base: #334）で検証中。全体2,619件成功と1件skip（source `22bb7de`）、関連18件とadmission 6件成功。永続化にはcodec、容量上界、保存とcold、件数枠の条件を別々に満たす |
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
後続の独立入口は、`codex/question-capsule-whole-validation-209-20261010`の[Draft PR #335](https://github.com/ktysne/agent-cockpit/pull/335)で実装し、検証中である。baseは#334である。
通常recordと複数capsuleを宣言された順序で復元し、全体ID、logical集合、履歴とnative相関の再利用、アンカー退役を検査する。
通常CPの全論理墓標から選択contextを導き、復元raw snapshotのreadyと同じrawストアの自己遷移checkedを、どちらも理由0件で要求する。
実保存byteと将来予約量は各slotのencoderとmeasurerで別途検査し、アンカーの退役予約も通常上限へ照合する。
既存件数と将来予約を含む通常容量の上限を維持し、同じ操作IDを共有する複数chunkもrecordの全体一意性で検査する。
契約は[容量回収計画](../design/codex-capacity-reclamation.md#通常recordと複数capsuleの全体検査)に置く。
`22bb7de`で関連18件とadmission 6件が成功し、全体試験は2,619件成功、1件skip、失敗0件だった。
指定に従いClaudeのクロスレビューで検査する。
保存接続、cold復旧、件数枠の解放と実runtime確認は未実施である。

## 起票していない候補

調査で見つけたが、任意の最適化や計測前の性能案、将来の条件であるため Issue にしていないもの。
着手するときに Issue を起票する。

| 候補 | 出所 |
|---|---|
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
