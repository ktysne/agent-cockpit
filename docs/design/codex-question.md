# Codex の質問

Codex 対応の順序 4(#174)の設計である。
Codex の質問ツールを、Claude の `AskUserQuestion` と同じ仕様でダッシュボードの判断事項にし、離席中は推奨を仮に適用する。
計画と順序の正本は [2026-10-11-codex-rebuild.md](../handover/2026-10-11-codex-rebuild.md) にある。
Codex のセッション行は [codex-registration.md](codex-registration.md)、委譲した Codex は [codex-delegation.md](codex-delegation.md) にある。

## 方針

Claude と同じ目的の処理と表示は、同じ仕様にする(開発者の決定)。
この資料は、Claude の今の仕様を既定とし、Codex で同じにできない点だけを「差」として決める。

## Claude の仕様(既定)

- 在席中: 質問は元の画面に出る。ダッシュボードには判断事項のカードとして表示だけし、ダッシュボードからは答えられない。カードは質問ツールの結果(`PostToolUse` の回答の内容)で閉じる。
- 離席中: `PreToolUse` のフックが、離席の設定の時間(1〜30 分)だけダッシュボードでの回答を待つ。回答が来たら回答を返す。期限が来たら、推奨を適用して判断事項を仮適用(provisional)にするよう指示して拒否する。期限の起点は質問を登録した時刻である。
- 期限の後の回答: ターンの途中なら次のツールの区切り、ターンの後なら次の入力か、対話セッションの `Stop` で待って届ける。単発実行(`AGENT_COCKPIT_NONINTERACTIVE=1`)では待たない。モデルが `cockpit_update_decision` で反映を記録する。
- サブエージェントの質問は判断事項にしない。離席中は推奨で進めるよう指示して拒否する。
- 質問文が重複する判断事項は答えられない。

## 観測した入力(Codex 0.162.1)

- 通常のモードの質問ツールは `request_user_input_async` で、入力は `{questions: [{title, options?: string[]}]}` である。呼ぶとすぐ戻り(結果は `{"accepted": true}`)、回答は後から新しいユーザーの入力として届く。選択肢は推奨を先頭に置く。選択肢を省くと自由記入だけの質問になる。複数選択は無い。
- Plan モードでだけ、待つ形の `request_user_input`(`{questions: [{id, header, question, options: [{label, description}]}]}`、推奨は先頭で `(Recommended)` を付ける)が使える。
- 質問ツールの `PreToolUse` で、拒否(`permissionDecision: deny`)の理由に回答を書くと、元の画面に質問は出ず、モデルはその回答を使って続ける。
- `PreToolUse` のフックが時間切れになると、フックの失敗として扱われ、質問ツールはそのまま通る。
- Codex には Claude の `PostToolBatch` と `asyncRewake` に当たるものが無い。

## 差と決定

### 回答を返す形

Codex の質問ツールには、Claude の `updatedInput.answers` に当たる入力が無い。
回答は拒否の理由に書いて返す。
理由には、質問ごとに質問文と、選んだ選択肢の文字列(自由記入なら本文)を並べ、開発者の指示があれば末尾に添える。
回答の中身の組み立ては Claude と共有し、包み方だけを provider で分ける。
回答を返した時点で、判断事項を解決済みにする。拒否で返すので、Codex の `PostToolUse` は来ないためである。

期限の拒否の文面は Claude と同じにし、ツール名だけを替える。
Codex の選択肢には推奨の印が無く、先頭が推奨という約束だけなので、質問ごとに適用する推奨を「推奨: 質問文 → 選択肢」として末尾に書き添える。
書き添えないと、モデルが推奨ではない選択肢を選ぶことを実機で確かめた。

### 質問の形

`request_user_input_async` の質問は、`title` を質問文に、選択肢の文字列を `{label}` にして、先頭を推奨とする。
`request_user_input` の質問は Claude と同じ形なので、推奨は `(Recommended)` の印で決める。
変換は入口で行い、以後は Claude と同じ判断事項として扱う。

### 在席中のカードの閉じ方

離席中にフックで回答を待った質問は元の画面に出ていないため、次の入力による回答済みや取り下げの対象から外す。
`request_user_input_async` はすぐ戻るので、Claude と同じく `PostToolUse` で閉じると、カードがすぐ消える。
質問の後に、その thread へ最初に届いた入力(`UserPromptSubmit`)で、カードを「次の入力を検出(回答は未確認)」として閉じる(開発者の決定)。
次の入力が質問への回答かどうかは分からないので、回答を確かめたと読める言い方にしない。
待つ形の `request_user_input` は回答がツールの結果として返るので、Claude と同じく `PostToolUse` で閉じ、「元の画面で回答済み(内容は不明)」とする。結果の形は未確認なので、内容は不明とする。結果が来ないまま次の入力が届いたら、Claude の中断された質問と同じく取り下げにする。
質問ツールの種類は保存しないので、常駐サーバーの再起動の前に出た質問は、すぐ戻る質問として次の入力で閉じる。
無関係な指示の入力でも閉じる近似である。
TUI で元の画面に答えると、入力した文字がそのまま `prompt` として届き、質問への回答を示す定型は無かったので、照合はしない。

### 離席中の選択肢の無い質問

Claude の質問には必ず選択肢と推奨があるので、同じ場面が無い。
選択肢の無い質問も、離席の期限まで待つ。
期限が来たら、仮定を置いて自分の判断で進め、判断事項を仮適用にするよう指示して拒否する(開発者の決定)。
後からダッシュボードで答えた回答は、推奨を仮適用した場合と同じ経路で届く。

### 期限の後の回答の届け方

Codex にはセッションを起こす手段が無い。
ターンの途中なら次の `PostToolUse` の `additionalContext` で、ターンの後なら次の `UserPromptSubmit` の `additionalContext` で届ける(開発者の決定)。
`Stop` の時点で届けていない回答があれば、その回答を理由にして一度だけ続行(`decision: block`)させる。これは単発実行でも同じである。
単発実行(`AGENT_COCKPIT_NONINTERACTIVE=1`)では、離席中も回答を待たない。離席中の `Stop` の待機は [codex-instructions.md](codex-instructions.md) にある。

### フックの上限

Codex のフックの既定の上限は 600 秒で、Claude の待ちの上限(30 分)より短い。
回答用のフックの上限は、原則として Claude の対応するフックと同じ値を Codex の設定に書く。
ただし Windows では `PostToolUse` が pwsh を経由して起動し、起動だけで約 0.5 秒かかるため、`UserPromptSubmit` と同じ 5 秒にする。
フックが早く終われば、timeout は待ち時間にならない。
確認応答は標準出力へ回答を書いた後に送る。
書く前にフックが打ち切られると確認応答は届かず、常駐サーバーは次の機会に回答を配り直す。
上限を超えても質問ツールはそのまま通るので、質問は失われない。

### 待つ間の中断

同期のフックで待つ間、Codex は作業中の表示になり、`Esc` で中断できる。
中断でフックの問い合わせが途絶えたら、Claude と同じく判断事項を待ちから戻す。

### 宛先と子

- 宛先は、質問を発行した thread(Codex のセッション ID)に固定する。
- Codex のネイティブの子(`agent_id` のある質問)は、Claude のサブエージェントと同じく判断事項にしない。離席中は推奨で進めるよう指示して拒否する。
- 委譲した Codex の thread は、セッション行が無いので判断事項にしない。委譲した Codex は cockpit のフックの無いホームで動く想定なので、離席中の拒否も当てない。

## 範囲の外

- 実行許可(`PermissionRequest`)には回答しない。許可は元の画面に残す。

## 導入

期限の後にダッシュボードで送った判断事項の回答を、次の `PostToolUse` または `UserPromptSubmit` の `additionalContext` で届ける。
在席中は、ターンの終わりに未配信の回答があるときだけ続行させる。
対話セッションでは離席中に `Stop` で回答や通知を待って届け、届いた内容を理由に続行させる。単発実行(`AGENT_COCKPIT_NONINTERACTIVE=1`)では待たない(詳細は [codex-instructions.md](codex-instructions.md)「ターンの後」)。

Codex の `hooks.json` に、`node "<リポジトリ>/src/hooks/away.js" codex` を同期のフックとして登録する。
provider は `event.js` と同じく引数で決め、入力の形から推測しない。
既存の `event.js` の登録は残す。
開発者が Codex の `/hooks` で信頼するまで、フックは動かない。
非同期(`async: true`)にしない。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "request_user_input_async|request_user_input",
        "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/away.js\" codex", "timeout": 1830 }]
      }
    ],
    "SessionStart": [
      {
        "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/away.js\" codex", "timeout": 5 }]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/answer.js\" codex", "timeout": 5 }]
      }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/away.js\" codex", "timeout": 5 }] },
      { "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/answer.js\" codex", "timeout": 5 }] }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "node \"D:/path/to/agent-cockpit/src/hooks/answer.js\" codex", "timeout": 3600 }]
      }
    ]
  }
}
```

`PreToolUse` の上限は、Claude の `away.js` と同じ 1830 秒にする。
離席の設定の最大値(30 分)に 30 秒の余裕を足した値である。
`SessionStart` と `UserPromptSubmit` の上限も Claude と同じ 5 秒にする。
フックが上限を超えると、Codex はフックの失敗として扱い、質問ツールをそのまま通す(実測済み)。
同期の待機は `Esc` で中断でき、問い合わせが途絶えた判断事項は Claude と同じく回答待ちから戻る。
