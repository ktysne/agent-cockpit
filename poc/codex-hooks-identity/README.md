# Codexの識別情報PoC

このPoCはCodex CLI 0.160.0のHooksとMCPから、セッションとサブエージェントを識別する値が得られるか確かめる。
記録するのは識別情報と状態情報の許可リストだけで、prompt、tool入力、tool出力、transcript、認証環境変数は記録しない。
Hooksのイベントと入力フィールドは[公式Hooks仕様](https://learn.chatgpt.com/docs/hooks)に合わせる。
exec runnerは選択した`poc/out/<slug>`の中に実行ごとの専用`CODEX_HOME`を作る。
既存MCP互換runnerは別の専用保存先へ固定fixtureを書き込む。

## 隔離環境を作る

Node.jsとGitを用意し、Codex CLIが0.160.0であることを確認する。
出力先は新しい`poc/out/<slug>`ディレクトリにする。

```powershell
codex --version
node poc/codex-hooks-identity/setup.js --out poc/out/poc157-live --codex-version 0.160.0
```

setupは指定した出力先の中に空のGitリポジトリと専用`CODEX_HOME`を作り、HooksとMCPの設定を生成する。
既存のCodexホーム、認証情報、認証ファイルへのsymlinkは使わない。
実モデルを使う場合は通常のCodex認証が必要になることがあるが、このPoCのfixture実行では認証を使わず、その可否も確認しない。
`run-exec.js`は実行ごとに`runtime-homes/<UUID>`を作り、元の`home/config.toml`と`home/hooks.json`だけをコピーする。
fixture providerはコピーした`config.toml`へ加え、元HOMEには書き込まない。
`hooks.json`は内容を保ったまま複製するため、Hook commandは元HOMEの`hooks/hook-logger.js`を実行し、記録先も元HOMEの`hooks/events.jsonl`になる。
認証ファイル、状態DB、履歴はコピーしない。
`config.toml`内に既存の`hooks.state`があれば原文のままコピーし、新しいcommand向けの信頼情報は生成・書換えしない。
新HOMEでCodexが信頼確認を求めた場合は通常の画面操作で判断する。
実行終了時に専用設定を復元できなかった場合は結果に`isolated_config_restored: false`を記録して失敗扱いにする。

## CLIで確認する

PowerShellで専用ホームと専用リポジトリを指定してCodex CLIを起動する。

```powershell
$env:CODEX_HOME = (Resolve-Path 'poc/out/poc157-live/home').Path
codex --no-daemon --no-alt-screen -s read-only -C 'poc/out/poc157-live/repo'
```

CLIで`/hooks`を開き、Hooks定義を読み、通常の信頼確認を行う。
trustを迂回する起動フラグは使わない。
短いpromptと安全なtool操作を行い、SessionStart、PreToolUse、PostToolUse、SubagentStart、SubagentStop、Stopなどの記録を確認する。
SubagentStopとStopはCodexが要求するJSON出力として空オブジェクト`{}`を返す。
Hook記録は`home/hooks/events.jsonl`に追加される。
PostToolUseに専用の終了コードまたは成否フィールドがなければ`tool_outcome`は`unknown`になる。

## ローカルfixtureでexecを再現する

実行ファイルのパスを指定し、まずfixtureだけを起動する。
このモードは専用設定を用意して待機し、Codexの実行は始めない。

```powershell
$codexExe = Join-Path $env:APPDATA 'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
node poc/codex-hooks-identity/run-exec.js --codex-path $codexExe --out poc/out/poc157-live --serve --start-with mcp
```

runnerが出力する`isolated_home`を使って別のPowerShellからCodex CLIを開き、`/hooks`で定義と通常の信頼確認を行う。
既存の`hooks.state`は設定ファイルの一部として原文のまま複製するが、新しいcommand向けの信頼情報は追加しない。
Codexが信頼確認を求めた場合は通常の画面操作で判断する。
このCLIでMCPを試す間はfixture serverを起動した端末を開いたままにする。
確認後にCLIを終了してからfixture runnerへ`Ctrl+C`を送り、専用設定の復元結果を確認する。

```powershell
$isolatedHome = '<runner出力のisolated_home>'
$env:CODEX_HOME = $isolatedHome
codex --no-daemon --no-alt-screen -s read-only -C 'poc/out/poc157-live/repo'
```

非対話や強制終了では専用設定の復元を保証しない。
停止後に専用`config.toml`を確認し、`isolated_config_restored`が`false`または結果ファイルがない場合は、fixture tokenが残っていないか確認する。

次のコマンドは新しい専用HOMEを作ってfixture経由の`exec`を実行する。
既存の`hooks.state`は原文のまま複製するが、新しいcommand向けの信頼情報は追加しない。

```powershell
node poc/codex-hooks-identity/run-exec.js --codex-path $codexExe --out poc/out/poc157-live
```

RunnerはCodex 0.160.0を確認してから、認証環境変数を引き継がず、`--no-daemon exec --json --ephemeral -C <repo> -s read-only`を40秒以内で実行する。
信頼、承認、sandboxを迂回するフラグは付けない。
一時fixture tokenは専用設定にだけ置き、結果JSONや標準出力には含めない。
元HOMEの設定ファイルは読み取り専用で、fixture設定は実行ごとの`isolated_home`へ保存する。
結果JSONには`source_home`と`isolated_home`のパスを記録するが、設定内容は記録しない。
cleanup時に専用設定がfixture適用時の内容から変わっていた場合は上書きせず、`isolated_config_restored: false`で失敗にする。
結果JSONにはこの実行情報に加え、イベントの公開ID・型・状態、許可したMCP probe項目、固定fixtureメッセージ、stderrのwarning/error件数を保存する。
fixture未対応またはtool errorがあれば、Codexの終了コードが0でも成功扱いにしない。

このResponses backendはローカルの決定的fixtureで、モデル名はfallback metadataである。
実モデル、実API認証、Codexの通常モデル応答を確認した結果として扱わない。
`--serve`は手動のHooks信頼確認を補助する準備モードであり、fixtureからの実行は開始しない。
MCPだけをTUIで試すときは上記の`--serve --start-with mcp`でfixtureを準備し、別のCLIから`probe_identity`を呼び出す。
通常の許可画面で一回限りのAllowを選び、承認や信頼を迂回する設定は使わない。

`isolated_config_restored: false`が出た場合は、対象の`isolated_home`を使わず、そのHOMEの`config.toml`を確認する。
プロセスを強制終了して結果ファイルがない場合もcleanup済みとは見なさない。
fixture tokenが残っている場合は専用HOME内の設定だけを復元するか、新しい`poc/out/<slug>`でsetupをやり直す。
元HOMEの設定ファイルは読み取りだけなので、fixture設定やcleanupによる変更は受けない。

## app-serverからMCPを確認する

専用ホームの設定を使い、検証済みのnative Codex実行ファイルを明示してRPC経路を再現する。

```powershell
$codexExe = Join-Path $env:APPDATA 'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
node poc/codex-hooks-identity/run-rpc.js --codex-path $codexExe --out poc/out/poc157-live
```

Runnerはapp-serverの版を0.160.0と照合し、2つのephemeral threadを作って各3回MCPを呼び出す。
呼出し引数を省略した場合、実thread IDを指定した場合、意図的に異なるIDを指定した場合を比べる。
`_meta.threadId`への偽値も送り、runtimeが実thread IDに置き換えることを確認する。
Runnerは各RPCを15秒で打ち切り、認証環境変数を子プロセスへ渡さない。
サニタイズした応答を選択した`poc/out`配下の`rpc-results-*.json`へ書く。

MCPの`probe_identity`は任意の`session_id`と`agent_id`を受け取り、明示引数、環境変数の候補、MCP metadataを別フィールドで返す。
確認する環境変数は`CODEX_THREAD_ID`、`CODEX_SESSION_ID`、`CODEX_AGENT_ID`、`CODEX_TURN_ID`、`CLAUDE_CODE_SESSION_ID`に限る。
これらの`CODEX_*`候補がCodex CLI 0.160.0の公開環境変数であることは前提にしない。
長さまたは文字種が許可範囲に入らない識別値は`unknown`として扱う。
`CLAUDE_CODE_SESSION_ID`は値を返さず、有無と明示session IDとの一致だけを返す。
MCP要求の`_meta`はキー名を返し、`threadId`だけは識別値として安全性を検査して明示session IDとの一致を返す。
`progressToken`など、ほかの`_meta`値は読み出さない。
`probe_identity`は読み取り専用・副作用なしのtool annotationsを`tools/list`で公開する。
これはツールの性質を説明するメタデータで、許可確認やHooksの信頼設定を迂回しない。

## 既存Agent Cockpit MCPのルーティングを確認する

既存の`src/mcp/server.js`がMCPの`_meta.threadId`ではなく`CLAUDE_CODE_SESSION_ID`を送信先に使うことを、専用保存先で確かめる。
Codex実行ファイルと、setupで作った専用ホーム・Gitリポジトリを指定する。

```powershell
node poc/codex-hooks-identity/run-existing-mcp.js --codex-path $codexExe --out poc/out/poc157-live
```

RunnerはCodex 0.160.0のapp-serverをstdioで起動し、ephemeral threadを2件作って各threadから`cockpit_set_tasks`、`cockpit_add_decision`、`cockpit_add_pr`を呼ぶ。
既存MCPには専用`AGENT_COCKPIT_HOME`と合成`CLAUDE_CODE_SESSION_ID`を設定する。
PR取得処理はno-opに差し替えるためGitHubへ接続せず、通常のCockpitポートやデータにも触れない。
Runnerは専用`config.toml`にMCP設定を実行中だけ加えて元に戻し、サーバーを閉じて一時保存先を削除する。
結果JSONにはnative thread ID、保存先ごとの件数、tool呼出しの成否だけを記録する。

この再現は既存MCPの書込みがnative thread IDへ分離されるか、`CLAUDE_CODE_SESSION_ID`に集約されるかを判定する。
ツール応答がエラーまたは未知の形なら成功とは扱わない。

## 現時点の実測

専用`CODEX_HOME`を使ったCodex 0.160.0のapp-server直接呼出しでは、2件の`thread/start`後に各threadで3回ずつ`mcpServer/tool/call`を行った。
この経路のMCPプロセスには`CODEX_THREAD_ID`、`CODEX_SESSION_ID`、`CODEX_AGENT_ID`、`CODEX_TURN_ID`が渡らなかった。
MCP設定で`CLAUDE_CODE_SESSION_ID`を明示的に転送するとsynthetic値が届いたが、値を返さず明示session IDとの一致だけを返した。
同じ直接呼出しで`_meta`に`progressToken`と`threadId`のキーが観測され、`threadId`は実thread IDと一致した。
呼出し側が別の`_meta.threadId`を指定しても実thread IDに置き換わり、明示引数に別thread IDを渡した試験でも照合結果は不一致になった。
別の専用TUI fixture実測では、MCPだけを起動した後に通常の一回限りのAllowを選ぶと`probe_identity`が成功し、`_meta.threadId`はSessionStartのIDと一致した。
4つの`CODEX_*`環境変数候補はMCPプロセスに渡らなかった。
この観測は固定応答fixtureを使ったTUI経路に限り、実モデル応答やデスクトップアプリでは確認していない。
実測結果は`poc/out/poc157-live/rpc-results-*.json`に出力される。

既存MCP互換runnerでは、native threadを2件作り各3 tool callを行うと全呼出しが成功した。
native thread IDごとの保存件数はtask、decision、PRとも0件で、合成`CLAUDE_CODE_SESSION_ID`にはtask 1件、decision 2件、PR 2件が集約された。
実測結果は`poc/out/poc157-live/existing-mcp-results-20261005T135900386Z.json`にある。
このrunnerの`success: true`は誤ルーティングを再現できたことを示し、Codexで既存MCPをそのまま採用できる確認ではない。

## 確認結果を区別する

`probe.test.js`、`run-exec-scenario.test.js`、`runtime-fixture.test.js`、`existing-mcp.test.js`はfixtureを使う単体テストであり、Codex CLIの実測結果ではない。
実測では生成した専用環境、Codex CLIのバージョン、Hook JSONL、MCP応答、Responses fixture経由の`exec`結果を区別して記録する。
未知の入力形状からtool名、成功状態、終了コードを推定しない。

```powershell
node --test --test-isolation=none poc/codex-hooks-identity/probe.test.js poc/codex-hooks-identity/run-exec-scenario.test.js poc/codex-hooks-identity/runtime-fixture.test.js poc/codex-hooks-identity/existing-mcp.test.js
```
