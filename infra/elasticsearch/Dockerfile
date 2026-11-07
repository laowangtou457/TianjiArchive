# =============================================================================
# Elasticsearch 8 + IK 中文分词插件镜像
# 说明：官方 ES 镜像不含 IK，需在构建期联编 analysis-ik 插件。
#       使用 elasticsearch-plugin install 的 URL 需可访问内网镜像；
#       内网隔离环境请预先将 zip 放入 build context（见下）。
# =============================================================================
ARG ES_VERSION=8.13.4
FROM docker.elastic.co/elasticsearch/elasticsearch:${ES_VERSION}

ARG ES_VERSION=8.13.4
ARG IK_VERSION=8.13.4

USER root

# 优先使用 build context 内预置的离线包；否则从网络下载
COPY ik/ /tmp/ik-offline/
RUN set -eux; \
    if [ -f "/tmp/ik-offline/elasticsearch-analysis-ik-${IK_VERSION}.zip" ]; then \
      ZIP="/tmp/ik-offline/elasticsearch-analysis-ik-${IK_VERSION}.zip"; \
    else \
      ZIP="/tmp/elasticsearch-analysis-ik-${IK_VERSION}.zip"; \
      curl -fsSL --retry 3 -o "${ZIP}" \
        "https://get.infini.cloud/elasticsearch/analysis-ik/${IK_VERSION}" || \
      curl -fsSL --retry 3 -o "${ZIP}" \
        "https://github.com/infinilabs/analysis-ik/releases/download/v${IK_VERSION}/elasticsearch-analysis-ik-${IK_VERSION}.zip"; \
    fi; \
    /usr/share/elasticsearch/bin/elasticsearch-plugin install --batch "file://${ZIP}"; \
    rm -rf /tmp/ik-offline "${ZIP}" /usr/share/elasticsearch/config/analysis-ik/README.txt || true

# 自定义 IK 词典与停用词（可在运行时挂载覆盖，无需重建镜像）
RUN mkdir -p /usr/share/elasticsearch/config/analysis-ik
COPY analysis-ik/custom_dict.dic /usr/share/elasticsearch/config/analysis-ik/custom_dict.dic
COPY analysis-ik/stopword.dic /usr/share/elasticsearch/config/analysis-ik/stopword.dic

# 中文档案常用词（示例种子，实施时按单位主题词表补充）
RUN cat >> /usr/share/elasticsearch/config/analysis-ik/custom_dict.dic <<'EOF'
天玑档案
案卷
全宗
档号
保管期限
著录
归档
借阅
卷内目录
文书档案
科技档案
会计档案
EOF

RUN chown -R elasticsearch:root /usr/share/elasticsearch/config/analysis-ik

USER elasticsearch

# 健康检查
HEALTHCHECK --interval=20s --timeout=10s --retries=20 --start-period=60s \
  CMD curl -fsS http://localhost:9200/_cluster/health || exit 1
