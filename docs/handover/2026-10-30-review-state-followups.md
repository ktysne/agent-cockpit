# クロスレビューの状態の扱いの改善の計画(2026-10-30)

agent-cockpit の #717 から #720 と、ai-cross-review の #106 から #108 を、2 つのセッションで並行して対応する計画である。
起点は agent-cockpit の main `76ab4084`、ai-cross-review の main `a1965d4` である。
どの Issue も、session-score-player と riff-trainer の並行作業で見つかった表示と記録の食い違いが元になっている(riff-trainer の PR #354、#356、#366、#367、session-score-player の PR #492)。
対象から外したものは無い。

## 現在地と次にやること

- 管理は agent-cockpit の管理セッションが行い、実装は次の 2 つのセッションが行う。
  - セッション A(agent-cockpit): #720 → #718 → #719 → #717 の順に、スタックで PR を積む。
  - セッション B(ai-cross-review): #106 → #108 → #107 の順に、スタックで PR を積む。
- A は A1(#721)が収束してマージ待ち。A2(#718)を実装中。
- リポジトリをまたぐ依存は「判断待ちと受け渡し」の節に書いた 2 点だけである。

## 決定済みの判断

| 項目 | 決定 | 理由 |
|---|---|---|
| セッションの分け方 | リポジトリごとに 1 セッション | 2 つのリポジトリは変更するファイルが重ならない。同じリポジトリの Issue は同じファイル(`src/shared/review-evaluation.js`、`src/server/pull-requests.js`)を触るため、1 セッションで直列に積むほうが競合しない |
| A の順序 | #720 → #718 → #719 → #717 | #720 と #718 は同じ `reviewDisplay` まわりを触るので、小さい #720 を先に入れる。#719 は `review.mergeCondition.met` を一括マージの条件に使うので、その値を変える #718 の後にする。#717 は B の #106 で決まる共有の状態ファイルの置き場を読む必要があるので最後にする |
| B の順序 | #106 → #108 → #107 | #106 は状態ファイルの契約(`docs/contracts/cross-review-state.md`)を変え、A の #717 がそれを待つので最初にする。#108 もコメントの形を契約に書くので #106 の後にする。#107 の SKILL の手順は agent-cockpit の #718 の振る舞いを前提に書くので最後にする |
| #717 の範囲 | Issue に書いた断片の統合に加え、#106 で決まる共有の状態ファイルも読む | #106 は「agent-cockpit の読み込み側と同じ版で入れる」としている。共有のファイルを読まないと、#106 の後に記録したブランチが cockpit から見えなくなる。断片の統合は、#106 より前に分かれた記録と古い版の ai-cross-review のために残す |
| マージ | 開発者がダッシュボードで確認したときだけ行う。セッションはマージしない | agent-cockpit の CLAUDE.md「守ること」 |
| 進め方 | 両セッションとも自走で、Issue ごとに PR を作りクロスレビューを回す | 開発者が並行対応を任せたため。判断が要る事項は推奨を仮に適用し、最後の報告に書く |

## 対応順序、ブランチ、PR

| 順 | リポジトリ | Issue | 主な変更先 | 委譲の区分 | PR | base | 状態 |
|---|---|---|---|---|---|---|---|
| A1 | agent-cockpit | #720 | `src/shared/review-evaluation.js` | standard(メインセッションが直接実装) | #721 | main | 1 往復で収束、マージ待ち(2026-10-30) |
| A2 | agent-cockpit | #718 | `src/shared/review-evaluation.js`、`src/server/pull-requests.js`、停止のフック | hard | 未作成 | A1 | 実装中(2026-10-30) |
| A3 | agent-cockpit | #719 | `src/server/pull-requests.js`、`src/server/pull-request-merge.js`、`src/web/index.html` | hard | 未作成 | A2 | 未着手(2026-10-30) |
| A4 | agent-cockpit | #717 | `src/server/pull-requests.js`、`docs/design/server.md`、契約の取り込み | hard | 未作成 | A3 | 未着手(2026-10-30) |
| B1 | ai-cross-review | #106 | `tools/cross-review.js`、`docs/contracts/cross-review-state.md`、`docs/migrations/` | hard | 未作成 | main | 未着手(2026-10-30) |
| B2 | ai-cross-review | #108 | `tools/cross-review.js`(`buildRoundComment`、`buildMetaSummary`)、契約 | standard | 未作成 | B1 | 未着手(2026-10-30) |
| B3 | ai-cross-review | #107 | `tools/cross-review.js`(`resolveBaseSelection`)、`.claude/skills/cross-review/SKILL.md`、`docs/cross-review.md` | hard | 未作成 | B2 | 未着手(2026-10-30) |

## 判断待ちと受け渡し

- B1 で、共有の状態ファイルの置き場とロックの方式を決める。推奨は `git rev-parse --git-common-dir` の下に 1 つのファイルを置き、ロックファイルを排他で作ってから読み直して書く形である。決めたら契約に書き、管理セッションへ知らせる。管理セッションが A4 に渡す。
- A4 は、B1 の契約を `tools/import-cross-review-contract.js` で取り込んでから読み込み側を作る。B1 がマージされていなければ、B1 の PR のブランチの契約を見て実装し、取り込みは B1 のマージ後に行う。
- B3 の SKILL の文面(競合の無い取り込みでは記録不要)は、A2 の判定がその通りに入ることを前提にする。A2 の設計が Issue と変わったら、管理セッションが B3 に知らせる。

## 落とし穴

- `.cross-review-state.json` は worktree ごとに置かれる(B1 が直すまで)。レビューと `comment --outcome` は同じ worktree で実行する。分けると #717 と同じ食い違いを自分で起こす。
- ai-cross-review の `E:\Develop\ai-cross-review` は、upstream の消えた `feat/comment-outcome-warning` にいる。作業ブランチは `origin/main` から切る。
- agent-cockpit の全体のテストは約 5 分かかる。時間切れは 10 分以上にする。
- Windows の Bash ツールではバックスラッシュが半分になる(anthropics/claude-code#98622)。バックスラッシュを含むスクリプトはファイルに書いてから実行する。
