param(
  [switch]$Check
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
      ShowWindow(window, 9);
      SetForegroundWindow(window);
    }

    public static Icon CreateTrayIcon(bool connected, bool pending) {
      using (Bitmap bitmap = new Bitmap(32, 32))
      using (Graphics graphics = Graphics.FromImage(bitmap)) {
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.Clear(Color.Transparent);
        Color background = connected ? Color.FromArgb(217, 119, 87) : Color.FromArgb(128, 128, 128);
        using (SolidBrush backgroundBrush = new SolidBrush(background)) {
          graphics.FillEllipse(backgroundBrush, 1, 1, 30, 30);
        }
        using (Font font = new Font("Segoe UI", 19, FontStyle.Bold, GraphicsUnit.Pixel)) {
          graphics.DrawString("C", font, Brushes.White, new PointF(6, 3));
        }
        if (pending) {
          using (SolidBrush mark = new SolidBrush(Color.FromArgb(245, 166, 35))) {
            graphics.FillEllipse(mark, 21, 1, 10, 10);
          }
          using (Pen outline = new Pen(Color.White, 1.5f)) {
            graphics.DrawEllipse(outline, 21, 1, 10, 10);
          }
        }
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

function Get-ServerPort {
  $serverInfoPath = Join-Path $script:cockpitHome 'server.json'
  $reader = $null
  try {
    $reader = New-Object System.IO.StreamReader($serverInfoPath)
    while ($null -ne ($line = $reader.ReadLine())) {
      $match = [regex]::Match($line, '^\s*"port"\s*:\s*(\d+)\s*,?\s*$')
      if (-not $match.Success) { continue }
      $port = 0
      if (-not [int]::TryParse($match.Groups[1].Value, [ref]$port)) { return $null }
      if ($port -lt 1 -or $port -gt 65535) { return $null }
      return $port
    }
    return $null
  } catch {
    return $null
  } finally {
    if ($reader) { $reader.Dispose() }
  }
}

function Get-DashboardState([object]$Port) {
  if ($null -eq $Port) {
    return [pscustomobject]@{ Connected = $false; PermissionCount = 0 }
  }
  try {
    $state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -Method Get -TimeoutSec 2 -UseBasicParsing
    $permissionCount = 0
    foreach ($session in @($state.sessions)) {
      $permissionCount += @($session.permissionWaits).Count
    }
    return [pscustomobject]@{ Connected = $true; PermissionCount = $permissionCount }
  } catch {
    return [pscustomobject]@{ Connected = $false; PermissionCount = 0 }
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

function Show-TrayNotice([string]$Message, [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info) {
  if (-not $script:notifyIcon) { return }
  $script:notifyIcon.BalloonTipTitle = 'Agent Cockpit'
  $script:notifyIcon.BalloonTipText = $Message
  $script:notifyIcon.BalloonTipIcon = $Icon
  $script:notifyIcon.ShowBalloonTip(5000)
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
    $output = @(& $nodePath $ensureScript 2>$null)
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
    Start-Process -FilePath $edgePath -ArgumentList @($appArgument, $profileArgument) -WindowStyle Normal
  } catch {
    Show-TrayNotice 'ダッシュボードを開けませんでした。' ([System.Windows.Forms.ToolTipIcon]::Warning)
  }
}

function Update-TrayState {
  $port = Get-ServerPort
  $state = Get-DashboardState $port
  $script:notifyIcon.Text = if (-not $state.Connected) {
    'Agent Cockpit: サーバーに未接続'
  } elseif ($state.PermissionCount -eq 1) {
    'Agent Cockpit: 許可待ち 1 件'
  } else {
    "Agent Cockpit: 許可待ち $($state.PermissionCount) 件"
  }
  $nextIcon = [AgentCockpitTray.NativeMethods]::CreateTrayIcon($state.Connected, ($state.PermissionCount -gt 0))
  $oldIcon = $script:notifyIcon.Icon
  $script:notifyIcon.Icon = $nextIcon
  if ($oldIcon) { $oldIcon.Dispose() }

  if ($state.Connected) {
    if ($null -ne $script:lastPermissionCount -and $state.PermissionCount -gt $script:lastPermissionCount) {
      Show-TrayNotice "許可待ちが $($state.PermissionCount) 件あります。クリックしてダッシュボードを開きます。" ([System.Windows.Forms.ToolTipIcon]::Warning)
    }
    $script:lastPermissionCount = $state.PermissionCount
  }
}

$script:cockpitHome = Get-CockpitHome
$env:AGENT_COCKPIT_HOME = $script:cockpitHome

if ($Check) {
  $window = Find-DashboardWindow
  $port = Get-ServerPort
  $state = Get-DashboardState $port
  [pscustomobject]@{
    WindowFound = ($window -ne [IntPtr]::Zero)
    Connected = $state.Connected
    Port = $port
    PermissionCount = $state.PermissionCount
  } | ConvertTo-Json -Compress
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
$script:lastPermissionCount = $null
try {
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
  $script:notifyIcon.Text = 'Agent Cockpit: サーバーに未接続'
  $script:notifyIcon.Icon = [AgentCockpitTray.NativeMethods]::CreateTrayIcon($false, $false)
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = $menu.Items.Add('ダッシュボードを開く')
  $openItem.add_Click({ Open-Dashboard })
  $exitItem = $menu.Items.Add('終了')
  $exitItem.add_Click({ [System.Windows.Forms.Application]::ExitThread() })
  $script:notifyIcon.ContextMenuStrip = $menu
  $script:notifyIcon.add_DoubleClick({ Open-Dashboard })
  $script:notifyIcon.add_BalloonTipClicked({ Open-Dashboard })
  $script:notifyIcon.Visible = $true

  Update-TrayState
  $script:timer = New-Object System.Windows.Forms.Timer
  $script:timer.Interval = 5000
  $script:timer.add_Tick({ Update-TrayState })
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
