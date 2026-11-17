#!/usr/bin/env bash
# Run the packaged macOS app's `--smoke` self-test (src/main/smoke.ts) and fail
# on a failed or missing result. The macOS counterpart of smoke-windows.ps1,
# used by .github/workflows/smoke.yml; also runnable by hand on a Mac after
# `npx electron-builder --mac dir`:
#
#   scripts/smoke-mac.sh release/mac-arm64/remotea.app/Contents/MacOS/remotea smoke/mac.json smoke-mac
#
# The binary is run directly, never through `open`, so its exit code and output
# come back here. Each run uses its own WMUX_INSTANCE, so it never shares a
# pipe, data folder or single-instance lock with another copy of the app.
set -uo pipefail

exe="${1:?usage: smoke-mac.sh <exe> <out.json> [instance] [timeout-ms]}"
out="${2:?usage: smoke-mac.sh <exe> <out.json> [instance] [timeout-ms]}"
instance="${3:-smoke}"
timeout_ms="${4:-90000}"

if [ ! -x "$exe" ]; then
  echo "::error::smoke: no executable at $exe"
  exit 1
fi
mkdir -p "$(dirname "$out")"
out_full="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
rm -f "$out_full"

export WMUX_INSTANCE="$instance"
echo "smoke: $exe --smoke --smoke-out=$out_full --smoke-timeout=$timeout_ms (instance $instance)"
"$exe" --smoke "--smoke-out=$out_full" "--smoke-timeout=$timeout_ms" &
pid=$!

# The app enforces its own budget and exits 2 if it wedges past it; this is the
# backstop for a process that never gets that far (stuck before app ready).
deadline=$(( $(date +%s) + timeout_ms / 1000 + 30 ))
while kill -0 "$pid" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::smoke: $exe did not exit within $(( timeout_ms / 1000 + 30 )) s"
    kill -9 "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    exit 1
  fi
  sleep 1
done
wait "$pid"
code=$?

if [ ! -f "$out_full" ]; then
  echo "::error::smoke: no result file at $out_full (exit code $code)"
  exit 1
fi

# Print each step, and write the same table to the job summary when there is one.
node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const rows = (r.steps || []).map((s) =>
  `  ${s.ok ? "ok    " : "FAILED"} ${String(s.name).padEnd(16)} ${String(s.ms).padStart(6)} ms  ${s.detail || ""}`);
console.log(rows.join("\n"));
if (r.screenTail) {
  console.log("  screen tail:");
  for (const line of String(r.screenTail).split("\n")) console.log(`    | ${line}`);
}
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const md = ["### macOS smoke", "", "| Step | Result | ms | Detail |", "|---|---|---|---|",
    ...(r.steps || []).map((s) => `| ${s.name} | ${s.ok ? "ok" : "FAILED"} | ${s.ms} | ${String(s.detail || "").replace(/\|/g, "\\|")} |`),
    "", r.ok ? `PASS in ${r.durationMs} ms` : `FAIL: ${r.error || "see steps"}`, ""];
  fs.appendFileSync(summary, md.join("\n"));
}
process.exit(r.ok ? 0 : 3);
' "$out_full"
parsed=$?

if [ "$code" -ne 0 ] || [ "$parsed" -ne 0 ]; then
  echo "::error::smoke failed (exit $code)"
  exit 1
fi
echo "smoke: PASS (exit $code)"
