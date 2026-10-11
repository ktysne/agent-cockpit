# provider別表示墓標の先行計測

表示墓標の件数と状態取得時の全件走査を、専有fixtureで計測する。
この資料の結果とcommandはPR #369最終commit `a890ee2b3469aa0474a11aa849aea461802de4fd` の全件走査版を参照する。
後続の[session索引版](projection-display-index.md)は別の計測modelであり、この基準値を上書きしない。
保持条件、索引、TTL、GC、拒否動作、常駐telemetryと公開APIは変更しない。
時間の基準値から製品容量や保持期間を決定しない。

## fixtureと仕様の確認

通常HOME、実セッション、GitHubとネットワークへアクセスしない。
DashboardStateへ専用writerを注入し、固定seed、session IDと時刻のstoreを専用in-memory filesystemで復元する。
readFileは指定fixtureのstore.json以外を拒否し、実ディスクへfallbackしない。
少量の実state操作と合成storeの復元結果を照合する。
保存recordはproductionと同じprovider/sessionの正規順に並べ、復元直後に保存pendingなしを検査し、flush後もwriter書き込み0回を確認する。
別providerと古い書き込みでは削除記録を保持し、同providerの新しいverified-write操作だけで対象の削除記録を解除する。
この確認はstate methodのfixtureであり、HTTP認証とruntime authorityの証拠ではない。

状態routeは専用contextとresponse sinkで直接呼ぶ。
外部の質問、指示、PR、実行、agent検出を固定依存へ置き換え、validated projection record以降の表示統合とJSON生成を測る。
routeが読むUI版のfileはos.tmpdir直下の自作rootだけに置く。
使用を終えたfile handleを閉じ、解決したrootが専用prefix内にあることを確認してからそのrootだけを削除する。
routeの直接Date.nowを変更せず、現在時刻で件数が変わらない固定入力を使う。

## 件数と時間の測定

墓標Nを0、100、1000、10000と変え、session Sとprojection Pは固定する。
別条件ではNを固定してSとPを変える。
Claudeのみ、Codexのみ、同じIDに両provider、unknown混在と、active数固定の履歴入替を分ける。
hide、unhide、delete、繰り返しdeleteと削除解除の操作順を固定する。

件数専用instanceのMap iteratorとlookup methodをwrapし、実yield数と呼出回数を数える。
prototypeは変更せず、時間専用の別instanceにはwrapperを付けない。
全件走査の期待量Map.size×lookup呼出回数を実yield数と照合する。
墓標総数、hidden/deleted、provider別数、distinct session数、出自Map key数と要素数、unknown Set件数を記録する。
出自履歴はメモリー集合であり、永続storeへ保存されるとは扱わない。
churn条件は残存した出自履歴を合成して置くもので、実runtimeの切断や再接続による履歴生成を再現しない。
store全体と表示墓標部分のUTF-8 JSON byte数を分け、heap byte数とは呼ばない。

単調時計で構築、lookup、snapshot、routeと応答JSON、serializeとJSON化、loadと復元を分ける。
構築はloadと復元を含むため、各phaseの時間を足し合わせない。
UI版fileの初回読取りは定常route sampleと混ぜない。
定常routeの時間にはcached UI stampの確認のためのfs.statを含む。
各phaseのsample数、warmup数、中央値、p95と最大値をNode、OS、入力条件とともに出す。
lookup batchの回数は観測したroute lookup数にそろえ、対象IDのround-robin順はrouteの呼出順とは別に定義する。
Sが正ならactive ID、Sが0ならprojection-only IDをlookup batchの対象にする。
このfixtureではSが正の場合のprojectionもactive IDへ対応させるため、製品で起こりうるactiveとprojection-onlyの混在分布は測定していない。
計時の前後でcanonical store JSON、versionとMap.sizeが変わらないことを確認する。
少数sampleのp95は参考値である。
件数とbyte数は同じ入力で再現でき、時間は環境依存とする。

## 実行と出力

手動入口はtools/manual/projection-display-baseline.js、出力はstdoutのJSONだけとする。
十進整数の件数、samples、warmup、seed、provider条件とchurnを受け取り、重複、未知option、負数、指数表記と上限超過を構築前に拒否する。
総fixture件数と推定走査量にも上限を設ける。
これらは計測scriptの事故防止上限であり、製品の上限ではない。
JSONにはschemaVersion、environment、optionsと安定順のscenariosを含め、絶対temp path、乱数UUIDと実行開始時刻を出さない。

既定条件はNの4段階、S/Pの個別変化、provider4条件と履歴残存を順に実行する。
単一条件を調べる場合は--sweepと--provider-modeを指定する。
--tombstonesは重複のない十進整数のcomma区切り、その他のsweepでは--fixed-tombstonesを使う。
Nは保存record総数であり、both条件の同IDのprovider対も2recordとして数える。
both条件でNが奇数なら末尾の単独recordをmanifestへ記録する。

```powershell
node tools/manual/projection-display-baseline.js --help
node tools/manual/projection-display-baseline.js --samples 25 --warmup 1
node tools/manual/projection-display-baseline.js --sweep tombstones --tombstones 0,100,1000,10000 --sessions 8 --projections 8 --provider-mode codex --samples 25 --warmup 1
```

通常testは小規模fixtureの件数、保持、復元、CLI入力とroute応答を検証する。
重いbenchmark loopと固定ms閾値は通常testへ入れない。
実行条件と測定結果は確認後に記録する。
実provider runtime、並行負荷、長期保持、上流snapshot生成と製品のデータ分布は未測定条件に残す。
適合期待値は[provider適合試験](provider-conformance-testing.md)のID-F312-D01〜D08に置く。

## 先行計測の結果

2026-10-11にNode v24.15.0、Windows_NT、win32、x64で上記2つの計測commandを実行した。
seedは312、各phaseは25 sample、warmupは1回で、同時に全体試験やクロスレビューを走らせていない。
他のアプリの負荷は制御していないため、時間はこの実行環境の参考値である。
計測scriptのSHA-256は `bf68c34f4f3cc63899ec93302f893c1c78df09ea563763a7185537fa24a8103b` である。
レビューで見つかったfixture順序による書き戻しを排除した後に再計測した値である。
全15条件とCodexのN sweep4条件は完了した。

S=8、P=8のN sweepでは、両providerともlookupは16回で、実iterator yieldはN×16と一致した。
時間の単位はms、byte数は永続store全体のUTF-8 JSON長である。

| provider | N | 実yield | store byte | route中央値 | route p95 | serialize中央値 | load/normalize/restore中央値 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude | 0 | 0 | 364 | 0.196 | 0.382 | 0.002 | 0.044 |
| Claude | 100 | 1600 | 11411 | 0.158 | 0.272 | 0.060 | 0.528 |
| Claude | 1000 | 16000 | 111911 | 0.307 | 0.414 | 0.588 | 4.213 |
| Claude | 10000 | 160000 | 1125911 | 1.829 | 2.010 | 6.044 | 45.534 |
| Codex | 0 | 0 | 364 | 0.172 | 0.290 | 0.002 | 0.043 |
| Codex | 100 | 1600 | 11311 | 0.160 | 0.282 | 0.060 | 0.518 |
| Codex | 1000 | 16000 | 110911 | 0.303 | 0.429 | 0.589 | 4.257 |
| Codex | 10000 | 160000 | 1115911 | 1.828 | 2.012 | 5.869 | 46.351 |

N=1000でSを1、8、32と変えた条件では、P=8のままlookupは9、16、40回、実yieldは9000、16000、40000だった。
N=1000、S=8でPを0、8、32と変えた条件では、lookupは8、16、40回、実yieldは8000、16000、40000だった。
provider別条件とboth/unknown条件も実yieldと期待値が一致した。
履歴残存の合成条件ではactive 8件を保ったまま出自Mapが108 key、108 provider要素、unknown Setが29件、非active履歴が100件だった。
比較先はproviders sweepのunknown条件（N=100、S=8、P=8、churn=0）であり、履歴残存条件とstore byte数はともに11411だった。
メモリー出自履歴を保存量へ混ぜていない。

この観測は全件走査のN×lookup回数を確認するもので、時間の厳密な比例や許容閾値を証明しない。
小規模試験6件と2ファイルの構文確認は成功した。
固定head `58e8615` の全体試験は3,066件成功、失敗0件、Windows実symlink権限によるskip2件で、指定Claude R2はblockerと要修正0件に収束した。
routeの時間には応答JSON生成を含め、件数用sinkのJSON解析を含めない。
同じIDのCodex削除を解除した後もClaude削除を保持すること、両providerとunknown出自の統合抑止もfixtureで確認した。
保持条件を変えずにsession別参照を設ける案を次の設計候補とし、回収条件は別に検討する。
