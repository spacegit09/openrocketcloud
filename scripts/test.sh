#!/usr/bin/env bash
# Runs all tests:
#  1. the live-share self-test against the real OpenRocket 24.12 (all bundled example designs),
#     inside the worker image on a virtual display; it also writes Java model fixtures;
#  2. the server tests, including Java/Node parity on those fixtures.
set -euo pipefail
cd "$(dirname "$0")/.."
export ORC_IMAGES="${ORC_IMAGES:-orcloud}" # test the locally built images

docker compose build worker
cache=worker/.cache
mkdir -p "$cache/test-out" "$cache/fixtures"
[ -f "$cache/OpenRocket.jar" ] || docker run --rm --entrypoint cat orcloud-worker /opt/openrocket/OpenRocket.jar > "$cache/OpenRocket.jar"

docker run --rm -v "$PWD/worker:/w" -w /w eclipse-temurin:17-jdk \
  bash -c 'javac -nowarn -d .cache/test-out -cp .cache/OpenRocket.jar $(find bridge/src bridge/test -name "*.java")'

docker run --rm -e ORC_VNC_PASSWORD=test -e SELFTEST_DUMP=/fx \
  -v "$PWD/$cache/fixtures:/fx" -v "$PWD/$cache/test-out:/opt/test" --entrypoint bash orcloud-worker -c '
  set -o pipefail
  Xvnc :1 -geometry 1400x900 -depth 24 -SecurityTypes None >/tmp/xvnc.log 2>&1 &
  sleep 1.5; openbox >/dev/null 2>&1 &
  java --add-exports java.base/java.lang=ALL-UNNAMED --add-exports java.desktop/sun.awt=ALL-UNNAMED \
       --add-exports java.desktop/sun.java2d=ALL-UNNAMED -cp /opt/openrocket/OpenRocket.jar:/opt/test \
       orcloud.bridge.SelfTest 2>&1 | grep -E "^(  FAIL|  note|ERROR|SELFTEST|[A-Z0-9].*\.ork$)"'

(cd server && npm ci --no-audit --no-fund >/dev/null && npm test)
