# Codex連携の復旧の試作

[Issue #162](https://github.com/ktysne/agent-cockpit/issues/162)で、切断と再起動後の状態照合を調べるための試作。
実測の条件と制限は[検証記録](../../docs/poc-codex-162.md)に記載する。
調査は完了したが、採用方式の合格と本番実装は未完了である。制約、代替、追加試験を含む調査結果は[検証記録](../../docs/poc-codex-162.md)を参照する。PRは未マージ。

## 保存と復旧

`recovery-model.js`は、provider、host、HOME scope、threadと委譲実行の識別を固定して保存する。
計画、通常の質問、回答の配信状態と、イベントの世代・順序を扱う。
復元だけでは配信を開始しない。
現在の登録と稼働証拠を照合できない場合は未確認として保持する。
受付済みで適用未確認の回答は自動再送しない。

`checkpoint-store.js`は、呼出し元が渡す検証関数を必須とする。
保存と読込みは128 KiBを上限とし、破損データと検証に合格しない形式を拒否する。
保存先はリポジトリの`poc/out/poc162-*`内に限定する。
既存の保存内容は、新しい内容の検証と一時ファイルの書込みが完了した後に置き換える。
この処理は稼働状態を推定せず、回答を送信しない。

```powershell
node --test --test-isolation=none poc/codex-recovery/recovery-model.test.js
node --test --test-isolation=none poc/codex-recovery/checkpoint-store.test.js
node --test --test-isolation=none poc/codex-recovery/native.test.js
```

## ネイティブ通信の検証

`native-runner.js`は、専用HOMEと固定Responses fixture、所有するapp-serverを使用する。
接続の切断と再接続、所有プロセスの停止と再起動、認証の更新を測定する。
通常daemonと既存チャットには操作を送らない。
CLI、アプリ同梱ランタイム、daemonの版が異なる場合も、それだけを理由に検証を拒否しない。
実行時に確認できた各版と取得方法を結果へ記録し、版の差が原因と考えられる問題は個別に調査する。
Recovery試験では、Aだけでthreadを開始し、warmup turnが完了してからAでthread metadataを読み、その後にBが同じthreadをresumeする。
設定比較にはthread/start応答とBのresume応答を使う。
再起動後は保存履歴とloaded状態を別々に取得し、元の実行が復旧した証拠として履歴だけを使わない。
許可要求には回答しない。

`metadata_recovery_success`は再起動後にthreadのmetadataと設定を照合できたことを表す。
`recovery_success`はこれに加えて、受け付けたsteer入力itemが元のthread、turn、client message IDに対応したことを表す。
どちらも強制終了した元の実行が継続したことや、モデルが入力を消費したことを保証しない。
同じheld turnが再起動後もactiveである証拠がなければ、`original_execution_continued_after_restart`は`null`（不明）のままにする。

`cockpit-probe.js`は、保存先を分離したAgent Cockpitを専用子プロセスで起動する。
合成した計画の保存、離席設定、秘密値とOriginの照合を検証する。
合成データの復元はCodexの親子対応を復旧した証拠にはしない。

## 再現コマンド

PowerShellでCodex実行ファイルの絶対パスを指定し、各モードに別の新規出力先を使う。
`$RunId`は実行ごとに変える。

```powershell
$CodexPath = 'C:\path\to\codex.exe'
$RunId = Get-Date -Format 'yyyyMMdd-HHmmss'

node poc/codex-recovery/native-runner.js --codex-path $CodexPath --out "poc/out/poc162-recovery-$RunId" --mode recovery --timeout-ms 20000
node poc/codex-recovery/native-runner.js --codex-path $CodexPath --out "poc/out/poc162-approval-$RunId" --mode approval --timeout-ms 20000
node poc/codex-recovery/native-runner.js --codex-path $CodexPath --out "poc/out/poc162-cockpit-$RunId" --mode cockpit --timeout-ms 20000
```

Codex正式レビューは2往復で収束した。
round 1の3件の要修正をcommit `4240d49`で解消し、round 2では要修正0件だった。
改善提案にあったacceptedTurnId欠落の拒否と識別子保持もテストで補強した。
round 1修正後のRecoveryModel 27件とcheckpoint store 5件は成功した。
native runnerは変更しておらず、関連テスト18件は直前の実行で成功しているため、PoC関連テストは計50件成功している。
`npm test`全体の917件中915件成功、2件失敗という結果はレビュー修正前の実行であり、修正後は再実行していない。
2件は[Issue #168](https://github.com/ktysne/agent-cockpit/issues/168)に記録された期待値不一致である。

現時点でCockpitの合成データ再起動、Codex metadata復旧、approval requestの観測と割り込み試験は成功した。
steer入力itemの適用は確認できず、元の実行が継続したとも判定していない。
approvalの割り込み前後の状態を分けて出力する修正も再試験で確認した。
検証記録にあるすべてのIssueケースは完了していない。
結果と未確認の項目は[検証記録](../../docs/poc-codex-162.md)を参照する。
