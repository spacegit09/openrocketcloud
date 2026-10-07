#!/usr/bin/env bash
# OPuhRohCum installer: the real OpenRocket in the browser, with live sharing.
#
#   curl -fsSL https://raw.githubusercontent.com/spacegit09/openrocketcloud/main/install.sh | bash
#
# Needs Docker with the Compose plugin (Linux server, or Docker Desktop on Mac/Windows+WSL).
# Re-running it updates an existing installation and keeps its settings and designs.
set -euo pipefail

REPO="${OPUHROHCUM_REPO:-spacegit09/openrocketcloud}"
BRANCH="${OPUHROHCUM_BRANCH:-main}"
DIR="${OPUHROHCUM_DIR:-$HOME/openrocketcloud}"
RAW="${OPUHROHCUM_RAW:-https://raw.githubusercontent.com/$REPO/$BRANCH}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
ask() { # ask "Question" default -> answer (uses the terminal even when piped from curl)
  local answer=""
  if { exec 3<>/dev/tty; } 2>/dev/null; then
    printf '%s %s' "$1" "${2:+[$2] }" >&3
    read -r answer <&3 || true
    exec 3>&-
  fi
  printf '%s' "${answer:-${2:-}}"
}
set_env() { # set_env KEY value  (in .env)
  if grep -q "^$1=" .env; then
    sed -i.bak "s#^$1=.*#$1=$2#" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

command -v docker >/dev/null || fail "Docker is not installed. Get it from https://docs.docker.com/get-docker/ and run this again."
docker info >/dev/null 2>&1 || fail "Docker is installed but not running (or you need sudo). Start Docker and run this again."
docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is missing. See https://docs.docker.com/compose/install/"

say "Installing OPuhRohCum into $DIR"
mkdir -p "$DIR"
cd "$DIR"
for f in docker-compose.yml docker-compose.https.yml Caddyfile .env.example; do
  curl -fsSL "$RAW/$f" -o "$f" || fail "Could not download $f from $RAW"
done

if [ ! -f .env ]; then
  cp .env.example .env
  say "A few questions (press Enter for the default)"
  echo "Where will people open it?"
  echo "  1) Only on this computer, to try it out (http://localhost:8080)"
  echo "  2) On the internet, at a domain name pointing to this server (HTTPS is set up automatically)"
  mode=$(ask "Choose 1 or 2:" 1)
  if [ "$mode" = "2" ]; then
    domain=$(ask "Domain name (for example rocket.example.com):" "")
    [ -n "$domain" ] || fail "A domain name is needed for option 2."
    set_env PUBLIC_URL "https://$domain"
    set_env DOMAIN "$domain"
  else
    set_env PUBLIC_URL "http://localhost:8080"
  fi
  echo
  echo "Google sign-in needs an OAuth client ID and secret (see the setup guide:"
  echo "https://${REPO%%/*}.github.io/${REPO#*/}/#google). You can add them to $DIR/.env later."
  client_id=$(ask "Google client ID (Enter to skip):" "")
  if [ -n "$client_id" ]; then
    set_env GOOGLE_CLIENT_ID "$client_id"
    set_env GOOGLE_CLIENT_SECRET "$(ask "Google client secret:" "")"
  elif [ "$mode" != "2" ]; then
    set_env DEV_LOGIN true
    echo "No Google keys: test sign-in (any email, this computer only) is turned on."
  fi
  domains=$(ask "Only allow emails from these domains, comma-separated (Enter = anyone):" "")
  [ -z "$domains" ] || set_env ALLOWED_EMAIL_DOMAINS "$domains"
fi

compose=(docker compose)
if grep -q '^DOMAIN=.\+' .env; then
  compose+=(-f docker-compose.yml -f docker-compose.https.yml)
fi

say "Downloading OPuhRohCum (the first time this is about 1.5 GB)"
"${compose[@]}" pull
say "Starting"
"${compose[@]}" up -d --no-build --remove-orphans

url=$(grep '^PUBLIC_URL=' .env | cut -d= -f2-)
say "Done. Open $url"
if ! grep -q '^GOOGLE_CLIENT_ID=.\+' .env; then
  echo "To turn on Google sign-in later: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to $DIR/.env,"
  echo "then run this installer again."
else
  echo "In your Google OAuth client, the authorized redirect URI must be: $url/auth/google/callback"
fi
echo "Settings: $DIR/.env   Update: run this installer again   Stop: cd $DIR && docker compose down"
