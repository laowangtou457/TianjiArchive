/**
 * 工作台「最近使用功能」数据源。
 *
 * 侧栏菜单点击时写入 localStorage，工作台按「访问次数 + 最近时间」排序展示。
 * 纯前端、不上传，避免为展示偏好增加后端表；换浏览器/清缓存后自动回退到推荐入口。
 */

export interface RecentFeature {
  key: string;
  label: string;
  path: string;
  icon: string;
  /** 最近访问时间（毫秒时间戳） */
  ts: number;
  /** 累计访问次数 */
  count: number;
}

const STORAGE_KEY = 'tianji.recentFeatures';
const MAX_KEEP = 40;

export interface FeatureVisit {
  key: string;
  label: string;
  path: string;
  icon: string;
}

/** 记录一次菜单访问（同一功能累加次数并刷新时间） */
export function recordFeatureVisit(feature: FeatureVisit): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list: RecentFeature[] = raw ? (JSON.parse(raw) as RecentFeature[]) : [];
    const now = Date.now();
    const idx = list.findIndex((f) => f.key === feature.key);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...feature, ts: now, count: (list[idx].count ?? 0) + 1 };
    } else {
      list.unshift({ ...feature, ts: now, count: 1 });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_KEEP)));
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级，不影响导航
  }
}

/** 读取最近使用功能：次数优先、时间次之 */
export function getRecentFeatures(limit = 12): RecentFeature[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as RecentFeature[];
    if (!Array.isArray(list)) return [];
    return [...list]
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, limit);
  } catch {
    return [];
  }
}
