FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false
COPY *.ts build.mjs ./
RUN node build.mjs

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 libatomic1 libjemalloc2 ca-certificates \
    && ln -s "$(find /usr/lib -name libjemalloc.so.2 -print -quit)" /usr/local/lib/libjemalloc.so.2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --create-home node

COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=dependencies /app/dist/*.js ./

ENV NODE_ENV=production \
    PORT=8080 \
    VIPS_CONCURRENCY=1 \
    UV_THREADPOOL_SIZE=2 \
    LD_PRELOAD=/usr/local/lib/libjemalloc.so.2

USER node
EXPOSE 8080
CMD ["node", "server.js"]
