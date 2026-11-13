import {
  BORROW_MODE_LABELS,
  BORROW_STATUS_LABELS,
  SECURITY_LEVEL_LABELS,
  type BorrowOrderDto,
} from '@tianji/shared';

/**
 * 打印「档案利用单」（对齐泰坦「打印利用单」）。
 *
 * 为什么用新窗口手写 HTML 而不是 CSS @media print 改造页面：
 *  - 利用单是**对外单据**，版式必须与页面 UI 解耦（改页面不该改单据）；
 *  - 新窗口打印不会被侧边栏/弹窗裁切，A4 边距可控；
 *  - 页面样式（MUI emotion）在打印时容易丢失，独立文档最稳。
 *
 * 单据内容口径（档案利用业务的必备项）：
 *   利用者、档号、题名、密级、利用方式、利用目的、借出/应还日期、审批意见、签字栏。
 */
export function printBorrowSlip(order: BorrowOrderDto): void {
  const esc = (v: string | number | null | undefined): string =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const approvals = order.approvals
    .map(
      (a) =>
        `<tr><td>${esc(a.level)} 级</td><td>${esc(a.action === 'APPROVE' ? '同意' : '驳回')}</td>` +
        `<td>${esc(a.opinion)}</td><td>${new Date(a.actedAt).toLocaleString('zh-CN')}</td></tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>档案利用单 ${esc(order.orderNo)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Songti SC", SimSun, "Microsoft YaHei", serif; color: #111; font-size: 12pt; }
  h1 { text-align: center; font-size: 20pt; letter-spacing: 4px; margin: 0 0 4mm; font-weight: 600; }
  .sub { text-align: center; font-size: 9pt; color: #555; margin-bottom: 8mm; }
  table { width: 100%; border-collapse: collapse; }
  .meta td { border: 1px solid #333; padding: 2.5mm 3mm; vertical-align: top; }
  .meta td.k { width: 26mm; background: #f4f4f4; text-align: center; white-space: nowrap; }
  .list { margin-top: 6mm; }
  .list th, .list td { border: 1px solid #333; padding: 2mm 2.5mm; font-size: 10.5pt; }
  .list th { background: #f4f4f4; }
  .sign { margin-top: 12mm; display: flex; justify-content: space-between; gap: 10mm; }
  .sign div { flex: 1; border-top: 1px solid #333; padding-top: 2mm; font-size: 10pt; color: #333; }
  .note { margin-top: 8mm; font-size: 9pt; color: #555; line-height: 1.7; }
  @media print { .noprint { display: none; } }
</style></head>
<body>
  <h1>档 案 利 用 单</h1>
  <div class="sub">单号：${esc(order.orderNo)} ｜ 打印时间：${new Date().toLocaleString('zh-CN')}</div>

  <table class="meta">
    <tr><td class="k">利用者</td><td>${esc(order.applicantName)}</td>
        <td class="k">密级</td><td>${esc(SECURITY_LEVEL_LABELS[order.itemSecurityLevel])}</td></tr>
    <tr><td class="k">档号</td><td colspan="3" style="font-family:Consolas,monospace">${esc(order.itemDanghao)}</td></tr>
    <tr><td class="k">题名</td><td colspan="3">${esc(order.itemTitle)}</td></tr>
    <tr><td class="k">利用方式</td><td>${esc(BORROW_MODE_LABELS[order.mode])}</td>
        <td class="k">当前状态</td><td>${esc(BORROW_STATUS_LABELS[order.status])}</td></tr>
    <tr><td class="k">借出日期</td><td>${esc(order.borrowDate ?? '未借出')}</td>
        <td class="k">应还日期</td><td>${esc(order.expectReturn)}</td></tr>
    <tr><td class="k">实际归还</td><td colspan="3">${
      order.actualReturn ? new Date(order.actualReturn).toLocaleString('zh-CN') : '未归还'
    }${order.overdue ? '（已逾期）' : ''}</td></tr>
    <tr><td class="k">利用目的</td><td colspan="3">${esc(order.purpose)}</td></tr>
  </table>

  <table class="list">
    <thead><tr><th style="width:16mm">级别</th><th style="width:20mm">结论</th><th>审批意见</th><th style="width:44mm">审批时间</th></tr></thead>
    <tbody>${approvals || '<tr><td colspan="4" style="text-align:center;color:#888">尚无审批记录</td></tr>'}</tbody>
  </table>

  <div class="sign">
    <div>利用者签字</div>
    <div>经办人签字</div>
    <div>归还确认（经办人）</div>
  </div>

  <div class="note">
    说明：1）本单为档案利用凭证，请妥善保存；2）利用者应按审批范围使用档案，不得复制、传播或用于申请之外的用途；
    3）档案原件借出须按期归还，逾期将暂停其借阅权限；4）涉密档案的利用按保密规定执行。
  </div>

  <div class="noprint" style="margin-top:10mm;text-align:center">
    <button onclick="window.print()" style="padding:6px 18px;font-size:14px">打印 / 另存为 PDF</button>
  </div>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 300); };</script>
</body></html>`;

  const win = window.open('', '_blank', 'width=900,height=1000');
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
}
