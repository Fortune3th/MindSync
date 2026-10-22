#!/bin/sh
# Paste-and-run installer for the NAS. Creates a self-contained Woodpecker
# deployment outside the git repository, so no clone is required on the NAS.
set -eu

DIR=${1:-/vol1/1000/apps/woodpecker}
PORT=${PORT:-8000}

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
command -v openssl >/dev/null || { echo "openssl not found"; exit 1; }

GITEA_CONTAINER=$(docker ps --format '{{.Names}}' | grep -i '^gitea$' | head -1)
if [ -z "$GITEA_CONTAINER" ]; then
  echo "No container named 'gitea'. Containers seen:"
  docker ps --format '  {{.Names}}'
  echo "Set GITEA_CONTAINER and edit the script, or rename the service."
  exit 1
fi

NET=$(docker inspect "$GITEA_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')
if [ -z "$NET" ]; then echo "Could not detect the network of $GITEA_CONTAINER"; exit 1; fi

echo "Gitea container: $GITEA_CONTAINER (network: $NET)"
echo "Create the Gitea OAuth2 application first:"
echo "  Settings -> Applications -> Redirect URI http://<nas-ip>:$PORT/authorize"
echo
printf 'NAS LAN IP or hostname (no scheme): '; read -r NAS_HOST
printf 'Gitea OAuth2 client id: '; read -r CLIENT_ID
printf 'Gitea OAuth2 client secret: '; read -r CLIENT_SECRET
printf 'Your Gitea username: '; read -r ADMIN_USER

AGENT_SECRET=$(openssl rand -hex 32)
mkdir -p "$DIR"
cd "$DIR"

cat > compose.yaml <<EOF
name: woodpecker

services:
  server:
    image: woodpeckerci/woodpecker-server:v3
    container_name: woodpecker-server
    restart: unless-stopped
    environment:
      WOODPECKER_HOST: http://$NAS_HOST:$PORT
      WOODPECKER_GITEA: "true"
      WOODPECKER_GITEA_URL: http://$GITEA_CONTAINER:3000
      WOODPECKER_GITEA_CLIENT: $CLIENT_ID
      WOODPECKER_GITEA_SECRET: $CLIENT_SECRET
      WOODPECKER_AGENT_SECRET: $AGENT_SECRET
      WOODPECKER_ADMIN: $ADMIN_USER
      WOODPECKER_OPEN: "false"
      WOODPECKER_DATABASE_DRIVER: sqlite3
      WOODPECKER_DATABASE_DATASOURCE: /var/lib/woodpecker/woodpecker.sqlite
    volumes:
      - ./data:/var/lib/woodpecker
    ports:
      - "$PORT:8000"
    networks: [ci, gitea]
    logging:
      driver: json-file
      options: { max-size: 10m, max-file: "3" }

  agent:
    image: woodpeckerci/woodpecker-agent:v3
    container_name: woodpecker-agent
    restart: unless-stopped
    environment:
      WOODPECKER_SERVER: server:9000
      WOODPECKER_AGENT_SECRET: $AGENT_SECRET
      WOODPECKER_MAX_WORKFLOWS: "2"
      WOODPECKER_BACKEND_DOCKER_NETWORK: $NET
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./agent:/etc/woodpecker
    networks: [ci]
    depends_on: [server]
    logging:
      driver: json-file
      options: { max-size: 10m, max-file: "3" }

networks:
  ci: {}
  gitea:
    external: true
    name: $NET
EOF

docker compose up -d
sleep 5

echo
echo "--- containers ---"
docker compose ps
echo
echo "--- health ---"
curl -fsS "http://127.0.0.1:$PORT/healthz" || echo "healthz not reachable from this shell yet"
echo
echo "--- agent ---"
docker logs woodpecker-agent 2>&1 | tail -10
echo
echo "Open http://$NAS_HOST:$PORT and log in with Gitea."
echo "Then: Repositories -> Add repository -> enable MindSync."
echo "Data lives in $DIR (compose.yaml is not in git)."
