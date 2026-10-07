# Claude の writer の発行

この文書は、通常の Claude Desktop と CLI から起動した Claude セッションに、登録核の writer を発行する仕組みを定める。
登録核の契約は[正規会話の登録核と適合試験](codex-registration-core.md)にある。
この文書は、その契約のうち Claude についてだけ、証拠の種類と強さを変える。

## 守る相手

守るのは、同じ利用者の中で起きる偶発的な取り違えである。
例えば、Claude の Bash から起動した Codex は環境変数 `CLAUDE_CODE_SESSION_ID` を継承する。
そのため、Codex の MCP の書き込みが Claude のセッションに入ってしまうことがある。

悪意のある同じ利用者のプロセスは、守る対象に含めない。
書き込みの口が照合する秘密値は利用者のホーム配下のファイルにあり、同じ利用者のプロセスなら読めるからである。

## 証拠

Claude の証拠は「同じ利用者の範囲で申告された系統」である。
MCP サーバーとフックは、自分の親プロセスの pid(`process.ppid`)を申告する。
常駐サーバーは、その pid が生きている Claude のセッションファイル(`~/.claude/sessions/<pid>.json`)に載っていることを照合する。

この照合は、登録核のいう認証ではない。
申告を偽ることは、同じ利用者のプロセスならできる。
それでも偶発的な取り違えは防げる。
Codex が起動した MCP の実際の親は Codex なので、その pid のセッションファイルは無い。

保存する evidence metadata は次のとおりにする。

| 項目 | 値 |
|---|---|
| source | `claude-local-lineage` |
| method | `declared-ppid-session-file` |
| capabilities | `['declared-lineage']` |

この証拠は、`codex-registration-core.md` の ID-F02-A01 と ID-F02-A04 の「PID は昇格の根拠にならない」に対する、Claude だけの例外である。
Codex の登録には使わない。

### 採らなかった方式

- 常駐サーバーが OS の表から接続元のプロセスを引く方式。
  - Windows では常駐する補助プロセスが要る。フックのたびに遅延も生じる。
  - それでいて、守れる範囲の上限は上がらない。
- MCP の起動時だけ OS で照合する方式。
  - フックの照合が申告のままなので、全体の強さは申告の照合と変わらない。
- trusted launcher と専用の IPC で結ぶ方式。
  - 通常の Desktop と CLI は cockpit が起動しないので、launcher が存在しない。

これらは、より強い証拠が使えるようになったときの差し替え先の候補として残す。
発行の判定は `createClaudeLocalIssuer` に閉じ込め、差し替えられる境界にする。

## 照合の規則

1. 申告された `ppid` は、正の整数でなければならない。
2. `listLiveSessionFiles` の結果に、`pid === ppid` で生きているファイルがなければならない。
   - そのファイルは、文字列の `sessionId` と、`procStart` を持たなければならない。
3. フックからの要求では、本文の `session_id` がそのファイルの `sessionId` と一致しなければならない。
4. MCP からの要求では、環境変数 `CLAUDE_CODE_SESSION_ID` を照合に使わない。
   - `/clear` の後も MCP のプロセスが続くと、環境変数が古い値のまま残るためである。
   - セッション ID の正本は、セッションファイルにする。

ファイルが読めないとき、または条件に合わないときは、writer を出さずに拒否する。
旧来の pid の引き当てや、環境変数による経路には戻さない。
拒否の理由は、ログと MCP のエラー文で区別して示す。

| 理由 | 意味 |
|---|---|
| `claude_parent_unverified` | 親プロセスを Claude と確認できない。シムやシェルを挟んで起動した場合も、これに当たる |
| `claude_session_mismatch` | フックの `session_id` が、親の Claude のセッションファイルと合わない |
| `claude_sessions_unreadable` | セッションファイルを読めない |

照合が成り立つのは、フックを exec 形式(`command` と `args`)で設定し、node を絶対パスで指定したときだけである。
文字列の形のフックは `claude.exe → bash.exe → node` とシェルを挟むので、親が Claude 本体にならない。
シェルを 1 段挟むことを許すと、Bash ツールで起動したプロセスと区別できなくなる。そのため、許さない。

## 登録と実行期間

照合が通ったら、issuer が authority で登録する。

- identity は、次の 5 項目にする。
  - `provider: 'claude'`
  - `nativeIdKind: 'session'`
  - `hostId`: ホスト名の SHA-256
  - `homeScopeId`: 実パスにした Claude のホームの SHA-256
  - `nativeId`: セッションファイルの `sessionId`
- 実行期間の鍵は、親の Claude の `(pid, procStart)` にする。
  - pid が別のプロセスに再利用されても、`procStart` が変わるので別の期間になる。
  - startId は `(pid, procStart, sessionId)` の SHA-256 にする。MCP やフックが何度照合しても、同じ期間に冪等に解決する。
- 初めて見る会話では、`projectionId` を `sessionId` にする。
  - 既存の Claude の表示データと、同じカードを保つためである。
- 同じ鍵で `sessionId` が変わったら(`/clear`)、古い期間を `authority.end` で終えてから、新しい `sessionId` を登録する。
- 常駐サーバーがセッションファイルを定期的に読み直すときに、鍵のプロセスが一覧から消えたら、その期間を `authority.end` で終える。
  - 期間を終えると、その期間の writer はすべて失効する。

MCP が先に照合しても、フックが先に照合しても、同じ規則で登録する。
どちらが先に届いても動くようにするためである。

再開で同じ `sessionId` が新しいプロセスに現れたときは、登録核の規則どおり `resume: true` で新しい期間を作る。
表示を会話ごとに 1 行にまとめるかどうかは、#213 と #177-A で決める。

## writer の配り方

### MCP

- MCP サーバーは、起動時と、書き込みが writer の欠落や失効で拒否されたときに、`POST /api/claude/writer` を送る。
  - 本文は `{ ppid, contextPid }` である。`contextPid` は MCP 自身の `process.pid` を入れる。
  - 書き込みが拒否されたときの取り直しは、1 回の書き込みにつき 1 回までにする。
- この口は、既存の書き込みの口と同じく、起動ごとの秘密値と Origin を照合する。
- 返す writer の `contextId` は `claude-mcp:<contextPid>` にする。
- MCP は、受け取った writer をメモリーにだけ持ち、`getWriter` で同期的に返す。
- token をファイル、ログ、MCP の結果に出さない。

### フック

- フックは token を持たない。
  - フックは要求ごとに起動する短命のプロセスなので、token を渡す手段が無いためである。ファイルに置くことは秘匿の規則に反する。
- `event.js` と `answer.js` は、本文に `claudeLineage: { ppid }` を足して送る。
- 常駐サーバーは要求ごとに照合する。通ったら、issuer がメモリーに持つその期間のフック用の writer を本文の `writer` に付け、既存の writer の経路へ渡す。
  - フック用の writer の `contextId` は `claude-hooks` にする。
- `claudeLineage` を持たないフックの要求は、従来の観測の経路で扱う。
  - その `session_id` が登録済みなら、従来どおり拒否する。

### サブエージェント

サブエージェントは、メインと同じ Claude のプロセスの中で動く。
そのフックの親も、メインの Claude 本体である(実機で確かめた。#207)。

issuer は、Claude 用の `resolveActorCorrelation` を提供する。
フック用の writer を付けた要求に `agent_id` があれば、それをその期間の agent として verified にする。

## 不在の判定

`state.isSessionAbsenceProtected` は、その `sessionId` に、今 active の期間があるときだけ真にする。
登録の記録は、期間を終えた後も残る。
そのため、登録済みかどうかで判定すると、終わった Claude のセッションが不在の判定で終了扱いにならない。

## 確かめる結合試験

合流の条件にする結合試験は、次の前提で組む。

- `startServer` は、一時的な HOME と port 0 だけを与え、既定のオプションで起動する。
- 擬似の Claude の親プロセス(node)が `sessions/<pid>.json` を書き、本物の `src/mcp/server.js` と各フックを直接の子として起動する。

確かめることは次のとおりである。

1. MCP の各ツール(タスク、判断事項、PR の登録、レビューの省略)と、フック(SessionStart、PreToolUse、PostToolUse、AskUserQuestion の回答、PostToolBatch、Stop)が、`/api/state` に反映される。
2. 同じ `CLAUDE_CODE_SESSION_ID` を持っていても、親が Claude でないプロセスは拒否され、副作用は 0 件になる。
3. 2 つのセッションを同時に動かしても、書き込みが混ざらない。
4. 常駐サーバーを再起動すると、古い token は拒否される。MCP が照合し直すと、書き込みが成功する。
5. 同じ親の `sessionId` を変えると(`/clear` の模擬)、古い期間が終わり、以後の書き込みは新しいセッションに入る。
6. 親が終了すると writer が失効し、不在の判定による終了の表示が従来どおり動く。
7. `agent_id` 付きのフックがサブエージェントとして表示され、`unknown` にならない。
8. `/api/claude/writer` は秘密値を要求し、別の Origin からの要求を拒否する。ログと保存データに token が残らない。
9. セッションファイルを読めないときは拒否し、旧経路に戻らない。

## 実機で確かめたこと

Windows の Claude Desktop、Claude Code 2.1.289 で確かめた(#207)。

- MCP サーバーとフックの直接の親は、セッションファイルの pid の `claude.exe` だった。
- サブエージェントのフックも、同じ `claude.exe` の子だった。
- Bash ツールのコマンドは、`cmd.exe` や `bash.exe` を挟むので区別できる。
- セッションファイルは `procStart` を持つ。

`/clear` の後に MCP のプロセスが続くか、CLI での親子関係は、まだ確かめていない。
