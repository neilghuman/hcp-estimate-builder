#!/bin/bash
set -e

# ============================================================================
# HCP Estimate Builder - Automated Deployment Script
# Usage: ./deploy.sh [--pull] [--build] [--fresh]
# ============================================================================

REPO_URL="https://github.com/neilghuman/projects-backup.git"
INSTALL_PATH="/opt/hcp-estimate-builder"
PROJECT_DIR="${INSTALL_PATH}/hcp-estimate-builder"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
print_header() {
  echo -e "${BLUE}============================================================================${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}============================================================================${NC}"
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

print_info() {
  echo -e "${BLUE}ℹ $1${NC}"
}

# Check prerequisites
check_prerequisites() {
  print_header "Checking Prerequisites"
  
  if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed"
    exit 1
  fi
  print_success "Docker found"
  
  if ! command -v docker-compose &> /dev/null; then
    print_error "Docker Compose is not installed"
    exit 1
  fi
  print_success "Docker Compose found"
  
  if ! command -v git &> /dev/null; then
    print_error "Git is not installed"
    exit 1
  fi
  print_success "Git found"
}

# Clone or pull repository
setup_repository() {
  print_header "Setting Up Repository"
  
  if [ -d "$PROJECT_DIR" ]; then
    print_info "Repository already exists at $PROJECT_DIR"
    
    if [ "$PULL" = "true" ]; then
      print_info "Pulling latest changes..."
      cd "$PROJECT_DIR"
      git pull origin main
      print_success "Repository updated"
    fi
  else
    print_info "Cloning repository to $INSTALL_PATH..."
    mkdir -p "$INSTALL_PATH"
    cd "$INSTALL_PATH"
    git clone "$REPO_URL" .
    cd hcp-estimate-builder
    print_success "Repository cloned"
  fi
}

# Setup environment file
setup_environment() {
  print_header "Setting Up Environment"
  
  cd "$PROJECT_DIR"
  
  if [ ! -f ".env.production" ]; then
    print_error ".env.production not found in repository"
    exit 1
  fi
  
  if [ ! -f ".env" ]; then
    print_info "Creating .env from .env.production..."
    cp .env.production .env
    print_success ".env created"
    
    print_warning "IMPORTANT: You must update .env with production values:"
    print_warning "  - Change DB_PASSWORD to a strong password"
    print_warning "  - Verify HCP_API_KEY is correct"
    print_warning "  - Check N8N_ESTIMATE_WEBHOOK_URL"
    echo ""
    read -p "Press Enter to continue after updating .env (run: nano .env) > "
  else
    print_info ".env already exists (skipping)"
  fi
  
  # Verify required variables
  if ! grep -q "DB_PASSWORD=" .env; then
    print_error ".env is missing DB_PASSWORD"
    exit 1
  fi
  print_success "Environment file is valid"
}

# Build and start Docker containers
deploy_containers() {
  print_header "Deploying Docker Containers"
  
  cd "$PROJECT_DIR"
  
  if [ "$FRESH" = "true" ]; then
    print_info "Fresh deployment: removing old containers..."
    docker-compose down -v 2>/dev/null || true
    print_success "Old containers removed"
  fi
  
  if [ "$BUILD" = "true" ]; then
    print_info "Building Docker image..."
    docker-compose build
    print_success "Docker image built"
  fi
  
  print_info "Starting containers..."
  docker-compose up -d
  print_success "Containers started"
}

# Wait for services to be healthy
wait_for_health() {
  print_header "Waiting for Services to Be Healthy"
  
  cd "$PROJECT_DIR"
  
  print_info "Waiting for database to be ready..."
  MAX_ATTEMPTS=30
  ATTEMPT=0
  
  while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if docker-compose exec -T postgres pg_isready -U scopeuser -d scopefoundry &>/dev/null; then
      print_success "Database is ready"
      break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    echo -n "."
    sleep 1
  done
  
  if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    print_error "Database failed to start within timeout"
    docker-compose logs postgres
    exit 1
  fi
  
  print_info "Waiting for application to be ready..."
  ATTEMPT=0
  
  while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -s http://localhost:8123/ > /dev/null 2>&1; then
      print_success "Application is ready"
      break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    echo -n "."
    sleep 1
  done
  
  if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    print_warning "Application did not respond within timeout (check logs with: docker-compose logs -f estimate-builder)"
  fi
}

# Verify deployment
verify_deployment() {
  print_header "Verifying Deployment"
  
  cd "$PROJECT_DIR"
  
  print_info "Container status:"
  docker-compose ps
  
  print_info "Testing application endpoint..."
  if curl -s http://localhost:8123/ > /dev/null; then
    print_success "Application is accessible at http://10.0.10.102:8123"
  else
    print_warning "Application endpoint did not respond"
  fi
  
  print_info "Testing database connection..."
  if docker-compose exec -T estimate-builder node -e "
    const { Pool } = require('pg');
    const pool = new Pool({
      host: 'postgres',
      port: 5432,
      database: 'scopefoundry',
      user: 'scopeuser',
      password: process.env.DB_PASSWORD
    });
    pool.query('SELECT NOW()', (err, res) => {
      process.exit(err ? 1 : 0);
    });
  " 2>/dev/null; then
    print_success "Database connection successful"
  else
    print_error "Database connection failed"
  fi
}

# Display summary
print_summary() {
  print_header "Deployment Complete"
  
  echo ""
  echo -e "${GREEN}Status: SUCCESS${NC}"
  echo ""
  echo "Application URL: ${BLUE}http://10.0.10.102:8123${NC}"
  echo "Project Path:    ${BLUE}$PROJECT_DIR${NC}"
  echo ""
  echo "Useful commands:"
  echo "  View logs:         ${BLUE}cd $PROJECT_DIR && docker-compose logs -f${NC}"
  echo "  Restart app:       ${BLUE}cd $PROJECT_DIR && docker-compose restart estimate-builder${NC}"
  echo "  Stop services:     ${BLUE}cd $PROJECT_DIR && docker-compose down${NC}"
  echo "  Database backup:   ${BLUE}cd $PROJECT_DIR && docker-compose exec postgres pg_dump -U scopeuser scopefoundry > backup.sql${NC}"
  echo ""
}

# Main execution
main() {
  # Parse arguments
  PULL=false
  BUILD=false
  FRESH=false
  
  while [[ $# -gt 0 ]]; do
    case $1 in
      --pull) PULL=true; shift ;;
      --build) BUILD=true; shift ;;
      --fresh) FRESH=true; BUILD=true; PULL=true; shift ;;
      *) print_error "Unknown option: $1"; exit 1 ;;
    esac
  done
  
  print_header "HCP Estimate Builder - Deployment Script"
  echo "Mode: $([ "$FRESH" = "true" ] && echo "FRESH INSTALL" || echo "UPDATE")"
  echo ""
  
  check_prerequisites
  setup_repository
  setup_environment
  deploy_containers
  wait_for_health
  verify_deployment
  print_summary
}

# Run main function
main "$@"
