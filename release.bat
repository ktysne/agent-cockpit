@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [agent-cockpit] ERROR: Node.js was not found on PATH.
    goto :failed
)
node --use-system-ca -e 0 >nul 2>nul
if errorlevel 1 (
    echo [agent-cockpit] ERROR: Node.js 22.15 or later is required.
    goto :failed
)
if not exist "node_modules\basic-ftp" (
    echo [agent-cockpit] ERROR: basic-ftp is missing.
    echo Run "npm install" in the repository root first.
    goto :failed
)
where git >nul 2>nul
if errorlevel 1 (
    echo [agent-cockpit] ERROR: git was not found on PATH.
    goto :failed
)
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
    echo [agent-cockpit] ERROR: this directory is not a git worktree.
    goto :failed
)

:askversion
set "VERSION="
set /p "VERSION=Version to release (e.g. 1.0.2): "
if not defined VERSION goto :askversion
echo(!VERSION!| findstr /r /x "v*[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*" >nul
if errorlevel 1 (
    echo [agent-cockpit] Invalid version "!VERSION!". Use a form like 1.0.2 or v1.0.2.
    goto :askversion
)
set "TAG=!VERSION!"
if not "!TAG:~0,1!"=="v" set "TAG=v!TAG!"

echo.
node tools\release.js plan !TAG!
if errorlevel 1 goto :planfailed
echo.

set "CONFIRM="
set /p "CONFIRM=Release !TAG! with the steps above? (y/N): "
if /i not "!CONFIRM!"=="y" (
    echo [agent-cockpit] Release cancelled. Nothing was changed.
    goto :done
)

node tools\release.js run !TAG!
if errorlevel 1 goto :releasefailed

echo.
node --use-system-ca tools\site-deploy.js upload --version !TAG!
if errorlevel 1 goto :uploadfailed

echo.
echo [agent-cockpit] Tag !TAG! pushed. Running servers notify users of the update within 6 hours.
echo [agent-cockpit] Site upload completed: https://ktysne.info/agent-cockpit/
goto :done

:planfailed
echo.
echo [agent-cockpit] Release was not started. Nothing was changed.
goto :pausefail

:releasefailed
echo.
echo [agent-cockpit] Release stopped. Running release.bat again with the same version continues from the failed step.
goto :pausefail

:uploadfailed
echo.
echo [agent-cockpit] Upload failed. The tag !TAG! is already pushed.
echo Running deploy-site.bat or release.bat again with the same version uploads the site again.
goto :pausefail

:done
pause
exit /b 0

:failed
echo.
echo [agent-cockpit] Release failed. Check the output above.
:pausefail
pause
exit /b 1
