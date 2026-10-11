# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY . .
ARG NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
# One build layer keeps the package store and build tooling out of final images.
# Optional session CA is a transient BuildKit secret, never copied into a layer.
RUN --mount=type=secret,id=proxy_ca \
    --mount=type=cache,target=/root/.local/share/pnpm/store \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    test -n "$NEXT_PUBLIC_API_URL" \
    && npm install --global pnpm@11.19.0 \
    && pnpm install --frozen-lockfile --prod=false \
    && pnpm build \
    && pnpm --filter=@agentconnect/api deploy --legacy --prod --frozen-lockfile /out/api \
    && pnpm --filter=@agentconnect/worker deploy --legacy --prod --frozen-lockfile /out/worker

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS service
WORKDIR /app
ENV NODE_ENV=production
USER node

FROM service AS api
COPY --from=build --chown=node:node /out/api ./apps/api
COPY --from=build --chown=node:node /app/packages/db/migrations ./packages/db/migrations
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]

FROM service AS worker
COPY --from=build --chown=node:node /out/worker ./apps/worker
ENV WORKER_HEALTH_HOST=0.0.0.0
EXPOSE 4100
CMD ["node", "apps/worker/dist/index.js"]

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
