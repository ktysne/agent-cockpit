# 共通質問の自動適用設定

## 保存形式

設定はcompositionから渡された`dataDirectory`直下の`common-question-settings.json`へ保存する。
呼出し側が`dataDirectory`を事前に作成する。`atomicWriteJson`はディレクトリを作らない。
モデルの登録引数から保存先を指定する機能は設けない。

```json
{
  "schemaVersion": 1,
  "autoApply": {
    "enabled": false
  }
}
```

`minimumWaitMs`は省略できる。
省略時は共通質問サービスの下限定数を使い、明示する場合はその下限以上の安全な整数を指定する。
既定の待ち時間を選んだ設定は、`minimumWaitMs`を保存しない。
未知のschema、未知のfield、不正な型または下限未満の待ち時間を読み込んだ場合は、設定全体を無効にする。

## 初期化と診断

`createCommonQuestionSettings({ dataDirectory, fileSystem? })`は設定ファイルを非同期に読み込み、利用できる操作を返す。
設定ファイルがない場合は自動適用OFFで初期化し、新しい設定を保存できる。
破損、未知schema、不正な値、読み取り不能の場合は自動適用OFFで初期化し、保存を拒否する。

`getAutoApplySettings()`はサービスへ渡す値のコピーを返す。
返す値は常に`enabled`と`minimumWaitMs`を持ち、変更できない。
`getStatus()`は`status`、revision、無害な理由コードを返す。
状態は`ready`、`missing`、`invalid`、`unavailable`、`changed`のいずれかである。
revisionは初期化ごとに変わるopaque stringで、保存成功のたびに同じinstance内で進む。
そのため、再起動前に画面が保持したrevisionを使う更新は拒否される。

## 更新

`updateSettings({ expectedRevision, enabled, minimumWaitMs? })`は一つの設定ファイルへの更新を直列に処理する。
`expectedRevision`が現在値と異なる更新は`stale_settings_revision`で拒否する。
保存の直前に現在のファイルbyte列を起動時または直前の保存後に記録したbyte列と比較する。
差があれば`changed`へ移り、保存済みsnapshotを保持したまま自動適用をOFFにする。
そのプロセスでは再読み込みも上書きもしない。

保存には既存の`atomicWriteJson`を使う。
一時ファイルの排他的作成、0600 mode、rename、失敗時の一時ファイル削除はそのhelperの契約に従う。
保存に成功してからメモリー上のsnapshot、revision、状態を更新する。
失敗後にファイルbyte列が直前の保存値と一致することを再確認できた場合は、snapshotとrevisionを保ち、`settings_write_failed`を返す。
ファイルが変わった場合は`changed`へ移り、再照合できない場合は`unavailable`へ移って自動適用をOFFにする。
異常状態から通常更新で`ready`へ戻ることはなく、再起動時に再読込する。
既定の待ち時間を表す`minimumWaitMs`は保存データから省く。

## 通知

`subscribe(listener)`は保存成功後の変更と、診断状態が異常へ移ったときの変更を通知し、解除関数を返す。
通知引数は`{ autoApply, status }`の凍結snapshotである。
listenerの同期例外と非同期失敗は保存結果を変えない。
新規登録時の初回通知は行わないため、現在値は`getAutoApplySettings()`と`getStatus()`で取得する。

## エラー

エラーは`code`で分類し、filesystemのpath、本文、設定値をmessageへ含めない。
主要なcodeは`invalid_settings_update`、`stale_settings_revision`、`settings_not_writable`、`settings_changed`、`settings_unavailable`、`settings_write_failed`である。
