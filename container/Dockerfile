FROM node:24-bookworm-slim AS native
WORKDIR /bundle
COPY package.json package-lock.json renderer.ts ./
RUN npm ci --omit=dev --ignore-scripts=false \
    && mkdir /native \
    && cp -r node_modules/@img/sharp-libvips-linux-*/lib/* /native/ \
    && node --input-type=module -e 'import { RENDERER_VERSION } from "./renderer.ts"; import { writeFileSync } from "node:fs"; writeFileSync("/native/renderer-version", RENDERER_VERSION)'

FROM rust:1.90.0-bookworm AS build
COPY --from=native /native /native
WORKDIR /src
COPY rust/Cargo.toml rust/Cargo.lock ./
COPY rust/src ./src
ARG IMGT_TEST_FEATURES=""
ENV CARGO_BUILD_JOBS=2 \
    RUSTFLAGS="-C link-arg=-Wl,-rpath,/native -C link-arg=/native/libvips-cpp.so.8.18.7"
RUN IMGT_RENDERER_VERSION=$(cat /native/renderer-version) cargo build --locked --release --features "$IMGT_TEST_FEATURES"

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 libatomic1 libjemalloc2 ca-certificates \
    && ln -s "$(find /usr/lib -name libjemalloc.so.2 -print -quit)" /usr/local/lib/libjemalloc.so.2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 imgt \
    && useradd --uid 1000 --gid imgt --create-home imgt
COPY --from=build /src/target/release/imgt-container /server
COPY --from=build /native /native
ENV PORT=8080 \
    VIPS_CONCURRENCY=1 \
    LD_PRELOAD=/usr/local/lib/libjemalloc.so.2
USER imgt
EXPOSE 8080
CMD ["/server"]
