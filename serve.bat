@echo off
REM Double-click this to serve the game and open it in your browser.
REM It just runs serve.ps1, bypassing the PowerShell script execution policy.
title BLACKSITE server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*
if errorlevel 1 pause
