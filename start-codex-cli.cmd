@echo off
rem Keep this file ASCII and switch to UTF-8 for Node output.
chcp 65001 >nul 2>nul
setlocal
node "%~dp0managed-relay-runtime\codex-cli-launch.js" %*
set "CLI_EXIT_CODE=%errorlevel%"
if not defined RELAY_NO_PAUSE pause
exit /b %CLI_EXIT_CODE%
