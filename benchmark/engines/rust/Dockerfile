FROM rust:1-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked
FROM debian:bookworm-slim
COPY --from=build /build/target/release/imgt-engine-benchmark /usr/local/bin/engine
COPY --from=build /build/Cargo.lock /engine-Cargo.lock
CMD ["/usr/local/bin/engine"]
