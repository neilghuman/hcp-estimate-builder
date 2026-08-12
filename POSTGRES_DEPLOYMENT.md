# ScopeFoundry Postgres Deployment Guide

## Quick Start

### Option 1: Deploy on Remote Docker Host (Recommended)

If you have SSH access to 10.0.10.102:

```bash
# Copy files to remote host
scp docker-compose.remote.yml user@10.0.10.102:~/scopefoundry/
scp -r migrations user@10.0.10.102:~/scopefoundry/

# SSH into remote host
ssh user@10.0.10.102

# Navigate and start
cd ~/scopefoundry
mkdir -p migrations
# Copy the migration file contents here

# Then run:
docker-compose -f docker-compose.remote.yml up -d postgres
```

### Option 2: Manual Deployment on Remote Host

1. **SSH into 10.0.10.102** (using your preferred method)

2. **Create directory and files:**
   ```bash
   mkdir -p ~/scopefoundry/migrations
   cd ~/scopefoundry
   ```

3. **Copy `docker-compose.remote.yml` contents** into `~/scopefoundry/docker-compose.yml`

4. **Copy migration file** contents into `~/scopefoundry/migrations/001_create_pricebook.sql`
   
5. **Start Postgres:**
   ```bash
   docker-compose up -d postgres
   docker-compose logs postgres -f
   ```

6. **Verify connection:**
   ```bash
   docker exec scopefoundry-db psql -U scopeuser -d scopefoundry -c "SELECT version();"
   ```

### Option 3: Alternative - Use Inside Docker Network

If you want ScopeFoundry to also run in Docker on the remote host:

```bash
# Edit docker-compose.remote.yml to add scopefoundry service
# Set DB_HOST=postgres (Docker hostname)
docker-compose -f docker-compose.remote.yml up -d
```

---

## Access from Windows (ScopeFoundry)

Once Postgres is running on remote host, update `.env`:

```env
DB_HOST=10.0.10.102
DB_PORT=5432
DB_NAME=scopefoundry
DB_USER=scopeuser
DB_PASSWORD=scopepass_dev
```

Then test connection:

```powershell
$user = "scopeuser"
$pass = "scopepass_dev"
$db = "scopefoundry"
$host = "10.0.10.102"

$connectionString = "Server=$host;Port=5432;Database=$db;User Id=$user;Password=$pass;"
Write-Host "Connection string: $connectionString"

# If psql is installed:
# psql -h $host -U $user -d $db
```

---

## Verification

Once deployed, test with:

```powershell
# From Windows, test connectivity
Test-NetConnection -ComputerName 10.0.10.102 -Port 5432

# If working:
$result = Invoke-WebRequest -Uri http://127.0.0.1:8123/api/pricebook -Method GET
$result.Content | ConvertFrom-Json | ConvertTo-Json -Depth 3
```

---

## Connection Details

| Property | Value |
|----------|-------|
| **Host** | 10.0.10.102 |
| **Port** | 5432 |
| **Database** | scopefoundry |
| **User** | scopeuser |
| **Password** | scopepass_dev |
| **Container** | scopefoundry-db |

---

## Troubleshooting

### Can't connect from Windows?

1. Check port is exposed: `docker ps | grep scopefoundry-db`
2. Verify binding: `docker port scopefoundry-db 5432`
3. Check firewall on remote host

### Postgres won't start?

```bash
# Check logs
docker-compose logs postgres

# Try removing and recreating
docker-compose down
docker volume rm scopefoundry_postgres_data
docker-compose up postgres
```

### Tables not created?

Migration file is automatically run on first startup. If needed manually:

```bash
docker exec scopefoundry-db psql -U scopeuser -d scopefoundry \
  < ./migrations/001_create_pricebook.sql
```

---

## What's Next?

1. **Verify connection** in ScopeFoundry UI
2. **Sync pricebook:** `curl -X POST http://127.0.0.1:8123/api/pricebook/sync`
3. **Download template:** `curl http://127.0.0.1:8123/api/template/download -o template.xlsx`

