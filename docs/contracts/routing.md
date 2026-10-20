# 経路設定の契約

## 正本と保存形式

経路設定の形式の正本は agent-cockpit です。
書き手は `src/server/routing.js` の `RoutingState` だけです。
置き場は `cockpitHomeFromOptions` で決まる agent-cockpit のホームの `routing.json` です。

形式は `{ "agents": <値>, "review": <値> }` です。
`agents` はサブエージェント、`review` はクロスレビューの経路を指定します。
どちらの値も `default`、`codex`、`claude` のいずれかです。

`AtomicJsonWriter` は `JSON.stringify(value, null, 2)` の結果に LF を 1 つ加え、UTF-8、BOM なしで書きます。
キーの順は `agents`、`review`、インデントは 2 空白で、最後の `}` の後にも LF が付きます。
たとえば既定値の本文は次の文字列です（コードブロックの各改行は LF）。

```json
{
  "agents": "default",
  "review": "default"
}
```

## 読み込み時の正規化

`readRouting` と `readRoutingSync` は同じ本文のパーサーを使います。
キーが `agents` と `review` のちょうど 2 つで、どちらの値も許可された値のときだけ採用します。
キーの順序は問いません。
それ以外は全体を既定値 `{ agents: 'default', review: 'default' }` にします。
片方だけを採用することはありません。
配列と `null`、JSON の構文誤り、BOM 付きの本文も全体を既定値にします。

ファイルが無いときは、両方の読み取りが既定値を返します。
読み取りに失敗したときは、再試行後に非同期の `readRouting` は例外を送出し、同期の `readRoutingSync` は `null` を返します。
同期の呼び出し元は `null` のとき経路の指定を出しません。

## 検証データと互換性

検証データは `contracts/routing/` に置きます。
`read/*.json` は `{ description, input, expected }` で、`input` はファイル本文の文字列、ファイル無しは `null`、`expected` は正規化した `{ agents, review }` です。
BOM は入力文字列中の `\ufeff` で表します。
`write/*.json` は `{ description, start, set: { key, value }, expected }` で、`start` は保存前の設定、`set` は更新する設定、`expected` は書き込む本文の文字列です。
期待する本文は末尾 LF も含みます。
`test/routing-contract.test.js` で両方の読み取り結果と書き込みのバイト列を確かめます。

ai-cross-review などのほかの読み手は、agent-cockpit の revision を固定して検証データを取り込み、自分の読み取りを確かめます。
形式を変えるときは、旧読取側との互換性と導入順を含む移行の手順を先に書きます。
