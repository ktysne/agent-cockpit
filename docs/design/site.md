# 配布ページ

https://ktysne.info/agent-cockpit/ に置く紹介ページの構成と、画面の画像の作り方を決める。
見た目は、同じサイトの Windows アプリの紹介ページ(rec-studio、agent-limit-checker の `site/index.template.html`)の様式にそろえる。

## 方針

- **説明の正本は README と `docs/setup.md`**:ページには、README にある導入の依頼文と、README と手順書へのリンクだけを置く。導入の手順、連携ツールの設定、確認の方法をページに写すと、片方だけが直って食い違うためである。
- **ダウンロードの導線は置かない**:Agent Cockpit は zip で配らず、リポジトリを置いて AI に導入させる。ほかの紹介ページのダウンロードの欄は、導入の依頼文をコピーする欄に置き換える。
- **版の差し込みは無い**:版ごとの値を持たないので、テンプレートではなく `site/index.html` をそのまま配る。
- **ライセンス**:ほかのアプリと同じく、紹介ページの横に `license.html` を置き、本体のライセンスと、同梱する第三者のソフトウェアを書く。本体は MIT License で、`license.html` には、リポジトリ直下の `LICENSE` と同じ全文を載せる。利用者は公開リポジトリのソースを取得して使うので、利用、改変、再配布の許可をはっきりさせるためである。Agent Cockpit は外部パッケージを使わないので、同梱は無い。外部パッケージを足したら、このページに足す。開発用の依存である `basic-ftp` は配布物に含めないため、このページには載せない。
- **配色**:ダッシュボードのダークの配色トークン(`src/web/index.html` の `:root[data-theme="dark"]`)を使う。画面の画像がダークで撮られているためである。

## 構成

```
site/
├── index.html          紹介ページ
├── license.html        ライセンスのページ
├── assets/             アイコン(app-icon-256.png。assets/agent-cockpit_icon.png を縮小したもの)
├── shots/*.json        画面の画像の撮影の定義
└── img/<定義名>/       撮影した画像(.png)と部品の矩形(.json)。撮影が生成し、コミットする
```

撮影の定義と部品の矩形の `.json` は配信しない。送る対象は「配信」の節にある。

## 画面の画像

ページには、幅 820px、倍率 1 で撮った画像を 2 枚載せる。
縦の長さは内容に合わせて伸ばす。
表示は種類別にし、欄の並びはアプリの既定の値のままにする。プロダクト別はセッションごとに欄を繰り返すので、縦に長くなりすぎるためである。
Claude Code のメインは Opus 5.5(`claude-opus-5-5`)、Codex のメインは GPT 6.1 Sol(`gpt-6.1-sol`)で動いている体裁にする。

撮影の仕組みはマニュアルと同じで、デモの常駐サーバーにシナリオを流し込んだ画面を撮る([manual.md](manual.md) の「デモ状態」と「スクリーンショットの撮影」)。
画像は撮影の定義とシナリオだけから決まり、時計も固定するので、同じコミットからは同じ画像ができる。

### 各画像が満たす条件

撮り直した後に、次の条件を満たしているかを目で確かめる。

| 定義 | シナリオ | 条件 |
|---|---|---|
| `review` | `site-review` | Claude Code と Codex のセッションがある。「あなたの判断が必要なこと」に、推奨つきの選択肢を 3 つ持つ Claude Code の判断事項がある。PR が 2 段のスタックで、1 段目はクロスレビュー中(2 往復目の結論待ち)、2 段目はレビュー済みで「下の段のマージ待ち」。今やっていることに「Claude Opus 5.5」と「Codex gpt-6.1-sol」のメインがある |
| `work` | `site-work` | Claude Code と Codex のセッションが、それぞれ完了条件つきのタスクを持つ。Claude Code のメインが作業中。サブエージェントが 2 つ稼働中で、1 つは Claude Sonnet 5.5 で動き、もう 1 つは Codex gpt-6-luna に委譲している |

条件を作っているシナリオの要点は次のとおりである。直すときに崩さない。

- **スタックの段の状態**:PR の段の関係は、偽の gh の定義の `base` で作る(2 段目の `base` が 1 段目の head)。段ごとのクロスレビューの状態は、プロダクトの `crossReview.state` にブランチ名ごとに書く。`lastTriage.outcome` が `fixing` ならクロスレビュー中、`converged` ならレビュー済みになる。
- **欄の中の並び**:今やっていることの欄は、最後に動いたセッションが上に並ぶ。上に見せたいセッションは、シナリオの最後のほうで動かす。
- **メインのモデル**:シナリオのセッションの `model` に書く。Codex のセッションは `provider: 'codex'` も書く。
- **表示の種類**:シナリオの最初に `/api/display` で `mode: 'kind'` を送り、撮影の定義でも種類別のボタンを押してから撮る。欄の並び(`sectionOrder`)は送らず、アプリの既定の値のままにする。

### 撮り直す手順

1. Edge か Chrome が入っていることを確かめる。撮影はヘッドレスのブラウザで行う。既定の場所に無いときは、環境変数 `MANUAL_BROWSER` にブラウザの実行ファイルを指定する。
2. 内容を直すときは、次を編集する。
   - 表示する内容(プロダクト名、セッションの題、タスク、判断事項、PR、モデル、時刻):シナリオ `tools/manual/demo/site-review.js` と `site-work.js`
   - 撮る範囲、ウィンドウの幅、倍率、配色:撮影の定義 `site/shots/<定義名>.json`
3. 画面を見ながら直したいときは、`node tools/manual/demo-server.js site-review` でデモのダッシュボードを起動し、表示された URL を開く。止めるには Ctrl+C を押す。
4. `npm run site:capture` で 2 枚を撮る。1 枚だけ撮るときは、`npm run site:capture -- review` のように定義名を足す。画像は `site/img/<定義名>/<定義名>.png` に書かれ、中身が前と同じなら書き換えない。
5. 画像の大きさを `site/img/<定義名>/<定義名>.json` の `width` と `height` で確かめる。幅は 820 になる。大きさが変わったら、`site/index.html` の該当する `img` の `width` と `height` を合わせる。
6. 画像が「各画像が満たす条件」を満たしているかを目で確かめる。内容を変えたら、条件の表と `site/index.html` の画像の説明(`figcaption` と `alt`)も合わせる。
7. `npm test` を流す。撮影の定義の検査は、`site/shots/` の定義も対象にする。

## 配信

配信スクリプト `tools/site-deploy.js` が、FTPS で https://ktysne.info/agent-cockpit/ へ送る。
送る処理は agent-limit-checker の `tools/release-site.js` と同じで、`basic-ftp` を開発用の依存として使う。
開発用の依存は配信する人だけが入れるので、利用者が `npm install` をしなくてよい方針は変わらない。
配信には Node.js 22.15.0 以上が要る。npm のスクリプトが、OS の証明書を使う `--use-system-ca` を付けて起動するためである。

### 送る手順

1. 初回だけ、`tools/deploy.config.example.json` を `tools/deploy.config.json` にコピーし、接続情報を書く。このファイルは認証情報を含むので、Git で管理しない。ファイルの代わりに、環境変数 `AGENT_COCKPIT_FTP_HOST`、`AGENT_COCKPIT_FTP_USER`、`AGENT_COCKPIT_FTP_PASSWORD`、`AGENT_COCKPIT_FTP_REMOTE_ROOT` でも設定できる。
2. `npm install` で開発用の依存を入れる。
3. `npm run site:deploy:dry` で、送るファイルとリモートのパスを確かめる。接続はしない。
4. `npm run site:deploy` で送る。

画像を撮り直した後も、同じ手順で送る。
通信が切れて途中で止まったときも、もう一度送れば揃う。
置き換えの途中で止まると、配信先に `.uploading` や `.previous` の付いたファイルが残ることがあるが、公開するファイルは次の配信で置かれる。

### 送る対象

送る対象はスクリプトが決める。
`assets/` の直下のファイル、`img/<定義名>/` の直下の `.png`、`license.html`、`index.html` を、この順に送る。
ページを最後に送るのは、ページが参照する画像を先に揃えるためである。
`shots/` と `.json` は送らない。

送る前に、`index.html` と `license.html` の `src` と `href` が指すローカルのファイルが、すべて送る対象に入っているかを確かめる。
入っていなければ、何も送らずに止まる。
外部の URL、`mailto:`、ページ内のリンク、`./` は確かめない。
