/**
 * 初始化数据脚本（管理员账号 + 演示全宗/机构/档号规则）。
 *
 * 用法：
 *   pnpm --filter @tianji/api seed
 *   ADMIN_PASSWORD=xxx pnpm --filter @tianji/api seed
 *
 * 幂等：全部使用 ON CONFLICT DO NOTHING / 存在性判断，可重复执行。
 */
import * as bcrypt from 'bcrypt';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../infra/database/data-source';
import { AppUser } from '../infra/database/entities/user.entity';
import { Role } from '../infra/database/entities/role.entity';
import { Fonds } from '../infra/database/entities/fonds.entity';
import { OrgNode } from '../infra/database/entities/org-node.entity';
import { Category } from '../infra/database/entities/category.entity';
import { DanghaoRule } from '../infra/database/entities/danghao-rule.entity';
import { UserDataScope } from '../infra/database/entities/user-data-scope.entity';
import {
  DEFAULT_VOLUME_TEMPLATE,
  DanghaoSegmentType,
  ResetCycle,
  RoleCode,
  FondsStatus,
  SecurityLevel,
  UserStatus,
  describeTemplate,
  type DanghaoSegment,
} from '@tianji/shared';
import { buildCoreItemFields, buildCoreVolumeFields } from '../infra/database/migrations/seed-data';

/** 默认管理员 */
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Tianji@2024';
const BCRYPT_ROUNDS = 10;

/** 文书档案门类编码 */
const DEFAULT_CATEGORY_CODE = 'WS';

/**
 * 构造文书档案档号段（5 段：目录号-年度-保管期限-卷号-件号）。
 *
 * 注意：与 `DEFAULT_DANGHAO_TEMPLATE`（6 段：全宗号-年度-机构代码-保管期限-卷号-件号）
 * **不同**——这里用 `CATALOG`（目录号）取代了 `FONDS`（全宗号），并省略了 `ORG`（机构代码）。
 * 文书档案按目录著录，不走机构维度；改动任一方时须同步核对此处。
 */
function buildDefaultSegments(): DanghaoSegment[] {
  return [
    { type: DanghaoSegmentType.CATALOG, pad: 0 },
    { type: DanghaoSegmentType.YEAR, pad: 4 },
    { type: DanghaoSegmentType.RETENTION, pad: 0 },
    { type: DanghaoSegmentType.VOLUME, pad: 4 },
    { type: DanghaoSegmentType.ITEM, pad: 4 },
  ];
}

async function main(): Promise<void> {
  const ds = await AppDataSource.initialize();
  console.log('▶ 数据库已连接，开始初始化数据…');

  try {
    await ds.transaction(async (manager) => {
      // ---------------------------------------------------------------- 1) 角色校验
      const roles = await manager.find(Role);
      if (roles.length === 0) {
        throw new Error('未找到内置角色，请先执行迁移：pnpm --filter @tianji/api migration:run');
      }
      const adminRole = roles.find((r) => r.code === RoleCode.R0);
      if (!adminRole) throw new Error('缺少 R0 系统管理员角色，迁移数据异常');

      // ---------------------------------------------------------------- 2) 管理员账号
      const existingAdmin = await manager.findOne(AppUser, { where: { username: ADMIN_USERNAME } });
      let adminId: string;
      if (existingAdmin) {
        adminId = existingAdmin.id;
        console.log(`  管理员 ${ADMIN_USERNAME} 已存在，跳过创建`);
      } else {
        const hash = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_ROUNDS);
        const admin = manager.create(AppUser, {
          username: ADMIN_USERNAME,
          passwordHash: hash,
          displayName: '系统管理员',
          status: UserStatus.ACTIVE,
          maxSecurityLevel: SecurityLevel.SECRET,
          pwdChangedAt: new Date(),
        });
        const saved = await manager.save(admin);
        adminId = saved.id;
        await manager
          .createQueryBuilder()
          .relation(AppUser, 'roles')
          .of(saved.id)
          .add(adminRole.id);
        console.log(`  已创建管理员 ${ADMIN_USERNAME}（初始密码见 ADMIN_PASSWORD，请立即修改）`);
      }

      // 管理员数据范围：ALL（不建 user_data_scope 记录即为全部，显式写入便于界面展示）
      const scopeExists = await manager.count(UserDataScope, { where: { userId: adminId } });
      if (scopeExists === 0) {
        await manager.save(
          manager.create(UserDataScope, { userId: adminId, scopeType: 'ALL', scopeRefId: null }),
        );
      }

      // ---------------------------------------------------------------- 3) 演示全宗与机构
      let fonds = await manager.findOne(Fonds, { where: { fondsNo: 'WS' } });
      if (!fonds) {
        fonds = await manager.save(
          manager.create(Fonds, {
            fondsNo: 'WS',
            name: '文书档案全宗（示例）',
            orgName: '档案室',
            yearStart: 1949,
            yearEnd: null,
            historyNote: '系统初始化示例全宗，可停用或删除',
            status: FondsStatus.ACTIVE,
          }),
        );
        console.log('  已创建示例全宗 WS');
      }

      const orgExists = await manager.findOne(OrgNode, {
        where: { fondsId: fonds.id, code: 'ZHC' },
      });
      if (!orgExists) {
        await manager.save(
          manager.create(OrgNode, {
            fondsId: fonds.id,
            parentId: null,
            code: 'ZHC',
            name: '综合处',
            sort: 1,
          }),
        );
        console.log('  已创建示例机构「综合处」');
      }

      // ---------------------------------------------------------------- 4) 文书门类补全（若迁移已建则跳过）
      let category = await manager.findOne(Category, { where: { code: DEFAULT_CATEGORY_CODE } });
      if (!category) {
        category = await manager.save(
          manager.create(Category, {
            code: DEFAULT_CATEGORY_CODE,
            name: '文书档案',
            fieldSchema: [...buildCoreVolumeFields(), ...buildCoreItemFields()],
            danghaoRuleId: null,
            sort: 1,
            active: true,
          }),
        );
        console.log('  已创建门类「文书档案」');
      }

      // ---------------------------------------------------------------- 5) 档号规则
      const ruleExists = await manager.findOne(DanghaoRule, {
        where: { fondsId: fonds.id, categoryId: IsNull() },
      });
      if (!ruleExists) {
        await manager.save(
          manager.create(DanghaoRule, {
            fondsId: fonds.id,
            categoryId: null,
            segments: buildDefaultSegments(),
            separator: '-',
            resetCycle: ResetCycle.YEAR,
            zeroPad: 4,
            active: true,
          }),
        );
        // 打印实际写入的段结构（而非 DEFAULT_DANGHAO_TEMPLATE —— 两者段数不同，
        // 且对象直接插值只会输出 [object Object]）
        console.log(
          `  已创建档号规则（模板 ${describeTemplate({ separator: '-', segments: buildDefaultSegments() })}）`,
        );
      }

      // 卷级模板说明（仅记录在参数中，供界面提示）
      // 列名以 InitSchema 为准：param_key / param_value（不是 key / value）；
      // param_value 是 text 列，存 JSON 保留完整结构，界面侧 JSON.parse 后使用。
      await manager.query(
        `INSERT INTO system_param (param_key, param_value, label, secret)
         VALUES ('danghao.volumeTemplate', $1, '案卷档号模板', FALSE)
         ON CONFLICT (param_key) DO NOTHING`,
        [JSON.stringify(DEFAULT_VOLUME_TEMPLATE)],
      );

      console.log('✔ 初始化完成');
      console.log(`  登录地址：http://localhost:8080`);
      console.log(`  账号：${ADMIN_USERNAME} / ${existingAdmin ? '(原密码)' : ADMIN_PASSWORD}`);
    });
  } finally {
    await ds.destroy();
  }
}

main().catch((err: Error) => {
  console.error(`✖ 初始化失败：${err.message}`);
  process.exit(1);
});
