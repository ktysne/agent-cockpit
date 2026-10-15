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

更新前の常駐サーバーの `/health` を取得し、`version` と `commit` を控えます。
確認先は、保存先（既定は `~/.agent-cockpit`、`AGENT_COCKPIT_HOME` があればその場所）の `server.json` の `port` を使った `http://127.0.0.1:<port>/health` です。
取得できない場合は、そのことを控えます。

## タグへの更新

`vX.Y.Z` は利用者が指定した新しい版に置き換えます。

```sh
git fetch --tags origin
git merge --ff-only vX.Y.Z
```

失敗したら止めて利用者に知らせます。
成功したら、この `docs/update.md` を必ず読み直し、新しい版の手順に従って残りを進めます。
続いて、次を実行します。

```sh
git rev-parse HEAD
git rev-parse "vX.Y.Z^{commit}"
git ls-remote https://github.com/ktysne/agent-cockpit.git "refs/tags/vX.Y.Z^{}"
node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version"
```

`HEAD` と手元のタグの実体コミットが一致することを確かめます。
同じ版番号でも別のコミットなら、更新の完了にはしません。
配布元の `refs/tags/vX.Y.Z^{}` の実体コミットも、手元のタグの実体コミットと一致することを確かめます。
`origin` がフォークを指し、同名のタグが別のコミットを指している場合の取り違えを防ぐためです。
`package.json` の `version` が指定された版（先頭の `v` を除く）と一致することも確かめます。
いずれかが違う場合、配布元のタグを取得できない場合、コマンドが失敗した場合は、止めて利用者に知らせます。

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

停止した pid、起動後の pid、起動した常駐サーバーの版、短縮コミット、`sourceState`、照合の結果が出ます。
コマンドが成功し、出力の版が指定された版に、コミットが更新後の `HEAD` に一致したことを完了の条件にします。
完全なコミット ID が必要な場合は、最初から `node src/client/restart-server.js --json` で実行し、`expected.commit` と `running.commit` を照合します。
「commit を照合できなかった」という成功だけでは、タグのコードで動いていることを確認できていません。
その場合は更新完了とせず、利用者に知らせます。
`sourceState` は起動直後には `pending` の場合があります。
失敗した場合は、出力を利用者に伝えて止めます。
`mismatch` の場合は、別のチェックアウトから起動した常駐サーバーか、更新前のコードで動いている可能性があることを利用者に知らせて止めます。
更新通知は外部のタグ確認の結果なので、通知が消えたことを稼働中のコードの照合には使いません。

利用者への報告は、次の 3 つに分けます。

- **常駐サーバー**：照合した版とコミット、および照合の結果を報告します。
- **画面**：利用者に、ダッシュボードのタイトルの版が更新先と一致し、再起動待ちの帯が出ていないことを確かめてもらいます。開いたままの画面は自動で読み込み直しますが、書きかけの回答があると案内が出ることも伝えます。画面を見ていない AI は画面の更新完了を報告しません。
- **連携**：Claude Code と Codex の実行中のセッションは古い MCP とフックの読み込みを使っているため、利用者にセッションを開き直してもらいます。
