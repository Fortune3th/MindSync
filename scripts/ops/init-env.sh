#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
if [ -e .env ]; then
  echo '.env already exists; keeping existing credentials.'
  exit 0
fi
umask 077
DB_SECRET=$(openssl rand -hex 32)
AUTH_SECRET=$(openssl rand -hex 32)
{
  printf 'MINDSYNC_AUTH_SECRET=%s\n' "$AUTH_SECRET"
  printf 'MINDSYNC_OWNER_EMAIL=you@example.com\n'
  printf 'MINDSYNC_PUBLIC_ORIGIN=https://notes.example.com\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$DB_SECRET"
  printf 'MINDSYNC_BIND_ADDRESS=127.0.0.1\nMINDSYNC_PORT=8080\nMINDSYNC_MAX_FILE_BYTES=52428800\n'
} > .env
unset DB_SECRET AUTH_SECRET
echo 'Created .env with random credentials. Set MINDSYNC_BIND_ADDRESS to the NAS LAN IP for LAN access.'
