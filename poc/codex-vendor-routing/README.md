# Codex / Claude ベンダー経路PoC

[Issue #163](https://github.com/ktysne/agent-cockpit/issues/163)の検証用ディレクトリ。目的、7ケースの判定基準、制約は[検証記録](../../docs/poc-codex-163.md)を参照する。

このPoCでは、Claude主軸・Codex主軸のどちらからでも次に起動する担当のvendorを選び、結果を親へ返せる契約を調べる。調査開始時点で本番実装やUI変更は行わない。

#162時点ではCodex CLIは0.160.1、アプリ同梱ランタイムは0.160.0で、稼働daemonの版は取得できていない。版の厳密な一致は開始条件とせず、実測ごとに実際の版を記録する。

## 開始時の実測

Codexのnative childに`9*7`を依頼し、親が固定JSON結果を受け取った。設定modelは`gpt-6-luna`、effortは`high`。runtime model metadataとnative thread IDは取得できず、共有routingも自動適用されなかった。[native probe結果](../../poc/out/poc163-native-codex-probe.json)

Claude CLI 2.1.291のローカルhelpで、非対話出力、JSON出力、session persistence無効化、safe mode、tool制限、MCP設定制限に関するflagを確認した。[help記録](../../poc/out/poc163-claude-help.txt)

同じ固定課題をClaude CLIで実行し、要求profile `sonnet`/`low`に対して実model `claude-sonnet-5-5`、実effort不明、markerと`answer: 63`の完全一致を確認した。version probeとmodel processは両方exit 0、owned process 2件の終了を確認した。[Claude実測JSON](../../poc/out/poc163-claude-291-a/result.json)

別のowned Node fixtureではcancel/kill要求を送り、SIGTERMでcloseしowned childが終了することを確認した。[cancel実測JSON](../../poc/out/poc163-cancel-node-a/result.json)

両実測は限定したrunner動作を示す。tool call count、実permission mode、descendant process tree、OS sandbox継承は未観測。Node fixtureのcancelはClaude稼働中cancelではない。native Codex probeもruntime model/native IDと共有routing自動適用が未確認のままで、本番bridge統合を証明しない。

## RoutingModelの検証結果

`routing-model.js`の31テストとnative runnerの12テスト、計43件が成功した。全体`npm test`は963件中961件成功し、既知Issue #168の時計依存テスト2件だけが失敗した（`test/pull-requests.test.js:617`、`test/server.test.js:184`）。この2件はPoC関連43件とは別の既知失敗である。

`reserveLaunch`はroute snapshot、vendor別profile、親、workspace、委譲depth/祖先を固定する。`default`は親providerへ解決され、起動後の設定変更では既存launchを書き換えない。予約と起動許可は別で、`beginLaunch`はparent ended、cancel要求済み、known/unknown exit後の再開始を拒否する。

result受領、owned childのexit、親への返却、cancel要求、cancel確認は独立した状態である。unknown exitは親への結果返却を保留し、後からknown exitの証拠を受け入れる。known exit後に初めて届いたresultは拒否する。終了不明のowned childにも停止要求を出せるが、要求だけでは終了確認にならない。

native identityはvendor固有IDの観測を示す。Claudeは`sessionId`、Codexは`threadId`を使い、provider、ID種別、host、HOME scopeでkeyを分ける。両IDの混在とprovider不一致を拒否する。Claude final JSONのsession IDは帰属に使い、終了証拠はowned processのcloseから得る。native Codex exitはCodex native transportだけで受け付ける。

モデル試験はcanonical launch rowと別launchの分離を確認したが、本番 `src/server/state.js`の既存照合はClaude配下のCodex childに特化している。したがってモデル試験の成功は本番の重複排除を証明しない。将来の本番変更候補は、stateのprovider共通化/strict launch照合と、`src/hooks/route.js`へのCodex起動adapter追加である。現状の不具合を示すものではない。

## 試作で守る契約

- routingは`default`、`claude`、`codex`をClaude主軸・Codex主軸の両方から扱い、既定経路はlaunch開始時に実vendorへ解決する。比較用profileはvendorごとに固定し、設定値と取得できた実値を別々に記録する。
- launch時のvendor、model、effort、workspace scope、親IDを固定し、設定変更は次のlaunchから適用する。
- launch/run/attemptの識別子でnative childとshell runnerの観測をまとめ、証拠のないID照合はしない。
- 子の結果、結果検証、process終了、親への返却、cancelを別々に記録する。結果受領や停止要求だけで完了としない。
- 委譲の深さを1に制限し、cycleを拒否する。Claudeは通常の自身の認証を使用し、Codex認証をコピーしない。
- `source: native`はvendor IDの観測元を表し、Codex native transport限定ではない。tool制限やモデルのtrust scopeはOS sandboxやcaller認証を証明しない。
- Cockpit側は共有routing、launch識別、観測重複抑止、結果通知を担う案とする。bridge側はvendor profile、許可コマンド、runner登録、exit/cancel契約を担う案とする。既存allowlistを汎用shellへ広げない。bridge実装コードは未監査で、役割案は関連docsの確認に基づく。
- 通常homeの導入設定が必要になった場合は、実装後に開発者の承認を得る。現時点で追加設定依頼はなく、Claude認証が利用できない場合にのみ導入・認証手順を前提として案内する。
- 条件付きの採用候補は共通dispatcherとvendor別runnerである。ネイティブCodex子のmodel設定だけでClaudeへ置き換える方式は採用しない。toolなしrunnerの成功をtool有効本番の合格とみなさない。

通常homeの設定を意図的に変更せず、Claude CLIは現在ユーザーの認証contextで実行した。home copyは作らなかったが、home write副作用の有無は観測していない。現runtimeで追加設定は依頼しない。

## 再現手順

前提はNode.jsと既存のClaude認証である。この環境のrunnerは`C:\Users\mss02968\.local\bin\claude.exe`を固定実行ファイルとして使う。別端末では`native-runner.js`の`CLAUDE_EXECUTABLE`をその端末の絶対パスに調整する。出力先は排他的に作るため、毎回新しいrun IDを使う。Claude runnerは許可された結果・識別情報だけを保存し、raw outputを保存しない。

```powershell
$RunId = [guid]::NewGuid().ToString('N')
node poc/codex-vendor-routing/native-runner.js --mode claude --out "poc/out/poc163-claude-$RunId"
node poc/codex-vendor-routing/native-runner.js --mode cancel-fixture --fixture-child node --cancel-after-ms 100 --out "poc/out/poc163-cancel-node-$RunId"
node --test --test-isolation=none poc/codex-vendor-routing/routing-model.test.js
node --test --test-isolation=none poc/codex-vendor-routing/native.test.js
```

## 採用候補と引継ぎ

採用候補は共通dispatcherとvendor別runnerであり、本番導入は未完了である。CodexからClaudeへの実runtime routing、Claude実行中cancel、tool有効時の権限とOS sandbox、本番collector/bridge接続は追加確認が必要となる。[本番改修Issue #180](https://github.com/ktysne/agent-cockpit/issues/180)へ引き継ぐ。

[Issue #164](https://github.com/ktysne/agent-cockpit/issues/164)はこのモデル/APIをimportせず、launch/run/attempt、親、vendor ID、起動時固定profile、result/exit/parent return/cancelの区別を仮契約としてfixtureに明示する。PID、cwd、時刻だけでは照合しない。PoCは制約と追加検証を示す調査として完了できるが、採用候補の本番合格とは分ける。Issue #156の既存見積もり26〜42人日、管理app-server接続5〜10人日は維持し、#180の見積もりを二重加算しない。
