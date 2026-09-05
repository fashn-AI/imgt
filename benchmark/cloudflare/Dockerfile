FROM node:24-bookworm-slim AS bundle
WORKDIR /app
COPY container/package*.json ./
RUN npm ci && npm install --no-save @img/sharp-libvips-dev@1.3.3

FROM bundle AS build-native
RUN apt-get update && apt-get install -y --no-install-recommends g++ && rm -rf /var/lib/apt/lists/*
COPY benchmark/engines/native.cpp ./
RUN set -eu; bundle_dir=$(find node_modules/@img -maxdepth 1 -type d -name 'sharp-libvips-linux-*' | head -1); \
    g++ -O3 -std=c++17 native.cpp -o /app/native \
      -I node_modules/@img/sharp-libvips-dev/include \
      -I node_modules/@img/sharp-libvips-dev/include/glib-2.0 \
      -I "$bundle_dir/lib/glib-2.0/include" \
      "$bundle_dir/lib/libvips-cpp.so.8.18.6" -pthread \
      -Wl,-rpath,"/app/$bundle_dir/lib"

FROM bundle
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 && \
    ln -s "$(find /usr/lib -name libjemalloc.so.2 -print -quit)" /usr/local/lib/libjemalloc.so.2 && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build-native /app/native /app/native
COPY container/*.ts ./
COPY benchmark/cloudflare/container.ts ./lab.ts
COPY benchmark/engines/optimized.ts ./optimized.ts
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2 VIPS_CONCURRENCY=1 UV_THREADPOOL_SIZE=2
USER node
EXPOSE 8080 8081 8082 8083 8084
CMD ["node", "lab.ts"]
