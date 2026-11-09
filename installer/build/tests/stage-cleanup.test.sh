#!/usr/bin/env bash
# =============================================================================
# 收尾清理用例：`lib/stage-cleanup.sh` 的 warn 路径
#
# 要守住的三件事：
#   1. 删不掉时必须 warn，且 warn 里要有「路径 + 大小 + 话术」三样，不能静默吞；
#   2. 删不掉时**返回 0**（清理失败不许把成功的构建改判为失败）；
#   3. 守卫把 rm 变成 no-op（退出码 0、目录还在）也算失败，必须 warn——
#      只看 rm 退出码会漏掉这种假成功。
#
# 用 stub 的 `rm` 函数制造「必然失败 / 必然假成功」，不碰真实文件系统的删除权限
# （root 构建机上 chmod 拦不住 rm，用权限做用例会假通过）。
#
# 跑法： bash installer/build/tests/stage-cleanup.test.sh
# =============================================================================
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="${SELF_DIR}/../lib/stage-cleanup.sh"
[ -f "${LIB}" ] || { printf '[test] FAIL: 找不到被测文件 %s\n' "${LIB}" >&2; exit 1; }
# shellcheck source=../lib/stage-cleanup.sh
. "${LIB}"

PASS=0
FAIL=0

# 夹具目录必须落在 POSIX 路径上：本机 TMPDIR 可能是 `C:\Users\...` 形态，
# 那种路径喂给 rm 会直接被拒——用例会以「删不掉」的形式假失败，
# 于是测的就不是被测逻辑，而是路径风格。（这个坑本轮真踩到过。）
TEST_TMP=''
for base in /tmp "${TMPDIR:-/tmp}"; do
  [ -d "${base}" ] || continue
  TEST_TMP="$(mktemp -d "${base%/}/stage-cleanup-test.XXXXXX" 2>/dev/null)" || continue
  case "${TEST_TMP}" in
    /*) break ;;
    *) command rm -rf "${TEST_TMP}" 2>/dev/null; TEST_TMP='' ;;
  esac
done
[ -n "${TEST_TMP}" ] || { printf '[test] FAIL: 找不到可用的 POSIX 临时目录\n' >&2; exit 1; }

# 断言辅助
ok() { PASS=$((PASS + 1)); printf '[test] ok   %s\n' "$*"; }
ng() { FAIL=$((FAIL + 1)); printf '[test] FAIL %s\n' "$*" >&2; }

# make_dir <name> [bytes] → 打印绝对路径；非空目录，好让 du 有东西可量
make_dir() {
  local dir="${TEST_TMP}/$1"
  local bytes="${2:-1024}"
  mkdir -p "${dir}"
  head -c "${bytes}" /dev/zero > "${dir}/blob" 2>/dev/null
  printf '%s' "${dir}"
}

# 把被测函数对 warn 的依赖接管过来：warn 只负责收集文本，不往屏幕刷。
WARN_LOG=''
warn() { WARN_LOG="${WARN_LOG}$*"$'\n'; }

# --- 用例 1：正常删除 → 目录消失、不 warn、返回 0 -----------------------------
dir="$(make_dir case1 4096)"
WARN_LOG=''
stage_cleanup "${dir}"
rc=$?
if [ "${rc}" -eq 0 ] && [ ! -e "${dir}" ] && [ -z "${WARN_LOG}" ]; then
  ok '正常删除：目录消失，rc=0，且没有 WARN'
else
  ng "正常删除：rc=${rc} exists=$([ -e "${dir}" ] && echo yes || echo no) warn=${WARN_LOG:-空}"
fi

# --- 用例 2：rm 必然失败 → 必须 warn，且带路径/大小/话术，仍返回 0 -------------
dir="$(make_dir case2 2048)"
WARN_LOG=''
rm() { return 1; }          # stub：权限 / 被占用 / 守卫拦截的等效形态
stage_cleanup "${dir}"
rc=$?
unset -f rm
has_path=no; has_size=no; has_phr=no
case "${WARN_LOG}" in *"${dir}"*) has_path=yes ;; esac
case "${WARN_LOG}" in *残留大小*) has_size=yes ;; esac
case "${WARN_LOG}" in *'不是交付物，手工清理前不要把它们当交付物分发'*) has_phr=yes ;; esac
if [ "${rc}" -eq 0 ] && [ "${has_path}" = yes ] && [ "${has_size}" = yes ] && [ "${has_phr}" = yes ]; then
  ok 'rm 失败：rc=0，WARN 同时含路径、残留大小、话术'
else
  ng "rm 失败：rc=${rc} path=${has_path} size=${has_size} phr=${has_phr} warn=${WARN_LOG:-空}"
fi

# --- 用例 3：rm 假成功（rc=0 但目录还在）→ 同样必须 warn ----------------------
dir="$(make_dir case3 1024)"
WARN_LOG=''
rm() { return 0; }          # stub：safe-delete 守卫把批量删除变成 no-op 的形态
stage_cleanup "${dir}"
rc=$?
unset -f rm
if [ "${rc}" -eq 0 ] && [ -n "${WARN_LOG}" ] && [ -d "${dir}" ]; then
  ok 'rm 假成功但目录仍在：仍 warn（没把 no-op 当成功）'
else
  ng "rm 假成功：rc=${rc} warn=${WARN_LOG:-空}"
fi

# --- 用例 4：目录本来就不存在 → 静默返回 0，不 warn ---------------------------
WARN_LOG=''
stage_cleanup "${TEST_TMP}/never-existed"
rc=$?
if [ "${rc}" -eq 0 ] && [ -z "${WARN_LOG}" ]; then
  ok '目录不存在：静默 rc=0（EXIT trap 重复触发时不刷屏）'
else
  ng "目录不存在：rc=${rc} warn=${WARN_LOG:-空}"
fi

# --- 用例 5：空路径不得进 rm -rf（防 `rm -rf ""` 删当前目录） -----------------
WARN_LOG=''
stage_cleanup ''
rc=$?
if [ "${rc}" -eq 0 ] && [ -z "${WARN_LOG}" ] && [ -d "${SELF_DIR}" ]; then
  ok '空路径：直接返回 0，不调用 rm（当前目录完好）'
else
  ng "空路径：rc=${rc} warn=${WARN_LOG:-空}"
fi

# --- 用例 6：未定义 warn 函数时退回内置 printf（构建脚本以外 source 也不崩） ---
dir="$(make_dir case6 1024)"
unset -f warn 2>/dev/null
rm() { return 1; }
err="$(stage_cleanup "${dir}" 2>&1 >/dev/null)"
rc=$?
unset -f rm
case "${err}" in
  *'[package] WARN:'*)
    if [ "${rc}" -eq 0 ]; then
      ok '缺 warn 兜底：退回内置 printf，rc 仍为 0'
    else
      ng "缺 warn 兜底：有 WARN 但 rc=${rc}（应为 0）"
    fi
    ;;
  *) ng "缺 warn 兜底：stderr 未出现内置 WARN -> ${err:-空}" ;;
esac

# --- 用例 7：变参清理（暂存目录 + payload tgz）→ 只漏一个时 WARN 只列那一个 ---
# 实测教训：只清目录会漏掉中间那个 ~150MB 的 .stage.*.payload.tar.gz。
dir="$(make_dir case7dir 1024)"
tgz="${TEST_TMP}/case7.payload.tar.gz"
head -c 2048 /dev/zero > "${tgz}" 2>/dev/null
WARN_LOG=''
# 用例 6 把 warn 卸掉了（为了验内置 printf 兜底），这里装回来再继续收集。
warn() { WARN_LOG="${WARN_LOG}$*"$'\n'; }
# stub：目录能删，*.payload.tar.gz 删不掉（用「被占用/守卫拦文件」等效形态）
rm() {
  case "${2:-}" in
    *.payload.tar.gz) return 1 ;;
    *) command rm -rf "$@" ;;
  esac
}
stage_cleanup "${dir}" "${tgz}"
rc=$?
unset -f rm
has_tgz=no; has_dir=no
case "${WARN_LOG}" in *"${tgz}"*) has_tgz=yes ;; esac
case "${WARN_LOG}" in *"${dir}"*) has_dir=yes ;; esac
if [ "${rc}" -eq 0 ] && [ ! -e "${dir}" ] && [ -e "${tgz}" ] \
   && [ "${has_tgz}" = yes ] && [ "${has_dir}" = no ]; then
  ok '变参清理：删掉的目录不报、没删掉的 tgz 单独列出，rc=0'
else
  ng "变参清理：rc=${rc} dir_exists=$([ -e "${dir}" ] && echo yes || echo no) tgz=$([ -e "${tgz}" ] && echo yes || echo no) in_warn(tgz)=${has_tgz} in_warn(dir)=${has_dir}"
fi

printf '[test] ---------------------------------------------\n'
printf '[test] %d pass / %d fail\n' "${PASS}" "${FAIL}"

# 清场（用 command 绕过可能残留的 stub）
command rm -rf "${TEST_TMP}" 2>/dev/null || true

[ "${FAIL}" -eq 0 ] || exit 1
exit 0
