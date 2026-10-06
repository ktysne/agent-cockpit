# 現行ownerとnative照合の核

## 対象と信頼境界

Issue #171-BのCockpit側コアは、#171-Aの不変bindingを読み取り、現行ownerとcurrentProofを管理する。
#170の先行read-only collectorは実装済みだが、native issuerと同じsourceからのproof発行への接続は未確認である。
このコアのfixture成功は実native証拠の取得やruntime採用の完了を意味しない。

信頼済みdaemon組立コードだけがauthorityを保持する。
接続の認証、HOMEの確定、native actor/contextの所属、起動との相関、handoff送信者の認証は、authorityを呼ぶ前にcollectorが検証する。
公開JSON、PID、cwd、継承環境、履歴、verifiedフラグからauthorityやproofを作らない。
証拠metadataは#166と同じ許可リストで縮約し、秘密値とpayloadを保存しない。

## 固定値と現行値

不変claimsはlaunchId、runId、attemptId、provider、nativeIdKind、hostId、homeScopeId、origin、purpose、originBinding、identity、executionBindingの完全な組とする。
identityはprovider/nativeIdKind/hostId/homeScopeId/nativeId、executionBindingはperiodId/actorである。
#166のexecutionIdがperiodIdであり、runIdやlaunchIdに置き換えない。

AのcurrentOwnerは初期ownerとして読み取る。
Bへ取り込んだ後の現行ownerとownerGenerationはBだけが更新し、originBindingとexecutionBindingは更新しない。
現在ownerの期間またはactor終了は、子を終了させず現行proofを失効させる。
handoff後の起動元だけの終了は、子と新ownerの有効なproofを失効させない。
AのbindExecutionを再照合時に呼ぶと終了済みの起動元親を再要求してしまうため、BはAの読取registryだけを使う。

## API

製品ファイルはsrc/server/runtime-binding.jsとする。
登録核とlaunch核にはcallbackなしのreadonly authority revisionを追加し、既存の保存schemaを維持する。

`createRuntimeBindingKernel({registrationRegistry,launchRegistry})`はregistryとauthorityを返す。
以下の入力は完全なschemaとして検査し、不明なclaimsキーを拒否する。
metadataの不明キーは捨てる。

| API | 契約 |
|---|---|
| authority.adoptExecution(launchRef, immutableExecutionClaims) | Aのbound記録と完全一致した固定値を取り込み、初期owner、generation 0、proof nullを保持。同内容再送は冪等。native検証への昇格はしない |
| authority.openConnection(scope, connectionId, evidence) | scopeはprovider/nativeIdKind/hostId/homeScopeId/connectionSlotId。返却値は{connectionHandle,connectionGeneration}。同slotの新しいconnectionIdで内部世代を1増やし、旧接続を失効。同じlive接続と同証拠は冪等。切断済みIDを再使用しない |
| authority.disconnect(connectionHandle) | 当該接続を失効。旧接続の遅延disconnectは新接続に影響しない |
| authority.attestActor(connectionHandle, claims, evidence) | claimsはidentity/periodId/actor/contextId/launchRef/immutableExecutionClaims。owner単独の証明では末尾2項をnull。子証明はlaunchRefと完全な固定値を明示。返却値は{actorHandle}。接続scope、同じ#166のactive期間、A bindingを照合 |
| authority.endContext(actorHandle) | 現接続の当該identity、period、actor、contextだけを不可逆に終了。同じcontextのalias handleと旧proofを失効し、actorと期間は終了しない。旧接続の遅延終了はfalse |
| authority.endActor(actorHandle) | 当該period/actorを不可逆に終了。別contextの同actorも失効。同じ期間での再attestを拒否 |
| authority.reconcileExecution(launchRef, {executionActorHandle,ownerActorHandle,expectedOwnerGeneration}) | 子と現行ownerの新鮮なactor証明を照合して{proofHandle,currentProof}を返す。実行側claimの省略やowner世代不一致は拒否 |
| authority.handoff(launchRef, transition, newOwnerActorHandle) | 認証済みtransitionのCASを実行し、proofをnullにする。新ownerのfresh actor証明を要求。旧ownerの生存は要求しない |
| registry.checkCurrentConnection(connectionHandle) | private opaque handleの現在の接続世代とslotを同期検査しbooleanを返す。JSON複製、他kernel、旧接続はfalse。metadataからcapabilityを復元しない |
| registry.checkProofCapability(launchRef, opaqueHandle) | callbackなしの同期boolean検査。private proof所属、latest、immutable claims、owner世代、execution/owner接続、actor/context tombstoneを確認する。foreign handleはfalse。canonical period/launchの現状態は別のrevision検査を必要とする。 |
| registry.checkCurrentProof(launchRef, proofHandle) | A state、固定値、子とownerの#166期間、actor終了、両接続世代、現行owner世代、最新proofを使用直前に再検査し、okと理由を返す |
| registry.observe(identity, metadata) | 未確認観測を保持するだけ。取り込み、接続登録、actor証明、writer発行を行わない |
| registry.get(launchRef), registry.snapshot() | 深いコピーの公開情報。capabilityを含めず、失効したcurrentProofはnull |

actorの生存はtrusted native attestationを受けた記録だけから判定する。
active期間、PID、プロセスの存在だけではactor証明を作らない。
context終端は当該contextの認可だけを失効し、actor、canonical期間、owned processの寿命を変更しない。
proofの使用、再照合、handoff先の認可にはactor生存とcontext有効性の両方を要求する。

接続失効だけではactorを終了しない。
snapshotのactor状態は、期間終了またはactor終了ならended、接続失効だけならunknown、active期間と現行接続ならactiveとする。
旧世代のactorHandleによる遅延endActorは現行actorを終了させない。
snapshotには既存actor stateに加えてcontextStateを返し、context終端後もactor stateはactiveのまま、contextStateはendedとなる。

connectionHandle、actorHandle、proofHandleは空の凍結objectとprivate WeakMapで管理する。
JSON複製、別kernel発行、公開snapshotから復元したobjectは受理しない。
接続slotとconnectionId、起動、証拠、actor tombstoneは上限を持ち、上限超過をfail closedで拒否する。
接続IDと証拠IDの同内容再送と別内容すり替えを区別する。
同じ接続世代、完全identity、contextIdの組を異なるperiod/actorへ再割当しない。
異なるidentityまたは期間では同名contextIdを区別する。
確定終了済みcontextはidentity、period、actor、contextIdの組で保持し、新接続世代でも再attestを拒否する。
終了が確定していないcontextの新接続世代での再attestは許し、fresh証拠との再照合を要求する。

handoff transitionはhandoffId、expectedOwner、expectedOwnerGeneration、newOwner、newOwnerGeneration、immutableExecutionClaims、evidenceを持つ。
新世代は旧世代+1の安全な整数に限る。
同handoffIdの同じ正規化内容は既存receiptを返し、別内容は拒否する。
同内容再送は、その後の接続失効や次のhandoffがあっても過去のreceiptを返すだけで、現行ownerとproofを変更しない。
初回受理時は現行ownerと世代のCAS、固定値、新ownerの証明をすべて検査してから更新する。

createProviderRuntimeAdapter(provider,registry,authority)は完全なscopeとidentityを受け、固定provider/nativeIdKindと一致させる。
launchRef操作と子actorはadapterのproviderに限定し、disconnect/endActorはhandle自身のproviderに限定する。
adapterのdisconnect/endActorと実行側actorは、そのadapter instanceが発行したhandleに限定する。
handleの初回発行instanceを共有private WeakMapへ記録し、公開snapshotからの同内容再送でも別instanceへ再発行しない。
同じinstanceでの接続とactorの同内容再送は同じhandleへ解決する。
ownerは子と異なるproviderやHOMEを許すため、reconcileとhandoffのownerHandleには子providerの制限をかけない。

公開currentProofには固定宛先、owner、ownerGeneration、両connectionGenerationとcontextIdの非秘密な要約だけを含める。
公開要約自体はcapabilityではない。
成功したproofはwriterやdeliveryを発行せず、#166-Bと#175の採用側が操作直前にcheckCurrentProofを呼ぶ必要がある。

## 実装前に固定する共通scenario

期待値は不変binding、ownerのCAS、接続失効、未確認情報の非昇格という共有契約から定める。
全scenarioをClaude/Codex両方の製品registration、launch、runtime adapterで実行する。
fixture issuerはauthorityを保持するが、実native認証を模倣して完了扱いにはしない。
各テストの観測期限は1秒とし、待機やネットワークを使わない同期判定で検証する。

| ID | 入力と操作 | 独立した期待値と禁止副作用 |
|---|---|---|
| ID-F03-B01 | 公開observeにverified、PID、cwd、継承claimsを渡す。複製または別kernelのhandleで照合する | proofを作れず、秘密metadataを保存せず、#166の期間とwriter状態を変えない |
| ID-F03-B02 | native identity、period、actor、context、launch固定値の欠落またはすり替え | attest/reconcileを拒否。対象と別の登録済みactor/contextのproofを流用しない。固定bindingと現行ownerを変えない |
| ID-F03-B03 | 同じ#166へ登録した子とownerを完全claimでattestしてreconcile | 固定した子identity/bindingとowner、世代0のproofを返す。Aを変更せず、writerを発行しない |
| ID-F04-B01 | 子またはownerの同slotを新connectionIdで再接続。旧disconnectと旧attestを遅れて送る | 旧proofを拒否。期間を新設せず、旧disconnectは新接続を失効させない。失効側を再attestし両側をreconcileするまでproofなし |
| ID-F04-B02 | active期間のactor終了、#166期間終了、A launch終了を別々に行う | それぞれ既存proofを拒否。actor終了は同actorの別contextも失効。再送や新接続で終了actorを復活させず、他actorや子期間を終了しない |
| ID-F04-B04 | Claude/Codexの子または異provider owner contextを終了し、alias、再送、同slot再接続、fresh contextを順に照合する | 旧proofとended contextの再attestを拒否。actor stateはactive、contextStateはended。fresh contextの明示reconcileだけが新proofを作り、旧opaque proofは復活しない。registration、既存writer認可、A binding、owner世代を変更しない |
| ID-F09-B01 | 世代0から1へのhandoff、同ID同内容再送、同ID別内容、旧CAS、世代飛び、固定値変更を順に送る | 正しいtransitionだけ1回反映し、受理後proofはnull。再照合前の旧proofを拒否。固定値とA記録を維持 |
| ID-F09-B02 | 起動元owner終了後、freshな新ownerへ認証済みhandoffし、子と新ownerを再照合 | 子の期間はactiveのまま。A bind再実行なしで新owner世代のproofを発行。未認証観測から自動handoffしない |
| ID-F09-B03 | 1→2のhandoff後、0→1の同内容再送。snapshotを別kernelへ渡す | 過去receiptのみ返しownerは世代2のまま。snapshotとJSONは新kernelのproofにならない。復元によるowner権威を作らない |

禁止副作用は実registration registryのsnapshotとwriter認可、A registryのsnapshot、Bの固定値と現行ownerを比較して観測する。
呼ばれない架空deliveryやstoreの常時0カウンターを合格根拠にしない。

## #170との合同試験ゲート

先行read-only collectorからnative issuerとproof発行を接続して採用する前に、以下を実接続で満たす必要がある。

1. 専用HOME、127.0.0.1 app-server、接続認証を確定し、外部JSONからauthorityへ到達する入口を設けない。
2. 実socketごとのconnectionIdと安定slotを管理し、再接続時のsnapshotとイベントを同じ世代で照合する。遅延旧イベントは旧handleのまま拒否する。
3. native thread/session、turn/item/context、actorとcanonical期間の対応を実証する。PID、cwd、継承されたlaunch値だけを根拠にしない。
4. 起動時の一度限り相関を完全なlaunch/run/attempt、HOME、native identity、子period/actorへ結び付ける。別起動の相関再使用と重複collectorを拒否する。
5. handoffの発行主体を認証し、owner CASと連続世代を検証する。owner終了や切断を自動handoffの根拠にしない。
6. 再接続、親終了、actor終了、遅延イベント、handoff再送を両providerで実測し、配信直前のproof失効を#166-B/#175採用側で確認する。

外部bridgeとHOMEへ必要な変更は、issuer呼出元、接続scopeの取得元、actor対応の根拠、handoff認証経路を実装候補としてレビュー可能にした後、開発者の確認を受けて適用する。
このPRでは外部ファイルを変更しない。

## 復元と残る境界

この核は同じプロセスに保持した記録だけを権威として扱う。
snapshotをauthorityへ戻すAPIは持たない。
#177で認証されたcheckpointとhandoff履歴を再検証するまでは、再起動後のownerとproofを未確認として扱う。
#170のnative issuer接続、#180-Aのrunner採用、#166-Bのwriter境界、#175の配信、#177の復元が通るまでIssue #171全体は完了にしない。


## 外部bridge変更の候補

bridge正本D:/Desktop/Develop/claude-codex-bridgeのHEAD 456e7b2b916fcd94fe80e7edc85bd53a233a9d62を読取確認した。
同正本のtools/codex-agent.shはrun、PID、開始時刻とwait結果を監査行へ書くが、native actor/contextを証明しない。
必要な変更候補と適用条件は以下である。

| 対象 | 提案する変更 | 適用前の確認 |
|---|---|---|
| bridge tools/codex-agent.shとrunner module | 起動前にlaunch/run/attemptと起動元を確定し、#170の認証済み接続slotと起動相関を受け取る。秘密相関はメモリー内に置き、監査行とwait状態には書かない | 同期、背景、wait、取消、再試行の既存動作と相関の一度限り使用を実runtimeで確認 |
| #170 collectorとCockpit daemon組立adapter | 実接続由来の完全scopeをopenConnectionへ渡し、native actor/contextと期間の証拠をattestActorへ渡す。切断はdisconnect、実actor終了だけをendActorへ渡す | collectorが返すwire証拠、接続認証、HOME scope、native context対応を合同試験で確定 |
| owner移譲issuer | 認証したhandoffId、固定claims、旧owner/世代、新owner/連続世代をhandoffへ渡す | 重複collector、旧接続、旧世代、同ID別内容を拒否し、再照合前の操作を保留 |
| bridge試験と導入文書 | 上記のnative相関試験、戻し方、監査行互換、HOME配置対象の差分を追加 | bridge正本のPRでレビューし、開発者の確認を受けてからHOMEへ同期 |

通常HOMEの候補は~/.claude/tools/codex-agent.sh、codex-agent-hook.js、必要なgpt-agents定義とhook設定である。
collectorのwire証拠が未確定なので、ここでは配置する差分や導入の承認を求めない。
実際の変更では各対象の具体的な差分と合同試験結果を用意し、開発者の確認を最後の適用手順にする。


## コア検証結果

専用単体試験10件と、Claude/Codex双方を通す共通scenario8件が通過した。
共通scenarioにはstandalone self-owner、異provider owner、接続失効のunknown表示、現在owner終了、起動元終了後のhandoff、過去receipt再送を含む。
全体のnpm testは1113件通過し、fail、cancelled、skipped、todoは0件だった。
この結果はfixture issuerを使ったコアと製品adapterの適合であり、実native認証や配送の成功件数へ合算しない。

専用worktreeでCodeGraph init、sync、exploreを実行し、変更後も索引を同期してproof検査の影響範囲を確認した。
担当サンドボックスのexploreはunable to open database fileで失敗したため、主担当が権限を拡張した同worktreeで実行し、現行ソースと照合した。

## canonical authorityのrevision

registrationとlaunchのregistryは`captureAuthorityRevision()`と`checkAuthorityRevision(opaqueStamp)`を持つ。
stampはkernelごとのprivate frozen objectで、認可に影響するauthorityの実変更ごとに新しいobjectへ置き換える。
新規登録、period終了、writerの作成と置換、launch bindingと終了はstampを更新する。
途中で変更した後に例外が出ても、変更前のstampを有効に戻さない。
拒否して変更しなかった操作と完全同一の冪等操作はstampを維持し、unverifiedなobserveや読取りでは更新しない。
両methodはsnapshot、外部getter、clock、callbackを呼ばない。
foreign kernel、JSON複製、復旧前のstampはfalseとなり、stampを保存schemaへ追加しない。
現kernelには直接restore/reset/eviction APIがなく、復旧時は新kernelの初期stampとauthority replayで別の寿命を持つ。

`checkProofCapability`はcanonical periodの生存やlaunch状態を単独では認可しない。
compositionはmetadata検査前にcanonical stampを捕捉し、callbackを含む検査がすべて終わった後に両stampと全nodeのprivate proof capabilityを確認する。
