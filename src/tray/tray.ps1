param(
  [switch]$Check,
  [string]$ExportIcon
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('AgentCockpitTray.NativeMethods' -as [type])) {
  $nativeMethodsSource = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace AgentCockpitTray {
  public static class NativeMethods {
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximumLength);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr icon);

    public static IntPtr FindDashboardWindow(string titleSuffix) {
      IntPtr found = IntPtr.Zero;
      EnumWindowsCallback callback = delegate(IntPtr window, IntPtr state) {
        if (!IsWindowVisible(window)) return true;
        StringBuilder title = new StringBuilder(512);
        GetWindowText(window, title, title.Capacity);
        if (Regex.IsMatch(title.ToString(), "^(\\(\\d+\\) )?" + Regex.Escape(titleSuffix) + "$")) {
          found = window;
          return false;
        }
        return true;
      };
      EnumWindows(callback, IntPtr.Zero);
      GC.KeepAlive(callback);
      return found;
    }

    public static void RestoreAndFocus(IntPtr window) {
      // SW_RESTORE は最大化も解くので、最小化されているときだけ使う。
      if (IsIconic(window)) ShowWindow(window, 9);
      SetForegroundWindow(window);
    }

    public static Bitmap DrawTrayBitmap(int size, bool connected, bool pending, bool away) {
      float scale = size / 32f;
      Bitmap bitmap = new Bitmap(size, size);
      using (Graphics graphics = Graphics.FromImage(bitmap)) {
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.Clear(Color.Transparent);
        Color background = connected ? Color.FromArgb(217, 119, 87) : Color.FromArgb(128, 128, 128);
        using (SolidBrush backgroundBrush = new SolidBrush(background)) {
          graphics.FillEllipse(backgroundBrush, scale, scale, 30 * scale, 30 * scale);
        }
        using (Font font = new Font("Segoe UI", 19 * scale, FontStyle.Bold, GraphicsUnit.Pixel)) {
          graphics.DrawString("C", font, Brushes.White, new PointF(6 * scale, 3 * scale));
        }
        if (pending) {
          using (SolidBrush mark = new SolidBrush(Color.FromArgb(245, 166, 35))) {
            graphics.FillEllipse(mark, 21 * scale, scale, 10 * scale, 10 * scale);
          }
          using (Pen outline = new Pen(Color.White, 1.5f * scale)) {
            graphics.DrawEllipse(outline, 21 * scale, scale, 10 * scale, 10 * scale);
          }
        }
        if (away) {
          using (SolidBrush mark = new SolidBrush(Color.FromArgb(180, 165, 227))) {
            graphics.FillEllipse(mark, scale, 21 * scale, 10 * scale, 10 * scale);
          }
          using (Pen outline = new Pen(Color.White, 1.5f * scale)) {
            graphics.DrawEllipse(outline, scale, 21 * scale, 10 * scale, 10 * scale);
          }
        }
      }
      return bitmap;
    }

    public static Icon CreateTrayIcon(bool connected, bool pending, bool away) {
      using (Bitmap bitmap = DrawTrayBitmap(32, connected, pending, away)) {
        IntPtr handle = bitmap.GetHicon();
        try {
          using (Icon shared = Icon.FromHandle(handle)) {
            return (Icon)shared.Clone();
          }
        } finally {
          DestroyIcon(handle);
        }
      }
    }
  }
}
'@
  Add-Type -TypeDefinition $nativeMethodsSource -ReferencedAssemblies 'System.Drawing'
}

function Get-CockpitHome {
  if (-not [string]::IsNullOrWhiteSpace($env:AGENT_COCKPIT_HOME)) {
    return [System.IO.Path]::GetFullPath($env:AGENT_COCKPIT_HOME)
  }
  return Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agent-cockpit'
}

function Export-TrayIcon([string]$Path) {
  $sizes = @(16, 32, 48, 256)
  $images = @(
    foreach ($size in $sizes) {
      $bitmap = [AgentCockpitTray.NativeMethods]::DrawTrayBitmap($size, $true, $false, $false)
      $stream = New-Object System.IO.MemoryStream
      try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        [pscustomobject]@{ Size = $size; Bytes = $stream.ToArray() }
      } finally {
        $stream.Dispose()
        $bitmap.Dispose()
      }
    }
  )
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $parent = [System.IO.Path]::GetDirectoryName($fullPath)
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $file = [System.IO.File]::Open($fullPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $writer = New-Object System.IO.BinaryWriter($file)
  try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$images.Count)
    $offset = [UInt32](6 + 16 * $images.Count)
    foreach ($image in $images) {
      $dimension = if ($image.Size -eq 256) { [byte]0 } else { [byte]$image.Size }
      $writer.Write([byte]$dimension)
      $writer.Write([byte]$dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]32)
      $writer.Write([UInt32]$image.Bytes.Length)
      $writer.Write([UInt32]$offset)
      $offset += [UInt32]$image.Bytes.Length
    }
    foreach ($image in $images) {
      $writer.Write([byte[]]$image.Bytes)
    }
  } finally {
    $writer.Dispose()
  }
}

function Get-ServerInfo {
  $serverInfoPath = Join-Path $script:cockpitHome 'server.json'
  $reader = $null
  try {
    # 常駐サーバーが server.json を名前の変更で置くので、Delete の共有を許して開く。
    $stream = New-Object System.IO.FileStream($serverInfoPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    $reader = New-Object System.IO.StreamReader($stream)
    $info = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
    $port = 0
    if (-not [int]::TryParse([string]$info.port, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { return $null }
    # 状態の取得に秘密値は要らないので、uiSecret を書かない常駐サーバーでも接続として扱う。
    return [pscustomobject]@{ Port = $port; Secret = [string]$info.uiSecret }
  } catch {
    return $null
  } finally {
    if ($reader) { $reader.Dispose() }
  }
}

function Get-DashboardState([object]$ServerInfo) {
  if ($null -eq $ServerInfo) {
    return [pscustomobject]@{ Connected = $false; PermissionCount = 0; PermissionKeys = @(); AwayEnabled = $false }
  }
  try {
    $state = Invoke-RestMethod -Uri "http://127.0.0.1:$($ServerInfo.Port)/api/state" -Method Get -TimeoutSec 2 -UseBasicParsing
    $keys = @()
    foreach ($session in @($state.sessions)) {
      foreach ($wait in @($session.permissionWaits)) {
        if ($null -ne $wait) { $keys += '{0}|{1}|{2}' -f $session.session_id, $wait.agent_id, $wait.startedAt }
      }
    }
    return [pscustomobject]@{ Connected = $true; PermissionCount = $keys.Count; PermissionKeys = $keys; AwayEnabled = ($state.away.enabled -eq $true) }
  } catch {
    return [pscustomobject]@{ Connected = $false; PermissionCount = 0; PermissionKeys = @(); AwayEnabled = $false }
  }
}

function Find-DashboardWindow {
  return [AgentCockpitTray.NativeMethods]::FindDashboardWindow('Agent Cockpit')
}

function Resolve-ApplicationPath([string]$Name, [string[]]$KnownPaths) {
  $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  foreach ($candidate in $KnownPaths) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $candidate
    }
  }
  return $null
}

function Join-InstallPath([string]$BasePath, [string]$RelativePath) {
  if ([string]::IsNullOrWhiteSpace($BasePath)) { return $null }
  return Join-Path $BasePath $RelativePath
}

function Get-NodePath {
  $knownPaths = @(
    (Join-InstallPath $env:ProgramFiles 'nodejs\node.exe'),
    (Join-InstallPath ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-InstallPath $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  return Resolve-ApplicationPath 'node.exe' $knownPaths
}

function Get-EdgePath {
  $knownPaths = @(
    (Join-InstallPath $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-InstallPath ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-InstallPath $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
  )
  return Resolve-ApplicationPath 'msedge.exe' $knownPaths
}

function Show-TrayNotice([string]$Message, [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info, [switch]$OpensDashboard) {
  if (-not $script:notifyIcon) { return }
  $script:balloonOpensDashboard = [bool]$OpensDashboard
  $script:notifyIcon.BalloonTipTitle = 'Agent Cockpit'
  $script:notifyIcon.BalloonTipText = $Message
  $script:notifyIcon.BalloonTipIcon = $Icon
  $script:notifyIcon.ShowBalloonTip(5000)
}

function Set-AwayStatus([bool]$Enabled) {
  $serverInfo = Get-ServerInfo
  if ($null -eq $serverInfo -or [string]::IsNullOrWhiteSpace($serverInfo.Secret)) {
    Show-TrayNotice '離席中を切り替えられませんでした。常駐サーバーの状態を確認してください。' ([System.Windows.Forms.ToolTipIcon]::Warning)
    Update-TrayState
    return
  }
  try {
    $headers = @{ 'X-Cockpit-Secret' = $serverInfo.Secret }
    $body = @{ enabled = $Enabled } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "http://127.0.0.1:$($serverInfo.Port)/api/away" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 2 -UseBasicParsing | Out-Null
  } catch {
    Show-TrayNotice '離席中を切り替えられませんでした。常駐サーバーの状態を確認してください。' ([System.Windows.Forms.ToolTipIcon]::Warning)
  }
  Update-TrayState
}

function Open-Dashboard {
  try {
    $nodePath = Get-NodePath
    if (-not $nodePath) {
      Show-TrayNotice 'Node.js が見つかりません。Node.js の導入先か PATH を確認してください。' ([System.Windows.Forms.ToolTipIcon]::Warning)
      return
    }
    $script:cockpitHome = Get-CockpitHome
    $env:AGENT_COCKPIT_HOME = $script:cockpitHome
    $ensureScript = Join-Path $PSScriptRoot 'ensure-server.js'
    # Windows PowerShell 5.1 は Stop のまま stderr を捨てると、node の警告 1 行で例外にする。
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = @(& $nodePath $ensureScript 2>$null) } finally { $ErrorActionPreference = $previousPreference }
    if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1) {
      Show-TrayNotice '常駐サーバーを起動できませんでした。' ([System.Windows.Forms.ToolTipIcon]::Warning)
      return
    }
    $server = $null
    try { $server = $output[0] | ConvertFrom-Json } catch { }
    if (-not $server -or $server.port -lt 1 -or $server.port -gt 65535) {
      Show-TrayNotice '常駐サーバーから有効なポートを取得できませんでした。' ([System.Windows.Forms.ToolTipIcon]::Warning)
      return
    }

    $window = Find-DashboardWindow
    if ($window -ne [IntPtr]::Zero) {
      [AgentCockpitTray.NativeMethods]::RestoreAndFocus($window)
      return
    }

    $edgePath = Get-EdgePath
    if (-not $edgePath) {
      Show-TrayNotice 'Microsoft Edge が見つかりません。Edge の導入先か PATH を確認してください。' ([System.Windows.Forms.ToolTipIcon]::Warning)
      return
    }
    $browserProfile = Join-Path $script:cockpitHome 'browser'
    New-Item -ItemType Directory -Path $browserProfile -Force | Out-Null
    $url = "http://127.0.0.1:$($server.port)/"
    $appArgument = "--app=$url"
    $profileArgument = '--user-data-dir="{0}"' -f $browserProfile
    Start-Process -FilePath $edgePath -ArgumentList @($appArgument, $profileArgument, '--no-first-run') -WindowStyle Normal
  } catch {
    Show-TrayNotice 'ダッシュボードを開けませんでした。' ([System.Windows.Forms.ToolTipIcon]::Warning)
  }
}

function Update-TrayState {
  $serverInfo = Get-ServerInfo
  $state = Get-DashboardState $serverInfo
  $tooltip = if (-not $state.Connected) {
    'Agent Cockpit: サーバーに未接続'
  } elseif ($state.PermissionCount -eq 1) {
    'Agent Cockpit: 許可待ち 1 件'
  } else {
    "Agent Cockpit: 許可待ち $($state.PermissionCount) 件"
  }
  if ($state.AwayEnabled) { $tooltip += ' (離席中)' }
  if ($tooltip.Length -gt 63) { $tooltip = $tooltip.Substring(0, 63) }
  $script:notifyIcon.Text = $tooltip
  if ($script:awayMenuItem) { $script:awayMenuItem.Checked = $state.AwayEnabled }
  $iconState = '{0}|{1}|{2}' -f $state.Connected, ($state.PermissionCount -gt 0), $state.AwayEnabled
  if ($iconState -ne $script:lastIconState) {
    $nextIcon = [AgentCockpitTray.NativeMethods]::CreateTrayIcon($state.Connected, ($state.PermissionCount -gt 0), $state.AwayEnabled)
    $oldIcon = $script:notifyIcon.Icon
    $script:notifyIcon.Icon = $nextIcon
    if ($oldIcon) { $oldIcon.Dispose() }
    $script:lastIconState = $iconState
  }

  if ($state.Connected) {
    # 件数で比べると、1 件が解消して別の 1 件が増えたときに知らせ損なう。
    $newWaits = @($state.PermissionKeys | Where-Object { $script:lastPermissionKeys -notcontains $_ })
    if ($script:permissionKeysKnown -and $newWaits.Count -gt 0) {
      Show-TrayNotice "許可待ちが $($state.PermissionCount) 件あります。クリックしてダッシュボードを開きます。" ([System.Windows.Forms.ToolTipIcon]::Warning) -OpensDashboard
    }
    $script:lastPermissionKeys = @($state.PermissionKeys)
    $script:permissionKeysKnown = $true
  }
}

$script:cockpitHome = Get-CockpitHome
$env:AGENT_COCKPIT_HOME = $script:cockpitHome

if ($Check) {
  $window = Find-DashboardWindow
  $serverInfo = Get-ServerInfo
  $state = Get-DashboardState $serverInfo
  [pscustomobject]@{
    WindowFound = ($window -ne [IntPtr]::Zero)
    Connected = $state.Connected
    Port = if ($serverInfo) { $serverInfo.Port } else { $null }
    PermissionCount = $state.PermissionCount
  } | ConvertTo-Json -Compress
  exit 0
}

if (-not [string]::IsNullOrWhiteSpace($ExportIcon)) {
  Export-TrayIcon $ExportIcon
  exit 0
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\AgentCockpitTray', [ref]$createdNew)
if (-not $createdNew) {
  $mutex.Dispose()
  exit 0
}

$script:notifyIcon = $null
$script:timer = $null
$script:lastPermissionKeys = @()
$script:permissionKeysKnown = $false
$script:lastIconState = $null
$script:balloonOpensDashboard = $false
$script:awayMenuItem = $null
try {
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
  $script:notifyIcon.Text = 'Agent Cockpit: サーバーに未接続'
  $script:notifyIcon.Icon = [AgentCockpitTray.NativeMethods]::CreateTrayIcon($false, $false, $false)
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = $menu.Items.Add('ダッシュボードを開く')
  $openItem.add_Click({ Open-Dashboard })
  $script:awayMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem('離席中')
  $script:awayMenuItem.CheckOnClick = $true
  $script:awayMenuItem.add_Click({ param($sender, $eventArgs) Set-AwayStatus ([bool]$sender.Checked) })
  $menu.Items.Add($script:awayMenuItem) | Out-Null
  $exitItem = $menu.Items.Add('終了')
  $exitItem.add_Click({ [System.Windows.Forms.Application]::ExitThread() })
  $script:notifyIcon.ContextMenuStrip = $menu
  $script:notifyIcon.add_DoubleClick({ Open-Dashboard })
  $script:notifyIcon.add_BalloonTipClicked({ if ($script:balloonOpensDashboard) { Open-Dashboard } })
  $script:notifyIcon.Visible = $true

  try { Update-TrayState } catch { }
  $script:timer = New-Object System.Windows.Forms.Timer
  $script:timer.Interval = 5000
  # 非表示のプロセスなので、例外を Application.Run まで届かせるとダイアログが出るか落ちる。
  $script:timer.add_Tick({ try { Update-TrayState } catch { } })
  $script:timer.Start()
  [System.Windows.Forms.Application]::Run()
} finally {
  if ($script:timer) {
    $script:timer.Stop()
    $script:timer.Dispose()
  }
  if ($script:notifyIcon) {
    $script:notifyIcon.Visible = $false
    if ($script:notifyIcon.Icon) { $script:notifyIcon.Icon.Dispose() }
    $script:notifyIcon.Dispose()
  }
  if ($menu) { $menu.Dispose() }
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
