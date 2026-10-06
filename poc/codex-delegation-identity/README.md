# Codex委譲実行の識別PoC

[Issue #159](https://github.com/ktysne/agent-cockpit/issues/159)の試作。
検証結果と制約は[検証文書](../../docs/poc-codex-159.md)へ記録する。
本番のbridge、MCPや画面を変更するものではない。

## 必要なもの

- Node.jsとGit。
- `0.160.0`のCodex実行ファイル。
- 新しい出力先として指定するリポジトリ内の`poc/out/<slug>`。

通常HOME、認証情報や既存bridgeの設定をコピーする必要はない。
固定応答のローカルfixtureを使い、実モデルへリクエストを送らない。
照合値は生成した子の環境とrunnerのメモリー内に置き、検証結果へ保存しない。
フックの信頼確認を迂回しない。

## native検証

```powershell
node poc/codex-delegation-identity/run-native.js --codex-path 'C:\path\to\codex.exe' --out poc/out/poc159-reproduction
```

同じcwdとモデルで、独立2件と委譲として登録した2件を専用HOMEから起動する。
JSONのthread IDとMCPの`_meta.threadId`を照合し、登録済みの起動へ対応付ける。
Claudeの実エージェントから4件を起動する試験とは分けて扱う。
委譲の親は合成の登録値であり、通常のClaudeセッションへは書き込まない。

フックの定義と機能フラグを有効にした3件と、無効にした1件を分けて記録する。
fresh HOMEで信頼していないフックは、設定が有効でも発火しない場合がある。
フックの発火件数を、JSONとMCPによる識別の成功と同一視しない。

runnerは4プロセスの並行範囲、native完了、照合結果とモデルの投影を集計する。
出力される`native-results.json`は私有の実測記録として扱い、そのまま公開しない。
失敗した試験の出力先を再利用せず、再実行時には新しいslugを指定する。

## 識別モデル

`DelegationIdentityModel`は登録とイベント再生を扱うインメモリの試作である。
`registerLaunch`へlaunch、run、attempt、origin、host、HOMEの識別範囲と照合値を渡す。
委譲の場合は親provider、session、agentまたはtool-useの登録も必要になる。
`bindNative`で同じ登録値とnative threadを照合する。

| 状態 | 投影 | MCPと回答の宛先 |
|---|---|---|
| nativeだけを観測した | related_unknown | 拒否 |
| 独立の起動登録とbindingが一致した | independent | 子のnative thread |
| 委譲の起動登録とbindingが一致した | confirmed_delegated | 登録した委譲先のnative thread |
| 監査行だけを観測した | audit_only | native宛先としては拒否 |

`project()`は安全な行と件数を返し、照合値や実HOMEのパスは返さない。
`resolveMcpDestination`は継承した`CLAUDE_CODE_SESSION_ID`を使わない。
`routeAnswer`は宛先と配送IDを検証するだけで、実際の配送や新しいexecの起動をしない。
実行許可を自動承認する経路も含めない。

CodexのStopとターン完了は、委譲全体の完了を示さない。
委譲は一致するbridge結果で完了し、結果がない終了はunknown_endとして扱う。
再試行と親の引継ぎは、attemptと所有親のgenerationを明示する。

## 関連テスト

```powershell
node --test --test-isolation=none poc/codex-delegation-identity/identity-model.test.js poc/codex-delegation-identity/native.test.js
```

合成イベントと依存の差し替えによる試験であり、native検証とは分けて結果を読む。
