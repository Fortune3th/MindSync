#!/bin/sh
# Restore only into an empty Compose project; never overwrite existing notes.
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
SOURCE=${1:?Usage: scripts/restore.sh BACKUP_DIRECTORY}
[ -f "$SOURCE/COMPLETE" ] && { [ "$(cat "$SOURCE/COMPLETE")" = 'mindsync-backup-v1' ] || [ "$(cat "$SOURCE/COMPLETE")" = 'nas-sync-backup-v1' ]; }
(cd "$SOURCE" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c checksums.sha256; else shasum -a 256 -c checksums.sha256; fi)
if [ -n "$(compose ps --status running -q mindsync)" ]; then
  echo 'Stop the sync service before restoring; use a fresh Compose project.' >&2
  exit 1
fi
compose up -d postgres --wait >/dev/null
COUNT=$(compose exec -T postgres psql -U mindsync -d mindsync -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
if [ "$COUNT" != '0' ]; then
  echo 'Target database is not empty. Restore to a fresh COMPOSE_PROJECT_NAME.' >&2
  exit 1
fi
# Ensure the object root has no existing objects before unpacking.
compose run --rm -T --no-deps --entrypoint sh mindsync -ec '[ ! -d /data/objects ] || [ -z "$(find /data/objects -mindepth 1 -print -quit)" ]'
compose run --rm -T --no-deps --entrypoint tar mindsync -xzf - -C /data < "$SOURCE/objects.tar.gz"
compose exec -T postgres pg_restore -U mindsync -d mindsync --no-owner --exit-on-error < "$SOURCE/database.dump"
# A restore starts a new history branch. Rotate identity before any client can
# connect, even if later writes reuse the pre-restore revision numbers.
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U mindsync -d mindsync -c 'UPDATE vault SET id=gen_random_uuid()::text WHERE singleton' >/dev/null
compose up -d --wait >/dev/null
echo 'Restore complete. The sync service rebuilt its readable file tree.'
