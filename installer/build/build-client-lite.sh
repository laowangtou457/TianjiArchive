#!/usr/bin/env bash
# =============================================================================
# build-client-lite.sh —— 用户端（阶段一 client-lite）安装包构建
#
# 产物：installer/client-lite/tianji-client-lite.zip（约 30KB，4 个文件）
#
# 为什么用 python zipfile 而不是 zip/Compress-Archive：
#   1. 文件名含中文（自检.ps1 / 说明.txt / 配置天玑客户端.bat）。zipfile 对
#      非 cp437 文件名自动置 UTF-8 标志位（flag bit 11），Windows 10/11 资源
#      管理器与 7-Zip/WinRAR 均按 UTF-8 正确解出中文名；外部 zip 工具对
#      「用什么编码写文件名」行为不一，容易产出版本间不可比对的包。
#   2. 确定性：zipfile 允许逐成员固定 date_time（配合 SOURCE_DATE_EPOCH），
#      同输入两次构建逐字节一致——与 build-server-package.sh 的可复现口径一致。
#      sha256 是每次构建的记录值，不是恒等式；口径见 docs/安装器总体设计.md。
#
# 自检守卫（构建即验收，避免发出去的包是坏的）：
#   G1  成员逐字节 == 源文件（防内容漂移）
#   G2  非 ASCII 文件名的 UTF-8 标志位必须置位（防中文名在目标机解出乱码）
#   G3  自检.ps1 必须是 UTF-8 with BOM（Windows PowerShell 5.1 无 BOM 会按
#       GBK 解析，中文界面全体乱码——client-lite 说明.txt 第六节有事故记录）
#   G4  4 个成员齐全、无多余文件（防把临时/调试文件打进交付包）
# =============================================================================
set -euo pipefail

die() { echo "[client-lite] FAIL: $*" >&2; exit 1; }
log() { echo "[client-lite] $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${SCRIPT_DIR}/../client-lite"
ZIP_PATH="${SRC_DIR}/tianji-client-lite.zip"
VERSION="${1:-1.0.0}"

# 成员清单：zip 内顶层目录名（用户解压出来的文件夹），与说明.txt 第一节一致
TOPDIR="tianji-client-lite"
MEMBERS=("config.json" "自检.ps1" "说明.txt" "配置天玑客户端.bat")

# 确定性时间戳：优先 SOURCE_DATE_EPOCH（与 server 包构建同口径），缺省 2026-11-10
EPOCH="${SOURCE_DATE_EPOCH:-1762732800}"   # 2026-11-10 00:00:00 UTC

for f in "${MEMBERS[@]}"; do
  [ -f "${SRC_DIR}/${f}" ] || die "源文件缺失：${f}"
done

# G3 前置守卫：BOM + CRLF 检查在打包前做（源文件被误存成 LF/BOM 丢失时当场拦下）
python3 - "${SRC_DIR}/自检.ps1" <<'PYEOF' || die "自检.ps1 编码守卫未通过（见上方输出）"
import sys
raw = open(sys.argv[1], 'rb').read()
ok = True
if not raw.startswith(b'\xef\xbb\xbf'):
    print('  BOM 缺失：自检.ps1 必须是 UTF-8 with BOM（PowerShell 5.1 无 BOM 按 GBK 解析）'); ok = False
if b'\r\n' not in raw:
    print('  行尾为 LF：自检.ps1 必须保持 CRLF（记事本/控制台兼容口径）'); ok = False
sys.exit(0 if ok else 1)
PYEOF

# 打包：python3 zipfile，固定 date_time，成员顺序固定
python3 - "$ZIP_PATH" "$SRC_DIR" "$TOPDIR" "$EPOCH" "${MEMBERS[@]}" <<'PYEOF' || die "zip 打包失败"
import sys, os, time, zipfile
zip_path, src_dir, topdir, epoch = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
members = sys.argv[5:]
dt = time.gmtime(epoch)[0:6]
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for m in members:
        src = os.path.join(src_dir, m)
        arcname = f'{topdir}/{m}'
        info = zipfile.ZipInfo(arcname, date_time=dt)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        with open(src, 'rb') as f:
            z.writestr(info, f.read())
print(f'  打包完成：{len(members)} 个成员')
PYEOF

# 构建后验收 G1/G2/G4：重开 zip 逐项核对
python3 - "$ZIP_PATH" "$SRC_DIR" "$TOPDIR" "${MEMBERS[@]}" <<'PYEOF' || exit 1
import sys, os, zipfile
zip_path, src_dir, topdir = sys.argv[1], sys.argv[2], sys.argv[3]
members = sys.argv[4:]
fails = 0
with zipfile.ZipFile(zip_path) as z:
    names = z.namelist()
    expect = [f'{topdir}/{m}' for m in members]
    if sorted(names) != sorted(expect):
        print(f'  G4 FAIL：成员清单不符 实际={names} 期望={expect}'); fails += 1
    for m in members:
        arcname = f'{topdir}/{m}'
        if arcname not in names: continue
        data = z.read(arcname)
        src = open(os.path.join(src_dir, m), 'rb').read()
        if data != src:
            print(f'  G1 FAIL：成员与源不一致 {m}'); fails += 1
        else:
            print(f'  G1 PASS：{m}（{len(data)} 字节逐字节一致）')
        info = z.getinfo(arcname)
        utf8 = bool(info.flag_bits & 0x800)
        needs_utf8 = any(ord(c) > 127 for c in arcname)
        if needs_utf8 and not utf8:
            print(f'  G2 FAIL：{arcname} 非 ASCII 文件名但 UTF-8 标志未置位'); fails += 1
        elif needs_utf8:
            print(f'  G2 PASS：{arcname} UTF-8 标志置位')
if fails:
    print(f'  构建后验收未通过（{fails} 处）'); sys.exit(1)
print('  构建后验收：G1/G2/G4 全部 PASS')
PYEOF

SHA="$(sha256sum "${ZIP_PATH}" | awk '{print $1}')"
SHA="${SHA#\\}"
SIZE="$(wc -c < "${ZIP_PATH}" | tr -d ' ')"
log "版本=${VERSION}"
log "产物=${ZIP_PATH}"
log "字节数=${SIZE}  sha256=${SHA}"
log "（sha256 是本次构建的记录值，不是恒等式——口径同 server 包）"
