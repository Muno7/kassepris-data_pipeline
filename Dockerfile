# Fetch-based scraper pipeline. The recurring weekly job (products:update-all)
# and the setup path (db:init) are pure HTTP - no browser - so Puppeteer's
# Chromium download is skipped, keeping the image small. Chromium is only
# needed for one-off Willys store DISCOVERY (stores/willys/willys_stores.js),
# which isn't part of either flow; Willys stores load from the committed
# stores/willys/willys_stores.json.
FROM node:22-slim

# tini as PID 1: forwards signals (clean SIGTERM stop on Fargate) and reaps the
# node/bash children the npm scripts spawn.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

# APP_ENV defaults to production for a real deployment (AWS RDS + SSL). Override
# it (and DB_URL/DB_SSL) at runtime for local/test - see docker-compose.yml.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    NODE_ENV=production \
    APP_ENV=production

WORKDIR /app

# Install deps against the lockfile first so this layer caches unless
# package*.json change.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Run as the unprivileged built-in `node` user. It must own /app because the
# pipeline writes scraped data + checkpoints under products/*/{data,normalized,
# .state} at runtime.
RUN chown -R node:node /app
USER node

ENTRYPOINT ["tini", "--"]
# Default command is the recurring weekly update. For setup or one-off steps,
# override, e.g.  docker compose run --rm app npm run db:init
CMD ["npm", "run", "products:update-all"]
