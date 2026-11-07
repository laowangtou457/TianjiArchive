# 依赖安装层
FROM node:22-bookworm-slim AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --filter @tianji/api... --frozen-lockfile=false

# 构建层
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @tianji/shared build \
 && pnpm --filter @tianji/api build

# 运行层
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production TZ=Asia/Shanghai
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared ./packages/shared
COPY --from=build /repo/apps/api ./apps/api
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
# tsconfig.base.json 必须随包进运行层：迁移/seed/压测均经 ts-node 执行，
# apps/api/tsconfig.json 以 "../../tsconfig.base.json" 相对路径继承它（联调现场 TS5083 实证）
COPY --from=build /repo/tsconfig.base.json ./tsconfig.base.json
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=10s --retries=10 --start-period=40s \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "apps/api/dist/main.js"]
