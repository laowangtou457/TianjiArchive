import { describe, expect, it } from 'vitest';
import { getVisibleGuides, USER_GUIDES } from '../userGuides';

describe('工作台使用指南的角色可见性', () => {
  it('R3 普通借阅用户只看得到用户操作指南', () => {
    const labels = getVisibleGuides(['R3']).map((g) => g.label);
    expect(labels).toEqual(['用户操作指南']);
  });

  it('R1 档案管理员 / R2 部门兼职档案员 / R4 领导可看用户操作指南与利用平台指南', () => {
    for (const role of ['R1', 'R2', 'R4'] as const) {
      expect(getVisibleGuides([role]).map((g) => g.label)).toEqual([
        '用户操作指南',
        '利用平台指南',
      ]);
    }
  });

  it('R0 系统管理员三份都能看到', () => {
    expect(getVisibleGuides(['R0']).map((g) => g.label)).toEqual(USER_GUIDES.map((g) => g.label));
  });

  it('多角色取并集：R3 + R0 可见全部', () => {
    expect(getVisibleGuides(['R3', 'R0'])).toHaveLength(3);
  });

  it('无角色信息时退化为仅显示用户操作指南（fail-closed）', () => {
    expect(getVisibleGuides([]).map((g) => g.label)).toEqual(['用户操作指南']);
  });
});
