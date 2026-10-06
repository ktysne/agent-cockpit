# マネージドランタイムの観測

## 適用範囲

managed collectorは、信頼済みプロセス管理層が接続したprovider runtimeの通知を読み、登録済み実行の現在状態をbounded observationへ投影する。
観測は新しいconversation、execution、writerを登録しない。

collectorは起動時に自動接続しない。
`startServer({ managedCollectors })`へ渡すcollectorは、隔離したruntime compositionで明示的に作成する。
通常のClaude HOME、Codex HOME、既存MCP登録、外部hook設定は変更しない。

## 公開API

`createManagedCollector({ provider, scope, expectedHome, transportFactory, runtimeAdapter, runtimeRegistry, registrationRegistry, eventAdapter, trustedBindingResolver, onObservation })`は、`connect`、`observeKnownThread`、`resumeKnownThread`、`disconnect`、`snapshot`、`resolveProof`、`reconcileProof`を返す。
`scope`は`provider`、`nativeIdKind`、`hostId`、`homeScopeId`、`connectionSlotId`の完全な組として固定する。
Codexでは`expectedHome`を必須とし、initialize応答の`codexHome`を絶対pathとして比較する。

`transportFactory({ onNotification, onServerRequest, onDisconnect })`は、認証済みclientの`request`、`notify`、`close`を返す。
Codexのclientはさらに`confirmLoadedThread`、`resumeLoadedThread(threadId, isStillVerified)`を返す。
Codex adapterが同一接続上で`initialize`を一度だけ要求し、成功後に`initialized`を一度だけ通知する。
`connect`はCodex HOME照合後にだけ`runtimeAdapter.openConnection`を呼ぶ。

Claude adapterはCodex initializeを呼ばず、trusted transportから`onNotification('claude/hook', hookInput)`を受け取る。
Claude hook inputは生の`session_id`と`hook_event_name`を読み、PID、cwd、継承環境値、`agent_id`から子actorのbindingを補完しない。
Claudeのloaded list、read、resume、server request/resolutionは未対応として能力を`unsupported`と示す。
Claudeの`SessionStart`と`UserPromptSubmit`はactive、`Stop`はwaiting、`Interrupt`はinterruptedへ投影する。
`PermissionRequest`、未対応hook、子actor相関のないhookはunknown qualityを記録し、確認済みの最終activity/turn値を保持する。
`SessionEnd`は`period_end_observed`のunknownとして表示し、同じconversation/execution/sessionのローカルtombstoneを作る。
このtombstoneはcollector内でproof cacheと以後の同期間eventを拒否するが、registration authorityのendやstateのperiod終了は呼ばない。
新execution periodはnative session IDを再利用しても別のtombstone keyを持つ。

`observeKnownThread(nativeId)`は、provider固有の読取能力で登録済みnative identityを照合する。
Codexはloaded listで対象threadの存在を確認した後に`thread/read`を行い、read応答のthread IDと登録snapshotを照合する。
resumeはtransportの`resumeLoadedThread(nativeId, isStillVerified)`だけを使う。
transportはloaded確認をawaitした直後、送信前に同期guardを実行する。
guardが省略、例外、thenable、またはliteral `true`以外を返す場合は拒否し、wireへ`{ threadId }`だけを送る。
`thread/start`、登録authority、HOME設定の変更を呼ばない。

`reconcileProof(launchRef)`はtrusted composition向けの非同期methodで、trusted issuerからfreshなproofを照合してbooleanを返し、handleはcollector内へcacheする。
`resolveProof(launchRef)`はtrusted composition向けの同期methodで、cached proofをlive checkした後にopaque proof handleか`null`を返す。
proof handleはtrusted callerだけが受け取り、HTTP、`snapshot`、`onObservation`へ渡さない。
collectorはhandleをgenerationとともに内部Mapへ保持し、切断時に破棄する。

`snapshot()`と`onObservation`はallowlist済みのbounded値を返し、native本文、capability token、writer、actor handle、proof handleを含めない。

## 登録照合と証拠

collectorは`registrationRegistry.snapshot()`をread-onlyで読み、provider、nativeIdKind、hostId、homeScopeId、native ID、conversation、execution、sessionの完全一致を確認する。

Codex `thread/read`が返すthread IDだけではactor proofを作らない。

PID、cwd、親プロセス環境のClaude ID、wire上のverified/context/claimsはbinding証拠にしない。

collectorはCodexのWebSocket認証済みtransportとinitialize responseのHOMEを検査するが、接続認証をruntime binding核へ委譲しない。

runtime binding核が検査するのはscope、identity、active period、handle間の整合であり、native証拠の真偽は検査しない。

`trustedBindingResolver`だけがtrusted in-process compositionからnative actor proofを発行できる。

resolverにはcollectorの現connection handleを渡し、その世代にattest/reconcileしたopaque proof handleだけを受け取る。

collectorは`runtimeRegistry.snapshot()`からlaunchを読み、`runtimeAdapter.get(launchRef)`のcurrent proofがregistryのidentityとactive execution periodに一致し、`executionConnectionGeneration`が現在の接続世代と一致することも確認する。

owner actorは別providerのscopeに属する場合があるため、owner connection generationをcollector scopeの世代と比較しない。

resolverが無い、証拠が不足する、例外になる、registry snapshotと一致しない場合はunknown observationを返す。

`trustedBindingResolver.resolveEventWriter`は既存の登録writerだけを返せる。

writerが得られた場合も、collectorはnative hookを既存hook名へ偽装せず、未対応eventを`eventAdapter.project`へ渡す。

この経路は`unsupported_event`のunknown観測だけを許し、writer mintや意味確定eventの適用は0回にする。

Codex app-serverのnative thread/actorと登録済みlaunchの結び付けを示すrunner側の証拠接点は未確認であり、production resolverはunverifiedのままとする。

## 状態と切断

notification、server request、server request resolutionは、本文を保持せず、activity、turn status、thread status、pending request IDへ写す。
Codexの`turn/completed`はstatusが不明ならunknownとし、確認済みactive turn IDと合わない終端通知で現在のturnを終端化しない。
unknown qualityは最終既知stateと分離し、PermissionRequestなど意味が未解決の通知でactivity/turn stateを巻き戻さない。

公開statusは`active`、`waiting`、`interrupted`、`completed`、`unknown`に限る。
同じ接続内の同じpending request IDは一件だけ記録する。
`serverRequest/resolved`はCodexの現接続・現executionに一致するrequest IDだけを解決する。
Claudeはnative RPC request/resolutionを提供しないため、`PermissionRequest` hookからpending解決を推測しない。
request recordはcanonical execution IDで区別し、同じnative IDで新executionが始まっても旧periodのpendingや遅延resolutionを引き継がない。

切断時はepochを最初に失効し、その後`runtimeAdapter.disconnect`を呼び、transportをcloseする。
await中の処理はepochを再確認し、切断後に戻った応答や通知からstate、event、proofを更新しない。
切断時にpending requestはunknownとして残す。
再接続は新しいconnection IDとgenerationを使い、resolverがbindingを再確認するまでunknownを維持する。
snapshotの復元はproof、pending requestの解決、execution再登録に使わない。

`observationId`はcollector内の記録識別子であり、native event ID、native sequence、dedup keyではない。

## scenario

| scenario ID | 操作と能力条件 | 期待結果 | 禁止する副作用 |
|---|---|---|---|
| ID-F03-P01 | Codexのinitializeを一接続で行い、transportとexpectedHomeの信頼済みscopeを照合する。 | initializeは一回。scopeとHOMEが一致した後にだけinitializedを一度通知する。不一致はunknown/拒否とし、versionとエラー分類だけを残す。 | 不一致時の接続証拠発行、registry登録、period作成は各0回。一致時は接続証拠を一度だけ発行する。 |
| ID-F03-P02 | loaded listで確認済みの登録済みthreadをreadし、read.thread.idと完全なregistry identityを照合する。 | 一致したcanonical conversation/execution/sessionだけをobservationへ示す。不一致またはread欠落はunknown。 | registry register、authority end、新period作成は各0回。 |
| ID-F03-P03 | loaded listにあるthreadだけを専用resumeで再開する。 | resume paramsは`{ threadId }`のみ。未loaded threadはresumeしない。 | thread/start、設定override、new periodは各0回。 |
| ID-F03-P04 | trusted resolver無し、wire上の偽造claims、stale proof、resolver例外を試す。 | unknown observationとし、eventAdapterの意味確定applyは0回。public snapshotからproof等を取得できない。 | writer取得、actor認証、event apply、period mutationは各0回。 |
| ID-F03-P05 | Claude adapterをCodex JSON-RPC clientなしで接続し、native capabilityを読む。 | Codex initializeは0回。loaded/read/resume/server request capabilityはunsupportedを示し、hook inputのstatus変換とcommon disconnect/unknown/proof check経路は動く。 | Codex method送信、架空のRPC request/resolution、period mutationは各0回。 |
| ID-F03-P06 | Claude `SessionEnd`を現在の登録periodで観測し、同native session IDの新しいexecutionを登録する。 | SessionEndはunknown qualityと期間別local tombstoneになり、同期間のproof再照合を拒否する。新executionは別periodとして扱う。 | registration authority.end、既存periodの終了、同期間proof復活は各0回。 |
| ID-F04-P01 | Codex native app-serverの同一connectionでserver requestを重複通知し、request ID一致のresolutionを送る。 | Codexのpending IDは一件だけ。native resolutionだけpendingを解決し、本文はsnapshotへ出さない。Claude `PermissionRequest` hookは結果を推測しない。 | Claudeに不存在のRPC request/resolutionを作ること、同IDの二重配信、任意resolutionによる解決は各0回。 |
| ID-F04-P02 | read等のawait中に切断し、遅延response/notificationを返す。 | epochを先に失効し、runtime disconnectの後にtransportをcloseする。古いepochのmutationは0回。pendingはunknownで残る。 | stale event apply、old proof有効化、pending request確定解決は各0回。 |
| ID-F04-P03 | 切断後に同一registered executionへ再接続し、resolverを再実行する。 | connection generationを増やす。新proofがlive確認されるまでunknown。execution数は変えない。 | snapshotからのproof復活、旧応答受理、新period作成は各0回。 |
| ID-F04-P04 | active turn後に欠落statusのCodex `turn/completed`、または現在と異なるturn IDの終端通知を送る。 | statusはunknown qualityとなり、最後に確認したactive turn stateは維持する。 | 別turnの終端化とperiod mutationは各0回。 |
| ID-F04-P05 | Codex pending request後に同じnative IDで新executionを開始し、旧request resolutionを送る。 | 新executionに旧pendingを引き継がず、旧resolutionを拒否する。 | 新period request rowへの付け替え、resolutionによる新period state更新は各0回。 |
| ID-F04-P06 | Claudeでactive状態を確認した後、turn IDを持たない`Interrupt` hookを受け取る。 | explicit hookに基づいてstatus、activity、turnStateをinterruptedへ更新する。 | Codexのturn identity guardをClaudeへ適用すること、period mutationは各0回。 |
| ID-F04-P07 | 登録済みperiodの`thread/read`待機中に同じnative IDを新しいexecutionへ切り替え、旧readを返す。 | 旧readとそのissuer結果を拒否し、新periodのobservationを保持する。 | 旧period結果によるobservation更新、callback通知、proof設定は各0回。 |
| ID-F04-P08 | 同じperiodのread待機中に、より新しいnative notificationを適用してから旧readを返す。 | 旧readを`observation_superseded`として拒否し、新しいactivity/turnを保持する。 | 古いreadによるstate巻き戻しとcallback通知は各0回。 |
| ID-F04-P09 | 既知observationのsnapshot生成前にactive periodまたはlive proofを失効させる。 | snapshotだけをunknown qualityへ下げ、最後に確認したactivity/turn値を保持する。 | onObservation通知、observation revision更新、period mutationは各0回。 |
| ID-F04-P10 | Codexのloaded確認をawaitした後、resume直前にproof guardが省略、false、例外、またはthenableを返す。 | resumeを拒否し、確認済みthreadだけを扱う。 | `thread/resume`送信、権限や設定の上書き、period mutationは各0回。 |
| ID-F04-P11 | connectionまたはremote CLI preflightのawait中にprocess managerをstopする。 | operation generationを失効させ、遅れて返ったtransportを登録せずcloseする。未spawnのCLIは起動せず、既にspawn済みのowned childは停止する。 | stop後の接続採用、所有外processの停止、未管理childの残存は各0回。 |

## 検証と採用境界

fixtureは両provider adapterとtransport callbackを通してscenarioを確認する。

fixtureのtrusted resolverはissuer境界とlive proof checkを確かめるものであり、実runtimeのnative binding証拠を実証しない。

core/conformance testsは16/16、transport/process testsは14/14、HTTP snapshot testsは4/4で成功した。

修正後の最初の統合実行では1,213件が成功し、既存で変更していない`poc/codex-pr-review-notifications/existing-probe.test.js`のファイル失敗が1件あったが、詳細な原因は出力されなかった。
同ファイルの単独再実行は1/1で成功し、その後に単独実行した`npm test`は1,214件成功、失敗・キャンセル・スキップ・TODOは0件だった。
このファイル失敗の根因は未確認であり、probeとの干渉も確認していない。

Codex app-serverの公式protocolは[Codex repository](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol)を参照する。

隔離probeは専用HOME・接続先・資格情報で実行し、通常HOMEと外部repoを変更しない。

通常HOMEや外部repoの変更は、対象差分と復旧手順を示して個別確認を得る。

Codex runtime 0.160.1の隔離probeでは、認証、HOME照合、loaded listの空応答、誤token拒否、単一close、所有process停止を確認した。

初期path guardの拒否は通常HOMEの祖先まで対象にした過剰判定と特定し、隔離HOMEの境界検査へ修正した。

初期接続開始の失敗は根因未特定のためbounded retryを追加し、最終probeでは上記条件を通過した。

lifecycle修正後にCodex runtime 0.160.1の薄い隔離probeを再実行し、再度成功した。
probeは通常HOME、外部repo、secret fileを変更せず、モデルturnは0回だった。
native actor bindingとremote CLIの実turnは未確認であり、production adoptionの根拠にしない。

実runtimeのrunner binding、HOME導入、native actor/currentProof連携は#170/#171-B/#180-Aで確認する。
