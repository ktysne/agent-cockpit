# Codex委譲実行の識別PoC

## 目的と範囲

[Issue #159](https://github.com/ktysne/agent-cockpit/issues/159)の検証記録。
Claudeからの委譲と独立したCodex実行を区別し、登録済みの起動とnative threadを明示的に対応付ける。
同じcwd、モデル、PIDや開始時刻だけでは実行を結合しない。
表示先はAgent Cockpitのダッシュボードとする。

本書は調査中の記録である。
専用HOMEの固定fixtureとイベント再生による検証を、本番bridge、画面やトレイの実測と分けて扱う。
通常HOMEと既存bridgeの設定は変更しない。

## 検証環境

2026-10-06の開始時に、CLI、デスクトップ同梱実行ファイル、daemonの配置済み実行ファイルがすべて`0.160.0`であることを確認した。
これは各実行ファイルの版の確認であり、このPoCでは稼働daemonへの接続を実行する必要はない。
別の`.codex-subagent`にあるランタイムは対象外とする。
#157のMCP `_meta.threadId`識別と、#158の管理app-server接続の制約を引き継ぐ。

## 検証計画

1. 既存bridgeのrun IDとClaude監査イベントの契約を調べる。
2. 登録済みの親provider、session、agentまたはtool-use、run、attemptとnative threadを照合する試作を作る。
3. 独立2件と委譲2件を同じcwdとモデルで実行し、native JSONとMCPの識別を照合する。
4. 順序逆、重複、遅延、欠落、背景待ち、引継ぎ、再試行と終了未確認のイベントを再生する。
5. 子のタスク、判断事項とPRの宛先、表示用の件数、通知と回答の重複排除を投影モデルで検証する。
6. native Stopをターン終了、bridge resultを委譲終了として扱い、終了した子への遅い回答で新しいexecを起動しないことを確認する。

## 結果

2026-10-06に、固定応答fixtureを使う4件のnative CLI並行実行が成功した。
4プロセスの並行範囲が重なり、最大同時実行数は4、終了コードはすべて0だった。
同じcwdとモデルを使い、別々の専用HOMEから異なる4つのthread IDを得た。
各実行でthread.started、turn.startedとturn.completedを1回ずつ観測した。

JSONのthread IDとMCPの`_meta.threadId`が各実行で一致した。
既知のMCPツールの完了結果だけを証跡として採用し、通常テキストや別ツールに含まれる同形JSONは採用しない。
全実行が同じ合成のClaude session環境変数を継承していたが、宛先はそれぞれのnative threadへ分離された。
起動登録とのbinding、runとattempt、HOMEの識別範囲と親tupleの一致も成功した。
投影はindependentが2件、confirmed_delegatedが2件、関連未確認と監査だけの行が0件だった。

委譲の1件はClaudeメインから直接起動する登録形式、もう1件はClaude子agent経由の登録形式を使った。
これは合成の親登録であり、実Claudeエージェントや現行bridgeからの起動を成功させた結果ではない。
native試験では読み取り専用の識別MCPを呼んだ。
本番のタスク、判断事項やPRへのMCP書き込みとダッシュボード表示は未実施である。

3件はfeatures.hooks=trueとフック定義あり、1件はfalseと定義なしで実行し、いずれもフック記録は0件だった。
fresh HOMEへ信頼情報は導入しておらず、フックの実発火は未観測として扱う。
フックがなくても、登録済みrunnerとJSON、MCPの照合でnativeを識別できた。
所有fixtureを閉じて設定を復元し、生成したruntime HOMEは検証後に除去した。
通常HOME、認証情報と既存bridgeは変更していない。

## ケース別の判定

| ケース | 判定 | 根拠と残る範囲 |
|---|---|---|
| 起動登録とnative識別の照合 | 条件付き | 所有runnerの登録と4 nativeのJSON/MCP識別が一致。外部受信口の認証と現行bridge契約は本番改修が必要 |
| 同じcwdとモデルの独立2件、委譲2件 | 条件付き | 実CLIの最大同時4件、異なる4 IDと宛先分離を確認。委譲の親登録は合成 |
| 直接起動、子agent経由、wait、引継ぎ、再試行 | 条件付き | 親tupleの両形式をnativeで照合。wait、generation付き引継ぎとattempt分離は合成イベントで確認。実Claudeの起動は未確認 |
| 順序逆、重複、遅延、欠落 | 条件付き | native先着と登録前の監査結果を再生し、binding後に1行へ統合。スコープ内の冪等性と別HOME、別attemptの同IDを確認。実環境の配送は未確認 |
| 別HOME、フック有効と無効、既存bridge | 条件付き | 専用HOME4件と機能フラグを分けてJSON/MCP照合。フック発火は未観測。現行bridgeの監査表示は既存4件の回帰が成功 |
| 子のタスク、判断事項とPRの宛先 | 条件付き | モデルで3種の宛先を子に分離し、nativeの識別と登録を照合。本番MCP書き込みは#166の改修後に実測する |
| 件数、許可待ち、長い待ち、前回見てから、トレイ | 未確認 | 試作の行数と稼働件数の投影は確認。本番Codexアダプターと画面が未実装のため、残る状態と通知の二重計上は#167の改修後に実測する |
| Stopと委譲結果、終了した子への遅い回答 | 条件付き | ターン終了と委譲終了を分け、古いattemptと遅延startの復活、終端への回答をモデルで拒否。実配送は#161で検証する |

本番UIや現行bridgeの成功を未確認のまま残す理由は、照合契約とCodexアダプターがまだ実装されていないためである。
これらを実装した後、実Claudeの直接起動と子agent経由の起動、背景waitと引継ぎ、nativeイベント欠落と通知を同じ起動登録で再検証する。
PID、cwdや開始時刻による代替照合は採用しない。

## 識別契約の方針

native threadの識別範囲は実行ホスト、HOMEの識別範囲とthread IDの組み合わせとする。
委譲は起動登録のlaunch ID、bridge run IDとattempt IDで区別し、登録時に発行した照合値を子へ渡す。
子の環境だけで親子関係を認定せず、登録との一致とnative threadの対応を検証する。
照合値は出力やダッシュボードへ含めない。

固定fixtureのnative試験では、runner自身が起動した子のスロットと、そのJSONとMCPのthread ID一致を照合根拠にする。
adapterが返す照合結果の真偽値だけで、外部から届いたイベントを認証するものではない。
本番では認証された起動登録と受信経路の契約が必要になる。

nativeイベントが先に到着した場合は「関連未確認」の行を保持する。
対応付けに成功した後は同じ委譲の行へ統合し、二重の件数や通知を作らない。
同じthreadが別の起動登録へ対応する競合は拒否する。
再試行はattemptを分け、完了済みの実行を遅延イベントで稼働中へ戻さない。

CodexのStopはターン終了、bridgeのresultは委譲実行の終了として扱う。
結果が得られなければ委譲の終了は未確認とする。
回答は照合済みの実行へだけ配送し、終了した委譲先への遅い回答を新しいexecの起動に使わない。
実行許可は通常の質問回答から分け、試作の回答経路では自動承認しない。

MCPの書込先はnativeの識別と登録された起動の対応から決める。
継承した`CLAUDE_CODE_SESSION_ID`をCodexの書込先として採用しない。
子のタスク、判断事項とPRは子の保存先を使い、Claudeメインの計画へ上書きしない。

## 既存動作の確認

既存bridgeは`run=`と`result=`の監査行を出すが、launch ID、attempt IDやnative threadとの照合値を子へ渡す正式な経路はない。
参照したbridgeは`456e7b2b916fcd94fe80e7edc85bd53a233a9d62`で、読み取りだけを行った。
run IDは不透明な値として扱い、その構成に含まれる時刻やPIDをnative threadの結合根拠にしない。
現行のMCPは環境のClaude session IDを使うため、Codex用の書込先解決をそのまま流用できない。

背景Codexの結果行、Agent出力内のrun IDの除外、別の親による`--wait`引継ぎ、run IDのない並列結果の4件は成功した。
実行コマンドは次のとおり。

```powershell
node --test --test-isolation=none --test-name-pattern='背景で起動した Codex|同じ実行 ID の --wait を別の親|同じ親の背景 Codex が複数|Agent の出力に含まれる run=' test/state.test.js
```

これは既存の監査行による状態モデルの確認であり、新しいnative連携や本番画面の合格を示すものではない。

## 再現手順と採用判断

全体テストは780件中778件が成功した。
失敗2件は、固定日時のセッションが保持期間を超える既知の[Issue #168](https://github.com/ktysne/agent-cockpit/issues/168)と一致する。
新しい識別モデル16件とnative runner4件は、この全体実行でも成功した。
クロスレビューはagent-cockpitの経路設定に従い、Codex CLIで実施する。

Node.js、Gitと`0.160.0`のCodex実行ファイルを使用する。
新しい出力先を指定して次のコマンドを実行する。

```powershell
node poc/codex-delegation-identity/run-native.js --codex-path 'C:\path\to\codex.exe' --out poc/out/poc159-reproduction
```

期待結果は、4件の並行実行と正常完了、各JSON/MCPのID一致、独立2件と委譲2件のbindingと宛先分離である。
出力には識別情報の私有記録が含まれるため、`native-results.json`をそのまま公開しない。
fixtureの認証値、照合値、会話本文とツール入出力は結果へ含めない。
細かい入力契約と関連テストは[試作README](../poc/codex-delegation-identity/README.md)を参照する。

既存bridgeのrun IDだけでnativeへ推測結合する方式は採用しない。
認証された起動登録とnative識別を明示照合する方式を条件付きで採用する。
本番bridgeの最小契約は、起動前登録、構造化されたnative識別、attemptごとの結果、generation付きの親引継ぎである。
HOMEの識別範囲は実パスを表示せず、復旧後も照合できるscope IDとして扱う必要がある。
登録の永続化と再接続時の認証は#162へ引き継ぐ。

bridgeと登録の本番対応を[Issue #171](https://github.com/ktysne/agent-cockpit/issues/171)へ切り出した。
MCPの宛先解決は#166、状態と画面は#167、質問と配送は#160と#161に依存する。
この方式の導入にはbridge側の契約変更が必要であり、通常HOMEへ設定を追加するだけでは解決しない。
