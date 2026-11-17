"""生成「泰坦功能树 × 天玑导航对照」文档与 CSV。

数据源：docs/泰坦功能树-原始数据.json（H2 T_S_PRIVILEGE 全量 4394 条）
输出：
  docs/泰坦功能树-天玑导航对照.md
  docs/泰坦功能树-天玑导航对照.csv
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'docs/泰坦功能树-原始数据.json'
MD_OUT = ROOT / 'docs/泰坦功能树-天玑导航对照.md'
CSV_OUT = ROOT / 'docs/泰坦功能树-天玑导航对照.csv'

rows = json.loads(RAW.read_text(encoding='utf-8'))[1:]
rows = [((c or '').strip(), (n or '').strip(), (u or '').strip(), (h or '').strip()) for c, n, u, h in rows]

# ---------------------------------------------------------------- 页面识别


def is_page(uri: str) -> bool:
    return bool(uri) and uri != 'null' and ('.jsp' in uri or 'action' in uri)


pages = [(c, n, u) for c, n, u, _ in rows if is_page(u)]

by_code = {c: n for c, n, _ in pages}

# code -> 子节点（按树结构：前缀匹配）
children: dict[str, list[tuple[str, str]]] = {}
codes = [r[0] for r in rows]
for c, n, _, _ in rows:
    if not c:
        continue
    # 找最长的真前缀父节点
    parent = None
    for p in codes:
        if p != c and c.startswith(p) and (parent is None or len(p) > len(parent)):
            parent = p
    if parent:
        children.setdefault(parent, []).append((c, n))


def button_names(code: str, limit: int = 18) -> list[str]:
    """收集该页面下所有层级的功能点名称（去重、去掉返回主页面）。"""
    out: list[str] = []
    stack = [code]
    while stack:
        cur = stack.pop()
        for c, n in children.get(cur, []):
            stack.append(c)
            name = re.sub(r'<[^>]+>', '', n).strip()
            if not name or name == '返回主页面' or name in out:
                continue
            if c in by_code:  # 子页面单独成行，不当按钮
                continue
            out.append(name)
    return out[:limit]


# ---------------------------------------------------------------- 导航映射
# (状态, 天玑导航, 路由)
#   ✅ 独立入口   🔗 合并入口（同一页面的页签/子视图）   🆕 本期新增   ⚪ 未覆盖
MAP: dict[str, tuple[str, str, str]] = {
    # ---------------- 档案收集 JZQB0001
    'JZQB00010001': ('✅', '档案收集 → 未归文件搜集', '/collection/staging'),
    'JZQB00010002': ('✅', '档案收集 → 档案著录', '/catalog'),
    'JZQB00010003': ('🔗', '档案收集 → 未归文件搜集（电子文件页签）', '/collection/staging'),
    'JZQB00010004': ('🔗', '档案收集 → 未归文件搜集（照片文件页签）', '/collection/staging'),
    'JZQB00010005': ('🔗', '档案收集 → 未归文件搜集（录音文件页签）', '/collection/staging'),
    'JZQB00010006': ('🔗', '档案收集 → 未归文件搜集（录像文件页签）', '/collection/staging'),
    'JZQB00010007': ('🔗', '档案收集 → 未归文件搜集（待审核页签）', '/collection/staging'),
    'JZQB00010008': ('🔗', '档案收集 → 档案著录（案卷确认归档）', '/catalog'),
    'JZQB00010009': ('🔗', '档案收集 → 档案接收（OA 接收包）', '/receive'),
    'JZQB00010010': ('✅', '档案收集 → 数据导入', '/import'),
    'JZQB00010011': ('✅', '档案收集 → 档案接收', '/receive'),
    'JZQB00010012': ('🔗', '档案收集 → 档案接收（电子/实体合并）', '/receive'),
    'JZQB00010013': ('✅', '档案收集 → 电子文件挂接', '/datalink'),
    # ---------------- 档案管理 JZQB0002
    'JZQB00020001': ('✅', '档案管理 → 档案著录', '/catalog'),
    'JZQB00020002': ('🔗', '档案管理 → 档案著录（电子档案视图）', '/catalog'),
    'JZQB00020003': ('✅', '档案管理 → 档案著录（案卷管理）', '/catalog'),
    'JZQB00020004': ('🔗', '档案管理 → 档案著录（照片档案门类）', '/catalog'),
    'JZQB00020005': ('🔗', '档案管理 → 档案著录（录音档案门类）', '/catalog'),
    'JZQB00020006': ('🔗', '档案管理 → 档案著录（录像档案门类）', '/catalog'),
    'JZQB00020007': ('🔗', '档案管理 → 档案著录（资料管理）', '/catalog'),
    'JZQB00020014': ('🔗', '档案管理 → 档案著录（专业档案）', '/catalog'),
    'JZQB00020015': ('🔗', '档案管理 → 档案著录（专业档案组卷）', '/catalog'),
    'JZQB00020018': ('✅', '档案管理 → 档案鉴定', '/appraisal'),
    'JZQB00020019': ('✅', '档案管理 → 开放管理', '/open'),
    'JZQB00020020': ('✅', '档案管理 → 销毁数据管理', '/destroy'),
    'JZQB00020021': ('🔗', '档案管理 → 档案著录（全宗卷）', '/catalog'),
    'JZQB00020024': ('✅', '档案管理 → 档案移交（实体）', '/transfer'),
    'JZQB00020026': ('🔗', '档案管理 → 档案移交（电子，合并）', '/transfer'),
    'JZQB00020029': ('✅', '档案管理 → 辅助实体', '/auxentity'),
    'JZQB00020030': ('✅', '档案管理 → 门类管理（分类方案）', '/category'),
    # ---------------- 保管 JZQB0003
    'JZQB00030001': ('✅', '档案管理 → 长期保管', '/erms'),
    'JZQB00030003': ('✅', '档案管理 → 回收站', '/recycle'),
    'JZQB00030004': ('🔗', '档案管理 → 长期保管（电子库房页签）', '/erms'),
    'JZQB00030005': ('✅', '系统安全 → 备份恢复', '/backup'),
    'JZQB00030006': ('🔗', '档案管理 → 长期保管（文件处理页签）', '/erms'),
    'JZQB00030007': ('✅', '档案管理 → 实体库房', '/stkf'),
    # ---------------- 利用 JZQB0004
    'JZQB00040001': ('🔗', '档案利用 → 综合检索（目录检索）', '/search'),
    'JZQB00040002': ('🔗', '档案利用 → 综合检索（分类检索）', '/search'),
    'JZQB00040003': ('✅', '档案利用 → 综合检索', '/search'),
    'JZQB00040004': ('✅', '档案利用 → 借阅管理', '/borrow'),
    'JZQB00040005': ('✅', '系统设置 → 报表管理', '/report-design'),
    'JZQB00040006': ('✅', '档案利用 → 编研管理', '/compilation'),
    'JZQB00040007': ('✅', '档案利用 → 统计报表', '/report'),
    'JZQB00040008': ('🆕', '档案利用 → 光盘导出', '/export-cd'),
    'JZQB00040009': ('✅', '档案利用 → 利用日志', '/usage-log'),
    # ---------------- 设置 JZQB0005
    'JZQB00050001': ('🆕', '系统设置 → 机构管理', '/system/org'),
    'JZQB00050002': ('✅', '系统设置 → 用户与角色', '/system/users'),
    'JZQB00050003': ('✅', '系统安全 → 权限设置（角色）', '/system/roles'),
    'JZQB00050004': ('🔗', '系统安全 → 权限设置（用户授权）', '/system/roles'),
    'JZQB00050005': ('✅', '系统安全 → 操作日志', '/audit'),
    'JZQB00050006': ('✅', '系统设置 → 审批设置', '/workflow'),
    'JZQB00050007': ('✅', '系统设置 → 元数据标准', '/metadata'),
    'JZQB00050008': ('✅', '系统设置 → 分类模板', '/template'),
    'JZQB00050009': ('✅', '档案管理 → 全宗管理', '/fonds'),
    'JZQB00050011': ('✅', '系统设置 → 报表管理', '/report-design'),
    'JZQB00050012': ('✅', '档案管理 → 保管期限表', '/retention'),
    'JZQB00050017': ('✅', '系统安全 → 备份恢复（配置备份）', '/backup'),
    'JZQB00050018': ('🆕', '系统安全 → 补丁管理', '/system/patch'),
    'JZQB00050019': ('✅', '系统设置 → 公告管理', '/notice'),
    'JZQB00050020': ('✅', '系统设置 → 下载中心', '/download'),
    'JZQB00050021': ('✅', '档案管理 → 门类管理', '/category'),
    'JZQB00050022': ('✅', '系统安全 → 四性检测', '/ercheck'),
    'JZQB00050023': ('✅', '系统设置 → 数据字典', '/system/dict'),
}

# 利用平台（LYPT）页面映射
MAP_LYPT: dict[str, tuple[str, str, str]] = {
    'LYPT00010001': ('🔗', '档案收集 → 未归文件搜集（电子文件页签）', '/collection/staging'),
    'LYPT00010002': ('🔗', '档案收集 → 未归文件搜集（照片文件页签）', '/collection/staging'),
    'LYPT00010003': ('🔗', '档案收集 → 未归文件搜集（录像文件页签）', '/collection/staging'),
    'LYPT00010004': ('🔗', '档案收集 → 未归文件搜集（录音文件页签）', '/collection/staging'),
    'LYPT00020001': ('🔗', '档案管理 → 档案著录（电子档案）', '/catalog'),
    'LYPT00020002': ('🔗', '档案管理 → 档案著录（照片档案）', '/catalog'),
    'LYPT00020003': ('🔗', '档案管理 → 档案著录（录像档案）', '/catalog'),
    'LYPT00020004': ('🔗', '档案管理 → 档案著录（录音档案）', '/catalog'),
    'LYPT00030001': ('🔗', '档案收集 → 未归文件搜集（文书文件）', '/collection/staging'),
    'LYPT00030002': ('🔗', '档案收集 → 档案著录（案卷收集）', '/catalog'),
    'LYPT00040001': ('🔗', '档案管理 → 档案著录（归档管理）', '/catalog'),
    'LYPT00040002': ('🔗', '档案管理 → 档案著录（案卷管理）', '/catalog'),
    'LYPT00040003': ('🔗', '档案管理 → 档案著录（资料管理）', '/catalog'),
    'LYPT00040004': ('🔗', '档案管理 → 档案著录（会计档案）', '/catalog'),
    'LYPT00040005': ('🔗', '档案管理 → 档案著录（会计档案案卷）', '/catalog'),
    'LYPT00040006': ('🆕', '档案利用 → 光盘导出', '/export-cd'),
}

MODULES = [
    ('档案收集', 'JZQB0001', '文件进馆、归档审核、接收与挂接'),
    ('档案管理', 'JZQB0002', '著录、鉴定、开放、销毁、移交、库房'),
    ('保管与长期保存', 'JZQB0003', '长期保管、电子库房、备份、回收站'),
    ('档案利用', 'JZQB0004', '检索、借阅、编研、统计、光盘导出'),
    ('系统设置', 'JZQB0005', '机构、用户、审批、元数据、分类'),
    ('系统安全（跨模块）', 'SEC', '日志、权限、备份、四性检测、补丁'),
]

STATUS_LEGEND = {
    '✅': '独立入口（导航有一级菜单项，功能完整）',
    '🔗': '合并入口（同一页面的页签/视图，导航可达）',
    '🆕': '本期新增入口',
    '⚪': '未覆盖',
}

# 系统安全模块的条目直接引用设置模块里的安全类页面
SECURITY_CODES = ['JZQB00050003', 'JZQB00050004', 'JZQB00050005', 'JZQB00050017', 'JZQB00050018', 'JZQB00030005', 'JZQB00050022']

jzqb_pages = [(c, n, u) for c, n, u in pages if c.startswith('JZQB')]
lypt_pages = [(c, n, u) for c, n, u in pages if c.startswith('LYPT')]

# ---------------------------------------------------------------- 统计
all_mapped = {**MAP, **MAP_LYPT}
stat = {'✅': 0, '🔗': 0, '🆕': 0, '⚪': 0}
for c, _, _ in jzqb_pages + lypt_pages:
    st = all_mapped.get(c, ('⚪', '未覆盖', ''))[0]
    stat[st] = stat.get(st, 0) + 1
total_pages = len(jzqb_pages) + len(lypt_pages)

# ---------------------------------------------------------------- Markdown
lines: list[str] = []
lines.append('# 泰坦 DARMS 功能树 × 天玑导航对照')
lines.append('')
lines.append('> **来源**：泰坦本地实例 H2 库 `T_S_PRIVILEGE` 全量导出（4394 条权限点，339 个可打开页面）。')
lines.append('> **口径**：按 `CODE` 前缀还原树结构；`URI` 非空的节点视为「页面」，其余为页面内按钮/状态。')
lines.append('> **复刻范围**：`JZQB`（增强版，63 页）+ `LYPT`（利用平台，16 页）共 79 页；')
lines.append('> `FZST / JBZB / JYBB / SJCB / CPSZ` 是同一产品的其他版本/功能池，页面与本套重复，不单独建导航。')
lines.append('> **状态图例**：')
for k, v in STATUS_LEGEND.items():
    lines.append(f'> - `{k}` {v}')
lines.append('')
lines.append('## 0. 总览')
lines.append('')
lines.append('| 指标 | 数量 |')
lines.append('|---|---|')
lines.append(f'| 泰坦页面（JZQB + LYPT） | {total_pages} |')
lines.append(f'| 已独立落地 ✅ | {stat["✅"]} |')
lines.append(f'| 合并落地 🔗 | {stat["🔗"]} |')
lines.append(f'| 本期新增 🆕 | {stat["🆕"]} |')
lines.append(f'| 未覆盖 ⚪ | {stat["⚪"]} |')
lines.append(f'| 页面级覆盖率 | {round((total_pages - stat["⚪"]) / total_pages * 100, 1)}% |')
lines.append('')
lines.append('> 覆盖率按「页面是否可达」计算。合并入口意味着从该导航项进入后，通过页签/视图切换即可完成泰坦对应页面的动作，')
lines.append('> 不再单独占用一个侧栏菜单（例如泰坦的「照片档案 / 录音档案 / 录像档案」在本系统内是档案著录的门类视图）。')
lines.append('')

section_index = 0
for mod_name, prefix, desc in MODULES:
    if prefix == 'SEC':
        mod_pages = [p for p in jzqb_pages if p[0] in SECURITY_CODES]
    else:
        mod_pages = [p for p in jzqb_pages if p[0].startswith(prefix)]
    if not mod_pages:
        continue
    section_index += 1
    lines.append(f'## {section_index}. {mod_name}（{len(mod_pages)} 页）')
    lines.append('')
    lines.append(f'{desc}。')
    lines.append('')
    lines.append('| 泰坦页面 | CODE | 页面内主要操作（权限点） | 天玑导航 | 路由 | 状态 |')
    lines.append('|---|---|---|---|---|---|')
    for code, name, _uri in mod_pages:
        st, nav, route = all_mapped.get(code, ('⚪', '未覆盖', ''))
        btns = button_names(code)
        btn_text = '、'.join(btns) if btns else '—'
        if len(btn_text) > 160:
            btn_text = btn_text[:160] + '…'
        lines.append(f'| {name} | `{code}` | {btn_text} | {nav} | `{route}` | {st} |')
    lines.append('')

# 利用平台
if lypt_pages:
    section_index += 1
    lines.append(f'## {section_index}. 利用平台 LYPT（{len(lypt_pages)} 页）')
    lines.append('')
    lines.append('利用平台是泰坦面向「部门兼职档案员 / 借阅用户」的轻量前端，页面能力与本系统已有页面高度重合，按合并入口处理。')
    lines.append('')
    lines.append('| 泰坦页面 | CODE | 页面内主要操作 | 天玑导航 | 路由 | 状态 |')
    lines.append('|---|---|---|---|---|---|')
    for code, name, _uri in lypt_pages:
        st, nav, route = MAP_LYPT.get(code, ('⚪', '未覆盖', ''))
        btns = button_names(code)
        btn_text = '、'.join(btns) if btns else '—'
        if len(btn_text) > 160:
            btn_text = btn_text[:160] + '…'
        lines.append(f'| {name} | `{code}` | {btn_text} | {nav} | `{route}` | {st} |')
    lines.append('')

lines.append('## 附：本期为对齐泰坦新增/改造的能力')
lines.append('')
lines.append('| 能力 | 说明 | 入口 |')
lines.append('|---|---|---|')
lines.append('| 未归文件搜集 | 新增页面：未处理/预归档/待审核/已归档/无需归档五个页签 + 门类页签，支持批量预归档、无需归档、删除、导出、打印 | 档案收集 → 未归文件搜集 |')
lines.append('| 档案移交合并 | 实体 / 电子移交合并为一个页面，按类型页签区分；条目改为档号/题名自动补全选择 | 档案管理 → 档案移交 |')
lines.append('| 销毁数据管理 | 新增「待销毁档案自动检索补全」，不再手工抄档号；新增整批还原 | 档案管理 → 销毁数据管理 |')
lines.append('| 开放数据管理 | 新增「开放数据」页签组：未处理 / 条目开放 / 原文开放 / 不开放 / 再审查；支持撤销结论、打印 | 档案管理 → 开放管理 |')
lines.append('| 机构管理 / 补丁管理 / 光盘导出 | 新增结构化表单页面（非 JSON 手填） | 系统设置 / 系统安全 / 档案利用 |')
lines.append('')
lines.append('---')
lines.append('')
lines.append('*本文档由 `scripts/gen_titan_nav_map.py` 从权限原始数据自动生成；页面增删后重跑即可同步。*')

MD_OUT.write_text('\n'.join(lines) + '\n', encoding='utf-8')

# ---------------------------------------------------------------- CSV
with CSV_OUT.open('w', encoding='utf-8-sig', newline='') as fh:
    w = csv.writer(fh)
    w.writerow(['模块', 'CODE', '名称', '类型', 'URI', '天玑导航', '路由', '状态', '状态说明', '页面内功能点'])
    for code, name, uri, _hid in rows:
        if not code:
            continue
        module = code[:4]
        is_pg = is_page(uri)
        st, nav, route = all_mapped.get(code, ('', '', ''))
        if is_pg:
            st2 = st or '⚪'
            nav2 = nav or '未覆盖'
            route2 = route
            btn = ''
        else:
            # 按钮级：继承最近页面祖先的映射
            anc = None
            for p in by_code:
                if code.startswith(p) and (anc is None or len(p) > len(anc)):
                    anc = p
            st2 = ''
            nav2 = all_mapped.get(anc, ('', '未覆盖', ''))[1] if anc else ''
            route2 = all_mapped.get(anc, ('', '', ''))[2] if anc else ''
            btn = re.sub(r'<[^>]+>', '', name)
        w.writerow([module, code, name, '页面' if is_pg else '功能点', uri, nav2, route2, st2,
                    STATUS_LEGEND.get(st2, ''), btn])

print('md:', MD_OUT, MD_OUT.stat().st_size, 'bytes')
print('csv:', CSV_OUT, CSV_OUT.stat().st_size, 'bytes')
print('pages:', total_pages, stat)
