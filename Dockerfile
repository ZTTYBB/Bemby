# ── Stage 1: Build frontend ────────────────────────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Build backend + compile native addons + prune to prod deps ────────
FROM node:22-alpine AS backend-builder
WORKDIR /app
# python3/make/g++ required to compile better-sqlite3 native addon
RUN apk add --no-cache python3 make g++
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# ── Stage 3: Production image ──────────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/dist        ./dist
COPY --from=backend-builder /app/package.json ./package.json
COPY --from=frontend-builder /frontend/dist  ./public

RUN mkdir -p /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:${PORT:-3000}/api/health || exit 1

# Prefer IPv4 to avoid IPv6 routing issues in container environments
CMD ["node", "--dns-result-order=ipv4first", "dist/server.js"]
