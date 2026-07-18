#!/bin/sh
# Installs a musl-native Chromium + fonts into an alternate apk root under the
# data dir, so the Cloudflare "I am not a bot" solver has a browser without
# bloating the image. Run as root via doas (see /etc/doas.d/cf-chromium.conf).
# Arg 1 = target root (defaults to /app/data/cf-chromium).
set -eu

ROOT="${1:-/app/data/cf-chromium}"
mkdir -p "$ROOT"

# --initdb bootstraps a fresh apk database inside ROOT; the browser and all its
# musl shared libs land under ROOT so they survive restarts on the data volume.
apk add --no-cache \
  --root "$ROOT" \
  --initdb \
  --arch "$(apk --print-arch)" \
  --repositories-file /etc/apk/repositories \
  chromium nss freetype harfbuzz ttf-freefont font-noto-cjk

# The app runs as the node user, so hand it ownership to launch the browser.
chown -R node:node "$ROOT" 2>/dev/null || true

echo "cf-chromium installed at $ROOT"
