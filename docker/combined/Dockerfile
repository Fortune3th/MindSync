ARG MINDSYNC_BACKEND_IMAGE=mindsync-backend:latest
ARG MINDSYNC_CADDY_IMAGE=mindsync-caddy:latest
FROM ${MINDSYNC_CADDY_IMAGE} AS caddy
FROM adguard/dnsproxy:v0.86.0@sha256:4d65bafbf246b206a1af35d4263a86c35451d957458c7836304199f1cd2c1535 AS dns
FROM ${MINDSYNC_BACKEND_IMAGE}
USER root
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY --from=dns /opt/dnsproxy/dnsproxy /usr/local/bin/dnsproxy
# Recreate copied executables without file capabilities; all listeners use high ports.
RUN cp --no-preserve=all /usr/local/bin/caddy /tmp/caddy \
    && cp --no-preserve=all /usr/local/bin/dnsproxy /tmp/dnsproxy \
    && mv /tmp/caddy /usr/local/bin/caddy \
    && mv /tmp/dnsproxy /usr/local/bin/dnsproxy \
    && chmod 755 /usr/local/bin/caddy /usr/local/bin/dnsproxy \
    && mkdir -p /var/lib/mindsync-tls /var/lib/mindsync-tls-config \
    && chown 10001:10001 /var/lib/mindsync-tls /var/lib/mindsync-tls-config
COPY docker/combined/Caddyfile /etc/mindsync/Caddyfile
COPY --chmod=755 docker/combined/entrypoint.sh /usr/local/bin/mindsync-entrypoint
COPY --chmod=755 docker/combined/healthcheck.sh /usr/local/bin/mindsync-healthcheck
USER 10001:10001
ENV MINDSYNC_PORT=18080 MINDSYNC_LISTEN_ADDRESS=127.0.0.1 \
    MINDSYNC_HTTPS_PORT=8080 MINDSYNC_TRUSTED_PROXIES=127.0.0.1 \
    XDG_DATA_HOME=/var/lib/mindsync-tls XDG_CONFIG_HOME=/var/lib/mindsync-tls-config
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["mindsync-healthcheck"]
ENTRYPOINT ["mindsync-entrypoint"]
