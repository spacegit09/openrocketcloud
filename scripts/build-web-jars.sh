#!/bin/bash
# Builds the Java side of the browser version into web/public/or/:
#   OpenRocket-web.jar  the official OpenRocket jar without the parts a browser cannot use
#                       (scripts/slim-openrocket-jar.py); OpenRocket's own code is unchanged
#   orcloud-web.jar     the live-share bridge (worker/bridge/src) plus the browser start-up code
#                       and fixes (worker/bridge/web)
#   jsrm-web.jar        JSRM, the Java version of Richard Nakka's SRM spreadsheet that METEOR runs
#                       (the motor designer's calculation, orcloud.bridge.MotorLab), with exp4j;
#                       JSRM has one change, scripts/jsrm-reuse-cross-section.patch, which makes
#                       its shaped grains quicker without changing a single result
# Needs Docker (for the JDK and Maven), git and python3.
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

# JSRM (github.com/jbgust/jsrm, GPL-3.0), built from its source at a pinned release with our one
# change (the patch, which the jar carries in META-INF). Its other library, Guava, comes with
# OpenRocket's jar, which the motor designer loads alongside.
jsrm_tag=v3.3
jsrm_commit=f3795b8041547165502bfe8ae8f69df927c22ae1
jsrm_patch="$root/scripts/jsrm-reuse-cross-section.patch"
jsrm="$cache/jsrm-$jsrm_tag-$(shasum -a 256 "$jsrm_patch" | cut -c1-8)"
if [ ! -f "$jsrm/target/Java-Solid-Rocket-Motor-${jsrm_tag#v}.jar" ]; then
  echo "Building JSRM $jsrm_tag with $(basename "$jsrm_patch")"
  rm -rf "$jsrm"
  git clone -q --branch "$jsrm_tag" --depth 1 https://github.com/jbgust/jsrm.git "$jsrm"
  [ "$(git -C "$jsrm" rev-parse HEAD)" = "$jsrm_commit" ] || { echo "JSRM $jsrm_tag is not commit $jsrm_commit"; exit 1; }
  git -C "$jsrm" apply "$jsrm_patch"
  docker run --rm -v "$jsrm":/w -v "$cache/m2":/root/.m2 -w /w maven:3.9-eclipse-temurin-17 \
    mvn -q -B -DskipTests package dependency:copy-dependencies -DincludeScope=runtime
fi
docker run --rm -v "$root":/w -w /w -e JSRM="${jsrm#"$root"/}" -e PATCH="${jsrm_patch#"$root"/}" eclipse-temurin:17-jdk sh -c '
  set -e
  t=$(mktemp -d)
  (cd "$t" && jar xf /w/$JSRM/target/Java-Solid-Rocket-Motor-*[0-9].jar && jar xf /w/$JSRM/target/dependency/exp4j-0.4.8.jar)
  rm -rf "$t/META-INF" && mkdir "$t/META-INF"
  cp "$JSRM/LICENSE" "$t/META-INF/LICENSE-JSRM.txt"
  cp "$PATCH" "$t/META-INF/JSRM-CHANGES.patch"
  printf "%s\n" "exp4j 0.4.8 (net.objecthunter.exp4j), Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0" > "$t/META-INF/NOTICE-exp4j.txt"
  jar cf web/public/or/jsrm-web.jar -C "$t" .'

docker run --rm -v "$root":/w -w /w -e JAR="web/.cache/OpenRocket-$ver.jar" eclipse-temurin:17-jdk sh -c '
  set -e
  classes=$(mktemp -d)
  javac --release 17 -nowarn -cp "$JAR:web/public/or/jsrm-web.jar" -d "$classes" $(find worker/bridge/src worker/bridge/web -name "*.java") 2>&1 | grep -v "^Note:" || true
  mkdir -p "$classes/orcloud"
  # The @Plugin classes, for the browser replacement of OpenRocket'"'"'s class-path scanner.
  java -cp "$JAR:$classes" orcloud.web.PluginIndex > "$classes/orcloud/plugins.txt"
  jar cf web/public/or/orcloud-web.jar -C "$classes" .
  echo "orcloud-web.jar: $(wc -l < "$classes/orcloud/plugins.txt") plugins"'
ls -la "$out"/OpenRocket-web.jar "$out"/orcloud-web.jar "$out"/jsrm-web.jar | awk '{printf "  %-20s %6.1f MB\n", $9, $5/1e6}' | sed "s#$out/##"
# The copy the pages load, named after its contents (web/scripts/prebuild.mjs).
(cd "$root/web" && node scripts/prebuild.mjs > /dev/null)
