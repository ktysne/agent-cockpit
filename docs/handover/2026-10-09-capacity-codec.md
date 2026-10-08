# 容量回収codecの計画(2026-10-09)

#209の段階2で、新schemaの入口を製品起動へ接続する前に実装する。
起点は集約ブランチの41dac2aで、mainの#303と#304を同期してから実装PRを積む。
通常readerとwriterの既定形式、標準起動、自動回収はこの共通基盤で変更しない。

## 現在地と次にやること

共通基盤のstrict helper、元byteのUTF-8検査と指紋、正規化したJSONのserializer、容量算術を1aとして実装する。
検証後に1bの質問codecと1cの配信codecへ進み、1dでstore間照合と互換投影を組み合わせる。

## 決定済みの判断

| 項目 | 判断 | 理由 |
|---|---|---|
| 内部分割 | 承認済み段階2のPR1を1a〜1dへ分ける | 共通APIを固定し、codec間の依存と容量証明を独立して監査するため |
| 旧形式の検査 | 公開済みの既存normalizerを再利用する | 新codecに同じidentityとclaimsの規則を重複させないため |
| 新形式 | 正確なfield集合を検査してから既存部分を明示投影する | 未知fieldを削って旧validatorへ渡すと新形式の不正を見逃すため |
| 容量定数 | 1dで解析的上界と実serializerの最大field fixtureを確認する | 最大fixture1つだけでは全入力の上界を証明できないため |

## 対応順序、ブランチ、PR

| 順 | 対象 | ブランチ | PRとbase | 状態 |
|---|---|---|---|---|
| 0 | main #303/#304の同期 | codex/sync-main-304-20261009 | [#306](https://github.com/ktysne/agent-cockpit/pull/306)、base: codex/feature-codex-support | 競合解消済み、2往復でレビュー収束、Draft解除 |
| 1a | codec共通基盤 | codex/reclamation-codec-primitives-209-20261009 | [#307](https://github.com/ktysne/agent-cockpit/pull/307)、base: #306のブランチ | 実装済み、1往復目の指摘対応中 |
| 1b | 質問codec | 作成前 | 1aの上へ積む | 未実装 |
| 1c | 配信codec | 作成前 | 1bの上へ積む | 未実装 |
| 1d | cross-store照合と互換投影 | 作成前 | 1cの上へ積む | 未実装 |

main同期を下からmerge commitで取り込み、1a以降は集約先へ順次渡す。
マージは開発者が行う。
各PRのbaseとheadは作成、レビュー、マージ後にGitHubとgitで照合する。

## 落とし穴

共通基盤の合格は新schemaの検証、容量回収、Claude/Codexの実runtime適合を示さない。
1aはNode標準機能だけを使い、時計、乱数、registry、ファイル保存を呼ばない。
strict helperはown data propertyを検査し、入力getterやtoJSONを実行して値を取得しない。
Proxyのtrapを無副作用で検査できるとは扱わない。

## 次のセッションの開始用プロンプト

```text
agent-cockpitの#209段階2を続けてください。
docs/handover/2026-10-09-capacity-codec.mdの表とGitHubの実際のPR状態を照合し、マージ済みの起点から次のcodecを実装してください。
共通基盤だけで段階2完了とは扱わず、docs/design/codex-capacity-reclamation.mdの1a〜1dの完了条件を使ってください。
通常起動と自動回収へ接続せず、スタックと別ベンダーのクロスレビューで渡してください。
```
