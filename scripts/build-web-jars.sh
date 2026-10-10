#!/bin/bash
# Builds the Java side of the browser version into web/public/or/:
#   OpenRocket-web.jar  the official OpenRocket jar without the parts a browser cannot use
#                       (scripts/slim-openrocket-jar.py); OpenRocket's own code is unchanged
#   orcloud-web.jar     the live-share bridge (worker/bridge/src) plus the browser start-up code
#                       and fixes (worker/bridge/web)
# Needs Docker (for the JDK) and python3.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
ver=$(sed -n 's/^ARG OPENROCKET_VERSION=//p' "$root/worker/Dockerfile")
sha=$(sed -n 's/^ARG OPENROCKET_SHA256=//p' "$root/worker/Dockerfile")
cache="$root/web/.cache"
out="$root/web/public/or"
mkdir -p "$cache" "$out"

jar="$cache/OpenRocket-$ver.jar"
if ! echo "$sha  $jar" | shasum -a 256 -c - >/dev/null 2>&1; then
  echo "Downloading OpenRocket $ver"
  curl -fsSL -o "$jar" "https://github.com/openrocket/openrocket/releases/download/release-$ver/OpenRocket-$ver.jar"
  echo "$sha  $jar" | shasum -a 256 -c -
fi

python3 "$root/scripts/slim-openrocket-jar.py" "$jar" "$out/OpenRocket-web.jar"

docker run --rm -v "$root":/w -w /w -e JAR="web/.cache/OpenRocket-$ver.jar" eclipse-temurin:17-jdk sh -c '
  set -e
  classes=$(mktemp -d)
  javac --release 17 -nowarn -cp "$JAR" -d "$classes" $(find worker/bridge/src worker/bridge/web -name "*.java") 2>&1 | grep -v "^Note:" || true
  mkdir -p "$classes/orcloud"
  # The @Plugin classes, for the browser replacement of OpenRocket'"'"'s class-path scanner.
  java -cp "$JAR:$classes" orcloud.web.PluginIndex > "$classes/orcloud/plugins.txt"
  jar cf web/public/or/orcloud-web.jar -C "$classes" .
  echo "orcloud-web.jar: $(wc -l < "$classes/orcloud/plugins.txt") plugins"'
ls -la "$out"/*.jar | awk '{printf "  %-20s %6.1f MB\n", $9, $5/1e6}' | sed "s#$out/##"
