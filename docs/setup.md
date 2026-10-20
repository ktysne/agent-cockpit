# agent-cockpit の導入手順

この文書は、agent-cockpit を導入する AI(Claude Code など)が読む手順書です。人が読んで手で進めることもできます。

## 進め方の決まり

- `~/.claude/settings.json`、MCP サーバーの登録、`~/.claude/skills/`、Codex の `~/.codex/hooks.json`、`~/.codex/config.toml`、`~/.agents/skills/` は、リポジトリの外にあり、開発者のすべてのセッションに効きます。変更する前に、追加する内容(差分)を開発者に示し、確認を得てから書き込んでください。agent-cockpit はこれらを自動では変更しません。
- 既存の設定は消さずに統合します。同じイベントの配列がすでにあるときは、その配列へ要素を足します。
- claude-codex-bridge と ai-cross-review は、最初に「始める前に: 連携ツールの確認」で導入済みかを確かめ、導入されていなければ開発者に導入するかを尋ねます。導入するときは、各ツールの手順書に従います。GitHub CLI と Codex は、導入されていなければ各ツールのドキュメントへ案内してください。この文書の各パターンは、連携ツールが導入済みのときに agent-cockpit 側で必要な設定だけを書いています。
- 手順の中の `D:/path/to/agent-cockpit` は、このリポジトリを置いた絶対パスに置き換えます。worktree ではなく、残しておく本体のチェックアウトを指してください。worktree を消すと、フックの参照先が無くなります。
- この文書の `~/.claude` は Claude のホームを指します。`CLAUDE_CONFIG_DIR` を設定しているときは、そのディレクトリの `settings.json` と `skills/` を使ってください。
- 設定を変えた後は、新しく開いたセッションから効きます。実行中のセッションは、後から足したフックや MCP サーバーを読み込みません。

## 始める前に: 連携ツールの確認

パターン A に進む前に、[claude-codex-bridge](https://github.com/ktysne/claude-codex-bridge) と [ai-cross-review](https://github.com/ktysne/ai-cross-review) が導入済みかを確かめます。
どちらも agent-cockpit と組み合わせて使う前提で作ったツールで、両方を入れると、経路の設定とクロスレビューを待ったマージを含めて、agent-cockpit の機能をすべて使えます。
導入されていないツールがあれば、開発者に概要を説明し、導入するかを尋ねます。
導入しないと答えたツールは、対応するパターン(C か D)を飛ばします。agent-cockpit は単独でも動き、連携ツールを後から入れても表示に反映されます。

### 1. 導入済みかを確かめる

- claude-codex-bridge:「パターンの選び方」の表の C の方法で確かめます。
- ai-cross-review:リポジトリごとに入れるツールです。開発者に、agent-cockpit で見ながら作業するリポジトリを尋ね、それぞれの worktree のルートに `tools/cross-review.js` があるかを確かめます。このセッションの作業ディレクトリが git のリポジトリなら、それも候補に含めます。

Codex だけで使うときは、claude-codex-bridge を確かめません。bridge は Claude Code のサブエージェントから Codex を呼ぶためのツールで、Claude Code が無い環境では使わないためです。

### 2. 導入されていないツールを説明して、導入するかを尋ねる

導入されていないツールについて、次の表の内容を開発者に説明します。
要約してかまいませんが、何をするツールか、agent-cockpit と組み合わせるとできること、入れなくても agent-cockpit は使えることの 3 点は落とさないでください。
尋ねるときは、選択肢を出せる道具(Claude Code の `AskUserQuestion`、Codex の `request_user_input`)があれば使います。

| ツール | 何をするツールか | agent-cockpit と組み合わせるとできること | 要るもの |
|---|---|---|---|
| claude-codex-bridge | Claude Code のメインセッションが設計と監査を受け持ち、実装やレビューを Codex CLI のサブエージェントに任せるための定義一式。モデル、effort、使う Codex のアカウントを定義ファイルで固定する | サブエージェントを Codex と Claude のどちらで動かすかを、画面の「経路の設定」で切り替えられる。サブエージェントの行に、経路と Codex のモデルが出る | Claude Code、Codex CLI、Codex を使える OpenAI のアカウント |
| ai-cross-review | Claude と Codex に、git の差分で交互にコードレビューさせる CLI。往復の回数と結論をブランチごとに記録し、PR コメントの本文を作る。リポジトリごとに入れる | PR のカードに、クロスレビューの往復と結論が出る。レビューの収束を待ってからマージする予約ができる。レビュアーを画面の「経路の設定」で選べる | Node.js 20 以上、レビュアーにする `codex` か `claude` の CLI |

2 つを両方入れると、ai-cross-review が Codex でレビューするときも、bridge の定義のモデル、effort、アカウントで動きます。

### 3. claude-codex-bridge の導入パターンを確かめる

bridge を導入すると答えたら、Codex のアカウントの使い方でパターンを選んでもらいます。
パターンの正本は、bridge の手順書の[「パターンの選び方」](https://github.com/ktysne/claude-codex-bridge/blob/main/docs/setup.md#パターンの選び方)です。要約は次のとおりです。

| パターン | 使い方 | 向いている使い方 |
|---|---|---|
| 1 | 1 アカウントで、実装の委譲だけを Codex に任せる | レビューを Codex に頼まない |
| 2 | 1 アカウントで、実装の委譲に加えて、レビューや調査も Codex に頼む | ai-cross-review も使い、Codex のアカウントは 1 つ |
| 3 | 2 アカウントで、通常利用とレビューを `~/.codex` に、サブエージェントを `~/.codex-subagent` に分ける | ai-cross-review も使い、Codex のアカウントを 2 つ持っていて、役割で分けたい |

ai-cross-review も導入するなら、2 か 3 を勧めます。パターン 1 には `codex-review` と `codex-subagent` の定義が無く、ai-cross-review が bridge を経由せずに `codex` を直接起動するためです。
2 つのアカウントは役割を分けるためだけに使います。利用上限に達したら別のアカウントへ回す使い方は、OpenAI の利用規約に抵触する恐れがあるので勧めません。

### 4. 導入すると答えたツールを入れる

順番は「3 つのツールをまとめて導入するとき」に従います。

- claude-codex-bridge:[bridge の手順書](https://raw.githubusercontent.com/ktysne/claude-codex-bridge/main/docs/setup.md)に従って、選んだパターンで導入します。`codex login` はブラウザーでアカウントを選ぶ操作なので、開発者に行ってもらいます。
- ai-cross-review:導入先のリポジトリのファイル(`package.json` など)を変えるので、リポジトリごとに開発者の確認を得てから、[ai-cross-review の手順書](https://raw.githubusercontent.com/ktysne/ai-cross-review/main/docs/setup.md)に従って導入します。後で入れると答えたリポジトリには、そのリポジトリを開いたセッションで使う次の依頼文を伝えます。

  > このリポジトリに ai-cross-review を導入して。手順は https://raw.githubusercontent.com/ktysne/ai-cross-review/main/docs/setup.md にある。

## パターンの選び方

まず「パターン A: agent-cockpit だけ」を行います。そのうえで、導入済みの連携ツールに合わせて B〜E を足します。B〜E は互いに独立していて、いくつでも組み合わせられます。
Claude Code を使わず、Codex だけで使うときは、下の「Codex だけで使うとき」に従います。

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

### Codex だけで使うとき

Claude Code が入っていない環境では、パターン A の Claude Code 向けの手順を飛ばし、パターン E で Codex をつなぎます。
常駐サーバーは Codex のフックからも起動するので、Claude Code が無くても動きます。

1. パターン A の前提のうち、Node.js 22 以上だけを満たします。Claude Code は要りません。
2. パターン A の 1(リポジトリを置く)を行います。2〜4(Claude Code のフック、MCP サーバー、スキル)は飛ばします。5 と 6 は、必要なら行います。
3. パターン E を行います。パターン E の前提の「パターン A を終えていること」は、この 2 で満たしたものとします。
4. パターン E の「確認」を行います。あわせて、パターン A の「確認」の 2 と 3 を、Claude Code のセッションの代わりに Codex のセッションで行います。

パターン B と D も、Codex だけで使えます。パターン C は Claude のサブエージェントの経路を切り替えるものなので、Codex だけの環境では対象になりません。

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
- 単発の `claude -p` を起動するツールは、その子プロセスの環境にだけ `AGENT_COCKPIT_NONINTERACTIVE=1` を渡します。Stop で待ち続けず結果を回収するための指定で、契約は[「Claude の単発実行」](design/server.md#claude-の単発実行)にあります。
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
あわせて、agent-cockpit、ai-cross-review、claude-codex-bridge の checkout と写しを GitHub の最新と見比べて更新するスキルを、`~/.claude/skills/update-tools/` にコピーします。

PowerShell:

```powershell
foreach ($name in 'agent-cockpit', 'update-tools') {
  $skillDirectory = Join-Path $env:USERPROFILE ".claude\skills\$name"
  New-Item -ItemType Directory -Path $skillDirectory -Force | Out-Null
  Copy-Item ".\skills\$name\SKILL.md" (Join-Path $skillDirectory 'SKILL.md') -Force
}
```

bash:

```bash
for name in agent-cockpit update-tools; do
  mkdir -p ~/.claude/skills/$name
  cp skills/$name/SKILL.md ~/.claude/skills/$name/SKILL.md
done
```

リポジトリを更新してスキルが変わったときは、コピーし直します。
本体の更新から再起動までの手順は [更新手順](update.md) にあります。

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
フック、MCP サーバー、常駐サーバーは同じ値を読む必要があるので、Claude Code と Codex を起動する環境(ユーザーの環境変数など)に設定してください。

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
6. `~/.claude/skills/agent-cockpit/SKILL.md` と `~/.claude/skills/update-tools/SKILL.md` があることを確かめます。
7. 回答の経路を確かめるときは、画面上部の「離席中」をオンにしてから、セッションに「確認のために `AskUserQuestion` で質問して」と依頼します。ダッシュボードに判断待ちとして出て、画面から回答するとセッションがその回答で進めば成功です。確かめ終わったら「離席中」をオフに戻します。離席中でないときは、質問はデスクトップアプリのダイアログに出ます。

設定の不一致を調べるときは、この checkout のルートで `node src/client/doctor.js` を実行します。
`--json` を付けると JSON を出力し、不一致があれば終了コード `1` を返します。
診断は MCP からの書き込みと質問への回答の往復を確かめないため、上の 5 と 7 も実行してください。
設定を直した後は、その後に開いたセッションだけが新しい内容で動きます。

導入できたら、画面の使い方を利用者向けマニュアル(https://ktysne.info/agent-cockpit/manual/)で確かめます。ダッシュボードの設定画面の「マニュアル」からも開けます。

## パターン B: + GitHub CLI

### 前提

GitHub CLI を導入し、`gh auth login` でログインしておきます。導入とログインは [GitHub CLI のドキュメント](https://cli.github.com/manual/) に従ってください。

### agent-cockpit 側の設定

agent-cockpit 側で追加する設定はありません。次の 2 点だけ確かめます。

- 常駐サーバーは、自分を起動したプロセス(フックを実行した Claude Code か Codex、またはタスクトレイ)の `PATH` から `gh` を探します。Claude Code と Codex を起動する環境で `gh` が見つかるようにしてください。
- 常駐サーバーは `gh` を呼ぶときに、環境変数 `GH_TOKEN`、`GITHUB_TOKEN`、`GH_ENTERPRISE_TOKEN` を外します。セッションの環境に入ったトークンで GitHub を操作しないためです。そのため、`gh auth login` で保存した認証情報が必要です。

PR は、セッションが Bash または PowerShell ツールで `gh pr create` を実行したときに自動で登録されます。ほかの方法で作った PR は、セッションから MCP ツール `cockpit_add_pr` に URL を渡して登録します。

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

画面の「経路の設定」で選んだ経路を、bridge の窓口と `codex-review` へ伝えるフック `route.js` を登録します。
次の内容を `~/.claude/settings.json` の `hooks` に統合します。パターン A で登録した `SubagentStart` と `PreToolUse` の配列へ、要素を足してください。

```json
{
  "hooks": {
    "SubagentStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/route.js"], "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash|PowerShell", "hooks": [{ "type": "command", "command": "node", "args": ["D:/path/to/agent-cockpit/src/hooks/route.js"], "timeout": 5 }] }
    ]
  }
}
```

`route.js` は同期フックです。`impl-hard`、`impl-standard`、`impl-light`、`codex-subagent` の開始時は「サブエージェント」の経路を、`codex-review` の開始時は「クロスレビュー」の経路を `AGENT_COCKPIT_HOME` の `route-agents/` に記録します。
経路が「Codex」か「Claude」なら対象の窓口へ伝え、「既定」なら記録だけを行います。
既定で始めたサブエージェントは、設定を後から変えて再開しても、Codex の起動や待機を拒否されません。
Claude の経路を記録した窓口が `codex-agent.sh` を呼ぶと、`PreToolUse` で止めます。
経路は起動時に決まり、稼働中のサブエージェントは設定を変えても切り替わりません。
経路の設定が効くのは、Claude のセッションが起動する bridge の窓口だけです。`codex-review` はクロスレビューの経路に従います。Codex のセッション(パターン E)のサブエージェントには効かないので、Codex のフックに `route.js` は登録しません。
サブエージェントの経路を Claude にしたとき、bridge の実装窓口は `codex-agent.sh` の実行を拒否されると `再委譲: impl-*-claude` を報告します。メインセッションは bridge の手順に従って、報告された `impl-*-claude` へ委譲し直します。
`codex-review` はクロスレビューの経路を Claude にしたときだけ拒否の文言を受けます。Codex を選んでいれば Codex の起動は拒否されません。
定義側での明文化と実機での確認は [ktysne/claude-codex-bridge#129](https://github.com/ktysne/claude-codex-bridge/issues/129) で進めています。
bridge を外したときは、`codex-agent.sh` が無いので `route.js` は何も差し込みません。登録は残したままで構いません。

### 確認

1. 新しいセッションを開き、ダッシュボードを再読み込みします。上部の「経路の設定」に、サブエージェントの段(既定、Codex、Claude)が出れば、bridge が検出されています。出ないときは、`codex-agent.sh` が `~/.claude/tools/` か `CLAUDE_CONFIG_DIR` の `tools/` にあるかを確かめます。
2. 「サブエージェント」の経路を「Claude」にしてから、セッションで bridge の窓口を起動させます。窓口が動いている間に、その行に「経路: Claude」の札が出て、`AGENT_COCKPIT_HOME`(既定は `~/.agent-cockpit`)の `route-agents/` に記録のファイルができれば成功です。窓口(`impl-light` など)は `再委譲: impl-light-claude` と、`開発者の指定(agent-cockpit の経路設定):` で始まる拒否の文言を報告します。`codex-review` は「クロスレビュー」の経路に従います。違う報告になったときは [ktysne/claude-codex-bridge#129](https://github.com/ktysne/claude-codex-bridge/issues/129) を見てください。
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
2. クロスレビューの段で「Codex」を選び、そのリポジトリで次を実行します。`codex` が返れば成功です。確かめ終わったら、元の値に戻します。`route` を使えない古いバージョンのときは、ai-cross-review の導入手順の[「更新するとき」](https://github.com/ktysne/ai-cross-review/blob/main/docs/setup.md#更新するとき)に従って更新します。

   ```bash
   node tools/cross-review.js route
   ```

3. パターン B も行っているときは、そのリポジトリの PR のカードに「クロスレビュー」の段が出ることを確かめます。レビューを回す前は「レビュー未実施」と出て、往復を回すと往復数と結論が出ます。ai-cross-review を入れていないリポジトリの PR は「レビュー不要」と出ます。

## パターン E: + Codex

Codex(CLI とデスクトップ)のセッションも、Claude のセッションと同じダッシュボードに出します。
判断事項への回答、離席中の推奨の適用、PR の登録は、Claude と同じ仕様で動きます。
画面では、Claude 起点の情報を橙、Codex 起点の情報を青紫の色帯で見分けます。

### 前提

- パターン A を終えていること。Codex だけで使うときは、「Codex だけで使うとき」の 1 と 2 を終えていること。常駐サーバー、保存先、ポートは Claude と共通です。
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
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/answer.js\" codex", "timeout": 5 }] }
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
- `SessionStart` と `UserPromptSubmit` の `away.js` は、タスクの登録を促す文と、離席中の指示を `additionalContext` で渡します。判断事項の記録やレビュー不要の記録の使い方は、3 で置くスキルが伝えます。
- `PreToolUse` の `away.js` は、Codex の質問ツール(`request_user_input_async` と `request_user_input`)だけを対象に、離席中にダッシュボードの回答を待ちます。timeout は Claude と同じ 1830 秒です。
- Codex には `PostToolBatch` が無いので、`PostToolUse` の `answer.js`(timeout 5 秒)で、作業中のセッションへ回答を差し込みます。Windows では pwsh 経由の起動に約 0.5 秒かかります。フックが早く終われば、timeout は待ち時間になりません。
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

[mcp_servers.agent-cockpit.tools.cockpit_defer_review]
approval_mode = "approve"
```

各ツールの `approval_mode = "approve"` は、呼び出しのたびに許可を求めないための設定です。
許可を求める設定のままだと、離席中にタスクや判断事項の記録が許可待ちで止まります。
どのツールも、ダッシュボードにタスク、判断事項、PR を記録するだけで、ファイルやコマンドには触れません。

### 3. スキルを置く

Codex のメインセッションが MCP ツールの使い方を読むスキルを、`~/.agents/skills/agent-cockpit/` にコピーします。
Claude 向けの `skills/agent-cockpit/` ではなく、質問ツールの扱いを Codex に合わせた `skills/codex/agent-cockpit/` を使います。
更新のスキル(`skills/update-tools/`)は Claude と共通なので、同じものを `~/.agents/skills/update-tools/` にコピーします。リポジトリのルートで実行します。

PowerShell:

```powershell
$agentsHome = Join-Path $env:USERPROFILE '.agents'
$skillDirectory = Join-Path $agentsHome 'skills\agent-cockpit'
New-Item -ItemType Directory -Path $skillDirectory -Force | Out-Null
Copy-Item .\skills\codex\agent-cockpit\SKILL.md (Join-Path $skillDirectory 'SKILL.md') -Force
$updateSkillDirectory = Join-Path $agentsHome 'skills\update-tools'
New-Item -ItemType Directory -Path $updateSkillDirectory -Force | Out-Null
Copy-Item .\skills\update-tools\SKILL.md (Join-Path $updateSkillDirectory 'SKILL.md') -Force
```

bash:

```bash
mkdir -p "$HOME/.agents/skills/agent-cockpit" "$HOME/.agents/skills/update-tools"
cp skills/codex/agent-cockpit/SKILL.md "$HOME/.agents/skills/agent-cockpit/SKILL.md"
cp skills/update-tools/SKILL.md "$HOME/.agents/skills/update-tools/SKILL.md"
```

古い置き場(`$CODEX_HOME/skills/agent-cockpit/`、`$CODEX_HOME/skills/update-tools/`、既定では `~/.codex/skills/` の下)に写しがあれば、その写しのフォルダーを消してください。
ただし、`~/.codex/skills` を `~/.agents/skills` へのジャンクションやシンボリックリンクにしているときは、古い置き場と新しい置き場が同じフォルダーなので、消さないでください。消すと、配ったばかりのスキルも消えます。

リポジトリを更新してスキルが変わったときは、コピーし直します。

### 4. フックを信頼する

Codex は、開発者が信頼するまで新しいフックを動かしません。
Codex CLI を起動して `/hooks` を開き、1 で足したフックを信頼してください。
信頼の記録は `~/.codex/config.toml` の `[hooks.state]` に残り、同じ Codex のホームを使う CLI とデスクトップで共通です。
`hooks.json` を変えたときは、変えたフックを信頼し直します。

### 確認

1. 新しい Codex のセッションを開き、ダッシュボードを再読み込みします。そのセッションの行が、左端に青紫の色帯を付けて出れば成功です。出ないときは、`/hooks` で信頼したかと、フックのパスと引数 `codex` を確かめます。
2. `codex mcp list` を実行し、`agent-cockpit` の行の状態が `enabled` であることを確かめます。あわせて、`~/.agents/skills/agent-cockpit/SKILL.md` があることを確かめます。
3. Codex のセッションで「`cockpit_set_tasks` で確認用のタスクを 1 件登録して」と依頼します。そのセッションの欄にタスクが出れば、MCP サーバーとフックが同じセッションを指しています。「Codex のフックが届いていないため記録できなかった。」と返るときは、フックを信頼する前から開いていた会話か、フックが動いていません。1 を確かめてから、新しい会話で試します。
4. 回答の経路を確かめるときは、画面上部の「離席中」をオンにしてから、Codex のセッションに「確認のために `request_user_input_async` で質問して」と依頼します。待つ形の `request_user_input` は Plan モードでだけ使えます。ダッシュボードに判断待ちとして出て、画面から回答するとセッションがその回答で進めば成功です。確かめ終わったら「離席中」をオフに戻します。
5. パターン B も行っているときは、Codex のセッションで作った PR が、青紫の色帯を付けて PR の欄に出ることを確かめます。

設定の不一致を調べるときは、この checkout のルートで `node src/client/doctor.js` を実行します。
`--json` を付けると JSON を出力し、不一致があれば終了コード `1` を返します。
診断は MCP からの書き込みと質問への回答の往復を確かめないため、上の 3 と 4 も実行してください。
設定を直した後は、その後に開いたセッションだけが新しい内容で動きます。

## 更新するとき

導入済みの agent-cockpit を新しいバージョンにするときは、[更新手順](update.md)に従います。
タグへの更新、フックと MCP サーバーの登録の見比べ、スキルのコピー、`node src/client/restart-server.js` による常駐サーバーの再起動とバージョンおよびコミットの照合までを扱います。
起動後のバージョンまたはコミットがこのチェックアウトの期待値と違う場合は失敗します。
期待のコミットを取得できない場合は、コミットが未照合であることを出力します。
動いている常駐サーバーは起動したときのコードのままなので、更新の後は必ず再起動します。

再起動の後は、新しいセッションを開き、パターン A の「確認」の 2〜4 を行います。パターン E を行っているときは、パターン E の「確認」の 1 と 2 も行います。Codex だけで使うときは、パターン A の「確認」の 2 と 3 を Codex のセッションで行い、パターン E の「確認」の 1 と 2 を行います。

Codex 対応より前のバージョンから更新したときは、Codex のセッションも画面に出すなら、更新の後にパターン E を行います。

## うまくいかないとき

- 画面にセッションが出ない:フックの登録後に開いたセッションかを確かめます。`~/.claude/settings.json` の JSON が壊れていないか、パスが本体のチェックアウトを指しているかを確かめます。
- Codex のセッションが画面に出ない:`/hooks` でフックを信頼したか、`~/.codex/hooks.json` の JSON が壊れていないか、コマンドの最後に引数 `codex` があるかを確かめます。
- 常駐サーバーのログは `AGENT_COCKPIT_HOME`(既定は `~/.agent-cockpit`)の `server.log` にあります。
- 常駐サーバーを手で起動するときは、リポジトリのルートで `npm start` を実行します。終了は `Ctrl+C` です。
- `~/.claude/sessions/*.json` は Claude Code の公開仕様ではありません。Claude Code のバージョンによって読めなくても、フックから組み立てた表示は動きます。ただし、パターン D のクロスレビューの段は、そのリポジトリの PR を登録するか、そのリポジトリで Codex のセッションを開くまで出ません。

### PR のレビューを省略または保留するとき

現在の head の記録が無い PR はカードに次の操作を表示し、Stop でも記録を促します。
古い head のレビューだけがある場合も対象です。
配信への ACK は、レビューの記録を完了したことにはなりません。
新しい入力の後か最後の配信から 30 分後の Stop で再び促し、同じセッションと head で 3 回までにします。
上限後も未記録の案内はカードに残ります。
省略するなら `cockpit_skip_review` に owner、repo、number、現在の head SHA(headRefOid)、理由(reason)を渡します。
保留するなら `cockpit_defer_review` に同じ項目と次の作業(next)を渡します。
登録したセッションからだけ記録でき、サーバーが最新の head を照合します。
ツールが成功を返したことを確かめてから完了報告してください。
失敗時はツールの応答に従い、未記録であることか、記録できたかを確かめられなかったことを、理由と一緒に完了報告に書いてください。
保留は理由と次の作業を表示し、レビューを条件にしたマージを待たせます。
不要記録と保留は後からの記録だけが有効で、head が変わると無効になります。
