# ── Stage 1: Build frontend ────────────────────────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Build backend + compile native addons + prune to prod deps ────────
# Debian rather than Alpine: the native addon has to be built against the same libc
# the production stage runs, and that stage needs glibc for the browser (see below).
FROM node:22-bookworm-slim AS backend-builder
WORKDIR /app
# python3/make/g++ required to compile better-sqlite3 native addon
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# ── Stage 3: Production image ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS production
WORKDIR /app

ENV NODE_ENV=production

# The Cloudflare "I am not a bot" solver runs a real Chromium. The browser itself is
# downloaded on demand into the data dir (keeping the image small), but its shared
# libraries and fonts belong here. This is the dependency set Playwright's Chromium
# expects, and it is why the image is Debian: that build is glibc-only, and it is the
# same one that gets through a challenge on a developer machine. Alpine could only
# offer its own musl build of a different Chromium version.
#
# xvfb gives the browser a virtual display so it can run headed (far better challenge
# pass rate than headless). gosu lets the entrypoint fix data-dir ownership as root
# and then drop to the non-root `node` user. The fonts cover Latin, CJK and emoji: a
# browser that cannot draw a glyph measures text unlike any real one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      gosu \
      xvfb \
      libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libatspi2.0-0 libx11-6 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxrandr2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 \
      libasound2 libxcb1 libexpat1 libglib2.0-0 libudev1 \
      fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# puppeteer-core never downloads a browser of its own; the Playwright installer places
# one under the data dir on demand and the app resolves it at launch.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/dist        ./dist
COPY --from=backend-builder /app/package.json ./package.json
COPY --from=frontend-builder /frontend/dist  ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
# Prefer IPv4 to avoid IPv6 routing issues in container environments
CMD ["node", "--dns-result-order=ipv4first", "dist/server.js"]
