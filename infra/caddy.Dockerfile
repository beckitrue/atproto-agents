# Caddy, with the observer UI baked in.
#
# Caddy already terminates TLS for the PDS and the engine, so it serves the
# observer's static build too rather than adding another container. Same
# origin as /api → no CORS anywhere in the stack.
#
# Build from the repo root so workspaces resolve:
#   docker build -f infra/caddy.Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/observer/package.json packages/observer/
# plain install: resolves the copied workspace AND root devDeps (typescript)
RUN npm install
COPY packages/observer packages/observer
RUN npm run build --workspace @atproto-agents/observer

FROM caddy:2
COPY --from=build /app/packages/observer/dist /srv/observer
