# provider別表示記録のsession索引

状態取得のsession別lookupを、全表示記録の走査から対象sessionのkey参照へ置き換える。
保持、削除解除、providerの曖昧性、保存schemaと公開APIを維持する。
TTL、GC、容量制限と出自履歴の回収は別作業とする。

## 所有と順序

内部collectionがcanonical Mapとsession IDからkey集合へのMapを所有する。
record本体をcanonical Mapへ一度だけ置き、session索引は挿入順のSetでkeyを参照する。
既存keyの置換は位置を維持し、削除後の再追加は末尾へ移す。
同じsessionのClaude/Codex recordを旧全件走査と同じ順序で返す。
返却recordはcopyとし、内部recordを外へ渡さない。

DashboardStateのprojectionDisplaySettingsは診断用getterとしてMapとrecordのcopyを返す。
確認したcallerのsize/values読取りを維持し、返却Mapの変更からstateを変更する挙動は維持しない。
これは内部propertyのmutation互換境界の変更である。
対象sessionのlookupはこの診断getterを経由しない。

constructor、restore、hide/unhide、delete、verified-write解除とclearHiddenSessionsを同じcollectionの更新へ集約する。
最後のkeyを消したsession bucketを削除し、restoreは旧recordと旧索引を一緒に置き換える。
timestamp変更はrecordの置換として反映し、canonical keyのidentityを後から変更しない。
serializeStoreの正規sortとcopy、store正規化は維持する。
毎lookupの全件整合検査と全件走査へのfallbackは置かない。

## 検証と計測

独立した旧Map全件走査oracleで配列順と保存結果を比較する。
単体試験で対象lookup中のcanonical Mapの全件iterator使用を拒否し、無関係recordが増えても対象bucketだけを辿ることを確認する。
計装は試験専用の隔離realmで行い、global prototypeと製品APIを変更しない。
関連試験では同IDの両provider、unknown出自、削除抑止、古いwriteと新しい同provider writeを確認する。
実provider runtimeは今回のfixture成功と区別する。

PR #369の全件走査値とscript hashは固定baselineとして保持する。
手動scriptはschemaVersionまたはmeasurementModelを更新し、lookup呼出回数と返却record数を測る。
schemaVersionは2、measurementModelのnameはsession-indexとし、bucketVisitsはnot-observedと明記する。
索引bucketの訪問数は別の観測点がなければ実測と呼ばず、構造からの期待値として区別する。
旧診断Mapのwrapperによる0 yieldを索引の訪問数として出力しない。
同じmanifestで保存byte数と件数を比較し、索引版の結果を別artifactへ記録する。
estimatedLegacyFullScanVisitsは旧走査に相当する保守的な事故防止予算であり、索引版の訪問数の実測ではない。
追加索引はO(N)の参照とbucketを使い、保存量とheap使用量を同一視しない。
固定ms閾値は通常testへ入れない。

未知の直接mutation caller、順序不一致、保持条件の変更または全件走査fallbackの必要が判明した場合は実装を止めて設計へ戻る。
適合期待値は[provider適合試験](provider-conformance-testing.md)のID-F312-E01〜E09に置く。

## fixture検証と計測結果

関連試験84件と構文確認は成功した。
最後の空bucket削除assert補強後の隔離realm試験1件も成功し、全件iterator 0回、対象2 recordのcanonical getとSet訪問は各2回だった。
これらは単体fixtureで観測したもので、手動route計測のbucket訪問数とは区別する。

2026-10-11にNode v24.15.0、Windows_NT、win32、x64、seed 312で旧基準と同じ全15条件とCodex N sweep4条件を測定した。
各phaseは25 sample、warmup 1で、全体試験とレビューは並行実行していない。
他のアプリの負荷は制御していないため時間は参考値である。
計測scriptのSHA-256は `071642cd6f716f2328a35b8a07514cf35c3b0a806d5d4c7b1a8cf16ee4cf1d78` である。
全19条件でmanifest、表示と出自の件数、lookup回数、routeのJSON byte数と保存byte数が旧基準と一致した。
復元の書き戻しと計時中のstate変更は検出されなかった。

N=10000、S=8、P=8では両providerともlookup 16回、返却record数16を観測した。
時間の単位はmsである。

| provider | route中央値（旧→索引） | 索引route p95 | lookup中央値（索引） | serialize中央値（旧→索引） | restore中央値（旧→索引） |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude | 1.829→0.155 | 0.251 | 0.003 | 6.044→6.424 | 45.534→50.059 |
| Codex | 1.828→0.153 | 0.227 | 0.003 | 5.869→6.237 | 46.351→49.451 |

lookupの仕事量を対象sessionへ限定した一方、復元には索引構築が加わる。
serializeとrestoreは全recordを扱い、測定した時間は上表のとおり増えた。
heap容量、製品の分布、実runtime、並行負荷と長期保持は未確認である。
固定head `3bfd407` の全体試験は3,069件成功、失敗0件、Windows実symlink権限によるskip2件だった。
開発者指定のClaude R1はblockerと要修正0件で収束した。
