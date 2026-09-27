FROM node:22-bookworm-slim
WORKDIR /repo
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends sqlite3 ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile --filter api...
RUN pnpm --filter api... run build
WORKDIR /repo/apps/api
ENV NODE_ENV=production
RUN mkdir -p /data && chown -R node:node /data /repo
USER node
EXPOSE 4000
CMD ["sh", "-c", "pnpm --filter @workspace/db exec prisma migrate deploy && node --conditions=compiled dist/index.js"]
