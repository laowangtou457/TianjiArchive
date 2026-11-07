import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BORROW_MIN_DAYS,
  BORROW_RULES_FALLBACK,
  BizException,
  ErrorCode,
  PARAM_DEFS,
  getParamDef,
  isDirectReadParam,
  parseStrictInt,
  validateCrossParams,
  validateParamValue,
  type BorrowRules,
  type ParamConflict,
  type ParamDef,
  type ParamView,
} from '@tianji/shared';
import { SystemParam } from '../../infra/database/entities/system-param.entity';
import { CACHE_KEY, CACHE_TTL } from '../../common/constants/enums';
import { RedisService } from '../../infra/redis/redis.module';

/** 参数变更事件（跨实例广播载荷） */
export interface ParamInvalidatePayload {
  /** 变更的 key；空数组表示全量失效 */
  keys: string[];
  /** 触发者（审计追溯用） */
  by?: string;
  /** 变更时间戳（毫秒），用于丢弃乱序消息 */
  at: number;
}

/** 单个参数的读取结果（含来源信息，便于排查「改了不生效」） */
export interface ParamReadResult {
  key: string;
  value: string;
  /** 来源：db=直读库 / cache=缓存命中 / default=未配置回落默认值 */
  source: 'db' | 'cache' | 'default';
}

/**
 * 业务参数服务（F-14 / PRD 5.5.1 PR-P1 ~ PR-P8，架构 §4.3）。
 *
 * 设计要点：
 *
 * ① **唯一定义源**：取值区间、类型、分组、可编辑性全部来自 `PARAM_DEFS`
 *    （`@tianji/shared`），本服务不重复声明任何业务口径。
 *
 * ② **分级读取（PR-P8）**：`grp ∈ {security, preview}` 直读数据库，绕开 Redis。
 *    理由：安全类参数（会话超时、下载模式、水印）变更必须**下一次请求**即生效，
 *    不能依赖「缓存失效消息有没有送到」——广播丢失就是安全事件。
 *    其余分组走 60s 缓存 + `param:invalidate` 主动失效（PR-P2）。
 *
 * ③ **fail-safe 而非 fail-open**：参数缺失/非法时回落 `PARAM_DEFS.default`，
 *    并对**越界值**额外告警——宁可回到出厂口径，也不让脏数据把业务算坏。
 *
 * ④ **变更即校验**：`upsert()` 同时做单值区间校验与跨参数约束（C-1~C-5），
 *    一次性返回全部冲突，避免管理员逐条试错。
 */
@Injectable()
export class ParamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ParamService.name);

  /** 进程级参数缓存（key → value），仅服务非直读分组 */
  private readonly local = new Map<string, string>();

  /** 订阅者引用（用于优雅退订） */
  private subscriber: ReturnType<RedisService['duplicateForSubscribe']> | null = null;

  public constructor(
    @InjectRepository(SystemParam) private readonly paramRepo: Repository<SystemParam>,
    private readonly redis: RedisService,
  ) {}

  // ==========================================================================
  // 生命周期：订阅失效广播
  // ==========================================================================

  public async onModuleInit(): Promise<void> {
    // 进程内缓存跟随 Redis 广播失效：多实例部署时，A 实例改参数 → B 实例收到消息
    // → 清掉自己的进程缓存，下一次读取回源数据库。
    try {
      this.subscriber = this.redis.duplicateForSubscribe();
      await this.subscriber.subscribe(CACHE_KEY.PARAM_CHANNEL);
      this.subscriber.on('message', (channel: string, raw: string) => {
        if (channel !== CACHE_KEY.PARAM_CHANNEL) return;
        this.handleInvalidateMessage(raw);
      });
      this.logger.log(`已订阅参数失效通道 ${CACHE_KEY.PARAM_CHANNEL}`);
    } catch (err) {
      // 订阅失败不阻断启动：直读分组不受影响，缓存分组退化为 60s TTL 自然过期
      this.logger.error(`订阅参数失效通道失败，缓存分组退化为 TTL 自然过期: ${(err as Error).message}`);
    }
  }

  public async onModuleDestroy(): Promise<void> {
    try {
      if (this.subscriber) {
        await this.subscriber.unsubscribe(CACHE_KEY.PARAM_CHANNEL);
        await this.subscriber.quit();
        this.subscriber = null;
      }
    } catch {
      /* 退出期忽略 */
    }
  }

  /** 处理失效广播 */
  private handleInvalidateMessage(raw: string): void {
    let payload: ParamInvalidatePayload | null = null;
    try {
      payload = JSON.parse(raw) as ParamInvalidatePayload;
    } catch {
      payload = null;
    }
    if (!payload || !Array.isArray(payload.keys)) {
      this.local.clear();
      this.logger.warn('收到无法解析的参数失效消息，已清空进程内参数缓存');
      return;
    }
    if (payload.keys.length === 0) {
      this.local.clear();
    } else {
      for (const key of payload.keys) this.local.delete(key);
    }
    this.logger.debug(`参数缓存已失效：${payload.keys.length ? payload.keys.join(',') : '(全部)'}`);
  }

  // ==========================================================================
  // 读取
  // ==========================================================================

  /**
   * 读取单个参数（字符串）。
   *
   * 直读分组（security / preview）每次回源数据库；其余分组三级缓存
   * （进程内 → Redis → DB）。
   */
  public async get(key: string): Promise<string> {
    const def = getParamDef(key);
    if (!def) {
      // 未登记 key 一律拒绝：静默返回空串会让调用方拿错误口径继续跑
      throw new BizException(ErrorCode.BAD_REQUEST, `未登记的业务参数 key：${key}`);
    }

    if (isDirectReadParam(key)) {
      const row = await this.paramRepo.findOne({ where: { key } });
      if (!row) {
        this.logger.warn(`参数 ${key} 未在数据库配置，使用默认值 ${def.default}`);
        return def.default;
      }
      return this.normalizeValue(def, row.value);
    }

    const localHit = this.local.get(key);
    if (localHit !== undefined) return localHit;

    const cacheKey = `${CACHE_KEY.PARAM}${key}`;
    const redisHit = await this.redis.get(cacheKey);
    if (redisHit !== null) {
      const value = this.normalizeValue(def, redisHit);
      this.local.set(key, value);
      return value;
    }

    const row = await this.paramRepo.findOne({ where: { key } });
    const value = this.normalizeValue(def, row?.value ?? def.default);
    if (!row) this.logger.warn(`参数 ${key} 未在数据库配置，使用默认值 ${def.default}`);
    this.local.set(key, value);
    await this.redis.set(cacheKey, value, CACHE_TTL.PARAM);
    return value;
  }

  /** 读取整数参数（严格解析，非法回落默认值并告警） */
  public async getInt(key: string): Promise<number> {
    const def = getParamDef(key);
    if (!def) throw new BizException(ErrorCode.BAD_REQUEST, `未登记的业务参数 key：${key}`);
    const raw = await this.get(key);
    const n = parseStrictInt(raw);
    if (n === null) {
      const fallback = parseStrictInt(def.default) ?? 0;
      this.logger.error(`参数 ${key} 值「${raw}」不是合法整数，已回落默认值 ${fallback}`);
      return fallback;
    }
    if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
      const fallback = parseStrictInt(def.default) ?? 0;
      this.logger.error(
        `参数 ${key} 值 ${n} 超出合法区间 ${def.rangeText}，已回落默认值 ${fallback}`,
      );
      return fallback;
    }
    return n;
  }

  /** 读取布尔参数 */
  public async getBool(key: string): Promise<boolean> {
    const raw = (await this.get(key)).trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
  }

  /** 读取枚举参数（非法值回落默认值并告警） */
  public async getEnum(key: string): Promise<string> {
    const def = getParamDef(key);
    if (!def) throw new BizException(ErrorCode.BAD_REQUEST, `未登记的业务参数 key：${key}`);
    const raw = await this.get(key);
    const allowed = def.enumValues ?? [];
    if (!allowed.includes(raw)) {
      this.logger.error(`参数 ${key} 值「${raw}」不在枚举 ${allowed.join('/')} 内，已回落默认值`);
      return def.default;
    }
    return raw;
  }

  /** 读取逗号分隔列表参数 */
  public async getCsv(key: string): Promise<string[]> {
    const raw = await this.get(key);
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  /** 一次性读取多个参数（管理端列表/批量判定用，减少往返） */
  public async getMany(keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const key of keys) {
      out[key] = await this.get(key);
    }
    return out;
  }

  /** 读取全部已登记参数（管理端展开用） */
  public async getAll(): Promise<Record<string, string>> {
    return this.getMany(PARAM_DEFS.map((d) => d.key));
  }

  // ==========================================================================
  // 借阅规则（BORROW_RULES 的唯一取值入口）
  // ==========================================================================

  /**
   * 读取借阅规则（后端校验 + 前端展示共用同一份口径）。
   *
   * 并发防线的数值全部来自此处，**禁止**在业务代码里再写 90 / 30 / 1。
   */
  public async getBorrowRules(): Promise<BorrowRules> {
    const [maxTotalDays, maxRenewalCount, maxRenewalDays, defaultDays] = await Promise.all([
      this.getInt('borrow.max_total_days'),
      this.getInt('borrow.max_renewal_count'),
      this.getInt('borrow.max_renewal_days'),
      this.getInt('borrow.default_days'),
    ]);
    // 兜底：任何一项读到异常值（NaN / undefined）都会退化为出厂口径，
    // 绝不让 undefined 流进日期运算变成 NaN（QA 缺陷 #6 的假绿根因）。
    return {
      maxTotalDays: Number.isFinite(maxTotalDays) ? maxTotalDays : BORROW_RULES_FALLBACK.maxTotalDays,
      minDays: BORROW_MIN_DAYS,
      maxRenewalCount: Number.isFinite(maxRenewalCount)
        ? maxRenewalCount
        : BORROW_RULES_FALLBACK.maxRenewalCount,
      maxRenewalDays: Number.isFinite(maxRenewalDays)
        ? maxRenewalDays
        : BORROW_RULES_FALLBACK.maxRenewalDays,
      defaultDays: Number.isFinite(defaultDays) ? defaultDays : BORROW_RULES_FALLBACK.defaultDays,
    };
  }

  // ==========================================================================
  // 写入
  // ==========================================================================

  /**
   * 保存参数（含单值区间校验 + 跨参数约束校验）。
   *
   * @param key    参数 key（必须已在 PARAM_DEFS 登记）
   * @param value  新值（字符串形态）
   * @param by     操作人（审计追溯）
   * @throws BizException 400 未知 key / 值非法 / 不可编辑 / 跨参数冲突
   */
  public async upsert(key: string, value: string, by?: string): Promise<void> {
    const def = getParamDef(key);
    if (!def) {
      throw new BizException(ErrorCode.BAD_REQUEST, `未登记的业务参数 key：${key}`);
    }
    if (!def.editable) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `${def.label} 为合规固化项（PR-P7），不允许修改`,
      );
    }

    // ① 单值区间校验（PR-P4）
    const single = validateParamValue(key, value);
    if (!single.ok) {
      throw new BizException(ErrorCode.BAD_REQUEST, single.reason ?? `${def.label} 取值非法`);
    }

    // ② 跨参数约束校验（C-1 ~ C-5）：以「库中现值 + 本次改动」为视图
    const merged = await this.buildConstraintView(key, value);
    const conflicts = validateCrossParams(merged);
    const blocking = conflicts.filter((c) => c.blocking);
    if (blocking.length > 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        blocking.map((c) => `[${c.code}] ${c.message}`).join('；'),
        conflicts,
      );
    }
    // 非阻断冲突只告警，不拦保存（如容量估算超限）
    for (const c of conflicts.filter((x) => !x.blocking)) {
      this.logger.warn(`参数约束提示 [${c.code}] ${c.message}`);
    }

    // ③ 落库（UPSERT，避免依赖「种子必须已插入」）
    const normalized = this.serializeValue(def, value);
    await this.paramRepo
      .createQueryBuilder()
      .insert()
      .into(SystemParam)
      .values({ key, value: normalized, label: def.label, secret: false })
      .orUpdate(['param_value', 'label', 'updated_at'], ['param_key'])
      .execute();

    // ④ 主动失效（PR-P2）：即便直读分组不需要，也让其他实例的进程缓存干净
    await this.invalidate([key], by);
    this.logger.log(`参数已更新 ${key} = ${normalized}（操作人 ${by ?? 'system'}）`);
  }

  /** 批量保存（任一失败则整体不落库：先全量校验，再统一写入） */
  public async upsertMany(items: Array<{ key: string; value: string }>, by?: string): Promise<void> {
    // 先在内存里模拟出最终视图，一次性校验跨参数约束
    const view: Record<string, string> = {};
    for (const item of items) {
      const def = getParamDef(item.key);
      if (!def) throw new BizException(ErrorCode.BAD_REQUEST, `未登记的业务参数 key：${item.key}`);
      if (!def.editable) {
        throw new BizException(ErrorCode.BAD_REQUEST, `${def.label} 为合规固化项（PR-P7），不允许修改`);
      }
      const single = validateParamValue(item.key, item.value);
      if (!single.ok) throw new BizException(ErrorCode.BAD_REQUEST, single.reason ?? '取值非法');
      view[item.key] = item.value.trim();
    }

    const base = await this.getAll();
    const merged: Record<string, string> = { ...base, ...view };
    const conflicts = validateCrossParams(merged);
    const blocking = conflicts.filter((c) => c.blocking);
    if (blocking.length > 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        blocking.map((c) => `[${c.code}] ${c.message}`).join('；'),
        conflicts,
      );
    }

    for (const item of items) {
      const def = getParamDef(item.key) as ParamDef;
      const normalized = this.serializeValue(def, item.value);
      await this.paramRepo
        .createQueryBuilder()
        .insert()
        .into(SystemParam)
        .values({ key: item.key, value: normalized, label: def.label, secret: false })
        .orUpdate(['param_value', 'label', 'updated_at'], ['param_key'])
        .execute();
    }
    await this.invalidate(items.map((i) => i.key), by);
  }

  /** 校验一组「待保存值」的跨参数约束（管理端保存前预检，不落库） */
  public async checkCross(items: Array<{ key: string; value: string }>): Promise<ParamConflict[]> {
    const base = await this.getAll();
    const merged: Record<string, string> = { ...base };
    for (const item of items) merged[item.key] = item.value;
    return validateCrossParams(merged);
  }

  // ==========================================================================
  // 失效
  // ==========================================================================

  /**
   * 主动失效参数缓存（本地 + Redis + 广播）。
   *
   * @param keys 变更的 key；空数组表示全量失效
   * @param by   触发者
   */
  public async invalidate(keys: string[], by?: string): Promise<void> {
    for (const key of keys) {
      this.local.delete(key);
      await this.redis.del(`${CACHE_KEY.PARAM}${key}`);
    }
    if (keys.length === 0) {
      this.local.clear();
      await this.redis.delByPrefix(CACHE_KEY.PARAM);
    }

    const payload: ParamInvalidatePayload = { keys, by, at: Date.now() };
    await this.redis.publish(CACHE_KEY.PARAM_CHANNEL, JSON.stringify(payload));
  }

  // ==========================================================================
  // 内部工具
  // ==========================================================================

  /** 把库中原始值规范化：bool 统一小写、字符串去空白；非法值回落默认值 */
  private normalizeValue(def: ParamDef, raw: string | null | undefined): string {
    const text = (raw ?? '').trim();
    if (text === '') return def.default;
    if (def.type === 'bool') return text.toLowerCase() === 'true' ? 'true' : 'false';
    if (def.type === 'int') {
      const n = parseStrictInt(text);
      if (n === null) return def.default;
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        return def.default;
      }
      return String(n);
    }
    if (def.type === 'enum') {
      return (def.enumValues ?? []).includes(text) ? text : def.default;
    }
    return text;
  }

  /** 写入前的序列化（bool 小写、int 去前导零） */
  private serializeValue(def: ParamDef, raw: string): string {
    const text = raw.trim();
    if (def.type === 'bool') return text.toLowerCase();
    if (def.type === 'int') {
      const n = parseStrictInt(text);
      return n === null ? text : String(n);
    }
    return text;
  }

  /** 构造「库中现值 + 本次改动」的约束校验视图 */
  private async buildConstraintView(pendingKey: string, pendingValue: string): Promise<ParamView> {
    const base = await this.getAll();
    return { ...base, [pendingKey]: pendingValue.trim() };
  }
}
