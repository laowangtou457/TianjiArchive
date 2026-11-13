# 天玑档案 —— PostgreSQL 基础镜像（PG16 + pgvector 0.8.1）
#
# 为什么自建：官方 postgres:16-alpine 不含 pgvector；Alpine 仓库里的
# `postgresql-pgvector` 是针对 PG18 编译的（扩展目录 /usr/share/postgresql18），
# 无法加载到 PG16，故改为「下载 0.8.1 源码 + 对 PG16 头文件本地编译」。
#
# 为什么可行：
#   - 主版本仍是 16，数据目录格式不变，./volumes/postgres 原地复用（无需 dump/restore）；
#   - 扩展只增不改 PG 内核表结构，CREATE EXTENSION 幂等；
#   - 编译产物直接装进系统目录，容器启动时无需再联网。
#
# 可用性兜底：若构建环境取不到源码（离线现场），`docker compose build postgres`
# 会显式失败而非静默成功；此时可临时改回 `image: postgres:16-alpine`，
# 应用侧会自动探测扩展缺失并切到「double precision[] + 应用内余弦」降级路径
# （见 docs/RAG与知识库设计.md §3.2）。
FROM postgres:16-alpine

ARG PGVECTOR_VERSION=0.8.1

RUN set -eux; \
    apk add --no-cache --virtual .pgvector-build-deps \
        build-base postgresql16-dev curl tar; \
    curl -fsSL --retry 3 -o /tmp/pgvector.tar.gz \
        "https://codeload.github.com/pgvector/pgvector/tar.gz/refs/tags/v${PGVECTOR_VERSION}"; \
    mkdir -p /tmp/pgvector; \
    tar -xzf /tmp/pgvector.tar.gz -C /tmp/pgvector --strip-components=1; \
    cd /tmp/pgvector; \
    # 明确指向 PG16 的 pg_config，避免误用其它版本头文件（ABI 不兼容）
    PGC="$(command -v pg_config)"; \
    "$PGC" --version | grep -q ' 16\.'; \
    # with_llvm=no：官方镜像的 PG 带 JIT（with_llvm=yes），pgvector 会额外生成
    # .bc 位码并强制要求 clang-XX；镜像内没有 clang，且位码只影响 JIT 内联性能，
    # 对向量检索无实质影响 —— 直接跳过，避免为此装一整条 LLVM 工具链。
    make -j"$(nproc)" with_llvm=no PG_CONFIG="$PGC"; \
    make install with_llvm=no PG_CONFIG="$PGC"; \
    cd /; rm -rf /tmp/pgvector /tmp/pgvector.tar.gz; \
    apk del --no-network .pgvector-build-deps; \
    # 校验：控制库与共享库必须真实落盘，否则「构建成功但 CREATE EXTENSION 失败」
    test -f /usr/local/share/postgresql/extension/vector.control; \
    test -f /usr/local/lib/postgresql/vector.so
