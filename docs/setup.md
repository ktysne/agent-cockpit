# agent-cockpit の導入手順

この文書は、agent-cockpit を導入する AI(Claude Code など)が読む手順書です。人が読んで手で進めることもできます。

## 進め方の決まり

- `~/.claude/settings.json`、MCP サーバーの登録、`~/.claude/skills/`、Codex の `~/.codex/hooks.json` と `~/.codex/config.toml` は、リポジトリの外にあり、開発者のすべてのセッションに効きます。変更する前に、追加する内容(差分)を開発者に示し、確認を得てから書き込んでください。agent-cockpit はこれらを自動では変更しません。
- 既存の設定は消さずに統合します。同じイベントの配列がすでにあるときは、その配列へ要素を足します。
- 連携ツール(GitHub CLI、claude-codex-bridge、ai-cross-review)そのものの導入手順は、この文書では扱いません。導入されていなければ、各ツールのドキュメントへ案内してください。この文書は、連携ツールが導入済みのときに agent-cockpit 側で必要な設定だけを書いています。
- 手順の中の `D:/path/to/agent-cockpit` は、このリポジトリを置いた絶対パスに置き換えます。worktree ではなく、残しておく本体のチェックアウトを指してください。worktree を消すと、フックの参照先が無くなります。
- この文書の `~/.claude` は Claude のホームを指します。`CLAUDE_CONFIG_DIR` を設定しているときは、そのディレクトリの `settings.json` と `skills/` を使ってください。
- 設定を変えた後は、新しく開いたセッションから効きます。実行中のセッションは、後から足したフックや MCP サーバーを読み込みません。

## パターンの選び方

まず「パターン A: agent-cockpit だけ」を行います。そのうえで、導入済みの連携ツールに合わせて B〜E を足します。B〜E は互いに独立していて、いくつでも組み合わせられます。

| パターン | 対象 | 導入済みかの確かめ方 |
|---|---|---|
| A | agent-cockpit だけ | — |
| B | + GitHub CLI | `gh --version` が通る |
| C | + claude-codex-bridge | Claude のホーム(`CLAUDE_CONFIG_DIR`、無ければ `~/.claude`)か `~/.claude` に `tools/codex-agent.sh` がある |
| D | + ai-cross-review | 対象のリポジトリの worktree のルートに `tools/cross-review.js` がある(リポジトリごとに導入するツールです) |
| E | + Codex(CLI、デスクトップ) | `codex --version` が通る |

D の PR カードの表示は、B の PR の表示に加わるものです。D で PR のクロスレビュー状態を見たいときは、B も行ってください。

### 3 つのツールをまとめて導入するとき

agent-cockpit、[claude-codex-bridge](https://github.com/ktysne/claude-codex-bridge)、[ai-cross-review](https://github.com/ktysne/ai-cross-review) をまとめて入れるときは、次の順に進めます。
どのツールも、ほかのツールの有無を実行時に調べるので、順番を変えても動きます。この順にすると、各ツールの連携の確認を、導入した時点でそのまま行えます。

1. claude-codex-bridge を、そのドキュメントに従って導入します。ai-cross-review と連携するなら、`codex-review` と `codex-subagent` を配置するパターン(bridge のパターン 2 か 3)を選びます。
2. この文書のパターン A、B、C を行います。
3. レビューを回すリポジトリごとに、ai-cross-review をそのドキュメントに従って導入します(ai-cross-review のパターン A〜D)。
4. この文書のパターン D を行います。
5. Codex のセッションも画面に出すなら、この文書のパターン E を行います。フックと MCP サーバーは通常の Codex のホームにだけ入れ、bridge が実装の委譲に使う Codex のホームには入れません(パターン E の前提)。

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

次の `hooks` を `~/.claude/settings.json` に統合し、`D:/path/to/agent-cockpit` を置き換えます。
実行ファイルと引数を分ける exec 形式(`command` と `args`)で書きます。Windows ではフックのコマンドが PowerShell で解釈され、引用符付きの実行ファイルのパスが失敗するためです。

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"] }] },
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/away.js"], "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] },
      { "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/away.js"], "timeout": 1830 }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "PostToolUseFailure": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "PostToolBatch": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/answer.js"], "timeout": 2 }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] },
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/answer.js"], "asyncRewake": true, "timeout": 3600 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/event.js"], "async": true }] },
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/away.js"], "timeout": 5 }] },
      { "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/answer.js"], "timeout": 5 }] }
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
      { "matcher": "", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/route.js"], "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/route.js"], "timeout": 5 }] }
    ]
  }
}
```

`route.js` は同期フックです。`SubagentStart` で、その時点の経路を `AGENT_COCKPIT_HOME` の `route-agents/` に記録し、Codex か Claude を選んでいればサブエージェントへ伝えます。Claude を選んだサブエージェントが `codex-agent.sh` を呼ぶと、`PreToolUse` で止めます。
経路は起動時に決まり、稼働中のサブエージェントは設定を変えても切り替わりません。
経路の設定が効くのは、Claude のセッションが起動するサブエージェントだけです。Codex のセッション(パターン E)のサブエージェントには効かないので、Codex のフックに `route.js` は登録しません。
経路を Claude にしたとき、bridge の窓口(`impl-hard`、`impl-light`、`impl-standard`)は自分では実装しないので、`codex-agent.sh` の実行を拒否されると `再委譲: impl-*-claude` を報告します。メインセッションは bridge の手順に従って、報告された `impl-*-claude` へ委譲し直します。`codex-review` と `codex-subagent` は、拒否の文言を報告して止まります。定義側での明文化と実機での確認は [ktysne/claude-codex-bridge#129](https://github.com/ktysne/claude-codex-bridge/issues/129) で進めています。
bridge を外したときは、`codex-agent.sh` が無いので `route.js` は何も差し込みません。登録は残したままで構いません。

### 確認

1. 新しいセッションを開き、ダッシュボードを再読み込みします。上部の「経路の設定」に、サブエージェントの段(既定、Codex、Claude)が出れば、bridge が検出されています。出ないときは、`codex-agent.sh` が `~/.claude/tools/` か `CLAUDE_CONFIG_DIR` の `tools/` にあるかを確かめます。
2. 経路を「Claude」にしてから、セッションでサブエージェントを起動させます。サブエージェントが動いている間に、その行に「経路: Claude」の札が出て、`AGENT_COCKPIT_HOME`(既定は `~/.agent-cockpit`)の `route-agents/` に記録のファイルができれば成功です。bridge の窓口(`impl-light` など)を起動したときは、窓口が `再委譲: impl-light-claude` と、`開発者の指定(agent-cockpit の経路設定):` で始まる拒否の文言を報告するのが期待される動きです。違う報告になったときは [ktysne/claude-codex-bridge#129](https://github.com/ktysne/claude-codex-bridge/issues/129) を見てください。
3. 確かめ終わったら、経路を元の値に戻します。

## パターン D: + ai-cross-review

### 前提

[ai-cross-review](https://github.com/ktysne/ai-cross-review) を、そのドキュメントに従って、レビューを回すリポジトリへ導入しておきます。ai-cross-review はリポジトリごとに入れるツールです。agent-cockpit は、稼働中のセッション(Claude は `~/.claude/sessions/*.json`、Codex はフックで届いたセッション)の作業ディレクトリと、PR を登録したセッションの作業ディレクトリについて、その worktree のルートに `tools/cross-review.js` があるかで判断します。

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

## パターン E: + Codex

Codex(CLI とデスクトップ)のセッションも、Claude のセッションと同じダッシュボードに出します。
判断事項への回答、離席中の推奨の適用、PR の登録は、Claude と同じ仕様で動きます。
画面では、Claude 起点の情報を橙、Codex 起点の情報を青紫の色帯で見分けます。

### 前提

- パターン A を終えていること。常駐サーバー、保存先、ポートは Claude と共通です。
- [Codex](https://github.com/openai/codex) を導入し、ログインしておきます。
- `~/.codex` は Codex のホームを指します。`CODEX_HOME` を設定しているときは、そのディレクトリを使ってください。常駐サーバーも `CODEX_HOME` から会話の名前と終わりを読むので、`AGENT_COCKPIT_HOME` と同じく、Claude Code と Codex の両方を起動する環境(ユーザーの環境変数など)に設定します。
- フックと MCP サーバーは、普段使う Codex のホームにだけ入れます。claude-codex-bridge が実装の委譲に使う Codex のホーム(`~/.codex-subagent` など、bridge の定義の `codex_home`)には入れません。入れると、委譲した Codex が親の Claude のセッションの行と、独立した Codex のセッションの行の両方に出ます。
- `~/.codex` の `hooks.json` と `config.toml` も、開発者のすべての Codex のセッションに効きます。パターン A と同じく、差分を開発者に示して確認を得てから書き込み、既存の設定は消さずに統合します。

### 1. フックを登録する

次の内容を `~/.codex/hooks.json` に統合し、`D:/path/to/agent-cockpit` を置き換えます。
どのフックも、最後の引数 `codex` で Codex のイベントであることを伝えます。この引数を省くと Claude のイベントとして扱われます。

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/event.js\" codex" }] },
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/away.js\" codex", "timeout": 5 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/event.js\" codex" }] },
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/away.js\" codex", "timeout": 5 }] },
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/answer.js\" codex", "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/event.js\" codex" }] },
      { "matcher": "request_user_input_async|request_user_input", "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/away.js\" codex", "timeout": 1830 }] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/event.js\" codex" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/event.js\" codex" }] },
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/answer.js\" codex", "timeout": 2 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/event.js\" codex" }] },
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/answer.js\" codex", "timeout": 3600 }] }
    ],
    "Interrupt": [
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/event.js\" codex" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/event.js\" codex" }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/event.js\" codex" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/event.js\" codex" }] }
    ]
  }
}
```

Claude の登録との違いと、timeout の値の理由は次のとおりです。値を変えずに登録してください。

- Codex のフックには `async` を付けません。非同期のフックは、短い実行で 1 件も届かないことがあるためです。
- `SessionStart` の `event.js` は、Claude と同じく常駐サーバーが動いていなければ起動し、ダッシュボードの URL を `additionalContext` でセッションへ渡します。Codex 本体のプロセス ID を調べるので、ほかのフックより時間がかかることがあります。timeout は付けずに Codex の既定に任せます。
- `SessionStart` と `UserPromptSubmit` の `away.js` は、タスクの登録を促す文と、離席中の指示を `additionalContext` で渡します。agent-cockpit のスキルは Claude 向けの内容なので、Codex には置きません。
- `PreToolUse` の `away.js` は、Codex の質問ツール(`request_user_input_async` と `request_user_input`)だけを対象に、離席中にダッシュボードの回答を待ちます。timeout は Claude と同じ 1830 秒です。
- Codex には `PostToolBatch` が無いので、`PostToolUse` の `answer.js`(timeout 2 秒)で、作業中のセッションへ回答を差し込みます。
- `Stop` の `answer.js` は、ターンの終わりに未配信の回答があれば続行させます。離席中は回答や通知を最大 59 分待ってから続行させます。そのあいだ Codex の画面は作業中の表示になり、`Esc` で中断できます。timeout はこの待ちに余裕を足した 3600 秒です。

### 2. MCP サーバーを登録する

次の内容を `~/.codex/config.toml` に足し、パスを置き換えます。Claude と同じ `src/mcp/server.js` を使います。

```toml
[mcp_servers.agent-cockpit]
command = "node"
args = ["D:/path/to/agent-cockpit/src/mcp/server.js"]

[mcp_servers.agent-cockpit.tools.cockpit_set_tasks]
approval_mode = "approve"

[mcp_servers.agent-cockpit.tools.cockpit_add_decision]
approval_mode = "approve"

[mcp_servers.agent-cockpit.tools.cockpit_update_decision]
approval_mode = "approve"

[mcp_servers.agent-cockpit.tools.cockpit_add_pr]
approval_mode = "approve"

[mcp_servers.agent-cockpit.tools.cockpit_skip_review]
approval_mode = "approve"
```

各ツールの `approval_mode = "approve"` は、呼び出しのたびに許可を求めないための設定です。
許可を求める設定のままだと、離席中にタスクや判断事項の記録が許可待ちで止まります。
どのツールも、ダッシュボードにタスク、判断事項、PR を記録するだけで、ファイルやコマンドには触れません。

### 3. フックを信頼する

Codex は、開発者が信頼するまで新しいフックを動かしません。
Codex CLI を起動して `/hooks` を開き、1 で足したフックを信頼してください。
信頼の記録は `~/.codex/config.toml` の `[hooks.state]` に残り、同じ Codex のホームを使う CLI とデスクトップで共通です。
`hooks.json` を変えたときは、変えたフックを信頼し直します。

### 確認

1. 新しい Codex のセッションを開き、ダッシュボードを再読み込みします。そのセッションの行が、左端に青紫の色帯を付けて出れば成功です。出ないときは、`/hooks` で信頼したかと、フックのパスと引数 `codex` を確かめます。
2. `codex mcp list` を実行し、`agent-cockpit` の行の状態が `enabled` であることを確かめます。
3. Codex のセッションで「`cockpit_set_tasks` で確認用のタスクを 1 件登録して」と依頼します。そのセッションの欄にタスクが出れば、MCP サーバーとフックが同じセッションを指しています。「Codex のフックが届いていないため記録できなかった。」と返るときは、フックを信頼する前から開いていた会話か、フックが動いていません。1 を確かめてから、新しい会話で試します。
4. 回答の経路を確かめるときは、画面上部の「離席中」をオンにしてから、Codex のセッションに「確認のために `request_user_input_async` で質問して」と依頼します。待つ形の `request_user_input` は Plan モードでだけ使えます。ダッシュボードに判断待ちとして出て、画面から回答するとセッションがその回答で進めば成功です。確かめ終わったら「離席中」をオフに戻します。
5. パターン B も行っているときは、Codex のセッションで作った PR が、青紫の色帯を付けて PR の欄に出ることを確かめます。

## 更新するとき

導入済みの agent-cockpit を新しい版にするときは、次の順に進めます。

1. 本体のチェックアウトで `git pull` を実行します。
2. この文書のフックと MCP サーバーの登録を、登録済みの内容と見比べます。足りないイベントや、timeout の値の違いがあれば、パターン A の決まりどおり差分を示して確認を得てから直します。パターン E を行っているときは `~/.codex/hooks.json` と `~/.codex/config.toml` も見比べ、`hooks.json` を変えたら `/hooks` で信頼し直します。
3. `skills/agent-cockpit/SKILL.md` が変わっていれば、パターン A の 4 と同じ手順でコピーし直します。
4. 常駐サーバーを再起動します。動いている常駐サーバーは起動したときのコードのままで、`git pull` では入れ替わりません。タスクトレイを使っているときは、メニューの「常駐サーバーを再起動」を選びます。使っていないときは、`AGENT_COCKPIT_HOME`(既定は `~/.agent-cockpit`)の `server.json` の `pid` のプロセスが、`src/server/server.js` を動かしている `node` であることを確かめてから終了します。次にセッションを開くと、フックが新しいコードで起動します。
5. 新しいセッションを開き、パターン A の「確認」の 2〜4 を行います。パターン E を行っているときは、パターン E の「確認」の 1 と 2 も行います。

Codex 対応より前の版から更新したときは、Codex のセッションも画面に出すなら、更新の後にパターン E を行います。

## うまくいかないとき

- 画面にセッションが出ない:フックの登録後に開いたセッションかを確かめます。`~/.claude/settings.json` の JSON が壊れていないか、パスが本体のチェックアウトを指しているかを確かめます。
- Codex のセッションが画面に出ない:`/hooks` でフックを信頼したか、`~/.codex/hooks.json` の JSON が壊れていないか、コマンドの最後に引数 `codex` があるかを確かめます。
- 常駐サーバーのログは `AGENT_COCKPIT_HOME`(既定は `~/.agent-cockpit`)の `server.log` にあります。
- 常駐サーバーを手で起動するときは、リポジトリのルートで `npm start` を実行します。終了は `Ctrl+C` です。
- `~/.claude/sessions/*.json` は Claude Code の公開仕様ではありません。読めない版でも、フックから組み立てた表示は動きます。ただし、パターン D のクロスレビューの段は、そのリポジトリの PR を登録するか、そのリポジトリで Codex のセッションを開くまで出ません。
