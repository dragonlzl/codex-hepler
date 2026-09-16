@echo off
rem Switch the console to UTF-8 before any non-ASCII output (avoids mojibake).
rem Keep this comment ASCII: lines above chcp are still decoded with the old code page.
chcp 65001 >nul 2>nul
setlocal
node "%~dp0managed-relay-runtime\codex-launch.js" %*

rem 启动失败时停住窗口，避免“未找到 Codex 桌面应用”等提示一闪而过。
rem 自动化调用可先设置 RELAY_NO_PAUSE=1 跳过。
if not defined RELAY_NO_PAUSE pause
