#!/usr/bin/env bash
# Configure ScopeFoundry on 10.0.10.102 (GUI + AI svc), aitop Ollama, existing DB.
# Idempotent. Does NOT print secret values.
set -euo pipefail
HCP=/opt/hcp-estimate-builder
SFAI=/opt/scopefoundry-ai
ts=$(date +%s)

set_kv() {
  local f=$1 k=$2 v=$3
  if grep -q "^$k=" "$f"; then
    sed -i "s|^$k=.*|$k=$v|" "$f"
  else
    echo "$k=$v" >> "$f"
  fi
}

# 1. Patch GUI .env: direct provider, aitop Ollama, point at AI svc by container DNS
cp "$HCP/.env" "$HCP/.env.bak.$ts"
set_kv "$HCP/.env" ESTIMATE_CREATE_PROVIDER direct
set_kv "$HCP/.env" OLLAMA_API_BASE http://10.0.10.44:11434
set_kv "$HCP/.env" OLLAMA_MODEL llama3.1:latest
set_kv "$HCP/.env" SCOPEFOUNDRY_AI_BASE http://scopefoundry-ai:8200

# 2. Pin postgres image to pgvector so compose up does NOT recreate the DB as alpine
cp "$HCP/docker-compose.yml" "$HCP/docker-compose.yml.bak.$ts"
sed -i 's|image: postgres:16-alpine|image: pgvector/pgvector:pg16|' "$HCP/docker-compose.yml"

# 3. Build AI svc .env from the GUI's DB creds (no secret echo)
src="$HCP/.env"
get() { grep "^$1=" "$src" | head -1 | cut -d= -f2-; }
DB_PASSWORD=$(get DB_PASSWORD); DB_USER=$(get DB_USER); DB_NAME=$(get DB_NAME); DB_PORT=$(get DB_PORT)
cat > "$SFAI/.env" <<EOF
DB_HOST=scopefoundry-db
DB_PORT=${DB_PORT:-5432}
DB_NAME=${DB_NAME:-scopefoundry}
DB_USER=${DB_USER:-scopeuser}
DB_PASSWORD=${DB_PASSWORD}
OLLAMA_MODEL=llama3.1:latest
OLLAMA_KEEP_ALIVE=30m
QA_THRESHOLD=90
QA_MIN_SUBSCORE=85
QA_MAX_ITERATIONS=3
EOF
chmod 600 "$SFAI/.env"

# 4. Write AI svc compose for .102: aitop Ollama + existing estimate-network + DB
cat > "$SFAI/docker-compose.yml" <<'EOF'
services:
  scopefoundry-ai:
    build: .
    image: scopefoundry-ai:latest
    container_name: scopefoundry-ai
    restart: unless-stopped
    env_file: .env
    environment:
      OLLAMA_BASE: http://10.0.10.44:11434
      OLLAMA_MODEL: ${OLLAMA_MODEL:-llama3.1:latest}
      OLLAMA_KEEP_ALIVE: ${OLLAMA_KEEP_ALIVE:-30m}
      PORT: "8200"
      DB_HOST: ${DB_HOST:-scopefoundry-db}
      DB_PORT: ${DB_PORT:-5432}
      DB_NAME: ${DB_NAME:-scopefoundry}
      DB_USER: ${DB_USER:-scopeuser}
      DB_PASSWORD: ${DB_PASSWORD:-}
    ports:
      - "127.0.0.1:8200:8200"
    networks:
      - estimate-network
networks:
  estimate-network:
    external: true
    name: hcp-estimate-builder_estimate-network
EOF

echo "=== GUI .env (redacted) ==="
sed -E 's/=.*/=<set>/' "$HCP/.env" | grep -E 'PROVIDER|OLLAMA_API_BASE|OLLAMA_MODEL|SCOPEFOUNDRY_AI_BASE|DB_HOST'
echo "=== GUI compose image lines ==="
grep -n 'image:' "$HCP/docker-compose.yml"
echo "=== AI svc .env keys (redacted) ==="
sed -E 's/=.*/=<set>/' "$SFAI/.env"
echo "CONFIG_DONE"
