#!/usr/bin/env bash
# =============================================================================
# build-windows-package.sh —— Windows 变体（变体 C）服务端安装包构建
#
# 产物：dist/installer/tianji-server-setup-windows-amd64-<version>.zip
#
# zip 内布局（见 docs/Windows部署方案设计.md §2）：
#   tianji-windows-setup/
#   ├── tianji-windows-setup.ps1                          编排器（唯一新代码）
#   ├── 说明.txt
#   └── payload/
#       ├── SHA256SUMS.txt                                载荷校验清单（编排器 S0 逐项重算）
#       ├── wsl.msi                                       WSL 离线安装器（fetch-wsl-assets.sh 抓取）
#       ├── ubuntu-jammy-wsl-rootfs.tar.gz                Ubuntu 22.04 rootfs
#       └── tianji-server-setup-ubuntu-debian-amd64-*.run 变体 A .run（原样复用，不改写）
#
# fail-closed 闸门（任何一条不过就不产出包）：
#   G1 输入齐备：ps1/说明.txt/三份载荷必须存在；.run 文件名版本与 --version 一致
#   G2 编码守卫：ps1 与 说明.txt 出包前强制规范化为 UTF-8 with BOM + CRLF
#      （PowerShell 5.1 无 BOM 按 GBK 解析——client-lite 事故记录的同款坑）
#   G3 载荷登记：SHA256SUMS.txt 内容与实际文件 sha256 逐项一致
#   G4 资产登记：wsl.msi / rootfs 的 sha256 与 assets/wsl/ASSETS-VERSION.txt 一致
#      （防"资产换版没重新 fetch"的静默漂移）
#   G5 构建后验收：重开 zip 逐成员比对字节 + 中文文件名 UTF-8 标志位 + 成员清单
#
# 确定性：python zipfile + 固定 date_time（SOURCE_DATE_EPOCH），同输入两次构建
#   逐字节一致。sha256 是每次构建的记录值，不是恒等式（口径同 server 包）。
#
# 用法：
#   bash installer/build/build-windows-package.sh \
#        --run dist/installer/tianji-server-setup-ubuntu-debian-amd64-1.0.0.run \
#        --version 1.0.0
#   （wsl.msi / rootfs 缺失时提示先跑 fetch-wsl-assets.sh）
#
# 退出码：0 成功；1 参数/输入不满足；2 闸门失败
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WIN_SRC_DIR="${SCRIPT_DIR}/../windows"
ASSETS_DIR="${SCRIPT_DIR}/assets/wsl"
OUT_DIR="${REPO_ROOT}/dist/installer"

VERSION='1.0.0'
RUN_FILE=''
EPOCH="${SOURCE_DATE_EPOCH:-1762732800}"   # 2026-11-10 00:00:00 UTC（与 client-lite 同口径）
TOPDIR='tianji-windows-setup'

log() { printf '[win-package] %s\n' "$*"; }
die() { printf '[win-package] FAIL: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --run)     RUN_FILE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    *) die "未知参数：$1（用法见文件头）" ;;
  esac
done

# ---- G1 输入齐备 ----
[ -f "${WIN_SRC_DIR}/tianji-windows-setup.ps1" ] || die "G1：缺少编排器 tianji-windows-setup.ps1"
[ -f "${WIN_SRC_DIR}/说明.txt" ]                 || die "G1：缺少说明.txt"
[ -n "$RUN_FILE" ] && [ -f "$RUN_FILE" ]         || die "G1：必须用 --run 指定变体 A .run（先跑 build-server-package.sh --variant ubuntu-debian --codename jammy）"
MSI_FILE="${ASSETS_DIR}/wsl.msi"
ROOTFS_FILE="${ASSETS_DIR}/ubuntu-jammy-wsl-rootfs.tar.gz"
[ -f "$MSI_FILE" ]    || die "G1：缺少 $MSI_FILE —— 先跑 bash installer/build/fetch-wsl-assets.sh"
[ -f "$ROOTFS_FILE" ] || die "G1：缺少 $ROOTFS_FILE —— 先跑 bash installer/build/fetch-wsl-assets.sh"
RUN_BASE="$(basename "$RUN_FILE")"
case "$RUN_BASE" in
  *-"$VERSION".run) ;;
  *) die "G1：.run 版本与 --version=$VERSION 不一致（$RUN_BASE）" ;;
esac

# ---- G2 编码规范化（BOM + CRLF）----
STAGE_DIR="${REPO_ROOT}/.stage-win-package-$$"
trap 'rm -rf "$STAGE_DIR" 2>/dev/null || true' EXIT
mkdir -p "$STAGE_DIR"
normalize_bom_crlf() { # <src> <dst> <说明用途>
  python3 - "$1" "$2" <<'PYEOF'
import sys
src, dst = sys.argv[1], sys.argv[2]
raw = open(src, 'rb').read()
if raw.startswith(b'\xef\xbb\xbf'):
    raw = raw[3:]
raw = raw.replace(b'\r\n', b'\n').replace(b'\r', b'\n').replace(b'\n', b'\r\n')
open(dst, 'wb').write(b'\xef\xbb\xbf' + raw)
PYEOF
}
normalize_bom_crlf "${WIN_SRC_DIR}/tianji-windows-setup.ps1" "${STAGE_DIR}/tianji-windows-setup.ps1"
normalize_bom_crlf "${WIN_SRC_DIR}/说明.txt"                 "${STAGE_DIR}/说明.txt"
log "G2：ps1 与 说明.txt 已规范化为 UTF-8 with BOM + CRLF"

# ---- G3/G4 载荷登记（SHA256SUMS 只记 payload 内三份大文件）----
MSI_SHA="$(sha256sum "$MSI_FILE" | awk '{print $1}')"
ROOTFS_SHA="$(sha256sum "$ROOTFS_FILE" | awk '{print $1}')"
RUN_SHA="$(sha256sum "$RUN_FILE" | awk '{print $1}')"

AV_FILE="${ASSETS_DIR}/ASSETS-VERSION.txt"
[ -f "$AV_FILE" ] || die "G4：缺少 $AV_FILE（先跑 fetch-wsl-assets.sh）"
for pair in "wsl.msi:$MSI_SHA" "ubuntu-jammy-wsl-rootfs.tar.gz:$ROOTFS_SHA"; do
  name="${pair%%:*}"; sha="${pair##*:}"
  if ! grep -q "${name} .*sha256=${sha}" "$AV_FILE"; then
    die "G4：${name} 的 sha256 与 ASSETS-VERSION.txt 登记不符——资产已换版？重跑 fetch-wsl-assets.sh"
  fi
done
log "G4：wsl.msi / rootfs 与资产登记一致"

SUMS_CONTENT="# TianjiArchive Windows payload checksums (verified by S0 in tianji-windows-setup.ps1)
${MSI_SHA}  wsl.msi
${ROOTFS_SHA}  ubuntu-jammy-wsl-rootfs.tar.gz
${RUN_SHA}  ${RUN_BASE}
"
printf '%s' "$SUMS_CONTENT" > "${STAGE_DIR}/SHA256SUMS.txt"

# ---- 打包（python zipfile，固定 date_time，成员顺序固定）----
# ⚠️ MSYS 参数转换坑（本机实测三次踩中）：
#   1) Windows 原生 python 收到的 bash 路径参数依赖 MSYS 自动转换：以 / 开头
#      的独立参数（/e/x/y）会被转成 E:/x/y —— 这是正路（client-lite 同法）；
#   2) "arc|/e/x" 复合串不以 / 开头 → 不转换 → python 读到字面 /e/ 路径报错；
#   3) 自造 "e:/x" 形式会被 MSYS 按「路径列表」规则改写成 e;<msys-root>\x 的
#      垃圾串（cygpath -m 同样不可靠）。
#   因此：src 路径必须作为独立参数（POSIX 形式）传入，靠 MSYS 转换；
#   构建机若为原生 Linux，MSYS 不存在，POSIX 路径本来就是它的原生形式。
mkdir -p "$OUT_DIR"
ZIP_PATH="${OUT_DIR}/tianji-server-setup-windows-amd64-${VERSION}.zip"

# 成员清单：arcname 与 src 交替的扁平数组（src 是独立参数，MSYS 会转换）
MEMBERS=()
MEMBERS+=("${TOPDIR}/tianji-windows-setup.ps1" "${STAGE_DIR}/tianji-windows-setup.ps1")
MEMBERS+=("${TOPDIR}/说明.txt"                 "${STAGE_DIR}/说明.txt")
MEMBERS+=("${TOPDIR}/payload/SHA256SUMS.txt"   "${STAGE_DIR}/SHA256SUMS.txt")
MEMBERS+=("${TOPDIR}/payload/wsl.msi"          "$MSI_FILE")
MEMBERS+=("${TOPDIR}/payload/ubuntu-jammy-wsl-rootfs.tar.gz" "$ROOTFS_FILE")
MEMBERS+=("${TOPDIR}/payload/${RUN_BASE}"      "$RUN_FILE")

python3 - "$ZIP_PATH" "$EPOCH" "$(( ${#MEMBERS[@]} / 2 ))" "${MEMBERS[@]}" <<'PYEOF'
import sys, time, zipfile
zip_path, epoch, n = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
args = sys.argv[4:]
members = [(args[i * 2], args[i * 2 + 1]) for i in range(n)]
dt = time.gmtime(epoch)[0:6]
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for arcname, src in members:
        info = zipfile.ZipInfo(arcname, date_time=dt)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        with open(src, 'rb') as f:
            z.writestr(info, f.read())
print(f'[win-package] 打包完成：{n} 个成员')
PYEOF
log "打包完成（在 stage 目录做编码规范化，源文件不动）"

# ---- G5 构建后验收 ----
python3 - "$ZIP_PATH" "$EPOCH" "$(( ${#MEMBERS[@]} / 2 ))" "${MEMBERS[@]}" <<'PYEOF'
import sys, time, zipfile
zip_path, epoch, n = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
args = sys.argv[4:]
members = [(args[i * 2], args[i * 2 + 1]) for i in range(n)]
fails = 0
with zipfile.ZipFile(zip_path) as z:
    names = z.namelist()
    expect = [m[0] for m in members]
    if sorted(names) != sorted(expect):
        print(f'  G5 FAIL：成员清单不符 实际={names}'); fails += 1
    for arcname, src in members:
        data = z.read(arcname)
        ref = open(src, 'rb').read()
        if data != ref:
            print(f'  G5 FAIL：成员与源不一致 {arcname}'); fails += 1
        else:
            print(f'  G5 PASS：{arcname}（{len(data)} B 逐字节一致）')
        info = z.getinfo(arcname)
        want_dt = time.gmtime(epoch)[0:6]
        if info.date_time != want_dt:
            print(f'  G5 FAIL：{arcname} 时间戳非确定性 {info.date_time}'); fails += 1
        if any(ord(c) > 127 for c in arcname) and not (info.flag_bits & 0x800):
            print(f'  G5 FAIL：{arcname} 非 ASCII 名但 UTF-8 标志未置位'); fails += 1
if fails:
    print(f'  构建后验收未通过（{fails} 处）'); sys.exit(1)
print('  G5 构建后验收：全部 PASS')
PYEOF

SHA="$(sha256sum "$ZIP_PATH" | awk '{print $1}')"
log "产物=${ZIP_PATH}"
log "字节数=$(wc -c < "$ZIP_PATH" | tr -d ' ')  sha256=${SHA}"
log "（sha256 是本次构建的记录值，不是恒等式——口径同 server 包）"
