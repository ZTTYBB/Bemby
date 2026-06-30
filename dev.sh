#!/usr/bin/env bash

# ── Configurable host / ports ─────────────────────────────────────────────────
BACKEND_HOST=${BACKEND_HOST:-localhost}
BACKEND_PORT=${BACKEND_PORT:-3000}
FRONTEND_HOST=${FRONTEND_HOST:-localhost}
FRONTEND_PORT=${FRONTEND_PORT:-5173}

# Services always bind to 0.0.0.0; BACKEND_HOST/FRONTEND_HOST are display/proxy names only
PROXY_HOST=127.0.0.1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── .env setup ────────────────────────────────────────────────────────────────
if [ ! -f backend/.env ]; then
  cp env.example backend/.env
  echo ""
  echo "Created backend/.env from env.example -- update ADMIN_PASSWORD and JWT_SECRET before deploying."
  echo ""
fi

if grep -q "changeme\|change-me-in-production" backend/.env 2>/dev/null; then
  echo ""
  echo "WARNING: backend/.env still contains placeholder values."
  echo "         Update ADMIN_PASSWORD and JWT_SECRET for real use."
  echo ""
fi

# ── Dependencies ──────────────────────────────────────────────────────────────
echo "Installing dependencies..."
# utf-8-validate (optional ws perf addon) needs make to compile from source which
# may not be available -- use --ignore-scripts and restore better-sqlite3's prebuilt
(cd backend && npm install --ignore-scripts) || true
(cd backend/node_modules/better-sqlite3 && node ../prebuild-install/bin.js 2>&1 || true)
(cd frontend && npm install --no-audit) || true

# ── Cleanup on exit ───────────────────────────────────────────────────────────
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo "Stopping..."
  [ -n "$BACKEND_PID" ]  && kill "$BACKEND_PID"  2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait
}
trap cleanup EXIT INT TERM

# ── Kill any existing processes on configured ports ───────────────────────────
kill_port() {
  local PORT=$1
  local PIDS
  PIDS=$(ss -tlnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+')
  [ -z "$PIDS" ] && return 0
  echo "Killing existing process(es) on port $PORT: $PIDS"
  kill -9 $PIDS 2>/dev/null || true
  sleep 0.5
}

for PORT in $BACKEND_PORT $FRONTEND_PORT; do
  kill_port "$PORT"
done

# ── Start services ────────────────────────────────────────────────────────────
echo ""
echo "  Backend:  http://${BACKEND_HOST}:${BACKEND_PORT}"
echo "  Frontend: http://${FRONTEND_HOST}:${FRONTEND_PORT}"
echo ""
echo "Press Ctrl+C to stop both."
echo ""

(cd backend && HOST=0.0.0.0 PORT=$BACKEND_PORT DISPLAY_HOST=$BACKEND_HOST npm run dev) &
BACKEND_PID=$!

printf "Waiting for backend"
until (echo > /dev/tcp/127.0.0.1/$BACKEND_PORT) 2>/dev/null; do
  printf "."
  sleep 1
done
echo " ready"

(cd frontend && BACKEND_HOST=$PROXY_HOST BACKEND_PORT=$BACKEND_PORT npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" --strictPort) &
FRONTEND_PID=$!

wait
