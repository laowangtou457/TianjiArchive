import { api } from '../api/client';

/**
 * 条目导出前端工具（P5）。
 *
 * 后端 GET /archive/items/export 返回原始 CSV/XML 二进制流（带 BOM / UTF-8），
 * 因此走 api.download（responseType=blob）而不是 api.get（会错误解包信封）。
 * 服务端已做密级 + 数据范围行级过滤，前端只负责触发下载。
 */
export interface ExportItemsParams {
  /** 精确导出：条目 ID 列表；非空时优先于 volumeId */
  ids?: string[];
  /** 按案卷导出该卷全部符合过滤条件的件 */
  volumeId?: string;
  status?: string;
  keyword?: string;
}

export type ExportFormat = 'csv' | 'xml';

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function toQuery(params: ExportItemsParams, format: ExportFormat): Record<string, unknown> {
  const query: Record<string, unknown> = { format };
  if (params.ids && params.ids.length > 0) query.ids = params.ids.join(',');
  if (params.volumeId) query.volumeId = params.volumeId;
  if (params.status) query.status = params.status;
  if (params.keyword) query.keyword = params.keyword;
  return query;
}

/** 导出为 CSV（UTF-8 BOM，Excel 中文不乱码） */
export function downloadCsv(params: ExportItemsParams): Promise<void> {
  return api.download(
    '/archive/items/export',
    toQuery(params, 'csv'),
    `档案条目_${stamp()}.csv`,
  );
}

/** 导出为 XML（<items><item>…</item></items>） */
export function downloadXml(params: ExportItemsParams): Promise<void> {
  return api.download(
    '/archive/items/export',
    toQuery(params, 'xml'),
    `档案条目_${stamp()}.xml`,
  );
}

/** 按指定格式导出（菜单统一入口） */
export function exportItems(params: ExportItemsParams, format: ExportFormat): Promise<void> {
  return format === 'xml' ? downloadXml(params) : downloadCsv(params);
}
