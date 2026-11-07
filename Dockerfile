# DOCKERHUB / NPM_REGISTRY let servers that cannot reach Docker Hub or npm use a mirror (set by install.sh).
ARG DOCKERHUB=docker.io
FROM ${DOCKERHUB}/library/node:22-alpine AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
COPY package*.json ./
RUN npm ci --registry="$NPM_REGISTRY" --no-audit --no-fund
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${DOCKERHUB}/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# pg_dump for the nightly Telegram backup (same major version as the database). A local build on a server
# that cannot reach the Alpine mirrors still succeeds; the backup then reports that pg_dump is missing.
RUN apk add --no-cache postgresql16-client || echo "WARNING: postgresql16-client not installed (Telegram backup disabled)"
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "dist/bin/api.js"]
