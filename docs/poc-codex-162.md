# Codex連携の切断と再起動後の復旧PoC

[Issue #162](https://github.com/ktysne/agent-cockpit/issues/162)の検証記録。
検証中であり、以下の計画は採用方式の合格を示さない。

## 開始条件

2026-10-06の更新後、CLIは0.160.1、アプリ同梱ランタイムとdaemon用のインストール済みバイナリは0.160.0だった。
稼働中daemonは制御ソケットへの接続が拒否され、版を確認できていない。
CLI、アプリ、daemonの厳密な版一致は開始条件にしない。実測ごとに各版と確認方法を記録し、版の違いに関係する問題が起きた場合は、その都度原因を調べる。
通常daemonと既存チャットは停止しない。
専用HOMEの所有するapp-serverと、保存先を分離したAgent Cockpitで検証する。
表示先はAgent Cockpitのダッシュボードとする。

## 復旧時の判定

保存履歴は、同じ実行が現在も稼働している証拠にはならない。
復元した親子対応と計画は保持するが、現在の登録とネイティブ状態が照合できるまで配信を保留する。
PID、cwd、時刻、継承したClaudeの環境変数で別の実行を結合しない。
送信中または受付済みで適用の証拠がない回答は未確認とし、自動再送しない。
解決した質問と終了した委譲は、古い通知や保存データで復活させない。
保存形式は識別、計画、通常の質問、配信状態に限定し、認証情報と会話全体を含めない。

## 現在の証拠を受け入れる順序

1. 起動後の秘密値で所有する接続先へ接続し、ランタイムの版とHOMEを確認する。
2. 現在のbridge登録から、親、launch、run、attemptと実行状態を取得する。
3. 同じ現行接続で対象threadの読取りとloaded一覧を取得し、保存履歴と現在のロード状態を区別する。
4. 質問待ちと許可待ちを取得する。取得できない場合は未確認として通常指示の配信を保留する。
5. 保存した宛先と現在の証拠を照合する。適用済みの判定にはrequest、delivery、turn、内容のdigestと一意の入力itemの証拠も必要とする。

この順序は本番collectorへの要求であり、モデル単体では接続先や証拠の世代を認証しない。
`current_loaded`という値を外部入力からそのまま証拠として受け入れない。
collector切断、フック失敗、現在の証拠の取得失敗、新しい接続世代の開始時は、照合前に`markCurrentProofUnavailable`で以前の配信可能判定を無効にする。
画面上の現在の稼働状態は`reconciliation`から判定し、保存された`runState`だけで稼働中と表示しない。
ネイティブ通信からモデルまでの一貫した復旧は未確認として扱う。

保存処理は、新規に独占作成した出力先を単一writerで使い、変更を加えないbooleanの検証関数を渡すことを前提とする。
`poc162-*`というパスの制約だけでは、実行ごとの所有権や外部呼出し元の認証を保証しない。

## 検証ケース

| ケース | 確認すること | 検証経路 | 結果 |
|---|---|---|---|
| 1：通常、背景委譲、質問待ち、許可待ち、適用未確認 | 状態ごとの復旧と配信保留 | 条件付き：モデル試験と専用native fixture。実環境は別判定 | 条件付き確認：approval requestとinterruptは観測。steer受付後からkill前までに、steerに対応する入力item通知とsteer入力を含むfixture要求を観測できず、適用は未確認。実native質問と実Claude背景委譲は未確認 |
| 2：collector切断、Cockpit再起動、フック失敗 | 履歴と現在の稼働状態を区別する | 条件付き：専用app-serverと専用Cockpit。本番collectorは別判定 | 条件付き確認：専用Cockpit再起動とCodexクライアント再接続。本番collectorの再接続と実フック失敗時の動作は未確認 |
| 3：daemon再起動、子の強制終了 | 所有する専用プロセスだけを停止し、保存状態を照合する | 専用app-serverの強制終了と同じHOMEでの再起動 | 専用app-serverで確認：強制終了、終了確認後のgate解放、同じHOMEでの再起動。通常daemonは操作していない |
| 4：親子対応と未受領回答の復元 | 不変の宛先、現在の登録、入力itemの証拠を照合する | 条件付き：復旧モデル、上限付き保存、専用native再起動 | 条件付き確認：metadata復旧は成功。steer受付応答とnative item適用は別の証拠であり、後者は未確認 |
| 5：古い、重複、逆順イベント | 解決済み質問と終了済み委譲を復活させない | 条件付き：世代、順序、イベントIDを使うモデル試験 | モデル試験24件は成功。native event streamは未測定 |
| 6：結合情報と終了通知の欠落、PID再利用 | 対応不明を保ち、推測で他の実行に結合しない | 条件付き：不一致と欠落を含むモデル試験。実bridge連携は別判定 | モデル試験24件は成功。このPoCは本番collectorとbridgeに接続していないため、native欠落通知とPID再利用は未確認 |
| 7：起動時の秘密値更新 | 古い認証と異なるOriginの書込みを拒否する | 専用app-serverとCockpitの実通信。本番環境は別判定 | 専用環境で確認：旧app-server token拒否、新token initialize、Cockpitの秘密値更新とOrigin検証。本番認証との接続は未確認 |

固定応答の試験は通信と状態照合を確認するもので、実モデルの判断能力を保証しない。
専用Cockpitの合成データの復元は、Codex本番の親子対応を復旧した証拠にはしない。
ネイティブの履歴読取りとresumeだけでは、元の実行を制御できると判定しない。

## 実測結果

専用Cockpitの再起動試験は成功した。
合成した計画、判断事項、離席設定が再起動後に残り、旧hookと旧UIの秘密値は401、現行の秘密値は200、異なるOriginは403で拒否された。
セキュリティヘッダー4項目も確認し、すべての子プロセス終了と後処理が成功した。
詳細は`poc/out/poc162-cockpit-1601-a/native-result.json`にある。
この試験のCodexバージョン欄は対象外のため空であり、合成データだけを使っている。

Codex recoveryの追試では、CLIと3回のinitialize応答がすべて0.160.1だった。
AとBは再起動前の同じapp-serverに接続し、再起動後に2世代目のapp-serverへ再接続した。
初回はAだけでthreadを開始し、warmup turnの完了後にAでthread metadataを読み、次にBが同じthreadをresumeした。
設定比較はthread/start応答とresume応答を使った。
再起動直後のreadは`notLoaded`、loaded一覧は0件だった。
同じthreadへのresume後はreadが`idle`を示し、loaded一覧にthreadが1件現れた。
再起動後のturn/start RPCとturn/started通知はいずれも0件で、metadata復旧は成功した。
hard killの終了を確認するまでgateを保持し、終了後にfixture接続をdrainしてから同じHOMEで再起動した。
旧tokenは拒否され、新tokenによるinitializeが成功し、全プロセス終了と後処理も成功した。

一方、steer RPCの受付応答と同じturn ID、送信側切断を確認した。
kill前にsteerに対応する入力item通知は0件で、steer入力を含むfixture要求も0件だった。
再起動後の読取りは`includeTurns:false`のmetadata照合だけで、thread本文やitem履歴は照合していない。
したがって、回答が届かなかった、または失われたとは断定できない。
turnの終端通知も観測せず、`original_execution_continued_after_restart`は`null`のままだった。
したがって`metadata_recovery_success`は`true`だが、steerの適用を確認できず`recovery_success`は`false`である。
回答を自動再送せず、元の実行が続いたとも判定しない。
結果は`poc/out/poc162-recovery-1601-b/native-result.json`にある。

許可待ちの追試では、approval requestを観測し、runnerは回答せず、同じturnへのinterruptを送り、turnが`interrupted`で終わることを確認した。
AとBのobserverは割り込み前の待ち状態と、割り込み後に解除された現在状態を報告した。
初回結果では上位の現在状態に割り込み前の値が残ったため、投影を修正して再試験した。
修正版の結果は、`before_interrupt_active:true`、現在の`active:false`、`cleared:true`を区別し、同じturnの終了状態も`interrupted`だった。
測定とapproval stateの観測は成功し、runnerはapproval requestに回答しなかった。
全プロセス終了と後処理も成功した。
修正版の結果は`poc/out/poc162-approval-1601-b/native-result.json`にある。

復旧モデルの関連テスト24件、保存処理の関連テスト5件、native-runnerの関連テスト18件がそれぞれ成功した。
これらのテスト結果は、検証ケースすべてのnative実測を意味しない。

## 未確認の項目

実Claudeの背景起動、既存デスクトップの稼働実行、実UIとの競合、本番collectorとbridgeの認証は未確認。
native-runnerはCodex用の固定fixtureを使い、Claude Codeを起動しないため、Claudeの背景起動とhook注入は測定していない。
desktop UIと本番collectorの間に接続しておらず、UI競合やbridge認証も証明できない。
steerの受付応答後、kill前にsteerに対応する入力item通知とsteer入力を含むfixture要求は観測されなかった。
再起動後のmetadata読取りはturn/item本文を含まないため、入力が届かなかったのか、後で適用されたのかは判断できない。
approval結果の割り込み前後の状態は修正版で区別できたが、実native質問を使ったUIフローは未確認である。
次はsteer itemの欠落原因を調査し、実native質問、実Claude背景実行、desktop UI、本番collectorとbridgeを含む専用検証を計画する。
検証ケースのすべてが完了するまで、採用判断を保留する。

## 暫定採否と後続Issue

版の厳密一致は開始条件にしない。
各試行でCLIとapp-serverの版を記録し、差による問題が観測された場合に個別調査する。
historyの存在だけで現在のthreadが稼働中とみなす案、受領応答だけでsteerが適用されたとみなす案、自動再送する案は採用しない。
native itemが見つからない回答は未確認のまま保留する。
モデルと保存処理のテストは各状態機械の証拠として使い、native実測の代替にはしない。

本PoCは採用合格に達していない。
native item適用、実Claude背景実行、既存desktop UI、本番collectorとbridgeの接続が未確認である。
到達できなかった条件、その理由、専用fixtureやモデル試験で代替した範囲、追加検証は[後続Issue #177](https://github.com/ktysne/agent-cockpit/issues/177)へ引き継いだ。
Issue #162はこの制約と未確認範囲を含めた調査結果をレビューした後、採用判断とは分けて調査完了として閉じられる状態にある。
現在、クロスレビューとPRの確認は保留中であり、Issueは閉じていない。
今回の検証にあたり利用者側で追加する設定はない。
Issue #156で維持している概算は全体26〜42人日、管理app-serverへの接続部分5〜10人日であり、今回のPoCで見直していない。

## 全体テスト

`npm test`は917件中915件が成功し、2件が失敗した。
いずれも[Issue #168](https://github.com/ktysne/agent-cockpit/issues/168)に記録された既知の期待値不一致である。
`test/pull-requests.test.js`の617行目と653行目はsnapshotの期待hashが`null`、`test/server.test.js`の184行目と234行目は404を期待して400を受け取った。
今回のPoCに追加したテストはすべて成功した。
実行ログは`poc/out/poc162-full-verify.log`にある。

## モデルと保存処理の結果

復旧モデルの関連テスト24件と保存処理の関連テスト5件が成功した。
現在の登録には実行状態を含め、質問待ちと許可待ちが明示的に解除されていない場合は配信候補にしない。
collector切断、Cockpit再起動、フック失敗、状態取得失敗では、以前の配信可能という判定を無効にする。
128 KiBを超える変更は拒否し、直前の有効な保存状態を保つ。

モデルと実ファイル保存を組み合わせた結合検証も成功した。
固定の親子対応、計画、解決済み質問、受付済み回答を保存して読み戻し、親子対応と計画、質問の解決状態を保持した。
受付済み回答は復元後に未確認となり、配信保留のままだった。
これは保存と復元の検証であり、ネイティブ実行の復旧成功を示さない。
