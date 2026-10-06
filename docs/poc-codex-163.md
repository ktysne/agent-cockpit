# ベンダーをまたぐ委譲経路のPoC

[Issue #163](https://github.com/ktysne/agent-cockpit/issues/163)で、CodexとClaudeの間で次に起動する担当を切り替え、結果を親へ返す方式を調べる。
共通routing modelの31テストとnative runnerの12テストは成功した。固定課題によるClaude CLIの実測も完了した。実runtimeの共有routing、本番bridge統合、Claudeの稼働中cancelは未確認であり、モデル、runner、実vendor、本番動作の証拠を分けて記録する。

## 開始時点の情報

- 作業ブランチは`codex/poc-163-vendor-routing`で、#162の最終コミット`b03ccda`を基点とする。Issue #162は調査完了として閉じられ、関連PR #178は未マージ。
- #162の開始時情報ではCodex CLIは0.160.1、アプリ同梱ランタイムは0.160.0、稼働daemonの版は取得できていない。版の厳密な一致を開始条件にせず、実測時の版と接続状況を記録する。
- Claude CLIのローカル`--help`は2.1.291。`--print`、`--output-format json`、`--no-session-persistence`、`--safe-mode`、`--tools`、`--strict-mcp-config`の選択肢を確認した。helpの記録は[poc163-claude-help.txt](../poc/out/poc163-claude-help.txt)にある。
- Codexのネイティブ子へ固定入力`9*7`を渡し、親が`{"marker":"POC163_RESULT","answer":63}`を受領した。設定上のmodelは`gpt-6-luna`、effortは`high`。実行時のmodel metadataとnative thread IDは取得できず、共有routingの自動適用もなかった。[実測JSON](../poc/out/poc163-native-codex-probe.json)
- Claude CLI 2.1.291に同じ固定課題を実行し、markerと`answer: 63`が一致した。要求profileは`sonnet`/`low`、実測modelは`claude-sonnet-5-5`、実effortは取得できなかった。version/modelのowned processはともにexit 0で終了確認済み。[Claude実測JSON](../poc/out/poc163-claude-291-a/result.json)
- owned Node fixtureへcancelとSIGTERMを送り、closeとowned childの終了を確認した。この試験はClaude稼働中のcancelを測ったものではない。[cancel実測JSON](../poc/out/poc163-cancel-node-a/result.json)
- 子のツール呼出し全体は確認していない。OS sandboxの継承、Claudeとのモデル比較、本番routingやbridge連携はこの実測から判断しない。
- #159の親子識別モデルと#162の復旧条件を前提として参照する。vendor固有のIDをCodexのthread IDと同一視しない。

## 7ケースの現時点の判定

判定は現時点の証拠だけに基づく。「条件付き」は限定された経路またはモデル上の契約が確認対象になっている状態であり、実測完了を意味しない。

| ケース | 判定 | 根拠と残る確認 |
| --- | --- | --- |
| 1. Codexネイティブ子と外部Claude runnerが固定目的の結果を親へ返す | 条件付き | 両方から固定JSONの63を得た。Claudeは実測modelが`claude-sonnet-5-5`、effort不明。Codexはruntime model/native thread ID不明のため、同一profileの比較や一般的な能力同等性は確認していない。 |
| 2. 共通routingをClaudeとCodexの両方から読み、default/claude/codexを選ぶ | 条件付き | `RoutingModel`の31テストに専用ファイルを使ったrouting read/write試験を含み、合成Claude/Codex callerのdefault/claude/codex予約を確認した。実probeではCodex childへの自動routing適用はfalse。通常runtime双方の共通設定読取りは未確認。 |
| 3. 実行中の設定変更を既存runへ適用せず、次の起動に反映する | 条件付き | modelと専用shared-routing file fixtureで、既存launchのsnapshotを保ち、新しい予約に更新後のrouteを反映することを検証した。実runtime dispatcherでの固定は未確認。 |
| 4. model、effort、親子ID、終了、失敗、上限、未導入、cancelを共通契約へ表す | 条件付き | 31 model + 12 native runnerの関連43テストが成功。Claude実測では要求`sonnet`/`low`に対し実model`claude-sonnet-5-5`、実effort null、version/model child exit 0。実vendorでのlimit・多様な失敗・Claude中cancelは未確認。 |
| 5. 外部ClaudeとCodexのshell/native観測を一つのrunとして表示する | 条件付き | modelはcanonical launchとvendor別IDの照合を検証した。Claude session IDは取得したが、Codex native IDは未取得。production `state.js`の照合はCodex固有であり、モデル成功は本番の重複排除を証明しない。 |
| 6. 認証・sandboxを保ち、子の再委譲ループを防ぐ | 条件付き | Claudeは通常のユーザー認証contextで、tools空、customization無効、MCP空指定、session保存無効、permission bypassなしで実行した。tool count、実permission mode、OS sandbox継承、子孫processは未観測。Codex認証はコピーしていない。 |
| 7. bridgeの許可コマンド、起動、状態観測、結果返却の分担を決める | 条件付き | Cockpitとbridgeの責任境界を整理して本番Issue #180へ引き継いだ。外部bridge実装のコード監査、collector、dashboardとの接続試験は未実施。 |

## 共通モデルで確認した契約

`RoutingModel`と関連テスト31件、native runnerの12件、計43件が成功した。これはPoCの個別検証であり、実runtimeの共有routingや本番統合の成功を意味しない。

`reserveLaunch`は検証済みrouting snapshot、vendor別固定profile、親、workspace、depthと祖先列からlaunchを作る。`default`は親providerへ解決し、launch後に同じ識別子でrouteやprofileを変えた要求は拒否する。予約だけでは起動せず、`beginLaunch`の成功後に観測や結果を受け付ける。終了済みまたは終了状態が不明な子、cancel済みlaunch、終了済みparentは開始できない。

結果受領、owned childのexit、親へのresult返却は別状態である。unknown exitは未確認として保持し、親への返却を止めるが、後から根拠のあるknown exitを記録できる。known exitの後に初めて届いたresultは拒否する。exit不明でもowned childへのcancel要求は記録でき、cancel完了には終了証拠が必要となる。

native identityのsource名はvendor固有IDの観測を表し、Codex native transportだけを意味しない。Claude identityは`sessionId`、Codex identityは`threadId`を要求し、両者の混在やprovider不一致を拒否する。識別scopeはprovider、ID種別、host、HOME scopeを含む。Claude CLIのfinal JSONに含まれるsession IDは帰属情報として扱い、child exitは所有processのclose観測で確認する。Codex native exitは`nativeCodex` transportに限る。

Claude runnerは要求`sonnet`/`low`に対して実model`claude-sonnet-5-5`を返し、固定JSONを完全一致で出力した。実effortはnullで、tool call countは未観測のまま保存されている。version probeとmodel processは両方exit 0、owned process 2件は終了を確認した。descendant process tree、OS sandbox inheritance、admin policyは観測していない。raw stdout/stderrは保存せず、許可された識別情報と固定結果だけをJSONへ記録した。

別fixtureでNode childへのcancel要求とkill要求を記録し、SIGTERMでのcloseとowned child終了を確認した。これはprocess ownershipと後始末の試験であり、Claude runnerが応答中のcancel挙動ではない。

## runtimeおよび本番側の残作業

実測されたnative childは結果を返したが、`shared_routing_automatically_applied`はfalseだった。`src/server/state.js`にはClaude配下のCodex childを`isCodex`、`parent_agent_id`、`runId`（欠落候補も許容）で照合する既存処理がある。PoCモデルのcanonical launchは、この本番照合や重複排除が成功した証拠ではない。

本番化する場合の候補範囲は、`src/server/state.js`のprovider共通化とstrict launch登録照合、`src/hooks/route.js`のCodex起動adapter追加である。これは将来の変更範囲候補であり、現在の実装を不具合と判定する記述ではない。

bridge資料上の責任分担案は、Cockpit側が共有routing、launch識別、観測の重複抑止、結果通知を担い、bridge側がvendor profile、限定された許可コマンド、runner登録、exit/cancel契約を担う形である。既存allowlistを汎用shellへ広げない。これはdocsで確認した役割案に限り、外部bridge実装自体は監査していない。通常homeの導入設定を変更する場合は、実装後に開発者の承認を得る。本番改修の引継ぎ先は[Issue #180](https://github.com/ktysne/agent-cockpit/issues/180)。

条件付きの採用候補は共通dispatcherとvendor別runnerの組合せである。ネイティブCodex子のmodel設定だけでClaudeへ置き換える方式は採用しない。toolなしの最小runnerが成功しても、toolを有効にする本番runnerの権限、sandbox、認証を合格としない。

## #164への仮契約引継ぎ

[Issue #164](https://github.com/ktysne/agent-cockpit/issues/164)は#163の作業中モジュールをimportせず、仮契約をfixtureへ明示する。照合対象はlaunch/run/attemptと親provider/session/agent/tool-use、vendor固有native ID、起動時に固定したvendor/model/effort/transportである。result受領、子exit、親への返却、cancel要求/確定を分け、PID/cwd/時刻の近さで結合しない。unknown exitや親終了後を成功/再開扱いにしない。この契約はmodelで確認したもので、Cockpit/bridge間の実連携ではない。

## 検証方針

共有routingはClaude主軸とCodex主軸の両方から読める設定として扱う。比較用profileはvendorごとに固定し、選択したvendor、設定model/effortと実行時に取得できた値、workspace scope、親IDをlaunchへ固定する。値の文字列が揃っても同じモデルや能力とはみなさない。`default`は起動要求元の既定vendorへ解決する。設定変更は新しいlaunchから適用し、稼働中のrunを切り替えたり自動retryしたりしない。

native Codex child、Claude CLI、shell runnerは、親が発行したlaunch/run/attempt識別子でまとめる。実測で結び付けられないnative IDは未照合として残す。cwd、PID、時刻、model名だけでrunを同一視しない。再委譲は深さ1とし、祖先launchとのcycleを拒否する。

Claude runnerは固定された実行ファイル、専用cwd、shellを介さないargv配列、tool制限を使う。候補flagはローカルhelpで確認済みだが、互換性と実際の制限効果はrunner試験で確認する。Claudeは通常の自身の認証を使い、Codexの認証情報をコピーしない。tool無効化や`--restricted`はOS sandbox継承の証拠として扱わない。

結果受領、内容の妥当性、子processの終了、親への引き渡しを別状態で記録する。受付応答だけで結果適用を成功とみなさず、停止要求だけでcancel完了とみなさない。timeout、出力上限、未導入、rate limit、unknown endを別の結果として扱い、raw model outputや認証情報を保存しない。

既存bridgeでは、許可コマンド、起動登録、状態観測、結果返却の境界を調べて担当を記録する。本PoCの実測は本番allowlistを広げる根拠にしない。本番collector、dashboard、画面やmockの変更はこの調査範囲に含めない。

## 追加設定

現時点で開発者に依頼する追加設定はない。Claude CLI 2.1.291は現在ユーザーの認証contextで固定課題を実行できた。通常homeへの意図的な設定変更やhome copyは行っていないが、home writeの副作用自体は観測していない。Codexの認証をClaudeへ流用しない。

## 再現手順

前提はNode.jsと既存のClaude認証である。この環境のrunnerは`C:\Users\mss02968\.local\bin\claude.exe`を固定実行ファイルとして使う。別端末では`native-runner.js`の`CLAUDE_EXECUTABLE`をその端末の絶対パスに調整する。PowerShellではrun IDを新規生成し、まだ存在しない`poc/out`出力先を使う。runnerは既存ディレクトリを上書きしない。Claude実測では通常のユーザー認証を使い、Codex認証をコピーしない。

```powershell
$RunId = [guid]::NewGuid().ToString('N')
node poc/codex-vendor-routing/native-runner.js --mode claude --out "poc/out/poc163-claude-$RunId"
node poc/codex-vendor-routing/native-runner.js --mode cancel-fixture --fixture-child node --cancel-after-ms 100 --out "poc/out/poc163-cancel-node-$RunId"
node --test --test-isolation=none poc/codex-vendor-routing/routing-model.test.js
node --test --test-isolation=none poc/codex-vendor-routing/native.test.js
```

Claude runnerはJSONに許可された識別・結果フィールドのみを保存し、raw outputは保存しない。tool call count、実permission mode、descendant process tree、OS sandbox継承は取得できない。cancel-fixtureはNode processの所有・終了を確かめるもので、Claude実行中cancelの再現ではない。

## テスト結果と残る制約

関連テストはRoutingModel 31件とnative runner 12件の計43件が成功した。全体`npm test`は963件中961件成功、2件失敗。2件は既知の時計依存Issue #168（`test/pull-requests.test.js:617`、`test/server.test.js:184`）で、新しいPoCテストの失敗ではない。

Claudeの固定課題とowned Node cancel fixtureは完了した。Claude稼働中cancel、Codex native runtime ID/実profile、両親からの実runtime共通routing、実runの本番重複排除、sandbox継承、bridge/collector接続は未確認であり、本番改修をIssue #180へ引き継いだ。Issue #164では上記の仮契約をfixtureへ明示し、実連携と区別する。

このPoCは制約と追加検証を示す調査として完了できる。条件付き採用候補の本番合格とは分ける。親Issue #156の見積もり26〜42人日、管理app-server接続の追加5〜10人日は維持し、Issue #180の工数を二重加算しない。
