# 委譲した Codex の表示

Codex 対応の順序 3(#171)の設計である。
Claude から `codex-agent.sh` で委譲した Codex を、親の Claude の行の下にだけ出し、Codex のセッション行として二重に出さない。
計画と順序の正本は [2026-10-11-codex-rebuild.md](../handover/2026-10-11-codex-rebuild.md) にある。
Codex のフックとセッション行の扱いは [codex-registration.md](codex-registration.md) にある。

## 範囲

対象にするもの:

- Claude から委譲した Codex(実装の委譲とレビュー)の Codex のフックのイベント
- 委譲した Codex の終了の表示を、テストで固定すること

対象にしないもの:

- bridge(`codex-agent.sh`)の変更(開発者の決定)
- 委譲した Codex の質問待ち、許可待ち、稼働中のツールを親の行へ写すこと(順序 4 以降で判断する)
- native の質問待ちと許可待ちの種類と件数の表示(順序 4 へ移す)

## 二重表示が起きる条件

委譲した Codex は、Claude の `Bash` のフックが検出し、親の Claude のセッションに `isCodex` のエージェント行として出る。
委譲した Codex が使う Codex のホームに cockpit の Codex のフックが入っていると、Codex のフックも発火し、同じ実行が Codex のセッション行としても出る。

- 実装の委譲は `~/.codex-subagent` を使い、cockpit のフックを入れないので起きない。
- レビュー(`codex-review`)は通常の `~/.codex` を使うので、`~/.codex` に cockpit のフックを入れると起きる。

## 観測した入力

- bridge は `CODEX_HOME` だけを付けて `codex exec` を起動し、実行 ID などを子に渡さない。
- Claude の `Bash` から起動した Codex のフックのプロセスには、`CLAUDE_CODE_SESSION_ID` が引き継がれる。`CLAUDE_CODE_MESSAGING_TOKEN` も引き継がれる。
- `codex-agent.sh --wait` は新しい Codex を起動しないので、新しい thread は生まれない。

## 決定

### フック

- Codex のフックは、環境の `CLAUDE_CODE_SESSION_ID` がセッション ID の形なら、その値を `claudeParentSessionId` としてイベントに付ける。
- `CLAUDE_CODE_MESSAGING_TOKEN` は送らない。

### 分類

- 常駐サーバーは、Codex の thread を、その thread のイベントを最初に受けた時点で「委譲」か「独立」に分類する。
- 最初のイベントに `claudeParentSessionId` があり、その Claude のセッションに稼働中の委譲行(`isCodex` で、結果行を受けておらず、稼働中か終了未確認)があれば「委譲」とする。それ以外は「独立」とする。
- 分類の結果は、受けたイベントに `delegatedFrom`(親の Claude のセッション ID)として残す。同じ thread の以後のイベントは、最初のイベントの分類に従う。
- Claude の `PreToolUse` は非同期のフックなので、子の Codex のイベントより後に届くことがある。Claude 側で `codex-agent.sh` の起動を受けたら、同じ親を持つ「独立」の thread のうち、最初のイベントの時刻(`hookAt`)が起動の時刻以降のものを「委譲」に直す。
- 起動より前に始まった「独立」の thread は、後から「委譲」に変えない。

イベントの列は受けるたびに導出し直すので、分類を別に記憶すると導出と食い違う。
分類をイベントに残せば、導出し直しても同じ結果になる。

### 表示と書き込み

- 「委譲」の thread はセッション行を作らない。保持するのは分類に使う最初のイベントだけにする。委譲のたびに thread が増えるので、全イベントを持つと際限なくたまるためである。親の行へ写すかは順序 4 以降で判断する。
- 「委譲」の thread には Codex のセッション行が無いので、MCP の書き込みは順序 2 の照合で拒否される(403)。委譲した子のタスク、判断事項、PR を親の計画に書かない。
- 委譲した thread の `UserPromptSubmit` は判断事項や通知の配信処理を行わず、委譲元の Claude セッションがタスク、判断事項、PR を記録するため `cockpit_*` を呼ばないよう `additionalContext` で知らせる。
- 委譲した thread には、タスク登録の案内と `PostToolUse` / `PostToolBatch` のタスク催促を送らない。委譲元の Claude セッションがタスクを記録するためである。
  Claude のツールから起動した Codex(`CLAUDE_CODE_SESSION_ID` を持つもの)には、委譲の分類によらずタスク登録を案内しない。タスクは起動元の Claude が記録するためである。委譲の分類は親の非同期の起動イベントが届くまで決まらず、常駐サーバーも独立した起動を確定できないので、分類を待たない。
- 常駐サーバーは、委譲した thread への MCP の書き込みを、未登録や終了済みと分けて 403 の `error: "Codex session delegated"` で拒否する。MCP はこの理由のときだけ、エラーにせず、委譲元が記録するので呼ばなくてよいと返す。環境の `CLAUDE_CODE_SESSION_ID` だけでは判定しない。親に委譲行の無い独立した Codex も同じ値を持つためである。
- 委譲した thread への `UserPromptSubmit` の案内は、配信の記録に載せない。載せると ACK で、その thread に残る回答と通知まで配信済みになるためである。
- 委譲した Codex の終了は、親の行の下の `isCodex` の行が、結果行を受けて終わったものとして畳まれる今の表示のままとする。

## 既知の制約

- 委譲と thread を 1 対 1 で結び付けない。bridge から実行 ID が来ないためである。
- 委譲した Codex が稼働中に、同じ Claude のセッションが `codex-agent.sh` を経ずに Codex を起動すると、その Codex も「委譲」に分類され、セッション行が出ない。
- 委譲行より先に Codex のイベントが届くと、起動を受けるまでの間は独立した行として出て、その間の MCP の書き込みも受け付ける。起動を受けた時点で行は消えるが、受け付けた書き込みは残る。
- 起動の通知が委譲の終了の後まで遅れると、委譲の終了後に始まった独立の Codex も「委譲」に直される。直すかは起動の時刻だけで決め、委譲の終了の時刻を見ないためである。非同期のフックの遅れは委譲の実行時間より十分短いので、扱わない。
- 常駐サーバーを再起動するとイベントの列は失われる。再起動の後に届いた委譲した Codex のイベントは、親の委譲行が無いので「独立」に分類される。

## 不変条件

- 継承した `CLAUDE_CODE_SESSION_ID` は、セッション行を作らないかの判定にだけ使い、書き込みの宛先には使わない(codex-registration.md「MCP の書き込み先」)。
- `CLAUDE_CODE_MESSAGING_TOKEN` をイベント、状態、ログに出さない。
