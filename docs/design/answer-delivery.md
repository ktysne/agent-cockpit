# フック回答配信の共通受付

画面とフックの応答の仕様は [server.md の「判断事項への回答」](server.md#判断事項への回答) を参照する。
この資料は、回答配信の適用条件と状態更新をどこで扱うかを定める。
セッション一覧、サブエージェント、PR 取得の状態管理は対象に含めない。

## 責務と識別情報

`DecisionAnswerDelivery.intakeHookDelivery(operation, now)` を同期的な共通受付とする。
`now` は受付時刻のミリ秒で、呼び出し側が渡す。
フックの発生時刻は `occurredAt` として別に渡す。
HTTP の入力検証と応答、フック出力の形式への変換、レビュー状態の読み取り、long-poll の待機は入口側に残す。
待機の前後では共通受付の `stop-status` で現行の実行かを確認する。

全操作に同じ識別情報を要求しない。
受付が必要とする値は次のとおりである。

| 操作 | 識別情報と条件 | 更新対象 |
| --- | --- | --- |
| `request` | session、action、request ID。stop-poll は要求の generation。Stop の再送は親の生存も照合 | 期限切れ配信記録、新規取得時の催促の取消 |
| `prepare-answers` | session、action | 配信候補の回答に version が無い場合だけ補完 |
| `response` | session、action、request ID、応答。stop-poll は要求の generation、Stop は応答の generation、ask-finish は decision ID | 配信 ID、固定した応答、回答の version、通知 ID、overflow ID、催促との対応 |
| `ack` | session、delivery ID。回答は配信記録内の decision ID と version で照合 | 回答の受領時刻と入力時の受領回数、該当通知の除去、現行の催促の受領、配信の ACK 時刻 |
| `lifecycle` | session、イベント名、発生時刻。Stop の開始は `startStop` も指定 | 最終発生時刻、Stop 世代、入力世代、終了印、催促の取消 |
| `stop-status` | session、generation、親の生存。待機では provider、再送では `replay` | 参照のみ |
| `cancel-reminders` | session、発生時刻。新規取得の区切りは `Infinity` | 未受領の催促の取消 |
| `reopen` | session、SessionStart の source があれば指定 | 配信側の終了印、終了前の質問待ち、対象 source の最終発生時刻 |

配信記録の検索、作成、ACK の更新には、既存の `getHookDelivery`、`recordHookDelivery`、`acknowledgeHookDelivery` を受付の補助として使う。
これらには受付から同じ `now` を渡す。
回答候補の選択は `answersForDelivery` にそろえ、本文の準備と配信時の version の記録で同じ条件を使う。

## 状態遷移

| 現在の状態 | 入力と適用条件 | 結果 |
| --- | --- | --- |
| 未配信の回答と通知 | 出力を含む応答を準備 | 配信記録を作る。回答と通知は未受領のまま残す |
| 配信記録あり | 同じ session、action、request ID と要求世代で再送 | 保持中の配信 ID と本文をそのまま返す |
| Stop の配信記録あり | 世代が現行でない、親が終了、サーバーが閉鎖、セッションが終了 | 空の終了応答を返す。新しい Stop の世代は変更しない |
| 配信記録なし | 空応答または待機中 | 配信記録を作らない。同じ要求で後続の回答を取得できる |
| 未 ACK の配信 | 一致する delivery ID の初回 ACK | 記録された回答の version が現在と一致する場合だけ受領を記録する。配信時に含まれた通知 ID だけ除く |
| ACK 済みの配信 | 同じ delivery ID の重複 ACK | 成功を返し、回答、入力の受領回数、通知、次の配信を更新しない |
| 回答訂正後 | 訂正前の version の ACK | 配信自体は ACK 済みにするが、訂正後の回答の受領時刻は更新しない |
| 催促を準備済み | 準備時刻より後のメインイベント、または別の取得要求 | 配信中の催促を取り消す。取消前の配信への遅い ACK は新しい催促を受領済みにしない |
| Stop の判定または待機中 | 後続の Stop、入力、終了、より新しいメインツールイベント | 世代を進め、古い待機と遅延した判定結果を終了する。回答と通知は次の配信用に残す |
| lifecycle 記録あり | 記録より古いイベント | 世代と最終発生時刻を変更しない。ツールイベントは同時刻も変更しない |
| 終了印あり | セッションの再開 | 配信側の終了印を外す。startup、resume、clear の SessionStart は最終発生時刻も消す |
| 配信記録が期限切れ | 次の取得 | 配信記録だけ除く。未受領の回答と通知は再配信できる |
| 配信記録が容量上限 | 新規配信 | ACK 済みの古い記録から除く。未 ACK だけなら 503。同じ既存要求の再送は可能 |

Stop の再送では保存側のセッション終了状態も確認する。
Codex の待機では離席解除でも待ちを終えるが、すでに作った応答の再送可否には離席状態を使わない。
この区別と、同時刻の入力または Stop を受け付ける扱いは既存の仕様を保つ。
同じ要求の再送は本文のある配信記録で識別するため、stop-start や空応答をセッション単位の終了済みフラグとして記録しない。

ACK は受領の記録であり、`reflectedAt`、判断事項の解決、レビュー不要、保留の記録を成立させない。
回答を質問に適用した後の Claude の PostToolUse や Codex の ask-finish、MCP による判断事項の更新は、それぞれの既存の業務処理に残す。

## 入口との対応

| 入口 | 共通受付への対応 | 入口に残す処理 |
| --- | --- | --- |
| Claude stop-start | `request` → `lifecycle(startStop)` | レビュー判定の非同期処理を開始し、世代を返す |
| Claude stop-poll | `request` → `stop-status` → `prepare-answers` → `response` | レビュー判定と合図を待ち、stderrText に変換する |
| Claude の非対話 Stop と Codex Stop の stop-check | `request` → `lifecycle(startStop)` → `stop-status` → `prepare-answers` → `response` | レビュー判定を待ち、block の reason に変換する |
| Claude PostToolBatch と Codex PostToolUse | `request` → `prepare-answers` → `response` | サブエージェントの除外、状態イベント、additionalContext の組み立て |
| PreToolUse の ask-finish | `request` → `response` | 質問待ちの終了、回答を updatedInput または拒否理由に変換、Codex の判断事項の解決 |
| UserPromptSubmit | `request` → `lifecycle` → `prepare-answers` → `response` | タスクの状態イベント、additionalContext の組み立て、委譲 thread の配信記録対象外の案内 |
| delivery-ack | `ack` | HTTP の検証と acknowledged 応答 |
| メインのツールイベント、入力、SessionEnd | `lifecycle` | 質問待ちとタイマーの後始末 |
| セッションの再開と SessionStart | `reopen` | セッション自体の状態管理 |

## 新しい入口の追加規則と検査

新しい入口には、共通受付を通さない配信記録、Stop 世代、最終発生時刻、配信側の終了印の直接更新を追加しない。
回答候補の version の補完と ACK による受領の更新も共通受付を経由する。
入口側は入力の変換と待機を実装し、配信可否、重複、取消の条件を複製しない。

`test/hook-answer-intake-boundary.test.js` は、フックと HTTP の回答入口から配信状態や補助メソッドへの直接アクセスが無いことと、世代と終了印の変更が共通受付に限られることを検査する。
保存ファイルの復元、保持期限の整理、明示削除は配信受付ではないため、この依存検査の対象にしない。
遅延、訂正、再送、重複 ACK は `test/hook-answer-delivery.test.js` の HTTP とフックの入口から確認する。
共通の受領処理を provider 別に重複検証せず、Claude stop-poll と Codex stop-check の応答が分かれる部分をそれぞれ確認する。

これらの自動テストは、Claude と Codex の実 runtime が出力を採用した証拠にはしない。
