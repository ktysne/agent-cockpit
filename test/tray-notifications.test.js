const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 作業ツリーは autocrlf で CRLF になることがあり、ソースの断片を照合する正規表現は LF を前提にする。
const tray = fs.readFileSync(path.join(__dirname, '../src/tray/tray.ps1'), 'utf8').replace(/\r\n/g, '\n');

function section(startMarker, endMarker) {
  const start = tray.indexOf(startMarker);
  const end = tray.indexOf(endMarker, start);
  assert.notEqual(start, -1, `開始位置が見つからない: ${startMarker}`);
  assert.notEqual(end, -1, `終了位置が見つからない: ${endMarker}`);
  return tray.slice(start, end);
}

test('通知設定が無いときは初回に既定オフで確認し、壊れた設定も未設定として扱う', () => {
  const getter = section('function Get-TrayNotificationSetting', '\nfunction Save-TrayNotificationSetting');
  const initializer = section('function Initialize-TrayNotificationSetting', '\nfunction Set-TrayNotificationPreference');

  assert.match(getter, /Join-Path \$script:cockpitHome 'tray\.json'/);
  assert.match(getter, /notifyPendingCounts/);
  assert.match(getter, /Found = \$false; Enabled = \$false/);
  assert.match(initializer, /許可待ちと判断待ちが増えたときに Windows の通知を出しますか\? Claude Code の通知と重なることがあります。/);
  assert.match(initializer, /MessageBoxButtons\]::YesNo/);
  assert.match(initializer, /MessageBoxDefaultButton\]::Button2/);
  assert.match(initializer, /DialogResult\]::Yes/);
  assert.match(tray, /\$script:notifyPendingCounts = \$false/);
  assert.match(tray, /Initialize-TrayNotificationSetting\n/);
});

test('通知設定は一時ファイルから置き換えて保存する', () => {
  const saver = section('function Save-TrayNotificationSetting', '\nfunction Initialize-TrayNotificationSetting');

  assert.match(saver, /notifyPendingCounts/);
  assert.match(saver, /WriteAllText\(\$temporaryPath/);
  assert.match(saver, /File\]::Replace\(\$temporaryPath, \$settingsPath, \$null\)/);
  assert.match(saver, /File\]::Move\(\$temporaryPath, \$settingsPath\)/);
});

test('右クリックメニューから通知設定を切り替えて保存する', () => {
  const menu = section("$script:notifyPendingCountsMenuItem = New-Object", '$script:awayMenuItem = New-Object');
  const setter = section('function Set-TrayNotificationPreference', '\nfunction Export-TrayIcon');

  assert.match(menu, /ToolStripMenuItem\('待ち件数を通知する'\)/);
  assert.match(menu, /CheckOnClick = \$true/);
  assert.match(menu, /Checked = \$script:notifyPendingCounts/);
  assert.match(menu, /Set-TrayNotificationPreference/);
  assert.match(setter, /Save-TrayNotificationSetting \$Enabled/);
});

test('待ち件数の3種類の通知だけが設定で止まる', () => {
  const update = section('function Update-TrayState', '\n$script:cockpitHome = Get-CockpitHome');
  const gatedNotices = section('if ($script:notifyPendingCounts) {', '$script:lastPermissionKeys = @($state.PermissionKeys)');

  assert.match(update, /許可待ち \$\(\$state\.PermissionCount\) 件、判断待ち \$\(\$state\.DecisionCount\) 件/);
  assert.match(update, /CreateTrayIcon\(\$state\.Connected, \$hasPending, \$state\.AwayEnabled\)/);
  assert.equal((gatedNotices.match(/Show-TrayNotice .*?-OpensDashboard/g) || []).length, 3);
});

test('離席中や常駐サーバーのエラー通知は通知設定で止めない', () => {
  const away = section('function Set-AwayStatus', '\nfunction Restart-ResidentServer');
  const startup = section('function Open-Dashboard', '\nfunction Update-TrayState');

  assert.equal((away.match(/Show-TrayNotice .*ToolTipIcon\]::Warning/g) || []).length, 2);
  assert.match(startup, /常駐サーバーを起動できませんでした。/);
  assert.match(startup, /ToolTipIcon\]::Warning/);
  assert.doesNotMatch(away, /notifyPendingCounts/);
  assert.doesNotMatch(startup, /notifyPendingCounts/);
});

test('再起動前に別フォルダーの常駐サーバーを確認ダイアログより先に知らせる', () => {
  const restart = section('function Restart-ResidentServer', '\nfunction Open-Dashboard');
  const precheck = restart.indexOf('Get-ResidentServerFolderFromCommandLine $previousCommandLine');
  const confirmation = restart.indexOf('[System.Windows.Forms.MessageBox]::Show');

  assert.ok(precheck >= 0);
  assert.ok(precheck < confirmation);
  assert.match(restart, /Get-Process -Id \$previousServer\.ProcessId -ErrorAction SilentlyContinue/);
  assert.match(restart, /Get-CimInstance Win32_Process -Filter "ProcessId=\$\(\$previousServer\.ProcessId\)"/);
  assert.match(restart, /別のフォルダーの agent-cockpit の常駐サーバーが動いているため、再起動しませんでした/);
  assert.match(restart, /\$isAgentCockpitServer -and -not \$isResidentServer/);
  assert.match(restart, /そのフォルダーのタスクトレイから再起動してください。/);
});

test('トレイの再起動は照合結果に応じた警告を出し、成功扱いにしない', () => {
  const restart = section('function Restart-ResidentServer', '\nfunction Open-Dashboard');

  assert.match(restart, /ensureScript --verify/);
  assert.match(restart, /Show-TrayNotice '常駐サーバーを再起動しましたが、更新の途中のファイルで起動した可能性があります。もう一度再起動してください。' \(\[System\.Windows\.Forms\.ToolTipIcon\]::Warning\)/);
  assert.match(restart, /Show-TrayNotice "別のフォルダーの agent-cockpit の常駐サーバーが起動しました\$folderNotice。フックの登録先がこのフォルダーになっているか確かめてください。"/);
  assert.match(restart, /Show-TrayNotice "別のフォルダーの agent-cockpit の常駐サーバーが動いているため、再起動しませんでした\$folderNotice。そのフォルダーのタスクトレイから再起動してください。"/);
  assert.match(restart, /if \(\$isLocalServerCommand\) \{\s*Show-TrayNotice '常駐サーバーを再起動しましたが、更新の途中のファイル/);
  assert.match(restart, /Show-TrayNotice '常駐サーバーを再起動しましたが、このフォルダーの agent-cockpit で動いているかを確かめられませんでした。もう一度再起動し、続くときはフックの登録先を確かめてください。' \(\[System\.Windows\.Forms\.ToolTipIcon\]::Warning\)/);
  const otherFolderNotice = restart.indexOf('別のフォルダーの agent-cockpit の常駐サーバーが起動しました');
  const mismatchBranch = restart.indexOf("if ($server.result -eq 'mismatch')");
  assert.ok(otherFolderNotice >= 0 && otherFolderNotice < mismatchBranch, '照合が ok でも別フォルダーの起動を成功と通知しない');
  assert.match(restart, /if \(\$server\.result -ne 'ok'\) \{ throw/);
  assert.match(restart, /Show-TrayNotice '常駐サーバーを再起動しました'/);
  assert.match(restart, /常駐サーバーを再起動できませんでした。\{0\}/);
  assert.match(tray, /if \(\$Folder\.Length -le 90\)/);

  const longFolder = 'x'.repeat(90);
  const notices = [
    `別のフォルダーの agent-cockpit の常駐サーバーが動いているため、再起動しませんでした(${longFolder})。そのフォルダーのタスクトレイから再起動してください。`,
    `別のフォルダーの agent-cockpit の常駐サーバーが起動しました(${longFolder})。フックの登録先がこのフォルダーになっているか確かめてください。`,
  ];
  assert.ok(notices.every(notice => notice.length <= 200));
});
