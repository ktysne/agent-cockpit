# Codexの指示配信の試作

[Issue #161](https://github.com/ktysne/agent-cockpit/issues/161)で、通常指示の配信と停止後の再開を調べるための試作。
本番サーバー、ダッシュボードと既存セッションを変更するものではない。
実測の条件、結果と制限は[検証記録](../../docs/poc-codex-161.md)を参照する。

## 状態モデル

`delivery-model.js`はメモリー上で、登録、送信中、受付、適用、未確認を分ける。
宛先はprovider、host、HOME scope、thread、runとattemptで識別し、要求の内容を固定する。
同じ要求の再登録は送信を増やさず、内容や対象が変わった再登録は拒否する。
許可待ち、質問待ちと状態不明では直接送信を保留する。
終了した委譲とレビューには送信しない。

standaloneの作業中は登録したturnへsteerし、停止後は同じthreadへ新しいturnを開始する。
対象turnが変わった場合はstaleとして止め、開始へ自動で切り替えない。
稼働中のdelegatedへは既存turnへの指示だけを扱う。
次のユーザー入力による代替配信は未送信のstandaloneだけを対象とし、一度選ぶと元の経路を無効にする。
取消でも元の経路は復活しない。

ネイティブAPIの受理だけでは適用済みにしない。
適用には対象実行、配信要求、入力item、turnと正確な内容のdigestを照合する。
モデルが使う`user_input`は内部の証拠分類で、ネイティブの`userMessage`等を検証したadapterが変換する。
モデルは外部入力を認証しないので、呼出し元が検証していない値を適用の証拠として渡さない。
`observeApplied`は受付前の証拠を1件だけ保留し、受付後に同じturnと入力itemを照合する。
同じ証拠の再通知は候補を増やさず、異なる候補が届いた要求は曖昧なまま保持して再送しない。
`reconcileUnknown`は未確認の要求だけを扱い、送信中の先行証拠の保留には使わない。

送信後の曖昧な成功を自動再送しない。
既知の対象turnへの送信は同じ入力の証拠で照合できるが、新しいturnの開始応答を失い、turn IDが不明なら未確認を維持する。
送信後の取消は取消要求の記録にとどめ、未送信だったと保証しない。
この試作は保存、再起動後の復旧と本番の認証を実装しない。

```powershell
node --test --test-isolation=none poc/codex-instruction-delivery/delivery-model.test.js
```

## ネイティブ通信の検証

`native-runner.js`は専用HOME、専用リポジトリ、固定Responses fixtureと所有するapp-serverを使用する。
固定入力は試験用の文字列に限定し、実モデルの判断能力を検証しない。
loopbackのWebSocketへ秘密値で認証した2接続を使い、通常と実験的APIを比較する。
秘密値は結果やプロセス引数に出さず、既存threadへ指示を送らない。
入力がモデル要求へ含まれることと、その指示に従って作業が完了することを分けて記録する。

本番導入は、管理app-serverと同じthreadへ接続するCLIを候補とする。
別のサーバーで既存threadの履歴をresumeできても、元UIの稼働実行を制御できた証拠にはしない。
app-serverとWebSocketは実験的な連携なので、対象版を揃えて再検証する必要がある。

```powershell
node poc/codex-instruction-delivery/native-runner.js --codex-path <0.160.0のcodex.exeの絶対パス> --out poc/out/<新規出力ディレクトリ> --mode lifecycle --timeout-ms 30000
node poc/codex-instruction-delivery/native-runner.js --codex-path <0.160.0のcodex.exeの絶対パス> --out poc/out/<別の新規出力ディレクトリ> --mode queue-cli --timeout-ms 30000
```

出力先は未作成の`poc/out`配下を指定する。
既存の出力先は上書きしない。
`queue-cli`はAPI queueを使わない新規threadでCLIの入力と次turnを観測する。
CLIが生成するclient IDは配信要求へ結び付けていないので、同じthread/turn/itemの観測とダッシュボードの適用照合を区別する。
`--mode tool|question|approval|stop`で状態を観測できる。
状態観測は通常指示配信の成功を意味しない。
`--serve`は入力を維持する端末で使い、`native-ready.json`の接続先、専用HOMEとtokenファイルを使ってCLIを接続する。
tokenは環境変数へ読み込み、引数やログへ直接出さない。
接続するCLIにapprovalとsandboxの上書きを渡さない。
stdinのJSON制御は`release`、`snapshot`、`stop`、固定marker名の`start`と`steer`だけを扱う。

状態モデルとfixtureの検証は実モデルを起動しない。
結果は登録、受付と適用の証拠を区別して読む。
固定文字列がモデル要求に含まれることは、実モデルが指示に従って作業を完了した保証にはならない。

```powershell
node --test poc/codex-instruction-delivery/delivery-model.test.js poc/codex-instruction-delivery/fixture.test.js poc/codex-instruction-delivery/native.test.js
```
