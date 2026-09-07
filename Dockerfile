FROM node:20-slim AS base
WORKDIR /app

# Full install (devDependencies included) — the build needs typescript, which is a devDependency.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# Runtime install, kept separate so devDependencies never reach the final image. Safe because
# logger.ts only loads pino-pretty when NODE_ENV !== 'production', and the runtime entry point is
# plain `node dist/...` rather than tsx.
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The generated SQL lives outside dist and is read at runtime: index.ts applies migrations on boot,
# so a cold start on a fresh database works with no release command (see docs/deploy.md).
COPY drizzle ./drizzle
# node:20-slim ships an unprivileged `node` user; the default is root, which this process has no
# need for.
USER node
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
