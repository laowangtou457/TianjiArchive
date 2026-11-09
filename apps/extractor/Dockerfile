# Extractor Worker 镜像：需 LibreOffice（Office→PDF）与 ffmpeg（音视频转码）
FROM node:22-bookworm-slim AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/extractor/package.json apps/extractor/
RUN pnpm install --filter @tianji/extractor... --frozen-lockfile=false

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/extractor apps/extractor
RUN pnpm --filter @tianji/shared build \
 && pnpm --filter @tianji/extractor build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production TZ=Asia/Shanghai
RUN apt-get update \
 && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends --fix-missing \
      curl ca-certificates tzdata \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      fonts-noto-cjk fontconfig ffmpeg poppler-utils \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# 构建期可选镜像源覆盖（默认空 = 官方源 npmjs，行为不变）。
# 网络受限的构建机可传 --build-arg COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
# 让 corepack 从国内镜像源下载 pnpm；该值不写入镜像元数据之外的任何运行时行为。
ARG COREPACK_NPM_REGISTRY=
ENV COREPACK_NPM_REGISTRY=${COREPACK_NPM_REGISTRY}
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared ./packages/shared
COPY --from=build /repo/apps/extractor ./apps/extractor
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
CMD ["node", "apps/extractor/dist/main.js"]
