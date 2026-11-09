#!/usr/bin/env python3
"""audit-debs.py 的回归用例（标准库 unittest，无需 pytest）。

    python3 installer/build/audit_debs_test.py

这些用例全部用手工合成的小 .deb，不依赖任何真实载荷——目的是锁住「判定口径」，
而不是验证某个具体包。真实载荷的核对由 `audit-debs.py --dir <debs>` 现场跑。
"""

import io
import os
import sys
import tarfile
import tempfile
import types
import importlib.util

# 文件名带连字符（与同目录 shell 脚本命名一致），不能直接 import，这里按路径加载。
_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("audit_debs", os.path.join(_HERE, "audit-debs.py"))
ad = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ad)


# ---------------------------------------------------------------- 合成 .deb
#
# .deb = ar 归档，成员顺序固定：debian-binary / control.tar.* / data.tar.*。
# 这里故意用 gz 压 control（gzip 是标准库），zstd 分支另有用例单独覆盖魔数与降级路径。

def _ar_member(name: str, body: bytes) -> bytes:
    return (name.ljust(16) + "0".ljust(12) + "0".ljust(6) + "0".ljust(6)
            + "100644".ljust(8) + str(len(body)).ljust(10) + "`\n").encode() + body + (
        b"\n" if len(body) % 2 else b"")


def _control_tar(control: str) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        data = control.encode()
        info = tarfile.TarInfo("./control")
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def make_deb(dir_path: str, filename: str, control: str) -> str:
    path = os.path.join(dir_path, filename)
    body = (b"!<arch>\n"
            + _ar_member("debian-binary", b"2.0\n")
            + _ar_member("control.tar.gz", _control_tar(control))
            + _ar_member("data.tar.gz", _control_tar(""))
            )
    with open(path, "wb") as fh:
        fh.write(body)
    return path


def make_manifest(dir_path: str, names: dict) -> None:
    lines = []
    for filename, sha in names.items():
        lines.append("%s  %s" % (sha, filename))
    with open(os.path.join(dir_path, "DEBS-MANIFEST.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def deb_sha(path: str) -> str:
    import hashlib
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


# ---------------------------------------------------------------- 版本比较

def test_vercmp_basics():
    cases = [
        ("1.0", "1.0", 0),
        ("1.0", "1.1", -1),
        ("2.5.3-2ubuntu3~22.04.1", "2.5.3-2ubuntu3", -1),  # ~ 比空小
        ("5:29.9.3-1", "5:29.9.3-1", 0),
        ("1:1.0", "2.0", 1),                              # epoch 优先
        ("1.02", "1.2", 0),                               # 数字段去前导零
        ("1.0-2", "1.0-10", -1),
        ("3.10.6-1~22.04.1", "3.10.6-1~22.04.1", 0),
    ]
    for a, b, want in cases:
        got = ad.vercmp(a, b)
        got = 0 if got == 0 else (1 if got > 0 else -1)
        assert got == want, "vercmp(%s, %s) = %s，期望 %s" % (a, b, got, want)


def test_sat_relation():
    assert ad.sat_relation("2.5.3-2ubuntu3", ">=", "2.4")
    assert not ad.sat_relation("2.3", ">=", "2.4")
    assert ad.sat_relation("1:1.0", ">>", "0.9")
    assert ad.sat_relation("1.0", "", "9.9")  # 无约束恒真


# ---------------------------------------------------------------- 闭包自洽性

def test_closure_satisfied_inside():
    with tempfile.TemporaryDirectory() as d:
        a = make_deb(d, "aaa_1.0_amd64.deb",
                     "Package: aaa\nVersion: 1.0\nArchitecture: amd64\nDepends: bbb (>= 2.0)\n")
        b = make_deb(d, "bbb_2.1_amd64.deb",
                     "Package: bbb\nVersion: 2.1\nArchitecture: amd64\n")
        make_manifest(d, {os.path.basename(a): deb_sha(a), os.path.basename(b): deb_sha(b)})
        report = ad.audit(d)
        assert report["package_count"] == 2
        assert report["errors"] == [], report["errors"]
        assert "bbb" not in report["external"]


def test_version_mismatch_inside_closure_is_error():
    """闭包里点名了依赖、但版本不够 —— 必须在构建机就拦下，别等到真机 dpkg 报错。"""
    with tempfile.TemporaryDirectory() as d:
        a = make_deb(d, "aaa_1.0_amd64.deb",
                     "Package: aaa\nVersion: 1.0\nArchitecture: amd64\nDepends: bbb (>= 2.0)\n")
        b = make_deb(d, "bbb_1.0_amd64.deb",
                     "Package: bbb\nVersion: 1.0\nArchitecture: amd64\n")
        make_manifest(d, {os.path.basename(a): deb_sha(a), os.path.basename(b): deb_sha(b)})
        report = ad.audit(d)
        assert report["errors"], "版本不满足必须报 ERROR"
        assert "bbb" in report["errors"][0]


def test_missing_dep_is_external_not_error():
    """闭包外依赖（基础系统提供）是正常现象，不能判失败——否则每台机器都报错。"""
    with tempfile.TemporaryDirectory() as d:
        a = make_deb(d, "aaa_1.0_amd64.deb",
                     "Package: aaa\nVersion: 1.0\nArchitecture: amd64\nDepends: libc6 (>= 2.34)\n")
        make_manifest(d, {os.path.basename(a): deb_sha(a)})
        report = ad.audit(d)
        assert report["errors"] == []
        assert "libc6" in report["external"]


def test_alternatives_resolve_when_one_is_present():
    """`a | b` 只要一个满足即可，不能因为 a 缺失就报。"""
    with tempfile.TemporaryDirectory() as d:
        a = make_deb(d, "aaa_1.0_amd64.deb",
                     "Package: aaa\nVersion: 1.0\nArchitecture: amd64\nDepends: missing-pkg | bbb\n")
        b = make_deb(d, "bbb_1.0_amd64.deb",
                     "Package: bbb\nVersion: 1.0\nArchitecture: amd64\n")
        make_manifest(d, {os.path.basename(a): deb_sha(a), os.path.basename(b): deb_sha(b)})
        report = ad.audit(d)
        assert report["errors"] == [], report["errors"]


def test_provides_satisfies_virtual_dependency():
    with tempfile.TemporaryDirectory() as d:
        a = make_deb(d, "aaa_1.0_amd64.deb",
                     "Package: aaa\nVersion: 1.0\nArchitecture: amd64\nDepends: mail-transport-agent\n")
        b = make_deb(d, "bbb_1.0_amd64.deb",
                     "Package: bbb\nVersion: 1.0\nArchitecture: amd64\nProvides: mail-transport-agent\n")
        make_manifest(d, {os.path.basename(a): deb_sha(a), os.path.basename(b): deb_sha(b)})
        report = ad.audit(d)
        assert report["errors"] == [], report["errors"]
        assert "mail-transport-agent" not in report["external"]


def test_duplicate_package_name_is_error():
    with tempfile.TemporaryDirectory() as d:
        a = make_deb(d, "aaa_1.0_amd64.deb",
                     "Package: aaa\nVersion: 1.0\nArchitecture: amd64\n")
        b = make_deb(d, "aaa_1.1_amd64.deb",
                     "Package: aaa\nVersion: 1.1\nArchitecture: amd64\n")
        make_manifest(d, {os.path.basename(a): deb_sha(a), os.path.basename(b): deb_sha(b)})
        report = ad.audit(d)
        assert any("两个 aaa" in e for e in report["errors"]), report["errors"]


# ---------------------------------------------------------------- 清单核对

def test_manifest_hash_mismatch_detected():
    with tempfile.TemporaryDirectory() as d:
        a = make_deb(d, "aaa_1.0_amd64.deb",
                     "Package: aaa\nVersion: 1.0\nArchitecture: amd64\n")
        # 故意登记一个错误的 sha256
        make_manifest(d, {os.path.basename(a): "0" * 64})
        report = ad.audit(d)
        problems = ad.check_manifest(d, report)
        assert any("sha256 不符" in p for p in problems), problems


def test_unlisted_deb_is_rejected():
    """磁盘上有、清单里没有 —— 来源不明，不允许出包。"""
    with tempfile.TemporaryDirectory() as d:
        a = make_deb(d, "aaa_1.0_amd64.deb",
                     "Package: aaa\nVersion: 1.0\nArchitecture: amd64\n")
        make_manifest(d, {})  # 空清单
        report = ad.audit(d)
        problems = ad.check_manifest(d, report)
        assert any("清单里没有" in p for p in problems), problems


# ---------------------------------------------------------------- zstd 分支

def test_zstd_magic_without_module_gives_actionable_error():
    """缺 zstd 能力时，错误信息必须说清「这是环境缺能力，不是闭包坏」。"""
    body = b"\x28\xb5\x2f\xfd" + b"\x00" * 16
    old_which = ad.shutil.which
    ad.shutil.which = lambda _name: None
    try:
        try:
            ad.decompress_zstd(body)
        except RuntimeError as exc:
            text = str(exc)
            assert "pip install zstandard" in text
            assert "环境缺能力" in text
        else:
            raise AssertionError("缺 zstd 能力时必须抛错")
    finally:
        ad.shutil.which = old_which


def test_control_compression_dispatch():
    """gz 必须走通；未知魔数要报「不认识格式」而不是崩在 tarfile 里。"""
    payload = b"hello"
    import gzip as _gzip
    assert ad.decompress_control_member(_gzip.compress(payload)) == payload
    try:
        ad.decompress_control_member(b"\xde\xad\xbe\xef" + b"\x00" * 8)
    except ValueError as exc:
        assert "不认识的 control.tar 压缩格式" in str(exc)
    else:
        raise AssertionError("未知魔数必须报错")


# ---------------------------------------------------------------- runner

def main() -> int:
    tests = [(name, obj) for name, obj in sorted(globals().items())
             if name.startswith("test_") and isinstance(obj, types.FunctionType)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS %s" % name)
        except AssertionError as exc:
            failed += 1
            print("FAIL %s: %s" % (name, exc))
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print("ERROR %s: %r" % (name, exc))
    print("\n%d/%d 通过" % (len(tests) - failed, len(tests)))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
