#!/bin/sh
set -eu
curl --fail --silent --show-error --noproxy '*' --max-time 4 \
    --resolve "${MINDSYNC_HTTPS_DOMAIN}:${MINDSYNC_HTTPS_PORT:-8080}:127.0.0.1" \
    "https://${MINDSYNC_HTTPS_DOMAIN}:${MINDSYNC_HTTPS_PORT:-8080}/health"
