# 正規会話の登録核と適合試験

この文書はIssue #166-Aの登録契約と、実装前に定めた期待値を記載する。
実runtimeと外部issuerの認証は後続で検証する。
この段階は会話識別と書込み境界の基盤を提供し、全機能の表示結合は#167に残す。
scenario ID `ID-F01`と`ID-F02`は本実装計画から引き継ぎ、`-Axx`を#166-A内の枝番として使う。

## 根拠と適用範囲

期待値は固定版の[本実装計画](https://github.com/ktysne/agent-cockpit/blob/64a5d0a4ca4f9c9ef6d2b526d8bcd3d764c901d2/docs/design/codex-implementation-plan.md)、[共有契約](https://github.com/ktysne/agent-cockpit/blob/a2da27f1f51e932a0184cea72da38fc89b1c5c5f/docs/design/codex-shared-contract.md)、[適合試験方針](https://github.com/ktysne/agent-cockpit/blob/f4460762641d9eef6c0eb0c2c9c55df4f625532e/docs/design/provider-conformance-testing.md)から定める。
登録主体と後続interfaceはこの文書の「観測主体と登録interface」に定める。

MCPは登録されたwriterと、呼出しのnative metadataを照合してから`/api/sessions/pending/plan`または`/prs`へ書き込む。
サーバーはsecretとOriginの検査後にwriterを登録核へ照合し、projection用のsessionIdを内部で解決する。
secret、MCP引数、PID、cwd、時刻、環境変数の値だけではprovider、会話、実行期間への認証済みbindingを証明しない。

#166-Aでは正規会話のidentity tuple、会話内の実行期間、観測と認証済み登録の分離、既存Claude表示データの読取互換、未確認または不一致のMCP書き込み拒否を対象にする。
#166-Bのdelegated MCP起動登録は#171の認証済みbindingとの結合後に行う。

## 判定と計測の共通規則

| 区分 | 判定規則 |
|---|---|
| 共通結果 | 同じシナリオをClaude adapterとCodex adapterへ適用し、会話同一性、期間境界、権限判定、副作用件数の意味が一致する。 |
| 仕様差 | native IDの形式、イベント名、証拠の取得方法、表示aliasなどprovider固有の表現だけを許す。共通のbinding判定や拒否結果は変えない。 |
| 未確認 | adapter、証拠issuer、HOME scopeの由来、実runtime能力がないか確認できない。unknownを成功または同等と数えない。 |

コアとadapterの同期処理は戻り値までを観測期限とし、1秒のwatchdogは停止検出だけに使う。
watchdogは製品の応答時間契約ではない。
MCP往復を含むケースは現行`MCP_TIMEOUT_MS`の5秒以内に応答させ、期限切れを成功に含めない。
時計は固定し、時刻の近さで会話や期間を結び付けない。
ランダムな内部IDだけを比較用mapへ正規化し、identity tuple、期間の対応、副作用件数は正規化しない。

| シナリオID | 機能とIssue | 区分 | 能力条件 | 操作 | 観測点と期限 | 共通期待値 | 許容差 | 禁止副作用 |
|---|---|---|---|---|---|---|---|---|
| ID-F01-A01 | 正規会話のprovider、native ID種別、host、HOME scope、native ID照合。#166-A | 共通結果。native ID表現のみ仕様差。 | 各adapterが認証済みregistrar由来のscopeとnative IDを受け取れる。対応組は`claude/session`と`codex/thread`。 | 同じ完全tupleを二度登録し、次にprovider、native ID種別、host、HOME scope、native IDの各一要素だけを変えて登録する。未対応組と欠落fieldも入力する。 | 各登録の戻り値とcanonical registryを同期処理の戻り時に観測する。watchdogは1秒。 | 完全tupleの再登録は同じconversationIdへ解決する。対応するprovider-kindの組とscopeの値を変えた有効tupleは別conversationIdになる。欠落値や未対応provider-kindはverified conversationを作らず`unverified`またはrejectになる。 | IDの実値とprovider固有のnative文字列だけを比較用mapへ置換する。tupleの要素を省略または推定する差は許さない。 | 不正tupleからのconversation、execution、writer handle発行は各0回。異なるtupleの統合は0回。 |
| ID-F01-A02 | 再登録、observer resume、新しい実行期間。#166-A | 共通結果。resume開始証拠の形だけ仕様差。 | adapterが同一開始証拠の再送と、新しい認証済み開始証拠を区別できる。 | 同一tupleで同じstart evidenceを再送し、observer resumeとcollector再接続を行う。その後、旧期間を終了し、新しい認証済みstart evidenceでresumeする。 | conversationId、periodId相当の実行ID、開始証拠との対応、active状態を各操作直後に観測する。同期処理watchdogは1秒。 | 同じstart evidenceの再送は同じ期間へ冪等に解決する。observer resume、既存thread参加、再接続だけでは新期間を発行しない。終了後の認証済み新開始は同じ会話に新しい期間を発行し、旧期間を復活させない。 | 内部IDの実値は正規化する。開始証拠の種類はproviderごとに異なってよいが、証拠の認証結果は一致させる。 | 同じ証拠から別期間を作ること、旧期間の再開、証拠のない期間発行は各0回。 |
| ID-F01-A03 | 旧期間の遅延event隔離。#166-A | 共通結果。event名と配送元の形式だけ仕様差。 | eventに対象periodIdまたは同等の認証済み期間参照を付け、両期間の状態を個別に観測できる。 | 同一conversationの旧期間を終了し、新期間を開始する。旧periodId付きeventを後着させ、次に期間参照のない曖昧なeventを送る。 | event受理結果、旧期間と新期間のstate、各event数、PR登録、回答配送呼出しを処理直後に観測する。同期処理watchdogは1秒。 | 旧期間を証明するeventは旧期間だけに記録できる。期間不明eventは`unverified`またはrejectとして保留し、到着時点のactive期間へ割り当てない。 | event固有時刻と無害な到着順は比較対象外。期間宛先とstate変化は完全一致させる。 | 旧eventによる新期間state変更、PR登録、回答配送、writer認可は各0回。曖昧eventによる全state mutationも0回。 |
| ID-F02-A01 | 観測登録とverified昇格の権限。#166-A、#170、#171 | 共通結果。proof issuerの具体方式は未確認。 | daemon組立コードがin-process registrar/verifier capabilityを信頼済みコードだけへ渡し、adapterが観測入力と検証済み証拠の経路を分ける。 | collectorまたはhookの未検証観測に`verified: true`、同じPID、cwd、近接時刻、またはMCP secretを付ける。別試行で有効なtest verifier証拠を渡し、bindingを1要素変えた証拠も渡す。 | observation status、registrar/verifier呼出し、execution、writer handle、stateとログを各応答直後に観測する。同期処理watchdogは1秒。 | 観測は`unverified`のまま保持できるがwriter権限を得ない。外部verified boolean、PID、cwd、時刻、secret/Originは昇格根拠にならない。検証済み証拠はそのidentityとbindingが一致する場合だけ昇格し、不一致は拒否する。 | test verifierのproof形式だけprovider別にしてよい。発行主体と判定結果は共通規則に従う。 | 不正入力によるverified化、period作成、writer handle、MCP mutation、secretやcapabilityの保存・ログ出力は各0回。 |
| ID-F02-A02 | 登録再送と実宛先の重複防止。#166-A、#171 | 共通結果。actor IDの形式だけ仕様差。 | test verifierが同一executionBindingに対応する証拠を発行し、登録核が実宛先を比較できる。 | 同じstart evidenceを再送し、次に同一executionBindingを異なるlaunch/runとして重ねて登録する。第三にbindingのactorまたはperiodを差し替えたproofを送る。 | conversation、period/execution対応、executionBindingの一意性、拒否結果を各応答直後に観測する。同期処理watchdogは1秒。 | 同じ証拠の再送は冪等。すでに登録済みの同一実宛先を別executionとして重複登録せず、binding不一致proofを拒否する。 | 一意なIDの実値だけを正規化する。同じ宛先判定と登録件数に許容差はない。 | 重複execution、宛先すり替え、既存bindingの上書きは各0回。 |
| ID-F02-A03 | Codexへ継承されたClaude IDの拒否。#166-A | 共通結果。provider固有のenvironment keyは仕様差。 | Codex adapterが実thread identityとClaude環境変数を別々に観測できる。 | Codex起動環境へ既知の`CLAUDE_CODE_SESSION_ID`を継承させ、Codexのthread IDを有効証拠または未検証観測として与える。 | 正規tuple、Claude alias、parent/origin binding、writer handleを応答直後に観測する。同期処理watchdogは1秒。 | 有効なCodex証拠は`codex/thread`のtupleだけへ登録する。継承Claude IDだけではClaude会話への関連付け、Codexのperiod認証、親bindingを作らない。Codex証拠がなければunverifiedに留める。 | Codex thread IDの文字形式と環境変数の有無はprovider仕様差として許す。Claude会話へのbinding結果は許容しない。 | Claude会話への書込み、Claude executionへの紐付け、継承ID由来のwriter認可は各0回。 |
| ID-F02-A04 | 未確認または不一致MCP書込みの拒否。#166-A。delegated登録全体は#166-B/#171。 | 共通結果。protocol errorの表示文だけ仕様差。 | MCP要求を既存server入口から送り、in-process writer verifier結果と各store/side-effect spyを観測できる。 | 未知native ID、異なるprovider、native kind、host、HOME scope、context、execution、token、終了済みperiod、旧periodを指定し、plan、decision、PR、skip-reviewを書き込む。旧MCP形式の`session_id`、`ppid`、`claudeCodeSessionId`だけを揃えた要求も送る。対照として全claimが現在のruntime bindingと一致する有効opaque writer tokenでClaude書込みを行う。 | MCP応答とstore、event、PR tracker、回答配送の呼出し数を要求ごとに確認する。現行timeoutは5秒。 | provider、native kind/id、host、HOME scope、context、execution、opaque tokenを現行runtime bindingと照合する。claimの欠落または不一致、旧MCP形式のみの要求は`unverified`またはerrorで拒否し、成功応答を返さない。一致する有効writerだけが対象Claude aliasへ一度書き込める。 | MCP error textや内部status codeは契約しない。成功/拒否と対象、副作用数は完全一致させる。 | 拒否ケースのplan、decision、PR、event、回答配送、外部API呼出しは各0回。既知session ID、PID、Claude ID、MCP引数からのwriter発行も0回。 |
| ID-F02-A05 | Claude旧データの表示互換とwriter権限の分離。#166-A、#177-A | 表示互換は共通期待値。旧Claude alias表現は仕様差。 | 旧store fixtureを読み、snapshot表示と新規writer認可を別々に観測できる。 | `session_id`で保存された既存Claude plan、decision、PR、eventをseedし、load、snapshot、serialize、reloadする。追加でsession file由来の稼働観測を置き、再起動後に同じMCP書込みを試す。 | 表示上の記録と内容、会話alias、writer handle、period、store diffをreload後に比較する。同期処理watchdogは1秒、MCPは5秒。 | 保存済み記録はClaude aliasの読取表示で欠落または重複しない。旧storeやsession fileから稼働中period、verified登録、writer権限を復元しない。新規書込みは再起動後の再認証済みbindingが一致するときだけ許可する。 | 永続schema内部の配置やalias名称は、公開表示と正規会話対応を保つ限り変更できる。認証権限を旧データから復元する差は許さない。 | 読取互換のための旧記録削除、別providerへの表示統合、再起動時のwriter handle復活、未認証MCP mutationは各0回。 |

## 観測主体と登録interface

| 主体 | 許す操作 | 許さない操作 |
|---|---|---|
| collectorまたはhookの観測入口 | evidence metadata付き候補を`unverified`として登録する。 | verified会話、期間、writer handleを自己発行する。 |
| 信頼済みdaemon code | in-process registrar/verifier capabilityを使い、証拠を検証して会話と期間を登録する。 | capabilityを外部JSON、store、ログへ出す。 |
| binding verifier | runtime native binding、scope/context、executionの全claimが一致した場合だけopaque writer tokenを発行または照合する。 | 外部`verified` booleanや別conversation/periodの書込みを認可する。 |
| MCP caller | 発行済みopaque tokenと要求claimが照合した対象へ既存のMCP書込みを行う。 | ID、PID、Claude IDだけで会話登録、期間開始、認証昇格を要求する。 |
| 旧storeとsession file | Claude aliasの既存データを読取表示する。 | 稼働証拠または書込み権限を復元する。 |

`createRegistrationKernel()`は`registry`と`authority`を返す。
authorityを保持する同一プロセス内の信頼済み組立コードだけが登録、binding、期間終了を行える。
registryには観測と照合だけを公開し、HTTPからauthorityを取得する口を作らない。
authorityは外部collectorやrunnerの認証を代替しない。
外部の証拠を検証してからauthorityへ渡すissuerは#170と#171で実装する。

| API | 責務 |
|---|---|
| `registry.observe(identity, metadata)` | 未検証観測を保持する。期間やwriterを発行しない |
| `authority.register(identity, evidence, {startId, resume})` | 認証済み開始を登録し、conversationId、executionId、sessionIdを返す。同じ開始証拠は冪等 |
| `authority.bindWriter(executionId, {identity, contextId, evidence})` | 実行自身のbindingを照合し、tokenを含むwriter envelopeを発行する |
| `registry.authorizeWriter(envelope)` | token、5項目のidentity、contextId、現行executionを照合する |
| `registry.authorizeEvent(envelope)` | 同じ期間境界をイベント入口に適用する |
| `authority.end(executionId)` | 期間を不可逆に終了し、そのwriterを失効させる |
| `createProviderRegistrationAdapter(provider, registry, authority)` | ClaudeとCodexの実adapterを構成し、provider固定の登録とnativeContext照合を行う |

writer envelopeは`{token, identity, contextId, executionId}`とする。
MCP組立コードは認証済みwriterを`options.writer`としてメモリー内で渡す。
Codexでは各呼出しの`_meta.threadId`とnativeIdの一致を要求し、Claude IDへfallbackしない。
通常のstdioエントリポイントへbindingを供給する外部起動経路は#171と#166-Bへ残す。

identity候補はprovider、nativeIdKind、hostId、homeScopeId、nativeIdを含む。
保存するevidence metadataはevidenceId、source、method、adapterVersion、runtimeVersion、capabilities、observedAt、registrationRefに限定する。
対象identityは登録・binding APIの独立した引数で照合し、metadataから推定しない。
registrationRefは後続の認証済み起動登録を参照する値であり、参照値だけでは起動を証明しない。
verified判定の主体と結果は観測者が提出したmetadataから分ける。
opaque writer tokenは実行時のnative bindingとprovider、scope/context、executionが一致した場合だけ発行し、MCPの各書込みで要求claimと全項目を照合する。
nonce、token、capability、機密payloadはmetadataやログに含めない。
実装上の期間IDはexecutionIdとする。
シナリオ表のperiodIdは同じ期間を指す。

## Claudeの互換経路

旧storeのplan、判断事項、PRと表示設定は既存schemaで読み取る。
保存値と非公開session fileからauthorityやwriterを復元しない。
初期Claude期間ではHTTPとhookのID規則に合い、衝突しない旧native aliasをprojectionに使い、別HOMEやresumeには別projectionを割り当てる。
アンダースコアを含む保存済み旧IDは読み取りを保持し、新しい認証済み期間には別projectionを割り当てる。
新期間の書込みで旧期間のplanを上書きしない。

kernelへ未登録のClaude aliasでは、既存hookの観測経路を維持する。
この経路は認証済み正規登録ではなく、両adapterの適合成功へ数えない。
登録済みaliasへのwriter欠落eventは拒否し、旧期間や期間不明eventで現行期間のstate、PR、回答を変更しない。
未登録MCPはPIDやClaude IDが一致しても拒否する。
このため通常HOMEへの旧MCP設定だけでは新しい認証済み書込みを開始できない。

## 検証層と採用条件

| 検証層 | #166-Aで確認すること | 結果の意味 |
|---|---|---|
| 製品登録核の単体試験 | test証拠を使い、製品kernelのidentity tuple、期間遷移、権限判定を仕様表どおりに検証する。 | 製品kernelの局所的な適合を示す。adapter接続や実runtimeの認証を示さない。 |
| 製品adapter適合 | 同じscenarioを製品のClaude adapterとCodex adapterへ通し、test verifierが作る模擬証拠で本物の正規化、登録核、state/MCP接続を検証する。 | test証拠を使った製品adapter経路の適合を示す。vendor認証や実native bindingを示さない。 |
| 実runtime | Claude/Codex runtimeで認証済み起動、native binding、実HOME scope、resumeと新開始、接続世代を確認する。 | 記録した版と能力に対する実測結果を示す。#166-Aのfixture結果から推定しない。 |

各共通適合scenarioは両製品adapterへ実装してから合否を付ける。
未実装側、skip、環境制約で未実行の層は未確認と記録する。
PIDまたはClaude ID fallbackを使った既存経路、参照モデルだけの成功、両adapter間の出力一致だけでは合格にしない。

本実装前提PRは開発者側でfeatureへ集約された。
製品コードを含む統合checkpoint `99b365a`でnpm testは1043件成功、失敗とskipは0件だった。
続く`dc76304`は本実装計画と入口リンクだけの集約である。
この開始ゲートの成功は製品adapterや実runtimeの採用条件を証明しない。

製品kernelの単体試験は`node --test test/conversation-registry.test.js`、両adapterの共通試験は`node --test test/provider-registration-conformance.test.js`で実行する。
後者では製品の登録adapter、HTTPサーバー、MCP要求処理を使い、認証済み起動を模擬するtest authorityだけをfixtureで供給する。
実runtimeからの証拠取得を代替しない。
HTTPの回答pollとレビュー不要記録は、待機中の失効と副作用0回を各入口の試験でも確認する。

共通試験の8シナリオでは、模擬証拠を使った両製品adapterの対象分岐が成功した。
2026-10-06の全体検証では`npm test`の1077件が成功し、失敗、skip、todoは各0件だった。
ID-F02-A02で確認したのは、同じactive identityの二重開始、開始証拠の再利用、identityを差し替えたbindingの拒否である。
物理actorとexecutionBindingが本当に同じ実宛先を指すことの検証は#171へ残る。
ID-F02-A05は旧Claude保存内容の読取と、再起動後に旧writerが復活しないことを確認し、canonical履歴の保存復旧は#177-Aへ残る。

確認に使用した版はNode.js 24.15.0、gh 2.92.0、Codex CLI 0.160.1、Claude CLI 2.1.291である。
CLIの版取得だけではnative binding、`_meta.threadId`の実供給、scope認証の能力を確認したことにならない。
版の厳密な一致は採用条件にせず、#180-Aでは認証済み開始、native metadata、HOME scope、resumeの能力を実測して記録する。

## 後続へ渡す未確認事項

| 担当 | 残る確認 |
|---|---|
| #170 | 管理CLI collectorの認証、接続世代、再接続、provider別観測能力、hostとHOME scopeの信頼できる供給元。 |
| #171-A/B | 認証済み起動登録、originBindingとexecutionBinding、native binding証拠、writer capabilityのissuer/verifier、現在ownerとの照合。 |
| #166-B | #171のbinding後にdelegated MCP登録を共通核へ接続し、親子bindingが一致する要求だけを扱う。 |
| #177-A | canonical identity、period、接続世代、証拠失効を保存復旧するschema。旧storeから認証を復元せず、再起動後に再照合する。 |
| #180-A | 実Claude/Codexの薄い接続でstart evidenceとnative bindingを確認し、CLI、アプリ、daemonの版と能力を記録する。 |

#166-Aを提供してもIssue #166全体を閉じない。
#166-B、#171の実binding、#170 collector、#177-A復旧、#180-A実runtime接点が後続の採用条件として残る。

登録核のmetadataとwriterはこの段階ではメモリー内だけに置く。
既存storeのschemaは変更しない。
同じnative会話に対するdaemon再起動後の期間履歴とaliasの復旧は#177-Aで結合し、今回の期間分離試験は同じkernelの寿命内を対象にする。
再起動した空のkernelでは旧tokenを認可しない。
