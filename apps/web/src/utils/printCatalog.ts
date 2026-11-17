import {
  ITEM_STATUS_LABELS,
  RETENTION_LABELS,
  SECURITY_LEVEL_LABELS,
  type ItemDto,
  type VolumeDto,
} from '@tianji/shared';

/**
 * 著录打印工具（P5）。
 *
 * 沿用 utils/print.ts 的既有模式：新窗口手写 A4 HTML，与页面 UI / MUI 样式解耦，
 * 打印时不受侧边栏、弹窗与 emotion 样式丢失影响；文档内自动触发 window.print()。
 */
const esc = (v: string | number | null | undefined): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const PRINT_STYLE = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Songti SC", SimSun, "Microsoft YaHei", serif; color: #111; font-size: 11pt; }
  h1 { text-align: center; font-size: 19pt; letter-spacing: 3px; margin: 0 0 3mm; font-weight: 600; }
  .sub { text-align: center; font-size: 9pt; color: #555; margin-bottom: 7mm; }
  table { width: 100%; border-collapse: collapse; margin-top: 3mm; }
  th, td { border: 1px solid #333; padding: 1.8mm 2.2mm; font-size: 9.5pt; vertical-align: top; }
  th { background: #f4f4f4; text-align: center; }
  td.c, th.c { text-align: center; }
  .cover { border: 2px solid #333; padding: 10mm 8mm; min-height: 90mm; }
  .cover .row { display: flex; border-bottom: 1px solid #bbb; padding: 2.5mm 0; }
  .cover .k { width: 26mm; color: #444; flex: 0 0 26mm; }
  .cover .v { flex: 1; }
  .cover .title-line { font-size: 18pt; text-align: center; padding: 16mm 0 12mm; font-weight: 600; }
  .stats { display: flex; gap: 8mm; }
  .stats > div { flex: 1; }
  .foot { margin-top: 6mm; font-size: 8.5pt; color: #666; }
  @media print { .noprint { display: none; } }
`;

function openPrint(title: string, body: string): void {
  const html =
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" />' +
    `<title>${esc(title)}</title><style>${PRINT_STYLE}</style></head><body>` +
    body +
    '<div class="noprint" style="margin-top:10mm;text-align:center">' +
    '<button onclick="window.print()" style="padding:6px 18px;font-size:14px">打印 / 另存为 PDF</button>' +
    '</div><script>window.onload=function(){setTimeout(function(){window.print();},300);};</script>' +
    '</body></html>';
  const win = window.open('', '_blank', 'width=1000,height=1000');
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
}

function itemsTable(items: ItemDto[]): string {
  const rows = items
    .map(
      (it, i) =>
        `<tr><td class="c">${i + 1}</td><td>${esc(it.danghao)}</td><td>${esc(it.title)}</td>` +
        `<td>${esc(it.responsible)}</td><td class="c">${esc(it.docDate ?? '')}</td>` +
        `<td class="c">${esc(SECURITY_LEVEL_LABELS[it.securityLevel] ?? it.securityLevel)}</td>` +
        `<td class="c">${esc(it.pages ?? '')}</td></tr>`,
    )
    .join('');
  return (
    '<table><thead><tr><th class="c" style="width:12mm">序号</th>' +
    '<th style="width:52mm">档号</th><th>题名</th><th style="width:30mm">责任者</th>' +
    '<th class="c" style="width:24mm">形成日期</th><th class="c" style="width:16mm">密级</th>' +
    '<th class="c" style="width:14mm">页数</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="7" class="c" style="color:#888">暂无条目</td></tr>') +
    '</tbody></table>'
  );
}

/** 条目打印：档号/题名/责任者/日期/密级/页数表格 */
export function printItems(items: ItemDto[], title = '档 案 条 目 目 录'): void {
  const body =
    `<h1>${esc(title)}</h1>` +
    `<div class="sub">共 ${items.length} 条 ｜ 打印时间：${new Date().toLocaleString('zh-CN')}</div>` +
    itemsTable(items) +
    '<div class="foot">说明：本目录按档号升序排列；密级为国家秘密事项的，按保密规定管理。</div>';
  openPrint(title, body);
}

/** 卷内打印：案卷卷封 + 卷内目录 */
export function printVolume(volume: VolumeDto, items: ItemDto[]): void {
  const cover =
    '<div class="cover">' +
    '<div class="title-line">案 卷 封 面</div>' +
    `<div class="row"><span class="k">档号</span><span class="v">${esc(volume.danghao)}</span></div>` +
    `<div class="row"><span class="k">案卷题名</span><span class="v">${esc(volume.title)}</span></div>` +
    `<div class="row"><span class="k">年度</span><span class="v">${esc(volume.year)}</span></div>` +
    `<div class="row"><span class="k">责任者</span><span class="v">${esc(volume.responsible)}</span></div>` +
    `<div class="row"><span class="k">保管期限</span><span class="v">${esc(RETENTION_LABELS[volume.retention] ?? volume.retention)}</span></div>` +
    `<div class="row"><span class="k">密级</span><span class="v">${esc(SECURITY_LEVEL_LABELS[volume.securityLevel] ?? volume.securityLevel)}</span></div>` +
    `<div class="row"><span class="k">件数</span><span class="v">${esc(volume.itemCount)}</span></div>` +
    '</div>';
  const body =
    '<h1>卷 内 目 录</h1>' +
    `<div class="sub">案卷：${esc(volume.danghao)} ${esc(volume.title)} ｜ 打印时间：${new Date().toLocaleString('zh-CN')}</div>` +
    cover +
    itemsTable(items);
  openPrint(`卷内目录 ${volume.danghao}`, body);
}

/** 编目打印：条目清单 + 分类统计（保管期限 / 密级 / 年度） */
export function printCatalog(items: ItemDto[]): void {
  const countBy = (pick: (it: ItemDto) => string): Array<[string, number]> => {
    const map = new Map<string, number>();
    for (const it of items) {
      const k = pick(it) || '未分类';
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  };
  const statTable = (title: string, rows: Array<[string, number]>): string =>
    `<div><table><thead><tr><th>${esc(title)}</th><th class="c" style="width:20mm">数量</th></tr></thead>` +
    `<tbody>${rows.map(([k, n]) => `<tr><td>${esc(k)}</td><td class="c">${n}</td></tr>`).join('') || '<tr><td colspan="2" class="c" style="color:#888">无</td></tr>'}</tbody></table></div>`;

  const stats =
    '<div class="stats">' +
    statTable(
      '按保管期限',
      countBy((it) => RETENTION_LABELS[it.retention] ?? it.retention),
    ) +
    statTable(
      '按密级',
      countBy((it) => SECURITY_LEVEL_LABELS[it.securityLevel] ?? it.securityLevel),
    ) +
    statTable(
      '按年度',
      countBy((it) => String(it.year ?? '')),
    ) +
    '</div>';

  const body =
    '<h1>档 案 编 目 清 册</h1>' +
    `<div class="sub">共 ${items.length} 条 ｜ 打印时间：${new Date().toLocaleString('zh-CN')}</div>` +
    stats +
    '<h3 style="margin-top:7mm;font-size:12pt">著录清单</h3>' +
    itemsTable(items) +
    '<div class="foot">说明：状态口径 —— ' +
    Object.values(ITEM_STATUS_LABELS).join(' / ') +
    '。</div>';
  openPrint('档案编目清册', body);
}
