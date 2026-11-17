/** 工作台「使用指南」文档清单与按角色的可见性规则。 */

import type { RoleCode } from '@tianji/shared';

export interface UserGuide {
  label: string;
  filename: string;
  desc: string;
  /** 可见角色；缺省 = 全部角色可见 */
  roles?: readonly RoleCode[];
}

export const USER_GUIDES: readonly UserGuide[] = [
  { label: '用户操作指南', filename: '天玑档案管理系统-用户操作指南.pdf', desc: '全功能操作与 FAQ' },
  {
    label: '利用平台指南',
    filename: '天玑档案管理系统-利用平台指南.pdf',
    desc: '检索 / 借阅 / 智能问答',
    roles: ['R0', 'R1', 'R2', 'R4'],
  },
  {
    label: '管理维护指南',
    filename: '天玑档案管理系统-管理维护指南.pdf',
    desc: '部署 / 备份 / 运维',
    roles: ['R0'],
  },
];

/**
 * 按角色过滤可见指南。
 * R3（普通借阅用户）仅见用户操作指南；R1/R2/R4 另见利用平台指南；R0 见全部。
 * 用户拥有多个角色时，任一角色命中即可见。
 */
export function getVisibleGuides(roles: readonly RoleCode[]): UserGuide[] {
  return USER_GUIDES.filter((g) => !g.roles || g.roles.some((r) => roles.includes(r)));
}
