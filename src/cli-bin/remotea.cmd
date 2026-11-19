@echo off
setlocal
REM remotea CLI shim. remotea prepends this dir (cli-bin) to PATH in every shell it
REM spawns, so bare `remotea` resolves in cmd/PowerShell children too. Runs the
REM Node pipe client via the $REMOTEA_CLI path remotea injects; falls back to the copy
REM next to this shim. No remotea.exe in this dir, so no PATHEXT collision.
REM
REM The runtime comes from $REMOTEA_NODE when remotea declared one (issue #187): bare
REM `node` assumes node is installed AND on PATH, and remotea already resolved a
REM better answer at launch — down to its own Electron binary, which is Node
REM only with ELECTRON_RUN_AS_NODE set. Unset means an older remotea (or a shell it
REM did not spawn), so the old behaviour is the fallback, not an error.
if defined REMOTEA_NODE_ELECTRON set "ELECTRON_RUN_AS_NODE=1"
if defined REMOTEA_NODE (set "REMOTEA_NODE_BIN=%REMOTEA_NODE%") else (set "REMOTEA_NODE_BIN=node")
if defined REMOTEA_CLI (
  "%REMOTEA_NODE_BIN%" "%REMOTEA_CLI%" %*
) else (
  "%REMOTEA_NODE_BIN%" "%~dp0..\cli\remotea.js" %*
)
