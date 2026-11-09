#!/usr/bin/env bash
# =============================================================================
# 收尾清理：**容忍失败，但必须喊得响**（被 build-server-package.sh source）
#
# 为什么容忍失败：
#   这句 rm 发生在 G1/G2/G3 全过、产物摘要已打印**之后**。到这一刻「产物是否可用」
#   已经有答案了，而退出码是给流水线用的，语义必须是「产物是否可用」——不能因为
#   一个临时目录删不掉，就把一次成功构建改判为失败（真机上因此白等过一轮）。
#
# 为什么不许静默吞（禁止 `|| true`）：
#   「守卫拦下了」和「真删失败（权限 / 文件被占用 / 只读挂载）」在现场都值得知道，
#   两者都会让磁盘持续泄漏（实测一次泄漏 ~150MB，四个 stage 目录堆到 2.0G，
#   而那台机器刚因为磁盘写满瘫过一次）。所以走 warn，把**路径、大小、话术**打全。
#
# 清理对象有两类，都要清（构建机上实测：只清目录会漏掉 ~150MB 的 payload tgz）：
#   .stage.XXXXXX/                  组装用的暂存目录
#   .stage.XXXXXX.payload.tar.gz    中间的 payload 压缩包（必须在 STAGE 外面，
#                                   否则 tar 会把自己读进去，报 file changed as we read it）
#
# 约定：
#   stage_cleanup <path>...  变参；幂等；路径为空/不存在直接跳过；
#                            **无论成功失败都返回 0**。
#   warn                     调用方（构建脚本）提供的日志函数；未定义时走内置 printf。
# =============================================================================

# _stage_cleanup_warn <msg>
#   调用方的 warn 优先，缺省用同格式 printf 兜底（保证本文件可被测试脚本单独 source）。
_stage_cleanup_warn() {
  if declare -F warn >/dev/null 2>&1; then
    warn "$*"
  else
    printf '[package] WARN: %s\n' "$*" >&2
  fi
}

# stage_cleanup <path>...
#   逐个删除收尾产物；有任何一个没删掉（或被守卫拦截、或 rm 假成功）就打 warn，
#   但**始终返回 0**。
stage_cleanup() {
  local path=''
  local size=''
  local -a failed=()
  local -a failed_sizes=()
  local i=0
  local detail=''

  for path in "$@"; do
    # 空路径绝不能进 rm -rf：`rm -rf ""` 在部分实现下等价于当前目录。
    if [ -z "${path}" ] || [ ! -e "${path}" ]; then
      continue
    fi

    # 两道判据：rm 的退出码 + 路径真的没了。
    # 只看退出码会漏掉「守卫把 rm 变成了 no-op」这类假成功（守卫拦批量删除时的常见形态）。
    if rm -rf "${path}" 2>/dev/null && [ ! -e "${path}" ]; then
      continue
    fi

    size="$(du -sh "${path}" 2>/dev/null | awk '{print $1}')"
    failed+=("${path}")
    failed_sizes+=("${size:-未知}")
  done

  if [ "${#failed[@]}" -eq 0 ]; then
    return 0
  fi

  for i in "${!failed[@]}"; do
    detail="${detail}"$'\n'"    - ${failed[$i]}（残留大小 ${failed_sizes[$i]}）"
  done

  _stage_cleanup_warn "收尾清理失败，以下临时项仍在：${detail}
  产物不受影响，但这些都是构建中间物，不是交付物，手工清理前不要把它们当交付物分发。
  处置优先级：
    ① 下次构建用 --out 指到专门的临时目录，打完整体丢弃（推荐）
    ② 手工清理：rm -rf <上面列出的路径>
    ③ 本机装了 safe-delete 守卫时，给产物目录配白名单（需人工操作，脚本不做）"

  # 关键：不把清理结果传染给构建的退出码。
  return 0
}
