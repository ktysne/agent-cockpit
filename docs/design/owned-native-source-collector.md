# 同owned sourceのcollector結合

## 認可の境界

owned collectorはnative runnerが所有する同process、同pipeへ接続する。
processとpipeの所属はtrustedなprivate opaque capabilityで照合し、公開snapshot、verified値、native ID、数値generationの一致から推定しない。
collectorのepochと接続世代、runnerのprocess世代、runtimeの接続世代はそれぞれ別の寿命を持つ。
compositionだけがruntime接続を開き、collectorは同じopaque接続handleをloanとして借りる。
owned pathはinitializeを再送せず、collectorの独立transportからの観測をowned issuerへ昇格させない。
既存の独立WS collectorとmanaged processの契約を維持する。

collectorのreadonly facadeは同sourceの読取りとlease管理だけを公開する。
generic RPC、認証、thread/turn開始、resume、wait releaseを提供しない。
proofとwriterはcompositionのissuerと全owner chain facadeを通して取得する。
初回attachでは同sourceでattest済みの現在proofをborrowできる。
reconnectは旧receiptやcached contextを証拠にせず、新leaseへ結び付いたfresh read receiptと明示attest/reconcileを必要とする。
thread statusやmodel payloadからcurrent turnを作らない。

## logical detachとphysical source

logical detachはlease epochを無効にし、runtime接続と現在owner chainのcached proof/writerを失効させる。
owned processを停止せず、actorとcanonical periodを終了しない。
意図したdetachを観測欠落として扱わず、uncertain contextやcontext tombstoneを捏造しない。
physical processとpipeの生存検査はruntime認可から分離し、同pipeの再attachを許可する。
再attachは新leaseと新runtime接続世代を作り、fresh確認前のproof/writer利用を拒否する。
確定終了済みcontextと既存uncertain contextは再利用しない。
同pipeのmatching terminalはdetach中も既知終了として保持し、actorまたはperiod終了へ変換しない。
別processのephemeral再起動は新attemptとして扱い、同period reconnectへ変換しない。

## 独立した適合シナリオ

| ID | 共通期待値 | 観測点と期限 | 禁止する副作用 |
|---|---|---|---|
| ID-F10-S01 | 同process/pipeの初回attachで同opaque runtime接続とattest済みproofをborrowする。 | runner capability、collector lease、composition handle同一性、全chain facade。fixture5秒以内。 | initialize再送、collector openConnection、重複registration、別issuer proof、writer新規作成0回。 |
| ID-F10-S02 | sourceのclaimを早期予約し、別broker/attemptによる二重claimを拒否する。 | constructor時の予約、lease所属、元ownerの認可。同期fixture1秒以内。 | 拒否claimのnative RPC、認証、runtime接続、元sourceのdetach/kill0回。 |
| ID-F10-S03 | clone、foreign capability、同numeric generation、別pipe、外部verified/model payloadではproofを認可しない。 | facade結果、authority呼出し回数、公開snapshot。同期fixture1秒以内。 | proof発行、writer認可、capabilityの保存・公開0回。 |
| ID-F10-S04 | logical detachで旧lease、proof、writerと現chainの子cacheを失効し、physical sourceとperiodを維持する。 | lease fence、runtime接続、child process、actor/period、既知context集合。fixture5秒以内。 | child kill、actor/period終了、観測欠落やuncertain/context tombstoneの捏造、旧認可復活0回。 |
| ID-F10-S05 | 同生存pipeのreattachは新leaseとruntime世代を持ち、fresh receiptと明示再照合後だけ新proof/writerを認可する。 | opaque lease、read receipt、native context、kernel接続、owner chain。fixture5秒以内。 | 旧receipt/cacheの認可、新registration、immutable変更、子proofの自動復帰0回。 |
| ID-F10-S06 | pending read中のdetach、source失効、period終了、同期再入は、遅延結果とclone receiptを拒否する。 | async前後のleaseとepoch、callbackなしの最終proof facade、その後のprivate lease fence。fixture5秒以内。 | 遅延結果からのproof/writer発行、再入sink、別source認可0回。 |
| ID-F10-S07 | detach中のmatching terminalを保持し、同contextのreattach/replayを拒否する。 | runner内部identity/current context、composition既知終端、fresh別context。fixture5秒以内。 | known-ended contextの発行、actor/period終了、terminalをpositive生存証拠へ変換する操作0回。 |
| ID-F10-S08 | 新process/pipe、旧epoch通知、別attemptはsameperiod reconnectにならない。 | private source所属、runner世代、canonical period、immutable binding。fixture5秒以内。 | 別processの旧period再利用、旧lease再有効化、外部JSONによるsource切替0回。 |

## trusted interface

composition.createOwnedCollector(admissionReceipt, {onObservation})は同admissionに1つのcollectorを予約する。
同receiptでの再呼出しは同collectorを返し、onObservationを置換しない。
createManagedCollectorのownedSourceAccessorはprivate accessorだけを受け付け、transportや外部verified値でowned pathへ切り替えない。
collector.snapshotは既存sanitizeManagedCollectorSnapshotを通し、version:1の公開allowlistを維持する。
proof失効時はstatusをunknownにし、同periodで最後に確認したactivity、turnState、turnIdを保持する。

runnerのownedSourceClaimはcompositionがattempt単位で固定するopaque owner tokenである。
onSourceReady(capability)はspawnとstdio listenerの準備後、identity到着前に一度呼ばれる。
getOwnedSource(capability)はprivate WeakMapで同process/pipeを照合する。
readonly facadeは固定provider/hostId/homeScopeIdと、bindOwner、acquireReadLease、readCurrent、consumeReadReceipt、subscribe、releaseReadLease、checkLease、checkSource、subscribeTerminalだけを公開する。
ownerはsourceの全寿命で固定し、release後も別ownerへ移さない。
connection receipt、lease、read receiptはobject identityで扱い、JSON cloneや数値generationから再構築しない。

初回connectはidentity登録後の同runtime接続へobserverを同期的に取り付ける。
identity前にconnectした場合も予約を維持し、5秒以内にsourceとidentityが確認できなければunknownを返す。
Codexのowned sourceはinitialize.codexHomeと設定された隔離HOMEを照合した後にだけidentity/contextを採用する。
readCurrentは同stdioのthread/loaded/listとthread/read(includeTurns:true)だけを使い、同current turnのinProgressを確認する。
attested結果のone-use receiptをconsumeし、captured lease/connectionが現在であることを確認した後にだけattest/reconcileする。
再attachだけではcontext cacheを消去せず、proofを発行しない。
ClaudeのreadCurrentはunsupportedであり、同pipe初回proof借用とterminal拒否を確認する。
Claudeのpositive reconnectは実確認まで認可しない。

owned readのactor/proof変更には任意のtrusted同期mutation guardを渡す。
runtime kernelはmetadata callback前後のcanonical registration/launch revision、captured source guard、private connection/context/actor/immutable owner generationを確認し、最後のcallback後にMapを変更する。
guardのthrow、thenable、true以外の値は変更前に拒否する。
全chain proof facadeを通した後にもprivate lease fenceを確認し、awaitを挟む消費者は同期payload gateを再実行する。
#174への注入は既存get/snapshotとcomposition.checkCurrentProofを閉じたtrusted facadeにし、kernelを直接渡さない。

fixtureは実registration/launch/runtime adapterと実owned runnerへfake stdio pipeを接続する。
これは実native modelや認証の検証を代替しない。
fixtureは同sourceのissuer相関と認可契約を確認する。
実native runtimeの読取schema、認証後接続、delegated/handoff/reconnectは、該当runtime版の実probeで別に確認する。

## fixtureの確認範囲

専用owned-native-source-collector.test.jsは両providerの実runner、registration、launch、runtime adapterをfake stdio pipeへ接続する。
初回borrow、duplicate/foreign拒否、detach中の旧proof/writer拒否、last-known投影、same-pipe再attachのfresh前拒否、Codexの同context fresh read後の新proof/writer認可、Claude unsupported、切断中terminal、遅延read、kernel callback中のnew leaseへの切替を検証する。
実durable storeへの注入では送信開始保存後のdetachがunknownとなりsinkは0回、自動再送を拒否する。
fresh前の再attachは送信開始前にdelivery_target_unavailableで拒否する。
runtime-binding.test.jsは任意guardのfalse/throw/thenable、canonical revision不足、最後metadata callbackのsource/context/period失効とlatest-proof再入を検証し、actor新規登録や拒否時の新proof置換を防ぐ。
これらはfixtureの適合結果であり、実native model、認証、delegated/handoff/reconnectのlive結果を示さない。
capability facadeとsource accessorはtrusted composition内に閉じ、HTTP、保存JSON、public observationへ公開しない。

## 確認した実接続の範囲

2026年10月7日、source commit `87d1d3ca3541689c3955a2bfa5f242023f6dc2fe`をClaude Code 2.1.291へ隔離HOMEから接続し、standalone owned sourceの初回collector結合を確認した。
同physical sourceへのcollector接続と同opaque proofの借用はいずれも成功し、native spawnは1回、collector observationは5件、公開schemaも適合した。
context終端後は旧proofとwriterを拒否し、actorとcanonical periodはactive、contextStateはendedとなった。
collector detachはcanonical periodを維持し、owned stop後はchildのexitとcloseを確認した。
通常HOMEのCodex/Claude認証ファイルは不変、隔離HOMEの認証関連artifactの新規作成は0件だった。

結果区分は実Claudeのstandalone owned native runtime probeであり、fakepipe fixtureとは別の実接続証拠である。
同commitの全体テストは1466/1466 PASSで、CodeGraph同期とdiffcheckも成功した。
検証結果はexcludedな`.cross-review/native-live-binding-probe-results-claude-lifecycle-e6c98bd1-fd88-4909-97f2-984c5a7961ba.json`に保持する。
同sourceのpositive reconnect、delegated、handoff、およびCodexの実接続は未確認であり、後続の採用gateとして残す。
