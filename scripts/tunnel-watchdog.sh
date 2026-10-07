#!/bin/bash
# Restarts the tunnel if its public address stops working while this Mac is online (e.g.
# Cloudflare dropped the quick tunnel during a long sleep). launchd then starts a new tunnel and
# tunnel.sh switches .env to the new address and shows a notification.
#   usage: tunnel-watchdog.sh <public url> <local port>
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd "$(dirname "$0")/.."
url=$1
port=$2
fails=0
while sleep 60; do
  [ "$(cat .tunnel-url 2>/dev/null)" = "$url" ] || exit 0 # a newer tunnel took over
  if curl -fsS -m 15 "$url/healthz" >/dev/null 2>&1; then
    fails=0
    continue
  fi
  # Only count failures of the tunnel itself: local server up and the internet reachable.
  curl -fsS -m 5 "http://localhost:$port/healthz" >/dev/null 2>&1 || continue
  curl -fsS -m 10 https://www.cloudflare.com/cdn-cgi/trace >/dev/null 2>&1 || continue
  fails=$((fails + 1))
  if [ "$fails" -ge 5 ]; then
    echo "Tunnel address $url unreachable for 5 minutes; restarting the tunnel"
    pkill -f 'cloudflared tunnel --no-autoupdate --url'
    exit 0
  fi
done
