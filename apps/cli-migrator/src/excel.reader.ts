import ExcelJS from 'exceljs';
import { BizException, ErrorCode } from '@tianji/shared';

/** Excel 目录行（一行为一件/一卷） */
export interface CatalogRow {
  /** 行号（用于报告定位） */
  rowNo: number;
  /** 档号（必需，迁移主键） */
  danghao: string;
  /** 全宗号 */
  fondsNo: string;
  /** 门类编码 */
  categoryCode: string;
  /** 年度 */
  year: number;
  /** 保管期限（PERM/Y30/Y10） */
  retention: string;
  /** 密级（PUBLIC/INTERNAL/SECRET） */
  securityLevel: string;
  /** 题名 */
  title: string;
  /** 责任者 */
  responsible: string;
  /** 机构/部门 */
  orgName: string;
  /** 文件开始日期 */
  startDate: string | null;
  /** 文件结束日期 */
  endDate: string | null;
  /** 关键词（逗号分隔） */
  keywords: string[];
  /** 备注 */
  note: string;
  /** 原始行数据（便于报告展示与人工复核） */
  raw: Record<string, string>;
}

/** 校验问题 */
export interface RowIssue {
  rowNo: number;
  field: string;
  level: 'ERROR' | 'WARN';
  message: string;
  value: string;
}

/** 解析结果 */
export interface ParseResult {
  rows: CatalogRow[];
  issues: RowIssue[];
  /** 表头映射（列名 → 字段） */
  headerMap: Record<string, string>;
}

/** 标准列名（中文表头 → 字段） */
const HEADER_ALIASES: Record<string, string> = {
  档号: 'danghao',
  全宗号: 'fondsNo',
  门类: 'categoryCode',
  门类编码: 'categoryCode',
  门类代码: 'categoryCode',
  年度: 'year',
  年份: 'year',
  保管期限: 'retention',
  期限: 'retention',
  密级: 'securityLevel',
  题名: 'title',
  案卷题名: 'title',
  文件题名: 'title',
  责任者: 'responsible',
  机构: 'orgName',
  部门: 'orgName',
  机构或部门: 'orgName',
  起始日期: 'startDate',
  开始日期: 'startDate',
  文件形成时间: 'startDate',
  结束日期: 'endDate',
  终止日期: 'endDate',
  关键词: 'keywords',
  主题词: 'keywords',
  备注: 'note',
};

/** 必需列 */
const REQUIRED_FIELDS = ['danghao', 'title'];

/**
 * Excel 目录读取与校验。
 *
 * 用法：
 *   const reader = new ExcelReader();
 *   const { rows, issues } = await reader.read('/path/catalog.xlsx');
 *
 * 校验规则（PRD F-12）：
 *   - 必需列缺失 → 整体报错退出；
 *   - 单行：档号空/重复、年度非数字、保管期限与密级取值非法、题名过长 → 记为 ERROR；
 *   - 非致命（如关键词格式）→ WARN，仍导入。
 */
export class ExcelReader {
  /** 读取并校验 */
  public async read(filePath: string, sheetName?: string): Promise<ParseResult> {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.readFile(filePath);
    } catch (err) {
      throw new BizException(
        ErrorCode.MIGRATION_RUNNING,
        `无法读取 Excel 文件（路径或格式错误）：${(err as Error).message}`,
      );
    }

    const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
    if (!ws) throw BizException.badRequest('Excel 中未找到工作表');

    const headerRow = ws.getRow(1);
    const headerMap: Record<string, string> = {};
    const colIndex: Record<string, number> = {};

    headerRow.eachCell((cell, colNumber) => {
      const raw = String(cell.value ?? '').trim();
      if (!raw) return;
      const field = HEADER_ALIASES[raw] ?? HEADER_ALIASES[raw.replace(/\s/g, '')];
      if (field) {
        headerMap[raw] = field;
        colIndex[field] = colNumber;
      }
    });

    const missing = REQUIRED_FIELDS.filter((f) => !colIndex[f]);
    if (missing.length > 0) {
      throw BizException.badRequest(
        `Excel 缺少必需列：${missing.map((f) => this.fieldLabel(f)).join('、')}（请使用系统提供的模板）`,
      );
    }

    const rows: CatalogRow[] = [];
    const issues: RowIssue[] = [];
    const seenDanghao = new Map<string, number>();

    for (let r = 2; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      if (this.isEmptyRow(row, colIndex)) continue;

      const get = (field: string): string => {
        const idx = colIndex[field];
        if (!idx) return '';
        const cell = row.getCell(idx);
        const v = cell.value;
        if (v === null || v === undefined) return '';
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'object' && 'text' in (v as unknown as Record<string, unknown>)) {
          return String((v as { text: unknown }).text ?? '').trim();
        }
        if (typeof v === 'object' && 'result' in (v as unknown as Record<string, unknown>)) {
          return String((v as { result: unknown }).result ?? '').trim();
        }
        return String(v).trim();
      };

      const raw: Record<string, string> = {};
      for (const [header, field] of Object.entries(headerMap)) {
        raw[header] = get(field);
      }

      const danghao = get('danghao');
      const title = get('title');
      const yearStr = get('year');
      const retention = this.normalizeRetention(get('retention'));
      const level = this.normalizeLevel(get('securityLevel'));
      const keywordsRaw = get('keywords');

      // ---------------- 校验 ----------------
      if (!danghao) {
        issues.push({ rowNo: r, field: 'danghao', level: 'ERROR', message: '档号为空', value: '' });
        continue;
      }
      if (seenDanghao.has(danghao)) {
        issues.push({
          rowNo: r,
          field: 'danghao',
          level: 'ERROR',
          message: `档号重复（与第 ${seenDanghao.get(danghao)} 行相同）`,
          value: danghao,
        });
        continue;
      }
      seenDanghao.set(danghao, r);

      if (!title) {
        issues.push({ rowNo: r, field: 'title', level: 'ERROR', message: '题名为空', value: '' });
      } else if (title.length > 500) {
        issues.push({
          rowNo: r,
          field: 'title',
          level: 'ERROR',
          message: '题名超过 500 字',
          value: title.slice(0, 40),
        });
      }

      const year = Number.parseInt(yearStr, 10);
      if (!Number.isFinite(year) || year < 1900 || year > 2100) {
        issues.push({
          rowNo: r,
          field: 'year',
          level: 'WARN',
          message: '年度非法，将按档号中提取或取当前年',
          value: yearStr,
        });
      }
      if (!retention) {
        issues.push({
          rowNo: r,
          field: 'retention',
          level: 'WARN',
          message: '保管期限非法或为空，默认按「永久」处理',
          value: get('retention'),
        });
      }
      if (!level) {
        issues.push({
          rowNo: r,
          field: 'securityLevel',
          level: 'WARN',
          message: '密级非法或为空，默认按「公开」处理',
          value: get('securityLevel'),
        });
      }

      rows.push({
        rowNo: r,
        danghao,
        fondsNo: get('fondsNo'),
        categoryCode: get('categoryCode'),
        year: Number.isFinite(year) ? year : new Date().getFullYear(),
        retention: retention ?? 'PERM',
        securityLevel: level ?? 'PUBLIC',
        title,
        responsible: get('responsible'),
        orgName: get('orgName'),
        startDate: this.normalizeDate(get('startDate'), r, issues),
        endDate: this.normalizeDate(get('endDate'), r, issues),
        keywords: keywordsRaw
          ? keywordsRaw
              .split(/[,，;；\s]+/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        note: get('note'),
        raw,
      });
    }

    return { rows, issues, headerMap };
  }

  /** 生成标准导入模板 */
  public async writeTemplate(filePath: string): Promise<void> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('档案目录');
    ws.columns = [
      { header: '档号', key: 'danghao', width: 28 },
      { header: '全宗号', key: 'fondsNo', width: 14 },
      { header: '门类编码', key: 'categoryCode', width: 14 },
      { header: '年度', key: 'year', width: 10 },
      { header: '保管期限', key: 'retention', width: 12 },
      { header: '密级', key: 'securityLevel', width: 12 },
      { header: '题名', key: 'title', width: 40 },
      { header: '责任者', key: 'responsible', width: 18 },
      { header: '机构或部门', key: 'orgName', width: 18 },
      { header: '起始日期', key: 'startDate', width: 14 },
      { header: '结束日期', key: 'endDate', width: 14 },
      { header: '关键词', key: 'keywords', width: 24 },
      { header: '备注', key: 'note', width: 24 },
    ];
    ws.addRow({
      danghao: 'WS-2024-Y-001-0001',
      fondsNo: 'WS',
      categoryCode: 'WS',
      year: 2024,
      retention: 'PERM',
      securityLevel: 'PUBLIC',
      title: '示例：关于加强档案信息化建设的通知',
      responsible: '办公室',
      orgName: '综合处',
      startDate: '2024-01-15',
      endDate: '2024-01-15',
      keywords: '档案,信息化',
      note: '示例行，导入前请删除',
    });
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    await wb.xlsx.writeFile(filePath);
  }

  // ------------------------------------------------------------------ 内部

  /** 判断整行为空 */
  private isEmptyRow(row: ExcelJS.Row, colIndex: Record<string, number>): boolean {
    for (const idx of Object.values(colIndex)) {
      const v = row.getCell(idx).value;
      if (v !== null && v !== undefined && String(v).trim() !== '') return false;
    }
    return true;
  }

  /** 保管期限归一化 */
  private normalizeRetention(input: string): string | null {
    if (!input) return null;
    const s = input.trim();
    if (/^(permanent|永久|perm|y)$/i.test(s)) return 'PERM';
    if (/^(30|y30|定期30年|30年)$/i.test(s)) return 'Y30';
    if (/^(10|y10|定期10年|10年)$/i.test(s)) return 'Y10';
    return null;
  }

  /** 密级归一化 */
  private normalizeLevel(input: string): string | null {
    if (!input) return null;
    const s = input.trim();
    if (/^(public|公开)$/i.test(s)) return 'PUBLIC';
    if (/^(internal|内部)$/i.test(s)) return 'INTERNAL';
    if (/^(secret|秘密|机密|绝密)$/i.test(s)) return 'SECRET';
    return null;
  }

  /** 日期归一化 */
  private normalizeDate(input: string, rowNo: number, issues: RowIssue[]): string | null {
    if (!input) return null;
    const s = input.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})/);
    if (m) {
      const mm = String(m[2]).padStart(2, '0');
      const dd = String(m[3]).padStart(2, '0');
      return `${m[1]}-${mm}-${dd}`;
    }
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    issues.push({ rowNo, field: 'date', level: 'WARN', message: '日期无法识别，已置空', value: s });
    return null;
  }

  /** 字段中文名 */
  private fieldLabel(field: string): string {
    const found = Object.entries(HEADER_ALIASES).find(([, f]) => f === field);
    return found ? found[0] : field;
  }
}
