# Codexの指示配信と停止後再開のPoC

## 目的と範囲

[Issue #161](https://github.com/ktysne/agent-cockpit/issues/161)の検証記録。
通常の指示を作業中の実行へ送り、停止後には同じthreadで続けられる条件を調べる。
表示先はAgent Cockpitのダッシュボードとする。
質問への応答と実行許可は、通常の入力とは別に扱う。

#158では、所有する管理app-serverへの共有接続が成功した。
既存デスクトップの稼働threadへの接続は未確認なので、その履歴をresumeして同じ実行の検証と扱わない。
#159のhost、HOME、threadと委譲実行の識別を保持し、終了した委譲とレビューを自動再起動しない。
#160からは、回答確定と受領確認を分ける契約を引き継ぐ。

## 開始時の環境

2026-10-06にCLI、アプリ同梱ランタイムとdaemon packageの実行ファイルで`0.160.0`を確認した。
さらに`codex app-server daemon version`は、稼働状態をrunning、CLI、managed packageと稼働app-serverの版をすべて`0.160.0`と返した。
通常ホームの設定変更とdaemon再起動は行わない。
専用HOMEと固定Responses fixtureを使い、実モデルの認証情報を複製しない。

## 配信の判定

指示を保存する「登録」、ネイティブAPIが受け付ける「受付」、同じ入力が対象実行へ渡る「適用」を分ける。
受付後に応答を失った場合は「未確認」とし、無条件で再送しない。
入力がモデル要求へ含まれることは、モデルがその意図を守って作業を完了したことを証明しない。

試作モデルはhost、HOME scope、thread、run、attemptとrequestを固定する。
同じ宛先と内容の再登録は既存の要求を返し、同じIDで内容や対象が変わる再登録を拒否する。
送信開始後は同じ要求を再送できず、受付と適用の状態を分ける。
適用の証拠には、対象実行、配信要求、nativeの入力item、turnと正確な内容のdigestを照合する。
モデルは外部からの証拠を認証せず、本番ではcollectorが検証した証拠を渡す必要がある。
同じhost、HOME、thread、turnと入力itemは一つの配信要求へ対応付け、別runやattemptで同じ証拠を再利用しない。

次のユーザー入力での代替配信は、未送信のstandaloneに限定する。
代替配信を選ぶと元の経路を無効にし、取消でも元へ戻さない。
代替配信の確保だけでは適用済みにしない。
送信後に結果が曖昧になった要求は、代替経路へ流さない。
送信前から対象turnが分かっていた場合は正確なnative入力証拠で照合できるが、turn開始の受付応答を失い、新しいturn IDが不明な要求は未確認を維持する。
保存と再起動後の復旧は#162で検証する。

`turn/steer`は対象のexpected turn IDを照合する。
対象turnが終了していた場合に、自動で`turn/start`へ切り替えない。
停止したstandaloneの再開は、明示された対象threadへ新しいturnを開始する。
稼働中のdelegatedには既存turnへの指示だけを許し、終了済みdelegatedとreviewは配信対象にしない。

## 公式資料との照合

[公式App Server資料](https://learn.chatgpt.com/docs/app-server)は、`turn/steer`が現在のturnへ入力を追加し、`turn/start`が新しいturnを開始することを説明している。
`turn/steer`はexpected turn IDが一致する必要があり、turnごとの設定上書きを受け付けない。
この説明と、対象版の生成スキーマおよび実応答を照合する。
WebSocketとapp-serverは実験的な連携であるため、PoCの成功を本番の対応保証にはしない。

対象版の実験的スキーマには`thread/queue/add`、`thread/queue/list`と`thread/queue/start`がある。
初期化の`capabilities.experimentalApi`は既定がfalseなので、キューを試すクライアントは明示的にtrueを指定する。
`thread/queue/add`には`clientUserMessageId`が必須で、`turn/start`と`turn/steer`にも同名の任意項目がある。
この項目の存在だけでは、同じIDを再送したときの重複排除を保証しない。

## 検証結果

状態モデルの関連12件は、rootで実行してすべて成功した。
同ID登録、内容の競合、待機、turn不一致、終了した委譲、受付と適用の分離、未確認の照合、代替配信の固定、取消、入力証拠の一意性、上限と無効な時計値を検証した。
### 初回の実測

専用HOMEの固定Responses fixtureと所有するapp-serverで実測した。
実際のCodexプロトコルを使うが、実モデルの判断能力を確かめる試験ではない。
結果の`measurement_success`は計測の完了、`feature_flow_success`は試験した配信経路全体の成立を示す。
両者を採用方式の合格と混同しない。

作業中のsteerは、受付、対象turnの一致、native入力itemとモデル要求への完全一致入力を確認できた。
対象が違うsteerと停止後のsteerは、どちらも`-32600`で拒否された。
停止後の同じthreadへのturn/startは、両接続で完了を観測できた。
接続時のapproval policyはon-request、sandboxはread-onlyで維持された。
thread/readでは有効なポリシーを取得できず、試験後も同じだったと断定する証拠にはしない。

experimentalApi=falseのqueueは拒否された。
trueのqueue/addでは、同じclientUserMessageIdと内容の再送は一覧1件、同じIDで内容を変えた追加は一覧2件になった。
続くqueue/startは`-32600`で拒否された。
この初回試験ではAPIとCLIが同じ固定文字列を使用し、CLI区間の新しいturn2件を開始元へ帰属できなかった。
CLIの終了コード0と一覧の文字列だけを、自動開始や適用の成功とは扱わない。
独立したthreadと入力で追試した。

CLIを分離した追試では、別の専用HOMEと新規threadでwarmupと初期turnを完了させた後、API queue/add/startを一切呼ばず、CLI queueで独自の固定入力を1回だけ送った。
終了コードは0で、受付したqueued IDが表示された。
モデル要求に完全一致のqueueCli入力が1件含まれ、観測turnはwarmup、初期turnとCLI入力の3件、すべて完了した。
明示的なqueue/startを呼ばずに次のturnが始まる経路を確認できた。
この測定では設定復元、サーバー停止、専用HOMEとtoken削除がすべて成功した。
CLIが生成したclientUserMessageIdを配信台帳へ結び付けていないため、Cockpit要求の厳密な適用照合は未確認のままとする。
また、API queue/add単独の自動開始時点はこの結果から推定しない。

API区間を分けた修正後の追試でも、同ID・同内容は一覧1件、同ID・異内容は一覧2件だった。
追加区間には新turn1件が見えたが、その時点のfixture入力は0件で、API addによる適用は照合できなかった。
その後の明示startは再び`-32600`で拒否され、その区間にも新turn1件を観測した。
既に追加した項目の処理との因果を区別できず、API add/startの方式は採用しない。
拒否の原因を版全体の非対応と断定せず、別入力・元UI競合と追加から開始までの順序を本番前に検証する。

自動runnerのqueue-cli追試では、事前・事後のqueue一覧は0件、CLIによる新規turnは1件だった。
完全一致の入力、同じthread/turn/itemとターン完了を確認し、計測と後処理は成功した。
clientUserMessageIdの一致はnullのまま記録している。
CLI子プロセスの終了後にfixtureの待機を解放して完了を観測したが、受付応答を失う切断試験とは区別する。
別接続の通知取りこぼしと受付応答を失う場合の復旧は#162へ引き継ぐ。

許可待ちでは要求を返さず、turn/interruptで両接続のinterruptedを観測した。
ツール実行試験は許可待ちになり、ツール完了と通常指示配信は未確認。
Defaultの質問試験も質問待ちを観測できず、#160と同じモード制約を別途照合する。
待機状態を観測できても、そこへ通常指示を安全に配信できた証明にはしない。

### 元CLI画面の共有

専用サーバーへ`codex resume <thread> --remote <url>`でCLI画面を接続した。
許可とsandboxの上書き引数は渡さず、フックの確認画面では信頼せず続行した。
同じ履歴、APIから開始した次の入力と固定応答が表示され、CLIで入力した別の固定文字列にも同じ実行で応答した。
CLI入力はダッシュボードの配信IDとは結び付けていないので、厳密な配信適用照合の成功とは扱わない。

初期の待機要求はCLIの初期画面を処理する間に30秒の上限へ達し、HTTP 504になった。
また、CLI試験後の専用configの復元照合は失敗した。
所有するサーバーの停止、tokenと専用HOMEの削除は成功したが、この測定の総合結果はcleanup_incompleteとして保持する。
既存デスクトップの稼働実行と元UIとの同時入力競合は未確認。

## 導入条件と本番対応

管理app-serverへ接続するCLIを、通常指示配信の標準候補とする。
利用者の導入手順では、対応するランタイムの版を揃え、Cockpitが用意した接続先へCLIを起動する条件を明記する。
既存デスクトップへの接続が使えない環境では、未送信指示を次のユーザー入力へ渡す代替を比較する。
代替配信は状態モデルで検証したが、実フックへの差し込みは未確認。
現時点で利用者による追加設定やソフトウェア導入は必要ない。

本番改修は[指示配信 #175](https://github.com/ktysne/agent-cockpit/issues/175)へ切り出した。
管理接続#170、質問応答#174と復旧#162に依存する。
判断・回答6〜10人日、全体26〜42人日と管理接続の追加5〜10人日の概算は維持する。
#175を別途二重計上しない。
本番実装は未実施。
採用方式の合格条件は未達成だが、制約と代替を示してPoCの調査として完了する。
未確認項目の追加検証は#175と#162で扱い、成功とみなさない。
正式レビューの結果は後述する。

## ケース別の判定

| ケース | 現時点の判定 | 根拠と残る確認 |
|---|---|---|
| 1：queue、steer、start | 条件付き | 同じ所有threadのsteer/startは入力証拠を確認。queueはexperimental opt-inが必要で、初回の明示startは拒否。分離したCLI queueは次turnの入力を確認 |
| 2：状態別の通常配信 | 条件付き・一部未確認 | 応答待機中のsteerと停止後startは確認。許可要求を自動応答せず停止できた。ツール実行中・質問待ち・許可待ちでの通常配信は未確認 |
| 3：自動開始と競合 | 条件付き・一部未確認 | expected turn不一致と停止後steerは拒否。分離したCLI queueは明示startなしで次turnを開始。API add単独の時点と元UIとの開始競合は未確認 |
| 4：元UIと二重実行 | 管理CLIは条件付き、既存デスクトップは未確認 | 同じ所有サーバー/threadへCLIを接続し、API入力とCLI入力の同じ会話を確認。既存デスクトップと実UI同時競合は未確認 |
| 5：重複・切断 | 条件付き・一部未確認 | 不変の要求と一意の入力証拠、送信後の無条件再送禁止を検証。queueの同ID異内容は2件。CLI受付後の子プロセス終了とサーバー側turn完了を確認。受付応答喪失と元UI競合は未確認 |
| 6：実行種別 | モデルは確認、native委譲は未確認 | standaloneの作業中/停止後、稼働中delegatedの既存turn、終了済みdelegatedとreviewの拒否を検証。実委譲への配送は別途必要 |
| 7：代替方式 | 管理CLIは条件付き、次入力はモデルのみ | 管理app-serverとCLIの共有を実測。次入力の代替は未送信standalone限定で元経路を固定無効化。実フックの差し込みは未確認 |

未確認項目は接続先・待機モード・実UI競合の証拠が不足しているため残す。
所有する専用サーバーの成功を、既存デスクトップや本番collectorの認証・適用成功へ拡張しない。

## 検証ログ

作業中の初回全体テストは858件中855件成功、3件失敗だった。
1件は追試用markerのテストを先に追加した時点でfixture本体が未対応だったためで、marker反映後の関連検証で解消した。
残る2件は既存の時計依存テストで、[Issue #168](https://github.com/ktysne/agent-cockpit/issues/168)に記録済み。
全件成功とは扱わない。
最終関連検証は通常の分離ランナーで27件すべて成功した。
内訳はモデル12件、fixture6件、runner境界9件。
単一プロセスで複数ファイルを流した試行では総件数の出力前に終了したため、その終了コード0を全件成功の根拠にはせず、分離ランナーで確認した。

ローカル測定の出力はgitignore対象の`poc/out`へ保存した。
固定入力の件数と照合結果を記録し、認証秘密値や実際の会話内容をIssueへ転記しない。

- `poc161-native-lifecycle-20261006-a/native-result.json`：初回のsteer/start/queue比較。
- `poc161-native-{tool,question,approval,stop}-20261006-a/native-result.json`：状態別の初回測定。
- `poc161-native-ui-20261006-a/native-result.json`：制御stdinが閉じたため計測未完了。
- `poc161-native-ui-20261006-b/native-result.json`と`poc161-ui-observation.md`：共有CLI画面、初期gateの504とcleanup不一致。
- `poc161-native-cli-isolated-20261006-a/native-result.json`：APIキューを使わずCLI queueだけを送る分離試験。
- `poc161-native-queue-cli-20261006-b/native-result.json`：自動化したCLI分離試験。新turn1件、入力itemと完了を観測。
- `poc161-native-lifecycle-20261006-b/native-result.json`：API区間を分離するrunnerの参照漏れで計測失敗。後処理は成功。修正後の追試はcへ保存。
- `poc161-native-lifecycle-20261006-c/native-result.json`：参照漏れ修正後の実測。計測成功、API add/startの因果照合は未解決。
- `poc161-full-test-initial.log`：初回全体テスト。
- `poc161-related-pre-followup.log`：marker反映後の関連25件。
- `poc161-related-final.log`：分離ランナーで最終関連27件成功。
