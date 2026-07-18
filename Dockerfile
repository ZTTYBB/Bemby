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

# V8 sizes its default heap from the memory it can see, which is generous: ~4GB on a 24GB
# host, and still roughly half of RAM on a small one. Node only collects hard as it nears
# that ceiling, so on a 2GB box the heap alone can grow past what is left after SQLite, the
# Telegram clients and (where enabled) a browser -- the OOM killer arrives first. Capping it
# makes GC start early enough to matter. Override the whole variable on a larger host.
ENV NODE_OPTIONS="--max-old-space-size=512"

# su-exec lets the entrypoint fix data-dir ownership as root, then drop to `node`.
# doas lets the non-root `node` app run ONLY the Chromium install script as root:
# the browser for the Cloudflare "I am not a bot" solver is installed on demand
# into the data dir (keeping the image small), which needs apk + root.
# xvfb is a small virtual X server so that browser can run headed (far better
# Turnstile pass rate than headless); the heavy browser itself stays on demand.
RUN apk add --no-cache su-exec doas xvfb

# puppeteer-core never downloads its own browser; the installer places a musl-native
# Chromium under the data dir and the app resolves it at launch.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/dist        ./dist
COPY --from=backend-builder /app/package.json ./package.json
COPY --from=frontend-builder /frontend/dist  ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY docker/install-cf-chromium.sh /usr/local/bin/install-cf-chromium

# Allow `node` to run just the install script as root, nothing else.
RUN mkdir -p /app/data /etc/doas.d \
 && chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/install-cf-chromium \
 && printf 'permit nopass node as root cmd /usr/local/bin/install-cf-chromium\n' > /etc/doas.d/cf-chromium.conf \
 && chmod 0600 /etc/doas.d/cf-chromium.conf

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:${PORT:-3000}/api/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
# Prefer IPv4 to avoid IPv6 routing issues in container environments
CMD ["node", "--dns-result-order=ipv4first", "dist/server.js"]
