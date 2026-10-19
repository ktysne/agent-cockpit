# レビュー状態とコマンド解析の経路の計画(2026-10-20)

2026-10-20 の 3 リポジトリ横断調査で起票した 4 件(agent-cockpit の #656、#657、#658 と、claude-codex-bridge の #164)の対応の計画である。
起点は agent-cockpit が main の c6bf2320(v1.8.0)、claude-codex-bridge が main の 7a6422d である。
ai-cross-review の正本のスキルは変えない。変える必要が出たら、別の PR として ai-cross-review で起票する。

## 現在地と次にやること

計画を立てた段階である。
次のセッションは、下の表の状態の列を `gh pr view` で確かめ、未着手の最初の行から再開する。

## 決定済みの判断

| 項目 | 決定 | 理由 |
|---|---|---|
| PR の単位 | Issue ごとに 1 つの PR にする | 不具合ごとにクロスレビューとマージの判断を分けるため |
| スタック | #657 を下、#656 を上に積む。#658 と bridge #164 は各リポジトリの main から作る | #657 と #656 はどちらも `recalculateReviewGroups` と PR ごとのレビュー状態の形を変えるため。#656 の「今の head を覆う記録が無い」の判定は、#657 で足す競合の状態を前提にするため |
| レビューの観点 | 両リポジトリの `.cross-review.md` に「同じ情報を扱う別の経路」の観点を足す | 1 つの経路を直しても、同じ情報を扱う別の経路に問題が残る傾向があったため |
| #657 の選び方 | 候補の記録を全部集めてから 1 回だけ選ぶ。記録ごとに今の head での結論(converged、halted、fixing、進行中、古い head)を 1 つの関数で分類する | 登録ごとに選んでから登録どうしを比べ直すと、登録の中で見つけた競合が比べ直しで消えるため。走査の順で結果を変えないため |
| #657 の競合の条件 | 今の head の converged と、今の head の halted か fixing が混在したら、round に関係なく競合にする。今の head のレビュー中(結論の無い往復)は、収束した round より大きい round のときだけ競合にする | 同じ round のレビューと結論が別の worktree に分かれて記録されることがあり、その組み合わせは競合ではないため。halted と fixing は、独立した worktree の round では前後を決められないため |
| #657 の代表の記録 | 競合のときは、代表を止める側(halted、fixing、進行中、converged の順)にし、`conflict` に記録元の worktree、round、SHA、結論の一覧を付ける | 画面と予約マージには `triage` を直接読む写しがあり、`conflict` を読まない経路も安全側に倒すため |
| #657 の予約マージ | 競合のあいだは予約を取り消さずに待つ。競合の無い halted は今のまま取り消す | 競合の halted は古い記録のことがあり、取り消しは戻せないため |
| #657 の不要記録 | 不要記録は今のまま競合も上書きし、`conflict` の一覧は残して見せる | 不要記録は head を確かめた明示の判断で、競合を解く手段にもなるため |
| #657 の解消の手段 | カードに記録元の一覧と、古い worktree の記録を消すか不要記録で確定する案内を出す。ダッシュボードから別の worktree のファイルを消す操作は作らない | 書き込みの口を増やさないため |
| #656 の催促の対象 | 今の head を覆う記録(今の head の結論か今の head のレビュー中の往復、今の head の不要記録か保留の記録)が無い PR。確認できない値、道具なしの不要、競合は対象にしない | 古い head の記録だけでは、今の head の確認を終えたことにならないため |
| #656 の再催促 | ACK は配信済みにするだけにする。同じ head でも、新しい UserPromptSubmit の後か、最後の配信から 30 分後の Stop で再び催促し、同じセッションと head で 3 回までにする | 自走中は UserPromptSubmit がほぼ来ないため。Stop を無制限に繰り返さないため |
| #656 の未記録の表示 | 未記録は保存せず、今の記録から導いて PR カードに次の操作と一緒に出す | 記録と状態ファイルから導けるので、保存すると食い違う値が増えるため |
| #656 の保留 | 新しい MCP ツール `cockpit_defer_review` で、理由と次の作業を必須にして記録する。保存は `store.json` の新しいキー `crossReviewDeferrals` にし、同じ head の不要記録とは排他にする。保留はマージの条件を満たさない | 不要と保留を同じツールの引数で分けると、エージェントが取り違えやすいため。既存の `crossReviewSkips` の形を変えないため |
| #656 の区別 | レビュー実施中と開発者の回答待ちは、状態ファイルと waiting の判断事項から導く。通信不能はサーバーから観測できないので、MCP の失敗応答で完了報告に書くよう伝える | 保存する状態を増やさないため |

## 対応順序、ブランチ、PR

| 順 | 対象 | 主な変更先 | 委譲の区分 | ブランチ | base | 状態(2026-10-20 に確認) |
|---|---|---|---|---|---|---|
| 1 | agent-cockpit #657 worktree 間の記録の競合 | `src/server/pull-requests.js`、`src/server/pull-request-merge.js`、`src/web/index.html`、`mock/index.html` | hard | `claude/fix-657-review-conflict` | main | 未着手 |
| 2 | agent-cockpit #656 レビュー不要の記録の未完了 | `src/server/decision-answers.js`、`src/server/pull-requests.js`、`src/mcp/server.js`、`skills/agent-cockpit/SKILL.md` | hard | `claude/fix-656-review-pending` | 1 | 未着手 |
| 3 | agent-cockpit #658 シェルの解析の不一致 | `src/hooks/event.js`、`src/hooks/route.js`、`src/server/pull-request-utils.js` | hard | `claude/fix-658-shell-commands` | main | 未着手 |
| 4 | claude-codex-bridge #164 stderr を保持する子孫で終了を待ち続ける | `tools/codex-agent.sh` | hard | `fix/issue-164-stderr-holder` | main | 未着手 |

base の列の数字は、表の順の PR のブランチを指す。

## 同じ情報を扱う経路

各 Issue で、次の経路をすべて同じ規則にそろえる。
実装とレビューでは、1 つの経路だけを直していないかを確かめる。

- PR の head ごとのレビュー状態(#657、#656):
  - 記録を選ぶ合流点は 3 つある。同じ worktree 群の走査(`readCrossReviewStateAcrossWorktrees`)、remote が一致しないときの別の checkout の走査(同じ関数の `repository-mismatch` の分岐)、同じ PR の登録どうしの比較(`recalculateReviewGroups`)。
  - 状態を読む側は 5 つある。PR カードの待ち理由(`crossReviewWaitReason`、`mergeConditionWaits`)、マージの条件(`crossReviewConvergedAtHead`)、予約マージ(`reservationMergeInput`)、Stop の催促(`missingReviewRecords`)、不要記録の重ね合わせ(`recalculateReviewGroups`)。
  - 催促を配る経路は 3 つある。Claude の `stop-poll`(`waitForStopAnswer`)、`stop-check`(`checkStop`)、Codex の Stop(`checkStop`)。
- 実行されるコマンドの抽出(#658):
  - Codex の起動の検出(`extractCodexLaunchDefinition`、`extractCodexWaitRunId`)、レビューの起動の検出(`extractCodexReviewDefinition`)、経路の制御(`commandInvokesCodexAgent`)、PR の作成とマージの検出(`commandSegmentParts` を使う関数)。
  - Bash と PowerShell の両方のツール、シェルの `-c` の中、コマンド置換の中。
- Codex の実行の終わり(#164):
  - 本体の終了コード、最終回答の保存、標準エラーの収集、猶予を超えたときの停止、`--wait` での後からの照合。

## 落とし穴

- `.claude/skills/cross-review/SKILL.md` は ai-cross-review からの同期の写しである。この計画では編集しない。
- 予約マージは、開発者がダッシュボードで予約したときだけ動く。テストで実際の `gh pr merge` を起動しない。

## 次のセッションの開始用プロンプト

```text
docs/handover/2026-10-20-review-state-paths.md の計画に沿って、4 件の Issue の対応を続けてください。
表の状態の列を gh で確かめてから、未着手の最初の行に着手してください。
レビューでは、計画の「同じ情報を扱う経路」をレビュアーに渡してください。
```
