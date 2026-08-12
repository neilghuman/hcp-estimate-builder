# Docker Production Deployment Guide

**Production Server IP:** `10.0.10.102`  
**Public Access:** `http://10.0.10.102:8123`

---

## Prerequisites

- Docker & Docker Compose installed on the production server (10.0.10.102)
- PostgreSQL credentials set in `.env.production`
- N8N webhook running on port 5678 (if using n8n estimate creation)
- Ollama running on port 11434 (for AI-powered search descriptions)

---

## Deployment Steps

### 1. On Your Local Machine (Development)

Everything is already committed. Just verify:

```bash
cd C:\Projects\hcp-estimate-builder
git status  # Should show clean working tree
```

The following files are ready for deployment:
- `Dockerfile` – Alpine Node.js 20 image, optimized
- `docker-compose.yml` – Updated with network isolation, health checks, and proper container linking
- `.env.production` – Production environment variables
- `public/` – Frontend assets
- `src/` – Backend services

### 2. Transfer to Production Server

Option A: Clone from Git (Recommended)
```bash
ssh user@10.0.10.102
cd /opt  # or your preferred path
git clone https://github.com/neilghuman/projects-backup.git hcp-estimate-builder
cd hcp-estimate-builder
```

Option B: Direct File Transfer (SCP/rsync)
```bash
rsync -av C:\Projects\hcp-estimate-builder\ user@10.0.10.102:/opt/hcp-estimate-builder/
```

### 3. On Production Server (10.0.10.102)

```bash
cd /opt/hcp-estimate-builder  # or your installation path

# Copy production environment file
cp .env.production .env

# Update database password (SECURITY CRITICAL)
nano .env  # Edit DB_PASSWORD to something strong
# OR
sed -i 's/scopepass_prod/YOUR_STRONG_PASSWORD/g' .env

# Build and start containers
docker-compose up -d

# Verify containers are running
docker-compose ps

# Check logs
docker-compose logs -f estimate-builder
docker-compose logs -f postgres
```

### 4. Verify Deployment

```bash
# Check application is running
curl http://10.0.10.102:8123/

# Check database connectivity
docker-compose exec estimate-builder curl http://localhost:8123/api/health

# Check PostgreSQL is ready
docker-compose exec postgres pg_isready -U scopeuser -d scopefoundry
```

---

## Container Architecture

```
┌─────────────────────────────────────────────────────────┐
│         Docker Network: estimate-network               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────────┐         ┌──────────────────┐    │
│  │ estimate-builder │         │    postgres      │    │
│  │  (Node.js API)   │────────▶│   (Database)     │    │
│  │   Port: 8123     │         │   Port: 5432     │    │
│  │                  │         │                  │    │
│  └──────────────────┘         └──────────────────┘    │
│         │                             │                │
│         │ Exposed to Host             │ Volume mount   │
│         │ via port mapping            │ postgres_data  │
│         │                             │                │
│         ▼                             ▼                │
│   10.0.10.102:8123            /var/lib/postgresql/data
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Environment Variables Explained

| Variable | Purpose | Production Value |
|----------|---------|-------------------|
| `HCP_API_KEY` | Housecall Pro API token | (Your token) |
| `DB_HOST` | Database container name | `postgres` |
| `DB_PASSWORD` | PostgreSQL password | **Change to strong value!** |
| `OLLAMA_API_BASE` | AI model service | `http://10.0.10.102:11434` |
| `N8N_ESTIMATE_WEBHOOK_URL` | N8N webhook (optional) | `http://10.0.10.102:5678/webhook/hcp-estimate-create` |
| `PORT` | App listen port | `8123` |
| `HOST` | Bind address (inside container) | `0.0.0.0` |

---

## Maintenance

### View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f estimate-builder
docker-compose logs -f postgres

# Real-time tail
docker-compose logs -f --tail 100 estimate-builder
```

### Restart Services

```bash
# Restart application only
docker-compose restart estimate-builder

# Restart everything
docker-compose restart

# Full rebuild
docker-compose down
docker-compose up -d --build
```

### Database Backups

```bash
# Backup PostgreSQL database
docker-compose exec postgres pg_dump -U scopeuser scopefoundry > backup.sql

# Restore from backup
docker-compose exec -T postgres psql -U scopeuser scopefoundry < backup.sql
```

### Scaling & Updates

```bash
# Pull latest code updates
git pull origin main

# Rebuild image with latest code
docker-compose up -d --build estimate-builder

# Health check
docker-compose ps
docker-compose logs estimate-builder
```

---

## Troubleshooting

### Container won't start
```bash
docker-compose logs estimate-builder
# Check for:
# - Port 8123 already in use on host
# - Environment variables missing
# - Database connection timeout (postgres not ready)
```

### Database connection fails
```bash
# Verify postgres is running and healthy
docker-compose ps postgres

# Test connection from app container
docker-compose exec estimate-builder node -e "
  const { Pool } = require('pg');
  const pool = new Pool({
    host: 'postgres',
    port: 5432,
    database: 'scopefoundry',
    user: 'scopeuser',
    password: process.env.DB_PASSWORD
  });
  pool.query('SELECT NOW()', (err, res) => {
    console.log(err ? 'FAIL: ' + err.message : 'OK: ' + res.rows[0].now);
    process.exit(0);
  });
"
```

### Port 8123 already in use
```bash
# Find what's using the port
netstat -an | grep 8123

# Change the exposed port in docker-compose.yml
# From: 10.0.10.102:8123:8123
# To:   10.0.10.102:8124:8123  (external:internal)
docker-compose up -d
```

---

## Security Checklist

- [ ] Changed `DB_PASSWORD` to a strong value (20+ chars, mixed case, symbols)
- [ ] Set `HCP_API_KEY` to your actual HCP token (not test/dummy value)
- [ ] Firewall: Only port 8123 is exposed on 10.0.10.102, blocked from internet
- [ ] Review `.env.production` – no test credentials
- [ ] Database volume is persisted (`postgres_data` Docker volume)
- [ ] Container restart policy is `unless-stopped` (auto-restart on crash)
- [ ] Health checks configured for database readiness

---

## Rolling Back

If you need to revert to a previous version:

```bash
cd /opt/hcp-estimate-builder

# Checkout previous commit
git checkout <commit-hash>

# Rebuild and restart
docker-compose down
docker-compose up -d --build
```

---

## Next Steps

1. **Copy `.env.production` to production server** – Update passwords
2. **Run `docker-compose up -d`** on the production server
3. **Verify with `curl http://10.0.10.102:8123/`**
4. **Test full workflow** – Create estimate, search pricebook, submit to HCP
5. **Monitor logs** – `docker-compose logs -f` for any errors

---

## Support

For issues or questions, check:
- `docker-compose logs` for error details
- `server.js` for backend logic
- `public/app.js` for frontend behavior
- `src/` directory for service implementations
