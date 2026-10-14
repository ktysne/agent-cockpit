@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "DRYRUN="
if /i "%~1"=="--dry-run" set "DRYRUN=1"
if not "%~1"=="" if not defined DRYRUN (
    echo [agent-cockpit] ERROR: unknown argument "%~1". Usage: deploy-site.bat [--dry-run]
    goto :failed
)
if defined DRYRUN echo [agent-cockpit] Dry run: the site will not be uploaded.

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

set "DIRTY="
for /f "delims=" %%L in ('git status --porcelain --untracked-files^=normal') do set "DIRTY=1"
if defined DIRTY if defined DRYRUN (
    echo [agent-cockpit] WARNING: the worktree has uncommitted changes. A real run stops here.
    git status --short
    set "DIRTY="
)
if defined DIRTY (
    echo [agent-cockpit] ERROR: commit or discard all worktree changes before uploading.
    git status --short
    goto :failed
)

set "BRANCH="
for /f "delims=" %%B in ('git branch --show-current') do set "BRANCH=%%B"
if not defined BRANCH set "BRANCH=(detached)"
set "COMMIT="
for /f "delims=" %%C in ('git log -1 --format^=%%h') do set "COMMIT=%%C"
echo.
echo [agent-cockpit] Branch: %BRANCH%  Commit: %COMMIT%
if /i not "%BRANCH%"=="main" echo [agent-cockpit] WARNING: this is not the main branch.
echo.

node --use-system-ca tools\site-deploy.js upload --dry-run
if errorlevel 1 goto :failed
echo.
if defined DRYRUN (
    echo [agent-cockpit] Dry run finished. A real run would upload the files above.
    goto :done
)

set "UPLOAD="
set /p "UPLOAD=Upload the site files now? (y/N): "
if /i not "!UPLOAD!"=="y" (
    echo [agent-cockpit] Upload skipped.
    goto :done
)
node --use-system-ca tools\site-deploy.js upload
if errorlevel 1 goto :uploadfailed
echo [agent-cockpit] Site upload completed: https://ktysne.info/agent-cockpit/
goto :done

:uploadfailed
echo.
echo [agent-cockpit] Upload failed. Running deploy-site.bat again completes the upload.
goto :pausefail

:done
pause
exit /b 0

:failed
echo.
echo [agent-cockpit] Deploy failed. Check the output above.
:pausefail
pause
exit /b 1
