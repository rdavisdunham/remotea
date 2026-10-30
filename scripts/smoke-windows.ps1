# Run the packaged app's `--smoke` self-test (src/main/smoke.ts) and fail on a
# failed or missing result. Used by .github/workflows/smoke.yml; also runnable
# by hand on a Windows machine after `npm run build`:
#
#   pwsh scripts/smoke-windows.ps1 -Exe release\win-unpacked\remotea.exe -Out smoke\unpacked.json -Instance smoke-unpacked
#
# Each run uses its own WMUX_INSTANCE, so it never shares a pipe, %APPDATA%
# folder or single-instance lock with an installed remotea (or another variant).
param(
  [Parameter(Mandatory = $true)] [string] $Exe,
  [Parameter(Mandatory = $true)] [string] $Out,
  [string] $Instance = 'smoke',
  [int] $TimeoutMs = 90000
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Exe)) { throw "no such executable: $Exe" }
$outFull = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outFull) | Out-Null
Remove-Item -LiteralPath $outFull -ErrorAction SilentlyContinue

$env:WMUX_INSTANCE = $Instance
# Quoted: Start-Process joins the list with spaces and quotes nothing itself.
$appArgs = @('--smoke', "--smoke-out=`"$outFull`"", "--smoke-timeout=$TimeoutMs")
Write-Host "smoke: $Exe $($appArgs -join ' ') (instance $Instance)"
$p = Start-Process -FilePath $Exe -ArgumentList $appArgs -PassThru
# Caching the handle is what makes ExitCode readable after the process ends
# (a long-standing Start-Process quirk); without it ExitCode is $null.
$null = $p.Handle
# The app enforces its own budget and exits 2 if it wedges past it; this is the
# backstop for a process that never gets that far (stuck before app ready).
if (-not $p.WaitForExit($TimeoutMs + 30000)) {
  Write-Host "::error::smoke: $Exe did not exit within $($TimeoutMs + 30000) ms"
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  exit 1
}
$code = $p.ExitCode

if (-not (Test-Path -LiteralPath $outFull)) {
  Write-Host "::error::smoke: no result file at $outFull (exit code $code)"
  exit 1
}
$result = Get-Content -LiteralPath $outFull -Raw | ConvertFrom-Json
foreach ($s in $result.steps) {
  $mark = if ($s.ok) { 'ok    ' } else { 'FAILED' }
  Write-Host ("  {0} {1,-16} {2,6} ms  {3}" -f $mark, $s.name, $s.ms, $s.detail)
}
if ($result.screenTail) { Write-Host "  screen tail:"; $result.screenTail -split "`n" | ForEach-Object { Write-Host "    | $_" } }
if ($code -ne 0 -or -not $result.ok) {
  Write-Host "::error::smoke failed (exit $code): $($result.error)"
  exit 1
}
Write-Host "smoke: PASS in $($result.durationMs) ms (exit $code)"
