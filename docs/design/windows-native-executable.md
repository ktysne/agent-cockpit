# Windowsのnative実行ファイルの診断

owned native runnerのClaude/Codexと、Codex managed processのapp-server/remote CLIは、trusted profileの絶対実行ファイルをshellなしで起動する。
Windowsでは通常の`.exe`ファイルだけを受け付け、`.cmd`、`.bat`、拡張子なしのファイルなどは起動前に`executable_format_unsupported`で拒否する。
大文字の`.EXE`も受け付ける。

既存の絶対path、存在、通常file、非symlinkの検査を先に行い、その診断を優先する。
拡張子の検査はconstructorで完了し、認証callback、隔離HOME配下の作成、child spawnへ進まない。
compositionでは`start`時のrunner生成で検査するため、`admitLaunch`の受理は実行ファイル形式の検証成功を意味しない。
エラーは固定codeだけを示し、実行ファイルの私有pathを含めない。
非Windowsでは拡張子を制限せず、既存の検査と起動を維持する。

Node.jsの[Windowsでのbatch起動の説明](https://github.com/nodejs/node/blob/main/doc/api/child_process.md#spawning-bat-and-cmd-files-on-windows)では、`.cmd`と`.bat`の起動にはshellが必要となる。
この経路はshellへ切り替えず、利用者がproviderのnative `.exe`を明示する契約を維持する。
shell wrapper、自動探索、認証情報の複製は追加しない。
拡張子が一致してもPE形式やprovider CLIとしての正当性、実行成功を保証しないため、壊れた`.exe`の起動失敗は従来の診断に残る。

## 検証境界

両providerのconstructor fixtureで非`.exe`の拒否、認証とspawnの未呼出し、HOME配下の未作成、`.EXE`の受理、既存診断の優先を確認する。
managed processは共通の実行ファイルをapp-serverとremote CLIに使うため、共通constructorの拒否と二つの起動経路でのpath維持を確認する。
fixtureで使う`.exe`は偽childへの注入用であり、実providerのインストールや実runtimeの成功を示さない。
実symlinkを作れない環境と、未実行の非Windows条件は未確認として分ける。
認証保持、ログインの直列化、proxy/CA環境変数、feature設定の実効性は別の契約として残す。
