#!/usr/bin/env bash
# Build remotea-server and install it as a systemd user service in WSL.
#   ./scripts/install.sh [--yes] [--hooks | --no-hooks]
# --yes:      restart a running server without asking (live sessions are lost and respawned by the apps).
# --hooks:    install the agent status hooks without asking; --no-hooks: leave agent settings alone.
#             Without either, you are asked (and nothing is changed when there is nobody to ask).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
assume_yes=0
hooks_choice=ask
for arg in "$@"; do
  case "$arg" in
    --yes) assume_yes=1 ;;
    --hooks) hooks_choice=yes ;;
    --no-hooks) hooks_choice=no ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done
say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# Node first, before anything is built: the floor (and why) is in scripts/check-node.sh.
node_bin="$(command -v node || true)"
"$here/scripts/check-node.sh" "$node_bin" || die "Stopped before building: unsupported Node (see above)."
for tool in make g++ python3; do
  command -v "$tool" >/dev/null || die "$tool is required to build node-pty (sudo apt install build-essential python3)"
done
command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 \
  || die "systemd user services are not available. Enable systemd in WSL: add [boot] systemd=true to /etc/wsl.conf, then 'wsl --shutdown' from Windows."

say "Building remotea-server in $here"
cd "$here"
npm ci --no-audit --no-fund
npm run build
chmod +x dist/remote-server/src/cli.js dist/remote-server/src/main.js

config_dir="${REMOTEA_CONFIG_DIR:-$HOME/.config/remotea}"
REMOTEA_CONFIG_DIR="$config_dir" "$node_bin" dist/remote-server/src/cli.js token >/dev/null

mkdir -p "$HOME/.local/bin"
ln -sf "$here/dist/remote-server/src/cli.js" "$HOME/.local/bin/remotea"

# Agent status hooks (Claude Code, Codex): offered, not imposed. They go beside any hooks
# already in those files and never replace them; `remotea hooks remove` takes them back out.
cli() { "$node_bin" dist/remote-server/src/cli.js "$@"; }
hooks_json="$(cli hooks status --json)"
hooks_count() { "$node_bin" -e 'const [j,f]=process.argv.slice(1);console.log(JSON.parse(j).filter(x=>x.present&&x[f]).length)' "$hooks_json" "$1"; }
present="$(hooks_count present)"
installed="$(hooks_count entries)"
if [[ "$hooks_choice" == no ]]; then
  :
elif (( present == 0 )); then
  say "No Claude Code or Codex found in this WSL; skipping agent status hooks (remotea hooks install, later)."
elif [[ "$hooks_choice" == ask && "$installed" -gt 0 ]]; then
  cli hooks install >/dev/null  # chosen before: refresh the helper copy and entries
  say "Agent status hooks: up to date."
else
  if [[ "$hooks_choice" == ask ]]; then
    if [[ -t 0 ]]; then
      say ""
      say "Agent status hooks"
      echo "  Let Claude Code and Codex running in remotea terminals tell the app when they are"
      echo "  working, waiting on you, or done (and which conversation to resume after a restart)."
      echo "  This adds remotea's entries to (other hooks there are kept as they are):"
      "$node_bin" -e 'for (const t of JSON.parse(process.argv[1])) if (t.present) console.log("    " + t.file)' "$hooks_json"
      read -r -p "  Install them? [Y/n] " answer || answer=n
      [[ -z "$answer" || "$answer" == [yY]* ]] && hooks_choice=yes || hooks_choice=no
    else
      warn "Agent status hooks not installed (no terminal to ask). Run: remotea hooks install"
      hooks_choice=no
    fi
  fi
  if [[ "$hooks_choice" == yes ]]; then
    cli hooks install
  else
    say "Skipped. Install them any time with: remotea hooks install"
  fi
fi

# The Python session collector's SessionStart hook: only mentioned, never removed here.
# Removing it is a step of the collector cutover (docs/remotea/eridani-link.md).
if cli hooks --remove-legacy-collector --dry-run | grep -q '^would remove'; then
  say "The Python session collector's SessionStart hook is still in ~/.claude/settings.json."
  echo "  After the collector cutover (remotea eridani collector authoritative), remove it with:"
  echo "    remotea hooks --remove-legacy-collector"
fi

unit_dir="$HOME/.config/systemd/user"
mkdir -p "$unit_dir"
sed -e "s#@NODE@#$node_bin#g" -e "s#@WORKDIR@#$here#g" -e "s#@PATH@#$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin#g" \
  systemd/remotea.service.in > "$unit_dir/remotea.service"
systemctl --user daemon-reload

if systemctl --user is-active --quiet remotea; then
  status_json="$("$node_bin" dist/remote-server/src/cli.js status --json)"
  live="$("$node_bin" -e 'const s=JSON.parse(process.argv[1]);console.log(s.sessions.filter(x=>x.state==="live"&&!x.inKeeper).length)' "$status_json")"
  keeper="$("$node_bin" -e 'const k=JSON.parse(process.argv[1]).server.ptyKeeper;console.log(k&&k.enabled&&k.running?1:0)' "$status_json")"
  if (( keeper == 1 && live == 0 )); then
    # S-Q5: the PTY keeper holds every session; drain and restart the server only (docs/remotea/upgrade.md).
    say "Restarting the server with remotea upgrade (sessions in the PTY keeper keep running)"
    "$node_bin" dist/remote-server/src/cli.js upgrade --yes || warn "remotea upgrade reported a problem (see above)"
    live=-1
  fi
  if (( live > 0 && assume_yes == 0 )); then
    warn "remotea is running with $live live session(s). Restarting ends their processes"
    warn "(apps reconnect and respawn them; Claude sessions resume). Restart now? [y/N]"
    read -r answer
    [[ "$answer" == [yY]* ]] || { say "Installed but not restarted. Run: systemctl --user restart remotea"; exit 0; }
  fi
  (( live < 0 )) || systemctl --user restart remotea
else
  systemctl --user enable --now remotea
fi

sleep 1
systemctl --user is-active --quiet remotea || die "remotea failed to start: journalctl --user -u remotea -n 50"

[[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" == "yes" ]] \
  || warn "Lingering is off: the server stops when your last WSL session closes. Fix: sudo loginctl enable-linger $USER"

port="$("$node_bin" -p "require('$config_dir/config.json').port" 2>/dev/null || echo 7717)"
ts_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
ts_name="$(tailscale status --json 2>/dev/null | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,""))}catch{}})' || true)"

say ""
say "remotea-server is running."
echo "  On this PC's Windows side:  ws://127.0.0.1:$port"
[[ -n "$ts_name" ]] && echo "  From other devices:         ws://$ts_name:$port"
[[ -n "$ts_ip" ]] && echo "                              ws://$ts_ip:$port"
echo "  Token:                      $(cat "$config_dir/token")"
echo "  (print it again any time with: remotea token)"
say ""
echo "Keep WSL running while you're away, or sessions end with it. In %UserProfile%\\.wslconfig:"
echo "  [wsl2]"
echo "  vmIdleTimeout=-1"
say ""
echo "Optional: link this server to Eridani (agent status and turns, read-only for now):"
echo "  remotea eridani connect --url wss://<eridani-host>/api/v1/external/agents/link"
echo "  (see docs/remotea/eridani-link.md; nothing is sent until you run it)"
