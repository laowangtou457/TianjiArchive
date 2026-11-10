#!/usr/bin/env bash
# =============================================================================
# build-offline-bundle.sh —— 离线交付整合包（一次下载 = 完整安装可用）
#
# 产物：dist/bundle/tianji-offline-bundle-<版本>.zip
#   内含顶层目录 tianji-offline-bundle-<版本>/：
#     两个变体服务端 .run + tianji-offline-images.tar + client-lite.zip
#     + SHA256SUMS.txt（四件套 digest）+ 安装说明.txt
#
# 设计口径：镜像 tar 保持分离分发（安装器总体设计 §7.1 方案 B 已否决打进
# 单文件：二次解压双倍磁盘 / 无法逐项校验 / FAT32 4G 逼近）。本整合包只是
# 「一次下载」的容器，解压后 .run 与 tar 自动处于同目录，满足安装器
# locateImagesTar 的同目录约定——不改安装器行为，真机验证结论继续有效。
#
# 闸门：
#   B1 输入四件全部存在
#   B2 输入 digest 与登记值一致（防把坏文件打进去）
#   B3 构建后逐成员回读与源字节一致 + 顶层目录唯一
#   B4 解压目录内 .run 与 tar 同在（安装器同目录约定自证）
# =============================================================================
set -euo pipefail

die() { echo "[bundle] FAIL: $*" >&2; exit 1; }
log() { echo "[bundle] $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUN_DIR="${ROOT}/dist/installer"
TAR_PATH="${ROOT}/offline/tianji-offline-images.tar"
CLIENT_ZIP="${ROOT}/installer/client-lite/tianji-client-lite.zip"
NOTE_SRC="${SCRIPT_DIR}/bundle/安装说明.txt"
VERSION="${1:-1.0.0}"
OUT_DIR="${ROOT}/dist/bundle"
TOPDIR="tianji-offline-bundle-${VERSION}"
ZIP_PATH="${OUT_DIR}/${TOPDIR}.zip"

RUN_KY="${RUN_DIR}/tianji-server-setup-kylin-uos-amd64-1.0.0.run"
RUN_UB="${RUN_DIR}/tianji-server-setup-ubuntu-debian-amd64-1.0.0.run"

# ---- B1 输入存在 ----
for f in "${RUN_KY}" "${RUN_UB}" "${TAR_PATH}" "${CLIENT_ZIP}" "${NOTE_SRC}"; do
  [ -f "$f" ] || die "输入缺失：$f（先跑 build-server-package.sh 两个变体与 build-client-lite.sh）"
done

# ---- B2 输入 digest 与登记值一致 ----
expect_ky="d1120fda71cfcdf6dfc8f90ab8522c96430f3c9e2985f497bb52fa8042ebac5f"   # 审定版 v2（§14.6）
# ubuntu 变体与镜像 tar 的期望值动态取自本仓库 offline/SHA256SUMS（单一真源）
expect_tar="$(awk '$2 ~ /\*?tianji-offline-images\.tar$/{gsub(/^\*/,"",$2); print $1}' "${ROOT}/offline/SHA256SUMS")"
[ -n "${expect_tar}" ] || die "offline/SHA256SUMS 中找不到 tianji-offline-images.tar 条目"

sha_of() { sha256sum "$1" | awk '{print $1}'; }
actual_ky="$(sha_of "${RUN_KY}")"
actual_tar="$(sha_of "${TAR_PATH}")"
[ "${actual_ky}" = "${expect_ky}" ] || die "kylin .run sha 与审定版不一致：${actual_ky}（期望 ${expect_ky}）——请重跑 build-server-package.sh --variant kylin-uos 并更新 §14.6"
[ "${actual_tar}" = "${expect_tar}" ] || die "images tar sha 与 offline/SHA256SUMS 不一致：${actual_tar}（期望 ${expect_tar}）"
log "B2 PASS：kylin .run 与镜像 tar digest 与登记值一致"

# ---- 打包（确定性：固定 date_time；tar/.run STORED 不压缩）----
mkdir -p "${OUT_DIR}"
python3 - "${ZIP_PATH}" "${VERSION}" "${RUN_KY}" "${RUN_UB}" "${TAR_PATH}" "${CLIENT_ZIP}" "${NOTE_SRC}" <<'PYEOF' || die "zip 打包失败"
import sys, os, time, zipfile, hashlib
zip_path, version = sys.argv[1], sys.argv[2]
inputs = sys.argv[3:8]
topdir = f'tianji-offline-bundle-{version}'
dt = time.gmtime(1762732800)[0:6]  # 2026-11-10 00:00:00 UTC
names = [os.path.basename(p) for p in inputs[:4]]
# SHA256SUMS.txt 现场生成（四件套，标准 sha256sum 格式）
sums = ''
for p in inputs[:4]:
    h = hashlib.sha256(open(p,'rb').read()).hexdigest()
    sums += f'{h}  {os.path.basename(p)}\n'
with zipfile.ZipFile(zip_path, 'w') as z:
    for p, n in zip(inputs[:4], names):
        info = zipfile.ZipInfo(f'{topdir}/{n}', date_time=dt)
        info.compress_type = zipfile.ZIP_STORED
        info.external_attr = 0o644 << 16
        with open(p,'rb') as f:
            z.writestr(info, f.read())
    info = zipfile.ZipInfo(f'{topdir}/SHA256SUMS.txt', date_time=dt)
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, sums.encode())
    info = zipfile.ZipInfo(f'{topdir}/安装说明.txt', date_time=dt)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.flag_bits |= 0x800
    z.writestr(info, open(inputs[4],'rb').read())
print(f'  打包完成：{len(inputs[:4])+2} 个成员')
PYEOF

# ---- B3/B4 构建后验收：逐成员回读 + 同目录约定自证 ----
python3 - "${ZIP_PATH}" "${RUN_KY}" "${RUN_UB}" "${TAR_PATH}" "${CLIENT_ZIP}" "${NOTE_SRC}" <<'PYEOF' || exit 1
import sys, os, zipfile
zip_path = sys.argv[1]; inputs = sys.argv[2:7]
topdir = os.path.basename(zip_path)[:-4]
fails = 0
with zipfile.ZipFile(zip_path) as z:
    names = z.namelist()
    expect_top = f'{topdir}/'
    if any(not n.startswith(expect_top) for n in names):
        print(f'  B3 FAIL：存在顶层目录之外的成员'); fails += 1
    for p in inputs:
        n = os.path.basename(p)
        arc = f'{topdir}/{n}'
        if arc not in names:
            print(f'  B3 FAIL：成员缺失 {n}'); fails += 1; continue
        if z.read(arc) != open(p,'rb').read():
            print(f'  B3 FAIL：成员与源不一致 {n}'); fails += 1
    if f'{topdir}/SHA256SUMS.txt' not in names or f'{topdir}/安装说明.txt' not in names:
        print('  B3 FAIL：SHA256SUMS.txt 或 安装说明.txt 缺失'); fails += 1
    runs = [n for n in names if n.endswith('.run')]
    tar_ok = f'{topdir}/tianji-offline-images.tar' in names
    if len(runs) == 2 and tar_ok:
        print('  B4 PASS：解压目录内 .run ×2 与镜像 tar 同目录（安装器同目录约定自证）')
    else:
        print('  B4 FAIL：.run/tar 组合不完整'); fails += 1
if fails:
    print(f'  构建后验收未通过（{fails} 处）'); sys.exit(1)
print('  构建后验收：B3/B4 全部 PASS')
PYEOF

SHA="$(sha256sum "${ZIP_PATH}" | awk '{print $1}')"
SIZE="$(wc -c < "${ZIP_PATH}" | tr -d ' ')"
log "版本=${VERSION}"
log "产物=${ZIP_PATH}"
log "字节数=${SIZE}  sha256=${SHA}"
log "（整包 sha256 是本次打包的记录值，不是恒等式）"
