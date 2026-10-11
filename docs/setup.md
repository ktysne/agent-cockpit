# agent-cockpit の導入手順

この文書は、agent-cockpit を導入する AI(Claude Code など)が読む手順書です。人が読んで手で進めることもできます。

## 実験用managed collector

managed collectorは通常の導入では有効にならず、`npm start`もruntimeへ接続しません。
隔離probeで使う場合は、明示的なtrusted compositionから`startServer({ managedCollectors })`へcollectorを渡します。
probe専用のHOME、接続先、資格情報を用意し、通常のClaude HOME、Codex HOME、MCP登録、外部hook設定は変更しません。
remote実行環境では、loopback外へtransportを公開せず、認証済みの接続とHOME scopeを検証できる環境だけを使います。
native actorと登録済みexecutionを結ぶ証拠が確認されるまでは、観測はunknownとして扱い、production bindingとして採用しません。
通常HOMEへの導入案を検討するときは、対象、差分、復旧手順を先に示し、個別の承認後にだけ進めます。

実験用のowned native runnerとCodex managed processに実行ファイルを指定する場合、Windowsではproviderのnative `.exe`の絶対パスを使います。
npmの`codex.cmd`などのshell wrapperは使えず、`executable_format_unsupported`になります。設定を確認し、providerが提供するnative実行ファイルの場所を明示してください。
この診断は認証や隔離HOME配下の作成より前に行います。`.exe`という拡張子だけでインストールや実行の成功を保証するものではありません。

実験用runnerは、起動元の信頼済み環境から`HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`、`SSL_CERT_FILE`、`NODE_EXTRA_CA_CERTS`だけを通信設定として継承します。
CAの二つの変数には完全な絶対パスを指定します。不正な型や制御文字、相対CAパスは、値を表示せず`invalid_transport_environment`で起動を拒否します。
proxyを設定する場合は、起動元の`NO_PROXY`へloopbackの除外を設定してください。`127.0.0.1,localhost,::1`は例で、IPv6の表記と解釈はproviderごとに未確認です。認証付きのCockpit loopback通信をproxyへ送らないための条件です。値は自動補完しません。実providerでloopbackが直結することを確認してから使用してください。
変数を渡す検査は、実providerでのproxyやCAを使った通信成功を保証しません。供給元と検証範囲は[通信環境の契約](design/native-transport-environment.md)にあります。

owned Codexのbrowser認証URLは`https://auth.openai.com`と`https://chatgpt.com`のoriginに限定します。未知のoriginや非標準portは、URLを表示せず`authentication_response_invalid`で拒否します。前後空白も受け付けません。対象は初期URLで、後続redirectと実runtimeの互換性は未確認です。[認証URLの契約](design/native-authentication-url.md)に検査条件があります。

同module内のowned Codexのログインは順番に開始します。queueの期限切れは`authentication_queue_timeout`になります。開始済みloginの停止が未確認の場合、childのexitとcloseを両方確認するまで後続を開始しません。別processや外部CLIとの競合とOS portの解放は、この制御から保証しません。[ログイン直列化の契約](design/native-login-serialization.md)に待機と解放の条件があります。

`stop_unconfirmed`のloginが残ると、後続も`authentication_queue_timeout`になり得ます。対象実行と関連processの停止を確認してください。保持しているchildのexitとcloseがCockpitへ届けば、ゲートは自動解放されます。Cockpitの再起動は旧childの停止確認の代わりにならず、終了不明のまま再起動して認証競合が解消することは保証できません。

## 進め方の決まり

- `~/.claude/settings.json`、MCP サーバーの登録、`~/.claude/skills/` は、リポジトリの外にあり、開発者のすべてのセッションに効きます。変更する前に、追加する内容(差分)を開発者に示し、確認を得てから書き込んでください。agent-cockpit はこれらを自動では変更しません。
- 既存の設定は消さずに統合します。同じイベントの配列がすでにあるときは、その配列へ要素を足します。
- 連携ツール(GitHub CLI、claude-codex-bridge、ai-cross-review)そのものの導入手順は、この文書では扱いません。導入されていなければ、各ツールのドキュメントへ案内してください。この文書は、連携ツールが導入済みのときに agent-cockpit 側で必要な設定だけを書いています。
- 手順の中の `D:/path/to/agent-cockpit` は、このリポジトリを置いた絶対パスに置き換えます。worktree ではなく、残しておく本体のチェックアウトを指してください。worktree を消すと、フックの参照先が無くなります。
- この文書の `~/.claude` は Claude のホームを指します。`CLAUDE_CONFIG_DIR` を設定しているときは、そのディレクトリの `settings.json` と `skills/` を使ってください。
- 設定を変えた後は、新しく開いたセッションから効きます。実行中のセッションは、後から足したフックや MCP サーバーを読み込みません。

## パターンの選び方

まず「パターン A: agent-cockpit だけ」を行います。そのうえで、導入済みの連携ツールに合わせて B〜D を足します。B〜D は互いに独立していて、いくつでも組み合わせられます。

| パターン | 対象 | 導入済みかの確かめ方 |
|---|---|---|
| A | agent-cockpit だけ | — |
| B | + GitHub CLI | `gh --version` が通る |
| C | + claude-codex-bridge | Claude のホーム(`CLAUDE_CONFIG_DIR`、無ければ `~/.claude`)か `~/.claude` に `tools/codex-agent.sh` がある |
| D | + ai-cross-review | 対象のリポジトリの worktree のルートに `tools/cross-review.js` がある(リポジトリごとに導入するツールです) |

D の PR カードの表示は、B の PR の表示に加わるものです。D で PR のクロスレビュー状態を見たいときは、B も行ってください。

### 3 つのツールをまとめて導入するとき

agent-cockpit、[claude-codex-bridge](https://github.com/ktysne/claude-codex-bridge)、[ai-cross-review](https://github.com/ktysne/ai-cross-review) をまとめて入れるときは、次の順に進めます。
どのツールも、ほかのツールの有無を実行時に調べるので、順番を変えても動きます。この順にすると、各ツールの連携の確認を、導入した時点でそのまま行えます。

1. claude-codex-bridge を、そのドキュメントに従って導入します。ai-cross-review と連携するなら、`codex-review` と `codex-subagent` を配置するパターン(bridge のパターン 2 か 3)を選びます。
2. この文書のパターン A、B、C を行います。
3. レビューを回すリポジトリごとに、ai-cross-review をそのドキュメントに従って導入します(ai-cross-review のパターン A〜D)。
4. この文書のパターン D を行います。

## パターン A: agent-cockpit だけ

### 前提

- Node.js 22 以上(`node --version`)
- Claude Code(`claude --version`)。MCP サーバーの登録に `claude` コマンドを使います。
- 外部パッケージは使わないので、`npm install` は不要です。

### 1. リポジトリを置く

```bash
git clone https://github.com/ktysne/agent-cockpit.git
```

置いた場所の絶対パスを、以降の手順で使います。

### 2. フックを登録する

次の `hooks` を `~/.claude/settings.json` に統合し、`D:/path/to/agent-cockpit` をリポジトリの絶対パスに、`D:/path/to/node` を node の絶対パス(手順 3 の `$nodePath` や `command -v node` の値)に置き換えます。
実行ファイルと引数を分ける exec 形式(`command` と `args`)で書きます。Windows ではフックのコマンドが PowerShell で解釈され、引用符付きの実行ファイルのパスが失敗するためです。
exec 形式で書くのは、常駐サーバーがフックの親プロセスを Claude 本体と照合するためでもあります。文字列の形のフックや、`node` を PATH 経由で呼ぶ形は `claude → シェル → node` となり、親が Claude 本体にならないので照合が通りません。通らないフックは、未登録の観測の経路で扱われ、ダッシュボードには表示されますが、MCP の書き込みと同じセッションには載りません。照合に失敗した理由(`claude_parent_unverified` など)は常駐サーバーのログ(`~/.agent-cockpit/server.log`)に出ます。

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"] }] },
      { "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/away.js"], "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] },
      { "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/away.js"], "timeout": 1830 }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "PostToolUseFailure": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "PostToolBatch": [
      { "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/answer.js"], "timeout": 2 }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] },
      { "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/answer.js"], "asyncRewake": true, "timeout": 3600 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] },
      { "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/away.js"], "timeout": 5 }] },
      { "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/answer.js"], "timeout": 5 }] }
    ]
  }
}
```

同期か非同期か、timeout の値には理由があります。値を変えずに登録してください。

- `SessionStart` の `event.js` は同期で動き、常駐サーバーが動いていなければ起動します。起動したダッシュボードの URL を `additionalContext` でセッションへ渡します。そのため、`npm start` で別に起動しておく必要はありません。
- `PreToolUse`(matcher `AskUserQuestion`)の `away.js` は、離席中にダッシュボードの回答を待ちます。待つ時間は設定画面で 1〜30 分に変えられるので、timeout は最大値に 30 秒の余裕を足した 1830 秒に固定します。
- `UserPromptSubmit` と `SessionStart` の `away.js` は同期で、timeout は 5 秒です。
- `PostToolBatch` の `answer.js` は同期で timeout 2 秒、`UserPromptSubmit` の `answer.js` は同期で timeout 5 秒です。作業中のセッションへ回答を差し込みます。
- `Stop` の `answer.js` は `asyncRewake: true` と timeout 3600 秒です。待機中のセッションを、回答が届いたときに起こします。
- そのほかの `event.js` は `async: true` で、作業を止めません。

### 3. MCP サーバーを登録する

登録核は、認証済みの writer を持つ書き込みだけを受け付けます。
Claude のセッションでは、MCP サーバーとフックが自分の親プロセスの pid を常駐サーバーへ申告し、常駐サーバーが `~/.claude/sessions/<pid>.json` と照合して writer を発行します。この照合は認証ではなく、同じ利用者の中の取り違え(Claude の Bash から起動した Codex が環境変数を継承する場合など)を防ぐためのものです。仕組みは[Claude の writer の発行](design/claude-local-issuer.md)にあります。
照合が成り立つ条件は、MCP サーバーを `node` の絶対パスで登録すること(下の手順)と、フックを exec 形式で設定すること(手順 2)です。シェルやラッパーを挟んで起動すると、親が Claude 本体にならず、MCP の書き込みは親プロセスを確認できない旨のエラーで拒否されます。
共通質問の3ツールも同じ認証済みwriterを要求します。
正式ログインと製品MCPの組立、実nativeでの確認条件は[共通質問の設計](design/common-questions.md#実native接続の採用条件)に記載しています。
登録核の契約と残る採用条件は[正規会話の登録核](design/codex-registration-core.md)を参照してください。

メインセッションがタスクと判断事項を書き込むための MCP サーバーを、ユーザーのスコープで登録します。リポジトリのルートで実行します。

PowerShell:

```powershell
$nodePath = (Get-Command node).Source
$serverPath = (Resolve-Path .\src\mcp\server.js).Path
claude mcp add --scope user agent-cockpit -- $nodePath $serverPath
```

bash:

```bash
claude mcp add --scope user agent-cockpit -- "$(command -v node)" "$(pwd)/src/mcp/server.js"
```

登録方法は [Claude Code の MCP ガイド](https://docs.anthropic.com/en/docs/claude-code/mcp) に従っています。

### 4. スキルを置く

メインセッションが MCP ツールの使い方を読むスキルを、`~/.claude/skills/agent-cockpit/` にコピーします。

PowerShell:

```powershell
$skillDirectory = Join-Path $env:USERPROFILE '.claude\skills\agent-cockpit'
New-Item -ItemType Directory -Path $skillDirectory -Force | Out-Null
Copy-Item .\skills\agent-cockpit\SKILL.md (Join-Path $skillDirectory 'SKILL.md') -Force
```

bash:

```bash
mkdir -p ~/.claude/skills/agent-cockpit
cp skills/agent-cockpit/SKILL.md ~/.claude/skills/agent-cockpit/SKILL.md
```

リポジトリを更新してスキルが変わったときは、コピーし直します。

### 5. タスクトレイを入れる(Windows、任意)

Windows では、タスクトレイからダッシュボードを専用のウィンドウで開けます。PowerShell の実行ポリシーが `RemoteSigned` 以上であることが前提です(`Get-ExecutionPolicy` で確かめます。既定の `Restricted` のままでは、何も表示せずに起動が失敗します)。

```powershell
powershell.exe -NoProfile -File ".\src\tray\install-shortcut.ps1"
```

デスクトップとスタートメニューに「Agent Cockpit」のショートカットができます。ショートカットには実行したチェックアウトの絶対パスが入るので、worktree ではなく本体のチェックアウトから実行してください。

ログオン時にタスクトレイだけを自動で起動する(ダッシュボードは開かない)には、上のコマンドとは別に `-Startup` を付けて実行します。`-Startup` を付けた実行は、スタートアップのショートカットだけを作ります。

```powershell
powershell.exe -NoProfile -File ".\src\tray\install-shortcut.ps1" -Startup
```

### 6. 保存先とポートを変えるとき(任意)

既定では、保存先は `~/.agent-cockpit/`、ポートは `47821` です。変えるときは、環境変数 `AGENT_COCKPIT_HOME` と `AGENT_COCKPIT_PORT` を設定します。
フック、MCP サーバー、常駐サーバーは同じ値を読む必要があるので、Claude Code を起動する環境(ユーザーの環境変数など)に設定してください。

### 確認

1. Claude Code で新しいセッションを開きます。`SessionStart` のフックが常駐サーバーを起動します。
2. 常駐サーバーが応答することを確かめます。

   ```powershell
   Invoke-RestMethod http://127.0.0.1:47821/health
   ```

   ```bash
   curl -s http://127.0.0.1:47821/health
   ```

   `"app":"agent-cockpit"` を含む JSON が返れば成功です。接続できないときは、フックの登録(パスと exec 形式)と、`~/.agent-cockpit/server.log` を確かめます。
3. ブラウザーで `http://127.0.0.1:47821/` を開き、1 で開いたセッションが表示されることを確かめます。
4. `claude mcp list` を実行し、`agent-cockpit` がつながっている(`Connected`)ことを確かめます。
5. 1 のセッションで「`cockpit_set_tasks` で確認用のタスクを 1 件登録して」と依頼します。そのセッションの欄にタスクが出れば、MCP サーバーとフックが同じセッションを指していることも確かめられます。別のセッションの欄に出たり、どこにも出なかったりするときは、MCP サーバーの登録を確かめます。
6. `~/.claude/skills/agent-cockpit/SKILL.md` があることを確かめます。
7. 回答の経路を確かめるときは、画面上部の「離席中」をオンにしてから、セッションに「確認のために `AskUserQuestion` で質問して」と依頼します。ダッシュボードに判断待ちとして出て、画面から回答するとセッションがその回答で進めば成功です。確かめ終わったら「離席中」をオフに戻します。離席中でないときは、質問はデスクトップアプリのダイアログに出ます。

導入できたら、画面の使い方を利用者向けマニュアルで確かめます。常駐サーバーが `http://127.0.0.1:47821/manual/` で配ります。

## パターン B: + GitHub CLI

### 前提

GitHub CLI を導入し、`gh auth login` でログインしておきます。導入とログインは [GitHub CLI のドキュメント](https://cli.github.com/manual/) に従ってください。

### agent-cockpit 側の設定

agent-cockpit 側で追加する設定はありません。次の 2 点だけ確かめます。

- 常駐サーバーは、自分を起動したプロセス(フックを実行した Claude Code、またはタスクトレイ)の `PATH` から `gh` を探します。Claude Code を起動する環境で `gh` が見つかるようにしてください。
- 常駐サーバーは `gh` を呼ぶときに、環境変数 `GH_TOKEN`、`GITHUB_TOKEN`、`GH_ENTERPRISE_TOKEN` を外します。セッションの環境に入ったトークンで GitHub を操作しないためです。そのため、`gh auth login` で保存した認証情報が必要です。

PR は、セッションが `gh pr create` を実行したときに自動で登録されます。ほかの方法で作った PR は、セッションから MCP ツール `cockpit_add_pr` に URL を渡して登録します。

### 確認

1. 環境変数のトークンを外した状態で、`gh` が認証済みであることを確かめます。

   ```powershell
   powershell.exe -NoProfile -Command "Remove-Item Env:GH_TOKEN, Env:GITHUB_TOKEN, Env:GH_ENTERPRISE_TOKEN -ErrorAction SilentlyContinue; gh auth status"
   ```

   ```bash
   env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN gh auth status
   ```

2. セッションで PR を作るか、既存の PR の URL を `cockpit_add_pr` で登録させます。ダッシュボードのプルリクエストの欄に、その PR が CI とレビューの状態と一緒に出れば成功です。
3. 「gh コマンドが見つかりません」と出るときは `PATH` を、「gh の認証、通信、または取得結果を確認してください」と出るときは 1 のログイン状態を確かめます。

## パターン C: + claude-codex-bridge

### 前提

[claude-codex-bridge](https://github.com/ktysne/claude-codex-bridge) を、そのドキュメントに従って導入しておきます。agent-cockpit は、Claude のホーム(`CLAUDE_CONFIG_DIR`、無ければ `~/.claude`)か `~/.claude` のどちらかに `tools/codex-agent.sh` があることで、bridge が導入済みだと判断します。
bridge は `CLAUDE_CONFIG_DIR` にかかわらず `~/.claude/tools/` に置く作りなので、`CLAUDE_CONFIG_DIR` を別の場所に設定していても検出できます。

### agent-cockpit 側の設定

画面の「経路の設定」で選んだ経路(既定、Codex、Claude)を、起動するサブエージェントへ伝えるフック `route.js` を登録します。
次の内容を `~/.claude/settings.json` の `hooks` に統合します。パターン A で登録した `SubagentStart` と `PreToolUse` の配列へ、要素を足してください。

```json
{
  "hooks": {
    "SubagentStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/route.js"], "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "D:/path/to/node", "args": ["D:/path/to/agent-cockpit/src/hooks/route.js"], "timeout": 5 }] }
    ]
  }
}
```

`route.js` は同期フックです。`SubagentStart` で、その時点の経路を `AGENT_COCKPIT_HOME` の `route-agents/` に記録し、Codex か Claude を選んでいればサブエージェントへ伝えます。Claude を選んだサブエージェントが `codex-agent.sh` を呼ぶと、`PreToolUse` で止めます。
経路は起動時に決まり、稼働中のサブエージェントは設定を変えても切り替わりません。
経路を Claude にしたとき、bridge の窓口(`impl-hard`、`impl-light`、`impl-standard`)は自分では実装しないので、`codex-agent.sh` の実行を拒否されると `再委譲: impl-*-claude` を報告します。メインセッションは bridge の手順に従って、報告された `impl-*-claude` へ委譲し直します。`codex-review` と `codex-subagent` は、拒否の文言を報告して止まります。定義側での明文化と実機での確認は [ktysne/claude-codex-bridge#129](https://github.com/ktysne/claude-codex-bridge/issues/129) で進めています。
bridge を外したときは、`codex-agent.sh` が無いので `route.js` は何も差し込みません。登録は残したままで構いません。

### 確認

1. 新しいセッションを開き、ダッシュボードを再読み込みします。上部の「経路の設定」に、サブエージェントの段(既定、Codex、Claude)が出れば、bridge が検出されています。出ないときは、`codex-agent.sh` が `~/.claude/tools/` か `CLAUDE_CONFIG_DIR` の `tools/` にあるかを確かめます。
2. 経路を「Claude」にしてから、セッションでサブエージェントを起動させます。サブエージェントが動いている間に、その行に「経路: Claude」の札が出て、`AGENT_COCKPIT_HOME`(既定は `~/.agent-cockpit`)の `route-agents/` に記録のファイルができれば成功です。bridge の窓口(`impl-light` など)を起動したときは、窓口が `再委譲: impl-light-claude` と、`開発者の指定(agent-cockpit の経路設定):` で始まる拒否の文言を報告するのが期待される動きです。違う報告になったときは [ktysne/claude-codex-bridge#129](https://github.com/ktysne/claude-codex-bridge/issues/129) を見てください。
3. 確かめ終わったら、経路を元の値に戻します。

## パターン D: + ai-cross-review

### 前提

[ai-cross-review](https://github.com/ktysne/ai-cross-review) を、そのドキュメントに従って、レビューを回すリポジトリへ導入しておきます。ai-cross-review はリポジトリごとに入れるツールです。agent-cockpit は、稼働中のセッション(`~/.claude/sessions/*.json`)の作業ディレクトリと、PR を登録したセッションの作業ディレクトリについて、その worktree のルートに `tools/cross-review.js` があるかで判断します。

### agent-cockpit 側の設定

agent-cockpit 側で追加するフックや登録はありません。次の点だけ合わせます。

- ai-cross-review は、`node tools/cross-review.js route` で agent-cockpit の `routing.json` からレビュアーの設定を読みます。`AGENT_COCKPIT_HOME` を変えたときは、ai-cross-review を実行する環境でも同じ値が見えるようにしてください。値が見えないと `~/.agent-cockpit/routing.json` を読み、画面の設定が効きません。
- PR のカードにクロスレビューの状態を出すには、パターン B が必要です。カードの状態は、リポジトリの `.cross-review-state.json` に ai-cross-review が記録する往復と結論から読みます。
- 「レビュー収束後マージ」の予約は、ai-cross-review が `converged` を記録した head の SHA でマージします。

### 確認

1. ai-cross-review を入れたリポジトリでセッションを開き、ダッシュボードを再読み込みします。「経路の設定」にクロスレビューの段が出れば、検出されています。出ないときは、うまくいかないときの `~/.claude/sessions/*.json` の項を確かめます。
2. クロスレビューの段で「Codex」を選び、そのリポジトリで次を実行します。`codex` が返れば成功です。確かめ終わったら、元の値に戻します。`route` を使えない古い版のときは、ai-cross-review の導入手順の[「更新するとき」](https://github.com/ktysne/ai-cross-review/blob/main/docs/setup.md#更新するとき)に従って更新します。

   ```bash
   node tools/cross-review.js route
   ```

3. パターン B も行っているときは、そのリポジトリの PR のカードに「クロスレビュー」の段が出ることを確かめます。レビューを回す前は「レビュー未実施」と出て、往復を回すと往復数と結論が出ます。ai-cross-review を入れていないリポジトリの PR は「レビュー不要」と出ます。

## うまくいかないとき

- 画面にセッションが出ない:フックの登録後に開いたセッションかを確かめます。`~/.claude/settings.json` の JSON が壊れていないか、パスが本体のチェックアウトを指しているかを確かめます。
- 常駐サーバーのログは `AGENT_COCKPIT_HOME`(既定は `~/.agent-cockpit`)の `server.log` にあります。
- 常駐サーバーを手で起動するときは、リポジトリのルートで `npm start` を実行します。終了は `Ctrl+C` です。
- `~/.claude/sessions/*.json` は Claude Code の公開仕様ではありません。読めない版でも、フックから組み立てた表示は動きます。ただし、パターン D のクロスレビューの段は、そのリポジトリの PR を登録するまで出ません。
