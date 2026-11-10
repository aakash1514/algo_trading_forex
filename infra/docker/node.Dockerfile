# syntax=docker/dockerfile:1.7
# The Node apps of ForexEdge from one build: the six NestJS services and the Next.js frontend.
#
#   build     npm ci + nx build of every Node app (shared by all targets, built once)
#   service   one NestJS service:  --target service --build-arg APP=auth-service (market-service,
#             domain-service, order-service, ws-gateway, replay-service)
#   frontend  the Next.js standalone server
#   ops       the repo's tools with dev dependencies (migrations, seeds, logins, history import);
#             run once with `docker compose run`, never a long-running service
#
# Runtime images hold only main.js and its production dependencies, owned by root and run as the
# non-root "node" user, and take every setting from the environment (no .env in any image).
ARG NODE_IMAGE=node:24.13.1-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
ENV CI=true NX_DAEMON=false NX_NO_CLOUD=true NX_SKIP_NX_CACHE=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 CYPRESS_INSTALL_BINARY=0 HUSKY=0
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
# NODE_OPTIONS: next build and six webpack builds in a 4 GB Docker VM
RUN NODE_OPTIONS=--max-old-space-size=3072 npx nx run-many -t build --parallel=1 \
      -p auth-service market-service domain-service order-service ws-gateway replay-service frontend \
 && node apps/frontend/scripts/check-production-build.cjs dist/apps/frontend/.next
# Nx's pruned package-lock.json can miss nested entries (seen: content-type@1.0.5), which makes `npm ci`
# refuse it. Complete each one here, once (the direct dependencies are exact pins from the root lock),
# so the runtime stage can still install strictly with `npm ci`.
RUN --mount=type=cache,target=/root/.npm \
    for app in auth-service market-service domain-service order-service ws-gateway replay-service; do \
      (cd dist/apps/$app && npm install --package-lock-only --omit=dev --no-audit --no-fund) || exit 1; \
    done

FROM ${NODE_IMAGE} AS service
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/dist/apps/${APP}/package.json /repo/dist/apps/${APP}/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund
COPY --from=build /repo/dist/apps/${APP}/main.js ./
# the code and its node_modules belong to root: the service can read them, not change them
USER node
CMD ["node", "main.js"]

FROM ${NODE_IMAGE} AS frontend
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# Nx builds into dist/: standalone/ has server.js under apps/frontend and the .next dir under dist/
COPY --from=build /repo/dist/apps/frontend/.next/standalone ./
COPY --from=build /repo/dist/apps/frontend/.next/static ./dist/apps/frontend/.next/static
COPY --from=build /repo/apps/frontend/public ./apps/frontend/public
USER node
CMD ["node", "apps/frontend/server.js"]

FROM build AS ops
# the tools write only reports (docs/) and history transfers (data/, a mounted volume)
RUN mkdir -p /repo/data && chown -R node:node /repo/docs /repo/data
USER node
WORKDIR /repo
CMD ["node", "--version"]
