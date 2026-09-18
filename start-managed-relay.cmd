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
echo First run: installing relay dependencies...
call npm ci --prefix "%RUNTIME%" --ignore-scripts --no-audit --no-fund
if errorlevel 1 (
  echo Dependency installation failed. Check that Node.js 22.13+ and npm are available.
  goto :eof
)

:run
node "%ROOT%managed-relay-server.js" %*

rem Keep the window open after the service exits so errors can be read.
rem Set RELAY_NO_PAUSE=1 for automated calls to skip the pause.
if not defined RELAY_NO_PAUSE pause
