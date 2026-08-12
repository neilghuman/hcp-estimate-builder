#!/usr/bin/env pwsh
# ============================================================================
# HCP Estimate Builder - Local Development Deploy Script (Windows)
# Usage: .\deploy.ps1 -Mode [dev|docker]
# ============================================================================

param(
    [ValidateSet("dev", "docker")]
    [string]$Mode = "docker"
)

$ErrorActionPreference = "Stop"

# Color codes
$Success = "✓"
$Error = "✗"
$Warning = "⚠"
$Info = "ℹ"

function Write-Header {
    param([string]$Text)
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host $Text -ForegroundColor Blue
    Write-Host "============================================================================" -ForegroundColor Blue
}

function Write-Success {
    param([string]$Text)
    Write-Host "$Success $Text" -ForegroundColor Green
}

function Write-Error-Custom {
    param([string]$Text)
    Write-Host "$Error $Text" -ForegroundColor Red
}

function Write-Warning-Custom {
    param([string]$Text)
    Write-Host "$Warning $Text" -ForegroundColor Yellow
}

function Write-Info {
    param([string]$Text)
    Write-Host "$Info $Text" -ForegroundColor Cyan
}

# Check if Docker is installed
function Test-Docker {
    try {
        docker --version | Out-Null
        Write-Success "Docker is installed"
        return $true
    }
    catch {
        Write-Error-Custom "Docker is not installed or not in PATH"
        return $false
    }
}

# Check if Docker is running
function Test-DockerRunning {
    try {
        docker ps | Out-Null
        Write-Success "Docker daemon is running"
        return $true
    }
    catch {
        Write-Error-Custom "Docker daemon is not running"
        return $false
    }
}

# Build Docker image
function Build-DockerImage {
    Write-Header "Building Docker Image"
    Write-Info "Building image for local development..."
    
    try {
        docker-compose build
        Write-Success "Docker image built successfully"
    }
    catch {
        Write-Error-Custom "Failed to build Docker image: $_"
        exit 1
    }
}

# Start Docker containers
function Start-DockerContainers {
    Write-Header "Starting Docker Containers"
    Write-Info "Starting containers..."
    
    try {
        docker-compose up -d
        Write-Success "Containers started"
    }
    catch {
        Write-Error-Custom "Failed to start containers: $_"
        exit 1
    }
}

# Wait for services to be healthy
function Wait-ForHealth {
    Write-Header "Waiting for Services to Be Healthy"
    
    Write-Info "Waiting for database to be ready..."
    $MaxAttempts = 30
    $Attempt = 0
    
    while ($Attempt -lt $MaxAttempts) {
        try {
            $result = docker-compose exec -T postgres pg_isready -U scopeuser -d scopefoundry 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Database is ready"
                break
            }
        }
        catch { }
        
        $Attempt++
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 1
    }
    
    if ($Attempt -eq $MaxAttempts) {
        Write-Error-Custom "Database failed to start within timeout"
        docker-compose logs postgres
        exit 1
    }
    
    Write-Info "Waiting for application to be ready..."
    $Attempt = 0
    
    while ($Attempt -lt $MaxAttempts) {
        try {
            $response = curl -s -m 2 "http://localhost:8123/" -ErrorAction SilentlyContinue
            if ($response) {
                Write-Success "Application is ready"
                break
            }
        }
        catch { }
        
        $Attempt++
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 1
    }
    
    if ($Attempt -eq $MaxAttempts) {
        Write-Warning-Custom "Application did not respond within timeout (check: docker-compose logs -f estimate-builder)"
    }
}

# Verify deployment
function Verify-Deployment {
    Write-Header "Verifying Deployment"
    
    Write-Info "Container status:"
    docker-compose ps
    
    Write-Info "`nTesting application endpoint..."
    try {
        $response = curl -s -m 2 "http://localhost:8123/" -ErrorAction SilentlyContinue
        if ($response) {
            Write-Success "Application is accessible at http://localhost:8123"
        }
        else {
            Write-Warning-Custom "Application endpoint did not respond"
        }
    }
    catch {
        Write-Warning-Custom "Could not reach application endpoint"
    }
}

# Start Node server locally (for dev mode)
function Start-LocalServer {
    Write-Header "Starting Local Node Server"
    Write-Info "Starting server on http://localhost:8123..."
    
    try {
        Set-Location "C:\Projects\hcp-estimate-builder"
        npm start
    }
    catch {
        Write-Error-Custom "Failed to start server: $_"
        exit 1
    }
}

# Print summary
function Print-Summary {
    Write-Header "Deployment Complete"
    Write-Host ""
    Write-Host "Status: " -NoNewline
    Write-Host "SUCCESS" -ForegroundColor Green
    Write-Host ""
    
    if ($Mode -eq "docker") {
        Write-Host "Application URL:  " -NoNewline
        Write-Host "http://localhost:8123" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Useful commands:"
        Write-Host "  View logs:       " -NoNewline
        Write-Host "docker-compose logs -f" -ForegroundColor Cyan
        Write-Host "  Restart app:     " -NoNewline
        Write-Host "docker-compose restart estimate-builder" -ForegroundColor Cyan
        Write-Host "  Stop services:   " -NoNewline
        Write-Host "docker-compose down" -ForegroundColor Cyan
        Write-Host ""
    }
}

# Main function
function Main {
    Set-Location "C:\Projects\hcp-estimate-builder"
    
    Write-Header "HCP Estimate Builder - Deployment Script"
    Write-Host "Mode: $Mode" -ForegroundColor Cyan
    Write-Host ""
    
    if ($Mode -eq "docker") {
        if (-not (Test-Docker)) { exit 1 }
        if (-not (Test-DockerRunning)) { exit 1 }
        
        Build-DockerImage
        Start-DockerContainers
        Wait-ForHealth
        Verify-Deployment
        Print-Summary
    }
    else {
        Write-Info "Starting development server..."
        Start-LocalServer
    }
}

# Run
Main
