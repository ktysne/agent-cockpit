# Codex対応をmainへ採用する前の実runtime確認計画（2026-10-08）

この計画は、fixtureで検証したCodex対応をfeatureへ集約した後、mainへ採用する前に残る実runtime確認を進めるための資料である。
起点は、main同期PR `codex/sync-main-259-20261008` の上に作成する計画PR `codex/plan-a-runtime-gates-20261008` である。
起点はfeature `6b071e1` とmain `3a7f007` の通常mergeである。
実runtimeの版とhostは、試験時に確認して追記する。
この計画の作成だけでは製品実装、runtime試験、Issue完了を意味しない。

## 現在地と次にやること

fixtureで検証した変更をfeatureへ集約し、実runtime確認をfeatureからmainへの採用条件にする判断は開発者が2026-10-08に決定した。
実runtimeの記録はfixture記録と分け、実行していない組合せを成功と扱わない。

計画の確認後、最初に製品のcomposition入口と既存試験が実際に通る経路を調べ、必要なruntime操作、ログ、証拠の採り方を各Issueの完了条件に合わせて確定する。
機能未接続や試験手段不足が見つかった場合は、接続実装とruntime確認を分けた差分案を作り、計画確認後に着手する。

## 決定済みの判断

2026-10-08に開発者が決めた案Aは、fixtureで契約を検証した変更をfeatureへ集約し、実runtime未確認をfeatureからmainへの採用条件として残すことである。
この計画だけでは#175、#211、#216、#217を閉じず、fixture合格を実runtime合格に読み替えない。
決定の正本とG2/G4の境界は[本実装計画の決定済み判断](../design/codex-implementation-plan.md#決定済みの判断)に置く。

## 対応順序、ブランチ、PR

| 作業順 | 対象 | 作業 | ブランチとPR | 完了の判断 |
|---:|---|---|---|---|
| 1 | compositionと試験能力 | 各機能の製品起動経路、設定供給元、既存fixture、実runtimeで観測できる証拠を対応づける。未接続箇所、認証、隔離HOME、テスト境界を記録する。 | 計画PR `codex/plan-a-runtime-gates-20261008`。変更が要る実装は計画確認後の別PRとする。 | 各ゲートの操作が製品入口を通り、観測結果と期待値を照合できる。 |
| 2 | #211 | 128件上限の境界、製品からの明示停止、停止確認、遅れて届くresolvedを確認する。 | feature向けの別PR。Issueは閉じない。 | 129件を実runtimeに要求せず、fixtureと製品境界試験で上限を確認する。代表的な実runtime待ちを停止し、後続要求が誤解除されないことを確認する。 |
| 3 | #216 | trusted設定の供給元、既存デザインを使う製品導線、製品composition、Claudeのlegacy経路との二重登録・二重配信を確認する。 | feature向けの別PR。Issueは閉じない。 | モデルが指定した値ではなく開発者の設定だけが自動適用を有効化し、両経路が同じ質問を重複登録・配信しない。 |
| 4 | #175 / ID-F08-NS09 と Claude native検出 | 実Codexで質問待ちと許可待ちを再現し、実Claudeでnative要求の検出を確かめる。 | feature向けの別PR。Issueは閉じない。 | native状態が対象実行に一致して表示され、許可は元UIで行われる。質問待ちと許可待ちの結果を別々に記録し、許可待ち未観測ならNS09全体を未確認とする。質問待ちの成功で代替しない。 |
| 5 | #217 | 実Codexで通常指示のACK確定後から、同一turnの適用証拠が届くまでの時間と台帳の遷移を測る。 | feature向けの別PR。Issueは閉じない。 | 相関器の60秒証拠待ち期限でunknownを通知し、その後、試験打切り（ACK確定から30分または対象turn終了の早い方）前に、同一turn・delivery・本文の証拠でunknownからappliedへ進む。ACK未確定、不一致の証拠では進めず、再送0回。 |
| 6 | #209、#210、#212、#218 / G2・G4 | 容量予約と回収、再照合後のcheckpoint処理、collector復帰証拠と指示projection、currentProofと再接続、質問応答と通常指示の横断適合、PoCの最終除去条件を照合する。 | main向け最終PRの準備段階。削除・package/test対象変更は承認済み条件の範囲で行う。 | 永続化と復旧の安全条件、G2/G4、対象runtimeの条件がそろい、未確認事項が採用範囲から残っていない。 |

次の表は2026-10-08時点のスタック状態である。
最新のPR状態はGitHubを正本として確認する。

| 取り込み順 | ブランチとPR | base | 状態（2026-10-08確認） |
|---:|---|---|---|
| 1 | `codex/sync-main-259-20261008` / #261 | `codex/feature-codex-support` | レビュー2往復で収束。#259の同期と #262 の修正。merge `feb3af4` で集約済み。 |
| 2 | `codex/plan-a-runtime-gates-20261008` / #263 | `codex/feature-codex-support` | レビュー3往復で収束。計画の明示承認を確認。merge `d079203` で集約済み。 |
| 3 | `codex/native-capacity-stop-211-20261008` / #269 | `codex/feature-codex-support` | 容量保留と物理停止の確認条件を実装。Claudeレビュー2往復で収束しDraft解除。fixture全体2146/2146成功。実runtimeは未確認。 |
| 4 | `codex/native-owned-stop-api-211-20261008` / #273 | `codex/native-capacity-stop-211-20261008` | 六項目の停止対象照合、旧配送の分離、後継開始の確認を製品HTTPへ接続。Claudeレビュー2往復で収束しReady。実runtimeは未確認。 |
| 5 | `codex/native-stop-mock-211-20261008` / #274 | `codex/native-owned-stop-api-211-20261008` | 採用済みモックと製品画面を同じ判断カード・ボタンへ整合。画面関連fixture216/216成功。製品HTMLの表示、停止確認、送信抑止、下書き保持をfixtureで確認。Claudeレビュー2往復で収束しReady。 |
| 6 | `codex/sync-main-272-20261008` / #276 | `codex/native-stop-mock-211-20261008` | main b62ba98を通常mergeし、HTTP route factoryへCodex対応を適合。先行UI/APIとの全体fixture2184/2184成功。設計・差分監査で必須修正なし。レビューの最新結果と収束headはGitHubのコメントを正本とする。 |
| 7 | `codex/plan-common-question-composition-216-20261008` / #279 | `codex/sync-main-272-20261008` | 設定と注入用factoryの計画。Claudeレビュー2往復で収束。開発者が段階1・2を承認。 |
| 8 | `codex/sync-main-278-20261008` / #282 | `codex/plan-common-question-composition-216-20261008` | main 85403b2のPR集計分割を取り込み、多段スタックの安全条件を保持。関連fixture203/203成功。 |
| 9 | `codex/common-question-settings-216-20261008` / #284 | `codex/sync-main-278-20261008` | 既定OFFの専用設定、revision照合、保存後の通知を実装。標準起動と画面への接続は対象外。 |
| 10 | `codex/common-question-composition-216-20261008` / #286 | `codex/common-question-settings-216-20261008` | 共通質問を同じregistry/storeへ明示注入。専用fixture18/18と既存関連31/31成功。fresh registryの再起動条件は#283で未達として追跡。 |

#216の段階1・2は[開発者の承認記録](https://github.com/ktysne/agent-cockpit/pull/279#issuecomment-6057424235)に従う。
注入用factoryのfixtureでは両providerの登録・回答・一度だけの配送を確認するが、実runtimeは未実施である。
fresh registryで保存済み質問を読み込む再起動はbinding照合で拒否されるため、段階2の再起動条件は未達である。
未選択と選択済みの反例で、両journalとshared checkpointのbyte列が保持されることを確認する。
復旧は[#283](https://github.com/ktysne/agent-cockpit/issues/283)で追跡し、#216を閉じない。
復旧方式の選択肢と推奨案は[保存済み共通質問の復旧計画](2026-10-08-common-question-recovery-plan.md)に記載する。
この復旧計画は提案段階であり、方式の確認後に実装する。
#283の復旧契約を設計・検証し、fresh registryの再起動条件を満たすまで、共通質問を標準起動や設定画面へ接続するPRに着手しない。
設定画面と標準起動への組込み、厳密な横断二重登録防止、native権限の変更には別の設計判断を残す。

開発者は下から通常mergeで取り込み、次段のbaseがfeatureへ付け替わったことを確認してから進める。
以後の実装PRは、計画確認後に最新featureまたは開発者指定の直前PRを起点にする。
実際のPR番号、head、base、SHAはGitHubとGitで確認した値だけを記録する。
PRのマージは開発者が行う。
mainには#272のクロスレビュー状態を他worktreeから取得する修正に加え、#268/#270のHTTP route factory分割が入っている。
同期PR #276で、Codex側の状態投影、hook writer認証、質問・指示・所有実行停止のAPI経路を分割後の構成へ適合した。
#211の変更とは別の同期PRで通常mergeし、featureからmainへの最終差分で取り込み漏れを確認する。

## 実runtime計画

### providerごとの必須確認

次表の「必須」はmain採用前にそのproviderで確認する範囲を示す。
全行の実runtime確認は未実施であり、fixtureの合格を必須runtime確認の代わりにしない。
「仕様上不要」は該当Issueの対象外という意味であり、別の共通適合条件を免除しない。

| 機能 | Codex | Claude | 実runtime状態と境界 |
|---|---|---|---|
| ID-F08-NS09のnative質問と許可待ち | 必須 | 仕様上不要。このscenarioはCodex固有。 | 未実施。Claudeのnative検出は次の行で確認する。 |
| 実Claudeのnative要求検出（#175、接続前提#207） | 仕様上不要 | 必須 | 未実施。起動順修正後のClaude runtime結果が必要。 |
| #211のCodex ID保持上限 | 必須 | 仕様上不要。#211本文の不具合対象はCodexの`usedNativeRequestIds`である。 | 未実施。Claude owned waitの別の128件寿命上限は#174/#175の採用確認へ残す。 |
| 製品からのnative待ち実行の明示停止 | 必須（#211、Codex owned runner） | 共通製品停止の適合対象（Cockpitが起動・所有した実行のみ） | 未実施。対象processの物理停止をproviderごとに確認し、一方の成功を他方へ流用しない。外部起動またはbridge所有の実行はClaudeの停止対象外とする。 |
| #216の共通質問とopt-in導線 | 必須 | 必須。legacy質問経路を変えない。 | 未実施。両adapterの登録元、適用時設定、重複防止を個別に照合する。 |
| #217のACK後60秒超の入力証拠 | 必須 | 仕様上不要。Issueが要求する実runtimeはCodexである。 | 未実施。ClaudeのfixtureはCodex runtime gateの証拠にならない。 |
| 通常指示の配送、G2/G4の共通境界 | 必須 | 必須 | 未実施。受付と適用、再接続とcurrentProof、質問と通常指示をproviderごとに記録する。 |

必須範囲と実行結果は別に記録する。
結果は成功、失敗、未実施または観測不能に分け、未実施や観測不能が残る必須項目をmain採用済みと扱わない。

### 実行前の接続と証拠の確認

対象ソースのSHA、製品の起動入口、設定値の由来、既存テストの初期化、実runtimeへ届く観測点を先に特定する。
fixtureが内部関数を直接呼ぶ場合は、製品compositionを通る検証とは分けて記録する。
遅延適用試験の前に、対象adapter接続で`recoverAfterExpiry`が`true`となる条件を確認する。
`false`の場合、現行仕様では期限後の回復が成立しないため、試験を合格扱いせず仕様判断待ちとする。

各試験記録に、シナリオID、provider、runtime名と版、OS、hostの識別子、Cockpit source SHA、scriptと結果のhash、fixtureまたは実runtimeの区分、手順、観測結果、合否を残す。
host名などの個人情報は共有用記録で伏せ、認証情報、質問本文、ローカルの秘密パスを保存しない。
未確認や観測不能は `unknown` として記録し、失敗や成功へ読み替えない。
sanitizeしたsummaryとmanifestは `docs/evidence/` の追跡対象かIssue添付へ残し、レビューで再照合できるようにする。
raw frame、token、実際の質問や入力本文は共有用証拠に含めない。

### #211の上限、停止、resolved

**上限**は実runtimeに129件の要求を生成させず、fixtureと製品入口を通る境界試験で127件、128件、129件相当を確認する。
次の表は、2026-10-08に開発者が承認した代替仕様の期待値である。
件数はpending件数ではなく、同一実行世代でIDの再利用を防ぐために保持する詳細記録数とする。
解決済みの要求も保持件数に含み、byte単位の保存予約は#209の試験と分ける。

| 条件 | 保持件数 | IDの残枠 | 期待する動作 |
|---|---:|---:|---|
| 重複しないIDを127件受信 | 127 | 1 | 上限例外によるrunnerの異常終了なし。未解決のnative待ちがある間は追加指示を送らない。 |
| 128件目を受信 | 128 | 0 | 上限内で詳細を保持し、待ちの解消を推測しない。 |
| 129件目相当を受信 | 128 | 0 | 詳細記録を追加保持せず、定数サイズの容量超過保留を表示する。runnerの上限例外による異常終了と追加指示の配送は0回。 |
| 容量超過後のresolved、turn終了 | 128 | 0 | 容量超過保留を解除せず、同じ実行への送信を再開しない。IDの再利用防止記録を上限回避のために削除しない。 |
| 開発者による明示停止 | 旧世代を隔離 | 新世代で128 | 旧processのexitとclose、非稼働、旧イベントの分離を確認した新しい実行だけが新規受付できる。 |

この案は寿命累計の上限到達でrunnerが落ちることを防ぐ代替仕様であり、turn単位の回収による連続運転を達成したとは扱わない。
現行のresolvedはturn IDを含まないため、turn終了だけでID集合を消すと、同じthreadで再利用されたIDを遅い通知が誤解除するおそれがある。
回収による連続運転を採用する場合は、その識別を保証する方式を先に検証する。
本案の#211完了条件への採用は[開発者の明示承認](https://github.com/ktysne/agent-cockpit/pull/263#issuecomment-6054884939)で確認し、Issueへ記録した。
容量超過の文言と操作は、採用した既存の保留カードを踏襲する案を `mock/index.html` に示し、開発者が表示を確認してから `src/web/index.html` に反映する。
runnerの保持ID上限、web/mockのnative pending件数上限、managed transportの未完了RPC上限など、128件の上限はそれぞれ別であり、同じカウンターとして扱わない。
#211の実装PRでは、ID再利用防止記録`retiredOwnedWaitRequests`が容量上限に達した場合の挙動も確認する。
実runtimeでは通常発生する少数のnative待ちだけを扱い、境界件数の証拠とは分ける。

**明示停止**は、#211の対象である実Codexのowned runnerがnative要求を待っている代表実行から行う。
共通製品停止の適合として、実ClaudeではCockpitが起動・所有した実行を停止する。
外部起動またはbridge所有の実行はCockpitの停止対象外とする。所有の判定は#207担当と照合する。
Cockpitの既存デザインに沿う停止操作が対象実行を指すことを確認し、停止後にprocessのexitとclose、および非稼働を観測する。
終了証拠は対象contextと照合し、同名または後続実行の終了を取り違えない。
statusや保留レコードの削除だけでは物理停止の証拠にしない。
停止に失敗した場合、または対象との一致を確認できない場合は、送信と再送を保留する。

**遅延resolved**は、既知の待ちを失効させた後にresolvedを遅らせ、同じ実行に後続待ちを作ってから到着させる。
遅い通知が失効済みの要求だけを消費し、後続待ちを解除せず、未知または不一致の通知が送信保留を解除しないことを確認する。

### #216の設定、導線、composition

接続差分の段階と確認事項は[共通質問の設定と製品接続の差分案](2026-10-08-common-question-composition-plan.md)に置く。

設定値は開発者が制御するtrusted sourceから読み、モデルが質問本文やtool引数で申告する値を採用しない。
設定の既定値と有効化方法を製品の設定導線で確認し、既存デザインの質問カードを使った操作を記録する。

製品の標準起動から質問を登録し、推奨自動適用が既定offであること、明示opt-in後だけ設定が作用することを確認する。
同じ問いがlegacyのClaude `decision-answers.js` と新しい共通経路に同時に登録または配信されないことを、質問IDと配信台帳の観測で確かめる。
既存Claudeのlegacy設定と離席動作を変更する場合はこの計画から拡張せず、別の判断とIssueを必要とする。

### #175の実Codex質問・許可とClaude native検出

**Codexの質問待ち**は、実Codexで判断を必要とする質問を出し、本体が回答待ちになる操作で再現する。
自然文で質問を出すだけではnative要求の証拠にならないため、実際のserver requestを観測できる能力と操作を先に確認する。
同一実行の待ちの種類と件数、下書き保持、追加指示の保存と送信の拒否を製品HTTPと画面で確認する。
繰り返しGETで要求を消費しないこと、元のUIでの解決後も現在bindingを再検証できない間はunverifiedを保つことを確認する。
owned app-serverで本人が回答できる元UIとの接続は未確認である。
回答者との接続が確認できない場合は、自然文入力や別接続から解決を推測せず、送信保留と明示停止だけを確認して、回答による復帰は未確認として残す。
質問本文や回答機能がnative待ちの種別と件数から推定されていないことも確かめる。

**Codexの許可待ち**は、本体が許可を求める操作で再現する。
現行owned runnerのnever/read-only固定では許可待ちの再現能力を証明できない。
製品runnerの `approvalPolicy: 'never'` と `readOnly` は維持し、通常の起動入口から権限を広げない。
専用profileを作る場合はtest harnessだけから選べる形にし、製品入口、モデル引数、通常設定から選べないことを実装PRで確かめる。
試験は隔離HOMEと隔離cwdで行い、tool実行sandboxのネットワークを無効にし、隔離cwd内の無害な固定操作を一つだけ許す。
本人認証とmodel APIへの通信は、toolのネットワーク権限とは分けて試験の接続条件に記録する。
外部pathの変更、任意コマンド、通常HOMEの認証情報の複製を禁止する。
隔離HOMEの認証は本人が別途ログインして用意する。今回の計画と実行では新規ログインも試験profileの起動もしない。
専用profileで要求が出ても、製品がnative要求を観測できる証拠にはならない。ID-F08-NS09の製品gateは通常の製品compositionで質問と許可の待ちを観測できるかを別に確認し、未観測は未確認とする。
専用profileを実装するPRでは、`docs/design/owned-native-wait-profile.md` に製品の固定never/read-only契約との違い、選択境界、隔離条件、NS09との関係を追記する。
要求のschemaと能力が確認できなければ、未確認としてゲートを残し、Cockpit独自の `cockpit_wait` を成功の代わりに数えない。
Cockpitが通常指示を保留し、許可操作が元のCodex画面に残ることを確認する。
Cockpitから許可を出せる経路や、許可待ちを質問応答で解除する経路があれば不合格とする。

**Claudeのnative検出**は、実Claudeで権限または質問を必要とする操作を行い、対象セッションのnative待ちと正規bindingがCockpitに現れるかを確認する。
Claude担当の #207 の製品経路と観測能力を照合してから行い、writerの実装を重複させない。
以前のClaude記録は起動順修正前の結果であるため、修正後のruntime版とsource SHAを記録して再実施する。
検出できない場合は、未検出の観測点と原因候補を記録し、既存の実行を消したり新たな許可を代行したりしない。

### #217の60秒超過、ACK、遅延適用

実Codexで、無害な固定の処理を計画案として90秒以上同じturnで継続し、その開始後早い時点に通常指示を一度送る。
処理時間だけで遅延証拠が届くとは仮定せず、60秒以内に証拠が届いた場合は遅延gateを未確認とする。
実runtimeで自然に遅れて届いた証拠と、harnessで人工的に配送を遅らせた結合試験の結果は区別し、後者だけで実Codexの遅延gateを確認済みにしない。
計測の起点は、対象deliveryのACK確定を観測した時刻とする。
到着時刻は、同一turn、同一要求、同一本文に対応するnative入力証拠を受け取った時刻とする。

#217の遅延適用gateでは、相関器の60秒証拠待ち期限で台帳がunknownを記録し、その後、ACK確定から実時間で60秒を超え、試験打切り前に、同一turn、同一delivery、同一本文に完全一致する適用証拠でunknownからappliedへ進むことを確認する。
到着時刻だけで合格にせず、適用証拠の保存、台帳の状態遷移、送信回数と再送0回を照合する。
ACK確定前に期限を越えた試験は無効とし、そのdeliveryを再送しない。
ACKから60秒以内に証拠が届いた場合、通常の適用は記録するが、遅延適用gateは未確認のままとする。
相関器の証拠待ち期限まで証拠が届かない場合は `unknown` と記録する。試験打切りまでに適用証拠を確認できなければ、遅延適用gateは未確認のままとする。

試験打切りは計画案として、ACK確定から30分、または対象turnの終了時刻の早い方とする。
この上限は計画の承認後、実装と試験を始める前に確定する。
期限後に同じdeliveryを再送せず、再試験は別の明示したexecutionで行う。
観測したACK時刻、証拠時刻、runtime turn、delivery ID、本文hash、状態遷移、再送回数を記録する。
ACK未確定、別turn、別source、本文不一致の証拠では台帳をappliedへ進めず、全ケースで自動再送が0回であることを台帳とruntime入力で照合する。

## #218で維持する最終準備条件

承認済みの旧PoC 8ファイルを含む `poc/` 全体除去、`tools/probes/common-question-runtime.js` と `test/common-question-runtime-probe.test.js` の除去、`npm test` と `npm run test:inprocess` の `test/**/*.test.js` への対象指定、本文SQLiteの隔離HOMEとcleanupを最終main PRの準備条件として維持する。
これらは今回の計画PRでは削除または変更しない。
PoCの固定SHA参照は証拠として残し、製品実装済みの根拠にしない。

G2は実接続、再接続世代、currentProofの失効をruntimeで確かめる。
G4は質問の固定宛先、owner保留、late answer、通常指示とのtransport分離、受付と適用の区別を保つ。
横断確認は両providerの適合を機能単位で記録してから行い、未実行のproviderやruntimeを同等と扱わない。

#209では、unknownから許される遷移と保持証拠が増やす最大量を予約し、件数、予約量、残容量、閾値を診断する。
確定記録の保持と、再送を防ぐ墓標の寿命を区別し、sendingやunknownを時間だけで回収しない。
128件のowned request ID枠は#211の別上限であり、byte予約と合算しない。
#210では、不完全な会話を再照合した後のcheckpoint更新と、復旧後の同じstartの扱いを確かめる。
#212では、既存collectorの復帰証拠と指示projectionの接続条件を確認し、確認できない復帰を配信可能として扱わない。

| Issue | fixtureでの証拠 | 製品境界での証拠 | 実runtimeでの証拠 | 実装から独立した合格条件 |
|---|---|---|---|---|
| #209 | 合成した記録で、予約上限、保持証拠の最大量、終端本文の7日保持、再送防止墓標の保持、sending/unknownの非回収を検証する。 | 標準compositionから件数、予約byte数、残容量、閾値を診断する。閾値到達時は新規受付を抑え、進行中記録の確定に要る予約を維持する。 | 隔離HOMEで代表的な実runtime記録を作り、unknownを再送せず保持する。実providerが不要な容量境界をruntime件数で代替しない。 | 予約量が許された遷移と証拠の最大量を覆う。閾値、容量不足時の抑止、墓標保持はfixtureと独立の仕様値で判定する。 |
| #210 | 不完全conversationの再照合後に`incompleteConversationIds`から除かれ、同じstoreを新kernelで開いて同じstartを再送しても保存が恒久拒否されないことを確認する。 | 標準起動経路でCockpitの隔離storeを復旧し、journal、checkpoint、同一startの扱いを観測する。 | 実providerで作った未完了sessionを再起動後に再照合し、旧期間へ再送しない。実runtimeが起動できない場合はunknownのまま残す。 | 対象conversationとcheckpointの差分を固定し、再照合前後のID集合、保存結果、delivery再送数0を照合する。 |
| #212 | currentProofに結び付くsnapshot watermarkとterminal境界で、replay、再gap、古い世代の証拠を拒否する。 | 製品collectorの復帰経路でsnapshotからprojectionまでのwatermark、terminal状態、指示projectionを観測する。 | 対象providerを再接続し、currentProofを持つ復帰snapshotだけがprojectionへ反映されることを確認する。未接続providerは未実施と記録する。 | 接続世代、snapshot watermark、terminal記録、指示projectionの相関を保存前後で照合する。公開しないnative IDは共有証拠で別名またはhashにする。 |

別repositoryや通常HOMEへの変更は、対象、導入手順、cleanupを明記し開発者が確認した後に行う。
bridge側の正本、契約、試験が必要な変更はCockpit側だけで完了としない。
関連する外部repositoryは `claude-codex-bridge` である。
Cockpitの #171/#180 とbridge側Issueの対応は確認対象とし、bridge側Issue番号は未確認である。
Claude担当の #207 は標準起動、既存writer、native検出の責任を維持し、Codex担当は同じClaude registryや不在判定を重複実装しない。
必要なbridge側の変更は対応するrepositoryとIssueを確認し、外部repositoryの変更が未確認の間は関連ゲートを完了にしない。

## 承認と残る判断

#283の保存済み共通質問の復旧は、[開発者の明示承認](https://github.com/ktysne/agent-cockpit/pull/290#issuecomment-6059866678)によりA案を採用する。
service初期化時に読み込んだ全質問を隔離し、旧質問の回答と再送を禁止する。
保存構造の検査と現在の認可を分離し、現在のregistryに旧権限を復元しない。
共有checkpointの既存の保守的な復旧遷移は維持するが、availableへの復旧だけで隔離質問の配送を許可しない。
実装とfixtureの確認は実runtimeでの再起動成功とは区別する。
隔離記録が容量を占有する問題は#209で回収条件を満たすまで残り、#216の標準起動と設定画面への接続を止める。
詳細は[保存済み共通質問の復旧計画](2026-10-08-common-question-recovery-plan.md)を参照する。

計画の順序と合格基準、および#211の代替仕様は、2026-10-08の[開発者コメント](https://github.com/ktysne/agent-cockpit/pull/263#issuecomment-6054884939)で明示承認された。
容量超過時の保留と、明示停止を確認した新世代での受付再開を#211の完了条件とする。
turnごとの回収による連続運転は、resolvedでturnを識別できる方式を確認するまで対象外とする。
PRのマージだけを計画の承認として扱わない。
計画PRを差し替えた場合は、元の承認が対象とした内容と差分を新PRに示し、内容が変わる判断は明示確認を取り直す。
新しい停止表示は、既存カードを踏襲するモック案を表示確認した後、開発者がチャットで「この形を採用する」と明示承認した。
停止対象の確認、停止未確認中の送信抑止、下書き保持を製品へ反映する。
仕様と表示の承認は、実runtimeの成功確認を意味しない。
runtimeの版、host、利用可能な機能、認証状態は、確認時点で記録するまで未確認である。
観測不能をscope縮小や安全条件の緩和で解決しない。
製品のnever/read-onlyを維持したままNS09の許可待ちを観測できない場合は、main採用ゲートを未確認として残す。
採用範囲から外す判断や、製品profileの権限を変更する判断は、その時点の能力と影響を提示して開発者が別に決める。

## 落とし穴

- native待ちはCodexまたはClaude本体の本人操作待ちであり、Cockpitから許可を与える意味ではない。
- `unknown` を手動で消して再送できるようにすると二重入力を防げないため、停止確認とunknown解除を同じ操作にしない。
- 128件上限は実モデルに大量要求を出させず、fixtureと製品境界で確かめる。
- fixture、product composition試験、実runtime試験は異なる証拠であり、結果を合算して実runtime成功としない。
- 既存の実Codex run4の `unknown` を消去または成功へ書き換えない。
- Claudeの既存実測は起動順修正前であり、修正後の実runtime結果として流用しない。
- 実行寿命の上限、墓標、容量予約を増やす試験は、通常HOMEや既存の保存記録を再利用しない。
- 汎用stack-checkは既定ブランチmainを前提としてfeature集約を警告する。採用ゲートを満たす前に、その警告だけを理由に作業PRのbaseをmainへ付け替えない。

## 次のセッションの開始用プロンプト

```text
docs/handover/2026-10-08-runtime-gates.md と docs/design/codex-implementation-plan.md を読み、まず最新のfeature/main、PR #263、#218、#175、#211、#216、#217の状態をGitHubとGitで照合してください。開発者本人のPRコメント、またはチャットから転記された明示確認がPR #263に記録されているか確認し、マージだけなら未承認として実装とruntime試験へ進まないでください。承認後、製品compositionと既存テストが実際に通る経路、設定のtrusted source、runtimeで観測できる証拠を特定してください。fixture、product composition、実runtimeの結果を分け、provider別完了表で未実施を成功に数えないでください。#211の128件境界はfixtureと製品境界で確かめ、実モデルに129件を要求しないでください。native待ちの許可は元のCodexまたはClaude画面で行い、停止確認はprocessのexitとclose、非稼働と対象contextの一致で確かめてください。PRをマージしないでください。
```
