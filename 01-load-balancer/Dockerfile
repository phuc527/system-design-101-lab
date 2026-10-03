# syntax=docker/dockerfile:1
# One image, two programs: the API (dist/api/server.js) and the
# TypeScript load balancer (dist/lb/server.js). docker-compose.yml picks
# which one each container runs via `command:`.

# ---------- Stage 1: build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ---------- Stage 2: runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000 8091

# Default program: an API instance. The healthcheck is defined per service in docker-compose.yml.
CMD ["node", "dist/api/server.js"]
