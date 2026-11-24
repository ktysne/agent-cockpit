# 日本語ガードのフック

開発者に見える文を日本語に保つフックを、リポジトリに置く仕組みと、他のリポジトリへの写し方をまとめる。

## 目的

手元の Claude Code は、グローバル設定に登録したフックで返答を日本語に保っている。決まりの差し込みは `~/.claude/hooks/japanese-guard.js` が、英語の返答の書き直しは `~/.claude/hooks/japanese-guard.py`(Python 版)が担う。
クラウドセッション(claude.ai/code)は `~/.claude` を読まないので、グローバル版が効かない。
そこで、同じ役目のフックをリポジトリの `.claude/` に置き、クラウドでも効かせる。

## 動き

`.claude/hooks/japanese-guard.js` が、次の 4 つのイベントを扱う。

| イベント | 動き |
|---|---|
| `UserPromptSubmit` | 開発者が入力するたびに、日本語で書く決まりを文脈に差し込む |
| `PostToolBatch` | ツールの実行がひとまとまり終わるたびに、同じ決まりを差し込む |
| `SessionStart`(`compact`) | 会話を圧縮した直後に、要約が英語でも日本語で書く決まりを差し込む |
| `Stop` | 最後の返答が英語に偏っていたら、ターンの終了を止めて日本語で書き直させる。書き直しは 1 回だけ |

`Stop` の判定は、手元の Python 版(`~/.claude/hooks/japanese-guard.py`)の `is_english` と同じにしてある。
コードブロック、インラインコード、Markdown リンク(ラベルを含む)、URL、メールアドレスを外したうえで、アルファベットが 25 文字以上あり、日本語の文字(ひらがな、カタカナ、漢字)の 3 倍を超えたら英語とみなす。
バッククォートで囲まないパスは外さないので、アルファベットとして数える。
返答が JSON の値だけ(前後のコードフェンスは許す)のときは、スクリプトが読む出力なので判定しない。

Python 版のうち、次の部分はリポジトリ版に無い。

- transcript を読み、ツール呼び出しの間の途中報告と、次の一手の箱(`wrap_up`)の文言も判定する
- `PreToolUse` で、英語の `wrap_up` を出る前に止める
- 環境変数で閾値を変えたり、判定を止めたりする(`JAPANESE_GUARD_DISABLE` など)
- 差し戻しの理由に、英語だった箇所を引用する

## グローバル版との重複を避ける仕組み

手元では、グローバル版とリポジトリ版が同じイベントで動く。
両方が出力すると、決まりが 2 回差し込まれ、`Stop` も 2 つが同時に書き直しを求める。

そこでリポジトリ版は、ユーザー設定(`$CLAUDE_CONFIG_DIR/settings.json`、未設定なら `~/.claude/settings.json`)を読み、グローバル版を登録しているイベントでは何も出力しない。
グローバル版の登録は、スクリプトとイベントの組で見分ける。
`UserPromptSubmit`、`PostToolBatch`、`Stop` はフックのコマンドか引数に `/japanese-guard.js` が、`SessionStart` は `/compact-language.js` が含まれるときに数える。
`Stop` は、[minorun365/claude-code-japanese-guard](https://github.com/minorun365/claude-code-japanese-guard) の Python 版 `/japanese-guard.py` が含まれるときにも数える。Python 版は書き直しだけを担うので、ほかのイベントでは数えない。
`SessionStart` は、matcher が `compact` に当たる登録だけを数える。
`${CLAUDE_PROJECT_DIR}` を含む登録はリポジトリ版なので数えない。
イベントごとに見分けるので、グローバル版を一部のイベントにだけ登録した環境や、スクリプトを残したまま登録を外した環境でも、ガードが抜けない。

クラウドのユーザー設定にはグローバル版の登録が無いので、リポジトリ版が全イベントで動く。
グローバル版を入れていない手元の環境でも、リポジトリ版が動く。
ユーザー設定が無いか読めないときも、リポジトリ版は動く。重複するほうが、ガードが黙って抜けるより害が小さいためである。

グローバル版のスクリプト名や、それぞれが出力するイベントを変えたら、`GLOBAL_GUARD_EVENTS` も合わせて直す。

## 他のリポジトリへの写し方

1. `.claude/hooks/japanese-guard.js` をそのまま写す。依存は Node.js の標準モジュールだけである
2. `.claude/settings.json` の `hooks` にある 4 つの登録を写す。既に `.claude/settings.json` があるなら、`hooks` の各イベントの配列に足す
3. Node.js のテストがあるリポジトリなら、`test/japanese-guard.test.js` も写す。`require` のパスは写し先の構成に合わせる
4. 写し先の `CLAUDE.md` に「リモートセッション時の作業について」の節を作り、このフックが置いてあることを書く

登録は `"command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/japanese-guard.js"]` の exec 形式にする。
絶対パスで書くと、クラウドや他の開発者の環境で見つからない。
`args` を省いたシェル形式では、空白を含むパスを引用符で囲む必要があり、Git Bash の無い Windows では PowerShell で動くので、波括弧の無い `$CLAUDE_PROJECT_DIR` は展開されない。
exec 形式なら、置き換えたパスがそのまま 1 つの引数として渡る。

## 判定を直すとき

差し込む決まりの文言は `~/.claude/hooks/japanese-guard.js` と同じにし、`Stop` の判定は Python 版の `is_english` と同じにする。
片方だけを直すと、手元とクラウドで動きが食い違う。
