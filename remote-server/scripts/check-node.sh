#!/usr/bin/env bash
# Preflight: is this Node new enough to run remotea-server?
#   ./scripts/check-node.sh [path/to/node]      (default: node on PATH)
# Exits 0 when it is; otherwise prints what to do and exits 1. install.sh runs it
# before building, so an unsupported Node fails here and not halfway through.
#
# The floor is 22.13.0: the session collector reads Codex's databases with
# node:sqlite, which Node 22 only ships unflagged from 22.13. Keep MIN_NODE equal
# to "engines" in package.json and the major in .nvmrc (tests/node-version.test.ts
# checks that they agree).
set -euo pipefail

MIN_NODE=22.13.0

node_bin="${1:-$(command -v node || true)}"
fix="Install Node $MIN_NODE or later (Node 22 LTS), e.g. 'nvm install 22' (remote-server/.nvmrc) or https://nodejs.org, make it the 'node' on PATH, and run install.sh again."

if [[ -z "$node_bin" ]] || ! "$node_bin" --version >/dev/null 2>&1; then
  printf 'remotea-server needs Node >= %s, but node was not found on PATH.\n%s\n' "$MIN_NODE" "$fix" >&2
  exit 1
fi

found="$("$node_bin" -p 'process.versions.node' 2>/dev/null || true)"
if [[ ! "$found" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  printf 'remotea-server needs Node >= %s; could not read the version of %s.\n%s\n' "$MIN_NODE" "$node_bin" "$fix" >&2
  exit 1
fi
have=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
IFS=. read -r -a want <<<"$MIN_NODE"

too_old=0
for i in 0 1 2; do
  if (( 10#${have[i]} != 10#${want[i]} )); then
    (( 10#${have[i]} < 10#${want[i]} )) && too_old=1
    break
  fi
done
if (( too_old )); then
  printf 'remotea-server needs Node >= %s; %s is %s.\n%s\n' "$MIN_NODE" "$node_bin" "v$found" "$fix" >&2
  exit 1
fi

# The version is not the whole story (a build without SQLite, a flag that disables it):
# load the module the collector needs, as the server will.
if ! "$node_bin" -e 'require("node:sqlite")' >/dev/null 2>&1; then
  printf 'remotea-server needs node:sqlite, which %s (v%s) cannot load.\n%s\n' "$node_bin" "$found" "$fix" >&2
  exit 1
fi
