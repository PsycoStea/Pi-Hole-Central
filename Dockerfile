# Base image pinned by digest (multi-arch index, read from Docker Hub 2026-11-13)
# so a rebuild cannot silently pick up a different image. To take a Node
# security update, look up the new digest of node:22-alpine and change it here.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# Next 16.2.6 through 16.4.5 leave instrumentation.js (and its chunks) out of the standalone
# output, so register() never runs and the background poller silently never
# starts. This re-adds them; it exits non-zero if the entry is missing, so a
# future Next upgrade fails the build rather than shipping a dead poller.
RUN npm run build && node scripts/copy-instrumentation-standalone.mjs
# The runner copies node_modules wholesale (the entrypoint's migrate/seed
# scripts and the server-external ssh2/better-sqlite3 need it), so drop the
# build-only packages first: they are never loaded at runtime but carried
# the shadcn CLI and drizzle-kit dependency trees (and their advisories)
# into the image.
RUN npm prune --omit=dev

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runner
WORKDIR /app

RUN apk add --no-cache libc6-compat && \
    mkdir -p /app/data

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
