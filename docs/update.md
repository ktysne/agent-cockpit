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
コマンドは PowerShell か bash で実行します。

更新に使うコミットは、`origin` ではなく配布元から直接取得して決めます。
`origin` がフォークを指していると、同名のタグが別のコミットを指していることがあるためです。

```sh
git fetch --no-tags https://github.com/ktysne/agent-cockpit.git "refs/tags/vX.Y.Z:refs/tags/vX.Y.Z"
git rev-list -n 1 refs/tags/vX.Y.Z
```

`git rev-list` が出力した完全なコミット ID を、以下では `<S>` と書きます。
`git fetch` が失敗したら、本体を更新せずに止めて利用者に知らせます。
配布元に接続できないとき、配布元にタグが無いとき、手元の同名のタグが別のコミットを指しているとき(`would clobber existing tag` と出ます)に失敗します。
手元のタグを消したり、`--force` で上書きしたりして続けません。

次に、`<S>` の `package.json` を表示します。

```sh
git show <S>:package.json
```

`version` が指定されたバージョン（先頭の `v` を除く）と一致しなければ、本体を更新せずに止めて利用者に知らせます。

確かめたコミットへ更新します。
タグ名ではなく `<S>` を指定し、確かめた後にタグが変わっても別のコミットを適用しないようにします。

```sh
git merge --ff-only <S>
git rev-parse HEAD
node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version"
```

`git merge` が失敗したら、止めて利用者に知らせます。
変更やコミットを捨てて続けません。
`HEAD` が `<S>` と一致し、`package.json` の `version` が指定されたバージョンと一致することを確かめます。
いずれかが違う場合は、更新の完了にせず、止めて利用者に知らせます。

ここまで確かめてから、この `docs/update.md` を必ず読み直し、新しいバージョンの手順に従って残りを進めます。
手元のタグ `vX.Y.Z` は、再起動した常駐サーバーが公開したバージョンで動いているかの判定にも使います。

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
不一致の診断には、チェックアウトのルートで `node src/client/doctor.js` を実行します。
`--json` を付けると JSON を出力し、不一致があれば終了コード `1` を返します。
診断は MCP からの書き込みと質問への回答の往復を確かめないため、[導入手順](setup.md)の「確認」も実行してください。
設定を直した後は、その後に開いたセッションだけが新しい内容で動きます。

## スキルのコピー

[導入手順](setup.md#4-スキルを置く)と同じコマンドで、スキルをコピーし直します。
Claude Code を使っていない環境では、Claude Code のスキルは飛ばします。
リポジトリ外を書き換えるため、コピー先と内容を利用者に示して確認を取ります。
スキルの写しが古いかどうかも、前の節の `node src/client/doctor.js` で確かめられます。

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

Codex を使っているときは、[導入手順](setup.md#3-スキルを置く)と同じコマンドで、Codex のスキルもコピーし直します。

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

## 常駐サーバーの再起動と確認

```sh
node src/client/restart-server.js --json
```

コマンドが終了コード `0` で、出力 JSON の `result` が `ok`、`commitVerified` と `releaseVerified` が `true` であることを確かめます。
さらに、`running.version` が指定されたバージョン（先頭の `v` を除く）と一致し、`running.commit` が更新後の `HEAD` と一致することを更新完了の条件にします。
`commitVerified` が `false` の成功は、更新後のコードで動いているかを確認できていないため、更新完了とせず利用者に知らせます。
`commitVerified` が `true` でも `releaseVerified` が `false` なら、`running.sourceState` を利用者に伝えて更新完了にしません。
`dirty` は起動したときに未コミットの変更があった状態、`diverged` は手元のタグ `vX.Y.Z` が別のコミットを指している状態、`unknown` は手元にタグが無いか Git で確かめられなかった状態、`pending` は期限内に確定しなかった状態です。
`mismatch` などの失敗は、コマンドの出力を利用者に伝えて止めます。
更新通知は外部のタグ確認の結果なので、通知が消えたことを稼働中のコードの照合には使いません。

利用者への報告は、次の 3 つに分けます。

- **常駐サーバー**：照合したバージョンとコミット、ソースの状態、および照合の結果を報告します。
- **画面**：利用者に、ダッシュボードのタイトルのバージョンが更新先と一致し、再起動待ちの帯が出ていないことを確かめてもらいます。開いたままの画面は自動で読み込み直しますが、書きかけの回答があると案内が出ることも伝えます。画面を見ていない AI は画面の更新完了を報告しません。
- **連携**：Claude Code と Codex の実行中のセッションは古い MCP とフックの読み込みを使っているため、利用者にセッションを開き直してもらいます。
