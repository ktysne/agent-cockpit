# 起動登録と不変bindingの核

## 対象と信頼境界

Issue #171-Aは、信頼済みdaemon組立コードが保持するin-process authorityで起動を登録し、#166-Aで登録済みの期間へ結び付ける核を提供する。
外部runnerの認証、native証拠の検証、actor所属の実測は#171-B/#170/#180-Aに残る。
authorityは外部JSONから取得・作成できる認証情報ではない。
公開observerの入力は未確認のまま保持し、writerや期間を発行しない。

起動登録と期間結合は二段階に分ける。
この核から#166のregister、bindWriter、endは呼ばない。
結合拒否時に余分な期間やwriterが残らないように、同じregistrationRegistryの読取snapshotへ照合し、検査がすべて通った後に起動側だけを同期更新する。
#166のexecutionIdは本書のperiodIdであり、launch/run/attemptとは別の識別子である。

## APIと担当境界

所有する製品ファイルはsrc/server/launch-binding.jsとし、test/launch-binding.test.js、test/provider-launch-binding-conformance.test.jsを追加する。
state.js、events.js、store、server.js、MCP入口と既存登録核は変更しない。

`createLaunchBindingKernel({registrationRegistry})`は公開registryと信頼済みauthorityを返す。
authorityだけがregisterLaunch、bindExecution、endLaunchを持つ。
registryはobserve、get、snapshotだけを持ち、読取値は深いコピーにする。

起動claimsはlaunchId、runId、attemptId、provider、nativeIdKind、hostId、homeScopeId、origin、purpose、originBindingを明示する。
canonical attempt keyはlaunchId/runId/attemptIdの組であり、同じ組のprovider差も衝突として扱う。
standaloneのoriginBindingはnull、delegated/reviewは親のperiodIdとactorを保持する。
同じ起動claimsと証拠の再送は同じlaunchRefへ解決する。
launchRefは非機密参照であり、authorityや起動証明の代わりにならない。

bindExecutionは完全identityとexecutionBinding={periodId,actor}を同じ#166 registryへ照合する。
証拠metadataのregistrationRefは対象launchRefと一致させる。
actorのkindとidは信頼済みissuerの明示claimとして受け取り、#166-Aにactor台帳がないためnative所属を検証済みとはしない。
子自身のbindingは一度だけ設定し、同じperiod/actorへの別attempt登録、同じ証拠のすり替え、終了した期間への結合を拒否する。
親の期間も存在とactive状態を照合し、親と子のproviderやHOMEが等しいとは仮定しない。

初期currentOwnerはdelegated/reviewではoriginBinding、standaloneでは自身のexecutionBindingとする。
ownerGenerationは0、currentProofはnullとする。
ownerの変更API、配信認可、writer発行は提供しない。
起動登録済み・binding済み・現行配信可能を別の条件として扱う。
endLaunchは起動記録だけを不可逆に終了し、期間や他のactorを終了させない。

## 共通scenarioと期待値

期待値は共有契約とIssue #171の二重登録防止・宛先分離から定める。
各scenarioはClaude/Codex双方の製品登録adapterと製品launch adapterを通す。
証拠はtest issuerの模擬metadataであり、実runner認証の成功には数えない。
観測点は同期APIの返却時と各操作後の両kernel snapshot、watchdogは1秒、件数・宛先・不変claimsの許容差は0とする。
能力条件は信頼済みin-process組立が#166 registryと両authorityを保持し、完全scopeとactor claimを明示できることである。
provider/nativeIdKindとnative IDの表現だけを仕様差とし、期待値を片方のadapterの結果から生成しない。

| scenario ID | 操作 | 独立した期待値 | 禁止副作用 |
|---|---|---|---|
| ID-F02-L01 | 公開observeへverified boolean、PID、cwd、時刻、継承Claude IDと秘密を追加する | 保存は未確認と許可metadataだけ。authorityへ自動昇格しない | 期間、bound launch、writer、起動、配送、秘密保存は各0回 |
| ID-F02-L02 | standalone/delegated/review登録を同内容で再送し、同じattemptのscope/origin/actor/証拠を変える | 同内容は同じ参照。変更は拒否し初期起動claimsを保持する | 重複launchと既存claims上書きは0回 |
| ID-F02-L03 | 完全identityと登録済みperiod/actorを結合し再送する。別attemptから同じbindingを登録する | 初回だけ結合、同内容再送は冪等、別attemptの実宛先重複は拒否する | 余分な期間、重複binding、writer、配送は各0回 |
| ID-F02-L04 | 結合済みの子identity、provider、native kind、host、HOME、native ID、period、actor、証拠参照を一つずつ差し替える | 全claim一致時だけ結合。既存bindingとoriginBindingを保持する | 不一致による結合・期間生成・writer認可は各0回 |
| ID-F02-L05 | 親子を別期間に登録して結合し、返却値と入力を変更する | 子のbindingと親ownerを別々に保持し深いコピーで不変情報を保護する | 親への子binding上書き、owner変更、暗黙handoffは各0回 |
| ID-F02-L06 | 期間またはlaunch終了後の遅延結合、旧登録再送、新attemptを与える | 終了は不可逆。旧記録参照だけではactiveへ戻らない。新attemptは明示的新期間にだけ結合する | 旧期間/launch復活、再起動、writer発行は各0回 |

保存復旧、currentProof、handoff、結果返却とMCP宛先統合はAの未実装範囲であり、このscenarioの成功から採用しない。
実runtime層は未確認と記録する。

## 後続へ渡す実bridgeの接点

read-onlyで確認したbridge正本はD:/Desktop/Develop/claude-codex-bridge、HEADは456e7b2b916fcd94fe80e7edc85bd53a233a9d62である。
同リポジトリのtools/codex-agent.shはrun/pid/startedと結果の監査行を出すが、launch/attempt/native bindingの登録は持たない。
tools/codex-agent-hook.jsはラッパーのツール使用を制限するフックであり、認証済み起動やactor所属を証明するissuerではない。
既存監査行のPIDと時刻を本核のauthorityへ変換しない。

#171-B/#180-Aで変更を具体化する対象はbridgeのtools/codex-agent.shと専用試験、必要なrunner/verifier moduleおよび導入文書である。
新issuerが起動前にclaimsを確定し、起動ごとの照合値をメモリー内で子へ渡し、所有runnerの登録、native identity、MCP metadataを照合した後にだけ本核へ結合する。
外部issuerを導入するときは、Cockpitのdaemon組立で検証済み情報をin-process authorityへ渡すadapterを別に設ける。
秘密の照合値、認証token、会話本文やツール全文はmetadata、snapshot、監査行に渡さない。
実bridgeと実runtimeが提供できる証拠の形はまだ未確認であり、この説明だけで採用を確定しない。

通常HOMEへ配置する具体的候補は~/.claude/tools/codex-agent.shとcodex-agent-hook.js、必要なgpt-agents定義とClaude hook設定である。
導入前に各対象の差分、旧監査互換、実HOME scope、同期/背景/wait/再試行の検証手順、戻し方を開発者へ提示する。
確認後にbridge正本を変更・試験し、承認済み差分だけを通常HOMEへ配置する。
この段階では別repositoryとHOMEを変更しない。

## 検証結果の記録方法

共通コア、両製品adapterのfixture適合、実runtimeを別々に報告する。
Node.js 24.15.0、gh 2.92.0、Codex CLI 0.160.1、Claude CLI 2.1.291を版取得で確認した。
版取得は実native証拠、actor所属、MCP metadataやcurrentProof能力の実測ではない。
CodeGraphは専用worktreeでinit、sync、exploreを行い、製品登録入口と契約モデルの所在を確認した。
通常サンドボックス内での索引利用がdatabase openエラーになる場合は、この成功済み索引と現行ソースを照合して調査する。

## 後続合成に渡す読取レコード

registerLaunchの返却値は`{launchRef}`である。
bindExecutionとregistry.getの読取レコードは起動claims、launchRef、state、registrationEvidence、identity、executionBinding、conversationId、sessionId、bindingEvidence、currentOwner、ownerGeneration、currentProofを持つ。
結合前はidentity、executionBinding、conversationId、sessionId、bindingEvidenceがnullである。
standaloneのcurrentOwnerは結合前にはnull、結合後には自身のexecutionBindingになる。
公開snapshotはlaunchesとobservationsを持つ。
observationはclaims、status=unverified、metadataを保持し、観測の後にauthorityが登録しても自動昇格しない。

`createProviderLaunchAdapter(provider, registry, authority)`はproviderと明示nativeIdKindを固定したobserve、registerLaunch、bindExecution、endLaunchを提供する。
このadapterも信頼済み組立用であり、authorityを持つadapter全体を外部観測入口へ渡さない。
公開observerにはregistryだけを渡す。

結合済みレコードの再送でも、同じ#166 registryの子期間と起動元親期間がactiveであり、完全identityが一致することを再確認する。
終了済みlaunchの旧登録参照は履歴として取得できるが、新しい稼働証拠にはならない。
period終了はlaunch記録のstateを自動で書き換えず、後続の現行照合が配信可否を判断する。

#167-Aのprojectionは本記録を表示・相関の読取値として使えるが、native actor証明やwriter権限として扱わない。
同担当と合意したresolveActorCorrelationは信頼済みin-process組立が供給する任意capabilityであり、fixtureの型付き相関と実native証拠を区別する。
本核のbound状態だけからその相関resolverをverifiedへ昇格させない。
#166-Bは#171-BのcurrentProofと実native contextの照合を接続してからwriterを発行する。
#177-Aは履歴の保存schemaを接続し、保存された読取値からauthorityやcurrentProofを復活させない。



## 自動試験の結果と未確認範囲

共通核の専用試験6件と、ID-F02-L01〜L06の両製品adapter適合6件が成功した。
適合試験の各scenarioはClaude/Codex双方へ同じ独立した期待値を適用し、各APIの返却時に観測する。
scenarioのwatchdogは1秒であり、fixtureの非決定な内部ID以外に許容差を設けない。
#166の期間snapshotの不変性、起動参照をwriter tokenとして渡した実adapterの拒否、親期間終了後の結合再送拒否と子期間の維持を確認した。
起動・配送・store書込み・handoffは本核に操作口や接続がなく、これらの実runtime副作用を実測した試験には数えない。

全体のnpm testは1095件成功、失敗・cancelled・skip・todoは各0件だった。
専用試験はnode --test --test-isolation=none test/launch-binding.test.js test/provider-launch-binding-conformance.test.jsで実行し、12件成功だった。
3つの製品/試験ファイルのnode --checkも成功した。
これはtest issuerの模擬証拠による製品核と製品adapterの確認である。
実bridgeの認証済み起動、実native証拠、actor所属、HOME認証、native MCP metadata、currentProof、handoff、保存復旧と実配送は未確認であり、成功へ含めない。

#171-Aの提供でIssue #171全体を閉じない。
#171-B/#170/#180-Aで実証拠と接続世代を結合し、#166-Bでdelegated MCP、#177-Aで保存復旧を接続してから対象機能の採用を判断する。
