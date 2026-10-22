FROM rust:1.96-bookworm AS builder
WORKDIR /build
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
COPY server/migrations ./migrations
ARG CARGO_BUILD_JOBS=1
RUN --mount=type=cache,id=mindsync-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=mindsync-cargo-target,target=/build/target,sharing=locked \
    cargo build --release --locked --jobs "$CARGO_BUILD_JOBS" \
    && cp target/release/mindsync-server /build/mindsync-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 mindsync && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin mindsync \
    && mkdir /data && chown 10001:10001 /data
COPY --from=builder /build/mindsync-server /usr/local/bin/mindsync-server
USER 10001:10001
ENV MINDSYNC_DATA=/data MINDSYNC_PORT=8080 MINDSYNC_MAX_FILE_BYTES=52428800
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD curl -fsS "http://127.0.0.1:${MINDSYNC_PORT}/health" || exit 1
ENTRYPOINT ["mindsync-server"]
