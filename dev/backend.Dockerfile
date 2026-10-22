FROM rust:1.96-bookworm
WORKDIR /workspace/server
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
COPY server/migrations ./migrations
CMD ["sh", "-c", "cargo build --locked --features dev-assets && exec /cargo-target/debug/mindsync-server"]
