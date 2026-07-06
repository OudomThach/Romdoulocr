# --- Stage 1: Build the static SPA ---------------------------------------
# Pinned major version, small alpine image. We don't run the dev server here,
# we just produce a production `dist/` that nginx can serve verbatim.
FROM node:22-alpine AS builder

WORKDIR /app

# Copy lockfile + manifest first so dependency layer caches across source-only changes.
COPY package.json package-lock.json* ./

# Use ci when a lockfile is present (reproducible installs), fall back to install.
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

# Copy the rest of the source and build.
COPY . .

# Build arg lets the image target any API endpoint at build time.
# This is the URL the SPA calls when VITE_API_URL is set to "/api" (the default).
ARG API_UPSTREAM=https://rinabuoy13--khparser-api.modal.run
ENV VITE_API_URL=/api

RUN npm run build

# --- Stage 2: Serve with nginx (static + same-origin API proxy) ---------
# nginx alpine is ~40MB. The final image contains only the compiled SPA plus
# nginx, and runs nginx as a single-process server that does both static
# serving and same-origin reverse-proxying of /api/* to the upstream.
#
# Why the proxy: the upstream Modal API does not send Access-Control-Allow-Origin,
# so browsers block cross-origin requests. Proxying through nginx on the same
# origin as the SPA makes the browser think it's a same-origin call (no
# preflight), while nginx handles the actual cross-origin hop server-side.
FROM nginx:1.27-alpine AS runner

# gettext-base provides envsubst, used to template the upstream URL into nginx.conf.
RUN apk add --no-cache gettext

# Drop the default nginx site.
RUN rm -f /etc/nginx/conf.d/default.conf

# Templated config: the placeholder ${API_UPSTREAM} is substituted at build time.
# Everything else ($scheme, $proxy_host, etc.) is left alone for nginx to evaluate.
COPY nginx.conf /etc/nginx/templates/spa.conf.template

ARG API_UPSTREAM=https://rinabuoy13--khparser-api.modal.run
ENV API_UPSTREAM=$API_UPSTREAM

# Optional shared secret for the local vLLM adapter (empty by default). Baked
# into the nginx config so the home deployment forwards it; the value comes from
# the gitignored .env via docker-compose, never from the repo.
ARG ADAPTER_TOKEN=
ENV ADAPTER_TOKEN=$ADAPTER_TOKEN

# Render the template into nginx's conf.d. Only our explicit vars are
# substituted so nginx's own $variables are left intact.
RUN envsubst '${API_UPSTREAM} ${ADAPTER_TOKEN}' < /etc/nginx/templates/spa.conf.template \
              > /etc/nginx/conf.d/spa.conf \
 && rm -rf /etc/nginx/templates

# Copy the built site.
COPY --from=builder /app/dist /usr/share/nginx/html

# nginx runs as the built-in `nginx` user; ensure it can read assets.
RUN chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/log/nginx /etc/nginx/conf.d

EXPOSE 80

# Healthcheck: hit the SPA root. The /api/ proxy is exercised by the browser
# at request time, not at startup, so we don't depend on upstream availability
# for container health.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
