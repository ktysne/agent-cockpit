# Provider event projection

## 対象範囲

この文書は、#167-Aがprovider hook eventを認証済み実行期間の共通状態へ投影するときの試験契約を定める。
会話IDは登録kernelのconversationId、期間IDはregistrationのexecutionId、event用sessionIdは登録kernelが返すsessionIdを指す。
executionIdは実行期間であり、launch、run、actorの識別子として解釈しない。
投影処理はregistryの読取とauthorizeEventだけを使い、authority.endを呼ばない。
通常HOME、collector導入、画面とmock、全runtime接続は対象外である。

## 共通結果、仕様差、未確認

両providerで同じ結果を期待するのは、認証済み期間への相関、旧期間の隔離、actor単位の状態遷移、重複抑止、unknownの保持である。
Claudeはsessionをnative会話IDとして登録し、Codexはthreadをnative会話IDとして登録する。
provider名、native IDの形式、hook固有のevent名とpayloadは仕様差として許す。
出力文面、event到着順、runtimeごとの非決定IDは同等性の対象にしない。

ClaudeとCodex双方の実runtimeから、hook eventの一意ID、再送時の同一性、切断中の欠落範囲、Codex child hookの実bindingを観測できるかは未確認である。
fixture試験は製品adapter、registry、HTTP/state接続の挙動だけを証明し、実runtimeの能力を証明しない。
runtimeでevent IDまたは順序番号が得られない場合、時刻やpayload一致から重複を推測しない。

## 認証済みeventの入口

登録済みeventはwriter envelopeと登録時のprovider、native ID種別、host、HOME scope、native IDを照合する。
writerが表すexecutionIdとsessionIdをregistryのauthorizeEvent結果から取得し、受信eventの自己申告値で置き換えない。
旧executionIdのwriter、identity不一致、writer欠落、登録期間と相関しないeventは拒否する。
拒否ではHTTP応答または同期戻り値を観測し、state、PR、回答、refreshへの副作用を各0回にする。

既存HTTPのcanonical session_idとwriter形式を維持する。
登録済みhookの製品payloadはnativeEvent内のflat objectで受け、hook_event_name、hook_at、source、tool_name、tool_use_id、summary、agent_id、agent_type、route、description、questions、decisionResolution、pullRequest、codexOutputなどの共通項目だけをadapterが正規化する。外側session_idはcanonical sessionId、nativeEvent.session_idまたはCodexのthread_idはnative identityとして別々に扱う。外側と内側のhook_event_nameが異なるeventはunknownにする。
Codex child hookのnative session_idは親threadを表し、agent_idは子を表す。
nativeEventのsession_id、PID、cwd、時刻、継承Claude ID、外部verified値からactor bindingを認証しない。

## actor相関と観測品質

child actorへの投影は、server compositionからconstructorへ渡す任意のresolveActorCorrelation関数だけが認証できる。
この関数は信頼済みin-process capabilityであり、HTTPやevent JSONから作らない。
関数の入力にはprovider、registryから読んだ登録record、native eventを渡す。
成功値は `{ status: "verified", binding: { conversationId, executionId, sessionId, identity }, actor: { kind: "agent", id } }` とし、bindingはauthorizeEventと現在のregistry snapshotから得た親writerのcanonical tupleに完全一致させる。外部JSONのverified/evidence値はこの関数の代わりにならない。
未提供、proof欠落、actorの期間またはidentity不一致、関数例外はunknownにする。
#171-Aのread-only launch recordやcurrentProofがnullのrecordは相関証拠に使わない。
今回のchild fixtureは親writerとtrusted resolverを使い、同じ親conversation/period/sessionのactor rowだけを更新する。agent_idから子conversation、子execution、子writerを作らない。child writerのnative IDが子threadでraw session_idが親threadの場合は、この入口ではidentity mismatchとして拒否する。別writerで子periodを投影するnative経路は#166-B/#171-Bで確認する。親子actorの実native bindingとcurrentProofは後続#171-B/#170で確認する。

event欠落、collector切断、設定無効、tool結果欠落、PermissionRequest自体が未解決、重複検出用IDや順序番号の欠落は、理由付きunknownとしてprojection snapshotへ記録する。
unknown observationは既知の最終stateを保持し、終了、開始、成功、回答、PR更新へ読み替えない。認証済み通常eventは既存の#166互換経路で処理し、品質のunknownを併記する。
権威ある新規開始だけが新しいexecutionIdを作り、投影から新期間を発行しない。

## eventの意味と冪等性

Stopは対象actorのturn待機を表し、期間終端を表さない。
Interruptは対象actorのturn中断を表し、期間終端を表さない。
SubagentStopは相関が確認できた子actorだけを終了し、親、兄弟、会話期間を終了しない。
確認済みのactive child actorに対するPreToolUse、PostToolUse、PostToolUseFailure、UserPromptSubmitはturnをworkingへ戻すが、terminal actorを再開しない。
親actorのSessionEnd観測は対象executionの表示終端を表すが、registryのexecutionはactiveのまま残り、projectorはauthority.endを呼ばない。
親期間のSessionEndは、その期間に属する全agentへ適用する。authority.endは呼ばず、registry snapshot上の期間はactiveのままで、表示projectionはobserved endを別記する。authorityが別操作で期間を終了した場合、/api/stateはobserved periodと登録kernelのperiod stateを分け、canonical endedを反映する。
子actorのStop、Interrupt、SessionEnd、SubagentStopは子の観測に限り、親期間を終えない。
終了後の再開は、authorityが明示登録した別executionIdに限る。同じperiodでSubagentStopまたはactor SessionEndを観測したactorはterminalとして扱い、同一actor IDの遅延SubagentStartだけではactiveへ戻さない。

重複keyはprovider、executionId、providerが発行したnativeEventIdの組とし、IDが無い場合だけexecution内sequenceを代用する。sequenceはproducerがexecution全体で一意かつ単調増加を保証する場合に限り順序証拠として扱う。tool/actor単位のsequenceをexecution全体へ混ぜない。fixtureはこの能力を模擬するが、実runtime保証は未確認である。
同じkeyと同じ内容の再通知は、state、PR、回答、refreshを再適用しない。
同じkeyで内容が異なるeventはunknownにし、全mutationを0回にする。
event IDがない場合は重複検出品質をunknownとして記録し、正常な認証済みeventは既存互換どおり処理する。時刻またはpayload一致で重複扱いにしない。
tool_use_idなど別のnative IDはevent IDや重複keyとして使わない。PostToolUse/PostToolUseFailureのhook名が結果種別を保証する場合、全文outputの欠落だけではunknownにしない。tool_use_idが欠けて成否を開始eventへ結べない結果はunknownにし、state/PR/回答副作用へ進めない。PermissionRequestは解決結果の証明ではない。sequenceがない場合も順序品質をunknownとして記録し、到着順を全体の因果順序とみなさない。
writer、native identity、必要なactor相関を確認した後に意味上unknownとなるeventは、sequenceと重複keyの観測を記録する。PermissionRequestや結果相関不能のtool eventをunknownにしたまま後続sequenceを受理できるようにし、stateや業務副作用は適用しない。認証前に拒否した入力はsequence観測へ昇格しない。
sequenceのないeventで有限数値のhookAtが同じactorの最大観測値より小さい場合はevent_order_unverifiedとして記録し、状態と業務副作用を変更しない。これは巻き戻りを抑える局所ガードであり、時刻は認証、重複判定、順序証明には使わない。sequenceがあるeventは時刻が逆行してもsequence順で扱う。
登録writerでprojectionが適用したevent entryには、信頼済みserver経路だけが内部のpreserveProjectionOrder印を付ける。この印を含むsessionの再導出では、そのsessionの全entryを受信順sequenceで処理する。未登録legacy eventだけのsessionは従来どおりhookAt順とする。印はHTTP入力、event本体、snapshotへ公開しない。
最終活動時刻は同じsessionで処理済みのhookAtの最大値とし、受理順で古い子eventを処理しても巻き戻さない。新規sessionには終了済みsessionの時刻を引き継がない。
Codexのnative adapterはcodexReviewDefinitionとcodexWaitRunIdを通常のevent fieldへ引き継ぎ、既存のsanitizerに定義名とrun IDの値域検査を任せる。

## scenario

各試験は両providerの製品adapterへ同じ独立期待値を適用する。
同期投影APIの戻り値またはHTTP応答を1秒以内に観測し、HTTPの既存保存待ちは既存server契約の範囲で確認する。
provider固有ID、native event名、無害な到着順だけを正規化する。
identity tuple、conversationIdとexecutionIdの対応、actorの帰属、禁止副作用件数に許容差はない。

| scenario ID | 操作と能力条件 | 観測点 | 独立期待値と許容差 | 禁止副作用 |
|---|---|---|---|---|
| ID-F01-P01 | Claude/sessionとCodex/threadのactive registration fixtureから、一致するwriterで通常eventを送る。比較試行ではprovider、native kind、host、HOME scope、native ID、contextのいずれかを変える。 | authorizeEvent結果、同期戻り値またはHTTP応答、session snapshot、各副作用spy。 | 完全tupleとwriterが一致するときだけcanonical conversation、execution、sessionへ適用する。不一致とwriter欠落は拒否する。native IDの表現だけproviderごとの差を許す。 | 拒否eventのstate、PR、回答、refresh、period作成は各0回。 |
| ID-F01-P02 | 同じ会話を旧execution終了後に新executionへresumeし、旧writerの遅延eventを送る。旧writer eventと期間不明eventを両adapterで試す。 | HTTP応答、旧新session snapshot、event count、PR/回答/refresh spy。 | 旧execution eventと期間不明eventは拒否または保留し、現在期間へ割り当てない。 | 現期間変更、PR登録、回答、refresh、新execution発行は各0回。 |
| ID-F01-P03 | 同一periodのStop、Interrupt、SessionEndを個別に送る。native結果を欠くPostToolUseも含める。 | 状態遷移、execution snapshot、event observation status。 | Stopは待機、Interruptは中断、親actorのSessionEnd観測だけが表示上の期間終端となる。結果欠落はunknownで、成功結果を作らない。registry状態はactiveのままとし、表現差は許すが終端意味は一致させる。 | Stop/Interruptによる期間終了と、結果欠落からの成功、PR、回答は各0回。 |
| ID-F01-P04 | 親executionと子actorのfixtureを作り、信頼済みresolverの有無、resolver例外、actorの期間/identity不一致を試す。 | resolver呼出し、actor状態、親子期間snapshot、同期戻り値。 | 有効resolverだけが照合済みactorへ適用する。未提供、例外、不一致はunknownにし、既知の親子状態を維持する。 | unknown観測による親・子・兄弟の開始/終了、PR、回答、refreshは各0回。 |
| ID-F01-P05 | Codexのchild hookでnative session_idに親thread、agent_idに子IDを指定する。parent native IDの一致と不一致を試す。 | normalized actor、canonical session、HTTP応答、親子state。 | native session_idを子IDやcanonical session_idとして扱わない。actor resolverがない試行はunknownで親状態を変えない。 | 不一致観測によるactor認証、親期間終了、兄弟変更は各0回。 |
| ID-F01-P06 | 同じprovider/execution/nativeEventId/内容を再送し、次に同じIDで内容を変えて送る。最後にnativeEventIdとsequenceなしで、結果相関用tool_use_idがある通常eventを送る。 | 戻り値またはHTTP応答、state snapshot、PR/回答/refresh spy。 | 同一通知は一度だけ適用する。ID内容競合はunknownにする。ID欠落はdedup品質unknownとしてsnapshotに残し、認証済み通常event自体は処理する。時間や本文一致でdedupeしない。 | 再送による重複mutation、副作用、ID競合eventのmutationは各0回。 |
| ID-F01-P07 | SubagentStopを子、親、兄弟のそれぞれで送り、親SessionEndも送る。親子binding fixtureがない試行も含める。 | actorごとのactive state、execution state、event結果。 | SubagentStopは証明された子だけを終える。親SessionEndは同一期間の全agentを終える。child eventだけでは親期間を終えない。 | 未確認childからの親/兄弟終了と、親終端から漏れるagentは各0回。 |
| ID-F01-P08 | 重複ID付きPR create eventを再送する。AskUserQuestion回答の再送と配送台帳連携は#174/#175後続で未確認。 | state、PR登録、refresh、afterEvent呼出し数、同期戻り値。 | PR eventは最初の通知だけを適用し、同一IDの再送は副作用を繰り返さない。回答配送台帳の適用結果はこの試験で主張しない。 | 重複PR登録、refresh、二重afterEventは各0回。回答配送台帳は未確認。 |
| ID-F01-P09 | SessionEndを投影後にregistry snapshotを読み、同じproviderの未登録Claude旧alias/store fixtureを読み取る。 | projection結果、registry snapshot、既存Claude stateとsnapshot。 | 親actorのSessionEnd観測は対象期間の表示終端になるが、registry snapshotはexecutionをactiveとして返す。projectorはauthority.endを呼ばない。child SessionEndは期間終端にしない。旧Claude記録は既存aliasで読め、旧データやsession fileからwriter/verified期間を復元しない。 | projectionによる新execution発行、legacyデータの削除、旧aliasからのwriter発行は各0回。 |
| ID-F01-P10 | event欠落、collector切断、設定無効、未解決PermissionRequest、欠落tool結果をunknownとして注入する。 | observation status、state snapshot、registry snapshot、副作用spy。 | 全てunknownのままとし、既知の最終状態を変更しない。実runtimeの欠落検出能力はfixture合格に含めない。 | executionの終了/開始、成功・失敗確定、PR、回答、refreshは各0回。 |

## 検証層と完了記録

共通コア試験はprojectionの純粋な変換と重複・unknown規則を確認する。HTTP adapter試験はcreateProviderEventAdapter("claude", projection)とcreateProviderEventAdapter("codex", projection)を別々に通し、writer再認可後のapply gate、unknown/duplicateの副作用0、/api/state.providerEventsを確認する。
両adapter適合試験は製品のClaude adapterとCodex adapter、registration fixture、HTTPまたは共通state入口を通す。
fixture evidenceによる成功は認証済みruntimeやnative actor bindingの実証と区別する。
手動demoはdemo.hookがin-process fixtureとして登録executionにchild IDを束縛し、未束縛HTTP eventはunknown、各scenario eventはaccepted:trueを要求する。この経路はfixtureのみであり、製品runtimeのnative child correlation能力を示さない。
実runtime試験は本Issueで実施しない。
未実行、skip、環境未確認を成功へ数えない。

#170/#171-Bはnative event ID、切断中の欠落範囲、実child actor binding、currentProofを確認する。
#167-Bはdashboardとmockへ共通状態、unknown、期間終端を表示する。
#167-Aの局所試験合格だけでは#167全体を完了扱いにしない。
## 検証結果

共通コアはClaude/Codex各19件、計38件、HTTP適合は両providerの共通26件と互換・相関比較2件の計28件がpassし、skipはない。
最新featureのruntime-bindingコアを含む全体のnpm testは1,180件がpassし、failとskipは0件だった。
manual-demo局所試験も16件がpassし、failとskipは0件だった。
隔離デモはdemo.hookから発行したexecutionIdとagent_idをin-processで記録し、デモ専用resolverで照合する。
外部HTTPのagent_idだけではこのfixture recordを作らない。
デモの相関証拠は実runtimeのnative actor bindingやcurrentProofを証明しない。
