# 共通質問と回答配信

## 対象と依存

Issue #174の通常判断をAgent Cockpitで受け付け、質問の選択履歴を永続配信台帳へ接続する。
登録と実行先の照合には#166/#171のregistryを、配信には#175-A/#177-Aの永続台帳を使う。
native由来と元UI競合、実runtimeの1分、5分、30分待機は採用条件として追跡し、fixture成功で置き換えない。

## 質問と認証

完全identity、periodId、questionIdで質問を識別する。
質問内容のdigestを固定し、同じ質問の再登録で初回deadlineを延長しない。
同じkeyで内容が違う入力を拒否する。
単一選択、複数選択、自由記入、複数質問を明示schemaで保持し、未知形式を変換しない。
質問の分類は通常判断に限定し、許可、ネットワーク許可、アプリ操作、分類不明を自動回答しない。
共通MCPの由来は認証済みtool呼出しとし、native入力はtrusted verifierが由来と対象を照合できる場合だけ受け付ける。

MCPのwriterは166のtoken、完全identity、executionId、contextIdを検証する。
171の認証済みlive actor記録のidentity、period、contextから一意なlaunchRefとexecutionBindingへ対応付け、不変起動bindingとも照合する。
writer token、proof、接続handleを質問journalへ保存しない。
ownerが不明または終了していても質問を解決済みにせず、質問の配信だけを保留する。
回答先は発行した子自身のexecutionBindingであり、結果返却先のownerへ変更しない。

## 保存と復旧

checkpoint v1は変更せず、質問journalを別の厳密なversion付きファイルとして保存する。
journalは質問内容、完全identity、period、固定launch/binding、初回時刻、deadline、保留状態、選択と離席仮選択の区別、固定配信意図、外部解決、遅い回答を保持する。
配信意図はdeliveryAttemptId、logicalMessageId、revision、payloadDigestを含む。
選択と配信意図のjournal保存を終えてから、同じIDと内容で193のcreateQuestionDeliveryを呼ぶ。
二つのファイルを同時にcommitしたと扱わない。
途中停止後は意図と実台帳を照合し、配送がない場合だけ現在認証を確認して同じIDで作成する。
別のattempt IDを発行して復旧しない。
台帳に配送があるのにjournalが欠落または不一致なら保留し、空journalから回答を再構築しない。
未知版、破損、参照不整合、上限超過を拒否し、保存結果不明時はwriterを停止する。
同じjournalのwriter排他はプロセス内で行うため、別プロセスを同じ保存先のwriterとして起動しない。
一時ファイルからrenameして保存し、電源断に対するfsync保証や二つの保存ファイルの原子的なcommitは提供しない。

availableまたはclaimedだけが本文の再取得対象となる。
journalから内容を再構成してdigestを照合し、193のrehydratePayloadで現在宛先を再確認する。
sending、accepted、unknownを復元しても自動再送しない。
選択の履歴を適用証拠とみなさず、配信状態は193台帳を正本として読み取る。

## pollと競合

登録と状態pollは回答payloadと自由記入の値を返さない。
状態pollは選択の由来、revision、時刻と配信状態を示す。
回答pollは193のsendStartを通し、sending保存後のtrusted同期sinkでだけMCP/HTTP応答を構築して返却する。
同じdeliveryの二度目のpollは本文を露出しない。
応答返却を受付や適用の証拠とせず、応答喪失をunknownにして自動再送しない。
取消とsend-startの勝敗は193の単一writerで決める。

元UIの解決はtrusted adapterが完全な質問相関を照合して通知する。
回答内容が不明なら不明のまま保持する。
解決通知の抑止flagは同期で更新し、保存をqueueへ載せる。
保存待ち中に外部解決を観測した場合もsink入口で本文返却を止める。
保存失敗時に抑止を解除しない。
送信開始後は外部解決を理由に未送信確定や再送を生成しない。

## 期限と遅い回答

期限は登録時の設定から固定する。
期限判定時にも離席中で、未選択かつ未解決かつ保留されておらず、全質問に明示した単一選択の推奨がある場合だけ仮選択する。
一部の質問だけを仮選択しない。
手動選択と期限判定をservice queueで直列化する。
仮選択後の遅い回答は元質問へ再適用せず、後続通常指示の意図として保持する。
#175-Bが未接続なら後続配信は保持中として示し、質問回答transportへ変換しない。

## 共通scenario

自動試験の期限は各5秒で、IDと時計以外の意味差の許容は0とする。
両providerの実registration、launch、runtime、delivery adapterと実file storeを通す。
認証issuerとruntime sinkがfixtureの場合は実native成功と扱わない。

| ID | 操作と観測点 | 共通期待値と禁止副作用 |
|---|---|---|
| ID-F07-A01 | 認証登録、同内容再登録、異内容再登録、別HOMEと別期間 | 固定keyとdeadlineを保持。不一致登録と旧期間の書込み0 |
| ID-F07-A02 | 単一、複数、自由記入、複数質問の選択 | 形式と全質問の回答を保持。未知形式の黙示変換0 |
| ID-F07-A03 | 状態poll、回答poll、二重poll、応答喪失 | 状態poll本文0。送信保存前本文0、二重返却0、unknown自動再送0 |
| ID-F07-A04 | cancelとsend-startを両順序、保存失敗 | 取消先行は本文0。送信先行は要求だけ、保存失敗時の偽確定0 |
| ID-F07-A05 | journal意図保存後と配送作成後の停止、再open | 固定ID照合。新attempt発行0、unknown再送0、破損から空復旧0 |
| ID-F08-A01 | 離席期限、復席、保留、欠けた推奨、multi推奨 | 現在も離席で全問単一推奨の場合だけ仮選択。部分仮選択0 |
| ID-F08-A02 | 手動回答と期限の両順序、仮選択後の遅い回答 | 単一勝敗。元質問再適用0、後続未接続は保持 |
| ID-F08-A03 | owner不明と終了、handoff後のfresh照合 | 同じ子宛の未送信だけ再開。子終了と質問解決の生成0 |
| ID-F08-A04 | 相関済み元UI解決を送信前、保存待ち中、送信後に通知 | 内容推測0、解決先行の本文0、送信後の未送信確定0 |
| ID-F08-A05 | 許可、network、app操作、由来不明native入力 | 自動回答0、登録変換0 |

実runtimeの短い登録/poll接点を早期に確認する。
1分、5分、30分の実時間待機、native由来、元UI競合は能力と使用版を記録して別途検証する。
#170/#171-Bのlive接続と#175-Bの後続通常指示は未接続として明示し、Issue #174全体は閉じない。

## MCPと画面の契約

`cockpit_register_question`はquestionId、questions、timeoutMinutesを受け取り、通常判断として登録する。
期限設定は1〜30の整数の分で、登録し直しても初回期限を維持する。
`cockpit_question_status`と`cockpit_answer_poll`はquestionIdを受け取る。
前者は状態だけを返し、後者だけが保存済み送信開始を経て回答本文を返せる。
MCPプロセスのtrusted writerは起動側のcompositionから注入し、モデルが指定した引数から認証情報を構築しない。
既定CLI起動でwriterを注入する本番compositionは採用前に接続する。

質問schemaはid、text、mode、options、allowFreeText、recommendedOptionIdを持つ。
modeはsingleまたはmultiで、optionはid、label、descriptionを持つ。
自由記入だけの質問はoptionsが空でallowFreeTextがtrueである。
推奨がない場合はrecommendedOptionIdをnullにする。
回答は全質問についてquestionId、optionIds、freeTextを持ち、自由記入がない場合のfreeTextはnullである。
部分回答や未知のfieldは拒否する。
質問は1〜4件、各質問の選択肢は最大6件、質問文と選択肢の説明は最大2,000文字、選択肢のlabelは最大200文字とする。
自由記入は最大2,000文字、遅い回答の履歴は質問ごとに最大10件とする。
文字数はJavaScriptの文字列長で判定する。

質問journalはschemaVersion 1、上限16 MiB、最大20,000件とする。
後から最大長の選択や履歴を保存できる容量を登録時に予約するため、保存できる実件数は質問の内容と予約容量により少なくなる。
上限に達した登録を拒否し、確認済みの質問履歴を削って新しい質問を受け付けない。

画面には質問ごとの選択肢と自由記入欄を配置する。
選択の保存と回答の配送状態を別に示し、保留または取消を質問単位で操作する。
画面の回答は共通質問のjournalへ書き、既存AskUserQuestionの待機、期限処理、hook返却には渡さない。
入力途中と保存失敗後の回答を画面で保持する。
mock/index.htmlにも同じ入力欄と状態を反映する。

HTTP応答のfinishはMCP stdioへの到達証拠ではない。
観測できた応答喪失は同じwriterと質問IDを認証してunknownとして記録する。
喪失を通知できない場合はsendingを保持し、再起動時にunknownへ復元する。
応答完了をacceptedまたはappliedへ変換しない。


## 復旧時の診断

共通質問の名前空間を持つ配信記録に対応するjournalがない場合、共通質問serviceの書込みと回答返却を停止する。
共用の配信store全体は停止せず、ほかの機能の配信記録を取消または補修しない。
状態の読取りでは復旧が必要な理由を示す。

取消台帳がcancelled_before_sendなら、質問履歴のcancelledAtが欠落していても取消済みと表示する。
時刻が記録されていなければ不明とし、復旧した時刻で補わない。
送信開始後のcancelRequestedは取消要求として表示し、元の配送状態と適用証拠を保持する。
台帳の取消保存後に質問履歴の保存が失敗した場合は、取消の記録と質問履歴の保存失敗を分けて表示する。
配送の作成が失敗しても質問の選択を未保存へ戻さず、配送登録保留として同じIDで照合する。

回答pollと応答喪失通知のHTTP POSTは通信失敗時に再試行しない。
初回の返却結果が不明な場合、再pollの結果で最初の喪失を隠さず、固定質問IDで応答喪失を記録する。
重複を安全に処理する登録と状態pollには通常の再試行を適用できる。

## 現在writerの取得

起動側は固定launchRefを閉じ込めたtrusted getWriter関数をMCPの組立optionsへ渡せる。
各操作の入口で一度だけ同期取得し、検証したwriterを操作終了まで固定する。
writerとgetWriterの同時指定、例外、非同期結果、未準備、不正形式を拒否する。
固定writerへのfallbackや、途中で新contextのwriterへ差し替える処理はしない。
同じ有効bindingのtokenは再利用し、context変更または失効時に更新する。
HTTP受付時と送信開始の保存後に、同じwriterを現在の登録とactor/contextへ照合する。

threadIdだけのMCP metadataでは、同じthread内の旧turn要求と現在turnの要求を識別できない。
getWriterの接点だけでturn由来の認証を完了したとは扱わず、要求とnative contextの相関を#171-B/#180-Aの採用条件として追跡する。


## 実native接続の採用条件

#171-B/#180-Aの担当が正式ログイン、実actor/contextの相関、writerとproofの失効を検証し、認証済みの製品MCP起動を接続する。
#174の担当はその接点を使い、実native要求から質問登録、状態poll、回答poll、永続保存と応答喪失までを合同検証する。
隔離app-serverの初期化や製品MCPのinitialize/listだけでは、認証済みactorによる回答pollの成功と扱わない。
認証fixtureを使った両providerの製品adapter試験も、実native要求の証拠を置き換えない。

組立側は固定launchRefのgetWriterと現在のnative contextを提供し、要求ごとのcontext相関を検証できるようにする。
native組立で配信storeへ渡すruntimeRegistryは、現在ownerの連鎖を確認するguardを含むtrusted facadeとする。
送信開始の保存後、checkCurrentProofでこのguardと固定宛先のproofを同期で再確認し、本文を返すsinkまでawaitを挟まない。
葉のkernel proofだけを直接確認してowner連鎖のguardを迂回する経路は、native配送の採用条件を満たさない。
正式ログインとこの接点が未接続の間は、実native poll、同threadの旧turn拒否、元UIとの競合を未確認として保持する。
通常HOMEの認証ファイルを複製したり、MCP metadataを補充したりしてこの条件を回避しない。
接続後は実時間1分、5分、30分の離席期限、復席、保留、手動回答との両順序と応答喪失を確認する。
#175-Bの後続指示も接続し、遅い回答が元質問へ再適用されないことを確認する。
これらの確認と採用条件の反映までIssue #174を開いたままにする。


## 隔離runtimeの初期化確認

`tools/probes/common-question-runtime.js`は新しい`poc/out`配下に専用HOMEを作り、製品MCPとCodex app-serverを独立した子プロセスで初期化する。
通常HOMEの認証ファイルを複製せず、ログイン、thread開始、turn開始、認証済みtool呼出しを行わない。
結果の安全な観測値だけを`readiness.json`へ保存し、終了後に専用HOMEを削除する。
既存の出力directoryを上書きしないため、再実行時は新しい出力先を指定する。

```text
node tools/probes/common-question-runtime.js --codex-path "<配置済みCodex実行ファイルの絶対path>" --out poc/out/<新しい検証ID>
```

2026年10月7日の確認ではCLI/app-server 0.160.1、隔離CODEX_HOME、app-serverのinitialize応答、製品MCPのinitializeとtools/listが成功した。
MCP protocolVersionは2025-06-18で、共通質問の3ツールが公開された。
CLIとapp-serverの版一致は観測値として記録し、初期化確認の合否条件にはしない。
通常HOMEの変更と認証ファイルの複製は0回、専用HOMEの削除を確認した。
実native metadataと回答pollは観測しておらず、この結果を認証済み質問配送の成功とは扱わない。

## 製品adapterの検証範囲

`test/provider-common-question-conformance.test.js`はClaudeとCodexそれぞれに、製品の登録・起動・runtime・配信adapter、HTTP/MCP入口と実ファイルの保存先を組み合わせる。
認証済みwriterと外部解決の証拠はfixtureが発行し、native issuerを検証したとは扱わない。
期待する宛先、露出回数、保存済み状態と禁止副作用はscenario側で指定する。

F07では実行期間とHOMEの分離、回答形式、状態の本文非公開、一度限りの返却、応答喪失、取消と復旧を確認する。
送信開始の保存失敗では本文露出を0回とし、最後の保存済み状態から同じattemptで復旧する。
選択journalのcommit後に配信作成が失敗するケースでは、選択と固定intentを保ち、再起動後に同じlogical ID、attempt ID、revision、digestで一度だけ配送する。
F08では全質問の仮選択適格条件、保留、期限前後の手動回答、owner終了と引継ぎ後の固定child宛先、外部解決の抑制、許可・network・app分類の拒否を確認する。
実時間の期限、実native UIとの相関、native actor/contextの寿命は前節の採用条件として残す。

2026年10月7日の製品適合試験は両providerの計18件が成功した。
MCP境界と通信の再試行条件を確かめる関連試験は26件が成功した。

質問UIの実装関数を使う回帰試験では、件数と絞込、カード内取消、期限競合後の下書き保持と重複保存防止、外部解決後の後続回答、返却された取消要求の案内、数値時刻と既存判断の表示順、保存失敗後の入力保持の12件を確認する。
内部ブラウザでは形式別入力、poll中の下書きとcaret保持、保留と解除、手動保存、仮選択と遅い回答、filter保存、質問0件の復旧診断を観測した。
旧標準確認ダイアログ後に操作APIが停止したため、カード内確認へ変更した最終版の取消と遅い回答保持の実ブラウザ操作は未確認として残す。

モックの両表示、非表示件数、外部解決後の保留表示を実関数で確かめる5件の回帰試験と、全体テスト1,345件が成功した。
全体テストの失敗とskipは0件である。

配送結果がunknownの取消要求は実ファイルの配信storeで保存し、再起動後もcancelRequestedを保持する回帰試験が成功した。
取消要求を記録しても元の配送状態はunknownのままとし、回答を再露出しない。

外部解決で停止した元回答の配送と、質問の手動取消を区別し、手動取消後は再起動しても追加回答を拒否する。
同じ回答の再送は追加保存と案内せず、元回答の配送状態と後続回答の保持状態を別々に表示する。
