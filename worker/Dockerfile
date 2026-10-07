# OpenRocket session image: the official OpenRocket release running on a VNC display,
# with the live-share bridge attached in the same JVM.

ARG OPENROCKET_VERSION=24.12
ARG OPENROCKET_SHA256=4959b72f52f5f607941e9722abbb7b7f0c4a38ebbbf84204a329db9f31c4f897

FROM --platform=$BUILDPLATFORM eclipse-temurin:17-jdk AS build
ARG OPENROCKET_VERSION
ARG OPENROCKET_SHA256
RUN curl -fsSL -o /OpenRocket.jar \
      "https://github.com/openrocket/openrocket/releases/download/release-${OPENROCKET_VERSION}/OpenRocket-${OPENROCKET_VERSION}.jar" \
 && echo "${OPENROCKET_SHA256}  /OpenRocket.jar" | sha256sum -c -
WORKDIR /src
COPY bridge/src ./src
RUN mkdir out \
 && javac --release 17 -d out -cp /OpenRocket.jar $(find src -name '*.java') \
 && jar cf /liveshare.jar -C out .

FROM eclipse-temurin:17-jre
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      tigervnc-standalone-server tigervnc-tools openbox x11-utils \
      libxext6 libxrender1 libxtst6 libxi6 libxrandr2 libfreetype6 fontconfig \
      libgl1 libgl1-mesa-dri libglx-mesa0 \
      fonts-dejavu-core fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1001 --shell /bin/bash rocketeer
COPY --from=build /OpenRocket.jar /opt/openrocket/OpenRocket.jar
COPY --from=build /liveshare.jar /opt/openrocket/liveshare.jar
COPY rootfs/ /
RUN chmod +x /usr/local/bin/orc-session
USER rocketeer
WORKDIR /home/rocketeer
ENV DISPLAY=:1 \
    ORC_WORKDIR=/home/rocketeer/Projects
EXPOSE 5901
ENTRYPOINT ["/usr/local/bin/orc-session"]
