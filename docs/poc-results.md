# PoC の結果

Claude Code 2.1.284(デスクトップアプリ、Windows)で確かめた。
再現に使った一式は `poc/` にある。

## 確かめたこと

| 項目 | 結果 | 根拠 |
|---|---|---|
| MCP サーバーが呼び出し元のセッションを判別できるか | できる | MCP サーバーの環境に `CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_MESSAGING_TOKEN` が渡る(`poc/mcp-whoami.js`) |
| サブエージェントの中のツール呼び出しを見分けられるか | できる | `PreToolUse`/`PostToolUse` に `agent_id` と `agent_type` が付く。`SubagentStop` には `last_assistant_message` と `agent_transcript_path` が付く(`poc/hook-logger.js`) |
| サブエージェントのモデル名と effort を取れるか | できる | Agent ツールの `PostToolUse` の `tool_response.resolvedModel` に実際のモデルが入る。effort は定義ファイル(`~/.claude/agents/<名前>.md`)の `effort` から引く。GPT 側は `codex-agent.sh` の監査行 `codex-agent: agent=... model=... effort=...` から取る |
| 内部ブラウザでパス付きの URL を開けるか | できる | `preview_start {url}` でも `navigate` でも、パスとクエリがそのまま渡る。ただしサーバーが先に起動している必要がある |
| 受付ソケットからセッションへメッセージを届けられるか | 未確認 | 送信手順は分かったが、試験送信が auto mode の安全判定で拒否された |

## 分かった制約

- Windows ではフックのコマンドが PowerShell で解釈される。引用符付きの実行ファイルのパスは解釈できずに失敗するため、`command` と `args` を分ける exec 形式で書く。
- 受付ソケットへの送信は、1 行目が `{"type":"auth","token":...}`、2 行目が `{"type":"user","message":{"role":"user","content":...}}`。Windows では auth 行が無い接続は閉じられる。形式は公開文書に無く、本体に埋め込まれた送信例から得たので、版が変わると変わりうる。

## 回答をセッションへ届ける経路

受付ソケットは送信形式が非公開で、試験送信も安全判定で止まるため使わない。公式に文書化されたフックだけで組む。

- 作業中の回答は `PostToolBatch` フックの `additionalContext` で差し込む。
- 待機中のセッションを起こすには、`asyncRewake` を付けた非同期フックが終了コード 2 で終わる仕組みを使う。この非同期フックは、ダッシュボードの回答が来るまで待つ。
