# Codex の行の検出の不具合 4 件の計画(2026-10-19)

2026-10-19 に起票された #633〜#636 を直す計画である。
起点のコミットは main の 02487e17 である。
4 件とも、Issue に書かれた原因をコードで確かめた。
#596(push の直後の CI 判定)は [バグ傾向の計画](2026-10-19-bug-trend.md) で扱うので、ここには含めない。

## 現在地と次にやること

4 件のうち 2 件(#636、#633)が main に入った。
#635 はクロスレビューの往復中で、2 往復目の指摘 3 件に対応している。
#634 は #636 の上で実装し、PR を作ってクロスレビューに回す。#636 が main に入ったので base は main にする。

## 決定済みの判断

| 項目 | 決定 | 理由 |
|---|---|---|
| 進め方 | #636 と #634 はスタックで積み、#633 と #635 は main から別の worktree で並行に進める | #636 と #634 は `src/hooks/event.js` の起動の判定と結果行の取り出しを続けて触る。#633 は `src/hooks/route.js`、#635 は `src/server/session-projection.js` の区切りの処理だけを触り、ほかと重ならない |
| 各 Issue の対応 | Issue の「どう対応する」に従う | 原因と対応の案をコードで確かめ、食い違いが無かった |
| #635 の拒否の扱い | 区切りで完了を受けていない前面の起動は消さずに隠し、完了通知、run 行、`--wait` の引き継ぎで戻す。戻した起動の時刻で委譲した thread を付け直す | PostToolUse は非同期で欠けることがあり、消すと後の run 行から起動を引き取る既存の回復ができないため |
| #634 の割り当ての条件 | 実行 ID の無い結果行は、出力ファイルを読んだ応答(背景タスク ID の印がある)に限って背景の行へ割り当てる | 実行 ID も出所の印も無い結果行は、文書の引用と区別できないため。`--wait` とラッパーの全文の出力には run 行が入るので、実行 ID の経路で割り当てられる |

## 対応順序、ブランチ、PR

| 順 | Issue | 主な変更先 | 区分 | ブランチ | base | 状態 |
|---|---|---|---|---|---|---|
| 1 | #636 | `src/hooks/event.js` の `extractCodexLaunchDefinition`、`extractCodexReviewDefinition` | standard | `claude/fix-636-launch-detection` | main | PR #638 でマージ済み |
| 2 | #634 | `src/server/session-projection.js` の結果行の割り当て | hard | `claude/fix-634-result-origin` | main | 実装済み、レビュー前 |
| - | #633 | `src/hooks/route.js` | standard | `claude/fix-633-route-scope` | main | PR #640 でマージ済み |
| - | #635 | `src/server/session-projection.js` の `applyToolBatch` | hard | `claude/fix-635-denied-launch` | main | PR #639 でレビュー中 |

## 判断待ち

- #633 で `codex-review` を `review` の値に従わせると、claude-codex-bridge の文書(経路 Claude で `codex-review` が止まったら `review-claude` でレビューする、という記述)が合わなくなる。bridge 側の修正は別のリポジトリの作業なので、#633 のマージの後に起票するかを開発者が決める。

## 落とし穴

- 手で作った worktree のパスを依頼文に書いて担当に渡すと、窓口が Codex をセッションの作業ディレクトリで動かすことがある(#635 の最初の委譲で観測)。Agent ツールの `isolation: "worktree"` でも、担当の `bash` の起動が隔離の検査で拒否されることがある(#634 で観測)。並行させた担当は、報告の `codex-agent: agent=` の行の `workdir=` で作業場所を確かめる。
- 非同期のフックは届く順が入れ替わる。#635 で PostToolBatch を区切りに使うときは、遅れて届いた PostToolUse で本物の前面の起動を消さないことを確かめる。
- #634 の割り当ての絞り込みは、#86 で拾いたかった「背景の出力ファイルを Read で読んだときの結果行」を残す必要がある。

## 次のセッションの開始用プロンプト

```text
docs/handover/2026-10-19-codex-rows.md を読み、表の状態を gh で確かめてから、状態が「実装中」か「未着手」の最初の行の対応を続けてください。
```
