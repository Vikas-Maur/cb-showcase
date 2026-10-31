@echo off
rem Double-click wrapper for run-windows.ps1 (the NTFS race gate). Arguments pass through, e.g. -Dir D:\carton-race
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-windows.ps1" %*
