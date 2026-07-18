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

ENV NODE_ENV=production

# su-exec lets the entrypoint fix data-dir ownership as root, then drop to `node`.
# chromium + fonts power the headless Cloudflare "I am not a bot" solve for checkins
# (used by puppeteer-core). The alpine chromium package covers amd64 and arm64.
RUN apk add --no-cache \
      su-exec \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ttf-freefont \
      font-noto-cjk \
 && ln -sf /usr/bin/chromium /usr/bin/chromium-browser 2>/dev/null || true

# puppeteer-core drives the system chromium; never try to download its own.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/dist        ./dist
COPY --from=backend-builder /app/package.json ./package.json
COPY --from=frontend-builder /frontend/dist  ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:${PORT:-3000}/api/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
# Prefer IPv4 to avoid IPv6 routing issues in container environments
CMD ["node", "--dns-result-order=ipv4first", "dist/server.js"]
