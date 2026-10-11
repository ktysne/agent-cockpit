# Owned Codexの認証URL

account/login/startのchatgpt応答をブラウザへ渡す前に、認証URLのoriginを次の二つへ限定する。

- https://auth.openai.com
- https://chatgpt.com

[公式Codex login実装](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs)のdefault issuerは前者である。
[公式app-serverのbrowser flow](https://learn.chatgpt.com/docs/app-server)は、後者のauthUrlを応答例として示す。
公開資料を根拠に選んだ許可集合であり、インストール済み版が両方を返すことや、将来の全hostを網羅することは確認していない。
未知のoriginは固定codeの`authentication_response_invalid`で拒否し、任意hostを許す設定は追加しない。

## 検査と受け渡し

既存の文字列長4096、制御文字、HTTPS、hostname、usernameとpasswordの拒否を維持し、前後の空白を拒否する。
WHATWG URLで解析したoriginを固定集合と照合する。
HTTPSの既定port443とhostの大文字表記は正規化後に一致すれば受理する。
非標準port、末尾dot、下位subdomain、似たsuffix、IPとlocalhostは許可集合に含めない。

受理後は元の文字列を変更せずtrusted callbackへ渡す。
queryを解析してnonceを生成、保存、書き換える処理は加えず、エラー、snapshotや公開イベントへURLを記録しない。
path、queryとfragmentを個別の許可schemaへ限定せず、ブラウザ上の後続redirectは追跡しない。
originの限定だけで、許可originの全pathの安全性やopen redirectの不在を証明したとは扱わない。

responseのtypeとloginIdを検査してからURLを検査し、その後で早着のlogin completionを照合する。
早着の成功通知があっても不正URLを受理しない。
拒否時はtrusted認証callbackとthread/startを呼ばず、既存の失敗・停止経路を使う。
この時点ではchild起動とlogin/startの送信は済んでいるため、認証処理自体を開始していないとは扱わない。

## 適用範囲と検証

対象はowned Codexのbrowser login応答である。
ClaudeのOAuth token供給、managed remote CLI、credential保存と再利用、同時ログインの直列化を変更しない。
両provider共通の認証方式へ置き換えるものではない。

runnerのfake protocolで、許可集合、原文字列の保持、不許可URLの固定診断、callbackとthread/startの未呼出し、早着completionと停止後応答の境界を検査する。
compositionの実runnerを通る正常系fixtureも許可集合に合わせる。
実認証、SSO、installed runtimeとブラウザ遷移の互換性は別の実runtime試験として残す。
