# Codex の行の検出の不具合 4 件の計画(2026-10-19)

2026-10-19 に起票された #633〜#636 を直す計画である。
起点のコミットは main の 02487e17 である。
4 件とも、Issue に書かれた原因をコードで確かめた。
#596(push の直後の CI 判定)は [バグ傾向の計画](2026-10-19-bug-trend.md) で扱うので、ここには含めない。

## 現在地と次にやること

#636、#633、#635 を、それぞれの worktree で並行に実装している。
#634 は #636 の上に積むので、#636 の実装が終わってから着手する。

## 決定済みの判断

| 項目 | 決定 | 理由 |
|---|---|---|
| 進め方 | #636 と #634 はスタックで積み、#633 と #635 は main から別の worktree で並行に進める | #636 と #634 は `src/hooks/event.js` の起動の判定と結果行の取り出しを続けて触る。#633 は `src/hooks/route.js`、#635 は `src/server/session-projection.js` の区切りの処理だけを触り、ほかと重ならない |
| 各 Issue の対応 | Issue の「どう対応する」に従う | 原因と対応の案をコードで確かめ、食い違いが無かった |

## 対応順序、ブランチ、PR

| 順 | Issue | 主な変更先 | 区分 | ブランチ | base | 状態 |
|---|---|---|---|---|---|---|
| 1 | #636 | `src/hooks/event.js` の `extractCodexLaunchDefinition`、`extractCodexReviewDefinition` | standard | `claude/fix-636-launch-detection` | main | 実装中 |
| 2 | #634 | `src/hooks/event.js` の `makeHookEvent`、`src/server/session-projection.js` の結果行の割り当て | hard | `claude/fix-634-result-origin` | 1 | 未着手 |
| - | #633 | `src/hooks/route.js` | standard | `claude/fix-633-route-scope` | main | 実装中 |
| - | #635 | `src/server/session-projection.js` の `applyToolBatch` | hard | `claude/fix-635-denied-launch` | main | 実装中 |

## 判断待ち

- #633 で `codex-review` を `review` の値に従わせると、claude-codex-bridge の文書(経路 Claude で `codex-review` が止まったら `review-claude` でレビューする、という記述)が合わなくなる。bridge 側の修正は別のリポジトリの作業なので、#633 のマージの後に起票するかを開発者が決める。

## 落とし穴

- 非同期のフックは届く順が入れ替わる。#635 で PostToolBatch を区切りに使うときは、遅れて届いた PostToolUse で本物の前面の起動を消さないことを確かめる。
- #634 の割り当ての絞り込みは、#86 で拾いたかった「背景の出力ファイルを Read で読んだときの結果行」を残す必要がある。

## 次のセッションの開始用プロンプト

```text
docs/handover/2026-10-19-codex-rows.md を読み、表の状態を gh で確かめてから、状態が「実装中」か「未着手」の最初の行の対応を続けてください。
```
