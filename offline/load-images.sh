#!/usr/bin/env bash
# =============================================================================
# 封闭环境现场执行：导入离线镜像包（不联网、不 build）
# 用法：bash offline/load-images.sh
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f tianji-offline-images.tar ]; then
  echo 'ERROR: 找不到 tianji-offline-images.tar（请确认镜像包已随离线包一起送达）' >&2
  exit 1
fi

if [ -f SHA256SUMS ]; then
  echo '校验镜像包完整性…'
  sha256sum -c SHA256SUMS
else
  echo 'WARN: 缺少 SHA256SUMS，跳过完整性校验（建议补齐后再导入）' >&2
fi

echo '导入镜像（docker load，纯本地操作）…'
docker load -i tianji-offline-images.tar

echo '已导入镜像核对：'
while IFS= read -r line || [ -n "${line}" ]; do
  image="$(printf '%s' "${line}" | sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -z "${image}" ] && continue
  if docker image inspect "${image}" >/dev/null 2>&1; then
    echo "  OK   ${image}"
  else
    echo "  FAIL ${image}（镜像包不完整，禁止继续部署）" >&2
    exit 1
  fi
done < images.txt

echo '镜像导入完成，下一步见 offline/README.md'
