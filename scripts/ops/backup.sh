#!/bin/sh
# Pause application writes; PostgreSQL remains up for a consistent dump.
set -eu
cd "$(dirname "$0")/../.."
# Optional library selection: MINDSYNC_LIBRARY=<name> targets that library.
# Otherwise use the default Compose project for single-library compatibility.
# Deployment files live in docker/; a library env file may override COMPOSE_FILE
# with a colon-separated list to layer the combined or RAG overlays.
COMPOSE_FILE=${COMPOSE_FILE:-docker/compose.yaml}
export COMPOSE_FILE
compose() {
    if [ -n "${MINDSYNC_LIBRARY:-}" ]; then
        envfile="library/$MINDSYNC_LIBRARY.env"
        if [ ! -f "$envfile" ]; then
            echo "Error: $envfile was not found" >&2
            return 1
        fi
        project=$(grep -E '^MINDSYNC_PROJECT=' "$envfile" | cut -d= -f2 || true)
        if [ -z "$project" ]; then
            project="mindsync-$MINDSYNC_LIBRARY"
        fi
        profile=$(grep -E '^COMPOSE_FILE=' "$envfile" | cut -d= -f2- || true)
        if [ -n "$profile" ]; then
            COMPOSE_FILE=$profile
            export COMPOSE_FILE
        fi
        docker compose -p "$project" --env-file "$envfile" "$@"
    else
        docker compose "$@"
    fi
}
DEST=${1:-./backups/$(date +%Y%m%d-%H%M%S)}
mkdir -p "$DEST"
chmod 700 "$DEST"
if [ -e "$DEST/COMPLETE" ] || [ -e "$DEST/database.dump" ]; then
  echo 'Destination must be unused.' >&2
  exit 1
fi
WAS_RUNNING=$(compose ps --status running -q mindsync)
resume() {
  if [ -n "$WAS_RUNNING" ]; then
    compose start mindsync >/dev/null
  fi
}
trap resume EXIT
trap 'exit 130' HUP INT TERM
compose stop mindsync >/dev/null
compose exec -T postgres pg_dump -U mindsync -d mindsync -Fc > "$DEST/database.dump"
compose run --rm -T --no-deps --entrypoint tar mindsync -czf - -C /data objects > "$DEST/objects.tar.gz"
(cd "$DEST" && if command -v sha256sum >/dev/null 2>&1; then sha256sum database.dump objects.tar.gz; else shasum -a 256 database.dump objects.tar.gz; fi > checksums.sha256)
printf 'mindsync-backup-v1\n' > "$DEST/COMPLETE"
echo "Backup complete: $DEST (credentials are not included)."
