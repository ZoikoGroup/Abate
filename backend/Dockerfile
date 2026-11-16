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

FROM node:22.14.0-alpine@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS runner
WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=5000

COPY package.json package-lock.json ./
COPY --from=builder /app/backend/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/src ./src
COPY --from=builder /app/backend/db ./db
COPY --from=builder /app/backend/tools ./tools

USER node
EXPOSE 5000

CMD ["npm", "run", "start"]
