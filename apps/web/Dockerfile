FROM node:22-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/api/package.json ./apps/api/package.json
RUN pnpm install --frozen-lockfile --filter web...
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_OPERATOR_TOKEN=
ENV NEXT_PUBLIC_OPERATOR_TOKEN=$NEXT_PUBLIC_OPERATOR_TOKEN
RUN pnpm --filter web build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
