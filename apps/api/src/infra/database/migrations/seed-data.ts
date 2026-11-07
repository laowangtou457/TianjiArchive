import { PARAM_DEFS } from '@tianji/shared';
import type {
  MetadataFieldDef,
  PermissionDomain,
  PermissionGrant,
  PermissionMode,
  RoleCode,
} from '@tianji/shared';

/**
 * 基线种子数据定义（角色权限矩阵 / 门类字段集 / 字典 / 参数）。
 * 单独成文件便于 seed.ts 与迁移共用，且便于单测校验权限矩阵完整性。
 */

// ============================================================================
// 权限声明构造小工具
// ============================================================================
function g(
  domain: PermissionDomain,
  mode: PermissionMode,
  ops: PermissionGrant['ops'],
  scoped = false,
  levelCapped = true,
): PermissionGrant {
  return { domain, mode, ops, scoped, levelCapped };
}

const NONE_GRANT = (domain: PermissionDomain): PermissionGrant => g(domain, 'NONE', []);

// ============================================================================
// 角色权限矩阵 —— 严格对应 PRD §3.2
// ✔ FULL / ○ LIMITED / △ READONLY / ✖ NONE
// ============================================================================
export interface SeedRole {
  code: RoleCode;
  name: string;
  permissions: PermissionGrant[];
}

export function buildSeedRoles(): SeedRole[] {
  const r0: PermissionGrant[] = [
    // R0 系统管理员：原则上不接触档案内容
    g('FONDS', 'READONLY', ['READ']),
    NONE_GRANT('VOLUME'),
    NONE_GRANT('ITEM'),
    g('DANGHAO_RULE', 'LIMITED', ['READ', 'WRITE']),
    NONE_GRANT('ARCHIVE_CONFIRM'),
    g('SEARCH', 'FULL', ['READ', 'EXPORT']), // 公开级
    NONE_GRANT('SEARCH_INTERNAL'),
    NONE_GRANT('FILE'),
    NONE_GRANT('PREVIEW'),
    NONE_GRANT('BORROW_APPLY'),
    NONE_GRANT('BORROW_APPROVE'),
    NONE_GRANT('BORROW_RETURN'),
    g('REPORT', 'LIMITED', ['READ', 'EXPORT'], false, false), // 系统运行类报表，不受密级限制
    NONE_GRANT('COMPILATION'),
    g('APPRAISAL', 'READONLY', ['READ']),
    g('RECYCLE', 'LIMITED', ['READ', 'DELETE']),
    g('USER', 'FULL', ['READ', 'WRITE', 'DELETE', 'APPROVE'], false, false),
    g('AUDIT_LOG', 'FULL', ['READ', 'EXPORT'], false, false),
    g('BACKUP', 'FULL', ['READ', 'WRITE', 'DELETE'], false, false),
    g('IMPORT_EXPORT', 'LIMITED', ['WRITE', 'EXPORT']),
    g('PARAM', 'FULL', ['READ', 'WRITE'], false, false),
    g('DICT', 'FULL', ['READ', 'WRITE', 'DELETE'], false, false),
    g('KB', 'READONLY', ['READ']),
  ];

  const r1: PermissionGrant[] = [
    // R1 档案管理员：业务全责
    g('FONDS', 'FULL', ['READ', 'WRITE', 'DELETE']),
    g('VOLUME', 'FULL', ['READ', 'WRITE', 'DELETE']),
    g('ITEM', 'FULL', ['READ', 'WRITE', 'DELETE']),
    g('DANGHAO_RULE', 'FULL', ['READ', 'WRITE', 'DELETE']),
    g('ARCHIVE_CONFIRM', 'FULL', ['READ', 'WRITE', 'APPROVE']),
    g('SEARCH', 'FULL', ['READ', 'EXPORT']),
    g('SEARCH_INTERNAL', 'FULL', ['READ']),
    g('FILE', 'FULL', ['READ', 'WRITE', 'DELETE']),
    g('PREVIEW', 'FULL', ['READ']),
    g('BORROW_APPLY', 'LIMITED', ['READ', 'WRITE']),
    g('BORROW_APPROVE', 'FULL', ['READ', 'APPROVE']),
    g('BORROW_RETURN', 'FULL', ['READ', 'WRITE']),
    g('REPORT', 'FULL', ['READ', 'EXPORT']),
    g('COMPILATION', 'FULL', ['READ', 'WRITE']),
    g('APPRAISAL', 'FULL', ['READ', 'WRITE', 'APPROVE']),
    g('RECYCLE', 'FULL', ['READ', 'WRITE', 'DELETE']),
    NONE_GRANT('USER'),
    g('AUDIT_LOG', 'LIMITED', ['READ']),
    NONE_GRANT('BACKUP'),
    g('IMPORT_EXPORT', 'FULL', ['READ', 'WRITE', 'EXPORT']),
    g('PARAM', 'LIMITED', ['READ', 'WRITE']),
    g('DICT', 'FULL', ['READ', 'WRITE', 'DELETE']),
    g('KB', 'FULL', ['READ', 'WRITE']),
  ];

  const r2: PermissionGrant[] = [
    // R2 部门兼职档案员：限本部门（数据范围由 user_data_scope 控制）
    g('FONDS', 'NONE', []),
    g('VOLUME', 'LIMITED', ['READ', 'WRITE'], true),
    g('ITEM', 'LIMITED', ['READ', 'WRITE'], true),
    NONE_GRANT('DANGHAO_RULE'),
    g('ARCHIVE_CONFIRM', 'LIMITED', ['WRITE'], true), // 仅提交
    g('SEARCH', 'FULL', ['READ']),
    g('SEARCH_INTERNAL', 'LIMITED', ['READ'], true),
    g('FILE', 'LIMITED', ['READ', 'WRITE'], true),
    g('PREVIEW', 'LIMITED', ['READ'], true),
    g('BORROW_APPLY', 'FULL', ['READ', 'WRITE']),
    NONE_GRANT('BORROW_APPROVE'),
    NONE_GRANT('BORROW_RETURN'),
    g('REPORT', 'LIMITED', ['READ'], true),
    g('COMPILATION', 'LIMITED', ['READ', 'WRITE'], true),
    NONE_GRANT('APPRAISAL'),
    g('RECYCLE', 'LIMITED', ['READ', 'WRITE'], true),
    NONE_GRANT('USER'),
    NONE_GRANT('AUDIT_LOG'),
    NONE_GRANT('BACKUP'),
    NONE_GRANT('IMPORT_EXPORT'),
    NONE_GRANT('PARAM'),
    NONE_GRANT('DICT'),
    g('KB', 'LIMITED', ['READ']),
  ];

  const r3: PermissionGrant[] = [
    // R3 借阅用户：检索公开级 + 申请借阅
    NONE_GRANT('FONDS'),
    NONE_GRANT('VOLUME'),
    NONE_GRANT('ITEM'),
    NONE_GRANT('DANGHAO_RULE'),
    NONE_GRANT('ARCHIVE_CONFIRM'),
    g('SEARCH', 'FULL', ['READ']),
    g('SEARCH_INTERNAL', 'LIMITED', ['READ'], false), // 申请后按单授权
    NONE_GRANT('FILE'),
    g('PREVIEW', 'LIMITED', ['READ']),
    g('BORROW_APPLY', 'FULL', ['READ', 'WRITE']),
    NONE_GRANT('BORROW_APPROVE'),
    g('BORROW_RETURN', 'LIMITED', ['WRITE'], true),
    NONE_GRANT('REPORT'),
    NONE_GRANT('COMPILATION'),
    NONE_GRANT('APPRAISAL'),
    NONE_GRANT('RECYCLE'),
    NONE_GRANT('USER'),
    NONE_GRANT('AUDIT_LOG'),
    NONE_GRANT('BACKUP'),
    NONE_GRANT('IMPORT_EXPORT'),
    NONE_GRANT('PARAM'),
    NONE_GRANT('DICT'),
    g('KB', 'LIMITED', ['READ']),
  ];

  const r4: PermissionGrant[] = [
    // R4 领导/审批人：查询全部 + 重要件审批
    g('FONDS', 'READONLY', ['READ']),
    NONE_GRANT('VOLUME'),
    NONE_GRANT('ITEM'),
    NONE_GRANT('DANGHAO_RULE'),
    NONE_GRANT('ARCHIVE_CONFIRM'),
    g('SEARCH', 'FULL', ['READ']),
    g('SEARCH_INTERNAL', 'FULL', ['READ']),
    NONE_GRANT('FILE'),
    g('PREVIEW', 'FULL', ['READ']),
    g('BORROW_APPLY', 'FULL', ['READ', 'WRITE']),
    g('BORROW_APPROVE', 'LIMITED', ['READ', 'APPROVE']), // 重要件
    NONE_GRANT('BORROW_RETURN'),
    g('REPORT', 'FULL', ['READ', 'EXPORT']),
    g('COMPILATION', 'READONLY', ['READ']),
    g('APPRAISAL', 'LIMITED', ['READ', 'APPROVE']),
    NONE_GRANT('RECYCLE'),
    NONE_GRANT('USER'),
    g('AUDIT_LOG', 'READONLY', ['READ']),
    NONE_GRANT('BACKUP'),
    NONE_GRANT('IMPORT_EXPORT'),
    NONE_GRANT('PARAM'),
    NONE_GRANT('DICT'),
    g('KB', 'LIMITED', ['READ']),
  ];

  return [
    { code: 'R0', name: '系统管理员', permissions: r0 },
    { code: 'R1', name: '档案管理员', permissions: r1 },
    { code: 'R2', name: '部门兼职档案员', permissions: r2 },
    { code: 'R3', name: '借阅用户', permissions: r3 },
    { code: 'R4', name: '领导/查档审批人', permissions: r4 },
  ];
}

// ============================================================================
// 核心著录字段集（DA/T 18-2022 §7 / DA/T 22-2015 §6）—— core=true 不可裁剪
// ============================================================================
export function buildCoreItemFields(): MetadataFieldDef[] {
  return [
    {
      key: 'danghao',
      label: '档号',
      type: 'string',
      required: true,
      core: true,
      readonly: true,
      maxLength: 120,
      order: 1,
      level: 'ITEM',
      helpText: '由系统按档号规则自动生成，入库后不可修改（只能作废重编）',
    },
    {
      key: 'title',
      label: '文件题名',
      type: 'string',
      required: true,
      core: true,
      maxLength: 500,
      order: 2,
      level: 'BOTH',
      placeholder: '请输入文件题名（归档文件完整题名）',
    },
    {
      key: 'responsible',
      label: '责任者',
      type: 'string',
      required: true,
      core: true,
      maxLength: 200,
      order: 3,
      level: 'BOTH',
      placeholder: '形成该文件的机关或责任人',
    },
    {
      key: 'docDate',
      label: '形成日期',
      type: 'date',
      required: true,
      core: true,
      order: 4,
      level: 'ITEM',
    },
    {
      key: 'year',
      label: '年度',
      type: 'number',
      required: true,
      core: true,
      order: 5,
      level: 'BOTH',
      helpText: '文件形成年度，用于年度统计与档号年份段',
    },
    {
      key: 'retention',
      label: '保管期限',
      type: 'select',
      required: true,
      core: true,
      order: 6,
      level: 'BOTH',
      options: [
        { value: 'PERM', label: '永久' },
        { value: 'Y30', label: '定期 30 年' },
        { value: 'Y10', label: '定期 10 年' },
      ],
    },
    {
      key: 'securityLevel',
      label: '密级',
      type: 'select',
      required: true,
      core: true,
      order: 7,
      level: 'BOTH',
      options: [
        { value: 'PUBLIC', label: '公开' },
        { value: 'INTERNAL', label: '内部' },
        { value: 'SECRET', label: '秘密' },
      ],
    },
    {
      key: 'pages',
      label: '页数',
      type: 'number',
      required: true,
      core: true,
      order: 8,
      level: 'ITEM',
      helpText: '与原件实际页数一致（DA/T 18 数量项）',
    },
    {
      key: 'docNo',
      label: '文号',
      type: 'string',
      required: false,
      core: true,
      maxLength: 120,
      order: 9,
      level: 'ITEM',
    },
    {
      key: 'classNo',
      label: '分类号',
      type: 'string',
      required: false,
      core: true,
      maxLength: 64,
      order: 10,
      level: 'BOTH',
    },
    {
      key: 'keywords',
      label: '主题词',
      type: 'tags',
      required: false,
      core: true,
      order: 11,
      level: 'BOTH',
      helpText: '受控词表，多个主题词以回车分隔',
    },
    {
      key: 'note',
      label: '附注',
      type: 'text',
      required: false,
      core: true,
      order: 12,
      level: 'BOTH',
    },
    {
      key: 'openFlag',
      label: '开放标识',
      type: 'select',
      required: false,
      core: true,
      order: 13,
      level: 'ITEM',
      options: [
        { value: 'OPEN', label: '开放' },
        { value: 'CONTROLLED', label: '控制使用' },
      ],
    },
  ];
}

/** 卷级字段集：继承件级核心字段 + 卷特有字段 */
export function buildCoreVolumeFields(): MetadataFieldDef[] {
  return buildCoreItemFields()
    .filter((f) => f.key !== 'docDate' && f.key !== 'pages' && f.key !== 'docNo' && f.key !== 'openFlag')
    .map((f): MetadataFieldDef => ({ ...f, level: f.level === 'BOTH' ? 'BOTH' : 'VOLUME' }))
    .concat([
      {
        key: 'startDate',
        label: '起始日期',
        type: 'date',
        required: false,
        core: true,
        order: 20,
        level: 'VOLUME',
      },
      {
        key: 'endDate',
        label: '终止日期',
        type: 'date',
        required: false,
        core: true,
        order: 21,
        level: 'VOLUME',
      },
      {
        key: 'itemCount',
        label: '卷内件数',
        type: 'number',
        required: false,
        readonly: true,
        order: 22,
        level: 'VOLUME',
        helpText: '由卷内实际件数自动汇总',
      },
    ])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// ============================================================================
// 门类（档案种类）
// ============================================================================
export interface SeedCategory {
  code: string;
  name: string;
  fieldSchema: MetadataFieldDef[];
  sort: number;
}

export function buildSeedCategories(): SeedCategory[] {
  const base = buildCoreItemFields();
  // 科技档案追加专项字段（示例，可后台配置扩充）
  const techExtra: MetadataFieldDef[] = [
    {
      key: 'projectNo',
      label: '项目编号',
      type: 'string',
      required: false,
      core: false,
      maxLength: 80,
      order: 30,
      level: 'BOTH',
    },
    {
      key: 'projectStage',
      label: '阶段',
      type: 'select',
      required: false,
      core: false,
      order: 31,
      level: 'BOTH',
      options: [
        { value: 'DESIGN', label: '设计' },
        { value: 'CONSTRUCT', label: '施工' },
        { value: 'ACCEPT', label: '竣工验收' },
      ],
    },
  ];
  // 会计档案追加专项字段
  const accExtra: MetadataFieldDef[] = [
    {
      key: 'voucherNo',
      label: '凭证号',
      type: 'string',
      required: false,
      core: false,
      maxLength: 60,
      order: 30,
      level: 'BOTH',
    },
    {
      key: 'accountPeriod',
      label: '会计期间',
      type: 'string',
      required: false,
      core: false,
      maxLength: 40,
      order: 31,
      level: 'BOTH',
    },
  ];
  // 照片档案
  const photoExtra: MetadataFieldDef[] = [
    {
      key: 'shootPlace',
      label: '拍摄地点',
      type: 'string',
      required: false,
      core: false,
      maxLength: 120,
      order: 30,
      level: 'BOTH',
    },
    {
      key: 'photographer',
      label: '摄影者',
      type: 'string',
      required: false,
      core: false,
      maxLength: 80,
      order: 31,
      level: 'BOTH',
    },
  ];
  // 录音录像档案
  const avExtra: MetadataFieldDef[] = [
    {
      key: 'duration',
      label: '时长（秒）',
      type: 'number',
      required: false,
      core: false,
      order: 30,
      level: 'BOTH',
    },
    {
      key: 'recordPlace',
      label: '录制地点',
      type: 'string',
      required: false,
      core: false,
      maxLength: 120,
      order: 31,
      level: 'BOTH',
    },
  ];

  const sortFields = (arr: MetadataFieldDef[]): MetadataFieldDef[] =>
    [...arr].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  return [
    { code: 'WS', name: '文书档案', fieldSchema: sortFields(base), sort: 1 },
    { code: 'KJ', name: '科技档案', fieldSchema: sortFields([...base, ...techExtra]), sort: 2 },
    { code: 'KJ_ACC', name: '会计档案', fieldSchema: sortFields([...base, ...accExtra]), sort: 3 },
    { code: 'ZP', name: '照片档案', fieldSchema: sortFields([...base, ...photoExtra]), sort: 4 },
    { code: 'LYLX', name: '录音录像档案', fieldSchema: sortFields([...base, ...avExtra]), sort: 5 },
    { code: 'SW', name: '实物档案', fieldSchema: sortFields(base), sort: 6 },
  ];
}

// ============================================================================
// 字典
// ============================================================================
export interface SeedDict {
  dictType: string;
  code: string;
  label: string;
  sort: number;
}

export function buildSeedDicts(): SeedDict[] {
  return [
    // 密级（PRD Q8 三档，可通过界面扩展）
    { dictType: 'SECURITY_LEVEL', code: 'PUBLIC', label: '公开', sort: 1 },
    { dictType: 'SECURITY_LEVEL', code: 'INTERNAL', label: '内部', sort: 2 },
    { dictType: 'SECURITY_LEVEL', code: 'SECRET', label: '秘密', sort: 3 },
    // 保管期限
    { dictType: 'RETENTION', code: 'PERM', label: '永久', sort: 1 },
    { dictType: 'RETENTION', code: 'Y30', label: '定期 30 年', sort: 2 },
    { dictType: 'RETENTION', code: 'Y10', label: '定期 10 年', sort: 3 },
    // 利用目的（借阅申请下拉）
    { dictType: 'BORROW_PURPOSE', code: 'REPORT', label: '撰写报告', sort: 1 },
    { dictType: 'BORROW_PURPOSE', code: 'RESEARCH', label: '课题研究', sort: 2 },
    { dictType: 'BORROW_PURPOSE', code: 'WORK', label: '日常公务', sort: 3 },
    { dictType: 'BORROW_PURPOSE', code: 'LEGAL', label: '法律事务', sort: 4 },
    { dictType: 'BORROW_PURPOSE', code: 'OTHER', label: '其他', sort: 99 },
    // 借阅状态
    { dictType: 'BORROW_STATUS', code: 'PENDING', label: '待审批', sort: 1 },
    { dictType: 'BORROW_STATUS', code: 'APPROVED', label: '已批准', sort: 2 },
    { dictType: 'BORROW_STATUS', code: 'LENT', label: '已借出', sort: 3 },
    { dictType: 'BORROW_STATUS', code: 'RETURNED', label: '已归还', sort: 4 },
    { dictType: 'BORROW_STATUS', code: 'OVERDUE', label: '逾期', sort: 5 },
    { dictType: 'BORROW_STATUS', code: 'REJECTED', label: '已驳回', sort: 6 },
    { dictType: 'BORROW_STATUS', code: 'CANCELLED', label: '已撤销', sort: 7 },
    // 销毁原因（F-19 预留）
    { dictType: 'DESTROY_REASON', code: 'EXPIRE', label: '保管期满', sort: 1 },
    { dictType: 'DESTROY_REASON', code: 'DUP', label: '重复件', sort: 2 },
    { dictType: 'DESTROY_REASON', code: 'DAMAGE', label: '损毁无法修复', sort: 3 },
    // 主题词示例（受控词表种子）
    { dictType: 'SUBJECT_WORD', code: '会议纪要', label: '会议纪要', sort: 1 },
    { dictType: 'SUBJECT_WORD', code: '通知', label: '通知', sort: 2 },
    { dictType: 'SUBJECT_WORD', code: '年度报告', label: '年度报告', sort: 3 },
    { dictType: 'SUBJECT_WORD', code: '人事任免', label: '人事任免', sort: 4 },
  ];
}

// ============================================================================
// 系统参数
// ============================================================================
export interface SeedParam {
  key: string;
  value: string;
  label: string;
  secret: boolean;
  /** 分组（对应 sys_param.grp，PR-P5 分级授权依据） */
  grp: string;
  /** 是否可编辑（PR-P7 合规固化项为 false） */
  editable: boolean;
  /** 值类型 */
  valueType: string;
}

/**
 * 系统参数种子 —— **由 `@tianji/shared` 的 `PARAM_DEFS` 派生**。
 *
 * 为什么不在本文件写死数值：架构 §4.3 要求「种子默认值与参数表一致」是强制项，
 * 且 T02 验收含种子比对测试。派生写法从机制上杜绝两处漂移
 * （曾经发生的「种子里是 15、参数表是 30」正是手写两份导致的）。
 */
export function buildSeedParams(): SeedParam[] {
  return PARAM_DEFS.map((def) => ({
    key: def.key,
    value: def.default,
    label: def.label,
    secret: false,
    grp: def.grp,
    editable: def.editable,
    valueType: def.type,
  }));
}
