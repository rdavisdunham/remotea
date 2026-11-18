@echo off
setlocal
REM This private shim is on PATH only in remotea terminals with native Codex.
"%REMOTEA_CODEX_RUNTIME%" "%REMOTEA_CODEX_LAUNCHER%" %*
exit /b %ERRORLEVEL%
