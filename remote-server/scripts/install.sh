#!/usr/bin/env bash
# Build remotea-server and install it as a systemd user service in WSL.
#   ./scripts/install.sh [--yes]
# --yes: restart a running server without asking (live sessions are lost and respawned by the apps).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
assume_yes=0
[[ "${1:-}" == "--yes" ]] && assume_yes=1
say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

node_bin="$(command -v node || true)"
[[ -n "$node_bin" ]] || die "node not found on PATH (need Node >= 20)"
node_major="$("$node_bin" -p 'process.versions.node.split(".")[0]')"
(( node_major >= 20 )) || die "Node >= 20 required (found $("$node_bin" --version))"
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

# Agent status hooks (Claude Code, Codex): beside any hooks already there, never replacing them.
[[ "${REMOTEA_SKIP_HOOKS:-0}" == 1 ]] || "$node_bin" dist/remote-server/src/cli.js hooks install

unit_dir="$HOME/.config/systemd/user"
mkdir -p "$unit_dir"
sed -e "s#@NODE@#$node_bin#g" -e "s#@WORKDIR@#$here#g" -e "s#@PATH@#$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin#g" \
  systemd/remotea.service.in > "$unit_dir/remotea.service"
systemctl --user daemon-reload

if systemctl --user is-active --quiet remotea; then
  live="$("$node_bin" dist/remote-server/src/cli.js status --json | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).sessions.filter(x=>x.state==="live").length))')"
  if (( live > 0 && assume_yes == 0 )); then
    warn "remotea is running with $live live session(s). Restarting ends their processes"
    warn "(apps reconnect and respawn them; Claude sessions resume). Restart now? [y/N]"
    read -r answer
    [[ "$answer" == [yY]* ]] || { say "Installed but not restarted. Run: systemctl --user restart remotea"; exit 0; }
  fi
  systemctl --user restart remotea
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
