#!/usr/bin/env bash
# Runs all tests:
#  1. the live-share self-test against the real OpenRocket 24.12 (all bundled example designs),
#     inside the worker image on a virtual display; it also writes Java model fixtures;
#  2. the launch planner's flight engine against OpenRocket, its weather decoding and its shared
#     forecasts, fins built with their cross sections and root fillets for 3D export, and 3D export
#     of every example with the "3D printing" settings;
#  3. the server tests, including Java/Node parity on those fixtures.
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

# The launch planner's flight engine against OpenRocket: OpenRocket flies its example designs in
# three winds (fixtures in worker/.cache/flight), then the engine flies the same and must agree.
mkdir -p "$cache/flight"
docker run --rm -v "$PWD/$cache/flight:/fx" -v "$PWD/$cache/test-out:/opt/test" --entrypoint bash orcloud-worker -c '
  java -Djava.awt.headless=true -cp /opt/openrocket/OpenRocket.jar:/opt/test orcloud.flight.FlightCheck /fx 2>&1 | grep -E "^(FLIGHTCHECK|  skip)"'
node --test web/test/flight.test.mjs web/test/gfs.test.mjs web/test/forecast.test.mjs web/test/room.test.mjs web/test/room-lookups.test.mjs

# Fins with their cross sections and root fillets (3D export): closed solids, as thick as the fin,
# with the volume each profile gives; fillets tangent to fin and body, with OpenRocket's cross section.
docker run --rm -v "$PWD/$cache/test-out:/opt/test" --entrypoint bash orcloud-worker -c '
  java -Djava.awt.headless=true -cp /opt/openrocket/OpenRocket.jar:/opt/test orcloud.fins.AirfoilCheck 2>&1 | grep -E "^(AIRFOILCHECK|  FAIL)"
  java -Djava.awt.headless=true -cp /opt/openrocket/OpenRocket.jar:/opt/test orcloud.fins.FilletCheck 2>&1 | grep -E "^(FILLETCHECK|  FAIL)"'

# 3D export with the "3D printing" settings of every example, as is and with root fillets on every
# fin set, with the browser build's copies of OpenRocket's TriangulationHelper (faces with no area,
# as along a filled nose cone's axis) and FinSetExporter (fin cross sections and root fillets).
docker run --rm -v "$PWD/worker:/w" -w /w eclipse-temurin:17-jdk \
  bash -c 'mkdir -p .cache/test-web && javac -nowarn -d .cache/test-web -cp .cache/OpenRocket.jar:.cache/test-out \
    bridge/web/info/openrocket/core/file/wavefrontobj/TriangulationHelper.java \
    bridge/web/info/openrocket/core/file/wavefrontobj/export/components/FinSetExporter.java bridge/web/orcloud/web/FinProfiles.java'
docker run --rm -v "$PWD/$cache/test-out:/opt/test" -v "$PWD/$cache/test-web:/opt/test-web" --entrypoint bash orcloud-worker -c '
  set -o pipefail
  java -Djava.awt.headless=true -cp /opt/test-web:/opt/openrocket/OpenRocket.jar:/opt/test orcloud.obj.ObjExportCheck 2>&1 | grep -E "^(OBJCHECK|  FAIL)"'

(cd server && npm ci --no-audit --no-fund >/dev/null && npm test)
