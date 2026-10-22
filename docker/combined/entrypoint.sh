#!/bin/bash
set -uo pipefail

# Keep operator recovery commands compatible with the backend image.
if (( $# )); then
    exec mindsync-server "$@"
fi
: "${MINDSYNC_HTTPS_DOMAIN:?Set the public HTTPS domain}"
: "${ALIYUN_ACCESS_KEY_ID:?Set the DNS access key ID}"
: "${ALIYUN_ACCESS_KEY_SECRET:?Set the DNS access key secret}"

children=()
shutdown() {
    trap '' TERM INT
    if (( ${#children[@]} )); then
        kill -TERM "${children[@]}" 2>/dev/null || true
        for child in "${children[@]}"; do
            wait "$child" 2>/dev/null || true
        done
    fi
}
trap 'shutdown; exit 0' TERM INT

# DNS and the backend listen only inside this container.
dnsproxy --listen=127.0.0.1 --port=53535 \
    --upstream=https://1.1.1.1/dns-query \
    --upstream=https://8.8.8.8/dns-query \
    --upstream-mode=parallel --timeout=10s &
children+=("$!")
mindsync-server &
children+=("$!")
caddy run --config /etc/mindsync/Caddyfile --adapter caddyfile &
children+=("$!")

# Exit as a unit so the container restart policy also covers either helper.
wait -n "${children[@]}"
status=$?
printf 'A MindSync service exited; stopping the container.\n' >&2
shutdown
if (( status == 0 )); then status=1; fi
exit "$status"
