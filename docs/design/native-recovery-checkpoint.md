# Native 登録履歴の受動復旧

## 目的

この復旧入口は、製品チェックポイントから会話と実行の識別情報を新しい登録カーネルへ移す。

保存済み `active` execution は `unknown` へ降格し、`ended` tombstone は保持する。

以前の proof、writer、lease、接続、起動状態は再利用しない。

この段階では、新しい native evidence による再照合も、起動や配信の再開も行わない。

## 保存形式

チェックポイント schema v2 の `registrations` は、既存の登録履歴に次の二つの配列を加える。

```json
{
  "replayClaims": [
    {
      "startIdDigest": "<sha256>",
      "evidenceIdDigest": "<sha256>",
      "fingerprintDigest": "<sha256>",
      "conversationId": "<id>",
      "executionId": "<id>",
      "order": 1
    }
  ],
  "incompleteConversationIds": []
}
```

`startIdDigest` と `evidenceIdDigest` は、それぞれの識別子に専用ドメイン文字列と NUL 区切りを付けて SHA-256 で計算する。

`fingerprintDigest` は、正規化済み identity tuple、許可リスト化された evidence metadata、resume、projectionId から作る開始 fingerprint の SHA-256 である。

チェックポイントへは digest と参照 ID だけを書き、start ID、evidence ID、proof、token、native 本文、delivery payload は書かない。

開始 ID と evidence ID は非秘密の再生識別子として扱い、credential や native 入力を設定してはならない。

すべての配列、文字列、参照、digest、順序値は既存チェックポイント validator の上限と exact-key 検証に従う。

完全履歴では各 execution と replay claim を一対一に対応させ、登録順を 1 から連続させる。

`incompleteConversationIds` は、復元時に replay claim の全履歴を証明できない会話を列挙する。

v1 は raw replay claim を持たないため、claim を推測せず、登録済み会話をすべて incomplete として v2 へ正規化する。

## 復旧順序

`createNativeRecoveryBootstrap` は空の registration、launch、runtime kernel と durable store を非公開で作る。

store の `ready` が完了した後、WeakMap に登録された内部読み取りだけで、validator がすでに読み込んだ同じ checkpoint を clone する。

この読み取りはファイルを再読込せず、registry snapshot の capture や save を起動しない。

registration kernel は全会話、実行、replay claim、alias を一時 map へ検証し、最後に kernel がまだ空であることを再確認してから一括反映する。

保存済み `active` execution は store load 時に `unknown` へ降格し、`ended` tombstone は保持する。

launch、runtime、connection、actor、writer、proof resolver は復旧対象にしない。

すべての検証と反映が成功した後だけ bootstrap bundle を返す。

失敗時は store を閉じて例外を返し、部分的な kernel や store を呼び出し元へ公開しない。

公開結果は登録履歴の復元状態と、execution authority、writer、proof handle が復元されていない事実を別々に示す。

## 再登録の制限

復元した replay claim と同じ start の再要求は `needs_revalidation` で拒否し、保存済み ID を成功結果として返さない。

incomplete 履歴が一つでもある復旧 kernel は、他 identity を含めて登録を `needs_revalidation` で拒否する。

このロックは復旧 kernel 内だけに適用し、空の通常 kernel の新規登録経路は変更しない。

新しい evidence による同期間の再照合と、明示的な別期間の開始を区別する API はこの段階に含めない。

## 検証

関連試験は Claude と Codex の登録 adapter を個別に使い、製品 durable store へ保存した後に close、reopen、bootstrap する。

期待値は fixture の ID と provider ごとに独立して作り、復元後の `unknown`、再登録拒否、writer なし、delivery 再送なしを確認する。

開始・evidence の fixture ID が raw 値で保存されないこと、malformed・unknown version・oversize checkpoint の失敗時に入力ファイルが変更されないことも確認する。

共通 store の配信試験は、sending が reopen 後 `unknown` になり、自動 sink 呼び出しがなく、payload を再取得できないことを確認する。

これらは product runtime の復旧試験ではなく、実ファイル store と製品 adapter を用いた kernel/store 適合試験である。

| シナリオ | 独立した期待値 | 試験 | Fixture 結果 | 実runtime |
|---|---|---|---|---|
| ID-F11-B01 | v2 登録を passive `unknown` として復元し、同一 start の再生、writer、proof を拒否する。v1 は全 identity を再登録ロックする。 | [native-recovery-checkpoint.test.js](../../test/native-recovery-checkpoint.test.js) | Claude pass、Codex pass | 両providerとも未実施 |
| ID-F11-B02 | `sending` は `unknown` になり、payload の再取得と自動再送を拒否する。 | [native-recovery-checkpoint.test.js](../../test/native-recovery-checkpoint.test.js) | Claude pass、Codex pass | 両providerとも未実施 |
| ID-F11-B03 | `ended` tombstone を保ち、配列順でなく明示 order の最新実行を使う。 | [conversation-registry.test.js](../../test/conversation-registry.test.js) | 共通kernel unit pass | 該当なし。実runtime未実施 |

## 未対応の範囲

この bootstrap は標準製品 factory からまだ呼ばれない。

新しい native evidence による current connection の照合、launch/runtime/owner 履歴の復元、writer/proof の再発行、delivery 再有効化は未実装である。

fixture または adapter 適合試験は、Claude/Codex の実 native runtime 検証を代替しない。

したがって、この段階だけでは Issue #177 全体の復旧条件を満たさない。
