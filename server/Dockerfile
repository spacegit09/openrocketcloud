ARG OPENROCKET_VERSION=24.12
ARG OPENROCKET_SHA256=4959b72f52f5f607941e9722abbb7b7f0c4a38ebbbf84204a329db9f31c4f897

# OpenRocket's own example designs, offered as "New design > From an example".
FROM --platform=$BUILDPLATFORM alpine:3.22 AS examples
ARG OPENROCKET_VERSION
ARG OPENROCKET_SHA256
RUN apk add --no-cache curl unzip \
 && curl -fsSL -o /or.jar "https://github.com/openrocket/openrocket/releases/download/release-${OPENROCKET_VERSION}/OpenRocket-${OPENROCKET_VERSION}.jar" \
 && echo "${OPENROCKET_SHA256}  /or.jar" | sha256sum -c - \
 && mkdir /examples && unzip -j /or.jar 'datafiles/examples/*.ork' -d /examples

FROM --platform=$BUILDPLATFORM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-slim
ENV NODE_ENV=production DATA_DIR=/data NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY templates ./templates
COPY --from=examples /examples ./templates/examples
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
