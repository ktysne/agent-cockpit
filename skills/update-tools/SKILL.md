---
name: update-tools
description: 導入済みの agent-cockpit、ai-cross-review、claude-codex-bridge について、ローカルの checkout と配置済みの写しを GitHub の最新と見比べ、古いものを更新してローカルに反映する。「ツールを最新にして」「cockpit や bridge の更新を確かめて」と言われたときに使う。
---

# 連携ツールの更新

agent-cockpit、ai-cross-review、claude-codex-bridge(以下、bridge)のうち、導入済みのものだけを扱う。
未導入のツールは調べるだけにして、導入を勧めたり警告を出したりしない。

各ツールは 2 層で古くなる。

- **checkout**：GitHub から clone した作業コピー。
- **写し**：checkout から Claude のホーム、Codex のホーム、`~/.agents/skills` へコピーしたスキル、定義、スクリプトと、フックと MCP の登録。checkout を更新しても自動では変わらない。

checkout の確認と更新、写しと登録の照合と反映は、agent-cockpit の checkout にあるコマンドで行う。
bridge と ai-cross-review の写しは、診断が各ツールの照会の入口を呼んで照合する。
判定の規則はコマンドと各ツールの中にあり、このスキルでは書き写さない。モデルが行うのは、コマンドの結果を開発者に示して選んでもらうことと、報告である。

## 守ること

- checkout も写しも、今のリポジトリの外にあり、開発者のすべてのセッションに効く。調べるところまでは確認なしで進め、書き換える前に、対象と差分の一覧を示して開発者の確認を取る。
- checkout は `apply.js --update-checkouts` でだけ更新する。コマンドが更新しないと報告した checkout(`blocked`)を、変更を消す、ブランチを切り替える、`--force`、タグの削除で更新し直さない。
- 写しと登録は、3 ツールとも `apply.js --from` でだけ書き換える。コマンドが適用しなかった項目(`skipped`、`failed`)を手で書き換えない。診断し直して、もう一度選んでもらう。
- ai-cross-review の移行(`--migrate`)、取り込み(`sync`)、登録(`--register`)は、このスキルでは実行しない。移行と取り込みは対象リポジトリの作業ブランチと PR で行うよう伝え、ホームのファイルを書く登録は手順だけを示す。
- bridge の写しを置き直す内容は、bridge の照会が返す。開発者が設定コンソールや手で変えた定義のキーの引き継ぎも bridge が行うので、内容を手で直さない。
- 診断の結果には、開発者の設定のパスが出る。診断の JSON は、リポジトリの外の一時ファイルに置く。
- 手順の細部は各ツールの文書が正本である。

## 1. agent-cockpit の checkout を見つける

Claude のホームは `CLAUDE_CONFIG_DIR` があればその値、無ければ `~/.claude` である。Codex のホームは `CODEX_HOME` があればその値、無ければ `~/.codex` である。

agent-cockpit の checkout は、Claude のホームの `settings.json` のフック、`claude mcp list`、Codex のホームの `hooks.json` と `config.toml` に書かれた `src/` の手前のパスである。
パスが `.claude/worktrees/` の下のものは除く。
見つからなければ、このスキルでは扱わない。bridge と ai-cross-review は、それぞれの checkout の導入手順(bridge は `docs/setup.md` の「更新するとき」)に沿って更新するよう開発者に伝えて終える。各ツールの更新の規則を、agent-cockpit の外で書き写さないためである。

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

3 ツールの写し、フックと MCP の登録、常駐サーバーは、診断で見比べる。

```sh
node src/client/doctor.js --json > <一時ファイル>
```

`result` が `mismatch` の項目が、直す候補である。項目ごとの `reason` と `actions` を開発者に示す。
`unverified` は、コマンドでは一致を確かめられなかった項目である。`reason` を伝え、手で確かめてもらう。
`not-run` の項目は、診断が確かめていないことの案内である(MCP の往復の確認、checkout の更新の有無)。

bridge と ai-cross-review の写しは、区分(`category`)が `copies` の項目である。

- bridge の項目の id は `bridge.copies.<kind>.<name>` である。`requires` に、その項目を置くときに一致している必要がある項目の id が並ぶ。`requires` の中に `mismatch` の項目があれば、それも一緒に選んでもらう。選び漏れがあると、`apply.js` は足りない id を理由に書いて適用しない。
- ai-cross-review の項目の id は `cross-review.skills.<配布先>` である。`not-installed` のうち、`actions` に `copy-file` があるものは、写しの無い配布先である。新しく置くかは開発者に尋ね、認められたときだけ選ぶ。`actions` が空のものは配布の対象外なので、`reason` を伝えるだけにして選ばない。
- `bridge.copies.query` と `cross-review.skills.query` の `unverified` は、そのツールの照会ができなかったことを表す。checkout が古いと照会の入口が無いので、手順 2 で checkout を更新してから診断し直す。

ai-cross-review が導入済みなら、レビューを回すリポジトリごとの取り込みと、本体の登録も確かめる。
`<checkout>` は、手順 2 の結果の ai-cross-review の `root` である。
走査ルートは、agent-cockpit の checkout の親ディレクトリと、今のリポジトリの親ディレクトリとする。

1. 移行の要否は、ai-cross-review の checkout で走査ルートごとに次を実行して確かめる。

   ```sh
   node <checkout>/tools/cross-review.sync-all.js --migrate --check --json --root <走査ルート>
   ```

   出力は `{ schemaVersion: 1, subject: "migrate", result, root, projects: [{ root, manifest, upstream, form, migratable, reason, message }] }` である。
   `form` が `legacy` で `migratable` が `true` のリポジトリは移行できるものとして控える。
   `migratable` が `false` のリポジトリは `reason` と `message` を添えて移行できないものとして控える。
   `form` が `error` のものと、`form` が `legacy` で `migratable` が `null` のものは、確かめられなかったものとして控える。
   `form` が `new` のものは移行済み、`not-applicable` のものは対象外である。どちらも `migratable` は `null` になる。
   終了コードは、0 が移行の必要なし、1 が旧形式あり、3 が確かめられなかったリポジトリあり、2 が引数の誤り(JSON を出さない)である。

2. 取り込み先の差分は、1 の `form` に応じて各リポジトリのルートで確かめる。
   新形式では `node tools/cross-review.js sync --check` を実行する。終了コードは、0 が一致、1 が差分あり、2 がマニフェストの誤り、3 が確かめられなかったことを表す。
   旧形式では `node tools/cross-review.sync.js --check` を実行する。
   結果は控え、終了コード 1 の差分ありと、3 の確かめられなかったものを分ける。前者はそのリポジトリで取り込み、後者は原因を直すよう伝える。

3. ai-cross-review 本体の登録は、ai-cross-review の checkout で次を実行して確かめる。

   ```sh
   node <checkout>/tools/cross-review.sync-all.js --register --check --json
   ```

   出力は `{ schemaVersion: 1, subject: "register", result: clean|drift|error, registry, checkout, issues }` であり、終了コードは 0、1、3 である(2 は引数の誤りである)。
   `drift` なら `issues`(既定のブランチでない、未コミットの変更がある)を控える。
   `error` なら `issues` の `message` と、登録し直す手順 `node <checkout>/tools/cross-review.sync-all.js --register` を控える。
   登録した checkout(`checkout.path`)が `<checkout>` と異なる場合は、そのことを控える。手順 2 で `<checkout>` を更新しても、新形式のリポジトリのレビューは、登録した checkout の本体で動くためである。

照会の結果は解釈し直さず、そのまま示す。判定規則の正本は ai-cross-review の checkout の `docs/cross-review.md` である。

## 4. 結果を示して確認を取る

ツールごとに、次をまとめて開発者に示す。

- checkout：手順 2 の `status`、`from`、`to`、`commits`、更新できない理由
- 写し、登録、常駐サーバー：手順 3 の診断の `mismatch` の項目と、ai-cross-review の `not-installed` のうち `copy-file` の対処がある項目の id、`reason`、`actions`
- ai-cross-review：移行の要否、取り込み先の差分、本体の登録の結果

すべて最新なら、そう報告して終える。
更新するものがあれば、checkout はツールごとに、診断は項目の id ごとに選べる形で確認を取る。推奨は、更新できるものをすべて更新することである。

## 5. 更新して反映する

確認を得たものだけを、次の順に進める。

1. **checkout**：選んだツールを `--tool` に並べて更新する。

   ```sh
   node src/client/apply.js --update-checkouts --tool <名前> [--tool <名前> ...] --json
   ```

   `updated` にならなかったツールは、その理由を控え、そのツールの残りの手順を行わない。
   出力の `manual` に、agent-cockpit の `docs/update.md` の「バージョンごとの追加作業」を確かめる案内があれば、その節を読んで行う。
2. **写しと登録**：開発者が内容を見て項目を選んだ診断の JSON を、そのまま `--from` に渡す。適用の直前に作り直さない。作り直すと、選んだ後にファイルが変わっても `apply.js` が検出できないためである。

   ```sh
   node src/client/apply.js --from <選んでもらった診断の一時ファイル> --item <id> [--item <id> ...] --json
   ```

   checkout を更新したときは、期待値と照会の結果が変わるので、手順 3 の診断を作り直し、項目を示して選び直してもらってから、その JSON で適用する。

   常駐サーバーの再起動は、診断の `cockpit.server.running` の項目を選ぶと、ほかの項目を書き換えた後に行われる。
   bridge の項目は、bridge の照会が返す順(スクリプト、GPT 側定義、Claude 側定義)に置かれる。前提の項目が置けなかったときは、後の項目は `skipped` になる。
   `skipped` の項目は、診断の後にファイルか checkout が変わったか、前提を満たさなかったものである。`reason` を伝え、診断し直して、残っていれば選び直してもらう。
   `failed` の項目は、`reason` を開発者に伝える。
   出力の `backupDir` は、書き換える前のファイルの退避先である。

適用の後に診断をやり直し、選んだ項目に `mismatch` が残っていないことを確かめる。
agent-cockpit を更新して `skills/update-tools/SKILL.md` が変わったときは、写しを置いた後にこのスキルを読み直し、残りの手順を新しい内容で進める。

## 6. 報告する

ツールごとに、更新前と更新後のコミット、置き直した写しと適用した項目、確かめた結果を書く。
次のものは、開発者に行ってもらう作業として最後にまとめる。

- `apply.js` の出力の `manual`(セッションの開き直し、Codex の `/hooks` での信頼し直しなど)
- agent-cockpit を更新したときは、ダッシュボードのタイトルのバージョンと、再起動待ちの帯が出ていないことを画面で確かめること
- 診断の `cockpit.runtime-check.roundtrip` の案内(導入手順の「確認」で MCP の書き込みと質問の回答を試すこと)
- 更新できなかった checkout と適用できなかった項目と、その理由
- ai-cross-review の移行の要否、取り込み先の差分、本体の登録の結果
