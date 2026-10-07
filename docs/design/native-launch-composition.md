# Native launch composition

## 適用範囲

native launch compositionは、信頼済みのin-process呼出しからowned runnerを起動し、そのrunnerが同じ専用pipeで報告したnative identityとcontextを登録済みexecutionへ結び付ける。

compositionはHTTP、MCP、外部JSONからlaunch receipt、actor proof、writerを作らない。

compositionが発行するactorはbroker内のexecution actor keyであり、providerがnative actor IDを発行したことを意味しない。

runnerの実native protocol接続とreal runtimeでの証拠は、fake stdio fixtureの成功からは推定しない。

## 公開API

`createNativeLaunchComposition({ registrationKernel, launchKernel, runtimeKernel, runnerFactory, getAuthentication, onAuthenticationRequired, hostId, profiles })`は、`admitLaunch`、`start`、`stop`、`handoff`、`reconcileProof`、`resolveProof`、`checkCurrentProof`、`writerFor`、`authorizeWriter`、`snapshot`を返す。
registrationとlaunchのregistryにはcaptureAuthorityRevisionとcheckAuthorityRevision、runtimeのregistryにはcheckProofCapabilityを必須とする。
これらはtrusted kernelのcallbackなしmethodを渡し、公開metadataで代替しない。

`profiles`は`provider`、絶対`executablePath`、絶対`homePath`、`homeScopeId`、絶対`cwd`を持つ固定allowlistであり、start inputから変更できない。

`admitLaunch`は`launchId`、`runId`、`attemptId`、`profileId`、`origin`、`purpose`と、delegatedまたはreview用のopaque `originReceipt`だけを受ける。

standaloneは`agent`または`pr-creator`、delegatedは`agent`、reviewは`cross-review`のpurposeに限る。

receiptはprivate WeakMapにだけ結び付き、cloneやcaller-supplied bindingは拒否する。

同一attemptの完全一致再送は同じreceiptを返し、異なるprofileやorigin claimsを使う再送はconflictにする。

`start(admissionReceipt, { inputText })`は一attempt一度だけrunnerを起動し、異なるinput textによる再起動を拒否する。

input textはhashで重複判定し、composition snapshot、evidence、kernel claimsへ本文を保存しない。

`reconcileProof`と`resolveProof`はtrusted in-process向けであり、proof handleはcallerへ返す場合もopaque値として扱う。

`writerFor`は現在liveなproofとnative contextを確認してから既存registration writerを取得し、`authorizeWriter`は各writeの直前に現在のproofとcontextを再確認する。

`handoff`はprivate execution/current-owner/target-owner receiptとexpected owner generationを受け取り、immutable origin bindingを変えずcurrent ownerだけを切り替える。

同一handoff IDと同一内容の再送は保存済みreceiptを返し、異なる内容や古いgenerationはruntime authorityを呼ぶ前に拒否する。

target ownerのcurrent-owner chainがexecution自身へ到達するhandoff、既存cycle、上限超過はauthorityを呼ぶ前に拒否する。

`stop`はproofを先に失効し、子終了が確認されるまで`stopping`、確認できない場合は`stop_unconfirmed`を表示する。同じ停止処理の再呼出しは進行中のpromiseを共有する。

遅延した`exit`または`close`は、runner snapshotが該当イベントを確認した後のcomposition snapshotで`stopped`へ反映する。

## runner接続と認証

compositionは`owned-native-runner`をdefault runner factoryとして使い、provider、profile、executable、HOME、scope、cwdをallowlistから固定する。

Claudeには`getAuthentication`だけを渡し、Codexには`onAuthenticationRequired`だけを渡す。

Claudeのtokenはtrusted getterからrunnerへ渡し、Codexのlogin challengeは`loginId`とHTTPS `authUrl`を専用trusted presentation callbackだけへ渡す。

snapshotとnative eventには認証情報を出さず、Codex challenge callbackだけが`loginId`と`authUrl`をtrusted presentation先へ渡す。

login ID、URL、token、prompt、model outputはcomposition snapshotや一般HTTPへ出さない。

runnerへ渡す同期`isCurrent()` callbackは、launch epoch、process state、登録period、現在ownerのproofが有効な間だけtrueを返す。
同期`isSourceCurrent()` callbackは、binding後の自身のepoch、process、canonical期間、exact scopeと接続世代のowned sourceだけを検査する。
公開snapshotのscopeを照合した後、private opaque connection handleを`checkCurrentConnection`で同期再検査し、最後にepochとhandle同一性を再確認する。
literal true以外、例外、thenable、同期再入はfalseとして扱う。
初回binding前は両callbackとも従来のowner認可を要求する。
native書込み、認証、開始、待機中replyの受理は両callbackを独立に満たす必要がある。
固定wait profileへ渡す同期`isContextCurrent()`は引数を取らず、現在epochとcontext、および保持するopaque proofの全owner chain認可を検査する。
proof facadeの検査後にもepoch、context、opaque handleの同一性を確認し、同期再入、foreign handle、raw authorityのcontext終端ではfalseを返す。
wait callback通知前と返信直前にはowner、source、contextの三つのgateを独立にliteral trueで満たす必要がある。
v1 profileはcontext callbackを必須にせず、既存の開始と認証の契約を維持する。

native観測はsource callbackで受けるため、親contextがidleでも子のmatching context終端とfresh contextのattestationを保持できる。
親proofがない間は新proofとwriterを作らず、親復帰後にも子の明示reconcileを要求する。

runnerはchallenge提示直前と認証await後のnative request前にこのcallbackを同期評価し、literal `true`以外では継続しない。

親periodが認証待ち中に終了した場合、遅れてlogin completionが届いてもthread/start、turn/start、子execution registration、actor attestationを行わない。

runner側で既に送信したnative requestをcompositionが取り消すことはできないため、各送信の直前にfreshnessを確認する。

## native identityとcontext

Codex identityはnative `thread/start`結果のthread IDを使い、contextはnative `turn/start`結果のturn IDを使う。

Claude identityはnative `system/init.session_id`を使い、contextは同じsessionのtop-level assistant `message_start` IDを使う。

Claude nested tool responseはmain contextへ昇格しない。

runner callbackは厳密なschemaで検査し、provider、native ID kind、host、HOME scopeをprofileと照合する。

contextがidentityより先に届いた場合は本文を保持せずbounded queueへ置き、identityが登録された後に同じlaunch内で再検査する。

registrationには`resume:false`を渡し、Claudeの初回session aliasだけにnative session IDをprojection IDとして使う。

provider、native ID kind、host、HOME scope、native IDの完全tupleはbroker内で一launchにだけ割り当てる。

別launchが同じtupleを報告した場合、2つ目をquarantineしてrunnerを止め、既存periodへの再登録、actor追加、表示重複、writer認可を行わない。

同一launchからの同じidentity/contextの再通知は登録、attestation、reconciliationを繰り返さない。

context終端は現在のnative context IDに完全一致するときだけ`endContext`を呼び、当該contextのproofとwriterを不可逆に失効する。
main actor、canonical execution period、owned processは終了しない。
trusted native contextの新しい開始を観測した場合だけ、同じ不変execution bindingへattestし、明示的なruntime reconcileで新proofを発行する。
確定終了したcontextの再送、旧opaque proof、旧writer envelopeは認可へ戻さない。

main actorの生存は同じowned pipeからのtrusted native attestationで確認し、active期間やPIDだけから推定しない。
同じprocessのfresh contextを扱うfixture契約は、real runtimeの長寿命接続や複数turnの成功を保証しない。

identity、scope、contextの矛盾や認証状態の失効はconnectionをquarantineし、既発行proofを無効化する。

quarantine後の同connectionから届く遅延eventでactorやproofを再生成しない。

## owner、proof、writer

identity登録後はprovider registration adapterでconversation/executionを登録し、provider launch adapterでimmutable execution bindingを作り、runtime adapterへadoptしてconnectionを開く。

native contextのattestationにはbrokerが固定したexecution binding、context ID、private launch referenceだけを使う。

delegated launchは登録時にorigin receiptから固定したorigin bindingを維持し、現在のowner proofがliveである場合だけactor reconciliationを行う。

handoff後はcurrent owner receiptとowner generationを使い、終了したformer ownerのproofを現在ownerとして再利用しない。

異なるproviderのownerを使うhandoffは同じcomposition instanceに登録されたprivate receipt間で行う。

resume/proof contextに別slotのconnection handleが含まれる場合、numeric generationが一致してもauthorityを呼ばず拒否する。

writer envelopeはidentity、period、contextに固定し、contextが変われば旧envelopeを返さない。

registration kernelにwriter tokenを失効するAPIがないため、利用側はwriteごとに`authorizeWriter`を通す。

## snapshotとfailure

snapshotはlaunch/run/attempt ID、provider、canonical conversation/execution/session、native identity、context kind、owner generation、status、reason、process stateに限定する。

snapshotと`onNative` callbackには、prompt本文、model output、token、auth URL、login ID、filesystem path、connection handle、actor handle、proof handle、writer tokenを含めない。

runner constructionはspawnしない。

stop、親owner proof失効、provider mismatch、重複native identity、unexpected callback、native context矛盾でauthorityに進む前にfail-closedする。

unknown、quarantine、process failureはcanonical executionを暗黙に終了せず、新executionやresumeも作らない。

`snapshot()`はproofをlive checkし、proofが失効していれば最後のnative identity/stateを保持したままstatusをunknownへ落とす。

proofのlive checkはrecordから`currentOwnerRecord`をたどり、standalone self-ownerを終端として全nodeのperiod、actor、proofを確認する。欠落owner、cycle、上限超過はunknownとして扱う。

祖先ownerのproof失効は子のcomposition proof、writer取得・認可、新しいdelegated admissionへ伝播するが、葉のruntime kernel proof自体をこの走査だけで失効させない。

write先は各書込み直前に`authorizeWriter`を必ず通し、runtime kernelの葉proofが単体でliveに見えることを配信認可に使わない。

native context終端、stop、quarantine、disconnectを確定した時点で、そのrecordと現在のowner chainがそのrecordへ到達する子のcached proofとwriterを消す。
子のactor、期間、raw runtime kernel proofをこの走査だけで終了させない。
fresh親contextを再照合しても子の旧proofは復活せず、各子で`reconcileProof`を明示的に呼び、新しいopaque proofを得るまで配信を保留する。
handoffでその祖先から外れた現行chainは失効させない。
外部context guardのfalse、source guardのfalse、registryの一時的な読取不能だけで、recordやcached capabilityを破壊しない。
認可に影響するnativeイベントを観測していない間は、全owner chainのsourceを同期検査できるまでproofとwriterの利用を保留する。
同期payload gateは各nodeのconnection capabilityとepochの最終検査を含み、sink呼出しまでawaitを挟まない。
nativeイベントがない一時的な読取不能から復帰した場合は同じproofを再検査できるが、確定context終端とsource世代失効は旧proofを復活させない。

現在epochのowned callbackからcontext変更、context終端、identity矛盾を受けた時点でsourceを照合できない場合は、観測欠落をnative_observation_gapとして記録する。
この場合だけ自身と現owner chainの子のcached proofとwriterを消し、kernelのactor、context、期間に終端tombstoneを作らない。
当該context IDをbounded uncertainContextIdsへ保持し、同IDのreplayと単なるregistry復帰で旧認可を戻さない。
freshな別contextをtrusted sourceからattestし、runtimeで明示reconcileするまで認可を保留する。
子もそれぞれ明示reconcileを必要とする。
照合できなかったnativeイベントを後からauthorityへ再生しない。

owned runnerはsource照合不能時のpositive identity/contextを昇格させない。
同じ内部native identityとcurrent contextへ対応するterminal-onlyのnegative観測だけをcompositionへ渡し、compositionが観測欠落を記録する。
このcallbackだけでactorやcontextの終端権威を作らない。

`checkCurrentProof(launchRef, proofHandle)`はtrusted in-processの同期facadeである。
保持したopaque handleの同一性と`resolveProof`の全owner chainを同期再検査し、成功時だけ`{ok:true, reason:"accepted"}`を返す。
JSON複製、旧handle、chain欠落、cycle、再入、接続失効、期間終了ではokをfalseにする。
検査開始時にregistrationとlaunchのopaque authority revisionを捕捉する。
全chainの二回のmetadata、period、kernel proof、外部guardと比較を終えてから、両revisionが変わっていないことを同期検査する。
その後は外部registryを呼ばず、各nodeの`checkProofCapability`とcaptured private handle、epoch、context、immutable参照、owner世代の同一性だけを検査する。
最後のancestor callbackが既に検査済みの葉を失効させても、canonical revisionまたはprivate proof capabilityで拒否する。
revision照合不能だけではcached proofとwriterを破壊せず、操作を保留する。
返却後にawaitを挟む消費者は、sinkまたは返信の直前に再びfacadeを検査する。
送信開始を保存した後のpayload gateにはこのfacadeを渡し、raw runtime kernel registryを配信認可へ直接渡さない。
`createDurableDeliveryStore`にはget、snapshot、checkCurrentProofを持つ固定trusted facadeと同期resolverを渡す。

```javascript
const runtimeRegistry = Object.freeze({
  get: (ref) => runtimeKernel.registry.get(ref),
  snapshot: () => runtimeKernel.registry.snapshot(),
  checkCurrentProof: (ref, handle) => composition.checkCurrentProof(ref, handle),
});
const resolveProof = (ref) => composition.resolveProof(ref);
```

getとsnapshotは既存保存schemaの読取りを維持し、checkCurrentProofだけが全owner chainとopaque handleを配信直前に検査する。

祖先失効後のhandoff recoveryはこのcompositionの機能ではない。祖先が有効な間にfresh ownerへhandoffし、proofを再照合した場合だけ、その新current-owner chainを継承する。

## 検証境界

`node --test --test-isolation=none test/native-launch-composition.test.js`は両providerの実owned runner parserとfake stdio childを通し、provider option shape、native identity/context、Codex managed login待機、registration adapter、launch adapter、runtime adapterをfixtureで確認する。

同suiteのfixture handoff、cross-provider owner、duplicate tuple、foreign connection、失効ケースはkernel compositionとfail-closed制御を検証するもので、実native handoffの成功証拠ではない。

Claude standalone native identity、proof/writer、context終端後のproof失効とperiod維持、owned child closeは隔離runtime probeで確認済みである。

Codex managed loginは隔離app-serverで提示まで到達したが、5分の認証待ちで期限終了し、owned childのexit/closeを確認した。認証情報のファイル保存は検出されず、standalone bindingは未確認である。real delegated/handoff positive flowと同period reconnectも未確認とする。

Codex production authorizationが実際のmanaged browser loginと同じowned app-server connectionで成立すること、Claude OAuth getterの実環境接続、native tool/MCP writer correlationもこのfixtureだけでは実証しない。

### scenario

| scenario ID | 独立した期待 | 観測点 | 禁止する副作用 |
|---|---|---|---|
| ID-F03-N01 | contextがidentityより先に届いた場合、identity登録前のactor数は0であり、登録後のmatching contextだけがunique actorを作る。 | registration/runtime kernel snapshotとauthority counter | identity登録前のactor/proof 0回。 |
| ID-F03-N02 | 同一attempt・同一inputの再送は同じreceipt/startを共有し、異なるinputは拒否する。 | runner start counterとcomposition result | 重複spawn、prompt本文のsnapshot/evidence保存0回。 |
| ID-F03-N03 | 両providerの実runner adapterをfake owned pipeで通し、native ID/contextの許可schemaだけを登録する。 | runner method trace、registration/runtime snapshots | JSON-RPC未使用version fieldやnested model contentからIDを合成しない。 |
| ID-F03-N07 | 別launchが同じ完全native identity tupleを報告したら後続launchだけをquarantineする。 | active execution、proof check、adapter counters、writer authorization | 2つ目のregistration/bind/adopt/write 0回。 |
| ID-F03-N08 | Claude→CodexとCodex→Claudeのfixture owner handoffで、child executionとimmutable originを分離する。 | launch/runtime adapter snapshots、proof check | ownerをchild claimから生成せず、origin bindingを変更しない。 |
| ID-F04-N01-a | matching context終端はcontext認可を失効するがmain actorとcanonical periodはactiveのまま維持する。 | current-proof check、actor/context/execution snapshot | actor end、period end、新execution、旧proofの再活性化0回。 |
| ID-F04-N01-b | 子のcloseを観測できない停止は`stopping`を経て`stop_unconfirmed`になり、proofは即時失効する。 | composition snapshot、runner snapshot、共有stop promise | 未確認中の`stopped`表示、proof利用、period終端0回。 |
| ID-F04-N01-c | 遅れて`exit`または`close`を受信した後のsnapshotだけが停止確認を`stopped`へ戻す。 | runner flagsとcomposition snapshot | proof復活、period終端0回。 |
| ID-F04-N02 | 別connection handleを持つ#192 contextは、同じnumeric generationでも拒否する。 | reconcile result、runtime authority counter、既存proof check | authority mutationとproof置換0回。 |
| ID-F04-N03 | cross-provider handoffは同一内容だけ冪等であり、異内容・古いgeneration・target chain cycleを拒否する。 | origin/current owner binding、owner generation、proof check、handoff authority counter | staleまたはcycle handoff mutation、former owner再利用0回。 |
| ID-F04-N04-a | delegated parent periodがstart前またはCodex login待ち中に終わればchildをbindingせずnative startを送らない。 | runner factory、synchronous `isCurrent()`、fake stdio trace、kernel snapshots | thread/start、turn/start、registration、actor attestation各0回。 |
| ID-F04-N04-b | handoff後former ownerの終了は新owner proofを壊さず、current owner終了後はwriterを発行しない。 | proof check、writer result、bindWriter counter | current owner終了後のwriter mint/authorization 0回。 |
| ID-F04-N04-c | start中のCodex login challengeはstop後にtrusted presentation先へ渡らない。 | trusted challenge callback counterとcomposition snapshot | stop後challenge presentation 0回。 |
| ID-F04-N05-a | P→A→BでPのcontextが終端した後は、葉Bのkernel proof handleが残っていてもcomposition writerと新しいdelegated admissionを拒否する。 | current-owner chain、writer authorization counter、launch count | B起点のwriter認可、新launch、kernel proofの偽失効0回。 |
| ID-F04-N05-b | Pが有効な間にAをfresh QへhandoffしAのproofを再照合すれば、その後Pが終端してもAとBはQ経由でliveを保つ。 | origin/current owner binding、proof check、writer authorization | immutable origin変更、旧P proof再利用0回。 |
| ID-F04-N05-c | A→Bの後にB→Aをhandoffしてowner cycleを作る要求は拒否する。 | owner chainとhandoff authority counter | cycle edgeのauthority mutation、proof変更0回。 |
| ID-F04-N05-d | `isCurrent` callbackが同じrecordのproof resolutionへ同期再入した場合、外側のresolutionもfail-closedし、その後の通常resolutionは変わらない。 | nested result、同じproof handleの確認 | reentrant proof返却、authority mutation0回。 |
| ID-F04-N06 | Claude/Codex双方でcontext終端後もmain actorとperiodはactive。fresh native contextだけが同じbindingの新proofとwriterを作る。 | 両製品registration/launch/runtime adapter、actor/context state、private handle、writer認可。同期試験は1秒以内。 | actor/period end、重複registration、immutable変更、旧proof/旧writer/旧context replayの認可0回。 |
| ID-F04-N07 | P→A→BでPのcontext終端後はA/Bとも保留。fresh P後もA/Bのそれぞれの明示reconcileまで旧proofを拒否する。 | composition facade、実adapterのwriter認可回数、raw kernel葉proof、A記録。同期試験は1秒以内。 | 旧opaque handleの復活、旧writer認可、子期間終了、raw葉proofの偽失効0回。 |
| ID-F04-N08 | 両providerのstop、disconnect、quarantineは現chainの子のcached proof/writerを消し、子actorとperiodは終了しない。 | facade判定、reconcile結果、writer認可回数、execution snapshot。同期fixtureは1秒以内。 | 失効後のwriter認可、キャッシュ復活、子period終端0回。 |
| ID-F04-N09 | 両providerのstale connectionは捕捉済みproofによるpayload認可を拒否し、actorとcontextをunknownにする。 | 同期facade、writer認可回数、runtime snapshot。同期試験は1秒以内。 | raw kernelだけを使う配送認可、失効後のwriter認可0回。 |
| ID-F04-N10 | 両providerで親contextがidleでも子のtrusted native観測を保持する。子のfresh contextをattestするが親復帰と子の明示reconcileまではproof/writerなし。 | source/request callback、attestation回数、actor/context state、writer認可、固定binding。同期fixtureは1秒以内。 | 親idleだけによる子quarantine/stop、子period終端、未照合のproof/writer認可0回。 |
| ID-F04-N11 | 両providerでsource callbackの再入、snapshot後raw disconnect、throw、thenable、読取不能を拒否する。一時障害の復帰時は同じproofを再検査できる。 | 初回delegated binding、source callback、同期facade、private handle、attestationとwriter認可回数。各ケース1秒以内。 | 再入の認可、snapshotだけのsource昇格、障害中attestation、guardfalseだけによるstop/cache破壊0回。 |
| ID-F04-N12 | 両providerでsource照合不能中のnative context変更または終端を受けると観測欠落をfenceし、旧proofとwriterを拒否する。 | 実owned runner parserとfake pipe、composition gap理由、現chain、kernel actor/context、fresh contextと子の再照合。同期fixture1秒、owned pipe fixture5秒以内。 | registry復帰だけの旧認可、同context replay昇格、kernel tombstone、actor/period終端、子の自動復帰0回。 |
| ID-F04-N13 | 両providerのcontext callbackはraw authorityのown、owner、ancestor context終端、periodまたはsource失効を同期拒否する。Codex固定waitは同じ失効後に返信しない。 | opaque proof全chain、現在epoch/context、同期再入、実Codex runnerとfake pipeの返信数。callback fixture1秒、owned pipe fixture5秒以内。 | native終端未到着による旧context認可、foreign handle、失効後wait返信0回。正常系返信は1回。Claude waitはunsupportedであり成功扱いしない。 |
| ID-F04-N14 | 最後のancestor callbackによる葉のraw connection、context、period、actor、launch、handoff、latest proof失効を両providerで拒否する。 | canonical revision、全node private proof capability、opaque handle、callback後のprivate比較。同期fixture1秒以内。 | 失効proof返却、clone/stampのJSON復旧、revision拒否時のcache破壊0回。 |
| ID-F05-N01 | 両providerの実durable storeでsend-start保存中にown、owner、ancestor contextを終了する。 | `native-payload-gate-conformance.test.js`のfile checkpoint、同期facade、実delivery adapter、sink回数、復元状態。各ケース5秒以内。 | payload sink呼出し、raw葉proofからの認可、source/target変更、保存payload漏えい、自動再送0回。保存後はunknown、fresh runtimeでもunknownを保つ。 |

これらのscenarioはfixtureと製品adapterの契約を検証する。
ID-F05-N01は実file storeと製品delivery adapterを使うが、native transportへの配送はfixture sinkでありreal runtimeの配送成功には数えない。
real runtimeの複数context、生存観測、context後の再照合、delegated chainの復帰は未確認であり、#171-Bと#180-Aの実接続採用条件として残す。
## 確認した実接続の範囲

2026年10月7日、commit `6151af8f3b557db4c99e20a5a077e55927b0f3a2`のv1経路をClaude Code 2.1.291へ隔離HOMEから接続し、standaloneの一回のassistant contextを確認した。
context終端後はactor stateとcanonical期間がactiveのまま、contextStateがendedとなり、旧opaque proofとwriterの認可が拒否された。
owned stop後は実childのexitとcloseを確認し、通常HOMEのCodex/Claude認証ファイルは不変、隔離HOMEの認証関連ファイルの新規作成は0件だった。
canonical revisionsとcallbackなしの最終proof guardを含む同commitで、実Claudeのstandalone正常認可とcontext終端後の拒否を回帰確認した。
最後のancestor callbackからの失効注入はID-F04-N14とID-F05-N02のfixtureで検証しており、この実probeでは注入していない。
検証結果はexcludedな`.cross-review/native-live-binding-probe-results-claude-lifecycle-8fa31cf9-e215-4ede-a087-39e2ae17bc68.json`に保持する。
この結果は複数context、delegated、handoff、reconnect、Codex waitの実接続成功を示さない。

ID-F05-N02は両providerの実durable storeへ固定facadeを注入し、送信開始保存後の最後のancestor callbackによる葉のconnection、context、period、launch失効でsinkを0回に保つ。
状態はunknownとなり、自動再送しない。
これはfake native sourceを使う実adapter/store fixtureで、live runtimeの能力検証とは区別する。
