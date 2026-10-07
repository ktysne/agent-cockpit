# Claude owned native wait

## 適用範囲

専用 profile `cockpit-native-wait-v1` は、owned Claude process の固定 HTTP MCP tool `mcp__cockpit_wait__cockpit_wait` だけを待機経路として使用する。
既定の `cockpit-native-v1` は既存動作を維持する。
質問 service、台帳、永続化、共通 MCP 入口への接続はこの段階の対象外である。

CLI には空の built-in tools、固定 allowedTools、strict MCP config、dontAsk、disableAllHooks、空の setting sources、no session persistence を指定する。
専用 profile の tool timeout と idle timeout は 420000 ms とし、background 実行を無効にする。
これらの設定指定と、内部 tool 実行が全面的に無効であるという実証は区別する。

## HTTP と native 相関

親 Node process が 127.0.0.1 の ephemeral port に専用 endpoint を持つ。
random route は routing 用であり、認可は process environment だけに置く per-attempt secret の Authorization header で照合する。
inline config の header は `Bearer ${COCKPIT_NATIVE_MCP_SECRET}` という literal で指定する。
secret、認証情報、native ID、入力本文を設定ファイルやログへ保存しない。

Host は実際の 127.0.0.1 と port に限定し、Origin が存在する request は全て拒否する。
POST の JSON body は 64 KiB、読み取りは 5 秒を上限とする。
initialize、initialized notification、tools/list、tools/call、ping を限定して処理する。
GET は 405 とし、SSE replay、batch、未知 method を認めない。
未認証の拒否はその HTTP request だけを拒否し、owned source を失効させない。
認証済みの相関衝突、本物の pending response 喪失、同 attempt の再 initialize は現在の wait を失効させる。
TCP keepalive の交換は native source 世代の変更を意味しない。

HTTP 認証と native 相関は別々に必要である。
MCP request ID は response routing だけに使い、native tool_use ID との一致を認可に使わない。
同じ physical source、native session、assistant context、固定 tool 名、48 桁 hex nonce の完全 input、input epoch を一対一に照合する。
full assistant の tool_use を認可対象とし、partial JSON だけでは wait handle を発行しない。
partial と full は message ID、block index、tool_use ID で同一 call にまとめる。

相関待ち candidate は 16 件、serialized bytes は 256 KiB、match deadline は 5 秒に限定する。
実 installed CLI の能力 probe では速やかな到着を確認したが、この期限を満たせない環境は unknown とする。
消費済み native ID、nonce、request の帰属は source lifetime 128 件を保持し、eviction しない。
同 nonce の複数 call、同 native ID の矛盾、上限超過は positive capability を閉じる。

## 固定 facade

composition の `createWaitOwner(admissionReceipt)` は、同 admission に固定した別 opaque facade を返す。
公開 operation は `subscribeVerifiedWait(listener)`、`checkWait(handle)`、`settleWait(handle, status)`、`subscribeWaitInvalidated(listener)` に限定する。
status は `released` または `cancelled` だけを受理する。
listener の metadata は `source`、`target`、`nativeContextId`、`nativeToolUseId`、`inputDigest` の固定 5 keys とし、source と target は既存 instruction の immutable execution schema に合わせる。
inputDigest は strict input `{nonce}` をこのキー順で JSON 化した UTF-8 bytes の SHA256 hex とする。
handle は private WeakMap に所属を持ち、JSON clone、別 admission、別 source、旧 lease から復元できない。
readonly source facade には writer operation を追加しない。

settle、cancel、monotonic 5 分 deadline は同じ最終認可を通す。
response body と response.end は guard 前に capture し、metadata callback の終了後、canonical revision と private proof、lease、connection、epoch、context、owner、response open を再検査する。
one-shot consume から captured response.end まで await、外部 getter、serializer、callback を挟まない。
response.end の開始は send-start であり、native 受領や適用を意味しない。
throw、close、失われた response は unknown とし、再送しない。

## Context の継続

一つの input epoch に一つの in-flight input を持ち、各 assistant context では固定 wait を一度だけ許可する。
A の wait response send-start 後、同 owned stdout の user/tool_result を確認して continuation permit を一度だけ発行する。
必要条件は session 一致、parent null、tool_use ID 一致、完全な固定 result の single text block、status と整合する is_error、元 source lease と connection、input epoch、owner と proof の一致である。
文字列 result の形は実観測していないため未対応とする。

distinct B の最初の eligible message で transition flag を先に立て、permit を消費し、A context を終了し、source の次 context を開始して B を fresh attest する。
transition 中の writer、actor-only start、別 attest は拒否する。
失敗時は unknown とし、旧 A proof を復元しない。
actor と period は維持する。

A context の終了は input の完了を意味しない。
matching session result UUID が確定するまで standalone start を閉じる。
send-start だけ、B message_start だけ、未解決 wait、parallel tool、別 input epoch は continuation の根拠にならない。
外部 terminal、detach、source 失効、owner 変更は permit を失効させる。
UUID replay fence と 129 context の bounded terminal 履歴を維持し、容量不足は response や start の前に拒否する。

## 独立シナリオ

| ID | 入力と観測点 | 独立期待値と禁止副作用 | 期限と許容差 | 能力条件 |
| --- | --- | --- | --- | --- |
| CW01 | 実 loopback HTTP と actual runner fake pipe に MCP/native 両順序で同 call を渡す | opaque wait 1、response at most 1、partial だけで handle 0 | match 5 s、fixture 5 s、同期差 0 | Claude 固定 MCP profile。Codex は既存 closed stdio fixture |
| CW02 | secret、Host、Origin、path、method、type、body、session、parent、tool、nonce を個別に違える | 認可 0、wait/tool 成功応答 0（HTTP 401 等の negative response は可）、actor/period end 捏造 0 | read 5 s、body 64 KiB、同期差 0 | 実 Node endpoint と実 kernel |
| CW03 | duplicate、矛盾、同 nonce 別 native ID、旧 request、上限を入力する | 一対一照合、旧 call 復活 0、再送 0、bounded no eviction | candidate 16、256 KiB、lifetime 128、同期差 0 | 両到着順、同 message/index 再利用を区別 |
| CW04 | release/cancel/deadline と最終 metadata callback 中の owner/source/context 失効 | 同 guard、失効後 response 0、consume 後再送 0 | monotonic 300000 ms、fake clock 境界差 0 | canonical revisions と callback-free private checks |
| CW05 | response close/error/throw、send-start 後 receipt loss、TCP keepalive 交換 | unknown、retry 0、native 世代の捏造 0 | 同 call stack 差 0、fixture 5 s | captured Node response.end の回数を観測 |
| CW06 | matching tool_result 後の distinct B、result 前 B、wrong input epoch | 正規のみ A proof 0/B fresh proof 1、actor/period 同一。他は B proof 0 | 同期 transition 差 0、fixture 5 s | single text block の実観測形に限定 |
| CW07 | A end 後 standalone start、transition 再入、旧 UUID replay、matching session result | input 完了前 start 0、再入 write 0、replay で B end 0 | 同 call stack 差 0 | actor life と context/input life を分離 |
| CW08 | detach/reattach、旧 lease、旧 connection、handoff、lost proof、外部 terminal | 旧 wait/permit 0、fresh 相関前 positive 0、actor/period end 捏造 0 | 同期差 0、fixture 5 s | 元 opaque loan と exact source epoch |
| CW09 | 固定 profile/env、owned stop、capacity、unknown frames | 公開/許可した任意 MCP method 0、native unknown tool 観測 0、任意 config 0、private payload persistence 0、endpoint close、child exit/close | HTTP read 5 s、fixture cleanup 5 s | 設定と runtime 実証を区別 |
| CW10 | root の製品実 native run。1 min release、5 min deadline、30 min short-call chain | 各 native pair/context fresh、response once、禁止再送 0、同 actor/period | 1 min write 60000..62000 ms、deadline 300000..305000 ms。7 call の各 hold 257143..262143 ms、累積 >=1800000 ms かつ <=1900000 ms | root 専用。次 context/terminal は各 response 後 30 s 以内、超過 unknown。Codex actual auth gate unknown は別記 |

## 検証結果の区分

Claude 2.1.291 の能力 probe では header environment 展開、完全 tool input と MCP nonce 一致、partial/full 同 call、完全 single text tool_result、同 session と parent null、distinct B の前の result、正常 exit/close を確認した。
MCP request ID と native tool_use ID は異なった。
GET 405、SSE Accept header、session header 不在、initialize 一回を観測した。
通常認証ファイルの不変、隔離 HOME 認証 artifact 0、known secret content scan 0 を確認した。
この probe は製品 proof を発行していない。

製品 actual runner と kernel の fixture、製品 native run、30 分保持、質問 store への成功はそれぞれ独立に記録する。
現在の能力 probe だけから製品 adoption、delegated/review、質問 service の適用成功を主張しない。

## 実装順序

1. 専用 HTTP module に protocol、bounded correlation、opaque call、固定 response、invalidated lifecycle を閉じる。
2. 専用 Claude parser/context module と runner を接続し、partial/full scope、input epoch、native result permit、UUID fence を保持する。
3. composition の固定 profile と wait owner、canonical/private 最終 guard、A end/B fresh attest を接続する。
4. 実 loopback と actual fake pipe/kernel の CW01〜09 を確認し、関連テストだけをまとめて freeze する。
5. root が全体検証、製品 native の CW10、diff audit、review、公開を実行する。

## Fixture の確認範囲

実 Node loopback HTTP と実 owned runner の fake child stdio、canonical registration/launch/runtime kernels を接続した fixture で、両到着順、partial の message/index scope、release/cancel、A の旧 proof 失効と B fresh proof、同 actor/period、input 完了前 start 拒否、失効した source/context/period/lease、同期 getter と metadata callback、transition 中の外部 terminal を検証する。
full native tool_use の再送は完全一致であっても unknown とし、完成済み partial の矛盾を拒否する。
未完成 partial は認可根拠にならず、完全 full native frame による認可のみを許す。

期限 fixture は実 latch に制御時計を注入し、300000 ms の deadline と失効後 end 呼出 0 を観測する。
専用 matcher の容量 fixture は source の private brand と実 kernel proof を使い、17 件目の未照合候補と共有 byte cap 超過を拒否する。
256 KiB は UTF-8 serialized payload の論理保持量であり、Node の実 heap 上限ではない。
native candidate、受信中の認証済み HTTP body、partial input が共通予算を使い、overflow は source 全体を unknown とする。
close/error/read timeout/候補移譲/partial clear/stop の予約解放は冪等で、失効後に追加 chunk を保持しない。

128 回の正規 wait continuation で 129 context の actor/period 同一性と終了履歴を確認し、最後の input 完了後も容量不足の新 start は write 前に拒否する。
CW01〜09 の表は独立期待値であり、session/parent/input epoch の各不正形、handoff、すべての HTTP read/connection 境界を網羅済みとは扱わない。
CW10 の製品実時間検証、質問 issuer/service/store への接続、Codex の共通 wait owner は未確認で、root が別途記録する。

関連 9 test file の 313 件は成功し、その中に dedicated fixture 32 件を含む。
追加の Claude 専用 profile、send-start 後 finish 前の response close、二回目 initialize の 3 件も成功した。
受信中 body の source 失効時解放を最終修正した後、影響する容量・response・未認証拒否の 10 件が成功した。
担当 source と fixture の構文検査、差分検査は成功した。
全体テストと製品 native の CW10 はこの fixture 結果とは別に扱う。

初回の root 全体 `npm test` は 1579/1579 成功した（fail/skip/cancel/todo 0）。
CodeGraph の同期と現在の定義・影響範囲の確認も成功した。
この結果は fixture と全体回帰の確認であり、CW10 の製品実時間検証を代替しない。

後続の standalone input は beginInstructionContext で新 input epoch を確定し、同じ message_start を wait parser に渡して stream scope を更新してから context を通知する。
spawn 失敗と child の自然終了も専用 endpoint を閉じ、明示的な composition.stop に cleanup を依存させない。
重複 stop と失効通知からの再入は同一の endpoint close 完了 Promise を待ち、listen 完了前の stop は pending start を reject して遅延 listen を残さない。
専用 HTTP の成功と拒否応答には、既存 server と同じ no-store、nosniff、X-Frame-Options DENY、CSP frame-ancestors none、CORP/COOP same-origin を付ける。

これらの修正前に専用 6 回帰 fixture が失敗し、修正後は全件成功した。
修正後の関連 5 test file は 273/273 成功し、重複 stop と listen 完了前 stop を含む dedicated fixture の最終確認は 43/43 成功した。
初回全体結果は修正後の全体検証を代替しない。

修正後の root 全体 npm test は 1587/1587 成功した（fail/skip/cancel/todo 0）。
CodeGraph 同期と修正箇所の影響範囲確認、差分検査も成功した。
