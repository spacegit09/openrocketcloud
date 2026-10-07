#!/bin/bash
# Runs the public tunnel (scripts/tunnel.sh) as a macOS background service.
#   scripts/background.sh on       start now and at every login
#   scripts/background.sh off      stop and remove
#   scripts/background.sh status   is it running, and at which address
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
label=com.openrocket-cloud.tunnel
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/openrocket-cloud-tunnel.log"

case "${1:-status}" in
  on)
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$root/scripts/tunnel.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    echo "Started. Address (may take ~10 s): $root/.tunnel-url   Log: $log"
    ;;
  off)
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "Stopped; it will no longer start at login."
    ;;
  status)
    if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
      echo "Running. Address: $(cat "$root/.tunnel-url" 2>/dev/null || echo unknown)"
    else
      echo "Not running."
    fi
    ;;
  *) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
