# Codexの質問回答PoC

[Issue #160](https://github.com/ktysne/agent-cockpit/issues/160)の最小試作。
調査結果と採否は[検証記録](../../docs/poc-codex-160.md)にまとめる。
本番のサーバー、ダッシュボード、通常HOMEと既存bridgeには接続しない。

## 共通質問モデル

`decision-model.js`の`DecisionQuestionsBroker`は、通常判断の登録、回答、期限と配送状態をメモリー上で管理する。
登録の識別子はhost、HOME scope、native threadとrequest IDの組み合わせである。
同じ登録を再送しても期限を延長せず、異なる内容の同ID登録を拒否する。

質問は1〜3問で、各問に単一選択または複数選択、0〜6個の選択肢と自由記入の可否を指定する。
選択肢がない場合は自由記入を有効にする必要がある。
回答はすべての質問について登録順に渡す。
未対応の形式を単一選択へ変換しない。

離席期限は登録時刻から1〜30分で、期限ちょうどを期限到達として扱う。
現在も離席中で、すべての質問が単一選択で明示的な推奨を持つ場合だけ、推奨を仮適用する。
推奨を選択肢の文言から推測せず、部分的な自動回答もしない。
保留は期限を延長しない。
離席解除中は仮適用せず、再び離席した場合は次の期限照合で評価する。

`chosen`は利用者の選択、`provisional`は推奨の仮適用である。
仮適用後の遅い回答を別に記録し、同じ質問への再適用には使わない。
元UIとダッシュボードの回答は同じ勝敗判定を通す。
質問内容を取得できない外部解決は`external_resolved`とし、未受領の配送を無効にする。

配送の`claimDelivery`と`acknowledgeDelivery`は別の操作である。
このモデルはRPCの送信、受領確認の観測、永続化と再送を実装しない。
選択回答と推奨の仮適用は、配送の受領確認前ならキャンセルできる。
回答の履歴を残して配送を無効にし、その後のclaimとackを拒否する。
受領確認済みの回答は取り消さない。
登録で受け付ける`common_mcp`と`ordinary`は内部契約であり、呼び出し元の認証ではない。
実行許可、ネットワーク許可とアプリ操作の許可は登録対象から除外する。

## 状態試験

```powershell
node --test --test-isolation=none poc/codex-questions/decision-model.test.js poc/codex-questions/mcp.test.js poc/codex-questions/native.test.js poc/codex-questions/native-exec.test.js
```

1・5・30分の期限前、期限ちょうどと期限後は注入時計で検証する。
実時間の30分待機、ネイティブUIの競合とMCP timeoutを、この試験の成功として扱わない。

## 実測の扱い

ネイティブ質問と共通MCPの実測は、専用HOMEと固定応答fixtureで行う。
実行中の質問本文、自由記入、認証情報と生のHTTP本文を成果物に保存しない。
実測のコマンド、結果と未確認の範囲は検証記録へ追記する。

共通MCPは`questions_register`と`questions_poll`を公開する。
登録とpollには同じ`requestId`を使い、再試行でも変えない。
threadはCodexが付ける`params._meta.threadId`から、hostとHOME scopeは起動元の内部設定から取る。
呼び出し引数では宛先、由来、分類と離席状態を変更できない。
登録と期限の評価で状態を変更するため、両ツールの`readOnlyHint`は`false`である。
これはツール実行の承認設定とは別の情報であり、実行許可を回答する機能は持たない。

## runnerと対応範囲

`run-common-mcp.js`は共通MCPの選択回答、時計注入による推奨、実時間のtimeoutを別々に測定する。
`native-runner.js`は所有する専用app-serverでPlan／Defaultを指定し、固定fixtureの既知の呼び出しにだけ回答する。
`run-native-exec.js`はDefaultのexecでネイティブ質問が宣言されることと、呼び出し時の拒否を区別する。
0.160.0のPlanでは単一の選択回答と自由記入を確認した。
non-blocking、実TUIでの表示と元UIとの競合は未確認である。

各runnerには対象版の`--codex-path`と、未使用の`poc/out/`配下の`--out`を指定する。
専用HOMEとローカル固定Responses fixtureを作り、通常の認証情報をコピーしない。
回答本文や生RPCは保存せず、識別、状態、時間と照合結果だけを記録する。
具体的な再現コマンドと期待・実測結果は[検証記録](../../docs/poc-codex-160.md)を参照する。
