# agent-cockpit の更新手順

利用者から指定された `vX.Y.Z` へ、本体のチェックアウトを更新する AI 向けの手順です。
以下のコマンドは、この手順書があるチェックアウトのルートで実行します。
設定済みの保存先やポートがある場合は、常駐サーバーと同じ環境変数を使います。

## 更新前の確認

チェックアウトの絶対パスが `.claude/worktrees/` の下なら、更新せずに止めて、本体のチェックアウトで依頼し直すよう利用者に伝えます。
まず、更新前の版を `package.json` の `version` から読み、追加作業の判定のために覚えておきます。

```sh
git status --porcelain
git branch --show-current
git fetch origin
git rev-list --count origin/main..HEAD
```

未追跡ファイルを含めて変更が無いこと、ブランチが `main` であること、`origin/main` より先のコミットが 0 件であることを確かめます。
いずれかが違う場合やコマンドが失敗した場合は、更新せずに止めて利用者に尋ねます。
変更を消したり、ブランチを切り替えたり、ローカルのコミットを捨てたりして続けません。

## タグへの更新

`vX.Y.Z` は利用者が指定した新しい版に置き換えます。

```sh
git fetch --tags origin
git merge --ff-only vX.Y.Z
```

失敗したら止めて利用者に知らせます。
成功したら、この `docs/update.md` を必ず読み直し、新しい版の手順に従って残りを進めます。
`package.json` の `version` が指定された版と一致することも確かめます。

## 版ごとの追加作業

今はありません。
追加作業がある場合は、更新前の版より新しく、更新先の版以下の節だけを、版の小さい順に実行します。
版はピリオドで区切った 3 つの整数で比較します。
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
node src/client/restart-server.js
```

停止した pid と起動後の pid が出ます。
失敗した場合は、出力を利用者に伝えて止めます。
実行中のセッションは古い MCP とフックの読み込みを使っているため、利用者に Claude Code と Codex のセッションを開き直すよう伝えます。

ダッシュボードを開き、更新通知が消えたことを確かめます。
確認は新しいサーバーの初回の版確認が行われる起動 1 分後にも行い、通知が再び出ていないことを確かめます。
`/api/diagnostics` の `version` が更新先の版になっていることも確かめます。
既定のポートの場合、確認先は `http://127.0.0.1:47821/api/diagnostics` です。
ポートを変更している場合は、保存先の `server.json` の `port` を使います。
