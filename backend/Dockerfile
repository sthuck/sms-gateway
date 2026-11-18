# syntax=docker/dockerfile:1
# Build from repository root:
#   docker build -f backend/Dockerfile .

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json ./backend/
RUN pnpm install --filter @sms-gateway/backend... --frozen-lockfile

FROM deps AS build
COPY backend/tsconfig.json backend/tsconfig.build.json ./backend/
COPY backend/src ./backend/src
RUN pnpm --filter @sms-gateway/backend build \
  && pnpm --filter @sms-gateway/backend deploy --prod /out

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 app \
  && useradd --system --uid 1001 --gid app --home /app --shell /usr/sbin/nologin app
COPY --from=build --chown=app:app /out/ ./
USER app
EXPOSE 8080
# Default: API. Override command for worker / MCP Deployments.
CMD ["node", "dist/index.js"]
