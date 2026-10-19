# PoC の結果

Claude Code 2.1.284(デスクトップアプリ、Windows)で確かめた。
再現に使った一式は、固定参照 8c701b1 の [`poc/`](https://github.com/ktysne/agent-cockpit/tree/8c701b1e8a5718eccff69f84775f21171b6663d0/poc) にある。

## 確かめたこと

| 項目 | 結果 | 根拠 |
|---|---|---|
| MCP サーバーが呼び出し元のセッションを判別できるか | できる | MCP サーバーの環境に `CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_MESSAGING_TOKEN` が渡る(`poc/mcp-whoami.js`) |
| サブエージェントの中のツール呼び出しを見分けられるか | できる | `PreToolUse`/`PostToolUse` に `agent_id` と `agent_type` が付く。`SubagentStop` には `last_assistant_message` と `agent_transcript_path` が付く(`poc/hook-logger.js`) |
| サブエージェントのモデル名と effort を取れるか | できる | Agent ツールの `PostToolUse` の `tool_response.resolvedModel` に実際のモデルが入る。effort は定義ファイル(`~/.claude/agents/<名前>.md`)の `effort` から引く。GPT 側は `codex-agent.sh` の監査行 `codex-agent: agent=... model=... effort=...` から取る |
| 内部ブラウザでパス付きの URL を開けるか | できる | `preview_start {url}` でも `navigate` でも、パスとクエリがそのまま渡る。ただしサーバーが先に起動している必要がある |
| 受付ソケットからセッションへメッセージを届けられるか | 未確認 | 送信手順は分かったが、試験送信が auto mode の安全判定で拒否された |
| ダイアログで待つ `AskUserQuestion` に外から答えられるか | できる | `PreToolUse` フックが `permissionDecision: "allow"` と、元の `questions` に `answers`(質問の文から選んだ label への対応)を足した `updatedInput` を返すと、ダイアログを出さずにその回答で進む。フックが待っているあいだはダイアログが出ない(`poc/answer-proto.js` の `ask`、2.1.287) |
| 待機中のセッションを起こせるか | できる | `Stop` フックに `asyncRewake: true` を付けると背景で動き、終了コード 2 で終わると入力待ちのセッションがすぐ起きる。stderr の文がモデルに届く(同 `rewake`) |
| `AskUserQuestion` に選択肢に無い答えや複数の質問へ答えられるか | できる | `answers` の値に選択肢に無い文を入れると、自由な答えとしてモデルに届く。質問が複数あるときは質問ごとに、複数選択は label を「, 」でつないで渡せる。`additionalContext` を添えると、回答と一緒にモデルに届く(同 `ask`) |
| 作業中のセッションに文を差し込めるか | できる | `PostToolBatch` フックの `hookSpecificOutput.additionalContext` が、次のモデルの呼び出しに届く(同 `batch`) |
| 終了コードが 0 以外の Bash の出力をフックで読めるか | できる | `PostToolUseFailure` の `error` に、1 行目の `Exit code N` に続いて出力が入る(公式の文書) |

## 分かった制約

- Windows ではフックのコマンドが PowerShell で解釈される。引用符付きの実行ファイルのパスは解釈できずに失敗するため、`command` と `args` を分ける exec 形式で書く。
- 受付ソケットへの送信は、1 行目が `{"type":"auth","token":...}`、2 行目が `{"type":"user","message":{"role":"user","content":...}}`。Windows では auth 行が無い接続は閉じられる。形式は公開文書に無く、本体に埋め込まれた送信例から得たので、バージョンが変わると変わりうる。

## 回答をセッションへ届ける経路

受付ソケットは送信形式が非公開で、試験送信も安全判定で止まるため使わない。公式に文書化されたフックだけで組む。
3 つの経路は、どれも実機で届くことを確かめた(上の表)。

- ダイアログで待つ質問への回答は、`AskUserQuestion` の `PreToolUse` フックが回答を待ち、`allow` と `updatedInput` で返す。待っているあいだはデスクトップアプリにダイアログが出ないので、待たせる条件を決めて使う。
- `asyncRewake` のフックはターンの終わりのたびに 1 つずつ起動し、前のものは待ち続ける。開発者がチャットで先へ進んだときに、前のものを終わらせる仕組みが要る。
- 新しいフォルダーで試したとき、`.claude/settings.json` では信頼の確認が出ず、`settings.local.json` にすると出た。

- 作業中の回答は `PostToolBatch` フックの `additionalContext` で差し込む。
- 待機中のセッションを起こすには、`asyncRewake` を付けた非同期フックが終了コード 2 で終わる仕組みを使う。この非同期フックは、ダッシュボードの回答が来るまで待つ。
