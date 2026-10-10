# Claude/Codex適合試験

## 目的と対象

ClaudeとCodexで同じ結果を期待するCockpit機能は、機能を実装するたびに適合試験を追加する。
適合試験は各関連IssueとPRの完了条件にする。
全機能の実装後に、両runtimeを接続する横断統合試験を行う。
最初に全機能分の試験基盤を作り切らず、実装対象に合わせて段階的に増やす。

この文書が扱うのは、両providerで共通結果を期待するCockpit側の機能契約である。
LLMが生成する文面や、providerの能力差そのものは同等性の対象にしない。
CLI、アプリ、daemonの版を厳密に一致させず、検証に使った版と確認した能力を記録する。
runtime更新後は、代表的な接点を再試験する。

Issue #184の共有契約文書は状態遷移の参照モデルである。
参照モデルの合格は、実adapterや実runtimeの適合を証明しない。
[共有契約](codex-shared-contract.md)を参照する。

## 機能ごとのシナリオ定義

実装開始前に、対象機能について共通結果、仕様上許容する差、未確認を区別する。
Claude側とCodex側で適用する共通シナリオには共有IDを付け、関連Issue、観測点、期待値、許容差、能力条件を定義する。
期待値は仕様、合意済みモック、または明示した製品要件から決める。
片方の実装をもう片方へコピーした結果や、両者の出力比較だけを期待値の根拠にしない。

| シナリオID | 機能とIssue | 区分 | 能力条件 | 操作 | 観測点と期限 | 共通期待値 | 許容差 | 禁止副作用 |
|---|---|---|---|---|---|---|---|---|
| ID-F12-D01 | provider別の共通質問・指示projection表示 (#247) | Cockpitの共通結果 | Claude/Codexのregistrationと一致する質問・指示snapshot fixture | 合成行を非表示・復元・削除し、削除後にsnapshotが消えるケースと新しい検証済みstate writeを確認する | HTTP応答、GET `/api/state`、保存済み表示記録、実session状態と終了callback | 操作対象のprovider表示だけを変える。削除tombstoneは後から消えたprojectionで解除せず、削除より新しい検証済みstate writeだけで解除する。対象取得に失敗した変更操作は503で状態を変えず、GETは利用可能な実rowを返す | native ID、session ID、時刻はprovider fixtureごとに異なる。実runtime適合は別途確認 | projection操作から実session削除、終了callback、他providerへの変更、authorityまたはdeliveryの変更を起こさない |
| 実装前に機能ごとに定義 | 対象機能と関連Issue | 共通結果、仕様差、未確認 | 実行条件 | 入力と操作 | 状態・宛先・期限 | 仕様に基づいて実装から独立に定める | 意味を変えない差だけ記載 | 起きてはならない副作用 |

### 中断の表示 (#221)

`ID-F12-I01` は、合意済みモックの「中断」を製品画面で確認するシナリオである。
Claude/Codex の投影が `status: '中断'` または `turnState: 'interrupted'` を返すことを能力条件とする。
親の中断を与え、通常表示と「終了を隠す」が有効な表示を確認する。
次の描画で親の行が「中断」と表示され、待機中や終了した行に分類されず、終了した記録の削除対象にも入らないことを期待する。
子だけが中断した場合は、親の状態を変えず、子には既存の稼働と終了の表示を使う。
画面の終了操作後に非稼働となった子は、終了した行として扱う。
provider の識別子や時刻の差は許容するが、表示の操作から実行の停止や再開を送ることは許容しない。
更新の無い行を時間経過で隠す設定は別の表示条件として維持する。

投影 fixture とブラウザでの表示確認は、実 runtime から中断を検出できることの証明には含めない。
実 Claude/Codex のイベントを通す確認は、main 合流前の runtime 適合試験に残す。

| 対象 | 表示 fixture | adapter からの中断検出 | 実 runtime |
|---|---|---|---|
| Claude | `status: '中断'` を使う UI 試験 | この UI 修正の確認対象外 | 未確認 |
| Codex | `turnState: 'interrupted'` を使う UI 試験 | この UI 修正の確認対象外 | 未確認 |

ClaudeとCodexの両方が対象機能を実装するまでは、未実装側を未確認とする。
未確認を成功や同等と扱わない。
段階的な開発はできるが、共通結果を期待する対象機能は両adapterがシナリオに合格した時点で同等対応完了とする。

## 検証層

適合試験は次の三層で構成する。

| 層 | 確認内容 | 成功の意味 |
|---|---|---|
| 共通コア | providerに依存しない状態遷移、配送台帳、保存形式 | 共通ロジックがシナリオの期待値に合う |
| 両adapterを通す共通適合 | 同じシナリオをClaude adapterとCodex adapterへ適用する | 両adapterが共通機能契約を満たす |
| 少数の実runtime試験 | 実際のClaudeとCodexへ接続し、代表接点を確認する | 記録したruntime版と能力条件で接続・観測できた範囲を確認する |

共通コアの成功だけでadapterやruntimeの適合を主張しない。
fixtureを使った試験と実runtime試験の結果を分けて記録する。
機能の実装中は対象に関わる層を追加し、全体完成後に横断runtime統合試験を行う。

## TaskStopと終了通知

TaskStopの成功イベントは、stoppedTaskIdが一致するClaudeサブエージェントだけを終了扱いにする。
transcriptはnative session IDで読み、合成した終了イベントは表示用session IDへ適用する。
窓口配下のbackground Codexがactive=false, unconfirmed=trueになった状態は、実プロセス停止や結果受信の確認を意味しない。
fixtureではflatとnested native eventの成功IDが同じsanitize結果になり、失敗、他tool、不正ID、直接Codex行が状態を変えないことを確認する。
実runtimeは未確認であり、適合試験の成功に含めない。

## 観測する不変条件

各シナリオは、入力だけでなく処理中と処理後の観測点を定義する。
対象機能に応じて、次の事項を検証する。

- 意図した会話、実行、通知先へだけ配信する。
- 送信回数と状態遷移が期待値に一致する。
- 保存と復旧後も宛先、世代、配送結果を誤って復活させない。
- 禁止した副作用は0回である。
- 途中の取消、handoff、終了、再接続後も不変条件を保つ。
- transportの受付とruntimeでの入力適用を別の結果として扱う。

誤配信、重複、送信後の応答喪失を、単に最終画面の一致だけで合格にしない。
元の宛先、送信回数、状態履歴、禁止副作用も検証する。

## 差の正規化とイベント順

非決定なIDや時刻は、比較に必要な範囲でだけ正規化する。
意味のある状態差やunknown状態を正規化で消さない。
無害な固有イベントの到着順を一致させる前提にしない。
必要な観測点、期限、順序制約をシナリオの契約として定義する。

## シナリオの選択

対象機能に必要なケースを選び、実害のある差の再発でシナリオを追加する。
すべての機能へ一律に不要なケースを網羅しない。
候補には正常系、誤配信、重複、取消前後、送信後の応答喪失や再起動、owner handoff、旧期間と新期間の分離がある。
適用しない候補は、その機能の契約上不要である理由を記録する。

## provider別projection表示

ID-F12-D01は、共通質問と指示の検証済みprojectionに対する表示設定を扱う。Claude/Codexそれぞれのfixtureで非表示・復元・削除を確認し、同providerの実rowがある場合も削除はprojection表示だけに作用する。providerの起源が複数または不明な実rowと重なる対象は変更を拒否する。

古い・unknown event、session fileの再走査、projection取得中の失敗は削除tombstoneを解除しない。snapshotまたはregistryを取得できない間のhide/unhide/deleteは503で状態を変えず、GETは200を返して他の表示を維持する。新しい検証済みstate writeだけが、同providerのtombstoneを解除する。

HTTP適合fixtureは[test/server-projection-display.test.js](../../test/server-projection-display.test.js)で19件、保存形式と旧store復元は[test/state-persistence.test.js](../../test/state-persistence.test.js)の対象テスト1件が成功した。実Claude/Codex runtimeでの表示・削除動作は未確認である。

## 共通質問の推奨自動適用

`ID-F08-A01/A02`では、ClaudeとCodexの同じ質問状態に対して、trusted opt-inの登録時固定と適用時確認を検証する。
5分以上の最短待ちが質問期限を短縮しないこと、離席開始時刻、登録状態と現在接続中actorのbinding、手動回答との直列化も検証する。
期限前の一時的なbinding不成立でpolicy期限timerを維持し、期限後は30秒ごとに再確認して、binding回復後に手動tickなしで仮選択することも検証する。
離席開始時に期限と一致または経過した質問は、opt-in有効でも対象外とする。
許可や承認の要求、nativeの待機には共通質問MCPを使用しない。
Claudeのnative `AskUserQuestion`も既存hook経路で扱い、共通MCPへ再登録しない。
MCPモデル引数にopt-in設定を持たせない。
trusted設定の供給元は[専用設定モジュール](common-question-settings-module.md)で定義し、[native integrationの注入用factory](native-instruction-service-integration.md)から明示的に渡せる。
製品の標準起動と設定画面への接続は未実装で、製品既定はoffである。
共通service fixtureでの合格は製品MCP compositionや実runtimeでの接続証拠ではない。
Claude legacy経路と共通質問経路には共有native source keyも排他的producer選択もないため、厳密な横断重複防止は未達として追跡する。

設定モジュールの保存、revision、不正状態の試験はproviderに依存しないunit fixtureであり、Claude/Codexの実runtime適合結果には数えない。
`test/common-question-composition.test.js`では両providerのfake owned processと製品HTTPを通し、検証済みwriterの登録、手動回答、一度だけのanswer-poll配送を確認する。
質問サービスと指示サービスが同じregistryとcheckpoint storeを使い、質問の回答を通常指示adapterへ書き込まないことを期待値とする。
設定のunsafe状態、Promise、例外では自動適用をOFFにし、終了時には設定通知を解除してから質問と指示のserviceを閉じる。
これは注入用factoryのfixtureであり、標準起動の接続、MCP producerの実動作、実runtimeの成功を示さない。
#286の隔離復旧採用前のfixtureでは、fresh registryで未選択と選択済みの保存質問を読み込むとbinding照合に失敗した。
その反例で起動拒否と両journalおよびcheckpointのbyte列保持を確認した。
現在の隔離復旧の契約と期待値は次の節に定め、旧質問の再開能力と実runtime確認は別に残す。

## 保存済み共通質問の隔離復旧

期待値は[承認した復旧計画](https://github.com/ktysne/agent-cockpit/blob/8c701b1e8a5718eccff69f84775f21171b6663d0/docs/handover/2026-10-08-common-question-recovery-plan.md)から定める。
次のscenarioはClaudeとCodexの製品adapter、共通質問serviceと実ファイルstoreを組み合わせるfixtureで検証し、実runtimeの結果は別に記録する。
fresh registryでのnative factory再生成と共有資源のcleanupは、注入用factoryのcomposition試験で別に確認する。

| ID | 入力と操作 | 独立した期待値と禁止副作用 |
|---|---|---|
| ID-F08-QR01 | 未選択と選択済みの質問を保存してfresh registryで初期化する | 保存構造が正当なら起動し、保存済み全質問を隔離する。authority復元、旧質問の自動適用と配送は0回。 |
| ID-F08-QR02 | 隔離した質問へ回答、tick、answer-poll、保留変更、取消、外部解決、応答喪失とlate answerの読出しを試す | 旧記録の変更、新規intent、配送再生成、payload復元とtrustedSink呼出しは0回。安全な診断で操作不可を示す。 |
| ID-F08-QR03 | 同じkeyを再登録し、同じsessionとpublic questionIdを新しい検証済みperiodIdで登録する | 旧keyを解除しない。新periodの別keyだけ受付する。同じbindingが後から現れても旧質問は隔離のまま。 |
| ID-F08-QR04 | 保存記録の対応表の全行、不正schema、digest不一致と重複を初期化する | intentあり配送なしは保持して再生成しない。孤立配送、記録間の矛盾と不正構造は起動拒否。 |
| ID-F08-QR05 | 質問のavailable、claimed、sending、accepted、unknownと通常指示を同じcheckpointへ保存して初期化する | 共有checkpointの既存claimedからavailable、sending/acceptedからunknownへの復旧、revision増加と生存状態の安全な復元を許容する。起動snapshotと保存byte、後続保存後の差を分け、質問の新規配送と自動再送を0回にする。 |
| ID-F08-QR06 | 隔離記録を保持して上限まで新規受付し、保存失敗とservice再生成を試す | 記録と予約を保持し、上限は安全な理由、件数、予約量と残容量で診断する。再生成で隔離を解除しない。初期化失敗と終了時は共有資源を解放する。 |

容量回収は#209の別条件であり、隔離だけで連続運転を保証したとは扱わない。
隔離復旧を含むservice試験は41件、composition試験は20件、両providerの製品適合試験は32件が成功した。
compositionではClaudeとCodexの未選択・選択済み質問をfresh registryで読み直し、隔離と共有資源の解放を確認した。
QR03〜QR06のprovider別検証は製品adapter、serviceと実ファイルstoreの経路であり、native factoryの実runtimeを起動した結果ではない。
実Claude/Codex runtimeの隔離復旧は未実施である。

## 旧保存形式の移行と容量予約

#209の段階2では、独立した移行coordinatorと実ファイル保存層を組み合わせる。
期待値は[アンカー保存契約](question-reclamation-anchor.md)から定める。
以下は後続のサービス接続も含む期待値の定義であり、全項目をこの段階で確認済みとはしない。
ClaudeとCodexの相関を持つ旧形式を同じ保存手順へ通し、provider固有adapterと実runtimeの適合とは区別する。
新形式を明示したservice compositionの期待値は次節で定める。
native factoryと製品起動へ接続する試験は後続の実装範囲である。

| ID | 入力と操作 | 独立した期待値と禁止副作用 |
|---|---|---|
| ID-F08-RC01 | 満杯の旧形式を、質問と通常指示の相関を持つ3slotで移行する | 全writerの同期停止とdrain後にsourceを固定し、拒否情報、operation ID、起算時刻、grantを保持する。本文回収と新規配信は0回。 |
| ID-F08-RC02 | 各anchor phase、各slotの置換前後、再読取、completedからnullの間で保存を失敗させ、新instanceで再開する | 保存済みsourceか固定targetを保持し、固定順のprefixだけを復旧する。同じoperation ID、時刻、指紋とgrantを使う。結果不明のinstanceからは再開しない。 |
| ID-F08-RC03 | アンカー欠落、破損、store ID不一致、必須slot欠落、不可能prefixを与える | writerを停止し、空ファイルの補完、sourceの削除、自動再初期化と旧writerへのfallbackを行わない。 |
| ID-F08-RC04 | stop、drain、再開準備を失敗させ、並行startとcloseを行う | 全writerへstopを適用し、共通gateは全再開準備の成功後にだけ開く。失敗したinstanceのstartを再試行に使わない。 |
| ID-F08-RC05 | raw byteと将来予約がB+Gを超える設定、移行前後の予約不足を与える | Hを許容量へ流用せず停止する。予約resize失敗時は旧予約を保持し、null保存の確認後にだけpost予約へ縮小する。 |
| ID-F08-RC06 | 全slot未作成から初期化し、部分作成後に停止する | 完全初期化ではdataを先に、anchorを最後に保存する。部分new schemaと欠落anchorを再初期化せず、保存済みファイルを保持して停止する。 |
| ID-F08-RC07 | manifestをnullにして再起動し、既存grantと満杯の件数を検査する | grantを自動で消さず、通常枠への収束と新規受付を移行成功だけで許可しない。時刻、操作IDと失効期間を再発行しない。 |

容量budgetはcompositionが供給する論理予約であり、OSの空き容量や保存成功を保証しない。
ENOSPCとrename後の例外でも保存済みファイルを保持して停止することを試験する。
同一保存先の排他起動は前提であり、プロセス間writer排他は#313の別範囲である。
実装済みの試験は[移行coordinator試験](../../test/reclamation-migration-coordinator.test.js)、[容量予約試験](../../test/reclamation-capacity-reservation.test.js)、[保存層試験](../../test/reclamation-persistence.test.js)にある。

| ID | この段階で確認する試験と範囲 | 後続で確認する項目 |
|---|---|---|
| RC01 | `both providers complete a linked three-slot migration with fixed grants at source-sized limits`。Bをsource実byteに設定し、両providerの相関、失効とgrantを確認 | サービスの本文回収と新規配信の呼出回数。現在はどちらにも接続していない |
| RC02 | `every durable anchor and slot boundary fails closed and recovers only the persisted prefix`。5段階のanchorと3slotの各保存前・保存後・再読取、合計24故障境界を確認 | 実runtimeでの停止と復旧 |
| RC03 | 必須slot欠落、store ID不一致、破損anchorと無効prefixを拒否する各試験 | 製品起動時の診断表示 |
| RC04 | `a stop exception still stops and drains every writer without reading or writing storage`、drain失敗、再開準備失敗、close競合とsnapshot個別cloneの試験 | 製品writerへの停止範囲の接続 |
| RC05 | B+Gを超えるraw／将来予約、開始予算不足、bridge resize失敗、null再読取失敗時のlease保持を確認する各試験 | 通常受付guardとの接続 |
| RC06 | `empty first creation writes configured data slots before the anchor and opens the gate last`と部分初期化拒否の試験 | 部分初期化停止時の製品診断 |
| RC07 | 保存故障境界試験のnull保存後の再起動でgrant、操作IDと起算時刻の保持を確認 | 満杯の件数と新規受付の判定はPR3のguardで検証 |

symlink拒否は注入fixtureでも検証し、実symlinkを作成する権限が無い環境では実ファイル試験をskipする。
ここに列挙した確認範囲だけを移行fixtureの成功とし、serviceの受付guardと実Claude/Codex runtimeの結果は別に記録する。

## 新形式serviceの質問期間guard

ClaudeとCodexの完全identityを持つ質問service、delivery store、instruction serviceを同じアンカーcontextへ接続する。
既定形式の経路は既存試験を維持し、新形式は明示したbackendとperiod gateを使用する。
このfixtureはnative factoryや実runtimeの起動を含まない。

| ID | 入力と操作 | 独立した期待値と禁止副作用 |
|---|---|---|
| ID-F08-RG01 | 冷起動中に公開操作を行い、stop、drain、prepareResumeから新形式を設置する | 冷起動の操作は受理せず、全準備の完了後だけ受付する。readyとdrainの循環待ち、旧形式へのfallbackを起こさない。 |
| ID-F08-RG02 | 旧期間を失効させ、同identityとperiodでactor、generation、launchを変え、新しいtrusted期間も登録する | 旧期間の全質問操作と直接delivery操作を拒否する。新期間の受付は既存の認可と通常容量を満たす場合だけ許可する。 |
| ID-F08-RG03 | queue投入後、保存前、sink直前に対象期間の失効を開始する | 取得済みtokenを失効させ、古い操作から保存とnative送信を起こさない。送信開始済みの結果不明をunknownのまま保持する。 |
| ID-F08-RG04 | live退役のanchor、checkpoint、質問journalの各保存前後と再読取を失敗させ、新instanceを作る | anchorを先に保存し、保存済みの失効時刻と相関を保持して許可された冷起動修復だけを行う。anchor保存前に失敗した場合は冷起動時刻で隔離する。失敗したinstanceから書き続けず、新配信を生成しない。 |
| ID-F08-RG05 | creatingで停止した配信の有無、合法なcacheの遅れ、不可能な作成段階とcheckpointの組を保存する | 存在する完全相関のcheckpointへ照合し、作成有無が不明ならindeterminateを保持する。作成済み必須記録の欠落や不正相関を正常へ読み替えない。 |
| ID-F08-RG06 | 独立墓標、満杯の通常予約と件数、固定grant対象の既存記録を同居させる | 墓標とreservationを件数と予約量へ含めて新規受付を止め、ID再利用を拒否する。Gは対象となる既存遷移だけに使用し、本文やgrantを削除しない。 |
| ID-F08-RG07 | 質問と同じcheckpointに通常指示、PR通知と別期間の質問を保存し、live退役と後着通知を行う | 対象質問だけを失効させ、他の記録とinstruction journalのcreating状態を変えない。通常指示とPR通知の完全相関による遅延更新を維持し、terminalAtを再発行しない。 |

drainは受理済みのローカルqueue操作の完了または無副作用の拒否までを扱う。
外部sinkのPromise完了を待つことや、失効によるnative取消の保証は含めない。
質問cacheは質問serviceが更新し、delivery storeから別journalへの保存を行わない。
`test/reclamation-service-conformance.test.js`は、実ファイルのpersistence、新形式context、質問・配送・指示service、provider delivery adapterを組み合わせ、Claude・Codex各7件、計14件で成功した。
RG02の旧期間拒否と同identityの新期間受付、RG03の保存待ち中の失効と外部sink Promise、RG06の独立墓標・内部ID再利用・件数上限、RG07の別期間保持・通常指示とPR通知の後着更新・instruction.creatingを確認する。
期間gateのunitは完全identityとperiodだけを失効キーとし、actorとownerGenerationを入力に含めない契約を確認する。
同periodのactor・ownerGeneration差替えを実サービスで再登録する試験は、この結果に含めない。
RG01、RG04、RG05と固定grantの容量判定は、contextと各serviceの関連試験で確認する。
`test/reclamation-service-context.test.js`は33件で成功し、RG04の9保存境界を両providerで検証する18件を含む。
故障後に同じ製品registrationとlaunchを使い、新しいpersistence・context・実サービスを起動して、ready、失効時刻と静的相関の維持、旧期間の拒否、追加sinkと追加保存が0件であることを確認する。
instructionのnative adapterは未構成で、既存の製品registration・launch fixtureと固定verifierを使用する。
native factory、実Claude/Codex runtime、native instruction adapterの適合は、このfixtureの成功から推定しない。

## Codex native pendingの表示

`ID-F08-NS09`はCodex nativeの質問要求と許可要求をCockpitで表示するシナリオである。
Codexのowned runnerが受け取った要求を製品HTTP経路へ通し、実storeを使うfixtureで確認する。
共通期待値は、待機中の指示作成と送信が0回であること、HTTPに種別と件数だけを含めること、下書きを保持することである。
HTTP、safe snapshot、UIには要求本文、request ID、item ID、内部revisionを公開しない。
同じ状態への繰り返しGETは要求を消費せず、pending中は新しい指示の作成と送信を拒否する。
pendingが消えた後も、現在のownerとnative contextを再確認できない場合は`unverified`を維持する。
Claude nativeの質問要求と許可要求はunsupportedまたは未確認として扱い、Cockpit独自の`cockpit_wait`をこのシナリオの成功に数えない。
回答や許可の製品APIは追加せず、fixtureの成功を実runtimeの能力や質問への回答完了の証明に拡張しない。

HTTP経路は[実factoryのCodex fixture](../../test/native-instruction-service-http-target.test.js)で確認する。
runnerの件数投影と置換時失効は[runner test](../../test/owned-native-runner.test.js)、入力保持と通知は[web test](../../test/instruction-web.test.js)と[render test](../../test/web-render.test.js)で確認する。
このcheckpointでは関連6ファイルのin-process test 260件が成功した。
実Codex runtimeは未実施であり、Claude native waitはunsupportedまたは未確認である。

## owned process停止の適合

`ID-F08-NS13`は、CodexとClaudeのowned processを製品経路から停止する共通シナリオである。
対象の実行が明示的な停止を受けた後、authority失効と物理停止の状態を別々に観測する。
runner snapshotでchildのexitとcloseを両方確認し、owned childがinactiveになった場合だけ停止済みとする。
exitのみ、closeのみ、killのfalse返却、kill例外、または未生成を証明できないspawn errorは停止未確認を維持し、同じ実行への送信を許さない。
停止を確認できない間は元の実行に紐づく後続受付を許さず、停止確認後の新世代だけで受付を再開する。
CodexとClaudeのfake child fixtureでevent順序と失敗時の状態を確認する。
runtime確認では、owned childのexit後に子孫processが継承stdioを保持し、closeが遅れるかを記録する。
exit後もcloseが届かない場合は停止未確認を維持する。
stdioを強制的に閉じてcloseを作っても子孫processの終了証明にはならないため、停止確認には使わない。
このfixtureは実runtimeにおける製品の停止操作や子プロセス終了の証拠ではなく、両runtimeでの確認は未実施である。

製品画面では、合意済みモックと同じ判断カードで停止対象を示し、開いた確認の六項目を固定して停止APIへ送る。
`test/owned-execution-stop-web.test.js`で、診断欠落、古い確認の409、停止後に遅れて届く旧snapshot、停止未確認、下書き保持を検証する。
表示件数は要求IDの保持量と区別し、複数の所有実行を別の対象として確認する。
停止確認後も旧実行の送信を再開せず、停止状態をカードと追加指示欄で一致させる。
停止確認画面は製品HTMLを表示するfixtureで確認する。画像`.cross-review/211/product-stop-confirm.jpg`はGit管理外のローカルの一時記録であり、別のcloneでは参照できない。
継続して参照する確認結果は[Codex対応の引き継ぎ資料](../handover/codex-support.md)の「実 runtime 確認の計画」に文章で残す。
このfixtureは停止APIの応答を模擬するため、実runtimeのowned child停止や物理停止の確認とは区別する。

## 実行と結果の記録

自動適合試験は既存の npm test 経路へ統合する。
CIがある場合は同じ経路から実行する。
実runtime試験の未実行、失敗、skipを自動試験の成功に含めない。
PRには対象シナリオID、関連Issue、ClaudeとCodexそれぞれの結果、共通期待値、仕様差または非該当理由、fixtureと実runtimeの区別を記録する。
実行したruntime版と能力条件、未確認の理由、担当Issue、採用前に確認する条件も記録する。

## featureをmainへ提出する前の条件

featureをmainへ提出する前に、採用対象の共通機能について両adapterの適合試験、必要な実runtime接点試験、横断runtime試験の成功を確認する。
採用対象に残す機能の未確認項目は解消する。
未確認項目を残す場合は、開発者が承認した対象範囲の縮小または代替仕様によって採用対象から外し、理由、担当Issue、確認条件を記録する。

## 質問と追加指示の画面の適合

既存の判断事項カードを使う画面の期待値は、合意済みモックと[指示配送の画面契約](instruction-delivery.md#画面の保存要求と復旧)から定める。
`test/instruction-web.test.js`、`test/common-question-web.test.js`、`test/common-question-mock.test.js`、`test/web-render.test.js`で製品とモックの実装関数を通す。
この画面の試験はproviderの実runtimeへ送信せず、native質問への回答や許可能力の実証には含めない。
複数宛先の操作は、`mock/index.html?state=instruction-multiple-targets`で確認できる。
この確認例だけ、同じ実行期間に異なる実行先を2件用意し、選択前の保留から保存前の明示再確認までを再現する。

| ID | 入力と操作 | 独立した期待値 |
|---|---|---|
| UI-QI01 | 単一選択、複数選択、自由記入を含む質問を表示する | 既存の選択肢と回答欄の構造を使い、質問ごとの入力と検証を維持する。既存判断事項の選択解除も維持する |
| UI-QI02 | 一意な実行先を持つ追加指示を入力し、複数候補でも明示選択する | 一意なら宛先と送信方法を表示し、選択肢が一つのプルダウンを出さない。複数なら未選択から始め、明示選択した候補だけを下書きに固定する。保存だけでは送信しない |
| UI-QI03 | 編集後に対象の実行、世代、状態、turn、送信方法を変更した状態を受信し、その後元の状態へ戻す | 表示中と非表示中とも、下書きを保持して明示確認まで保存を止める。元の状態に戻っても自動再開せず、候補未選択や対象なしでは再開しない。候補追加や並べ替えで選択対象を変更しない |
| UI-QI04 | 質問待ち、許可待ち、状態不明の投影を表示する | 入力は保持し、保存と送信を保留する。待ちの種類と件数から回答や許可の操作を作らない |
| UI-QI05 | 保存済み指示と送信結果不明の指示を表示する | 本文を確認できる保存済み指示だけ明示送信を許す。送信結果不明には再送を出さず、保存済みの宛先と送信方法を変えない |
| UI-QI06 | 質問と指示の機能を未構成にする | 件数チップ、質問カード、追加指示の入力欄を表示しない |

## ACK確定後の入力証拠の適合

`ID-F08-NI14`はACK確定後に観測期限を超えて届く入力証拠を扱う。
ClaudeとCodexのadapter fixtureで、期限後のunknownから完全一致の証拠を保存してappliedへ進め、native writeが1回のままであることを確かめる。
未使用capabilityは60秒で失効し、ACK未確定の5秒タイムアウトは回復対象にしない。
終端、source失効、不一致で受付を閉じ、未知のcapabilityや古いsource tokenの閉鎖操作を拒否する。
保持中のunknownも件数と入力予約の上限を消費し、終端で予約を回収する。
閉鎖通知のない既存ownerは従来の60秒回収を維持する。
この結果はfixtureでの適合確認であり、両providerの実runtimeで60秒超の入力通知を観測した証拠にはしない。
実runtimeの確認は横断統合試験に残す。

## actor生存とcontext認可の適合

#171-Bと#180-Aでは、main actor、canonical period、owned processの生存とcontext認可を別々に観測する。
共通scenario ID-F04-B04、ID-F04-N06〜N14は両製品registration、launch、runtime adapterを通し、context終端、fresh context、owner chain、確定source失効、unknown connectionを検証する。
独立した期待値、観測点、期限、禁止副作用は[codex-runtime-binding-core.md](codex-runtime-binding-core.md)と[native-launch-composition.md](native-launch-composition.md)で定義する。
fixtureの成功は、real runtimeでの長寿命main actorや同periodの複数contextの実証へ合算しない。
送信開始保存後のpayload認可は、opaque handleとowner chainを同期検査するcomposition facadeを採用条件にする。
送信開始保存中のcontext失効はID-F05-N01で、両providerの実file storeとdelivery adapterへ固定trusted facadeを注入して確認する。
葉のraw kernel proofが単独で有効でも、ancestor chainが失効したときはpayload sinkを0回に保つ。
復旧後のunknownは自動再送せず、追加のcontextStateを保存schemaへ取り込まない。

ID-F04-N13のcontext callbackは両providerで同じraw authority失効を拒否する。
固定wait返信はCodexのowned runnerとfake pipeを通すfixtureであり、実modelやログイン後runtimeの能力を証明しない。
Claude waitは明示された`claudeWaitProfile`と`ownedSourceClaim`を持つowned経路に限り、[Claude wait契約](owned-native-claude-wait.md)の境界に従う。
owned sourceのないgeneric profileはunsupportedのままであり、共通callback試験の成功だけでClaude wait能力を主張しない。

ID-F04-N14とID-F05-N02では最後のancestor callbackからのraw葉失効を両providerで検査する。
canonical revisionとprivate proof capabilityの最終検査はcallbackを呼ばず、失効後のproof返却とpayload sinkを0回に保つ。

## 隔離質問の本文回収の適合条件

#209段階3の質問回収は、両providerの明示native factory、実ファイル保存、質問serviceと共有checkpointを通すfixtureで確認する。
processとnative event transportはfixtureに置き換えるため、実runtimeの適合結果には合算しない。

| scenario | 入力と境界 | 期待する結果 |
|---|---|---|
| QR-B01 | 退役期間の未選択、配信未作成、不確定、available、unknown、確定終端 | 保持期限前は本文を残す。期限到達後に準備、対応配信の墓標、質問詳細削除を順に保存し、配信stateと結果種別を変えない |
| QR-B02 | 3保存境界それぞれの書込み前と、保存後の返却失敗 | 再送を止める。保存済み準備があれば再起動後に同じ操作IDで再開し、準備前の失敗では本文を残す |
| QR-B03 | 回収済み質問と配信detail、準備なし質問と配信墓標、相関不一致 | 起動と回収を拒否し、配信を新規作成して補わない |
| QR-B04 | 回収後の同じ質問ID、共通key、attempt、後着通知 | 退役gateまたは墓標で再利用を拒否する。後着操作は退役gateが先にquestion_quarantinedで拒否し、全processの追加native writeを0回に保つ。墓標件数と移行grantを保持する |
| QR-B05 | 保持期限のoverflow、時計逆行、closeとの競合 | 安全な期限を判定できなければ本文を保持する。close後の新しい保存を拒否する |

QR-B04の後着通知は、providerで限定されたstoreのacceptedとapplied操作を直接呼び、退役gateが墓標判定より先にquestion_quarantinedで拒否することと保存不変を確認する。
墓標によるdelivery_reclaimedの拒否は、この経路では到達しない。
実runtimeから古い通知が到着することは、この試験では確認しない。
QR-B05は、質問準備と配信墓標を保存した後の時計逆行による延期も含み、質問欄が整合不良と表示されないことを確認する。

この接続の書込み結果不明時は既存の全writer停止を維持する。
質問writerだけを停止する分離、自動実行、通常指示とPR通知の回収は別の適合条件として残す。

## 実runtimeの回帰記録

sourceSHA `6151af8f3b557db4c99e20a5a077e55927b0f3a2`で全体npm testは1421/1421件が通過し、fail、cancelled、skipped、todoは0件だった。
2026年10月7日、同sourceSHAのcanonical revisionsとcallbackなしの最終proof guardを含むv1経路をClaude Code 2.1.291の隔離HOMEで回帰確認した。
standaloneの一回のassistant contextでproofとwriterの認可を確認し、終端後はactorとcanonical periodがactive、contextStateがendedとなり、旧proofとwriterを拒否した。
owned stop後のchild exitとclose、通常Codex/Claude認証ファイルの不変、隔離認証artifactの新規作成0件を確認した。
結果はexcludedな`.cross-review/native-live-binding-probe-results-claude-lifecycle-8fa31cf9-e215-4ede-a087-39e2ae17bc68.json`に保持する。
実probeはstandaloneだけであり、最後のancestor callbackからの失効注入、複数context、delegated、handoff、reconnect、Codex waitはこの結果で実証していない。

## Native 登録履歴の受動復旧

ID-F11-B01〜B03 の独立期待値と復旧境界は [native-recovery-checkpoint.md](native-recovery-checkpoint.md) に定義する。

ID-F11-B01 と B02 は実ファイル store と Claude/Codex adapter の fixture で pass、実 native runtime は両 provider とも未実施である。

ID-F11-B03 は ended tombstone と explicit order を検証する共通 kernel unit であり、provider adapter または実runtimeの結果として扱わない。

対応する試験は [native-recovery-checkpoint.test.js](../../test/native-recovery-checkpoint.test.js) と [conversation-registry.test.js](../../test/conversation-registry.test.js) にある。

この結果は passive registration bootstrap の適合に限り、fresh evidence reconciliation や Issue #177 全体の runtime 復旧を示さない。

## 明示的回収factoryの操作受付と終了 (#209)

`ID-F209-L01`は、ClaudeとCodexの実factory fixtureで共通の受付停止を確認するシナリオである。
回収を明示的に有効にしたfactoryと、質問および指示serviceの保存を保持できるfixtureを能力条件とする。
service queue、provider後着callback、質問timer、回収coreとschedulerを対象にする。

保存を一度進行中に保持し、未着手の操作を追加してcloseを呼ぶ。
close呼出し直後から新しいticketを発行せず、受付済み操作は成功、取消または失敗で終了し、ticketを一度だけ返すことを期待する。
closeの完了時点で対象ticketが残らず、既存contextと保存処理のcloseも終了していることを観測する。
後着callbackや保存済みtimerをclose後に呼んでも、新しい保存を開始しない。
完了は保持点の明示解放とPromiseの終了で確認し、固定のsleepを成功条件にしない。

contextの同期的な保存禁止とready拒否は、ticketのdrainを待つ前に行う。
起動失敗とsettings解除からの同期close再入でも終了が循環しないことを確認する。
回収無効の標準modeはgateを生成せず、既存APIとcloseの契約を保つ。
providerの識別子、時刻と既存取消のerror codeの差を許容するが、追加送信、追加保存、受付再開、authorityの再発行は許容しない。

両providerのfixture適合と実runtimeを分けて記録する。
acceptedへの実到達と登録済みlistenerの後着拒否は、両providerで確認する。
後着拒否はserviceへ登録したlistenerを直接呼ぶcontrolであり、adapter/routerを通した後着経路の確認ではない。
listenerの保存中にcloseされるcontrolはunknownを両provider、appliedを現fixtureが対応するCodexで確認する。
Claudeのlive appliedは未確認であり、cold checkpointのseedや別のcallbackで代用しない。
このシナリオはnativeの長時間startやread待機の物理取消、外process排他、新schema保存許可、電源断耐久性、件数枠解放を証明しない。
実Claude/Codex runtimeの適合は横断統合試験に残す。
`4db527e`の新factory試験15件とgate単体7件を含む関連11ファイルは248件成功、失敗0、skip0である。
同じheadの全体`npm test`は2802件成功、失敗0、Windows実symlink権限によるskip2である。
このskip数には未実行のClaude live appliedと実runtimeを含めず、上記の未確認境界として別に扱う。

## native起動待機の取消 (#209)

`ID-F209-S01`は、実owned runnerとcompositionを使い、開始途中の停止で開始Promiseが終了することを確認する。
Claudeは外部認証、spawn、初回入力write、context-readyの保持点を能力条件とする。
Codexはinitialize、initialized通知、login開始と完了、thread開始、turn開始の応答またはwrite callbackを保持できることを条件とする。
停止後に保持点を解放しても、次の起動段階、context、runtime proofを新たに発行しないことを期待する。
停止前に発行済みのidentityは存在し得るが、停止後の再認可を許容しない。

開始Promiseの終了と子プロセスの停止確認は別々に観測する。
子のexit、closeと非activeが揃った場合だけ停止確認済みとし、欠ける場合は未確認のまま扱う。
epoch、timeout、kill呼出しやPromiseの終了を物理停止の証拠にしない。
保持点の明示解放と状態・eventの観測で確認し、固定sleepを成功条件にしない。
任意注入runnerの未settled startをcompositionが一般に取消できるとは主張せず、負例はテスト側で明示解放する。

providerごとのRPC、認証方式、既存error codeの差は許容するが、後着による起動再開とauthority再発行は許容しない。
外部認証元の作業自体、観測readの取消とdrain、factory ticketへの接続と全I/O終了は対象外である。
両providerのfixture結果と実runtimeを分けて記録し、実Claude/Codex runtimeの適合は横断統合試験に残す。
今回のfixtureは通常起動profileで確認し、wait profile固有のtransport開始待機は未確認として分ける。
Codexのwrite callback保留はinitialize RPC（応答先着）とinitialized通知で確認する。
login、thread、turnの各RPCは応答待ちを確認し、それぞれのwrite callback保留は未確認である。
停止後の追加writeは、後着解放前後のwrite履歴の直接比較で検出する。

## native readのlease取消 (#209)

`ID-F209-R01`は、実owned sourceとCodex runnerを接続したfixtureで、lease解放またはsource無効化によるread待機の終了を確認する。
Claudeのnative readはunsupportedを期待し、transportを呼ばないことを確認する。
両providerの実runtime結果は、このfixture結果とは別に記録する。

Codexのloaded-listとthread-readについて、応答待ち、write callback待ち、応答先着、段階間の解放、write中の同期解放を保持点で再現する。
次のreadやrunner停止を呼ばず、lease解放だけで元のreadがunknownへ終了し、後着応答からreceiptや追加RPCを作らないことを期待する。
旧leaseの後着callbackと新leaseのreadを重ね、新しいreceiptと独立したrunnerへ取消が波及しないことを確認する。
通常完了したreceiptの一度だけの消費と、timeout・provider拒否後のrunner生存を維持する。

取消登録前の解放、取消済みscopeへの同期登録、二重取消、callback例外でも後始末を確認する。
後着write拒否を未処理rejectionにせず、現generationのpipe故障は既存のfailureへ進め、旧generationのcallbackは新childを止めない。
read取消はinstruction transportを一括取消しない。
ただし同じleaseの解放はinstructionのauthorityも失効させるため、後着ACKの成功は期待しない。

保持点の明示解放とPromise終了を観測し、固定sleepを成功条件にしない。
追加scopeを無視する注入readerはpendingのまま残る負例として明示解放する。
ラッパーの終了をproviderの元作業、raw write callback、collector、factoryのdrainや保存先所有の解放へ読み替えない。
source `b70816d`の関連2ファイルはin-processで120件成功し、追加20件で保持点と負例を確認した。
同sourceの全体`npm test`は2836件成功、失敗0、Windows実symlink権限skip2である。
loaded-listのraw応答とwrite解放後のmicrotask取消で次RPC不送信を確認するが、内部continuationの各境界は独立計測していない。
source無効化はsource単体で確認し、実runnerではglobal取消も行うstop経由で確認した。
runnerは公開APIから新childへ再起動できないため、旧generationの後着writeエラーはstopped状態の不変までを確認し、新childへの影響は未確認である。
実Claude/Codex runtimeのread取消は未実施である。

## owned collectorの内部終了追跡 (#209)

`ID-F209-C01`は、owned collectorの受付停止と非同期処理の終了追跡を確認する。
実runnerとcompositionのfixtureを能力条件とし、Codexは保留したreadの協調取消、Claudeはunsupported readと共通の接続停止を期待する。
公開collectorとcomposition wrapperの項目、options許可項目、通常disconnect後の再接続を維持する。

内部の恒久受付停止後にconnect、observe、reconcileを開始せず、collectorのproofとpositive observationを返さない。
外側compositionのauthority失効と実read取消には、別途disconnectまたはnative stopが必要である。
恒久停止だけで元のreadが終了したとは扱わない。
connect、observe、reconcileの受付済み処理が、結果判定と内部後始末まで終了してからprivate drainを完了する。
同じconnect試行のPromiseを共有し、reconcileの内部observeを重複計上しない。

再入可能なbinding、観測callback、ticket取得より先に処理を登録する。
ticket取得中のconnect再入、受付停止と例外でも二重開始や未登録の仕事を作らない。
ticket解放の例外でも記録の終了を通知し、例外を成功へ変換しない。
接続確立後のticket解放例外では接続が残り得るため、呼び出し側がdisconnectで回収する。
ticket取得関数は最初の処理受付前に一度だけ設定し、受付履歴がある場合と停止後は拒否する。

旧接続の遅延完了またはrejectが、新しい接続のPromise、state、loanを変更しないことを確認する。
停止後のnative eventと同期callbackからの再入でもpositive observationを再発行しない。
非協調bindingのreadは明示解放までdrainを未完了に保ち、epoch、timeoutやPromise.raceを終了の証拠にしない。
保持点とPromise終了を観測し、失敗時にも保留点を明示解放する。

内部binding単体と実runnerのfixture結果、両providerの実runtimeを分けて記録する。
factory ticket接続、factory close順、子の物理停止、provider元作業のdrainと保存ownership解放はこの段階の対象外である。
PR #356のsource `f449304`は関連145件と全体2849件が成功し、失敗0、全体はWindows実symlink権限skip2である。
ticket解放のfalsy例外理由を保ち、先行する失敗理由を後始末の例外で置き換えないことを確認した。
実Claude/Codex runtimeとfactory ticket接続は未実施である。

## native factoryの起動・観測と終了追跡 (#209)

`ID-F209-L02`は、明示的回収factoryと実owned runner/compositionのfixtureで、native startとcollector処理をfactory寿命へ接続する。
ClaudeとCodexの通常起動、Codexの観測read、共通のcollector接続と停止を能力条件とする。
Claudeのreadはunsupportedを期待し、実runtimeの結果とは分けて記録する。

closeは同期に新規ticketを拒否し、全collectorの受付停止後に全nativeの停止を開始する。
service closeが保留されても停止開始を遅らせず、一件の停止保留や例外で他entryの停止開始を妨げない。
受付済みstartとcollector処理は結果判定および後始末までticketを保持し、非協調処理が未完了ならcloseも未完了のままとする。
起動失敗のstop coreはstart自身、collector drain、factory gate drainを待たず、自己待ちを作らない。

start、stop、closeの同期再入は先行Promiseを共用し、二重spawn、二重停止、停止後のrunning復活を許容しない。
生成済みcollectorとcleanupはcallback前にentryへ登録する。
collector準備失敗は元の同期throwを保持し、生成済み資源の後始末が終わるまでticketを返さない。
後始末の失敗は元のthrowを置き換えず、後続closeで確認する。
control不在やbind拒否ではcollectorを公開せず、ticketがゼロでもdrain成功と扱わない。
entry登録後のrouter attach失敗とdirect collector作成失敗も後始末の待機対象とする。

初期化失敗でadmission集合を参照でき、composition未生成の空集合へnative停止を呼ばない。
contextの同期保存禁止とready拒否はticket drainより先に始め、標準modeでは既存停止順と返却条件を維持する。
物理停止はexit、closeと非activeを独立観測し、wrapper settlementだけで成功へ変換しない。
保持点はfinallyで明示解放し、callback内で捕捉されるassertを成功の証拠にしない。

外部認証元作業、raw provider I/O、保存ownership解放順、電源断耐久性、新schema接続は対象外である。
provider固有RPCと既存error codeの差は許容するが、追加送信、新規受付、authority再発行とcleanup失敗の成功変換は許容しない。
両providerのfixture結果と実runtimeを別記し、未実行の保持点を成功へ合算しない。
補強前の関連4ファイル108件と、最初のtest-only監査修正後のlifetime51件が成功した。
Claude R1後の標準mode例外保持のtest補強を含むlifetime52件はすべて成功した。
通常起動と非協調startの保留は両provider、観測readと故障注入はCodex fixtureを中心に確認する。
構築中にcollector返却前のclose再入を起こす試験はprivate injectionであり、通常製品のcallback到達性とは分ける。
固定head `9379162`の全体テストは2885件成功、失敗0、Windows実symlink権限によるskip2である。
52件へのtest補強後は全体未再実行で、検証source `d253639`以降に製品sourceの差分はない。
実Claude/Codex runtimeは未実施である。

## native readのwrite故障分類 (#355)

`ID-F209-R02`はCodexのowned readonly RPCのwrite故障を、provider拒否と論理取消から区別する。
対象RPCは`thread/loaded/list`と`thread/read`で、Claudeの同等readはunsupportedのままとする。

取消前にwrite callbackがErrorを返す場合、readはunknownとなり、現行runnerは`failed`と`stdin_write_failed`を記録して子の停止を一度だけ開始する。
writeの同期throwはundefined、null、false、0、空文字を含めて物理write故障に包む。
callbackのnullまたはundefinedはNode Writableの成功として扱い、同期throwと混同しない。
providerのJSON-RPC refusalとread timeoutはreadをunknownにするが、物理write故障を伴わなければrunnerをfailedへ変えない。

lease取消後の後着write failureは同じrunner generationが現行の場合に失敗を記録する。
stopでgenerationが失効した後は、旧callbackがfailureCodeを作ったりchild停止を追加したりしない。
同じrunnerを再startするAPIは無いため、別runnerを旧generationの後継として検証したとは扱わない。
read専用処理の分類だけを変更し、instruction ACKとbulk取消の契約を広げない。

FakeChildのwrite保持点と実owned sourceを使うfixtureで確認する。
実Codex runtime、実stdio故障、外部認証元作業は未実施であり、fixtureの合格へ混ぜない。

runnerとsourceの関連123件は成功し、失敗0件である。
固定head `d12453b`の全体テストは2889件成功、失敗0、Windows実symlink権限によるskip2である。
Claude R1はblockerと要修正が0件で収束した。
実Codex runtimeと実stdio故障は未実施である。

## 回収factoryの二段階終了とprocess内所有保持 (#209)

`ID-F209-O01`は明示的回収factoryで、同期の保存禁止と所有権の最終解放を分けるfixture契約である。
ClaudeとCodexの同一終了条件を確認し、provider固有read能力と実runtimeの結果を分ける。

第一段階は新規factory ticket、context保存、ready待機とwriter受付を停止する。
受付済みwriteとreadback、writer tail、context startup/I/O、coordinator startupのsettlement後にpersistenceの新規enqueueを停止し、そのpending queueをdrainする。
backend.closeとcoordinator.closeはfactory全体drainを逆待ちせず、Map所有権と実容量leaseを解放しない。

設定購読解除とrouter.closeの失敗も保守的な所有保持の対象とする。
これら二つの個別故障を対照にするfixtureは未追加である。
managed collectorの生成前入力検査失敗によるadmission退役の個別fixtureも未追加で、bind失敗後のcleanupと区別する。

第二段階は全native物理停止と隔離、collectorと準備失敗cleanup、serviceに依存しないwriter tail、schedulerとfactory gate、context/persistence I/Oの終了確認後にだけ行う。
容量leaseの解放成功後に同ownerのpath Mapを解放し、解放完了のフラグを先行させない。
leaseの実release後もstatusが不明なら、path再取得と同factoryの再起動を拒否する。
実容量予算の減少とpath所有の保持を別に観測し、繰返しcloseでreleaseを追加しないことを確認する。
通常の保存失敗があっても独立に終了を確認できれば解放し、close中に捕捉した失敗があれば最初の理由を返す。
停止またはdrainを確認できない場合はstickyな所有保持とし、timeout、後着通知、再closeとGCで自動解放しない。
同じprocess寿命中の同path再取得は拒否する。

所有保持となる回収factory.closeだけはcode `reclamation_ownership_retained`のAggregateErrorで返す。
closeまたはstartup cleanup中に捕捉した最初の失敗はcauseのown propertyとerrors先頭へfalsy値も含めて保持し、保持理由もerrorsに残す。
confirmed release後の保存失敗、standard mode、standalone context/coordinator/persistenceとnative.stop自体の既存エラーは維持する。

保持fixtureはticket、native readとwrite/readbackを別々に保留し、保存禁止後もMap所有権と容量leaseの保持を確認する。
正常終了後の同path再取得、保存失敗後の安全な解放、writer drain失敗、control不在、exit-only/close-only、lease release throw、初期化各段階の失敗、同期再入とbackend/coordinator経由の解放迂回拒否を対照にする。
新ownerの取得後も旧provider callbackと旧backend保存がfile bytes/revisionを変えず、旧gateを開き直さないことを確認する。
保持点はfinallyで解放し、同pathの保持試験に使ったrootを別試験へ流用しない。

対象の所有権は同module内Mapとprocess内容量予算に限る。
他module、process間lock、標準writer、任意filesystem writer、実runtime、OS耐久性とpower lossは未確認で、fixture成功へ合算しない。
明示再確認と所有保持の詳細診断は別作業であり、この契約は可用性回復APIを含まない。

検証sourceは`ed9e1b1`である。
関連9ファイルは237件成功、失敗0、Windows実symlink権限によるskip1だった。
この結果は最終の質問stop失敗記録と追加試験の前である。
所有保持と保存失敗の監査補強後はcontextとfactoryの112件が成功し、最終contextの49件とcoordinatorの管理終了2件も成功した。
実ticket、native readとwrite/readbackの保持中は容量leaseと同pathの取得拒否を確認し、保存失敗後はclose失敗の注入を足さずに安全な解放を確認した。
stop失敗を後続成功で消さず、同期throwと非同期rejectのfalsy理由を保持する。
固定head `5a3d50f`の全体テストは2792件成功、119件失敗、Windows実symlink権限によるskip2だった。
本文回収とgrant解放の既存helperが、cloneしたpersistenceとcontextへ元のprivate controlを引き継がず起動を拒否されるため、helperの互換補強を行う。
互換補強後は、lease解放状態が不明な場合の再起動拒否を含め、4試験群120件がすべて成功した。
factory lifetimeの72件とquestion write隔離の16件も成功した。
未知leaseの両provider対照では同じAggregateError、release一度だけ、直接のpath再取得拒否、保存済みgrant nullとnative送信0を確認した。
初回全体失敗後はDraftを維持し、製品条件を弱めずhelperと試験期待値を修正した。
Claude R1はblockerと要修正が0件で、任意提案の保持範囲を文書で明確化した。
互換補強後の固定head `30f6e85`は全体2911件成功、失敗0、Windows実symlink権限によるskip2、228867.7931msだった。
Claude R2もblockerと要修正が0件で、実originalへの転送とcache復元、未知leaseの期待値との整合を確認した。
restartは旧factoryのclose拒否で止まり、同pathの新owner取得拒否は直接persistenceを作る対照で確認する。
最終の字下げ整理と重複変数除去後も構文確認と未知leaseの2件が成功した。
製品コードは全体検証headから不変で、軽微な整形と結果記録だけのため全体再実行とR3は省略した。

## writerのプロセス間排他 (#313)

以下は[排他設計](writer-ownership-exclusion.md)の後続実装に対する期待条件で、製品fixtureは未実装である。
private primitive、standalone接続、factory接続、全参加writerの横断確認を別段階で記録する。
専有probeとfixtureの成功を、Claude/Codex実runtimeの成功へ読み替えない。

| ID | 操作 | 期待条件 |
| --- | --- | --- |
| ID-F313-W01 | 2つの実processをbarrierで同じ保存先取得へ進める | 参加したwriterの一方だけが取得し、敗者のsource load、fingerprint、temp作成とnative起動は0回 |
| ID-F313-W02 | factory集合の途中で競合させる | 新規source内容I/Oを始めず、当該試行が作ったmarkerだけをrollback。既存ownerのmarkerは不変 |
| ID-F313-W03 | metadata保存とrollbackを故障させる | 不完全markerも占有として拒否し、元の失敗とrollback failureを両方保持 |
| ID-F313-W04 | native、writer、readbackまたはcollectorを保留してcloseする | 終了未確認中はunlinkを試みず、子backendのcloseから最終解放へ迂回しない |
| ID-F313-W05 | 正常release後に新ownerを取得し旧releaseを繰返す | 旧ownerは保存とunlinkを追加せず、新ownerのmarkerと保存内容を変えない |
| ID-F313-W06 | 停止確認後のunlinkを失敗または結果不明にする | 旧capabilityを再利用せず、自動retryしない。残る自己markerも逆順に一度ずつ処理し全失敗を集約。Mapを保持し、回収factory closeはreclamation_ownership_retained。標準standaloneは接続PRで定める既存closeとの互換形式で原因を保持。既に解放された容量やmarker残存不明を保持確認済みと報告しない |
| ID-F313-W07 | 所有後のprocess crashと次の起動を観測する | 残留markerをTTL/PIDだけで奪取せず、取得を拒否。正常終了probeと区別する |
| ID-F313-W08 | 大小文字、junction、hardlink、短縮名と対象外filesystemを与える | 対応範囲で同じfileが共通keyとなるか、入力を取得前後の適切な境界で拒否。検出できない範囲を許容しない |
| ID-F313-W09 | 全participant停止と新規起動禁止のfixtureで回復する | 特定markerだけを処理し、次ownerは取得後に保存形式に応じたcold recoveryを完了してから保存再開 |
| ID-F313-W10 | standaloneとfactory、全低層writerを同じ保存先へ重ねる | 共通protocolで競合。公開constructorと移行/修復経路を照合し、未参加writerや旧versionとの共存は非対応として接続途中を全体排他成功としない |
| ID-F313-W11 | トレイの通常再起動、停止失敗と強制終了後のhook/MCP ensure起動を行う | graceful停止と全writer最終解放を確認後だけ再起動。残留時は取得拒否。ensureはeventごとに起動/health待ちをdeadlineまで繰返さず速やかに拒否理由を返す。自動削除せず、手動回復後と新instanceで拒否状態を誤継承しない |
| ID-F313-W12 | 各standalone constructorと移行/修復callerで未作成親directory、競合と権限拒否を与える | 親directory準備と同期throw処理をcallerごとに照合し、失敗後のsource I/Oと所有漏れを拒否 |

W01〜W12の製品試験と両provider実runtimeは未実行である。
Windows、Node v24.15.0の専有probeではwx一勝/一件EEXIST、正常終了後のmarker残留、close後の明示unlinkと再取得を観測した。
別名hardlinkでは双方のsidecarを取得できる反例があり、大小文字と親junctionのaliasは同じrealpath/dev/inoになった。
これらは方式検討の証拠で、OS crash、電源断、他volume、network、全aliasと全writer接続を保証しない。

### 限定primitiveのfixture条件

以下は内部moduleだけの期待条件で、実装前に記録する。
製品callerと実providerは未接続であり、成功してもW01〜W12の製品条件全体を完了扱いにしない。

| ID | 操作 | 期待条件 |
| --- | --- | --- |
| ID-F313-P01 | opaque prepared集合を取得する | 固定slot集合の同期取得。偽造/clone参照、重複、未作成親を拒否し、source内容I/Oなし |
| ID-F313-P02 | 部分競合とmetadata故障を注入する | 自己markerだけ逆順rollback。元falsy理由とcleanup失敗を保持し、未知結果ではMap予約を保持 |
| ID-F313-P03 | fd0、short write、0進捗とclose不明を与える | fd0は有効、正進捗writeを完了。未知fdを再close/unlinkせず、漏れを解消済みとしない |
| ID-F313-P04 | quiesceを保留/失敗/再入させる | 最初にclose Promiseを保存。保留中unlinkなし、失敗は同じPromiseと理由、Map保持。自己待ちによる解放なし |
| ID-F313-P05 | unlink失敗/結果不明後にcloseを繰返す | 各自己markerを逆順一度ずつ処理し全失敗を保持。Map保持と旧capability終端、追加unlinkなし |
| ID-F313-P06 | 正常close後に新ownerを取得し旧closeを繰返す | 同じ旧close Promiseで追加操作なし、新marker不変 |
| ID-F313-P07 | 実process二つのreadyを待ってから双方へ取得を指示する | 一勝/一件競合拒否、勝者保持中の第三者も拒否。敗者の取得後fixture処理は0回。OS schedulingの厳密な同時性と実processでの部分rollbackはこの試験の対象に含めない |
| ID-F313-P08 | 実processのcloseを始めquiesceを保留する | marker残存を確認後にbarrier解除。全unlink後に新process取得成功 |
| ID-F313-P09 | 所有childがcloseなしにprocess.exitする | childのexit/close後もmarker残留、次取得拒否。OS crashや電源断とは区別 |
| ID-F313-P10 | 取得操作へ同期再入する | 全keyのMap予約により再入のfilesystem操作なし。正常rollbackでのみ予約解除 |

P01〜P10を含む`test/writer-exclusion.test.js`は19件成功、失敗0件で、実child processの競合、quiesce保留、再取得とcloseなし終了を確認した。
通常sandboxではtest runnerの子process起動がEPERMになったため、この対象試験を昇格実行した。
実process fixtureの成功は両provider実runtimeや一般保存先のfilesystem対応の証拠には数えない。
実装head `7a4e23f`の全体`npm test`は2,930件成功、失敗0件、Windowsの実symlink試験2件skipだった。

### shutdownの失敗理由保持

通常serverとnative server wrapperのcloseは、失敗の有無と理由を別に扱う。
以下を#361の実装前期待値とし、実provider停止の確認と区別する。

| ID | 操作 | 期待条件 |
| --- | --- | --- |
| ID-F361-S01 | shutdown callbackからfalse、null、undefined、0、空文字列を同期throwまたは非同期rejectする | 初回と再closeが元の理由でrejectし、callbackは一度だけ。診断はshutdown_incomplete、listener停止とserver.json除去を確認 |
| ID-F361-S02 | 通常serverの先行保存flushがfalsyで失敗し、後続callbackも失敗する | 最初の理由を保持し、後続cleanupを継続。診断へ任意の理由を公開しない |
| ID-F361-S03 | native integration終了がfalsyで失敗し、後続callbackも失敗する | 既存の終了順とcloseキャッシュを維持し、wrapperを通って最初の理由を保持 |

S01〜S03を含む通常server試験87件とnative factory試験38件は成功し、失敗とskipは0件だった。
通常sandboxのharness子process起動がEPERMとなったため、同じ対象試験を昇格実行した。
実装head `2ec748b`の全体試験は2,969件成功、失敗0件、Windowsの実symlink試験2件skipだった。
指定Claude R1はblockerと要修正が0件で収束した。
writer排他の製品接続、graceful再起動と両provider実runtimeはこの試験の成功に含めない。

### 停止結果record codecの独立条件

以下は純粋codecの実装前期待値であり、製品callerを追加しない。
codecは固定schemaのrecordをUTF-8 Bufferへencodeし、decodeはBufferとkind別の期待IDを必須とする。
decode後は入力から独立した、固定primitive fieldだけのfreeze済みrecordを返す。
診断はinvalid_stop_ensure_recordに限定し、入力や任意例外の内容を残さない。
ファイルのbounded read、basename導出と保存は別moduleで検証し、codecの成功をACL、管理権限、healthやwriter解放の証拠としない。

| ID | 操作 | 期待条件 |
| --- | --- | --- |
| ID-F313-C01 | shutdownのcompleted/failedとstartupのstarted/blocked全理由を往復 | version 1の固定fieldとstatus/reason/instance組合せを保持し、余分fieldと許可外理由を拒否 |
| ID-F313-C02 | 大文字、過長、末尾改行、path区切り、version/variant違いのUUIDと不正scopeを与える | 36文字小文字UUID v4と64桁小文字hexだけを許可し、coercionせず拒否 |
| ID-F313-C03 | accessor、未知field、symbol、非列挙field、不正prototypeとthrowing proxyを与える | getterとtoJSONを実行せず固定診断で拒否。plain objectまたはnull prototypeのdataだけをコピー |
| ID-F313-C04 | 正しいJSONを空白で4096 byteへ拡張し4097 byteも与える。BufferのbyteLengthを偽装する | 実4096 byteは許容し実4097 byteはUTF-8変換とJSONparse前に拒否。入力のgetterを実行せず実byte長を検査し、文字数と混同しない |
| ID-F313-C05 | malformed UTF-8、JSON、BOM、空入力と非Bufferを与える | replacementによる救済なしで固定診断。合法JSONの外側空白は許容 |
| ID-F313-C06 | 期待IDを省略、不正schema、旧instance/request/scope/attemptとkind不一致にする | shutdownはkind/instanceId/requestId、startupはkind/scopeId/attemptIdの厳格照合が必要。startupの新instanceのhealth照合は後続の責任 |
| ID-F313-C07 | encode/decode後に入力を変更し、Object.prototype.toJSONを故障fixtureで追加する | 返却recordはfreeze済み独立コピーで、入力と継承toJSONにより出力を変更しない。fixtureはprototypeを必ず復元 |

C01〜C07を含む関連試験は17件成功、失敗0件で、両moduleの構文確認も成功した。
IDの固定長を明示し、末尾改行と各期待IDの不一致を検証した。Bufferの見かけのbyteLengthを信用せず実長を確認する。
実装head `6884318`の全体試験は2,986件成功、失敗0件、Windows実symlink試験2件skipだった。
指定Claude R1はcodec本体に要修正なし、C04の上限超過入力の判別力不足が1件あった。
合法JSONを4097 byteへ拡張した入力と偽装Bufferへ補強後も、関連17件と構文確認が成功した。
全体試験headから製品srcは不変で、testの入力だけを補強したため全体試験は反復しない。
Claude R2はblockerと要修正が0件で、C04の上限検査の退行を検出できる反例を確認して収束した。
停止結果の保存と停止手続き、両provider実runtimeと製品排他は未確認のままである。
停止全体の設計[PR #364](https://github.com/ktysne/agent-cockpit/pull/364)はレビュー未収束で、この独立codecの前提にしない。

### 停止結果storeの独立条件

以下は[限定内部store](stop-ensure-result-store.md)の実装前期待値である。
同インスタンスのwrite latchとbounded I/Oだけを確認し、異process排他、ACL、writer所有を成功へ読み替えない。

| ID | 操作 | 期待条件 |
| --- | --- | --- |
| ID-F313-R01 | expected-ID helperを直接呼び、encode/decodeも使う | 第4の内部exportだけを追加。厳格schemaと固定長、getter/Proxy非実行、入力独立freezeを保持 |
| ID-F313-R02 | shutdown/startupを実temporary rootへ保存して照合する | 導出固定basename、writtenとvalid、期待ID一致。APIはread/writeのみ、製品callerゼロ |
| ID-F313-R03 | 不正factory/record/expectedIDを与える | 未知field、accessor、path/ID形式を副作用前に拒否。I/O 0回、任意診断を返さない |
| ID-F313-R04 | target不在と親消失、nonregular/symlinkを与える | targetENOENTだけmissing、親消失/不明とnonregularはunknown。ENOENT時親再確認 |
| ID-F313-R05 | 4096/4097 byte、stat後伸長、short readと不正返値を与える | read最大4097固定buffer、short正進捗は続行、0EOF。過大statでbody read0、契約外返値はunknown |
| ID-F313-R06 | read/stat/open/close失敗とcodec不一致を与える | 最初の固定診断と後続closeFailedを保持。close不明でvalid/missingなし、handle close一度 |
| ID-F313-R07 | 同keyの即時再送、完了後再送と同期再入を行う | I/O前latch登録、同bytesは同Promise、異bytesはconflict、unknown後も再送でI/O増加0 |
| ID-F313-R08 | short write、0/過大返値、write故障を与える | Buffer viewだけを正進捗で書く。最初の診断保持、known handle close一度 |
| ID-F313-R09 | open副作用後rejectとclose不明を与える | 未確認handleを再close/unlinkしない。temp残留可能性を解消済みとしない |
| ID-F313-R10 | rename前失敗/副作用後rejectとcleanup失敗を与える | targetを消さずreadback成功化なし。known-created/closed自己tempだけ一度cleanupし、first diagnosticとcleanupFailed保持 |
| ID-F313-R11 | 既存targetと他file/temp/markerを置く | 既存は拒否、無関係なfileは不変。事前確認をcross-store/processのno-replace証拠としない |
| ID-F313-R12 | 結果objectを変更し、実fixtureをcleanupする | 結果freeze、任意原因/path/本文なし。全実handle終了とresolved自作os.tmpdir root確認後だけfixture cleanup |

R01〜R12を含むcodec/storeの関連試験44件は成功し、失敗とskipは0件だった。
4ファイルの構文確認も成功した。
実temporary rootでshutdownとstartup双方を保存して読み、全handle close確認後に自作rootをcleanupした。
不明handle、closeとrenameの副作用後失敗はfake filesystemで確認し、実descriptorを故意に漏らしていない。
全体試験と指定Claudeレビューは未実施で、製品停止と両provider実runtimeの合格には数えない。
record単位の上限はstore全体のメモリー容量を保証せず、製品enable前の設計条件に残す。
