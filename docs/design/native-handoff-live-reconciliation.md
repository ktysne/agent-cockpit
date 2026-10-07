# Claude の delegated handoff と proof 再照合の実測

## 対象と範囲

この記録は、Claude Code CLI を実際に起動し、delegated child の handoff 後に proof を再照合した短時間試験を記録する。
試験はソース commit `3fce4d4fc99655ac4d4e66b255acb4e51c745b1b` と Claude Code CLI `2.1.292` で行った。
3つの CLI process に隔離 HOME を割り当て、既存の native launch composition、owned runner、source collector、`cockpit_wait` MCP 経路を通した。
通常の認証情報は読み取り専用で fingerprint を比較し、ログインや設定は変更していない。

この試験が確認するのは、同一の生存中 native connection と context を使った handoff 後の proof 再照合である。
collector の disconnect/connect、provider session の reconnect、process restart 後の recovery は実施していない。
この結果を reconnect または Issue #177 全体の完了根拠として扱わない。

## 実行シナリオ

`O` は delegated child の起動元となる standalone owner、`Q` は handoff 先の standalone owner、`C` は delegated child とする。
O、Q、C の順に Claude CLI を起動し、それぞれの `cockpit_wait` を実際の native tool call として観測した。
C の originBinding が O の実行 binding と一致し、generation 0 の proof が有効な間に C を Q へ handoff した。
handoff 直後に C の旧 proof と旧 writer が無効になり、owner generation が 1 へ進み、immutable originBinding が保持されることを確認した。
O の process を停止して exit と close を確認した後、Q の standalone proof がその独立 context で有効なまま残ることを確認した。
その後、C の生存中 context を既存の `composition.reconcileProof` で再照合し、新しい proof が成立して旧 writer が引き続き拒否されることを確認した。

Q の proof は C の handoff によって必ず無効になる対象ではない。
試験では Q 自身の context に変更を加えず、その proof が維持されることを別の期待値として検査した。

## 期待値と実測

| 確認項目 | 期待値 | 実測 |
| --- | --- | --- |
| O、Q、C の native wait | 各1件を製品経路で観測する | pass |
| C の origin binding | admission 時に O の execution binding と一致する | pass |
| generation 0 handoff | Q への遷移を受理する | pass |
| C の旧 proof | handoff 直後に拒否される | pass |
| owner generation | 0 から1へ進む | pass |
| immutable origin binding | handoff と再照合を通じて変化しない | pass |
| C の current owner | handoff 後に Q の execution binding と一致する | pass |
| O の process | handoff 後の停止で exit と close を観測する | pass |
| O の proof | O 終了後に拒否される | pass |
| Q の standalone proof | O 終了後も同じ proof が有効である | pass |
| C の再照合 | generation 1 の新しい proof が成立する | pass |
| C の旧 writer | handoff 直後と再照合後の両方で拒否される | pass |

この表は成功 artifact の14個の boolean assertion を要約する。
全14 assertion が true で、scenario outcome は `observed` だった。
CLI の version pin、help query、必須 flag 検査もすべて true だった。

## 初回結果の訂正

最初の end-to-end 実行は `scenario_evidence_incomplete` で終了した。
ハーネスが `runtimeBindingSnapshot().currentProof.owner` を期待値に使っていたが、公開 projection の property は `currentProof.currentOwner` である。
owner の独立期待値は proof summary に依存させず、standalone launch record の `executionBinding` から構成するように改めた。
periodId、actor.kind、actor.id のいずれかが欠けた binding は比較前に拒否する matcher を追加した。
undefined 同士、wrong actor、missing period、missing actor、旧 owner を新 owner とみなすケースを含む9つの fake positive/negative assertion がすべて通った。
初回 unknown artifact は書き換えず、修正版 smoke は別 artifact として保存した。

## 実行証拠

| 項目 | 値 |
| --- | --- |
| source revision | `3fce4d4fc99655ac4d4e66b255acb4e51c745b1b` |
| Claude Code CLI | `2.1.292` |
| version pin | 一致 |
| `--help` query | 成功 |
| 必須 launch flags | すべて確認 |
| 成功 harness SHA-256 | `0EAE91B092A6AABB7D8D6A278B2825670687FF7A99624067F50DA1E16A552AC2` |
| 成功結果 SHA-256 | `7D115F835948455297768E20841C5507CBFDEA39B52149BFCBA7C3DEB6EA4EC0` |
| 初回 unknown 結果 SHA-256 | `432B0A4E4C3D54C0263E2A65D4AD4192A83EAC2FC49986B78D08A5BE7D81720B` |
| 成功結果 artifact | `claude-delegated-handoff-live-results-d361985a-71e5-47cf-97fd-9716aa8639e0.json` |
| 初回 unknown artifact | `claude-delegated-handoff-live-results-bac8c6bf-b4b4-4f75-a3e5-3fbf0287de27.json` |
| B worktree の凍結 artifact | `.cross-review/pr177-native-handoff-runtime/handoff-success-frozen-d361985a/manifest.json` |
| 調整 worktree の mirror | `.cross-review/b-handoff-observed/manifest.json` |

ハーネスは PR #200 の manifest で照合した `2.1.291` 版のコピーを基にした。
元の PR #200 artifact は保持し、検証用コピーだけを現在の `2.1.292` へ固定した。
version gate は残し、`--version`、help query、必須 flag の3結果を分けて記録した。
実 native tool call の観測で、固定 launch profile と wait protocol がこの CLI で動作したことも確認した。

通常認証の fingerprint は実行前後で一致した。
秘密 payload artifact は0件で、生の native actor metadata は観測も保存もしていない。
3 child の exit と close、wait endpoint 停止、collector disconnect、end observer 復元、timeout 解放、全 isolated HOME の削除を確認した。
保全した HOME はなく、終了後の Claude process count は0だった。
製品 source は実行前後で安定していた。

ハーネス全体は ignored evidence の一部であり、この repository に巨大な harness copy は追加しない。
9 assertion の self-test はハーネス内の matcher を検証するために置き、同じ判定ロジックだけを別の tracked test に複製しない。
製品側の fixture coverage は `test/native-launch-composition.test.js` と `test/runtime-binding.test.js` にあり、実 CLI smoke は process-level の追加証拠として扱う。

## Issue #177 の recovery 接続条件

schema 1 の checkpoint は kernel を復元せず、active execution を `unknown` として扱う。
schema 1 は startId、完全な registration と launch binding、connection の復元根拠、handoff 再生に必要な完全 fingerprint を保持しないため、受動履歴としてだけ読み込み、live recovery には使わない。
schema 1 から後続 schema へ変換するときも、欠けた claim を推測して補わず、既存項目を履歴として保持する。
live recovery 用 schema は、trusted runtime observation から必要な claim と replay fingerprint を新規に確定できる形式として版を上げる。
既存の resume API は `ended` のみを再開対象としており、`unknown` から proof を発行する入口はない。

保存 claim 自体を provider authority に昇格させず、fresh provider evidence が得られるまで delivery を止める。
attempt または handoff の transition は durable store への commit 成功後に限って proof、writer、delivery entrance を公開する。
commit 失敗時は authority を公開せず、同じ transition を成功済みとして推測しない。

| 要件 | 接続条件 |
| --- | --- |
| snapshot 復元 | 新 kernel へ一度だけ全 snapshot を検証し、全件検証後に反映を始める |
| active execution | status を `unknown` にし、connection を inactive にする |
| 終了記録 | ended tombstone と owner generation を単調に保持する |
| 秘密 capability | proof、token、actor handle、connection handle、source lease、currentProof を復元しない |
| same-period 再照合 | 保存 claim と区別された API で、fresh provider observation を要求する |
| new-period 開始 | same-period 再照合と別 API にし、利用者または正規の新規起動を通じて明示する |
| attempt replay | attempt claim と完全な idempotency fingerprint を永続化し、不一致を拒否する |
| handoff replay | launch、旧 owner、新 owner、期待世代、新世代、immutable execution claims を含む fingerprint が一致する場合だけ再生する |
| transition commit | attempt または handoff の durable commit が成功した後でだけ authority を公開する |
| 配信開始 | source、owner、proof の再検証と durable transition commit が完了した後に限る |

handoff receipt に必要な fingerprint が保存されていない場合、同じ handoff ID の再利用を成功と推測しない。
終了済み actor や execution を active に戻さず、unknown を registration API で昇格させない。

完成条件には、実 file store を close して reopen する試験と、fresh kernel、Claude adapter、Codex adapter の両方を使う適合試験が要る。
旧 proof と旧 connection が拒否されること、owner generation と ended tombstone が保持されること、fresh evidence 前の delivery が0件であることを観測する。
attempt の同一 fingerprint は一度だけ反映され、不一致 fingerprint は拒否されることを確認する。
この実 runtime smoke は file-store restart、kernel restore、attempt replay、handoff receipt replay を検証していない。

## 再接続の短時間実測

Claude Code CLI `2.1.292` の単一 owned process を起動し、native wait 中に owned source collector を disconnect/connect した。
試験時のsource revisionは `620c211f6e9161686cac82b8e17ee61e474bb7b1` で、product sourceは実行前後で安定していた。

| 観測 | 結果 |
| --- | --- |
| 初期 native wait、proof、writer | すべて有効 |
| disconnect 後の旧 proof、旧 writer | 両方拒否 |
| disconnect 後の旧 wait | response 前に無効化 |
| 同一 process での collector 再接続 | 接続成功、generation 1 から2へ進行 |
| reconnect 後の Claude source read | `unsupported` |
| fresh context 前の proof | なし |
| fresh context 前の `composition.reconcileProof` | proof を発行しなかった |
| reconnect 後の2回目の native wait/context | 観測なし。旧 wait が無効で次の prompt step に進めなかった |
| process restart | 試していない。owned process の再spawnは0 |
| native delivery dispatch | probeからの呼出し0 |
| outcome | `unknown`、reason `reconnect_wait_invalidated` |

collector disconnect 自体では owned Claude process は動作中のままだった。
旧 wait が無効化されたため、waitを解放して次の native context を要求する操作は行わず、scenario cleanup で owned process を停止した。
fresh context後の proof、旧 proof/writerの継続拒否、product delivery transportの実dispatch件数は未確認である。
この結果は reconnect 成功または Issue #177 の完了を示さない。

## 再接続の実行証拠

| 項目 | 値 |
| --- | --- |
| source revision | `620c211f6e9161686cac82b8e17ee61e474bb7b1` |
| Claude Code CLI | `2.1.292` |
| reconnect harness SHA-256 | `1A7F0EA65809BDE2964025CFF62137F47D92E6E8C1A00133A0DCA4B000A00112` |
| sanitized result SHA-256 | `A34E3B3FC85B5BB5000272746FB101A7F671CEF57B9D24C3108F79B31F948E96` |
| sanitized result artifact | `.cross-review/pr177-native-handoff-runtime/claude-owned-wait-live-results-b5819aa9-226b-40cd-b3d0-14ec44e06593.json` |
| reconnect evidence addendum | `.cross-review/pr177-native-handoff-runtime/reconnect-runtime-addendum.md` |
| frozen handoff harness SHA-256 | `0EAE91B092A6AABB7D8D6A278B2825670687FF7A99624067F50DA1E16A552AC2` |

最初の reconnect 試行は結果を保存できず、`result_write_failed` の unknown として扱った。
その後の専用result path write/remove preflight はsandbox内で `EPERM` となり、process count 0、隔離HOME count 0を確認した。
保存済み結果はこの初回試行を置き換えず、昇格実行で行った別試行の unknown を記録している。

## 再接続試験のcleanup

| 確認 | 結果 |
| --- | --- |
| Claude process count after cleanup | 0 |
| isolated HOME count after cleanup | 0 |
| child exit / close | 確認 |
| owned child inactive / wait endpoint inactive | 確認 |
| isolated HOME removed | 確認 |
| normal authentication fingerprint | 実行前後で不変 |
| product source stability | true |
| timeout handles cleared / HTTP end observer restored | true |
| secret/private payload / nonce artifact | 0 |
| HOME preserved for unconfirmed process | なし |
