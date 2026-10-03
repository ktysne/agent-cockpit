const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tray = fs.readFileSync(path.join(__dirname, '../src/tray/tray.ps1'), 'utf8');

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
