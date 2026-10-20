# 連携ツールの更新と反映の計画(2026-10-20)

Issue #534(段階 1)、#671(段階 2a)、#673(段階 2b)の計画である。利用者が、連携ツール(ai-cross-review、claude-codex-bridge)も含めて、最新のツールを簡単に使える状態にすることを最終目標にする。
起点は main の 558e7480 である。
各リポジトリが `tools/cross-review.sync.json` で取り込む ai-cross-review の写しは、リポジトリの中身でホームの設定ではないので、対象に入れない。
3 ツールの構造改善の計画(#669)の「配置済みの写しの更新」の系列にあたり、#669 の共通ルールに従う。

## 現在地と次にやること

段階 1(診断)は終わった。仕様の正本は [導入の整合の診断の設計](../design/doctor.md) である。
次は段階 2a(#671)である。最初に #671 の「設計で決める点」を決め、この資料の「決定済みの判断」に足してから実装に入る。最初の PR には、Codex のホームの解決の集約を入れる。
段階 2b(#673)は、#671、ktysne/claude-codex-bridge#169、ktysne/ai-cross-review#87 がそろった側から進める。

## 決定済みの判断

| 項目 | 決定 | 理由 |
|---|---|---|
| 最終目標 | 診断で終えず、更新と反映まで支える(開発者の決定、2026-10-20) | 利用者が手で照合して直す手間を無くすため |
| 段階 | 1 診断、2 更新と反映、3 ダッシュボードの入口。2 と 3 は段階 1 の後に別の Issue で起票する | 診断の出力の形を固めてから、適用の処理を作るため |
| 再起動待ちの帯のボタン | 「/update-tools スキルでの更新依頼プロンプトをコピー」(#664)はつなぎで、段階 3 でより良い形に置き換えてよい(開発者の決定、2026-10-20) | 段階 3 で、ダッシュボードから更新を始められるようにするため |
| 段階 1 の範囲 | agent-cockpit 自身のフック、MCP、スキル、常駐サーバーに限る。出力の項目には `tool` を持たせ、bridge と ai-cross-review は段階 2 以降に足す | bridge は `CLAUDE_CONFIG_DIR` を見ないなど、ホームの解決の規則が別で、照合の設計が倍になるため |
| 期待値の正本 | `src/shared/integration-manifest.js` に置き、導入手順の JSON と TOML の例との一致をテストで縛る | 段階 2 の適用も同じ期待値を使うため。導入手順を生成物にすると、周りの説明と例が離れて読みにくくなるため |
| 照合する checkout | `--root`、登録済みのフックが指す checkout、診断を置いた checkout(worktree なら元の checkout)の順に決める | worktree から実行したときに、すべてのフックが別の checkout として不一致になるのを避けるため |
| 対処の形 | 配列の添字ではなく一致の条件で要素を指し、書き換える対処には観測したファイルの sha256 を付ける | 利用者の独自のフックが混ざり、添字は読み直すたびに変わるため。適用の直前に変わっていないかを確かめるため |
| セッションの開き直し | 開始時刻と更新時刻では判定せず、不一致があるときに開き直しの案内を必ず添える | 同じ内容の写し直しでも更新時刻が変わり、誤った案内が増えるため |
| ツールの立ち位置と境界 | 3 つのツールは、どれも単体で導入して完結して使え、連携は任意にする。連携の観点の改善でも、各ツールの役割の境界を曖昧にしない(開発者の決定、2026-10-20) | どれも単独で使う環境があるため |
| 段階 2 の分け方 | 2a(#671)は agent-cockpit の項目の適用、checkout の更新、Codex のホームの解決の集約。2b(#673)は bridge と ai-cross-review の写し(開発者の決定、2026-10-20) | 連携ツールの写しの照合には、そのツールだけが決めている解釈が要るため |
| 連携ツールの写しの照合 | agent-cockpit で解釈せず、各ツールの照会の入口(claude-codex-bridge#169、ai-cross-review#87)の結果を写す。照会を持たない古い版は `unverified` にし、独自の照合に戻らない | 照合の規則を各ツールの中だけに置き、規則が変わっても直す場所を 1 つにするため |
| ai-cross-review の写しの反映 | ai-cross-review の一括配布の CLI に任せず、#671 の適用で選んだ配布先だけに置く | 今の CLI は配布先を選べず、写しの無い配布先にも置くため |

## 対応順序、ブランチ、PR

| 順 | 対象 | 主な変更先 | 委譲の区分 | ブランチ | base | 状態(2026-10-20 に確認) |
|---|---|---|---|---|---|---|
| 1 | #534 段階 1 診断 | `src/client/doctor.js`、`src/shared/integration-manifest.js`、`docs/setup.md`、`docs/update.md` | hard | `claude/integration-doctor` | main | PR #670。マージ済み、#534 は閉じた |
| 2 | #671 段階 2a 適用、checkout の更新、Codex のホームの解決の集約 | `src/client/doctor.js`、`src/server/identity.js`、`src/server/server.js`、`skills/update-tools/SKILL.md` | 未定 | 未定 | main | 起票済み、未着手 |
| 3 | ktysne/claude-codex-bridge#169 写しの照会 | bridge の `tools/codex-agent.sh` | bridge 側 | 未定 | bridge の main | 起票済み、#167 の後 |
| 4 | ktysne/ai-cross-review#87 グローバル SKILL の確認 | ai-cross-review の `tools/cross-review.sync-all.js` | ai-cross-review 側 | 未定 | ai-cross-review の main | 起票済み、未着手 |
| 5 | #673 段階 2b 連携ツールの写し | `src/client/doctor.js`、`skills/update-tools/SKILL.md` | 未定 | 未定 | main | 起票済み、2〜4 の後 |
| 6 | 段階 3 ダッシュボードの入口 | 未定 | 未定 | 未定 | main | 未起票 |

## 落とし穴

- Windows の Bash ツールでは、続けて書いた `\` が半分になる(anthropics/claude-code#98622)。パスを含むスクリプトは、ファイルに書いてから実行する。
- 実機のホームに対する診断は読み取りだけだが、結果に開発者の設定のパスが出る。PR の本文には、パスを伏せた要約だけを書く。

## 次のセッションの開始用プロンプト

```text
docs/handover/2026-10-20-tool-update.md を読み、「現在地と次にやること」から再開してください。
```
