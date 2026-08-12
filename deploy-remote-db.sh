#!/bin/bash
# Deployment script for ScopeFoundry Postgres on remote Docker host
# Usage: bash deploy-remote-db.sh

set -e

echo "🐘 Deploying ScopeFoundry Postgres..."

# Create directory
mkdir -p ~/scopefoundry/migrations

# Copy docker-compose
cat > ~/scopefoundry/docker-compose.yml << 'EOF'
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    container_name: scopefoundry-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: scopefoundry
      POSTGRES_USER: scopeuser
      POSTGRES_PASSWORD: scopepass_dev
    ports:
      - "0.0.0.0:5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./migrations/001_create_pricebook.sql:/docker-entrypoint-initdb.d/001_create_pricebook.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U scopeuser -d scopefoundry"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  postgres_data:
EOF

# Copy migration file
cat > ~/scopefoundry/migrations/001_create_pricebook.sql << 'EOF'
-- ScopeFoundry Pricebook Table
-- Stores extracted line items from HCP estimates to prevent duplicates

CREATE TABLE IF NOT EXISTS pricebook (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  unit_price BIGINT NOT NULL,
  unit_of_measure TEXT,
  kind TEXT DEFAULT 'labor',
  taxable BOOLEAN DEFAULT FALSE,
  source_estimate_id TEXT,
  usage_count INT DEFAULT 0,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(name, unit_price)
);

CREATE INDEX IF NOT EXISTS idx_pricebook_name ON pricebook (name);
CREATE INDEX IF NOT EXISTS idx_pricebook_last_synced ON pricebook (last_synced_at DESC);
EOF

# Start Postgres
cd ~/scopefoundry
docker-compose up -d postgres

# Wait for health check
echo "⏳ Waiting for Postgres to be ready..."
for i in {1..30}; do
  if docker exec scopefoundry-db pg_isready -U scopeuser -d scopefoundry > /dev/null 2>&1; then
    echo "✅ Postgres is ready!"
    break
  fi
  echo -n "."
  sleep 2
done

echo ""
echo "🎉 ScopeFoundry Postgres deployed!"
echo ""
echo "Connection Details:"
echo "  Host: 0.0.0.0 (localhost from remote, or 10.0.10.102 from Windows)"
echo "  Port: 5432"
echo "  Database: scopefoundry"
echo "  User: scopeuser"
echo "  Password: scopepass_dev"
