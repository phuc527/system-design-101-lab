# syntax=docker/dockerfile:1

# ---------- Stage 1: build ----------
# Full dev dependencies (TypeScript etc.) live only in this stage.
FROM node:22-alpine AS build
WORKDIR /app

# Copy only the manifests first: this layer (and `npm ci`) is cached until
# package.json / package-lock.json change, so code edits rebuild in seconds.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ---------- Stage 2: runtime ----------
# Small final image: compiled JS + production dependencies only, no compiler.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Never run as root inside a container.
USER node
EXPOSE 3000

# Docker marks the container "unhealthy" if /health stops answering.
# (busybox wget ships with alpine; no curl needed)
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1

# Run node directly (not `npm start`) so SIGTERM from `docker stop` reaches
# our graceful-shutdown handler instead of being swallowed by npm.
CMD ["node", "dist/server.js"]
