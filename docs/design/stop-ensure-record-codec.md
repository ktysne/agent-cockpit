# 停止結果recordの内部codec

## 範囲

#313の停止通知を準備する純粋内部moduleで、製品callerを追加しない。
ファイル保存、停止手続き、health、起動管理権限とwriter解放はcodecの責任に含めない。
停止全体の設計PR #364は3往復後も製品管理gateの指摘が残り、Draftの判断待ちである。
初回codecには残存指摘の影響がないため、レビュー済み#363から独立して実装する。

## 固定schema

versionは数値1だけを許可し、未知field、accessor、不正prototypeと非列挙fieldを拒否する。
入力はObject.prototypeまたはnull prototypeのplain dataに限り、getterとtoJSONを実行せず固定fieldのprimitive値をコピーする。
instanceId、requestIdとattemptIdは36文字小文字UUID v4、scopeIdは64桁小文字hexに限定する。
UUIDは`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`とする。
ID形式だけでは同じ保存先、起動権限や真正な結果を証明しない。

| kind | field | 許可される組合せ |
| --- | --- | --- |
| shutdown | version、kind、instanceId、requestId、status、reasonCode | completed/null、failed/shutdown_incomplete |
| startup | version、kind、scopeId、attemptId、instanceId、status、reasonCode | startedはUUIDのinstanceIdとnull理由。blockedはnullのinstanceIdとwriter_occupied、filesystem_unsupported、startup_failed、startup_unconfirmedのいずれか |

## 内部API

encodeStopEnsureRecord(record)は固定schemaを正規化してUTF-8 Bufferを返す。
decodeStopEnsureRecord(buffer, expectedIds)はBufferだけを受け、4096 byte上限をUTF-8変換とJSONparseより前に検査する。
入力が定義したbyteLengthの値やgetterを使わず、実際のbyte長で検査する。
不正UTF-8をreplacementで通さず、JSONの外側空白は許容し、BOMはJSON不正として拒否する。
shutdownの期待IDはkind、instanceId、requestId、startupはkind、scopeId、attemptIdを必須の固定schemaとする。
不正期待IDとrecord不一致も拒否し、decodeは入力から独立したnull prototypeのfreeze済みrecordを返す。
診断はTypeErrorの固定message invalid_stop_ensure_recordに限定し、入力、stack、secretと任意原因を追加しない。
MAX_STOP_ENSURE_RECORD_BYTESは4096である。

## 後続の境界

Bufferの入力上限はファイルのbounded readを証明せず、basename導出と保存は別moduleで確認する。
completedとstartedはschema上の値で、codecが実際の停止や起動を確認したことを意味しない。
decodeはJSON.parseを使う。既知の制約として数値表記とescapeは正規化され、重複keyは最後の値を採用する。
元byte列の同一性、署名と真正性は保証しない。
store、controllerと製品接続には別の期待条件、権限設計と実runtime検証が必要である。
