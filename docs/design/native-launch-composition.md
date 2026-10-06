# Native launch composition

## 適用範囲

native launch compositionは、信頼済みのin-process呼出しからowned runnerを起動し、そのrunnerが同じ専用pipeで報告したnative identityとcontextを登録済みexecutionへ結び付ける。

compositionはHTTP、MCP、外部JSONからlaunch receipt、actor proof、writerを作らない。

compositionが発行するactorはbroker内のexecution actor keyであり、providerがnative actor IDを発行したことを意味しない。

runnerの実native protocol接続とreal runtimeでの証拠は、fake stdio fixtureの成功からは推定しない。

## 公開API

`createNativeLaunchComposition({ registrationKernel, launchKernel, runtimeKernel, runnerFactory, getAuthentication, onAuthenticationRequired, hostId, profiles })`は、`admitLaunch`、`start`、`stop`、`handoff`、`reconcileProof`、`resolveProof`、`writerFor`、`authorizeWriter`、`snapshot`を返す。

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

`stop`はproofを先に失効し、子終了が確認されるまで`stopping`、確認できない場合は`stop_unconfirmed`を表示する。同じ停止処理の再呼出しは進行中のpromiseを共有する。

## runner接続と認証

compositionは`owned-native-runner`をdefault runner factoryとして使い、provider、profile、executable、HOME、scope、cwdをallowlistから固定する。

Claudeには`getAuthentication`だけを渡し、Codexには`onAuthenticationRequired`だけを渡す。

Claudeのtokenはtrusted getterからrunnerへ渡し、Codexのlogin challengeは`loginId`とHTTPS `authUrl`を専用trusted presentation callbackだけへ渡す。

snapshotとnative eventには認証情報を出さず、Codex challenge callbackだけが`loginId`と`authUrl`をtrusted presentation先へ渡す。

login ID、URL、token、prompt、model outputはcomposition snapshotや一般HTTPへ出さない。

runnerへ渡す同期`isCurrent()` callbackは、launch epoch、process state、登録period、現在ownerのproofが有効な間だけtrueを返す。

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

context終端は現在のnative context IDに完全一致するときだけactor proofとwriterを失効し、canonical execution periodとowned processは終了しない。

このprofileは一turnで終了するowned attemptを保守的に扱う。

一般の長寿命main sessionやturn間でのwriter再活性化を保証しない。

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

## 検証境界

`node --test --test-isolation=none test/native-launch-composition.test.js`は両providerの実owned runner parserとfake stdio childを通し、provider option shape、native identity/context、Codex managed login待機、registration adapter、launch adapter、runtime adapterをfixtureで確認する。

同suiteのfixture handoff、cross-provider owner、duplicate tuple、foreign connection、失効ケースはkernel compositionとfail-closed制御を検証するもので、実native handoffの成功証拠ではない。

real standalone native execution、real native identityのbroker binding、real context terminal/disconnect invalidation、delegated/handoff positive flow、同period reconnectは独立したnative runtime probeで確認されるまで未確認とする。

Codex production authorizationが実際のmanaged browser loginと同じowned app-server connectionで成立すること、Claude OAuth getterの実環境接続、native tool/MCP writer correlationもこのfixtureだけでは実証しない。

### scenario

| scenario ID | 独立した期待 | 観測点 | 禁止する副作用 |
|---|---|---|---|
| ID-F03-N01 | contextがidentityより先に届いた場合、identity登録前のactor数は0であり、登録後のmatching contextだけがunique actorを作る。 | registration/runtime kernel snapshotとauthority counter | identity登録前のactor/proof 0回。 |
| ID-F03-N02 | 同一attempt・同一inputの再送は同じreceipt/startを共有し、異なるinputは拒否する。 | runner start counterとcomposition result | 重複spawn、prompt本文のsnapshot/evidence保存0回。 |
| ID-F03-N03 | 両providerの実runner adapterをfake owned pipeで通し、native ID/contextの許可schemaだけを登録する。 | runner method trace、registration/runtime snapshots | JSON-RPC未使用version fieldやnested model contentからIDを合成しない。 |
| ID-F03-N07 | 別launchが同じ完全native identity tupleを報告したら後続launchだけをquarantineする。 | active execution、proof check、adapter counters、writer authorization | 2つ目のregistration/bind/adopt/write 0回。 |
| ID-F03-N08 | Claude→CodexとCodex→Claudeのfixture owner handoffで、child executionとimmutable originを分離する。 | launch/runtime adapter snapshots、proof check | ownerをchild claimから生成せず、origin bindingを変更しない。 |
| ID-F04-N01-a | matching context終端はactor proofを失効するがcanonical periodはactiveのまま維持する。 | current-proof check、actor/execution snapshot | period end、新execution、再活性化0回。 |
| ID-F04-N01-b | 子のcloseを観測できない停止は`stopping`を経て`stop_unconfirmed`になり、proofは即時失効する。 | composition snapshot、runner snapshot、共有stop promise | 未確認中の`stopped`表示、proof利用、period終端0回。 |
| ID-F04-N02 | 別connection handleを持つ#192 contextは、同じnumeric generationでも拒否する。 | reconcile result、runtime authority counter、既存proof check | authority mutationとproof置換0回。 |
| ID-F04-N03 | cross-provider handoffは同一内容だけ冪等であり、異内容・古いgenerationを拒否する。 | origin/current owner binding、owner generation、proof check | stale handoff mutation、former owner再利用0回。 |
| ID-F04-N04-a | delegated parent periodがstart前またはCodex login待ち中に終わればchildをbindingせずnative startを送らない。 | runner factory、synchronous `isCurrent()`、fake stdio trace、kernel snapshots | thread/start、turn/start、registration、actor attestation各0回。 |
| ID-F04-N04-b | handoff後former ownerの終了は新owner proofを壊さず、current owner終了後はwriterを発行しない。 | proof check、writer result、bindWriter counter | current owner終了後のwriter mint/authorization 0回。 |
| ID-F04-N04-c | start中のCodex login challengeはstop後にtrusted presentation先へ渡らない。 | trusted challenge callback counterとcomposition snapshot | stop後challenge presentation 0回。 |

このfixtureはkernel、provider adapter、owned pipe parserの接続を検証するもので、real native runtimeの成功証拠としては数えない。
