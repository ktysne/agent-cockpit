# Native起動へ渡す通信環境

owned runnerのClaude/CodexとCodex managed processのapp-server/remote CLIは、既存の信頼済み環境から次の5変数だけを通信設定として子へ渡す。

| 固定名 | 値の扱い |
|---|---|
| HTTPS_PROXY、HTTP_PROXY、NO_PROXY | 非空文字列を変更せず渡す |
| SSL_CERT_FILE、NODE_EXTRA_CA_CERTS | ホストOSの完全な絶対パスを変更せず渡す |

既存のOS起動変数の許可リストと、専有HOME、temp、XDG、OAuth、remote capabilityの固定供給を維持する。
任意の環境変数overrideやprofile設定の入力口は追加しない。
ALL_PROXY、SSL_CERT_DIR、NODE_OPTIONS、NODE_TLS_REJECT_UNAUTHORIZED、他の秘密変数や任意endpointを継承しない。

## 値の検査と供給時点

owned runnerはprocess.env、managed processは構築時に受け取った既存environment参照から、各spawn直前に固定名を一度ずつ読む。
undefinedと空文字列は省略する。
非文字列、NUL、CR、LF、値取得時の例外は、値や私有パス、元例外のcauseを含まない`invalid_transport_environment`で当該起動を拒否する。
URLの独自解析、trim、CAパスの自動補完は行わない。

CAはPOSIXの絶対パス、Windowsのドライブ付き絶対パスまたはserverとshareを持つUNC表記を受け付ける。
Windowsのドライブ相対パス、ドライブを省いた単一root表記とdevice namespace表記を拒否する。
検査は文字列の条件だけであり、存在、読取可否、symlink、ACL、証明書内容を検証せず、ファイルの読取、複製や変更も行わない。
不正なCA設定を黙って省略し、標準のtrustへ戻す扱いにはしない。

固定uppercase名だけを読むため、plain objectのlowercase名とPOSIXのlowercase-only設定は継承しない。
Windowsのmain threadにおけるprocess.envの大小文字を区別しない読取は、既存のOS動作を維持する。
Workerや別OSで同じ結果を確認したとは扱わない。
供給元の変更は次の起動へ反映され得るが、起動済みchildへ渡した値を撤回しない。

## 一時環境の寿命と秘密値

owned ClaudeのMCP wait endpointの開始待機を終えてから環境を構築し、構築後にもownerの有効性を検査して同期spawnする。
構築とspawnの間に新しいawaitを挟まない。
構築途中の失敗はbuilder内で部分結果を消し、構築完了後のguard失敗とspawn成功または同期throwではfinallyで全keyを消去する。
owned runnerはkeyを削除し、managed processの二つの経路は全keyを空文字へ戻す。
供給元のobjectは変更しない。
これは一時objectへの値の残留を抑止する処理であり、OSメモリーのzeroizationやchildの環境消去を保証しない。

診断、args、snapshot、ログや保存設定へ通信環境の値を追加しない。
managed remote CLIは既存のstdio:inheritを維持するため、child自身の出力を含む秘密非出力は保証対象にしない。
不正環境の検査より前に認証callbackやMCP wait endpointの起動が済む場合がある。
endpoint起動後の失敗は既存の停止経路で扱い、stop呼出だけを物理停止の証拠にしない。

## 検証と実runtimeの境界

4つのfake spawn経路で、値の完全一致、不正時のspawn未呼出し、供給元の保持、一時環境の消去、既存HOMEと認証の供給を検査する。
架空のproxy credentialを使い、通常HOMEや実環境の秘密値を検証成果物に含めない。
providerが各変数を使用すること、proxyやCAを経た接続成功、ログインの再利用と機能設定の実効性は実runtimeの別検証として残す。

[Node.jsのprocess.env](https://nodejs.org/api/process.html#processenv)はWindows main threadとWorkerの読取の違いを説明している。
[path.isAbsolute](https://nodejs.org/api/path.html#pathisabsolutepath)は文字列の絶対表記の判定であり、パスの安全性を証明しない。
[NODE_EXTRA_CA_CERTS](https://nodejs.org/api/cli.html#node_extra_ca_certsfile)はNodeプロセスの起動時に読む設定だが、各providerの配布実行形態で有効であることはこの資料から推定しない。
