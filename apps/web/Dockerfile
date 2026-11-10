# Web 构建：Vite 打包 → Nginx 托管静态资源并反代 /api
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
# .npmrc 必须一起拷：里面配了 registry 镜像（npmjs.org 在部分网络下 TLS 建连即断）
COPY pnpm-workspace.yaml package.json tsconfig.base.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --filter @tianji/web... --frozen-lockfile=false
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @tianji/shared build \
 && pnpm --filter @tianji/web build

FROM nginx:1.25-alpine AS runtime
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata curl
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=20s --timeout=5s --retries=5 \
  CMD curl -fsS http://127.0.0.1/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
