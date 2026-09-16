@echo off
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
  exit /b 1
)

:run
node "%ROOT%managed-relay-server.js" %*
