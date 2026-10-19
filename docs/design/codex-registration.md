# Codex の登録と識別

Codex 対応の順序 2(#166、#167)の設計である。
通常の `~/.codex` で動く Codex CLI とデスクトップのフックを、ダッシュボードのセッション行にする。
Codex から呼ばれた MCP の書き込み先を、フックで登録したセッションと照合して決める。
計画と順序の正本は [2026-10-11-codex-rebuild.md](../handover/2026-10-11-codex-rebuild.md) にある。

## 範囲

対象にするもの:

- 通常の `~/.codex` に導入したフックと MCP
- Codex のセッション行、ネイティブの子(`spawn_agent`)のエージェント行、ツールと許可待ちの表示
- MCP のツール(タスク、判断事項、PR、レビュー不要)の書き込み先

対象にしないもの:

- `~/.codex-subagent` と、Claude から委譲した Codex(順序 3)
- 質問への回答、追加指示、停止、保存と復旧(順序 4〜7)
- Codex のシェルで作った PR の自動登録(順序 8)
- 中断の状態の表示(#391)

## 観測した入力

2026-10-11 に Codex CLI(MCP の `clientInfo.version` は 0.160.0)で、親の MCP 呼び出し、ネイティブの子の起動、子の MCP 呼び出しを 1 回ずつ記録した。

| 入力 | 項目 |
|---|---|
| フックの共通項目 | `session_id`、`transcript_path`、`cwd`、`hook_event_name`、`model`、`permission_mode`。`SessionStart` 以外は `turn_id` も持つ |
| `SessionStart` | `source`(`startup`、`resume` など) |
| `PreToolUse`、`PostToolUse` | `tool_name`、`tool_input`、`tool_use_id`。`PostToolUse` は `tool_response` も持つ |
| 子のフック | `session_id` は親の thread ID、`agent_id` は子の thread ID、`agent_type` は `default` |
| `SubagentStop`、`Stop` | `stop_hook_active`、`last_assistant_message` |
| MCP の `initialize` | `clientInfo.name` は `codex-mcp-client` |
| MCP の `tools/call` | `params._meta.sessionId` は親の thread ID、`params._meta.threadId` は呼び出した thread の ID。親では両者が同じ値になる |

ツール名は、MCP が `mcp__<サーバー>__<ツール>`、組み込みが `collaborationspawn_agent` のような区切りの無い名前だった。
フックと MCP の環境変数に、thread ID を指すものは無かった。
記録用のフックでは `/exit` の後に `SessionEnd` が届かなかったが、実装後の確認では CLI の `/exit` で 2 回とも届いた。
届く条件は確かめられていないので、届かない場合に備える。

## 決定

### 導入

- Codex の `hooks.json` に、`node "<リポジトリ>/src/hooks/event.js" codex` を同期のフックとして登録する。登録するイベントは `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`Stop`、`Interrupt`、`SessionEnd`、`SubagentStart`、`SubagentStop` である。
  - 開発者が Codex の `/hooks` で信頼するまで、フックは動かない。
  - 非同期(`async: true`)にしない。PoC #157 で、非同期のフックは短い実行で 1 件も記録されなかったためである。
- provider は引数 `codex` で決める。入力の形から推測しない。Claude と Codex の入力は項目がほぼ同じで、推測は版の変更で静かに外れるためである。
  - フックは引数を `event.provider` に載せて送る。常駐サーバーは `claude` と `codex` 以外を捨て、無ければ `claude` とみなす。Claude の既存のフックは引数を渡さないので、今の挙動が変わらない。
- MCP は Codex の `config.toml` に `[mcp_servers.agent-cockpit]` として、Claude と同じ `src/mcp/server.js` を登録する。

### セッションの識別

- Codex のセッションのキーは、フックの `session_id`(親の thread ID)をそのまま使う。セッションには provider(`codex`)を持たせる。
  - 接頭辞を付けない。MCP の `_meta.sessionId` を変換せずに照合できるためである。Claude の session ID も Codex の thread ID も UUID なので、衝突しないものとして扱う。
- セッションの provider は最初のイベントで決まり、変わらない。provider の違うイベントが同じキーで届いたら捨てる。
- ネイティブの子は、`agent_id` で既存のエージェント行にする。`agent_type` の定義は `~/.claude/agents` から読まない。
- エージェント行の既存の `isCodex` は、Claude から `codex-agent.sh` で委譲した Codex を指すフラグで、provider とは別である。ネイティブの子には立てない。
- `SessionStart` の `source: resume` は同じキーで届くので、同じ行のまま扱い、再開の回数を数える。

### イベントの扱い

- 常駐サーバーが受け付けるイベント名に `PermissionRequest` と `Interrupt` を足す。名前は変換せずに保つ。#391 で中断を区別するときに要るためである。
- `Stop` と `Interrupt` はターンの終わりとして扱う。`Interrupt` はさらに状態を「中断」にする([server.md](server.md) の「中断の検出」と状態の項目)。
- `SessionEnd` はセッションの終わりとして扱う。
- `SubagentStop` は子の終わりとして扱う。
- `PermissionRequest` は許可待ちにする。`tool_use_id` が無いので、同じエージェントで同じ名前の実行中のツールが 1 つに決まればその完了で、決まらなければ同じ名前のツールの完了で解消する。`Stop`、`Interrupt`、`UserPromptSubmit` でも解消する。別のツールの完了では解消しない。並行して動くツールの完了で、許可待ちを見落とさないためである。
- `SessionEnd` でセッションのイベントを捨てても、同じ thread の再開の回数は常駐サーバーの稼働中は続けて数える。
- Codex のシェルも `Bash` で届くため、`gh pr create` の検出と PR の登録は Codex のイベントにも適用する。1 つのコマンドで複数回実行した場合も、出力順に実行回数まで登録し、2 件目以降の `commandCwd` は直前の `cd <絶対パス> &&` から推定する。`Agent`、`AskUserQuestion`、`codex-agent.sh` の解析は適用しない。
- PR の記録と画面へ渡す PR および「前回見てから」のデータは登録元の provider を持ち、複数セッションに結び付く PR は重複のない `providers` を持つ。マージ済みの PR とマージ履歴も、登録から同じ `providers` を求める。
- 計画は作成時のセッションの provider を保存する。セッションが終わってイベントが消えた後も、タスクの完了と判断の仮進行を同じ起点で渡すためである。
- Claude のファイルを読む処理は Codex のセッションで動かさない。対象は、エージェントの定義(`~/.claude/agents`)の読み取りと、背景の子の終了通知(`~/.claude/tasks`)の読み取りである。

### 終了

- `SessionEnd` が届いたら終了にする。
- `~/.claude/sessions` のファイルが見えないことによる終了は、Codex のセッションに当てない。
- `SessionStart` で Codex 本体のプロセス ID を記録できたセッションは、Claude のセッションのファイルと同じく、プロセスが終わってから 60 秒後に終了扱いにする([codex-recovery.md](codex-recovery.md))。
- プロセス ID を記録できず、`SessionEnd` も届かずに停止のまま残った行は、既存の「無操作で隠す」設定で隠れる。rollout ファイルの監視は作らない。
- 隠れた行も、MCP の書き込みを受け続ける。thread ID を知るのはその thread だけなので、受け入れる。

### MCP の書き込み先

- MCP サーバーは、`initialize` の `clientInfo.name` が `codex-mcp-client` のとき Codex から呼ばれたと判断する。
- MCP の要求の処理は 1 件ずつ独立しているので、`initialize` で判断した結果はプロセスの中の 1 つの変数に持つ。
- Codex から呼ばれたときは、`tools/call` の `_meta.sessionId` だけを常駐サーバーへ送り、`CLAUDE_CODE_SESSION_ID` と `ppid` は送らない。Claude から起動した Codex が継承した値で、Claude のセッションへ書き込まないためである。
- 常駐サーバーは、Codex の `sessionId` と、`ppid` か `claudeCodeSessionId` が同じ要求に並んでいたら 400 で拒否する。
- Claude と判断した接続の `tools/call` に `_meta.threadId` があれば、送らずにエラーを返す。Codex が `clientInfo.name` を変えたときに、Claude の経路へ落ちて継承した `CLAUDE_CODE_SESSION_ID` で書き込まないためである。
- 常駐サーバーは、`_meta.sessionId` が、フックで provider `codex` として登録され、終了していないセッションと一致するときだけ書き込む。一致しなければ書き込まず、Codex のフックが届いていないため記録できなかったことを返す。
- 子から呼ばれたときも、`_meta.sessionId` は親を指すので、親のセッションへ書き込む。Claude のサブエージェントの書き込みと同じ扱いで、子を親の行にまとめる決定(#213 の転記)にも合う。
  - 子の `cockpit_set_tasks` は親のタスクを置き換える。Claude のサブエージェントと同じである。
- `_meta` はモデルが書く引数ではなく、Codex のランタイムが付ける値である。常駐サーバーへの送信は、既存の秘密値と Origin の照合で守る。

### 表示

- Codex のメインの行と子の行は、モデルの表示の位置に「Codex <モデル名>」を出す。モデル名はフックの `model` を使う。
- 再開の回数が 1 以上なら「再開 N 回」の札を出す(旧モックで合意済みの表現)。
- 行の題は、Claude の行と同じくセッション名を使う。Codex のセッション名は `<CODEX_HOME>/session_index.jsonl` の `thread_name` で、同じ `id` の行が複数あれば `updated_at` の新しい行を採り、先頭 200 文字までを使う。
- `session_index.jsonl` は公開仕様ではないので、読めなくても動作を続ける。ファイルが無いか読めないとき、または名前の無いセッションは、題を「Codex のセッション」とする。thread ID は利用者にとって意味を持たないので、題に使わない。

## 不変条件

- Codex のイベントで Claude のセッションを変えない。Claude のイベントで Codex のセッションを変えない。
- Codex からの MCP の書き込みは、フックで登録した Codex のセッションにだけ届く。
- Codex を導入していない構成(Claude の MCP とフックだけ)の挙動を変えない。
- Codex のネイティブの子は、親のセッションのエージェント行であり、`isCodex` は立たない。

## 確認

入口のテスト:

- Codex のフック入力を `POST /api/events` に送ると、provider が `codex` のセッション行ができ、子はエージェント行になる。
- Codex の `_meta` を持つ `tools/call` は、登録済みの Codex のセッションへ書き込み、未登録や終了済みのセッションへは書き込まない。
- `CLAUDE_CODE_SESSION_ID` を持つ環境で Codex から呼ばれても、その Claude のセッションへ書き込まない。
- 独立した 2 つの Codex のセッションの書き込みが、別々の行に入る。
- `PermissionRequest` で許可待ちになり、`PostToolUse` などで解消する。`Interrupt` でターンが終わり、状態が中断になる。
- Codex のセッションは、`~/.claude/sessions` に無くても不在で終了しない。Codex の子があっても `~/.claude/agents` と `~/.claude/tasks` を読まない。
- 既定のオプションで常駐サーバーを起動し、provider の無い Claude のフックと `_meta` の無い MCP の書き込みを流して、今と同じ応答になる(#207 の転記)。既存のテストは、スナップショットに provider が増える以外で変わらない。

実 runtime の確認(Claude 側):

- Codex CLI とデスクトップで、セッション行、子の行、ツール、許可待ち、停止が画面に出る。
- 親と子から MCP を呼び、親のセッションにタスクが出る。
- `resume` で同じ行のまま再開の回数が増える。

## 未確認

- 実機の `PermissionRequest`。確認した操作では、CLI もデスクトップも許可を求めずに権限昇格か失敗で終わった
- `PermissionRequest` と `PreToolUse` の順序
- 確認の最初のやり取りで、Codex がフックの失敗(終了コード 1)を表示した原因。終了コードを記録した後のやり取りでは、cockpit のフックはすべて 0 で終わった
- compaction の前後のフック
- Claude の MCP の `tools/call` に `_meta.threadId` が付かないこと(実機で 1 回確かめる)
- 常駐サーバーの再起動後、`~/.claude/sessions` に無い ID の計画が保存から消されないか(順序 7 で確かめる)
