# plain: stock Caddy (certificates via ports 80/443).
# cloudflare: Caddy + Cloudflare DNS plugin, so certificates work on any port (DNS-01 challenge).
# `plain` comes first so even the legacy builder stops before compiling anything for it.
ARG DOCKERHUB=docker.io
FROM ${DOCKERHUB}/library/caddy:2-alpine AS plain

FROM ${DOCKERHUB}/library/caddy:2-builder-alpine AS cloudflare-build
ARG GOPROXY=https://proxy.golang.org,direct
RUN GOPROXY="$GOPROXY" xcaddy build --with github.com/caddy-dns/cloudflare --output /usr/bin/caddy

FROM ${DOCKERHUB}/library/caddy:2-alpine AS cloudflare
COPY --from=cloudflare-build /usr/bin/caddy /usr/bin/caddy
