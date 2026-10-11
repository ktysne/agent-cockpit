# Codex 対応の作り直しの計画(2026-10-11)

agent-cockpit を Codex デスクトップと Codex CLI にも対応させる作業を、main から Claude が作り直す計画である。
起点は、PR #384 のマージ(00e9114)を含む main の最新で、既存の集約ブランチ `codex/feature-codex-support` は凍結の印を含む PR #385 のマージコミット e56e4c1 を固定参照として残し、以後は変更しない。
PoC の一式と資料は、同じく固定参照 8c701b1 で読む。
資料ごとの扱いは「資料の扱い」に定める。

対象から外したもの:

- 既存の集約ブランチの整理([2026-10-11-codex-test-cleanup.md](2026-10-11-codex-test-cleanup.md))。2026-10-11 に中止した。
- 質問と配信の記録の容量回収(#209 の段階 2〜4)。上限付きの単純な保存で代替し、肥大化が実際に起きてから設計する。
- 旧版 Codex との互換、cloud や SSH 先の別 host の collector、稼働中のデスクトップへの共有接続。既存の計画の除外をそのまま引き継ぐ。

## 作り直す理由

既存の集約ブランチは、6 日間で 127 本の PR を取り込んだが、製品の入口(フック、MCP、常駐サーバー、トレイ)から `require` でたどり着く新規コードは 11 ファイル 4,000 行にとどまる。
Codex を起動する runner と composition は常駐サーバーから呼ばれておらず、常駐サーバーは Codex を起動も観測もできない。
製品に接続していないコードは 74 ファイル 4.1 万行で、1 関数が 100 行を超え、1.2 万行にコメントが 5 行しかなく、独自の語彙を 50 本の設計資料から復元しないと読めない。
接続のたびに契約が変わって書き直しになる量が、作り直す量に近い。
cockpit 本体と同じ流儀で、入口から 1 機能ずつ実 runtime で確かめながら作るほうが、読める形で残る。

## 現在地と次にやること

2026-10-11 に順序 1 に着手した。
旧集約ブランチの凍結の印([PR #387](https://github.com/ktysne/agent-cockpit/pull/387))は [PR #385](https://github.com/ktysne/agent-cockpit/pull/385) と一緒に feature へ入り、そのマージコミット e56e4c1 が旧集約ブランチの固定参照である。
追跡 Issue #310 の本文は、この計画を正本として指すように 2026-10-11 に更新した。

集約先 `claude/feature-codex-support` は main の eb85530 から作った。
旧計画の判断待ち 4 点と、実装の分担は 2026-10-11 に開発者が決め、「決定済みの判断」に移した。
順序 1 は 2026-10-11 に終えた。
欠陥 Issue は要件 Issue へ転記して閉じ、旧モックの差分は「旧モックの差分の採用」の表のとおり段階ごとに入れる。

集約ブランチを base にした PR をダッシュボードでマージできるようにする変更は、main 向けの [PR #390](https://github.com/ktysne/agent-cockpit/pull/390) で入れ、同期 PR #393 で集約先へ取り込んだ。

2026-10-11 に順序 2(登録と識別)に着手した。
通常の `~/.codex` に記録用のフックと MCP を一時的に入れて実機の入力を記録し、設計資料 [codex-registration.md](../design/codex-registration.md) を書いた(PR #394)。
実装は `impl-hard` で Codex に任せ、Codex CLI とデスクトップで、セッション行、ネイティブの子、MCP の書き込み、再開、`SessionEnd` を確かめた。
実機の `PermissionRequest` は、許可を求める操作を作れず未確認である。
順序 2 は 2026-10-11 に終えた(PR #395)。

順序 3 の資料を読んだところ、bridge は app-server を使っておらず、app-server は cockpit が起動した Codex にしか回答や指示を届けられないと分かった。
普段の Codex のセッションへフックで届けられるかを実機で確かめ、文脈の追加、ターンの途中の差し込み、質問ツールへの回答、`Stop` の続行のどれも届いた。
開発者の決定で、app-server を作らずにフックで届ける方針に順序 3〜6 を組み直した。
Codex の実機検証は、`~/.codex` を書き換えずに Opus が進められる手順にした(`AGENTS.md` と `CLAUDE.md`「Codex の実機検証」)。
この組み直しと検証の道具は 2026-10-11 に集約先へ入り(PR #396)、#170 を対象外として閉じた。
順序 3 の #171 は、委譲した Codex の二重表示の防止を [codex-delegation.md](../design/codex-delegation.md) で設計して実装し、2026-10-11 に終えた(PR #397)。
順序 4 の共通質問(#174)は、登録と表示、離席中の回答、遅い回答の配信の 3 つの PR に分けた。登録と表示は 2026-10-11 に終えた(PR #398)。離席中の回答は 2026-10-12 に終えた(PR #399)。遅い回答の配信も 2026-10-12 に終え(PR #400)、順序 4 を終えた。
再開の回数のテストが同じミリ秒のイベントで間欠的に失敗する問題は、テストの補助で送る側の時刻を付けて直した(PR #401)。
順序 5(通常指示)は 2026-10-12 に着手した。今のモックと Claude の実装に自由な指示を送る機能は無いので、Claude と同じく回答、通知、タスク登録の促しを届ける範囲にし、残る差の `Stop` の待ちを開発者が決めた。
離席中だけ `Stop` で待つ配信は 2026-10-12 に終えた(PR #402)。
順序 6 は開発者の決定で対象外にした。順序 7(保存と復旧)は 2026-10-12 に着手した。再起動の前後を確かめ、Codex の行と、モデル名と再開の回数が戻らない差を、プロセスの生死で戻す形に開発者が決めた。
順序 7 は 2026-10-12 に終えた(PR #405)。
順序 8 は 2026-10-12 に PR #406 を作り、クロスレビューが収束した。Codex のシェルの `gh pr create` は、偽の `gh` を使った実機の確認で `provider: codex` として登録された。マージは開発者が行う。
順序 9 は PR #406 の上に積んで 2026-10-12 に着手した。起点の色分けは見本ページ `mock/origin-colors.html` に 4 案を描き、推奨の案 A(左端の色帯)をモックと実装に仮に入れた。導入手順は `docs/setup.md` のパターン E に書いた。

## 決定済みの判断

| 項目 | 決定 | 理由 |
|---|---|---|
| 進め方(2026-10-11) | main から Claude が作り直す。既存の集約ブランチは固定参照として残す | 開発者の決定。到達する製品コードが 4,000 行にとどまり、未接続の 4.1 万行を理解する費用が書き直す費用に近いため |
| 既存ブランチの整理(2026-10-11) | PR #385(方針の同期)のマージで止め、削除と刈り込みは行わない | 開発者の決定。作り直すなら整理の成果が使われないため |
| 実装の分担(2026-10-11) | メインセッション(Opus)が設計と監査を行う。仕様を依頼文に書ける実装は `impl-*` を通して Codex に任せる。Codex CLI を起動して挙動を見ながら書く実装は、`委譲: Claude 側で実装` を付けて `impl-*-claude` に渡すか、メインセッションが書く。製品を動かす確認は Claude のサブエージェントかメインセッションが行う | 開発者の決定。Codex の Windows サンドボックスは子プロセスを起動できず、製品を動かして確かめられないため |
| レビュー(2026-10-11) | クロスレビューは Codex が行う。Codex 固有の挙動の調査は読み取り専用の `codex-subagent` に頼む | 開発者の決定 |
| Codex への依頼文(2026-10-11) | 到達させる入口、触ってよいファイル、その回に効く「作り直しの原則」を毎回書く。監査では差分が入口から到達するかを最初に見る | 既存の集約ブランチで、Codex が部品を下から積み、接続を後回しにしたため |
| テストの実行(2026-10-11) | Codex の担当は `npm run test:inprocess` まで流す。常駐サーバーを起動するテストと全体の `npm test` は、マージ前に Claude 側で流す | Codex のサンドボックスは子プロセスを起動できないため |
| 集約先(2026-10-11) | `claude/feature-codex-support` を main から作る。`codex/feature-codex-support` はブランチを残して固定参照にする | 開発者の決定 |
| モック(2026-10-11) | 既存ブランチのモック差分は、「旧モックの差分の採用」の表のとおり、その段階の設計と一緒に書き直して入れる。順序 1 ではモックを変えない | 開発者の決定。大きいまとまりは旧実装の内部 ID で表示を分けており、新しい設計に合わせて書き直す必要があるため |
| 中断の状態(2026-10-11) | Codex 対応とは別に、main 向けの #391 で扱う | 開発者の決定。中断は Claude のセッションでも起き、main には検出も表示も無いため |
| ダッシュボードのマージ先(2026-10-11) | base が既定ブランチか、どの PR の head でもないブランチである、スタックの一番下の PR をマージできるようにする(main 向けの PR #390) | 開発者の決定。集約先向けの PR を毎回 GitHub で手でマージしないため |
| 配信の経路(2026-10-11) | Codex への質問の回答と指示はフックで届ける。managed app-server は作らず、#170 は対象外にする | 開発者の決定。普段の Codex のセッションにフックで届けられると実機で確かめたため。app-server は cockpit が起動した Codex にしか届かない |
| 委譲した Codex(2026-10-11) | #171 は二重表示の防止までにし、bridge は変えない | 開発者の決定。bridge は `codex exec` を起動しており、thread ID を cockpit に渡す経路が無いため |
| Claude と同じ仕様(2026-10-11) | Codex の処理と表示は、Claude と同じ目的のものは同じ仕様にする。同じにできない点は開発者に相談する | 開発者の決定。provider ごとに挙動が違うと、使い分けを覚える必要が出るため |
| Codex の質問のカード(2026-10-11) | 在席中の Codex の質問のカードは、質問の後に最初に届いた入力で「元の画面で回答済み(内容は不明)」として閉じる | 開発者の決定。Codex の質問ツールはすぐ戻り、回答の内容を受け取れないため([codex-question.md](../design/codex-question.md)) |
| Codex への遅い回答(2026-10-11) | 離席の期限の後の回答は、ターンの途中なら次のツールの後に、ターンの後なら次の入力のときに届ける。`Stop` で待つかは順序 5 で決める | 開発者の決定。Codex にはセッションを起こす手段(Claude の `asyncRewake`)が無いため |
| 選択肢の無い質問(2026-10-11) | 離席中の自由記入だけの Codex の質問も期限まで待ち、期限で仮定を置いて自分の判断で進めさせ、仮適用にする | 開発者の決定。Claude の質問には必ず推奨があり、同じ場面が無いため |
| Codex の `Stop` で待つ(2026-10-12) | ターンの後に届いた回答と通知は、離席中だけ `Stop` で最大 3600 秒待って届け、続行させる。在席中は待たず、次の入力かツールの後に届ける。Issue #175 の自由な指示と配信台帳は、フックによる配信では作らない | 開発者の決定。Codex には裏で待つ仕組みが無く、待つ間は画面が作業中になるため。離席中は画面を見る人がいない([codex-instructions.md](../design/codex-instructions.md)) |
| 順序 6(2026-10-12) | 停止と結果(#180)は対象外にし、#180 を閉じる | 開発者の決定。モックと Claude の実装に画面から停止する操作は無く、Claude と同じ仕様にすると作るものが無い。#180 の中身の Codex 親から Claude への委譲は bridge の範囲で、bridge は変えない(「委譲した Codex」) |
| Codex の行の復旧(2026-10-12) | 常駐サーバーの再起動の後は、`SessionStart` で記録した Codex 本体のプロセス ID が生きている間だけ、保存した Codex の行を戻す。モデル名と再開の回数も保存する。プロセスが終わったら、Claude と同じく 60 秒後に終了扱いにする。Issue #177 の配信台帳と親子対応の保存は作らない | 開発者の決定。Claude はセッションのファイルにあるプロセスの生死で行を戻すので、同じ考え方にそろえる。Codex デスクトップで複数の会話がプロセスを共有するなら、アプリを閉じるまで行が残る近似を受け入れる([codex-recovery.md](../design/codex-recovery.md)) |
| 順序 8(2026-10-12) | PR とレビューの通知(#179)は Claude と同じ仕様にする。Codex のシェルの `gh pr create` も Claude と同じく検出して PR を登録し、PR に登録元の起点(複数可)を持たせる。マージと衝突の知らせは既存の経路で Codex にも届くことを確かめる。二重通知は Claude と同じ重複の扱いにとどめ、#179 の配信台帳は作らない | 開発者の決定。Claude と同じ目的の処理は同じ仕様にするため |
| 順序 9 の色分け(2026-10-12) | 起点の色分けは、モックに複数の案を描いたうえで、推奨の案をモックと実装に仮に入れる。開発者が案を見て、差し替えるかを決める | 開発者の決定。離席中も実装まで進めるため |
| 通常の `~/.codex` の変更(2026-10-12) | Codex の対話の画面とデスクトップの実機確認のために、通常の `~/.codex` に cockpit のフックと MCP を入れてよい。変える前にバックアップを取り、作業後に sha256 で照合して戻す | 開発者の承認(CLAUDE.md「Codex の実機検証」の承認に当たる) |
| 起点の表示分け(2026-10-12) | 画面に出す情報が Claude 起点か Codex 起点かを、色で見分けられるようにする。画面へ渡すデータは、項目ごとに起点を導ける形に保つ。セッションの中の項目(タスク、判断事項、ツール、許可待ち、サブエージェント)はセッションの `provider` から、Claude のセッションに委譲した Codex はサブエージェントの `isCodex` から導く。セッションの外に出る項目(PR の登録、通知の履歴)は、順序 8 で起点を項目に持たせる。複数のセッションが同じ PR を登録したときは、起点を複数持てる形にする。どこの色を変えるかは、順序 9 でモックに複数の案を描き、開発者が選ぶ | 開発者の決定。混在して動かすと、どちらの情報かを読み分ける必要があるため |
| Codex の実機検証(2026-10-11) | `--dangerously-bypass-hook-trust` と `-c` で、その起動だけにフックを渡す。`~/.codex` は書き換えない | 開発者の決定。Opus が検証を自分で進められるようにするため |
| 欠陥 Issue(2026-10-11) | 既存実装の欠陥 Issue は、要件に当たる部分を要件 Issue に転記して閉じる | 開発者の決定。作り直しで実装自体が無くなり、Issue の対象が消えるため |
| 容量回収(2026-10-11) | #209 の容量回収は作らない。保存は上限付きにし、上限に達したら受付を止めて画面に出す | 開発者の決定。肥大化は実際に起きてから設計するほうが要件が確かになるため |
| テストの基準(2026-10-11) | [docs/testing.md](../testing.md) に従う | PR #384 で定めた。入口から到達しないモジュールの単体テストと、信頼境界の内側への防御検査を書かない |
| メインセッションと相談先(2026-10-11) | メインセッションは Opus が務め、Fable への相談はグローバルの CLAUDE.md「メインセッションが Sonnet, Opus の場合の運用」に従う。この計画で新しい決まりは設けない | 開発者の決定 |

## 作り直しの原則

- 入口から接続する。機能ごとに、フック、MCP、HTTP、画面のどれかの入口から Codex の実 runtime まで通してから次へ進む。入口から到達しないモジュールを feature に入れない。
- cockpit 本体の流儀で書く。状態は `state.js` のイベントの畳み込み、入口は `routes/`、保存は `state-persistence.js` と同じ方式(一時ファイルへ書いて rename、直列化)を使う。独自の語彙は[共有契約](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/design/codex-shared-contract.md)の用語に限り、新しい層(台帳、capsule、墓標、grant)を作らない。
- 保存は機能ごとに、既存の保存ファイルへ上限付きで足す。配信台帳のような共通の保存層を先に作らない。
- 失敗経路の防御は信頼境界(別プロセス、ファイル、HTTP)だけに置く。内部の呼び出しは信頼する。
- 設計資料は機能ごとに 1 本、決定と不変条件だけを書く。既存の設計資料は読んで判断を引き継ぐが、写さない。
- 画面はモックを正本にする。既存ブランチのモック差分(1,255 行)は、採用する部分を選んで main のモックへ先に入れる。

## 持ち込む資料

| 資料(固定参照) | 使い方 |
|---|---|
| [PoC 資料 #157〜#164](https://github.com/ktysne/agent-cockpit/tree/8c701b1e8a5718eccff69f84775f21171b6663d0/docs)(`docs/poc-codex-157.md`〜`164.md`)と [`poc/`](https://github.com/ktysne/agent-cockpit/tree/8c701b1e8a5718eccff69f84775f21171b6663d0/poc) | 各機能の着手前に対応する 1 本を読む。フックと MCP の識別、app-server の接続、質問と許可の分離、指示配信と再開、切断後の復旧、委譲の経路、PR 通知の実測が根拠である |
| [Codex連携の共有契約](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/design/codex-shared-contract.md) | 用語、識別、所有者と handoff、結果返却、失敗と復旧の契約を引き継ぐ |
| [Codex連携の本実装計画](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/design/codex-implementation-plan.md) | 「決定済みの判断」「共通の安全条件」「接続前提と未確認境界」「採用条件と未完了範囲」を引き継ぐ。依存関係の表は順序の参考にし、実装単位の分割は引き継がない |
| [Claude/Codex適合試験](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/design/provider-conformance-testing.md) | 入口からの操作と観測で書かれたシナリオ(ID-F01〜F11)だけを引き継ぐ。内部 fixture の条件の節は引き継がない |
| 既存 runner の runtime 知識([native-transport-environment.md](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/design/native-transport-environment.md)、[native-authentication-url.md](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/design/native-authentication-url.md)、[native-login-serialization.md](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/design/native-login-serialization.md)、[windows-native-executable.md](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/design/windows-native-executable.md)と `src/server/owned-native-runner.js`) | 環境変数の allowlist、認証 URL の origin、ログインの直列化、Windows の実行ファイル、HOME の分離は実測に基づく制約として引き継ぐ。コードは読んで要る関数だけを本体の流儀で書き直す |
| 機能ごとの設計資料([common-questions.md](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/design/common-questions.md)、[instruction-delivery.md](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/design/instruction-delivery.md)、[managed-collector.md](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/design/managed-collector.md)、[native-launch-composition.md](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/design/native-launch-composition.md)) | 機能の着手前に読み、採った判断と理由を新しい設計資料に引き継ぐ |
| 既存ブランチの `mock/index.html` の差分 | 「旧モックの差分の採用」の表の段階で、その段階の設計に合わせて書き直して入れる |
| 既存ブランチの [codex-support.md](https://github.com/ktysne/agent-cockpit/blob/codex/feature-codex-support/docs/handover/codex-support.md) | 「決定済みの判断」と「判断待ち」だけを読む。進みの記録は引き継がない |

## 対応順序、ブランチ、PR

ブランチと PR の運用は `AGENTS.md` と `CLAUDE.md` の「Codex 対応のブランチ運用」に従う。

| 順 | 対象 | 入口と実 runtime の確認 | 持ち込む PoC | 委譲の区分 | 状態(2026-10-11) |
|---|---|---|---|---|---|
| 1 | feature ブランチの作成、この計画の更新、モックの採用範囲の合意、欠陥 Issue の転記、`AGENTS.md` と `CLAUDE.md` のブランチ運用の節 | 採用範囲を開発者が確認する | | メインセッション | 完了(PR #389 ほか) |
| 2 | 登録と識別(#166、#167)。Codex のフックを共通イベントへ変換し、MCP の書込先を provider と native の ID で照合する | Codex デスクトップと CLI のフックが常駐サーバーに届き、セッション行が出る | #157、#159 | Codex、実測は Claude | 完了(PR #394、#395) |
| 3 | 委譲の表示と検証の整備(#171)。委譲した Codex の二重表示の防止をテストで固定し、Codex の実機検証の決まりと道具を置く | 委譲した Codex が親の Claude の行の下にだけ出る | #159 | Codex、実測は Claude | 完了(PR #396、#397) |
| 4 | 共通質問(#174)。質問ツールへの回答を `PreToolUse` で届ける。離席時の推奨適用。#216 の問題を設計に含める | Codex の質問に画面から答え、実 runtime で反映される | #160 | Codex、実測は Claude | 完了([codex-question.md](../design/codex-question.md)。PR #398、#399、#400) |
| 5 | 通常指示(#175)。`Stop`、`PostToolUse`、`UserPromptSubmit` での指示の配信と、受付と適用の分離。#217 の待ち時間を設計に含める | 作業中の Codex に指示が届き、適用の証拠が出る | #161 | Codex、実測は Claude | 完了([codex-instructions.md](../design/codex-instructions.md)。PR #402) |
| 6 | 停止と結果(#180)。フックでは実行中のターンを外から止められないので、停止の手段を決め直す | 画面から停止し、停止したことを確かめる | #163 | Codex、実測は Claude | 対象外(決定済みの判断「順序 6」) |
| 7 | 保存と復旧(#177)。機能ごとの上限付き保存と、再接続後の照合 | 常駐サーバーの再起動後に未受領の回答を保留し、照合後に届ける | #162 | Codex、実測は Claude | 完了([codex-recovery.md](../design/codex-recovery.md)。PR #405) |
| 8 | PR とレビューの通知(#179) | 混在実行の PR 登録とレビュー通知が二重に届かない | #164 | Codex、実測は Claude | レビュー収束、マージ待ち(PR #406) |
| 9 | 画面と導入手順(#167-B、`docs/setup.md`) | 利用者がマニュアルどおりに導入できる | | Codex、実測は Claude | 進行中(PR #406 の上に積む) |
| 10 | main への最終 PR | 全機能の実 runtime 確認を記録する | | メインセッション | 未着手 |

「委譲の区分」の Codex は `impl-*` を通した委譲、Claude は `impl-*-claude` かメインセッションを指す(「決定済みの判断」の実装の分担)。
難易度の区分(light、standard、hard)は着手時にグローバルの CLAUDE.md の基準で選ぶ。
2〜8 は 1 つずつ直列に進める。
同じ `state.js` の入口に触れるため、並行すると衝突するためである。
各段階は、入口のテストと実 runtime の確認の両方が終わってからマージする。

## 段階ごとの設計の要点

既存の共有契約、安全条件、PoC、runner から引き継ぐ判断を、段階ごとに置く。
ここに無い判断は、着手時にその段階の資料を読んで決める。

- **登録と識別(2)**: 自己申告の ID だけでは認証済みにしない。MCP から未確認の ID を受けたら拒否か保留にする。Codex の識別は provider と native の thread ID の組で行い、Claude の session ID と同じ扱いの「正規会話 ID」に正規化する(PoC #157、#159)。
- **委譲の表示と検証の整備(3)**: app-server は作らない(「決定済みの判断」の配信の経路)。#171 は、今の `codex-agent.sh` の検出と run ID の照合のまま、委譲した Codex が親の Claude の行の下にだけ出ることを画面のテストで固定する。`~/.codex-subagent` には cockpit のフックを入れない。レビューは通常の `~/.codex` を使うので、Codex のフックが継承した `CLAUDE_CODE_SESSION_ID` と親の稼働中の委譲行から、委譲した thread のセッション行を作らない([codex-delegation.md](../design/codex-delegation.md))。
- **共通質問(4)**: 質問の宛先は、質問を発行した実行そのものに固定し、親への結果返却先と混同しない。質問への回答と実行許可は分け、許可は元の UI に残す(cockpit に許可を出す口を作らない)。離席時の推奨適用は、開発者が明示的に有効にしたときだけ行い、モデルが申告する期限だけに依存しない(#216 の教訓)。回答は、Codex の質問ツール(実測では `request_user_input_async`)の `PreToolUse` で、拒否の理由として返す。
- **通常指示(5)**: transport の受付と runtime での適用を別々に確かめる。送信の開始を保存してから本文を渡し、保存に失敗したら送信を始めない。結果が不明(unknown)になった配信は自動で再送しない。適用の証拠を待つ時間は、長いツール実行をまたげる長さにする(#217 の教訓)。配信は `Stop` の続行(`decision: block`)と、`PostToolUse`、`UserPromptSubmit` の `additionalContext` で行う。同期の `Stop` で待つ間、Codex は作業中の表示になり `Esc` で中断できるので、待つ時間と差し込みの使い分けを設計で決める。
- **停止と結果(6)**: フックでは実行中のターンを外から止められないので、停止の手段は着手時に決め直す。以下は cockpit が Codex を起動する場合の判断である。結果の返却先は、記録した時点の current owner と世代に固定する。停止は、authority の失効と物理停止を別に確かめ、子プロセスの exit と close の両方を見てから停止済みとする。stdio を閉じて close を作っても停止の証拠にしない。既存 runner から引き継ぐ実測の制約は、環境変数の allowlist(`PATH`、`PATHEXT`、`SYSTEMROOT`、`WINDIR`、`COMSPEC` と proxy、CA の変数)、認証 URL の origin(`https://auth.openai.com`、`https://chatgpt.com`)、ログイン提示の直列化、隔離 HOME に要るディレクトリである。Windows で `.cmd` を認めない制約は #215 が実運用に合わないとしているので、引き継がずに決め直す。
- **保存と復旧(7)**: 保存は機能ごとに既存の保存ファイルへ上限付きで足す。再起動後は、保存した対応関係を現在の証拠と照合してから回答を届け、照合できないものは保留する。unknown を復元しても再送は 0 回にする(PoC #162)。
- **PR とレビューの通知(8)**: PR 通知は正規化した明示の宛先に送る。作成者と current owner を分け、終了した実行には送らない(PoC #164)。

## 旧モックの差分の採用

旧集約ブランチのモックの差分(固定参照 e56e4c1、+1,260 / −77 行)を、画面のまとまりごとに次のとおり扱う。
採用するものも写さず、その段階の設計に合わせて書き直す。
旧モックで丸ごと上書きすると、main が後から足した「読み込み直す」ボタンが消えるので、差分は部分ごとに入れる。

| まとまり | 合意 | 扱い |
|---|---|---|
| Codex の会話を 1 行にまとめる(再開 N 回の札)、委譲した Codex の終了行 | PR #230 で合意済み | 順序 2、3 で入れる |
| native の質問待ちと許可待ちの表示(種類と件数) | #205 で合意済み | 順序 4 で入れる。旧モックでは追加指示と停止の状態に組み込まれており、実機の `PermissionRequest` も未確認のため |
| 共通質問のカード、「質問対応」の件数、隠す条件への組み込み | #221、PR #260 で形を合意済み | 順序 4 で、内部 ID を使わない形に書き直して入れる |
| 追加指示(入力欄、送信、取り下げ、差し替え、宛先の選択) | PR #260 で形を合意済み。復旧パネルなどの細かい表示は合意の記録が無い | 順序 5 で、合意した形だけを書き直して入れる |
| 未構成の機能を隠す(質問、指示) | PR #230 で合意済み | 隠す対象と一緒に、順序 4、5 で入れる |
| 明示停止と受付上限 | 合意の記録が無い(#221 で停止は合意に含まないと明記) | 順序 6 で設計し直し、モックで合意してから入れる |
| 中断の状態 | PR #230 で合意済み | Codex 対応の外で、main 向けの #391 で扱う |
| 合成行の「終了済み」と「状態不明」 | 合意の記録が無い | 採用しない |
| フックを照合できないときの札と、設定の「診断」欄 | 合意の記録が無い | 採用しない(旧実装の欠陥 #207 に付随) |
| 背景で動く Claude サブエージェントを閉じられるようにする | 合意の記録が無い | 採用しない。要るなら main 向けに別に起こす |

## 誤りの検出が難しい設計

次の設計は誤りの検出が難しく、グローバルの CLAUDE.md の運用で Fable に相談する基準に当たりやすい。
相談の要否と回数はその運用に従い、この計画では決めない。

| 段階 | 設計の内容 |
|---|---|
| 4、5 質問と指示 | 配信の状態機械(未送信、送信開始、受付、適用、取消、unknown)を、既存の `decisionLifecycles` の保存の形にどう収めるか |
| 6 停止 | exit と close のどちらかが来ない場合の扱いと、停止未確認のまま新世代で受付を再開する条件 |
| 7 復旧 | 再起動後の照合の順序と、照合できない記録を保留のまま画面に出す形 |

## Issue の扱い

マイルストーン「Codex対応」の Issue は、要件と、既存実装の欠陥に分かれる。

- 要件として残すもの: #166、#167、#171、#174、#175、#177、#179、#180、#310(追跡)。
- 対象外にするもの: #170(managed app-server。「決定済みの判断」の配信の経路)。2026-10-11 に閉じた。
- 既存実装の欠陥で、要件に当たる部分だけを対応する要件 Issue に転記して閉じる候補: #207、#210、#211、#212、#213、#214、#215、#216、#217、#218、#223、#312、#313、#314、#315。
- 対象外にする: #209(容量回収。上限付き保存で代替)。
- 調査が PoC で終わったもの: #156。PoC 資料を固定参照として示して閉じる候補にする。

2026-10-11 に、欠陥 Issue 15 件の要件を要件 Issue(#166、#167、#170、#171、#174、#175、#177、#180、#310)へコメントで転記し、#156、#209 と合わせて 17 件を閉じた。
各段階の着手時は、対応する要件 Issue の転記コメントも読む。

## 判断待ち

| 事項 | 推奨 | 理由 |
|---|---|---|
| 起点の色分けの案(`mock/origin-colors.html` の案 A〜D) | 案 A(左端の色帯)。モックと実装に仮に入れてある | 場所を取らず、一覧を流し見ても起点が分かるため。案 C の淡い背景は、警告やマージできる PR の背景と重なる。色は既存のモデルの札にそろえて Claude を橙、Codex を緑にしたが、緑は「マージできます」の枠と、橙は暗い配色の強調色と近い。差し替えるときは `--origin-claude` と `--origin-codex` の 2 つのトークンを変える |

## 資料の扱い

Codex 対応に関わる資料は次の表のとおりに扱う。
資料を増やすときはこの表に足し、旧資料を直したくなったら直さずにこの計画か新しい設計資料に書く。

| 資料 | 場所 | 扱い |
|---|---|---|
| この計画 | main の `docs/handover/2026-10-11-codex-rebuild.md` | 正本。進み、順序、判断待ちはここにだけ書き、PR のマージや開発者の決定のたびにその場で更新する |
| テストの作成方針 | main の [docs/testing.md](../testing.md) | 正本 |
| cockpit 本体の計画書 | main の [docs/handover/2026-10-02.md](2026-10-02.md) | 本体(main 側)の正本。Codex 対応の進みは書かない。Codex をサブエージェントとして扱う判断(bridge の経路、`--wait` の行の扱い)はこちらにある |
| テスト整理の計画 | main の [docs/handover/2026-10-11-codex-test-cleanup.md](2026-10-11-codex-test-cleanup.md) | 中止。既存ブランチのテストの現状と原因の記録として残す |
| 追跡 Issue [#310](https://github.com/ktysne/agent-cockpit/issues/310) | GitHub | 入口。本文の冒頭でこの計画を指す。段階のチェックリストは使わず、「対応順序、ブランチ、PR」の表を正本にする |
| マイルストーン「Codex対応」 | GitHub | 要件の Issue の分類。既存実装の欠陥 Issue の扱いは「Issue の扱い」 |
| 旧集約ブランチの資料一式(`docs/handover/codex-support.md`、`docs/design/` の 42 本、`AGENTS.md` と `CLAUDE.md` のブランチ運用の節) | コミット e56e4c1(`codex/feature-codex-support` の凍結 head) | 固定参照。読むだけで更新しない。資料の中で「正本」と書かれていても、2026-10-11 以降は正本ではない |
| PoC の一式(`poc/`、`docs/poc-codex-157.md`〜`164.md`) | コミット 8c701b1 | 固定参照 |
| ブランチ運用 | 新 feature の `AGENTS.md` と `CLAUDE.md`「Codex 対応のブランチ運用」 | 正本 |
| 新しい設計資料 | 新 feature の `docs/design/codex-*.md` | 機能ごとに 1 本、着手時に作る。決定と不変条件だけを書く |
| メモリー(`~/.claude/projects/.../memory/`) | 開発機 | この計画への参照だけを置く。進みは書かない |

## 片付けてよいもの

消す前に、ブランチが feature か main にマージ済みかを `git branch --merged` と `gh pr list --head` で確かめる。

- 旧 feature の作業で残った Claude 側の worktree とブランチ: `claude/207-claude-writer-issuer`(`E:/Temp/claude/impl207`)、`claude/lineage-failure-notice`(`E:/Temp/claude/lineage-ui`)、`claude/mock-221-213-draft`(`E:/Temp/claude/mock221`)、`claude/fix-211-unmatched-resolution`、`claude/codex-support-organization-c6e7ed`。
- Codex 側の worktree(`~/.codex/worktrees/` 配下)と、ローカルの `codex/*` ブランチ(156 本)。feature にマージ済みのものは消してよい。
- 既存ブランチの `.cross-review/` 配下の出力。

## 落とし穴

- Codex の Windows サンドボックスは子プロセスを起動できない。実 runtime の確認と、Codex CLI を動かしながら書く実装を Codex に頼まない。
- bridge(claude-codex-bridge)側の変更を伴う #171 と #180 は、別リポジトリの正本と契約も更新する。ホームに置いたスクリプトの写しを恒久の変更先にしない。
- セッションの受付ソケットは送信形式が非公開なので使わない(CLAUDE.md「守ること」)。
- 既存ブランチの `docs/handover/codex-support.md` と `AGENTS.md`「Codex機能のブランチ運用」は旧ブランチ向けで、更新しない。新しい feature では `AGENTS.md` と `CLAUDE.md` の「Codex 対応のブランチ運用」に従う。
- 既存の設計資料は 42 本 1.2 万行ある。機能の着手前に、その機能の資料だけを読む。全部を先に読まない。

## 次のセッションの開始用プロンプト

```
docs/handover/2026-10-11-codex-rebuild.md を読んで、Codex 対応の作り直しを続けてください。
「現在地と次にやること」と「判断待ち」から再開し、順序の表の次の段階へ進んでください。
実装は入口から 1 機能ずつ、実 runtime で確かめてからマージしてください。テストは docs/testing.md に従ってください。
```
