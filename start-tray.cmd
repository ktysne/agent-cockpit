@echo off
start "" powershell.exe -NoProfile -STA -WindowStyle Hidden -File "%~dp0src\tray\tray.ps1"
