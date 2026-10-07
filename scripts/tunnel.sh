#!/bin/bash
# Keeps OpenRocket Cloud reachable from the internet through a free Cloudflare quick tunnel:
# Docker VM up, Mac kept awake, tunnel running, and PUBLIC_URL in .env following the tunnel's
# address. Runs as a background service; install it with `scripts/background.sh on`.
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd "$(dirname "$0")/.."

colima status >/dev/null 2>&1 || colima start
docker compose up -d server >/dev/null 2>&1

# Keep the Mac from idle-sleeping while this runs (closing the lid on battery still sleeps).
caffeinate -i -w $$ &

port=$(grep -E '^HTTP_PORT=' .env | cut -d= -f2)
cloudflared tunnel --no-autoupdate --url "http://localhost:${port:-8080}" 2>&1 | while IFS= read -r line; do
  echo "$line"
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' <<<"$line" | head -1)
  if [ -n "$url" ]; then
    echo "$url" > .tunnel-url
    scripts/tunnel-watchdog.sh "$url" "${port:-8080}" &
    if ! grep -qx "PUBLIC_URL=$url" .env; then
      echo "Tunnel address changed to $url; updating .env and restarting the server"
      sed -i '' "s#^PUBLIC_URL=.*#PUBLIC_URL=$url#" .env
      docker compose up -d --force-recreate server
      osascript -e "display notification \"New address: $url. Add $url/auth/google/callback in Google Cloud.\" with title \"OpenRocket Cloud\"" || true
    fi
  fi
done
