@echo off
rem Switch the console to UTF-8 before any non-ASCII output (avoids mojibake).
rem Keep this comment ASCII: lines above chcp are still decoded with the old code page.
chcp 65001 >nul 2>nul
setlocal
set "ROOT=%~dp0"
set "RUNTIME=%ROOT%managed-relay-runtime"

if not exist "%RUNTIME%\node_modules\toml-eslint-parser" goto install
if not exist "%RUNTIME%\node_modules\proxy-agent" goto install
if not exist "%RUNTIME%\node_modules\proxy-from-env" goto install
goto run

:install
echo 首次运行：正在安装中转服务依赖...
call npm ci --prefix "%RUNTIME%" --ignore-scripts --no-audit --no-fund
if errorlevel 1 (
  echo 依赖安装失败，请确认已安装 Node.js 22.13 或更高版本且 npm 可用。
  goto :eof
)

:run
node "%ROOT%managed-relay-server.js" %*

rem 服务退出（含启动报错）后停住窗口，避免报错一闪而过。
rem 自动化调用可先设置 RELAY_NO_PAUSE=1 跳过。
if not defined RELAY_NO_PAUSE pause
