# agent-cockpit の更新手順

利用者から指定された `vX.Y.Z` へ、本体のチェックアウトを更新する AI 向けの手順です。
以下のコマンドは、この手順書があるチェックアウトのルートで実行します。
設定済みの保存先やポートがある場合は、常駐サーバーと同じ環境変数を使います。

## 更新前の確認

チェックアウトの絶対パスが `.claude/worktrees/` の下なら、更新せずに止めて、本体のチェックアウトで依頼し直すよう利用者に伝えます。
まず、更新前のバージョンを `package.json` の `version` から読み、追加作業の判定のために覚えておきます。

```sh
git status --porcelain
git branch --show-current
git fetch origin
git rev-list --count origin/main..HEAD
```

未追跡ファイルを含めて変更が無いこと、ブランチが `main` であること、`origin/main` より先のコミットが 0 件であることを確かめます。
いずれかが違う場合やコマンドが失敗した場合は、更新せずに止めて利用者に尋ねます。
変更を消したり、ブランチを切り替えたり、ローカルのコミットを捨てたりして続けません。

更新前の常駐サーバーの `/health` を取得し、`version` と `commit` を控えます。
確認先は、保存先（既定は `~/.agent-cockpit`、`AGENT_COCKPIT_HOME` があればその場所）の `server.json` の `port` を使った `http://127.0.0.1:<port>/health` です。
取得できない場合は、そのことを控えます。

## タグへの更新

`vX.Y.Z` は利用者が指定した新しいバージョンに置き換えます。

```sh
git fetch --tags origin
git merge --ff-only vX.Y.Z
```

失敗したら止めて利用者に知らせます。
成功したら、この `docs/update.md` を必ず読み直し、新しいバージョンの手順に従って残りを進めます。
続いて、次を実行します。

```sh
git rev-parse HEAD
git rev-parse "vX.Y.Z^{commit}"
git ls-remote https://github.com/ktysne/agent-cockpit.git "refs/tags/vX.Y.Z^{}"
node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version"
```

`HEAD` と手元のタグの実体コミットが一致することを確かめます。
同じバージョン番号でも別のコミットなら、更新の完了にはしません。
配布元の `refs/tags/vX.Y.Z^{}` の実体コミットも、手元のタグの実体コミットと一致することを確かめます。
`origin` がフォークを指し、同名のタグが別のコミットを指している場合の取り違えを防ぐためです。
`package.json` の `version` が指定されたバージョン（先頭の `v` を除く）と一致することも確かめます。
いずれかが違う場合、配布元のタグを取得できない場合、コマンドが失敗した場合は、止めて利用者に知らせます。

## バージョンごとの追加作業

今はありません。
追加作業がある場合は、更新前のバージョンより新しく、更新先のバージョン以下の節だけを、バージョンの小さい順に実行します。
バージョンはピリオドで区切った 3 つの整数で比較します。
節の見出しは `### vX.Y.Z` の形で書きます。

## フックと MCP サーバーの登録の見比べ

[導入手順](setup.md)のフックと MCP サーバーの登録を、登録済みの内容と見比べます。
対象は、Claude Code の `~/.claude/settings.json` と `claude mcp list`、Codex を使っているときの `~/.codex/hooks.json` と `~/.codex/config.toml` です。
足りないイベントや、timeout の値の違いがあれば、差分を利用者に示して確認を取ってから直します。
Codex の `hooks.json` を変えたときは、利用者に Codex の `/hooks` で信頼し直すよう伝えます。

## スキルのコピー

[導入手順](setup.md#4-スキルを置く)と同じコマンドで、スキルをコピーし直します。
Claude Code を使っていない環境では、Claude Code のスキルは飛ばします。
リポジトリ外を書き換えるため、コピー先と内容を利用者に示して確認を取ります。

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

Codex を使っているときは、[導入手順](setup.md#3-スキルを置く)と同じコマンドで、Codex のスキルもコピーし直します。

PowerShell:

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$skillDirectory = Join-Path $codexHome 'skills\agent-cockpit'
New-Item -ItemType Directory -Path $skillDirectory -Force | Out-Null
Copy-Item .\skills\codex\agent-cockpit\SKILL.md (Join-Path $skillDirectory 'SKILL.md') -Force
```

bash:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills/agent-cockpit"
cp skills/codex/agent-cockpit/SKILL.md "${CODEX_HOME:-$HOME/.codex}/skills/agent-cockpit/SKILL.md"
```

## 常駐サーバーの再起動と確認

```sh
node src/client/restart-server.js --json
```

コマンドが終了コード `0` で、出力 JSON の `result` が `ok`、`commitVerified` が `true` であることを確かめます。
さらに、`running.version` が指定されたバージョン（先頭の `v` を除く）と一致し、`running.commit` が更新後の `HEAD` と一致することを更新完了の条件にします。
`commitVerified` が `false` の成功は、更新後のコードで動いているかを確認できていないため、更新完了とせず利用者に知らせます。
`mismatch` などの失敗は、コマンドの出力を利用者に伝えて止めます。
更新通知は外部のタグ確認の結果なので、通知が消えたことを稼働中のコードの照合には使いません。

利用者への報告は、次の 3 つに分けます。

- **常駐サーバー**：照合したバージョンとコミット、および照合の結果を報告します。
- **画面**：利用者に、ダッシュボードのタイトルのバージョンが更新先と一致し、再起動待ちの帯が出ていないことを確かめてもらいます。開いたままの画面は自動で読み込み直しますが、書きかけの回答があると案内が出ることも伝えます。画面を見ていない AI は画面の更新完了を報告しません。
- **連携**：Claude Code と Codex の実行中のセッションは古い MCP とフックの読み込みを使っているため、利用者にセッションを開き直してもらいます。
