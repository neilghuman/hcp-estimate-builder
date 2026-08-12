# ScopeFoundry Postgres Connection Helper
# Run this after Postgres is deployed on 10.0.10.102:5432

param(
  [string]$Host = "10.0.10.102",
  [int]$Port = 5432,
  [string]$Database = "scopefoundry",
  [string]$User = "scopeuser",
  [string]$Password = "scopepass_dev"
)

Write-Host "🐘 ScopeFoundry Postgres Connection Helper" -ForegroundColor Cyan
Write-Host ""

# Test 1: Network connectivity
Write-Host "1️⃣  Testing network connectivity to $Host`:$Port..."
$result = Test-NetConnection -ComputerName $Host -Port $Port -WarningAction SilentlyContinue
if ($result.TcpTestSucceeded) {
  Write-Host "   ✅ Port $Port is reachable" -ForegroundColor Green
} else {
  Write-Host "   ❌ Cannot reach port $Port" -ForegroundColor Red
  Write-Host "   Check if Postgres is running and port is exposed." -ForegroundColor Yellow
  exit 1
}

# Test 2: Postgres connection (if psql available)
Write-Host ""
Write-Host "2️⃣  Attempting Postgres connection..."
$env:PGPASSWORD = $Password
$connectionTest = & psql -h $Host -U $User -d $Database -c "SELECT version();" 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Host "   ✅ Connected successfully!" -ForegroundColor Green
  Write-Host "   Server: $($connectionTest[0])" -ForegroundColor Cyan
} else {
  if ($null -eq (Get-Command psql -ErrorAction SilentlyContinue)) {
    Write-Host "   ⚠️  psql not found, skipping this check" -ForegroundColor Yellow
  } else {
    Write-Host "   ❌ Connection failed" -ForegroundColor Red
    Write-Host "   Error: $connectionTest" -ForegroundColor Yellow
  }
}

# Test 3: ScopeFoundry API connectivity
Write-Host ""
Write-Host "3️⃣  Testing ScopeFoundry API..."
try {
  $apiResult = Invoke-WebRequest -Uri "http://127.0.0.1:8123/api/pricebook" -TimeoutSec 5 -ErrorAction Stop
  $pricebook = $apiResult.Content | ConvertFrom-Json
  Write-Host "   ✅ ScopeFoundry API is working" -ForegroundColor Green
  Write-Host "   Pricebook items: $($pricebook.count)" -ForegroundColor Cyan
} catch {
  Write-Host "   ❌ ScopeFoundry API unavailable" -ForegroundColor Red
  Write-Host "   Make sure server is running on 127.0.0.1:8123" -ForegroundColor Yellow
}

# Test 4: Configuration
Write-Host ""
Write-Host "4️⃣  Current Configuration:" -ForegroundColor Cyan
$config = @{
  "Host" = $Host
  "Port" = $Port
  "Database" = $Database
  "User" = $User
  "Password" = "***hidden***"
}
$config | Format-Table -AutoSize

# Test 5: .env file check
Write-Host ""
Write-Host "5️⃣  Checking .env configuration..."
if (Test-Path ".env") {
  $envContent = Get-Content ".env" | Select-String "DB_"
  if ($envContent) {
    Write-Host "   ✅ .env has DB settings:" -ForegroundColor Green
    $envContent | ForEach-Object { Write-Host "      $_" -ForegroundColor Cyan }
  } else {
    Write-Host "   ⚠️  No DB settings in .env" -ForegroundColor Yellow
    Write-Host "   Add these lines to .env:" -ForegroundColor Yellow
    Write-Host "      DB_HOST=$Host" -ForegroundColor Cyan
    Write-Host "      DB_PORT=$Port" -ForegroundColor Cyan
    Write-Host "      DB_NAME=$Database" -ForegroundColor Cyan
    Write-Host "      DB_USER=$User" -ForegroundColor Cyan
    Write-Host "      DB_PASSWORD=$Password" -ForegroundColor Cyan
  }
} else {
  Write-Host "   ❌ .env file not found" -ForegroundColor Red
}

Write-Host ""
Write-Host "✨ Connection check complete!" -ForegroundColor Cyan
