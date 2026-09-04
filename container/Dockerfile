FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends libjemalloc2 \
    && ln -s "$(find /usr/lib -name libjemalloc.so.2 -print -quit)" /usr/local/lib/libjemalloc.so.2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false \
    && npm cache clean --force
COPY *.ts ./

ENV NODE_ENV=production \
    PORT=8080 \
    VIPS_CONCURRENCY=1 \
    UV_THREADPOOL_SIZE=2 \
    LD_PRELOAD=/usr/local/lib/libjemalloc.so.2

USER node
EXPOSE 8080
CMD ["node", "server.ts"]
