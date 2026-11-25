# backend/Dockerfile
# Multi-stage production container for Zoiko Abate API server and Outbox Worker.

FROM node:22.14.0-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS builder
WORKDIR /app/backend

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY db ./db
COPY tools ./tools

RUN npm run build

# Tools stage for migrations and operational CLI scripts (needs tsx + tools/)
FROM node:22.14.0-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS tools
WORKDIR /app/backend

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY --from=builder /app/backend/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/src ./src
COPY --from=builder /app/backend/db ./db
COPY --from=builder /app/backend/tools ./tools

USER node
CMD ["npm", "run", "migrate"]

# Lean production runtime stage: production dependencies + compiled dist/ only (no devDeps, src/, or tools/)
FROM node:22.14.0-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS runner
WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=5000

RUN apk upgrade --no-cache

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && \
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* && \
    printf '#!/bin/sh\nif [ "$1" = "run" ] && [ "$2" = "start" ]; then exec node dist/index.js; fi\nif [ "$1" = "run" ] && [ "$2" = "start:worker" ]; then exec node dist/worker/daemon.js; fi\nexec node "$@"\n' > /usr/local/bin/npm && \
    chmod +x /usr/local/bin/npm
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/db ./db

USER node
EXPOSE 5000

CMD ["npm", "run", "start"]
