# plain: stock Caddy (certificates via ports 80/443).
# cloudflare: Caddy + Cloudflare DNS plugin, so certificates work on any port (DNS-01 challenge).
# BuildKit only builds the stages the chosen target needs.
FROM caddy:2-builder-alpine AS cloudflare-build
RUN xcaddy build --with github.com/caddy-dns/cloudflare --output /usr/bin/caddy

FROM caddy:2-alpine AS plain

FROM caddy:2-alpine AS cloudflare
COPY --from=cloudflare-build /usr/bin/caddy /usr/bin/caddy
