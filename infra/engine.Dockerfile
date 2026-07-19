# Build from the repo root so workspaces resolve:
#   docker build -f infra/engine.Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/lexicon/package.json packages/lexicon/
COPY packages/engine/package.json packages/engine/
# plain install: resolves the copied workspaces AND root devDeps (typescript)
RUN npm install
COPY packages/lexicon packages/lexicon
COPY packages/engine packages/engine
RUN npm run build --workspace @atproto-agents/lexicon --workspace @atproto-agents/engine

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/lexicon/dist packages/lexicon/dist
COPY --from=build /app/packages/lexicon/package.json packages/lexicon/
COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/packages/engine/package.json packages/engine/
COPY infra/engine-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8080
CMD ["/entrypoint.sh"]
