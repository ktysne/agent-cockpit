param(
  [switch]$Desktop,
  [switch]$StartMenu,
  [switch]$Startup,
  [string]$Directory,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$destinations = @()
$hasNamedLocation = $Desktop -or $StartMenu -or $Startup
$useDefaultLocations = -not $hasNamedLocation -and [string]::IsNullOrWhiteSpace($Directory)
if ($useDefaultLocations -or $Desktop) {
  $destinations += [Environment]::GetFolderPath('Desktop')
}
if ($useDefaultLocations -or $StartMenu) {
  $destinations += [Environment]::GetFolderPath('Programs')
}
if ($Startup) {
  $destinations += [Environment]::GetFolderPath('Startup')
}
if (-not [string]::IsNullOrWhiteSpace($Directory)) {
  $destinations += $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Directory)
}
$destinations = @($destinations | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)

if ($destinations.Count -eq 0) {
  throw 'ショートカットの保存先を取得できません。'
}

$shortcutName = 'Agent Cockpit.lnk'
$trayScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'tray.ps1'))

if ($Remove) {
  $shell = New-Object -ComObject WScript.Shell
  try {
    foreach ($destination in $destinations) {
      $shortcutPath = Join-Path $destination $shortcutName
      if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
        Write-Output "存在しません: $shortcutPath"
        continue
      }
      $shortcut = $shell.CreateShortcut($shortcutPath)
      try {
        $targetIsPowerShell = [System.IO.Path]::GetFileName($shortcut.TargetPath) -ieq 'powershell.exe'
        $pointsToTray = $shortcut.Arguments -match '(?i)tray\.ps1'
        if ($targetIsPowerShell -and $pointsToTray) {
          Remove-Item -LiteralPath $shortcutPath
          Write-Output "削除: $shortcutPath"
        } else {
          Write-Output "削除対象ではありません: $shortcutPath"
        }
      } finally {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
      }
    }
  } finally {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
  }
  exit 0
}

if (-not [string]::IsNullOrWhiteSpace($env:AGENT_COCKPIT_HOME)) {
  $cockpitHome = [System.IO.Path]::GetFullPath($env:AGENT_COCKPIT_HOME)
} else {
  $cockpitHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agent-cockpit'
}
if (-not (Test-Path -LiteralPath $cockpitHome -PathType Container)) {
  New-Item -ItemType Directory -Path $cockpitHome -Force | Out-Null
}

$iconPath = Join-Path $cockpitHome 'agent-cockpit.ico'
# PowerShell 7 から実行しても、ショートカットと同じ Windows PowerShell 5.1 で書き出す。
$targetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$exportArguments = '-NoProfile -File "{0}" -ExportIcon "{1}"' -f $trayScript, $iconPath
$exportProcess = Start-Process -FilePath $targetPath -ArgumentList $exportArguments -NoNewWindow -Wait -PassThru
if ($exportProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
  throw 'タスクトレイのアイコンを書き出せませんでした。'
}

$arguments = '-NoProfile -STA -WindowStyle Hidden -File "{0}"' -f $trayScript
$shell = New-Object -ComObject WScript.Shell
try {
  foreach ($destination in $destinations) {
    if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
      New-Item -ItemType Directory -Path $destination -Force | Out-Null
    }
    $shortcutPath = Join-Path $destination $shortcutName
    $shortcut = $shell.CreateShortcut($shortcutPath)
    try {
      $shortcut.TargetPath = $targetPath
      $shortcut.Arguments = $arguments
      $shortcut.WindowStyle = 7
      $shortcut.WorkingDirectory = $cockpitHome
      $shortcut.IconLocation = $iconPath
      $shortcut.Description = 'Agent Cockpit のタスクトレイを起動する'
      $shortcut.Save()
      Write-Output "作成: $shortcutPath"
    } finally {
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
    }
  }
} finally {
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}
