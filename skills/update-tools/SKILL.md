---
name: update-tools
description: 導入済みの agent-cockpit、ai-cross-review、claude-codex-bridge について、ローカルの checkout と配置済みの写しを GitHub の最新と見比べ、古いものを更新してローカルに反映する。「ツールを最新にして」「cockpit や bridge の更新を確かめて」と言われたときに使う。
---

# 連携ツールの更新

agent-cockpit、ai-cross-review、claude-codex-bridge(以下、bridge)のうち、導入済みのものだけを扱う。
未導入のツールは調べるだけにして、導入を勧めたり警告を出したりしない。

各ツールは 2 層で古くなる。

- **checkout**：GitHub から clone した作業コピー。`git pull` などで更新する。
- **写し**：checkout から Claude と Codex のホームへコピーしたスキル、定義、スクリプト。checkout を更新しても自動では変わらない。

両方の層を見比べてから、まとめて開発者の確認を取り、更新する。

## 守ること

- checkout も写しも、今のリポジトリの外にあり、開発者のすべてのセッションに効く。調べるところまでは確認なしで進め、書き換える前に、対象と差分の一覧を示して開発者の確認を取る。
- checkout は fast-forward でだけ更新する。未コミットの変更、`main` 以外のブランチ、`origin/main` に無いローカルのコミットがある checkout は更新せずに報告する。変更を消す、ブランチを切り替える、`--force` で上書きする、タグを消すことはしない。
- 開発者が値を変えて使っている写し(手順 3 の設定のキー)は、上書きの前に差分を示し、変えた値を引き継ぐ。
- agent-cockpit の保存先の `server.json` は `port` だけを読む。秘密値を表示しない。
- 手順の細部は各ツールの文書が正本である。このスキルは順序と判定だけを決め、コピーのコマンドなどは checkout の文書に従う。

## 1. 導入済みのツールと checkout を見つける

Claude のホームは `CLAUDE_CONFIG_DIR` があればその値、無ければ `~/.claude` である。Codex のホームは `CODEX_HOME` があればその値、無ければ `~/.codex` である。
agent-cockpit の保存先は `AGENT_COCKPIT_HOME` があればその値、無ければ `~/.agent-cockpit` である。

| ツール | 導入済みの印 | checkout の探し方 |
|---|---|---|
| agent-cockpit | 保存先のディレクトリがある | Claude のホームの `settings.json` のフック、`claude mcp list`、Codex のホームの `hooks.json` と `config.toml` に書かれた `src/` の手前のパス |
| bridge | `~/.claude/tools/codex-agent.sh` がある | 下の「候補の場所」 |
| ai-cross-review | Claude のホームの `skills/cross-review/SKILL.md` がある、または候補の場所に checkout がある | 下の「候補の場所」 |

候補の場所は、agent-cockpit の checkout の親ディレクトリ、今のリポジトリの親ディレクトリ、ホームの直下である。
そこにあるディレクトリのうち、`git remote get-url origin` が `github.com/ktysne/<ツール名>` を指すものを checkout とする。
agent-cockpit の checkout は、パスが `.claude/worktrees/` の下のものを除く。
印があるのに checkout が見つからないときは、開発者に場所を尋ねる。clone し直すかどうかも開発者が決める。

## 2. checkout を GitHub と見比べる

checkout ごとに、そのルートで次を実行する。

```sh
git status --porcelain
git branch --show-current
git fetch origin
git rev-list --count origin/main..HEAD
git rev-list --count HEAD..origin/main
git log --oneline HEAD..origin/main
```

1 行目が空、ブランチが `main`、先行が 0 件なら更新できる。遅れが 0 件なら最新である。

agent-cockpit は、配布の単位がタグなので、追う先を checkout の状態で決める。

```sh
git ls-remote --tags --refs https://github.com/ktysne/agent-cockpit.git "v*"
git tag --points-at HEAD "v*"
```

- `HEAD` にリリースのタグが付いているときは、リリースを追う使い方である。`package.json` の `version` より新しいタグがあれば、最も新しいタグを更新先にする。
- `HEAD` にタグが付いていないときは、`main` を追う使い方である。`origin/main` を更新先にする。

agent-cockpit の常駐サーバーも見比べる。
保存先の `server.json` の `port` を使って `http://127.0.0.1:<port>/health` を取得し、`commit` が checkout の `HEAD` と一致するかと、`sourceState` を控える。
`sourceState` が `dirty` のときは、未コミットの変更があった状態で起動しているので、コミットが一致しても checkout と同じコードで動いているとは言えない。再起動の対象にする。
`pending` のときは判定が終わっていないので、一致を確かめたことにせず、少し待って取得し直す。
取得できないときは、そのことを控える。

## 3. 写しを checkout と見比べる

checkout の正本と、ホームの写しを、行末の違いを除いて比べる。
正本は作業ツリーのファイルではなく、checkout のルートで `git show <ref>:<パス>` が出す内容を使う。`<ref>` は今の比較では `HEAD`、更新後の見込みでは更新先である。
Windows の checkout は作業ツリーの行末が CRLF になることがあり、LF の写しとそのまま比べるとすべて差分に見えるため。

```sh
git show HEAD:<パス> | diff --strip-trailing-cr - <写し>
```

フロントマターの次のキーだけが違う定義は、開発者が設定コンソールや手で変えた設定として扱い、古いとは判定しない。

- bridge の Claude 側定義(`agents/`)：`model`、`effort`
- bridge の GPT 側定義(`gpt-agents/`)：`codex_home`、`codex_enabled`、`codex_model`、`codex_reasoning_effort`

これらのキー以外にも差分があるものを、更新の対象にする。置き直すときは、これらのキーの今の値を引き継ぐ。

写しが無いものは、導入時に置かなかったものとして扱い、新しく置かない。ただし、正本が新しく増えたもの(このスキルなど)は、置くかどうかを開発者に尋ねる。

| ツール | 正本(checkout) | 写し |
|---|---|---|
| agent-cockpit | `skills/agent-cockpit/SKILL.md` | Claude のホームの `skills/agent-cockpit/SKILL.md` |
| agent-cockpit | `skills/codex/agent-cockpit/SKILL.md` | Codex のホームの `skills/agent-cockpit/SKILL.md` |
| agent-cockpit | `skills/update-tools/SKILL.md` | Claude のホームと Codex のホームの `skills/update-tools/SKILL.md` |
| bridge | `tools/codex-agent.sh`、`tools/codex-agent-hook.js` | `~/.claude/tools/` の同名のファイル |
| bridge | `.claude/agents/*.md` | Claude のホームの `agents/` の同名のファイル |
| bridge | `.claude/gpt-agents/*.md` | `~/.claude/gpt-agents/` の同名のファイル |
| ai-cross-review | `.claude/skills/cross-review/SKILL.md` | Claude のホーム、`~/.codex`、`~/.codex-subagent` の `skills/cross-review/SKILL.md` |

ai-cross-review のグローバル SKILL は、checkout のルートで `node tools/cross-review.sync-all.js --global-skill --check` を実行しても確かめられる。

checkout を更新する予定のツールは、更新先の内容で差分の見込みを示し、更新後に比べ直す(手順 5)。

ai-cross-review は、レビューを回すリポジトリごとに `tools/cross-review.sync.json` で GitHub から直接取り込む形でも入っている。
候補の場所にあるリポジトリのうち、このマニフェストを持つものでは `node tools/cross-review.sync.js --check` を実行し、差分の有無を控える。
取り込みはそのリポジトリへの変更なので、このスキルでは行わない。差分があるリポジトリを報告に挙げ、そのリポジトリの運用(作業ブランチと PR)で取り込むよう伝える。

## 4. 結果を示して確認を取る

ツールごとに、次をまとめて開発者に示す。

- checkout：現在のコミット、更新先、遅れているコミットの一覧。更新できない理由があればその理由
- 写し：差分のあるファイルと、更新後に差分が出る見込みのファイル
- agent-cockpit の常駐サーバー：稼働中のコミットと checkout の `HEAD` の一致、`sourceState`
- ai-cross-review の取り込み先：差分のあるリポジトリ

すべて最新なら、そう報告して終える。
更新するものがあれば、対象をツールごとに選べる形で確認を取る。推奨は、更新できるものをすべて更新することである。

## 5. 更新して反映する

確認を得たツールだけを、次の順に進める。

1. **bridge**：checkout の `docs/setup.md` の「更新するとき」に従う。スクリプトを定義より先に置く。`.claude/agents/` の写しを変えたら、手順 6 で Claude Code の再起動を案内する。
2. **ai-cross-review**：`git merge --ff-only origin/main` で checkout を更新し、グローバル SKILL を配り直す。
   一括配布(`node tools/cross-review.sync-all.js --global-skill`)は、Claude のホームには写しが無くても新しく置き、Codex 側も `skills/` があれば新しく置く。
   そのため、`--dry-run` で配布先を確かめ、全配布先に写しがあるか、新しく置く先も開発者が認めたときだけ一括配布を使う。
   そうでないときは、写しのある配布先と認められた配布先だけに、`git show HEAD:.claude/skills/cross-review/SKILL.md` の内容を書く。
3. **agent-cockpit**：checkout の `docs/update.md` に従う。
   - リリースを追う使い方では、手順書のとおり更新先のタグで進める。
   - `main` を追う使い方では、「タグへの更新」の代わりに `git merge --ff-only origin/main` で更新し、`HEAD` が `origin/main` と一致することを確かめる。その後の節(バージョンごとの追加作業、登録の見比べ、スキルのコピー、再起動と確認)は手順書のとおり行う。再起動の確認では、`commitVerified` が `true` で `running.commit` が更新後の `HEAD` と一致すれば完了とする。タグと一致しないので `releaseVerified` は `false`、`running.sourceState` は `diverged` になる。
   - checkout を更新しなくても、稼働中のコミットが `HEAD` と違うときや `sourceState` が `dirty` のときは、確認を取ってから再起動と確認だけを行う。

各ツールの更新後に、手順 3 の比較をやり直し、差分が残っていないことを確かめる。
agent-cockpit を更新して `skills/update-tools/SKILL.md` が変わったときは、写しを置いた後にこのスキルを読み直し、残りの手順を新しい内容で進める。

## 6. 報告する

ツールごとに、更新前と更新後のコミット、置き直した写し、確かめた結果を書く。
次のものは、開発者に行ってもらう作業として最後にまとめる。

- 写しを変えたツールを使う、実行中の Claude Code と Codex のセッションを開き直すこと。スキル、定義、フック、MCP は開いた時点の内容で動くため
- Codex の `hooks.json` を変えたときは、Codex の `/hooks` で信頼し直すこと
- agent-cockpit を更新したときは、ダッシュボードのタイトルのバージョンと、再起動待ちの帯が出ていないことを画面で確かめること
- 更新できなかった checkout と、その理由
- ai-cross-review の取り込み先のうち、差分があるリポジトリ
