# ネイティブrunnerのactor寿命と固定wait profile

## 対象と制約

cockpit-native-v1 は一回のturnを実行する既存profileとして維持する。
cockpit-native-wait-v1 はCodex専用のtrusted profileであり、任意のCLI引数、任意のtool、任意のMCP設定を受け取らない。
wait profileは experimentalApi=true と固定の cockpit_wait dynamic tool一つだけを追加する。
cockpit_wait の引数schemaは空objectに限定し、callerやmodelが渡す内容を証拠として使わない。
features.shell_tool、features.unified_exec、features.multi_agent、features.apps、features.hooks、features.skill_mcp_dependency_install、features.daemon_auto_start、features.browser_use、features.browser_use_external、features.browser_use_full_cdp_access、features.computer_use、features.image_generation、features.plugins、features.remote_plugin、features.workspace_dependenciesを個別にfalseへ固定し、web_searchをdisabledにする。
thread/startとturn/startにはread-only sandboxを指定し、turn/startではnetwork accessを無効にし、approvalをneverに固定する。
これらの設定とdynamic toolが、すべての組み込みtoolを無効化することは実runtimeで確認できていない。
dynamic toolの追加はtoolの置換や排他を意味しないため、組み込みtool全体の無効化を保証しない。
wait profileの実runtime採用は、この能力境界と実行環境を別途確認するまで未確認とする。

Codexの認証はowned app-server内のmanaged ChatGPT loginを使い、credential storeをephemeralに固定する。
認証URLはmatchingな account/login/start 応答からだけ読み、trusted認証提示callbackへ一度渡す。
runner自身はbrowserを起動せず、認証challengeや認証情報をsnapshot、log、ファイルへ保存しない。

## 確認したnative protocol

隔離環境にあるCodex CLI 0.160.1のexperimental TypeScript schemaで ThreadStartParams.dynamicTools、item/tool/call、および threadId、turnId、callId、namespace、tool、arguments を確認した。
同schemaはtool応答の contentItems と success も定義する。
[公式app-server資料](https://learn.chatgpt.com/docs/app-server)はdynamic toolsと item/tool/call をexperimentalとして扱い、initialize.capabilities.experimentalApi=true を要求する。
fixtureでは受信messageの jsonrpc を省略でき、指定される場合は "2.0" だけを受理する。
このfixture結果はinstalled app-serverでの実接続確認を意味しない。

wait requestは現在のnative thread、active turn、固定tool名、null namespace、空arguments、RPC request IDを完全一致で照合する。
turn/start応答より早いrequestは一件だけ一時保持し、返されたturn IDとの一致を確認してからcontext登録とwait callbackを行う。
thread/turnの欠落または不一致、重複call、未知のserver requestでは応答しない。
permission requestやほかのserver requestへ自動回答しない。

## fresh contextとwait応答

isCurrent() はownerのfreshness、isSourceCurrent() はrunner sourceのfreshness、isContextCurrent() はkernel上のcurrent proofとnative contextのfreshnessを同期的に確認する。
wait profileは三つのcallbackをすべて必須とし、それぞれが同期的なliteral trueを返した場合だけcallbackまたはresponseへ進む。
runnerは onWaitRequired の直前とnative responseの直前に各gateを確認し、その後にgeneration、thread、turn、terminal状態を再確認する。
throw、thenable、false、callback reentryによるcontext失効、またはstopではwait responseを送らない。
freshness gateが使えないことだけを理由にactorまたはcanonical periodの終了を捏造しない。
nativeのmatching context terminalはwait receiptを失効させ、同じcontextのproofとwriterを再利用できなくする。
source freshnessが不明な間にpositive native observationを配送しない一方、matching context terminalはnegative observationとして配送し、kernelが古いbindingを失効できるようにする。

onWaitRequired(receipt) に渡すreceiptはrunner generationとnative contextへ結び付いたopaque objectである。
wait profileだけが releaseWait(receipt) と cancelWait(receipt) を返す。
receiptは一回だけ使え、別runnerや別contextへ移せない。
releaseWait() のtrueはlatchがterminal操作を受け付けたことを示し、native pipeへのresponse成功は保証しない。
release、cancel、deadlineの応答にはrunnerが固定したstatusとsuccessだけを含める。
native request IDは文字列と整数を区別し、runner寿命中の一意ID集合で再利用を拒否する。
native hold requestとowned wait requestは同じrunner寿命中128件の上限を使い、上限到達時はrunnerをfail closedにする。この上限は長い実行に対する可用性上の制約となる。
wait responseのwrite直前に既存のwait gateを再確認し、型付きrequest ID、child、generation、thread、元turnだけを非公開のresponse記録へ保存する。
`serverRequest/resolved`は同じchild、generation、threadに対応するowned wait responseだけを確認し、pending hold requestの既存照合条件は別に維持する。
応答を返さずに無効化または破棄した既知のactive/early waitも、元の型付きrequest ID、child、generation、thread、turnを同じ128件上限内で保持する。
対応する遅延`serverRequest/resolved`は一度だけ消費し、pending holdとrevisionを変えない。
未知または二重の通知と、ID型、thread、child、generationのいずれかが一致しない通知はfail closedにする。
resolution通知がwrite callbackより先に届いた場合は両方の到着まで記録を保持し、write errorはresponse失敗としてrunnerを停止する。
resolution時に現在turnとの一致は求めないため、wait response後にturnが進んでも元のscopeで確認できる。
response記録はwrite成功と対応通知の両方を確認した後、またはrunnerの失敗・停止時に破棄し、request IDやresponse本文はsnapshotやlogへ含めない。

## deadlineとprocess寿命

wait latchはmonotonic clockによる固定5分deadlineを持ち、release、cancel、deadlineのうち最初に成立した状態を採用する。
context terminal、runner stop、failureはlatchを無応答で失効させる。
deadline時点でowner、source、contextのどれかがfreshでなければ、deadline応答を送らずreceiptを再利用できなくする。
deadlineはnative subprocessを停止しないため、呼び出し側がstopを明示する必要がある。
stop後にchildのexitまたはcloseを確認できなければsnapshotは stop_unconfirmed を示す。

Codexのnative thread responseだけがnative identityを確定し、matching turn/start responseだけがnative contextを確定する。
matching terminalはcontextを終了するが、actorまたはcanonical periodの終了を意味しない。
terminal後もprocessが生きていることからactor operational proofや新contextを作らない。
新しいwriter/proofには新しいnative contextと明示reconcileが必要である。

## Claudeの対応範囲

Claude Code 2.1.291のCLI helpはstream-jsonの入出力、partial message、MCP関連option、tool filterを示す。
[Claude Code SDKのstreaming資料](https://code.claude.com/docs/en/agent-sdk/streaming-output)は複数入力を扱うlong-lived sessionとassistant message IDを説明する。
[tool-use資料](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)はtool_use IDと対応するtool result IDを定義する。
installed CLIのschema/helpではMCP call IDとassistant contextのcorrelationを確認できていない。
そのためClaudeのwait profileはunsupportedとしてspawn前に拒否し、v1のClaude one-message bindingをwait能力へ拡張しない。

## 検証境界

fake child/stdin fixtureは固定request schema、早着一件queue、identity/context照合、opaque receipt、静的response、deadlineの一回性、terminal後responseゼロを確認する。
fixtureはfreshness callbackの欠落、false、throw、thenable、callback reentry、stop、cross-runner receipt、unknown requestも確認する。
fixture成功はinstalled runtimeのexperimental compatibility、modelのtool選択、built-in tools全体の無効化、認証、live kernel proof、writer提供を証明しない。
実runtimeでのCodex waitは、これらを独立に確認するまで未採用とする。

## 一次資料

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Claude CLI usage](https://code.claude.com/docs/en/cli-usage)
- [Claude SDK streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Claude SDK streaming and single mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Claude tool-use handling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
