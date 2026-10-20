# 連携ツールの更新と反映の計画(2026-10-20)

Issue #534(段階 1)、#671(段階 2a)、#673(段階 2b)の計画である。利用者が、連携ツール(ai-cross-review、claude-codex-bridge)も含めて、最新のツールを簡単に使える状態にすることを最終目標にする。
起点は main の 558e7480 である。
各リポジトリが `tools/cross-review.sync.json` で取り込む ai-cross-review の写しは、リポジトリの中身でホームの設定ではないので、対象に入れない。
3 ツールの構造改善の計画(#669)の「配置済みの写しの更新」の系列にあたり、#669 の共通ルールに従う。

## 現在地と次にやること

段階 1(診断)は終わった。仕様の正本は [導入の整合の診断の設計](../design/doctor.md) である。
段階 2a(#671)は終わった。診断と適用(`src/client/doctor.js`、`src/client/apply.js`)、checkout の更新(`apply.js --update-checkouts`)、それを使う `update-tools` スキルが入っている。
新しい `update-tools` の手順は、本体の checkout と実機のホームで 1 回通した(2026-10-20)。checkout の確認と fast-forward の更新、診断の不一致の選択と適用、退避、常駐サーバーの再起動が動き、診断し直して不一致が残らないことを確かめた。
段階 2b(#673)の前提の照会の入口は、2 つともそろった。bridge は `bash tools/codex-agent.sh --check-copies`、ai-cross-review は `node tools/cross-review.sync-all.js --global-skill --check --json` である。契約の正本は、bridge の `docs/gpt-agents.md` の「配置済みの写しを照合する」と、ai-cross-review の `docs/cross-review.md` の「グローバル SKILL の配布」にある。
段階 2b(#673)は、診断と適用に ai-cross-review と bridge の写しの項目が入り、`update-tools` の手順もそれを使う形になった。bridge と ai-cross-review の写しは、ファイルを見比べず、診断の `copies` の項目を選んで適用する。
ktysne/ai-cross-review#89 で、すべての導入先が新形式(入口だけを置き、本体は登録した checkout から読む)に移った。`update-tools` も、移行の要否、取り込み先の差分、本体の登録を確かめる形になった(表の 7 行目)。
残るのは、表の 6 行目(段階 3、#694)である。
6 行目は、モックを先に入れ、その後に常駐サーバーと画面を実装する。画面の形と常駐サーバーからの呼び方は #694 の本文にある。

## 決定済みの判断

| 項目 | 決定 | 理由 |
|---|---|---|
| 最終目標 | 診断で終えず、更新と反映まで支える(開発者の決定、2026-10-20) | 利用者が手で照合して直す手間を無くすため |
| 段階 | 1 診断、2 更新と反映、3 ダッシュボードの入口。2 と 3 は段階 1 の後に別の Issue で起票する | 診断の出力の形を固めてから、適用の処理を作るため |
| 再起動待ちの帯のボタン | 「/update-tools スキルでの更新依頼プロンプトをコピー」(#664)はつなぎで、段階 3 でより良い形に置き換えてよい(開発者の決定、2026-10-20) | 段階 3 で、ダッシュボードから更新を始められるようにするため |
| 段階 3 の形 | 常駐サーバーが診断を子プロセスで流し、結果をダッシュボードの「導入の点検」に出す。直すのはセッションの update-tools に任せ、ダッシュボードからは適用しない。再起動待ちの帯のボタンは「導入の点検を開く」に置き換える(開発者の決定、2026-10-21) | 診断は読み取りだけなので、安全の制約に触れずに、何が古いかをセッションを開かずに示せるため。適用を画面に持たせるかは、この形を使ってから決める |
| 段階 1 の範囲 | agent-cockpit 自身のフック、MCP、スキル、常駐サーバーに限る。出力の項目には `tool` を持たせ、bridge と ai-cross-review は段階 2 以降に足す | bridge は `CLAUDE_CONFIG_DIR` を見ないなど、ホームの解決の規則が別で、照合の設計が倍になるため |
| 期待値の正本 | `src/shared/integration-manifest.js` に置き、導入手順の JSON と TOML の例との一致をテストで縛る | 段階 2 の適用も同じ期待値を使うため。導入手順を生成物にすると、周りの説明と例が離れて読みにくくなるため |
| 照合する checkout | `--root`、登録済みのフックが指す checkout、診断を置いた checkout(worktree なら元の checkout)の順に決める | worktree から実行したときに、すべてのフックが別の checkout として不一致になるのを避けるため |
| 対処の形 | 配列の添字ではなく一致の条件で要素を指し、書き換える対処には観測したファイルの sha256 を付ける | 利用者の独自のフックが混ざり、添字は読み直すたびに変わるため。適用の直前に変わっていないかを確かめるため |
| セッションの開き直し | 開始時刻と更新時刻では判定せず、不一致があるときに開き直しの案内を必ず添える | 同じ内容の写し直しでも更新時刻が変わり、誤った案内が増えるため |
| ツールの立ち位置と境界 | 3 つのツールは、どれも単体で導入して完結して使え、連携は任意にする。連携の観点の改善でも、各ツールの役割の境界を曖昧にしない(開発者の決定、2026-10-20) | どれも単独で使う環境があるため |
| 段階 2 の分け方 | 2a(#671)は agent-cockpit の項目の適用、checkout の更新、Codex のホームの解決の集約。2b(#673)は bridge と ai-cross-review の写し(開発者の決定、2026-10-20) | 連携ツールの写しの照合には、そのツールだけが決めている解釈が要るため |
| 連携ツールの写しの照合 | agent-cockpit で解釈せず、各ツールの照会の入口(claude-codex-bridge#169、ai-cross-review#87)の結果を写す。照会を持たない古い版は `unverified` にし、独自の照合に戻らない | 照合の規則を各ツールの中だけに置き、規則が変わっても直す場所を 1 つにするため |
| ai-cross-review の写しの反映 | ai-cross-review の一括配布の CLI に任せず、#671 の適用で選んだ配布先だけに置く | 今の CLI は配布先を選べず、写しの無い配布先にも置くため |
| 適用の入口 | 診断と別のコマンド(`src/client/apply.js`)にし、診断と同じ評価の関数を呼ぶ(開発者の決定、2026-10-20) | 診断を読み取りだけに保ち、段階 3 でダッシュボードから診断だけを呼べるようにするため |
| 適用する項目の選び方 | 診断の JSON のファイルと項目の id を渡す(`--from <ファイル> --item <id>`、`--item` は繰り返せる)。適用の直前に診断をやり直し、`observedDigest` が違う項目と、`ok` になった項目は適用しない(開発者の決定、2026-10-20) | id だけでは、開発者が結果を見てから適用するまでのファイルの変化に気付けないため |
| 退避先 | `AGENT_COCKPIT_HOME/backups/<時刻>/` に 1 回の適用ごとにまとめ、元のパスと sha256 の対応表を置く。時刻は `store.json.broken-<時刻>` と同じ書き方にする。残すのは新しい 10 回分とする(開発者の決定、2026-10-20) | ツールが読むフォルダーに写しを散らさず、戻すときと片付けるときの置き場を 1 つにするため |
| `.claude.json` の照合と同時の書き込み | Claude の MCP の登録の対処は、ファイル全体ではなく `mcpServers['agent-cockpit']` の部分木の sha256 で照合する。照合から書き込みまでの同時の書き込みは完全には防げないものとして受け入れ、書き込みの直前に読み直して照合し直す。残る間隙と退避からの戻し方は設計資料に書く(開発者の決定、2026-10-20) | Claude Code はプロンプトのたびに `.claude.json` を書き換え、排他の手段を公開していないため |
| checkout の更新の置き場 | 適用の側(`apply.js --update-checkouts`)に置き、checkout の更新、常駐サーバーの再起動、診断、適用の順にする。診断は、ネットワークを使わずに分かる checkout の状態だけを項目に出す(開発者の決定、2026-10-20) | 期待値を checkout から読むので、古い checkout で診断して適用すると古い期待値で書くため。`git fetch` は書き込みとネットワークの操作で、読み取りだけの診断に入れないため |
| #673 項目の単位と id(開発者の決定、2026-10-20) | 照会が返す 1 項目を、診断の 1 項目にする。id は bridge を `bridge.copies.<kind>.<name>`(例 `bridge.copies.script.codex-agent.sh`)、ai-cross-review を `cross-review.skills.<id>`(例 `cross-review.skills.codex-subagent`)にする。`category` は `copies` を足す。`provider` は、ai-cross-review の `claude` を `claude`、`codex` と `codex-subagent` を `codex`、bridge の `claude-agent` を `claude`、ほかを `null` にする | 照会の id をそのまま含めれば、agent-cockpit が項目を組み替えずに済み、照会の項目が増えても対応が要らない |
| #673 結果への写し方(開発者の決定、2026-10-20) | bridge は `match` を `ok`、`stale` と `missing` を `mismatch`、`not-deployed` を `not-installed`、`unreadable` を `unverified` にする。ai-cross-review は `match` を `ok`、`stale` を `mismatch`、`missing` と `skipped` を `not-installed`、`unreadable` を `unverified` にする | bridge の `missing` は必須なのに無い写しなので不一致である。ai-cross-review の `missing` は任意の配布先の未配置で、#87 の終了コードもドリフトに数えない |
| #673 未配置の配布先への配布(開発者の決定、2026-10-20) | ai-cross-review の `missing` の項目は `not-installed` のまま置く対処を付け、`apply.js` は、`--item` で明示して選んだ `not-installed` の項目のうち、対処を持つものも適用の候補にする | #673 の決定(未配置の配布先は、開発者が選んだときだけ新しく置く)を満たしつつ、不一致の件数に任意の配布先を数えないため |
| #673 対処の形(開発者の決定、2026-10-20) | 2 つの op を足す。`write`(`to`、`content`、`observedDigest`、`source`、`sourceDigest`)は bridge の `content` をそのまま書く。`copy-file`(`from` は絶対パス、`to`、`observedDigest`、`sourceDigest`)は ai-cross-review の正本のバイト列を写す。`observedDigest` と `sourceDigest` には、照会が返す sha256 をそのまま使う。適用の直前に、正本のバイト列の sha256 が `sourceDigest` と一致することも確かめる | 既存の `copy` は agent-cockpit の checkout からの相対パスを正本にする。照会の sha256 は生のバイト列から求めるが、有効な UTF-8 なら agent-cockpit の文字列からの digest と同じ値になる。違えば `skipped` になり、安全側に倒れる。bridge の契約は、書き込み直前に正本と写しを照合し直すことを求めている |
| #673 必須の依存と置く順(開発者の決定、2026-10-20) | bridge の項目に `requires`(agent-cockpit の id の配列)を持たせる。`apply.js` は、選んだ項目の `requires` を閉包でたどり、`mismatch` の項目が選ばれていなければ、その項目を適用せずに、足りない id を理由に書く。置く順は bridge の `order` に従い、前提の項目が `applied` にならなければ、後の項目を `skipped` にする | #673 の「依存を満たさない選び方は適用しない」「前提の適用に失敗したら後を適用しない」を、bridge の規則を解釈せずに満たすため |
| #673 置き直した後の操作(開発者の決定、2026-10-20) | bridge の `after` を `manual` の対処に写す。`restart-claude-code` は `claude-agent` の項目に、`review-role-section` はすべての bridge の項目に付ける | 適用の結果の `manual` が、重複を除いて最後に案内する作りを使える |
| #673 照会の呼び方(開発者の決定、2026-10-20) | 診断の observe が、各ツールの checkout で照会を子プロセスで実行する。bridge は `bash tools/codex-agent.sh --check-copies`、ai-cross-review は `node tools/cross-review.sync-all.js --global-skill --check --json` である。診断が解決した Claude と Codex のホームを、`CLAUDE_CONFIG_DIR` と `CODEX_HOME` で子プロセスに渡す。時間切れは bridge と ai-cross-review を 30 秒にする | 照会側のホームの解決が、診断のホームの解決とずれないようにするため。bridge の照会は Windows で約 5 秒かかる(bridge#172 で速度を改善) |
| #673 照会できないとき(開発者の決定、2026-10-20) | checkout が見つからない、照会の入口を持たない古い版、`bash` が無い、時間切れ、JSON を読めない、`protocol`(bridge)か `schemaVersion`(ai-cross-review)が未知、のどれでも、そのツールの項目を 1 つの `unverified` にする。理由に原因を書き、そのツールの導入手順の「更新するとき」の節へ案内する。独自の照合には戻らない。ツールが導入されていなければ項目を出さない | #673 の決定。古い checkout は、手順 2 の checkout の更新を先に行えば照会できるようになる |
| #673 PR の分け方(開発者の決定、2026-10-20) | 3 段のスタックにする。1 段目は ai-cross-review の項目と、`copy-file` の op、明示して選んだ `not-installed` の適用。2 段目は bridge の項目と、`write` の op、`requires` と置く順。3 段目は `skills/update-tools/SKILL.md` の書き換えと、手順 3 の表の行の削除 | ai-cross-review の項目のほうが単純で、新しい op と適用の候補の規則を先に固められる。bridge の依存の規則は 2 段目に閉じ込められる。スキルは両方がそろってから書き換える |
| Codex のクラウドでの cross-review(開発者の決定、2026-10-20) | 対応を見送る。使う需要が出たら別に扱う | Codex のクラウドはほとんど使わず、労力に見合わない。2026-10-20 の確かめで分かったことは次のとおり。`~/.cache` は読み取り専用で、入口のキャッシュの経路は失敗する。環境のセットアップスクリプトで上流を clone して `--register` すれば、本体は読める。`CODEX_HOME` にはスキルの置き場が無く、`~/.agents/skills` に置いた SKILL もスキル一覧に出なかった。リポジトリの `.agents/skills` に置く形は確かめていない |

## 対応順序、ブランチ、PR

| 順 | 対象 | 主な変更先 | 委譲の区分 | ブランチ | base | 状態(2026-10-20 に確認) |
|---|---|---|---|---|---|---|
| 1 | #534 段階 1 診断 | `src/client/doctor.js`、`src/shared/integration-manifest.js`、`docs/setup.md`、`docs/update.md` | hard | `claude/integration-doctor` | main | PR #670。マージ済み、#534 は閉じた |
| 2 | #671 段階 2a 適用、checkout の更新、Codex のホームの解決の集約 | `src/client/doctor.js`、`src/client/apply.js`、`src/server/identity.js`、`src/server/server.js`、`skills/update-tools/SKILL.md` | hard | 項目ごとに main から切る | main | PR #674、#675、#676、#677、#678 でマージ済み、#671 は閉じた。項目 6 は `test/apply-checkouts.test.js` と `test/apply.test.js` で確かめた。実機で `update-tools` を通した |
| 3 | ktysne/claude-codex-bridge#169 写しの照会 | bridge の `tools/codex-agent.sh` | bridge 側 | `claude/issue-169-copy-check` | bridge の main | ktysne/claude-codex-bridge#171 でマージ済み、#169 は閉じた。前提の ktysne/claude-codex-bridge#167 も ktysne/claude-codex-bridge#170 でマージ済み |
| 4 | ktysne/ai-cross-review#87 グローバル SKILL の確認 | ai-cross-review の `tools/cross-review.sync-all.js` | ai-cross-review 側 | `fix/global-skill-check` | ai-cross-review の main | ktysne/ai-cross-review#88 でマージ済み、#87 は閉じた |
| 5 | #673 段階 2b 連携ツールの写し | `src/client/doctor-observe.js`、`src/client/doctor-evaluate.js`、`src/client/apply.js`、`skills/update-tools/SKILL.md` | hard、3 段目はメインセッション | `claude/673-cross-review-copies`、`claude/673-bridge-copies`、`claude/673-update-tools-copies` | main | 1 段目は PR #681、2 段目は PR #682 でマージ済み。1 段目のマージ後に 2 段目を main から切ったので、スタックにはしていない。3 段目は PR #683 でマージ済み、#673 は閉じた |
| 6 | #694 段階 3 ダッシュボードの入口 | 1 段目は `mock/index.html`。2 段目は常駐サーバーの診断の呼び出しと `src/web/index.html` | 1 段目はメインセッション、2 段目は hard | `claude/694-doctor-mock`、2 段目は未作成 | main | 1 段目の PR を作成中 |
| 7 | update-tools の ai-cross-review の取り込み先の確認を新形式に合わせる | `skills/update-tools/SKILL.md` | light | `claude/684-update-tools-new-form` | main | PR #686 でマージ済み、#684 は閉じた |
| 8 | ai-cross-review#85 の検証データを revision を固定して取り込む | `test/fixtures/cross-review-state/`、`tools/import-cross-review-contract.js` | メインセッション | `claude/667-shared-contracts` | main | #667 として PR #692 でマージ済み、#667 は閉じた |

- 7 は、ktysne/ai-cross-review#89 の移行で、導入先から `tools/cross-review.sync.js` が消えたために要る。手順 3 の「取り込み先」の確認を、`node tools/cross-review.js sync --check` と、ai-cross-review の `--register --check --json`、`--migrate --check --json` の照会を使う形にする。
- 8 は、ktysne/ai-cross-review#89 の計画で、#85 の契約の文書と検証データを導入先へ写さず、agent-cockpit が上流の revision を固定して取り込むと決まったために要る。#85 は ktysne/ai-cross-review#93 でマージ済み(マージコミット 1978f8f)。#667 の項目 1 が、この検証データの取り込みを含む。

## 落とし穴

- Windows の Bash ツールでは、続けて書いた `\` が半分になる(anthropics/claude-code#98622)。パスを含むスクリプトは、ファイルに書いてから実行する。
- 実機のホームに対する診断は読み取りだけだが、結果に開発者の設定のパスが出る。PR の本文には、パスを伏せた要約だけを書く。
- bridge の `--check-copies` は、ホームに置いた写しからは動かず、checkout の `tools/codex-agent.sh` から実行する必要がある。ホームの写しから実行すると、終了コード 2 で JSON を出さない。
- bridge の `--check-copies` は、`HOME` と `USERPROFILE` が違う環境では、フックが使う写しと照合先が異なる(bridge の `docs/gpt-agents.md` の「配置済みの写しを照合する」)。
- ai-cross-review の SKILL の正本は、`.gitattributes` で LF に固定されている(ktysne/ai-cross-review#88)。固定より前に取り出した checkout には CRLF の SKILL が残るので、照会がすべての配布先を `stale` と返すことがある。その checkout では SKILL を削除して `git checkout --` で取り出し直す。

## 次のセッションの開始用プロンプト

```text
docs/handover/2026-10-20-tool-update.md を読み、「現在地と次にやること」から再開してください。
```
