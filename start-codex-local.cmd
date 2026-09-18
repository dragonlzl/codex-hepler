@echo off
rem Switch the console to UTF-8 before any non-ASCII output (avoids mojibake).
rem Keep this comment ASCII: lines above chcp are still decoded with the old code page.
chcp 65001 >nul 2>nul
setlocal
node "%~dp0managed-relay-runtime\codex-launch.js" %*

rem Keep the window open after an error so the message can be read.
rem Set RELAY_NO_PAUSE=1 for automated calls to skip the pause.
if not defined RELAY_NO_PAUSE pause
