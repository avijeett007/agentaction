# syntax=docker/dockerfile:1
#
# AgentAction approval server — production image (Postgres only).
#
# Build from the REPOSITORY ROOT, because the npm workspace lockfile lives there:
#
#   docker build -f server/Dockerfile -t agentaction-server .
#
# Create or update the tables once per release, before the new containers start
# (never from every container at once):
#
#   docker run --rm -e DATABASE_URL=postgres://… agentaction-server npm run db:deploy
#
# Then run as many containers as you like against the same database — see
# docs/production.md.

ARG NODE_VERSION=22

# ---- build: compile TypeScript and generate the Postgres client -------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY sdk/package.json sdk/
RUN npm ci --workspace server

COPY server/ server/
RUN npm run db:postgres --workspace server \
 && npm exec --workspace server -- prisma generate --schema=prisma/schema.postgres.prisma \
 && npm run build --workspace server

# ---- runtime: production dependencies, compiled output, nothing else --------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY sdk/package.json sdk/
RUN npm ci --workspace server --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/prisma server/prisma
RUN npm exec --workspace server -- prisma generate --schema=prisma/schema.postgres.prisma

USER node
WORKDIR /app/server
ENV PORT=4890
EXPOSE 4890

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
