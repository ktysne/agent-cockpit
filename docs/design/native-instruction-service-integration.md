# Native writerと通常指示サービスの接続

## 対象と採用境界

この接続は、通常指示サービスの永続配信と、認可された同じowned processの限定writerを結合する。
`createNativeInstructionServiceIntegration`はnative composition、owner router、実ファイルstore/journal、provider adapter、instruction serviceをまとめる。
`startNativeInstructionServer`はそのserviceとregistryを既存のloopback serverへ渡す、明示起動用の製品APIである。
既定daemonのprofileや起動設定は自動変更せず、信頼された呼び出し元がnative launchを登録・開始する。
以下の期待値はIssue #175と配信契約から定義し、既存実装の出力比較では作らない。

送信開始の保存に成功するまで本文をnative writerへ渡さない。
保存後にopaque認可を同期再検査し、最終guardから同じpipeの書き込みまでawaitを挟まない。
read-only sourceの観測をdispatch認可へ転用しない。
受付応答だけではappliedにせず、完全な入力証拠と固定宛先を照合する。
unknownと送信済み結果不明を自動再送しない。

## 適合シナリオと期待値

自動試験は製品integration factory、composition、collector、runner/writer、service、adapter、実file store/journalを通る。
runnerのprocess spawnとprovider runtime eventはfixtureで置換するため、実Claude/Codex runtimeの成功証跡にはならない。
初期化やfixtureの成功を実runtimeの適合として扱わない。

| ID | 区分と能力条件 | 入力と操作 | 観測点と期限 | 期待値と禁止副作用 |
|---|---|---|---|---|
| ID-F08-NS01 | 共通。登録済み固定launch | 本文を未送信として保存 | journalとcheckpointの実ファイル、service projection | available。native指示write0、自動send0 |
| ID-F08-NS02 | 共通。matching terminal、attested standalone actor | 同じnative/session/periodへ明示start | send-start保存前後、実pipe write、ack。prepare/ack各5秒以内 | 保存成功後にstart1回。別native0、再spawn0、受付だけによるapplied0 |
| ID-F08-NS03 | 仕様差。Codexの固定working turn | expectedTurnId付きsteer | 同期guardと実wire request、5秒以内 | Codexは固定turnへのsteer1回、turn/start0。Claude workingはunsupported/write0。startへの自動変換0 |
| ID-F08-NS04 | 共通。実checkpoint書き込み失敗 | send-start保存を失敗させる | atomic書き込み失敗、サービス状態、同一store再起動 | native本文露出0、write0。保存停止を維持し、復旧時も自動再送0 |
| ID-F08-NS05 | 共通。保存中のsource/context/owner失効 | send-start保存待機中にdetachまたは認可を失効 | 保存完了後の同期再検査と実wire | 保存後はunknown、指示write0、fallback0、旧proof復活0 |
| ID-F08-NS06 | 共通。ack喪失またはpipe書き込み失敗 | 明示send後に応答を失う | write開始、ack拒否/期限、同一ファイル再起動 | 指示write累計1回以下、unknown。再sendと再起動による追加write0 |
| ID-F08-NS07 | 共通の安全条件。完全な入力証拠が必要 | ackだけ、欠損clientId、部分本文、別turn/item、早期証拠を渡す | accepted/applying/appliedの境界、候補は60秒/128件/256KiB以内 | ackだけのapplied0、不一致証拠によるapplied0。完全一致証拠だけを受付後に採用。能力がないproviderの適用結果はunknown |
| ID-F08-NS08 | 共通。複数admissionまたは旧lease | 別ownerのopaque capability、clone、旧接続の証拠を渡す | 実owner routing、同期guard、証拠購読 | 誤owner write0、旧証拠のapplied0、汎用RPCへの迂回0 |
| ID-F08-NS09 | 共通の安全条件。review、ended delegated、question/permission hold、native未対応next-user-input | 保存済み指示を禁止対象へ明示send | source/target/mode確認、実wire | 指示write0、standalone/startへの自動変換0。question/permission pending時のtarget表示とsteer拒否はfixtureで確認するが、実runtimeでpendingが発生した場合の挙動は未確認 |
| ID-F08-NS10 | 共通。取消とsend-startの直列化 | 保存前の取消と送信開始を競合させる | 実storeのcommit順序と途中台帳 | 取消確定ならwrite0。送信開始後の取消を送信前取消として扱わない |
| ID-F08-NS11 | Claude Code 2.1.292の実standalone startを1回確認（e83cf3dの順序修正前のsource `ea600a0`） | boot context terminal後、同じowned process/launch/session/actor/periodへ明示`start` | durable `sending`、stdin write後のnative context acknowledgement、次context、終了とcleanup | 別session/追加spawn/fallback 0。`accepted`を観測、applied/steer/pending waitは未確認 |
| ID-F08-NS12 | Codex CLI 0.160.1の実run3（source `e83cf3d`）。機能証拠は一致したがscenarioはunknown | 同じowned processでboot terminal後の明示startと固定turnへのsteer | sending checkpoint revision 2/6、完全input、clientId、thread、turn、native item、service applied、cleanup | process/spawnは1回、start/steerは各1回で、両deliveryのnative evidenceとservice appliedが一致した。清掃前scanで`rawPayloadOutsideDurableDataCount=1`となりfile分類が記録されていないため、全体は`scenario_gate_not_met` |

宛先、送信回数、状態、禁止副作用の許容差は0とする。
ランダムIDと時刻だけを比較時に正規化し、能力差やunknownを正規化しない。
タイムアウトは各境界の契約に従い、未実行やskipを成功に混ぜない。

## 担当境界

接続moduleはprovider固定のowner routerを提供し、上記factoryが実際のserviceへ接続する。
信頼された起動lifecycleだけがcompositionのopaque admission receiptをrouterへ渡す。
同一receiptの二重登録は同じactive routeを返し、detach後の再登録は拒否する。
既存契約の不足が判明した場合は認可を緩めず、未送信またはunknownを保つ。
native runner、source、runtime kernel、wait専用経路はこの接続では変更しない。
receiptからownerを一度だけ取得し、prepareで成功したopaque capabilityをそのownerへ固定する。
check、dispatch、証拠購読では現在のlaunchRefからownerを選び直さない。
最終checkとdispatchは同期関数とし、dispatchの戻り値を変換せず返す。
detachとcloseは登録と既存capabilityを失効させ、証拠購読を解除する。
composition自身のsource失効もownerの同期検査で拒否される。

組み立ては、実storeのverifier closure、provider delivery adapter、owner router、provider instruction adapter、serviceの順に行う。
adapterの準備前にはverifierがfalseを返す。
`startNativeInstructionServer`は同じservice、registration registry、launch registryを`startServer`へ渡し、既存の127.0.0.1 bindとsecret/Origin gateを使う。
HTTP requestにはnative profile allowlist、receipt、writer capabilityによる認可を追加しない。
起動は明示opt-inであり、既定daemonや恒久HOMEへprofileを追加しない。

## 共通質問の明示構成

`commonQuestions: { away, settings }`をfactoryへ渡すと、共通質問サービスを同じnative構成へ接続する。
`away`はHTTPサーバーと同じinstanceを使い、`settings`は同期の`getAutoApplySettings()`、`getStatus()`と変更通知の`subscribe(listener)`を持つ。
away、設定getter、購読口のいずれかが不足する場合は非構成とし、通常指示だけの起動を維持する。
`startNativeInstructionServer`に別のaway instanceを明示した要求は拒否する。
標準起動、legacyフック、既存の離席設定には接続を追加しない。

共通質問には同じregistration、launch、runtime registryと単一の配送storeを渡す。
質問は`common-question-journal.json`、通常指示は`instruction-journal.json`に契約どおり保存し、配送checkpointは`delivery-checkpoint.json`を共有する。
回答は検証済みwriterの`answerPoll`から`store.sendStart`の同期sinkへ渡し、通常指示adapterでnative入力へ変換しない。
専用provider adapterと追加storeは作らない。

`getStatus().commonQuestions.status`は`unconfigured`、`ready`、`closed`を区別する。
サービスのready応答が成功を示した場合だけreadyとし、初期化失敗は構成成功を返さずcleanup後に拒否する。
設定の診断は`status`、文字列revision、reasonだけを取り出す。
設定がmissing、invalid、unavailable、changedの場合や、同期getterが例外またはPromiseを返した場合は自動適用をOFFにし、手動質問を受けられる状態と区別する。

設定の保存または安全状態の変更通知で質問のtickを再評価する。
listenerの同期例外と非同期拒否は観測し、通知元へ例外を戻さない。
終了時は購読を解除し、共通質問の受付とtimerを停止してから通常指示と所有実行を閉じ、最後に共有storeをflushして閉じる。

service初期化時に読み込んだ全質問を隔離し、fresh registryへ保存済みbindingを登録せずに保存整合性を検査する。
正当な保存記録がある起動は許すが、旧質問への回答と再送は許さない。
孤立配送と記録間の矛盾では起動を拒否し、intentだけが残る質問の配送は再生成しない。
通常指示の既存の復旧遷移を維持し、質問の隔離だけでは記録も容量予約も回収しない。
これは旧質問の再開能力を示さず、両providerの実runtimeの復旧確認は別に残す。
[#209](https://github.com/ktysne/agent-cockpit/issues/209)の隔離記録の回収条件を満たすまで標準起動と設定画面への接続を進めず、Issue #216を閉じない。

## HTTPのtarget projection

`/api/state`の`instructionTargets`は、native integrationがlaunchRefごとに返す安全な状態だけを表示する。
`startNativeInstructionServer`は呼び出し元の`serverOptions.instructionTargetState`を上書きし、登録状態を確認する内部callbackを必ず渡す。
`instructionTargetState` callbackは通常`{status, nativeTurnId, reason}`を返す。
Codexでnative questionまたはapprovalが保留中なら、`status: 'waiting'`、`reason: 'native_request_pending'`、件数を示す`nativeWaiting: [{kind, count}, ...]`を返す。
serverは`nativeWaiting`を含めて既存launch metadataへ重ねて表示し、steerは`working`状態の場合だけ受け付ける。
HTTP requestからreceiptやprofileを受け取らない。

compositionは通常writerと同じ`capture`と`checkFinal`を使い、runnerの物理writer適格性も副作用なしで確認する。
この照会は`prepare`を呼ばないため、capabilityやreservationを作らない。
照会は現在の適格性を示すもので、後続の`prepare`や送信を保証しない。
reservation容量やstdin pipeの使用可能性はこの照会だけでは保証せず、後続の`prepare`と同期送信時の最終検査で改めて確認する。

Codexのworkingは現在turnのsteer適格性を確認できた場合に限る。
Claudeのworking、delegated/reviewのterminal、disconnected、handoff中、active wait、送信結果不明、retired、closedはunverifiedを返す。
stoppedはstandalone terminal context、同一actorのlife proof、明示start適格性がすべて確認できた場合だけ返す。
送信直前にも既存の同期gateを通すため、状態表示後の失効は送信を許可しない。

`startLaunch`はcomposition起動の完了後にowned collectorを接続し、接続結果が`connected`の場合だけCodexの既知threadを観測する。
active contextはCodex観測が`observed`でcomposition/collector両方のcurrent proofがある場合に限り開始済みとする。
terminal contextはcompositionの`instructionTargetState`が`stopped`を返す場合だけ開始先として認める。この判定はstandalone actor-life/self-ownerと同期最終guardを通り、早期terminal eventだけでは成立しない。
compositionの`result.accepted/status`は元の観測結果を保ち、terminal判定で書き換えない。
各await後にadmissionのstarting状態を再確認し、stopやcloseによる失効後に観測を続けない。
失敗時はadmissionをretireし、native stopを試みる。
`stop`は最初にrouter capabilityを無効化し、collectorを切断してからcompositionへstopを依頼する。
snapshotの`processState === 'stopped'`だけを停止成功とし、確認できない場合は`stop_unconfirmed`を残して固定error codeでrejectする。
server close hookは既存flushが失敗しても実行し、server info削除と全cleanupを試す。失敗時の公開statusは固定値`shutdown_incomplete`とし、error messageやtokenを返さない。
factory closeはservice、router、admissionごとのowned process、storeのflush/closeを順に行い、部分初期化失敗時も作成済みresourceを解放する。

## 保留中のquestion/permission状態

Codex runnerはnative questionとapproval要求を現在のturnに結び付けて保持し、compositionは種類別の件数を`nativeWaiting`へ投影する。
要求が残っている間のtarget stateは`waiting`となり、HTTP serverは`working`以外のtargetへのsteerを拒否する。
このparser、件数の投影、steer gateはfixtureで実装と回帰を確認している。
実runtimeでquestionまたはpermission要求が発生した場合の表示と送信保留は未確認である。

Codex runnerの`approvalPolicy: 'never'`とClaude runnerのpermission mode `dontAsk`は起動時の設定値であり、実runtimeがquestionやpermission要求を出さないことの証拠にはならない。
`mode: 'question'`や`mode: 'permission'`のAPI入力拒否はnative request保留中の処理を通らないため、pending時の送信保留を証明しない。

Claude専用`cockpit_wait`のcontinuation状態は別機能であり、question/permission pending状態と同一視しない。
実runtimeでのpending観測と送信保留は未確認であり、Issue #175のNS09/G4と関連Issue #174/#170の残事項として扱う。

## 検証結果

関連3 filesを`npm run test:inprocess -- test/native-instruction-integration-router.test.js test/native-instruction-service-conformance.test.js test/native-instruction-service-factory.test.js`で実行し、35/35件が成功した。
内訳はrouter 14件、service/provider conformance 17件、factory/server lifecycle 4件である。
自動試験はsend-start永続化、保存失敗時のwrite拒否、detach中の同期再認可、完全なCodex input証拠、unsupported mode、明示start、review/delegated拒否、取消とsend-startの順序競合を両providerで検証する。
question/permissionのmode API拒否も確認するが、これはpending状態を保留する証明ではない。
`test/native-instruction-service-http-target.test.js`はfixtureでCodexのquestion/approval件数表示とcreate/send拒否を確認する。
fixtureはruntime process spawnとprovider event transportを置換する。別turn/input mismatch、client ID欠損、item再利用、早期証拠は`test/owned-native-instruction-dispatch.test.js`と`test/instruction-input-correlator.test.js`の既存回帰が補完する。
NS11では、Claude Code 2.1.292をsource `ea600a000ee77554f750b6bec1aed946d8563ae9`の製品integration factory、native collector/runner/writer、実durable storeへ接続した。
このsourceはe83cf3dの順序修正より前であり、記録済みの実runtime結果は修正前のsourceに対するものだ。
隔離HOMEの同じowned processでboot contextのterminalを確認してから、同じlaunch/session/actor/periodへ明示`start`を1回送った。
追加spawnとfallbackは0回で、実checkpointがstdin write時に`sending`状態だった。native context acknowledgement後に`accepted`となり、独立した次assistant contextとterminal eventも確認した。
acceptedは入力適用を意味しない。Claude native eventでは完全な本文とclient IDを確認できず、serviceAppliedObserved=false、appliedVerified=falseだった。
認証credentialはread-onlyで利用し、前後のfingerprint一致を確認した。隔離HOMEとworkspaceのprompt marker検出は0件、一時runtime全体のcredential token検出も0件で、durable一時storeには指示本文を検出した。child exitとclose、runner inactive、integration closeの確認後に隔離HOME/storeを削除し、cleanup errorはnullだった。
NS11の実測時点では、Claude steer、実question/permission pendingの保留、Codex NS12は未確認だった。
post-e83のClaude経路はfixtureで確認したが、Claude実runtimeは再実行していない。
source、script、resultのSHA-256は調整用worktreeのignore対象manifestに固定し、source `ea600a000ee77554f750b6bec1aed946d8563ae9`、script `763703F6DB3052CDB87FF4A6A80E9736A196BA8F64F4F45F6761D2019D071308`、result `C08B8B2C62AD624A9C526E4A6C5326F67E293061C785117A648B912AFEF93935`を識別子とする。
結果statusは`real_claude_start_accepted_applied_unverified`。
fixtureでpending stateの表示と送信拒否を確認しているが、実runtimeでのpending観測は未確認であるため、NS09の期待条件を満たしたとは扱わない。
この文書だけでIssue #175全体や実native採用の完了を宣言しない。

R1のHTTP target回帰を`npm run test:inprocess -- test/owned-native-instruction-dispatch.test.js test/native-instruction-service-http-target.test.js test/native-instruction-service-factory.test.js test/native-launch-composition.test.js`で実行し、171/171件が成功した。
通常のHTTP回帰では`instructionTargetState` callbackを省略し、Codex working、Claude/Codex standalone stopped、失効後の送信拒否を製品factory経由で確認する。
別の回帰は呼び出し元callbackの上書き、繰り返すGET、stale turn、別launch、Claude steer、delegated terminal、再接続前後、active wait、uncertain write、integration closeを確認する。
writer適格性照会を128回行ってもreservationは消費されず、続く128回のprepareが成功し、上限超過時の送信writeは0だった。
handoff時のtarget projectionは、製品composition、owner router、runner、writer、collectorを通るCodex fixtureでworkingからunverifiedへ変わることを確認した。
これらの自動試験はprocess spawnとnative event transportをfixtureで置き換えており、実Claude/Codex runtimeの証跡には含めない。
R1修正前のHEAD `44e3635`では、専用worktreeで子プロセス起動が許可された条件の`npm test`が1791/1791件成功した。
R1修正前の通常sandbox試行はtest runnerの子プロセス起動時に`spawn EPERM`となり、製品testの失敗とは数えなかった。
結果のsummaryと実行条件はignore対象の`.cross-review/native-integration-full-test.log`に記録した。tool出力上限のため完全なstdoutではない。

R1修正後の専用worktreeで`npm test`を子プロセス起動が許可された条件で実行し、1802/1802件が成功した。
完全な出力をignore対象の`.cross-review/native-integration-r1-full-test.log`に保存した。

## NS12 Codex runtime観測

修正前のsource `9d5f7e1`でCodex CLI 0.160.1を1回起動し、login完了、thread start、native identity、context eventを観測した。
`startLaunch`は正常返却せず、harnessの結果はunknownだった。
初回`turn/start` RPCを1回、native contextを1件観測したが、通常instructionRequestは0回で、bootstrapの完了確認へ到達していない。
cleanup、認証設定不変、source不変を確認した。元のproduct error codeは未保存だが、harnessの固定失敗codeは`product_operation_unconfirmed`として保存されている。
run1時点のsourceではcollector接続がcomposition起動と並行しており、Codex identityが届く前にowned-sourceの5秒attach待機が切れる可能性がある。harnessの固定失敗codeでは原因を識別できないため、これはコード経路からの推定である。

修正後のfactory試験は`npm run test:inprocess -- test/native-instruction-service-factory.test.js`で11/11件成功した。
製品factory、owned runner/source、real file storeを通し、5.2秒のlogin遅延、collector未接続、active proof、actor-lifeを持つstandalone terminal、actor-lifeを持たないearly terminal、pending login中のstopとcloseを検証した。
この遅延とnative eventはfixtureで作っており、Codex runtime再検証の成功証拠には含めない。
run1 harness script SHA-256は`9BCABA656BC8361C3C3B56BD95DF379D6A3748CAFAFF32472DE1148AFD87C108`、sanitized result SHA-256は`2FCB0179E8EE415C1175DEFF8828A69547381FF926A934DC903B938CB0094C42`で、root-side manifestにsource/script/resultを固定している。

run2ではcheckpoint検査が不成立となり、シナリオ結果はunknownだった。後続のreal store自己試験でobserver digest mismatchを再現したが、run2自身の具体的なerror codeは保存されていない。

source `e83cf3d`でCodex CLI 0.160.1を同じowned processで起動し、spawn 1回、boot contextのterminal、明示start 1回、steer 1回を観測した。
両送信ではstdin write前のdurable `sending` checkpoint revision 2と6を確認した。保存envelope digestは独立期待値と一致し、native input全文hashは送信本文と一致した。client ID、thread、turn、native item、service appliedもそれぞれ一致した。
このためstartとsteerの機能証拠は確認できたが、run3の全体statusは`unknown`、failure codeは`scenario_gate_not_met`だった。
清掃前のrunRoot scanでは`rawPayloadOutsideDurableDataCount=1`だったが、summaryに該当artifactのfile分類はなく、種類を推定しない。このraw payload countはdurable data内を対象に含めない。
scan対象はrunRootに限られ、通常HOME、OS store、その他の絶対pathは走査していない。隔離HOMEの`.codex/auth.json`は不在で、既知の認証secret値との照合も実施していない。`credentialPatternArtifactCount=0`は別のpattern scan結果であり、端末全体にtokenがないことを示さない。
summaryの`rawNativeInputSavedOutsideProductData=false`は固定値であり、入力の不存在の証拠には使わない。
child exitとclose、runner inactive、integration close、隔離HOME/cwd/storeの削除を確認し、通常認証設定とsourceが不変であることも確認した。
harness scriptには固定BOOT/START/STEER試験文面が含まれる。sanitized summaryには実測native入力全文、raw frame、tokenを保存せず、試験文面のhashと相関結果を保存する。この保全範囲の記録は、runRoot外を含む端末全体の不在確認ではない。
run3 script SHA-256は`55159428905C999DF2F3D17591DFB40C04D098D14091DA6A1D47FC9F2677B444`、sanitized summary SHA-256は`8A2469AC4360661538ECA9A336D5D0F03C568FBC0B6411DAA9EA0622BFDB586A`で、root-side manifestに固定している。

NS09の実runtimeでのquestion/permission待ちとClaudeのapplied判定は未確認である。
fixtureで検証したPR #202はfeatureへ集約済みであり、実runtimeの確認はmain採用条件として残る。

## 製品からの所有実行の停止

`GET /api/state`の`ownedExecutions`は、compositionが保持するadmission receiptとrunnerから作る。
公開IDや現在の送信proofだけからプロセス所有権を推定しない。
`ownedExecutionDiagnostics.status`は`ready`、`unavailable`、`unconfigured`を区別し、取得不能な停止状態で送信を再開しない。

`POST /api/executions/stop`は、画面の秘密値と同一Originを必須とする。
本文は`launchRef`、`executionId`、`sessionId`、`expectedContextId`、`expectedOwnerGeneration`、`stopRevision`の六項目だけを受ける。
画面で確認した対象と現在の所有実行が一致しない要求は409で拒否し、古い要求を別の対象へ読み替えない。
contextの開始・終了と所有世代の変更でrevisionを単調に進め、取得間に状態が元へ戻った場合も古い確認を失効させる。
送信proofが失効した後も、同じreceiptで所有が確認できるプロセスは停止できる。

停止の開始時に送信権限を失効させ、旧routerとcollectorを分離する。
`stopConfirmed`は、同一childのexitとclose、およびinactiveに加え、旧配送経路の分離をすべて確認した場合だけtrueにする。
物理停止か分離のどちらかを確認できない間は、新世代の開始も保留する。
内部の`predecessorReceipt`で紐づく新しい実行は、明示停止と停止確認を照合してから開始する。
無関係な独立実行をこの保留に巻き込まない。

要求IDの保持件数、残枠、上限128を停止状態に併記する。
128件を保持しただけでは容量超過と推定せず、runnerのstickyな容量保留を投影する。
`failed`は起動失敗の正当な状態として表示し、停止できる所有実行を一覧から除かない。
これらの境界はfake childと製品HTTP経路のfixtureで確認し、実Codex・Claudeの停止結果とは区別する。
