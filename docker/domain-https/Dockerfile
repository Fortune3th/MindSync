FROM caddy:2.11.7-builder AS builder
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOMAXPROCS=2
RUN --mount=type=cache,id=mindsync-go-mod,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,id=mindsync-go-build,target=/root/.cache/go-build,sharing=locked \
    xcaddy build v2.11.7 \
    --with github.com/caddy-dns/alidns@c8c945ded9ace193e86f063842ba59981b35146b

FROM caddy:2.11.7-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
