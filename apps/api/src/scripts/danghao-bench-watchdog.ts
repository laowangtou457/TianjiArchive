/**
 * 压测轮级看门狗（缺陷 #11 的「工具不喊疼」防护）。
 *
 * 背景（2026-11-07 联调现场）：`CONCURRENCY=200 ROUNDS=10 perf:danghao`
 * 在容器内挂起 18 分钟零进展——档号生成路径在持有事务连接时经全局
 * repository 二次申请池连接，并发 > 连接池上限即自死锁（20 会话
 * idle in transaction / last query START TRANSACTION / ClientRead，
 * pg_stat_activity 取证）。生成路径的修复在 rule.service.ts，本模块
 * 是独立的第二道防线：**无论何种原因导致一轮迟迟不完，看门狗必须
 * 喊疼报错退出，而不是静默挂起烧掉整个联调窗口**。
 *
 * 刻意零 DB / 零 Nest 依赖，供单测直接 import（同 danghao-bench-judge
 * 的拆分理由：bench 主脚本顶层初始化 AppDataSource，不可被测试 import）。
 */

/** 注入的定时器接口（单测可用假实现替换真实计时） */
export interface WatchdogTimer {
  set: (cb: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

/** 默认定时器：Node setTimeout/clearTimeout；句柄 unref，避免计时器本身撑住进程 */
const nodeTimer: WatchdogTimer = {
  set: (cb, ms) => {
    const handle = setTimeout(cb, ms);
    // unref 后即使事件循环只剩看门狗，进程也可自然退出（正常路径已 disarm 时无碍）
    (handle as NodeJS.Timeout).unref?.();
    return handle;
  },
  clear: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/**
 * 在 timeoutMs 后触发一次 onTimeout；返回撤防函数。
 *
 * 语义（全部可单测）：
 *   - 撤防（调用返回的函数）后 onTimeout **绝不**触发；
 *   - 未撤防则到点恰好触发一次（重复触发无意义——喊疼一次就够）；
 *   - 撤防可安全调用多次（幂等）。
 *
 * @param timeoutMs 超时毫秒数（调用方负责做下限保护）
 * @param onTimeout 超时回调（bench 传「打印诊断 + process.exit(2)」）
 * @param timer 可选假定时器（单测注入，替换真实等待）
 * @returns 撤防函数
 */
export function armWatchdog(
  timeoutMs: number,
  onTimeout: () => void,
  timer: WatchdogTimer = nodeTimer,
): () => void {
  let fired = false;
  let disarmed = false;
  const handle = timer.set(() => {
    if (disarmed || fired) return;
    fired = true;
    onTimeout();
  }, timeoutMs);
  return () => {
    if (disarmed) return;
    disarmed = true;
    timer.clear(handle);
  };
}
