#!/usr/bin/env python3
"""离线核对变体 A 的 .deb 闭包是否自洽（不需要 dpkg、不需要联网、不需要 Docker）。

为什么需要这个工具
------------------
`fetch-docker-debs.sh` 抓回来的是「apt 认为该下的一堆包」，但**它不会替我们证明这批包
凑起来能装得上**。真机上踩过两次，都是闭包不自洽、而现象发生在很远的地方：

  * `libseccomp2` 因为构建机已装过，apt 判定依赖满足 → 不下载 → 包里没有 → 真机
    docker-ce 装上了但 dockerd 起不来；
  * `python3-minimal` 的 Pre-Depends 是 `python3.10-minimal`，两个包都在闭包里，
    但一次性 `dpkg -i` 的参数顺序让 dpkg 判「未安装」，整步 S3 直接 FAIL。

前者靠关键包清单兜住了，后者靠补装一轮兜住了。但这两次都是「到安装时才炸」。
本工具把这两类问题**前移到构建机**：拿闭包里的 control 字段自己算一遍依赖，
不依赖 dpkg 数据库、不依赖网络。

判定分三档，避免把「真问题」和「正常现象」混在一起
-------------------------------------------------
  ERROR  闭包**内部**矛盾：某个包的依赖在闭包里点名了、但版本不满足，或闭包里有两个
         包提供同名但不同版本的关键能力。这类必然在真机炸，必须修。
  EXTERNAL  依赖不在闭包里，只能由目标系统（ubuntu:22.04 基础系统）提供。
         这是**正常**的——闭包只补「基础系统没有的那部分」。这里只做清单登记，
         让人能一眼看出「我们在依赖目标系统的什么」，不作为失败。
  OK      依赖由闭包内的包满足，版本也满足。

用法
----
    python3 installer/build/audit-debs.py --dir installer/build/payload/ubuntu-debian/jammy/debs
    python3 installer/build/audit-debs.py --dir <dir> --json <out.json>   # 供其它脚本消费

退出码：0 = 无 ERROR；1 = 有 ERROR（闭包不自洽，禁止出包）。
"""

from __future__ import annotations

import argparse
import bz2
import gzip
import hashlib
import io
import json
import lzma
import os
import re
import shutil
import subprocess
import sys
import tarfile

# ---------------------------------------------------------------- .deb 解析
#
# .deb 是 ar 归档：`!<arch>\n` + 若干 60 字节头的成员。成员里我们只关心 control.tar.*，
# 它本身是 tar，里面 ./control 就是 dpkg-deb -I 打印的那张表。
# 之所以自己解析而不调 dpkg-deb：构建机是 Windows/精简容器，未必有 dpkg。

AR_MAGIC = b"!<arch>\n"
CONTROL_MEMBER = re.compile(r"^control\.tar\.(gz|xz|zst|bz2|lzma)$")


def iter_ar_members(raw: bytes):
    """按 (成员名, 内容) 迭代 ar 归档。"""
    if not raw.startswith(AR_MAGIC):
        raise ValueError("不是 ar 归档（缺 !<arch> 魔数）")
    off = len(AR_MAGIC)
    while off + 60 <= len(raw):
        header = raw[off:off + 60]
        name = header[0:16].decode("ascii", "replace").strip()
        try:
            size = int(header[48:58].decode("ascii").strip() or "0")
        except ValueError:
            raise ValueError("ar 成员头损坏：%r" % header)
        off += 60
        body = raw[off:off + size]
        yield name.rstrip("/"), body
        off += size + (size % 2)  # 成员按 2 字节对齐


def read_control(path: str) -> dict[str, str]:
    """从 .deb 里取出 control 字段（等价于 dpkg-deb -I 的第一段）。"""
    with open(path, "rb") as fh:
        raw = fh.read()
    for name, body in iter_ar_members(raw):
        if not CONTROL_MEMBER.match(name):
            continue
        data = decompress_control_member(body)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as tf:
            for member in tf.getmembers():
                if member.name.lstrip("./") == "control":
                    text = tf.extractfile(member).read().decode("utf-8", "replace")
                    return parse_control_text(text)
    raise ValueError("找不到 control.tar.*（不是标准 .deb？）: %s" % path)


def decompress_control_member(body: bytes) -> bytes:
    """按魔数解压 control.tar.*。

    Ubuntu 21.10 起 .deb 默认用 **zstd** 压 control 与 data，而 Python 的 tarfile 到
    3.13 都还不认 zstd（`r:*` 只覆盖 gz/bz2/xz）。踩过一次：
    `tarfile.open(mode="r:*")` 对 control.tar.zst 直接 ReadError，报「不是 gzip/bzip2/xz」，
    很容易被误读成「.deb 坏了」。所以这里按魔数显式分派，缺 zstd 能力时给出可执行的处置话术。
    """
    magic = body[:6]
    if magic[:2] == b"\x1f\x8b":
        return gzip.decompress(body)
    if magic[:6] == b"\xfd7zXZ\x00":
        return lzma.decompress(body)
    if magic[:3] == b"BZh":
        return bz2.decompress(body)
    if magic[:4] == b"\x28\xb5\x2f\xfd":
        return decompress_zstd(body)
    if magic[:3] == b"\x5d\x00\x00":
        return lzma.decompress(body)
    raise ValueError("不认识的 control.tar 压缩格式（魔数 %s）" % magic.hex())


def decompress_zstd(body: bytes) -> bytes:
    try:
        import zstandard  # type: ignore

        with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(body)) as reader:
            return reader.read()
    except ImportError:
        pass
    for exe in ("zstd", "unzstd"):
        path = shutil.which(exe)
        if not path:
            continue
        proc = subprocess.run([path, "-d", "-c"], input=body, capture_output=True)
        if proc.returncode == 0:
            return proc.stdout
    raise RuntimeError(
        "control.tar.zst 需要 zstd 解压能力（Ubuntu 21.10+ 的 .deb 默认用 zstd）。"
        "请任选一种：`pip install zstandard`、或安装 zstd 命令行、或换到有 dpkg 的机器上跑。"
        "注意这是**环境缺能力**，不是闭包有问题，别据此判闭包坏。"
    )


def parse_control_text(text: str) -> dict[str, str]:
    """把 control 文本解析成字段字典，支持续行（以空格开头）。"""
    fields: dict[str, str] = {}
    key = ""
    for line in text.splitlines():
        if not line.strip():
            continue
        if line[0] in " \t" and key:
            fields[key] += " " + line.strip()
            continue
        if ":" in line:
            key, _, value = line.partition(":")
            key = key.strip()
            fields[key] = value.strip()
    return fields


# ---------------------------------------------------------------- 版本比较
#
# 只需要「够 Debian 用」的 compare，不追求完整实现：分段数字/非数字比较 + epoch + revision。
# 用错的后果是「明明满足却报 ERROR」，所以这里对拿不准的情况走「按字符串相等」兜底、
# 并标 uncertain，宁可少报也不误报。

def _order(ch: str) -> int:
    if ch.isdigit():
        return 0
    if ch.isalpha():
        return ord(ch)
    if ch == "~":
        return -1
    if ch == "":
        return 0
    return ord(ch) + 256


def _cmp_part(a: str, b: str) -> int:
    i = j = 0
    while i < len(a) or j < len(b):
        # 先吃掉非数字前缀
        while (i < len(a) and not a[i].isdigit()) or (j < len(b) and not b[j].isdigit()):
            ac = _order(a[i] if i < len(a) else "")
            bc = _order(b[j] if j < len(b) else "")
            if ac != bc:
                return -1 if ac < bc else 1
            i += 1
            j += 1
        # 再比较数字段（去前导零）
        si, sj = i, j
        while i < len(a) and a[i].isdigit():
            i += 1
        while j < len(b) and b[j].isdigit():
            j += 1
        na = a[si:i].lstrip("0") or "0"
        nb = b[sj:j].lstrip("0") or "0"
        if len(na) != len(nb):
            return -1 if len(na) < len(nb) else 1
        if na != nb:
            return -1 if na < nb else 1
    return 0


def split_version(version: str) -> tuple[str, str, str]:
    epoch = "0"
    if ":" in version:
        epoch, _, version = version.partition(":")
    upstream, _, revision = version.rpartition("-")
    if not upstream:
        return epoch, revision, ""
    return epoch, upstream, revision


def vercmp(a: str, b: str) -> int:
    ea, ua, ra = split_version(a)
    eb, ub, rb = split_version(b)
    if ea != eb:
        return -1 if int(ea) < int(eb) else 1
    rc = _cmp_part(ua, ub)
    if rc:
        return rc
    return _cmp_part(ra, rb)


def sat_relation(have: str, op: str, want: str) -> bool:
    if not op:
        return True
    c = vercmp(have, want)
    return {
        ">=": c >= 0,
        "<=": c <= 0,
        ">>": c > 0,
        "<<": c < 0,
        "=": c == 0,
    }.get(op, True)


# ---------------------------------------------------------------- 依赖解析

DEP_RE = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9+.\-]*)"
    r"(?::(?P<arch>[A-Za-z0-9\-]+))?"
    r"\s*(?:\((?P<op><<|<=|>=|>>|=)\s*(?P<ver>[^)]+)\))?"
    r"\s*(?:\[(?P<archs>[^\]]*)\])?"
    r"\s*(?:<(?P<profiles>[^>]*)>)?$"
)


def parse_dep_group(field: str) -> list[list[dict]]:
    """Depends 字段 → [[{name,op,ver,arch}], ...]（外层是「与」，内层是「或」）。"""
    groups: list[list[dict]] = []
    for clause in (field or "").split(","):
        clause = clause.strip()
        if not clause:
            continue
        alts = []
        for alt in clause.split("|"):
            alt = alt.strip()
            if not alt:
                continue
            m = DEP_RE.match(alt)
            if not m:
                # 解析不了的条目照样记下来，标 unparsed，让人肉看一眼
                alts.append({"name": alt, "op": "", "ver": "", "unparsed": True})
                continue
            alts.append({
                "name": m.group("name"),
                "op": m.group("op") or "",
                "ver": (m.group("ver") or "").strip(),
                "archqual": m.group("arch") or "",
            })
        if alts:
            groups.append(alts)
    return groups


class Package:
    def __init__(self, filename: str, fields: dict[str, str], sha256: str):
        self.filename = filename
        self.fields = fields
        self.sha256 = sha256
        self.name = fields.get("Package", "")
        self.version = fields.get("Version", "")
        self.arch = fields.get("Architecture", "")
        self.provides: list[dict] = []
        for clause in (fields.get("Provides") or "").split(","):
            clause = clause.strip()
            if not clause:
                continue
            m = DEP_RE.match(clause)
            if m:
                self.provides.append({
                    "name": m.group("name"),
                    "op": m.group("op") or "",
                    "ver": (m.group("ver") or "").strip(),
                })

    def dep_groups(self) -> list[tuple[str, list[list[dict]]]]:
        out = []
        for field in ("Pre-Depends", "Depends"):
            groups = parse_dep_group(self.fields.get(field, ""))
            if groups:
                out.append((field, groups))
        return out


def audit(dir_path: str) -> dict:
    deb_files = sorted(
        os.path.join(dir_path, name)
        for name in os.listdir(dir_path)
        if name.endswith(".deb")
    )
    if not deb_files:
        raise SystemExit("目录里没有 .deb：%s" % dir_path)

    packages: dict[str, Package] = {}
    by_filename: dict[str, Package] = {}
    errors: list[str] = []
    external: dict[str, list[str]] = {}

    for path in deb_files:
        with open(path, "rb") as fh:
            sha = hashlib.sha256(fh.read()).hexdigest()
        fields = read_control(path)
        pkg = Package(os.path.basename(path), fields, sha)
        if not pkg.name or not pkg.version:
            errors.append("%s：control 缺 Package/Version 字段（不是有效 .deb）" % pkg.filename)
            continue
        if pkg.name in packages:
            errors.append("闭包里有两个 %s（%s 与 %s）——dpkg 会按参数顺序覆盖，行为不确定"
                          % (pkg.name, packages[pkg.name].filename, pkg.filename))
        packages[pkg.name] = pkg
        by_filename[pkg.filename] = pkg

    # 能力提供表：包名 + Provides 里带版本的那些（不带版本的 Provides 只能满足无约束依赖）
    provider: dict[str, list[tuple[str, str]]] = {}
    for pkg in packages.values():
        provider.setdefault(pkg.name, []).append((pkg.version, pkg.name))
    for pkg in packages.values():
        for prov in pkg.provides:
            provider.setdefault(prov["name"], []).append((prov["ver"], pkg.name))

    def satisfied(alt: dict) -> str:
        """返回 'closure' / 'external' / 'mismatch:...'。"""
        cands = provider.get(alt["name"], [])
        if not cands:
            return "external"
        if not alt["op"]:
            return "closure"
        for version, _owner in cands:
            if version and sat_relation(version, alt["op"], alt["ver"]):
                return "closure"
        # 在闭包里点名了但版本不满足 —— 这是要人管的事
        have = ", ".join("%s(%s)" % (o, v or "无版本") for v, o in cands)
        return "mismatch:%s 需要 %s %s，闭包内为 %s" % (alt["name"], alt["op"], alt["ver"], have)

    for pkg in packages.values():
        for field, groups in pkg.dep_groups():
            for alts in groups:
                results = [satisfied(alt) for alt in alts]
                if any(r == "closure" for r in results):
                    continue
                mismatch = [r for r in results if r.startswith("mismatch:")]
                if mismatch and len(mismatch) == len(results):
                    errors.append("%s（%s）的 %s：%s" % (pkg.name, pkg.version, field, "；".join(mismatch)))
                    continue
                # 全部落在闭包外：登记为「由目标系统提供」，不是错误
                for alt, res in zip(alts, results):
                    if res == "external":
                        external.setdefault(alt["name"], []).append(
                            "%s%s" % (pkg.name, "（%s）" % field if field == "Pre-Depends" else "")
                        )

    return {
        "dir": dir_path,
        "package_count": len(packages),
        "packages": {
            name: {
                "version": pkg.version,
                "filename": pkg.filename,
                "sha256": pkg.sha256,
                "depends": pkg.fields.get("Depends", ""),
                "pre_depends": pkg.fields.get("Pre-Depends", ""),
                "provides": pkg.fields.get("Provides", ""),
            }
            for name, pkg in sorted(packages.items())
        },
        "errors": errors,
        "external": {k: sorted(set(v)) for k, v in sorted(external.items())},
    }


# ---------------------------------------------------------------- DEBS-MANIFEST.txt 交叉核对

def check_manifest(dir_path: str, report: dict) -> list[str]:
    """核对 DEBS-MANIFEST.txt 与磁盘上的 deb 是否一一对应（多、少、哈希不符）。"""
    problems: list[str] = []
    manifest = os.path.join(dir_path, "DEBS-MANIFEST.txt")
    listed: dict[str, str] = {}
    exists = os.path.exists(manifest)
    if exists:
        with open(manifest, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip().lstrip("\\")
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                if len(parts) < 2:
                    continue
                sha, name = parts[0], parts[1].lstrip("*")
                if not name.endswith(".deb"):
                    continue
                listed[os.path.basename(name)] = sha
    else:
        problems.append("缺 DEBS-MANIFEST.txt：没有逐文件 sha256 就无法证明闭包没被换过")

    on_disk = {info["filename"]: info["sha256"] for info in report["packages"].values()}
    for name, sha in sorted(listed.items()):
        if name not in on_disk:
            problems.append("清单里有、磁盘上没有：%s（闭包被删过？）" % name)
        elif on_disk[name] != sha:
            problems.append("sha256 不符：%s（清单 %s，实际 %s）" % (name, sha[:12], on_disk[name][:12]))

    # 反向核对只在清单文件存在时做：清单缺失已经单独报过一条，
    # 再逐个 deb 报「清单里没有」会把真正的问题淹掉（现场只会看到几十行重复）。
    # 但清单**存在**却漏登记某个 deb，就是「来源不明」——空清单也一样，必须报。
    if exists:
        for name in sorted(on_disk):
            if name not in listed:
                problems.append("磁盘上有、清单里没有：%s（来源不明，不予出包）" % name)
    return problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="离线核对 .deb 闭包自洽性")
    parser.add_argument("--dir", required=True, help="debs 目录（含 DEBS-MANIFEST.txt）")
    parser.add_argument("--json", help="把完整报告写到这个文件")
    parser.add_argument("--quiet", action="store_true", help="只打印结论，不打印清单")
    args = parser.parse_args(argv)

    report = audit(args.dir)
    manifest_problems = check_manifest(args.dir, report)

    print("闭包目录：%s" % report["dir"])
    print("包数    ：%d" % report["package_count"])
    total_bytes = sum(
        os.path.getsize(os.path.join(args.dir, info["filename"]))
        for info in report["packages"].values()
    )
    print("总字节  ：%d" % total_bytes)

    if not args.quiet:
        print("\n包清单：")
        for name, info in report["packages"].items():
            print("  %-34s %-44s %s" % (name, info["version"], info["filename"]))

    print("\n依赖（闭包外，由目标系统提供）：%d 项" % len(report["external"]))
    for name, owners in report["external"].items():
        owners_text = "、".join(owners[:4]) + ("…" if len(owners) > 4 else "")
        print("  %-28s ← %s" % (name, owners_text))

    if report["errors"]:
        print("\nERROR（闭包内部矛盾，必然在真机炸）：%d 条" % len(report["errors"]))
        for item in report["errors"]:
            print("  ✗ %s" % item)
    if manifest_problems:
        print("\nMANIFEST 问题：%d 条" % len(manifest_problems))
        for item in manifest_problems:
            print("  ✗ %s" % item)

    ok = not report["errors"] and not manifest_problems
    print("\n%s" % ("IS_PASS: YES —— 闭包自洽（依赖均能在闭包内或目标系统内满足）"
                    if ok else "IS_PASS: NO —— 修掉上面带 ✗ 的条目再出包"))

    if args.json:
        report["manifest_problems"] = manifest_problems
        report["ok"] = ok
        report["total_bytes"] = total_bytes
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
        print("报告已写入：%s" % args.json)

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
