# CodexのフックとMCP識別の検証

[Issue #157](https://github.com/ktysne/agent-cockpit/issues/157)の検証記録。
本番のCodex対応を完了したことは意味しない。
表示先はAgent Cockpitのダッシュボードとし、Codexの内部ブラウザへの表示は対象外とする。

## 検証環境

2026年10月5日にWindows上で確認した。

| 対象 | 実測版 |
|---|---|
| Codex CLI | `0.160.0` |
| Codexアプリのパッケージ | `26.930.4958.0` |
| アプリ同梱ランタイム | `0.160.0` |
| 通常ホームの共有daemon | 更新前`0.159.2`、更新後`0.160.0` |

通常ホームのdaemonは、開発者の許可を得て`codex app-server daemon update --from-cli --yes`で更新した。
`daemon version`の`cliVersion`、`managedCodexVersion`、`appServerVersion`がすべて`0.160.0`であることを確認した。
この更新方法はCLIのパッケージを選択して固定する。
通常の配布版へ戻す操作は`codex app-server daemon update`であり、自動的には実行していない。
別ホームのdaemonは更新していない。

検証には`poc/out/`内の専用ホームと空のGitリポジトリを使った。
普段の認証ファイルを複製せず、合成したClaudeセッションIDだけを継承の試験に使った。
プロンプト、ツール入力、ツール出力、認証値はPoCの記録器から出力しない。
Codex自体が専用ホームへ保存する履歴やログは共有しない。

## 実測できたこと

| 操作 | 期待 | 実測と判断 |
|---|---|---|
| 専用ホームの`app-server --stdio`へ`initialize` | 版を確認できる | `0.160.0`の応答を取得。実現可能 |
| `hooks/list` | 登録イベントと信頼状態を取得できる | 全12イベントが`user`、`enabled: true`、`untrusted`。実現可能 |
| 未信頼のまま`thread/start`を2回実行 | 信頼されていないフックを実行しない | thread生成後もフック記録ファイルなし。信頼後の発火は別途検証が必要 |
| 同じapp-serverで独立threadを2件作成 | 同じcwdでも異なるIDになる | 2件の異なるthread IDを取得。実現可能 |
| 各threadで`mcpServer/tool/call` | MCPに呼出し元の識別情報が届く | `_meta.threadId`が各thread IDと一致。直接API経由では実現可能 |
| MCP環境の`CODEX_*`識別候補 | 環境に識別値があれば観測する | `CODEX_THREAD_ID`、`CODEX_SESSION_ID`、`CODEX_AGENT_ID`、`CODEX_TURN_ID`はすべてなし。環境変数だけでは識別不可 |
| 合成したClaude IDを親プロセスへ渡す | MCPへの継承条件を確認する | 既定ではMCP環境へ渡らず、MCP設定の`env_vars`へ明示すると渡る。継承条件付き |
| 引数の`session_id`へ異なるIDを渡す | 実threadとの不一致を見分ける | `_meta.threadId`は変わらず、一致判定は`false`。実現可能 |
| API呼出しの`_meta.threadId`へ別の値を渡す | ランタイムの識別値が保持される | 実thread IDで上書きされた。直接API経由で実現可能 |
| 通常の対話CLIで専用ホームの`/hooks`を信頼 | 信頼後にだけイベントを記録する | 通常の信頼操作後に`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`Stop`、`Interrupt`、`SessionEnd`を取得 |
| 対話CLIのシェル許可画面をキャンセル | 許可待ちを終了できる | 元UIのキャンセルで`Interrupt`を取得。`PermissionRequest`に`tool_use_id`はなく、これだけでは要求の解決を照合できない |
| 対話CLIで固定コマンドを一回限り許可 | 実行後のイベントを取得する | `Write-Output POC157; exit 7`が実行され、`PostToolUse`を取得。記録器はツール応答を読まず、成否は`unknown`として保持 |
| 固定応答を使った`exec`のMCP呼出し | ネイティブの許可条件を確認する | MCPは認識されたが、`approval policy is never`で失敗。プロセスは0終了したため、終了コードだけではツールの成功を判定できない |
| 固定応答を使った対話CLIのMCP呼出し | 元UIで許可すると識別情報が届く | 一回限りの`Allow`で実行できた。`_meta.threadId`は`SessionStart`と同じIDで、`CODEX_*`の環境識別候補はなかった |
| 読取り専用のMCP注記を付けた`exec` | 注記と許可の条件差を確認する | `readOnlyHint: true`などを定義したプローブは、通常の`exec`ポリシーで成功した。MCP単独の固定シナリオで応答と終了を取得 |
| 保存済みの専用セッションを`resume`してMCPを呼ぶ | 再開前後のIDが一致する | 最初の入力で`SessionStart`の`source: resume`を取得。フックのセッションIDとMCPの`_meta.threadId`は再開前と同じ |
| 専用セッションで手動`/compact` | 圧縮イベントのIDを保持する | `PreCompact`と`PostCompact`が`trigger: manual`で届き、セッションIDは保持された。要約の内容は固定fixture応答なので品質は検証していない |
| 独立した2つのthreadから既存MCPでタスク・判断事項・PRを登録 | native IDごとに書込先を分ける | 6回の呼出しは受理されたが、すべて継承した合成Claude IDへ登録された。タスクは後の呼出しで上書きされた。既存方式をCodexへそのまま採用することは不可 |
| 通常ホームの`app-server proxy`で`initialize` | 共有daemonから応答が届く | 2回の試行とも15秒以内に応答なし。原因は未確定で、#158の接続成功とは扱わない |

MCPのメタデータには`progressToken`もあったが、その値は記録しない。
対話CLIのモデル応答処理経路では、さらに`callId`、`itemId`、`sessionId`、`windowId`、`x-codex-turn-metadata`のキーを観測した。
これらの値は記録せず、宛先の候補には`threadId`だけを使う。
直接APIの呼出しと、モデルが実行するMCPツール呼出しは別の経路として検証する。
アプリの実行パスと同梱ランタイムの版の取得は、アプリ内のフック発火を確認したことにはならない。

対話CLIと`exec`の試験では、認証不要のローカルResponses fixtureが固定のツール呼出しを返した。
この試験はCodexのランタイムが呼出しを処理する経路の確認であり、実モデルの選択や判断の検証ではない。
モデル名`poc157-fixture-model`は、実モデルと誤認しないための試験用識別子である。
実ランタイムの起動時には認証のないfeatured plugins取得が失敗しており、通信先がfixtureだけであるとは断定しない。

`exec`のフックでは`permission_mode: bypassPermissions`が届いたが、同じターンでMCPの許可要求と失敗が発生した。
このフィールドを「許可済み」の根拠にしない。
対話CLIの`PermissionRequest`は`permission_mode: default`だった。

## 導入時の前提

- CLI、アプリ、使用するdaemonのランタイムを同じ対応版に揃える。
- フックの定義を確認し、通常の`/hooks`操作で信頼する。未信頼や無効の状態を稼働中と表示しない。
- MCPの読み取り・書込みの注記を実装の動作に合わせる。
  読取り専用プローブでは`readOnlyHint: true`、`destructiveHint: false`、`idempotentHint: true`、`openWorldHint: false`の条件で`exec`の実行に成功した。
  タスク、判断事項、PRの登録は書込みなので、この結果だけで実行可能とは判断しない。
- 書込みツールの導入設定は対象ツールごとに確認する。
  [公式MCP設定](https://learn.chatgpt.com/docs/extend/mcp)には`default_tools_approval_mode`と`tools.<tool>.approval_mode`があるが、今回のプローブでは承認設定を変更していない。

## MCPの識別契約案

Codexの書込先候補には、ランタイムが付ける`_meta.threadId`を使う。
本番で採用する前に、モデル経由、デスクトップ、対話CLI、ネイティブ子エージェントで同じ情報が届くかを確認する。
現在の試作は情報を返すだけで、本番サーバーへ書き込まない。

既存MCPの互換性試験には、port 0の専用Cockpitサーバーと独立した保存先を使った。
タスクは1件、判断事項は2件、PRは2件が同じ合成Claude IDへ集約され、2つのnative IDにはいずれも0件だった。
PRのGitHub取得とマージは試験用の実装で無効化した。
試験終了後に専用サーバーを閉じ、専用設定とデータの後片付けが成功したことも確認した。
この試験の`success: true`は、誤ったルーティングの再現に成功したという意味であり、Codex対応の合格ではない。

- providerとネイティブthread IDを組にして識別する。
- 引数のIDだけで宛先を決めない。メタデータのIDと不一致なら書込みを拒否する。
- IDがない、形式が違う、登録済みの実行と照合できない場合は状態不明とし、PIDやcwdで他の実行へ結合しない。
- Codexの書込先へ`CLAUDE_CODE_SESSION_ID`を採用しない。
- 子エージェントのIDと親thread IDの対応は、子の実測と#159の起動登録で確認する。
- `_meta.threadId`の互換性は今回の版と経路に限る。公開仕様による永続的な保証とは扱わない。

## フックの変換案

入力と信頼の仕様は[公式Hooks資料](https://learn.chatgpt.com/docs/hooks)に基づく。
次の表は採用候補であり、未発火のイベントを実測済みとは扱わない。

| Codexイベント | 共通モデルでの候補 |
|---|---|
| `SessionStart` | 開始、resume、compactionを区別して登録 |
| `UserPromptSubmit` | 新しいターンの入力 |
| `PreToolUse` / `PostToolUse` | ツールの開始と終了。成否が不明なら不明のまま保持 |
| `PermissionRequest` | 許可待ちの開始。回答は元のクライアントに任せる |
| `SubagentStart` / `SubagentStop` | 親threadと子agentの関係、子の開始と停止 |
| `Stop` | ターンの停止。セッション終了とは区別 |
| `Interrupt` | ターンの割込み |
| `SessionEnd` | セッション終了 |
| `PreCompact` / `PostCompact` | 履歴の圧縮。実行の識別や計画を破棄しない |

許可待ちの解消は`PermissionRequest`だけでは保証しない。
拒否、キャンセル、割込み、要求解決と再接続時の状態照合を別途確認する。
セッション一覧、名前、worktree情報はapp-serverとGitを候補とし、取得可能な範囲は#158で確定する。

## 未確認のケース

| ケース | 現在の状態と追加検証 |
|---|---|
| デスクトップと対話CLIでの実モデル実行 | 未確認。通常ホームへ許可を得て検証フックとMCPを追加し、CLIで追加フックを信頼済み。デスクトップの専用チャットで設定の読込みと各イベントの発火を記録する |
| 直接`exec`とネイティブ子のフック | 固定応答の`exec`で開始、実行前、許可要求、停止、終了を取得。ネイティブ子は未確認 |
| 許可、拒否、キャンセルと割込み | 元UIでシェルの許可とキャンセル、MCPの一回限りの許可を実測。拒否、再接続後の終端照合は未確認 |
| 同期と非同期、信頼後、設定層の重複、フック無効 | 通常UIでの信頼と同期フックを実測。非同期、設定層の重複、無効時は未確認 |
| Codex用MCPのタスク、判断事項、PRの書込先 | 既存方式の誤ルーティングを実測。native IDを照合して書き込む改修後の成功と、子の分離は未確認 |
| resume、compaction、worktree | 専用HOMEのresumeと手動compactionでセッションID保持を実測。通常HOME、子、worktreeでの保持と圧縮後の計画の保持は未確認 |
| テスト用ダッシュボードへの接続 | 未確認。通常のcockpit保存先とポートを使わずに確認する |

## 再現の一式

試作と操作手順は[poc/codex-hooks-identity](../poc/codex-hooks-identity/README.md)にある。
実測の生記録はgitignore対象の`poc/out/`へ保存し、この文書へ秘密を含まない観測結果だけを転記する。
単体テストには合成した入力を使い、実機で確認できた項目と分けて報告する。

## コードの検証

関連する4つのテストファイルは41件すべて成功した。
Windowsで子プロセスを起動できる実行環境から`npm test`を1回実行し、全720件が成功した。
単体テストの成功は、表で未確認としたデスクトップ、子、復旧などの実測成功を意味しない。
