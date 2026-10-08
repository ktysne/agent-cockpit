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

期待値は[承認した復旧計画](../handover/2026-10-08-common-question-recovery-plan.md)から定める。
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
継続して参照する確認結果は[実runtimeの引き継ぎ資料](../handover/2026-10-08-runtime-gates.md)に文章で残す。
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
