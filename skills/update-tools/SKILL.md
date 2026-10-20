---
name: update-tools
description: 導入済みの agent-cockpit、ai-cross-review、claude-codex-bridge について、ローカルの checkout と配置済みの写しを GitHub の最新と見比べ、古いものを更新してローカルに反映する。「ツールを最新にして」「cockpit や bridge の更新を確かめて」と言われたときに使う。
---

# 連携ツールの更新

agent-cockpit、ai-cross-review、claude-codex-bridge(以下、bridge)のうち、導入済みのものだけを扱う。
未導入のツールは調べるだけにして、導入を勧めたり警告を出したりしない。

各ツールは 2 層で古くなる。

- **checkout**：GitHub から clone した作業コピー。
- **写し**：checkout から Claude と Codex のホームへコピーしたスキル、定義、スクリプトと、フックと MCP の登録。checkout を更新しても自動では変わらない。

checkout の確認と更新、agent-cockpit の写しと登録の照合と反映は、agent-cockpit の checkout にあるコマンドで行う。
判定の規則はコマンドの中にあり、このスキルでは書き写さない。モデルが行うのは、コマンドの結果を開発者に示して選んでもらうことと、報告である。
bridge と ai-cross-review の写しの照合と反映は、まだコマンドが無いので、手順 3 の表に沿ってファイルを見比べて行う。

## 守ること

- checkout も写しも、今のリポジトリの外にあり、開発者のすべてのセッションに効く。調べるところまでは確認なしで進め、書き換える前に、対象と差分の一覧を示して開発者の確認を取る。
- checkout は `apply.js --update-checkouts` でだけ更新する。コマンドが更新しないと報告した checkout(`blocked`)を、変更を消す、ブランチを切り替える、`--force`、タグの削除で更新し直さない。
- agent-cockpit の写しと登録は、`apply.js --from` でだけ書き換える。コマンドが適用しなかった項目(`skipped`、`failed`)を手で書き換えない。診断し直して、もう一度選んでもらう。
- 開発者が値を変えて使っている bridge の写し(手順 3 の設定のキー)は、上書きの前に差分を示し、変えた値を引き継ぐ。
- 診断の結果には、開発者の設定のパスが出る。診断の JSON は、リポジトリの外の一時ファイルに置く。
- 手順の細部は各ツールの文書が正本である。

## 1. agent-cockpit の checkout を見つける

Claude のホームは `CLAUDE_CONFIG_DIR` があればその値、無ければ `~/.claude` である。Codex のホームは `CODEX_HOME` があればその値、無ければ `~/.codex` である。

agent-cockpit の checkout は、Claude のホームの `settings.json` のフック、`claude mcp list`、Codex のホームの `hooks.json` と `config.toml` に書かれた `src/` の手前のパスである。
パスが `.claude/worktrees/` の下のものは除く。
見つからなければ、agent-cockpit は未導入として扱い、bridge と ai-cross-review の写しの手順(手順 3 と手順 5)だけを行う。

checkout に `src/client/apply.js` が無いときは、古い版である。checkout の `docs/update.md` に沿って agent-cockpit を先に更新してから、このスキルを読み直す。

以下のコマンドは、agent-cockpit の checkout のルートで実行する。

## 2. checkout を GitHub と見比べる

```sh
node src/client/apply.js --update-checkouts --check --json
```

導入済みのツールの checkout を見つけて `git fetch` し、ツールごとに結果を返す。merge はしない。

- `updatable`：fast-forward で更新できる。`to` が更新先、`commits` が遅れているコミット、`track` が追う先(`main` か、agent-cockpit のリリースのタグの `release`)である。
- `up-to-date`：最新である。
- `blocked`：更新できない。`reason` に理由がある(未コミットの変更、`main` 以外のブランチ、ローカルのコミット、worktree、履歴が分かれた更新先)。
- `not-found`：導入の印はあるが、checkout の場所が分からない。開発者に場所を尋ねる。clone し直すかどうかも開発者が決める。
- `failed`：git の確認に失敗した。`reason` を開発者に伝える。

導入されていないツールは結果に出ない。

## 3. 写しを checkout と見比べる

agent-cockpit の写し、フックと MCP の登録、常駐サーバーは、診断で見比べる。

```sh
node src/client/doctor.js --json > <一時ファイル>
```

`result` が `mismatch` の項目が、直す候補である。項目ごとの `reason` と `actions` を開発者に示す。
`unverified` は、コマンドでは一致を確かめられなかった項目である。`reason` を伝え、手で確かめてもらう。
`not-run` の項目は、診断が確かめていないことの案内である(MCP の往復の確認、checkout の更新の有無)。

bridge と ai-cross-review の写しは、checkout の正本とホームの写しを、行末の違いを除いて比べる。
正本は作業ツリーのファイルではなく、各 checkout のルートで `git show <ref>:<パス>` が出す内容を使う。`<ref>` は今の比較では `HEAD`、更新後の見込みでは手順 2 の `to` である。
Windows の checkout は作業ツリーの行末が CRLF になることがあり、LF の写しとそのまま比べるとすべて差分に見えるため。

```sh
git show HEAD:<パス> | diff --strip-trailing-cr - <写し>
```

フロントマターの次のキーだけが違う定義は、開発者が設定コンソールや手で変えた設定として扱い、古いとは判定しない。

- bridge の Claude 側定義(`agents/`)：`model`、`effort`
- bridge の GPT 側定義(`gpt-agents/`)：`codex_home`、`codex_enabled`、`codex_model`、`codex_reasoning_effort`

これらのキー以外にも差分があるものを、更新の対象にする。置き直すときは、これらのキーの今の値を引き継ぐ。

写しが無いものは、導入時に置かなかったものとして扱い、新しく置かない。ただし、正本が新しく増えたものは、置くかどうかを開発者に尋ねる。

| ツール | 正本(checkout) | 写し |
|---|---|---|
| bridge | `tools/codex-agent.sh`、`tools/codex-agent-hook.js` | `~/.claude/tools/` の同名のファイル |
| bridge | `.claude/agents/*.md` | Claude のホームの `agents/` の同名のファイル |
| bridge | `.claude/gpt-agents/*.md` | `~/.claude/gpt-agents/` の同名のファイル |
| ai-cross-review | `.claude/skills/cross-review/SKILL.md` | Claude のホーム、`~/.codex`、`~/.codex-subagent` の `skills/cross-review/SKILL.md` |

ai-cross-review のグローバル SKILL は、その checkout のルートで `node tools/cross-review.sync-all.js --global-skill --check` を実行しても確かめられる。

ai-cross-review は、レビューを回すリポジトリごとに `tools/cross-review.sync.json` で GitHub から直接取り込む形でも入っている。
agent-cockpit の checkout の親ディレクトリと、今のリポジトリの親ディレクトリにあるリポジトリのうち、このマニフェストを持つものでは `node tools/cross-review.sync.js --check` を実行し、差分の有無を控える。
取り込みはそのリポジトリへの変更なので、このスキルでは行わない。差分があるリポジトリを報告に挙げ、そのリポジトリの運用(作業ブランチと PR)で取り込むよう伝える。

## 4. 結果を示して確認を取る

ツールごとに、次をまとめて開発者に示す。

- checkout：手順 2 の `status`、`from`、`to`、`commits`、更新できない理由
- agent-cockpit の写し、登録、常駐サーバー：手順 3 の診断の `mismatch` の項目の id、`reason`、`actions`
- bridge と ai-cross-review の写し：差分のあるファイルと、更新後に差分が出る見込みのファイル
- ai-cross-review の取り込み先：差分のあるリポジトリ

すべて最新なら、そう報告して終える。
更新するものがあれば、checkout はツールごとに、agent-cockpit の診断は項目の id ごとに選べる形で確認を取る。推奨は、更新できるものをすべて更新することである。

## 5. 更新して反映する

確認を得たものだけを、次の順に進める。

1. **checkout**：選んだツールを `--tool` に並べて更新する。

   ```sh
   node src/client/apply.js --update-checkouts --tool <名前> [--tool <名前> ...] --json
   ```

   `updated` にならなかったツールは、その理由を控え、そのツールの残りの手順を行わない。
   出力の `manual` に、agent-cockpit の `docs/update.md` の「バージョンごとの追加作業」を確かめる案内があれば、その節を読んで行う。
2. **bridge**：bridge の checkout の `docs/setup.md` の「更新するとき」に従い、写しを置き直す。スクリプトを定義より先に置く。`.claude/agents/` の写しを変えたら、手順 6 で Claude Code の再起動を案内する。
3. **ai-cross-review**：グローバル SKILL を配り直す。
   一括配布(`node tools/cross-review.sync-all.js --global-skill`)は、Claude のホームには写しが無くても新しく置き、Codex 側も `skills/` があれば新しく置く。
   そのため、`--dry-run` で配布先を確かめ、全配布先に写しがあるか、新しく置く先も開発者が認めたときだけ一括配布を使う。
   そうでないときは、写しのある配布先と認められた配布先だけに、`git show HEAD:.claude/skills/cross-review/SKILL.md` の内容を書く。
4. **agent-cockpit**：checkout を更新したときは、診断をやり直して手順 4 と同じく項目を選んでもらう。更新していないときは、手順 4 で選んでもらった項目を使う。選んだ項目を、診断の JSON とともに適用する。

   ```sh
   node src/client/doctor.js --json > <一時ファイル>
   node src/client/apply.js --from <一時ファイル> --item <id> [--item <id> ...] --json
   ```

   常駐サーバーの再起動は、診断の `cockpit.server.running` の項目を選ぶと、ほかの項目を書き換えた後に行われる。
   `skipped` の項目は、診断の後にファイルか checkout が変わったものである。診断し直して、残っていれば選び直してもらう。
   `failed` の項目は、`reason` を開発者に伝える。
   出力の `backupDir` は、書き換える前のファイルの退避先である。

各ツールの更新後に、手順 3 の比較をやり直し、差分が残っていないことを確かめる。agent-cockpit は、診断をやり直して `mismatch` が残っていないことを確かめる。
agent-cockpit を更新して `skills/update-tools/SKILL.md` が変わったときは、写しを置いた後にこのスキルを読み直し、残りの手順を新しい内容で進める。

## 6. 報告する

ツールごとに、更新前と更新後のコミット、置き直した写しと適用した項目、確かめた結果を書く。
次のものは、開発者に行ってもらう作業として最後にまとめる。

- `apply.js` の出力の `manual`(セッションの開き直し、Codex の `/hooks` での信頼し直しなど)
- bridge と ai-cross-review の写しを変えたときは、それを使う実行中の Claude Code と Codex のセッションを開き直すこと
- agent-cockpit を更新したときは、ダッシュボードのタイトルのバージョンと、再起動待ちの帯が出ていないことを画面で確かめること
- 診断の `cockpit.runtime-check.roundtrip` の案内(導入手順の「確認」で MCP の書き込みと質問の回答を試すこと)
- 更新できなかった checkout と適用できなかった項目と、その理由
- ai-cross-review の取り込み先のうち、差分があるリポジトリ
