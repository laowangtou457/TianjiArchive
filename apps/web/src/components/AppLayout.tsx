import { useState, type ReactElement, type ReactNode } from 'react';
import type { PermissionDomain, PermissionSnapshot } from '@tianji/shared';
import { useAuthStore } from '../stores/authStore';

/** 侧栏菜单项 */
export interface MenuItem {
  key: string;
  label: string;
  path: string;
  icon: string;
  /** 分组标题（同级相同则归为一组） */
  group: string;
  /**
   * 可见性所需的功能域（任一命中即显示；缺省 = 恒显示，如工作台）。
   * 判据：grants[domain] 存在且 mode !== NONE。与后端角色权限矩阵同源，
   * 菜单只做「引导」，服务端 PermissionGuard 仍是最终裁决。
   */
  domains?: PermissionDomain[];
}

/** 菜单定义（与路由表一致） */
export const MENU: MenuItem[] = [
  { key: 'dashboard', label: '工作台', path: '/', icon: '◧', group: '概览' },
  { key: 'search', label: '综合检索', path: '/search', icon: '⌕', group: '检索利用', domains: ['SEARCH'] },
  { key: 'borrow', label: '借阅管理', path: '/borrow', icon: '⇄', group: '检索利用', domains: ['BORROW_APPLY', 'BORROW_APPROVE', 'BORROW_RETURN'] },
  { key: 'kb', label: '片段检索', path: '/kb', icon: '◈', group: '检索利用', domains: ['KB'] },
  { key: 'fonds', label: '全宗管理', path: '/fonds', icon: '▤', group: '档案业务', domains: ['FONDS'] },
  { key: 'catalog', label: '档案著录', path: '/catalog', icon: '▥', group: '档案业务', domains: ['VOLUME', 'ITEM'] },
  { key: 'rule', label: '档号规则', path: '/rules', icon: '⌗', group: '档案业务', domains: ['DANGHAO_RULE'] },
  { key: 'recycle', label: '回收站', path: '/recycle', icon: '⌫', group: '档案业务', domains: ['RECYCLE'] },
  { key: 'report', label: '统计报表', path: '/report', icon: '◔', group: '统计与运维', domains: ['REPORT'] },
  { key: 'backup', label: '备份恢复', path: '/backup', icon: '⌸', group: '统计与运维', domains: ['BACKUP'] },
  { key: 'audit', label: '操作日志', path: '/audit', icon: '☰', group: '系统管理', domains: ['AUDIT_LOG'] },
  { key: 'users', label: '用户与角色', path: '/system/users', icon: '☗', group: '系统管理', domains: ['USER'] },
  { key: 'dict', label: '数据字典', path: '/system/dict', icon: '≡', group: '系统管理', domains: ['DICT'] },
  { key: 'synonyms', label: '检索同义词', path: '/system/synonyms', icon: '⇋', group: '系统管理', domains: ['PARAM'] },
  { key: 'params', label: '系统参数', path: '/system/params', icon: '⚙', group: '系统管理', domains: ['PARAM'] },
];

/** 菜单可见性：任一声明域为非 NONE 授权即显示（工作台无声明恒显示） */
export function menuVisible(
  profile: PermissionSnapshot | null | undefined,
  item: MenuItem,
): boolean {
  if (!item.domains || item.domains.length === 0) return true;
  if (!profile?.grants) return false;
  return item.domains.some((d) => {
    const grant = profile.grants?.[d];
    return !!grant && grant.mode !== 'NONE';
  });
}

/** 布局属性 */
export interface AppLayoutProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** 是否隐藏侧栏（登录页等） */
  bare?: boolean;
}

/**
 * 应用主框架：左侧导航 + 顶部栏 + 内容区。
 * 高密度政务风格：固定 220px 侧栏，内容区自适应，最小支持 1366×768（PRD §7.4）。
 * 侧栏菜单按当前用户 grants 过滤——不同角色看到不同模块（检索利用/档案业务/系统管理）。
 */
export function AppLayout(props: AppLayoutProps): ReactElement {
  const { title, subtitle, actions, children } = props;
  const profile = useAuthStore((s) => s.profile);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('tianji.sidebarCollapsed') === '1';
  });

  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('tianji.sidebarCollapsed', next ? '1' : '0');
  };

  const visible = MENU.filter((m) => menuVisible(profile, m));
  const groups = Array.from(new Set(visible.map((m) => m.group)));

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside
        style={{
          width: collapsed ? 56 : 220,
          flex: `0 0 ${collapsed ? 56 : 220}px`,
          backgroundColor: '#152260',
          color: '#e2e8f0',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width .18s ease',
          position: 'sticky',
          top: 0,
          height: '100vh',
          overflowY: 'auto',
        }}
      >
        <div
          style={{
            height: 52,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: collapsed ? '0 14px' : '0 16px',
            borderBottom: '1px solid rgba(255,255,255,.12)',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ fontSize: 18 }}>泰</span>
          {!collapsed && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: 1 }}>天玑档案</div>
              <div style={{ fontSize: 10, opacity: 0.7 }}>Tianji Archive</div>
            </div>
          )}
        </div>

        <nav style={{ padding: '8px 0', flex: 1 }}>
          {groups.map((g) => (
            <div key={g}>
              {!collapsed && (
                <div
                  style={{
                    padding: '8px 16px 4px',
                    fontSize: 10,
                    letterSpacing: 1,
                    color: 'rgba(226,232,240,.55)',
                  }}
                >
                  {g}
                </div>
              )}
              {visible.filter((m) => m.group === g).map((m) => {
                const active =
                  m.path === '/'
                    ? window.location.pathname === '/'
                    : window.location.pathname.startsWith(m.path);
                return (
                  <a
                    key={m.key}
                    href={m.path}
                    title={m.label}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: collapsed ? '9px 18px' : '9px 16px',
                      color: active ? '#ffffff' : 'rgba(226,232,240,.82)',
                      backgroundColor: active ? 'rgba(79,110,247,.28)' : 'transparent',
                      borderLeft: active ? '3px solid #4f6ef7' : '3px solid transparent',
                      textDecoration: 'none',
                      fontSize: 13,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ width: 14, textAlign: 'center', opacity: 0.9 }}>{m.icon}</span>
                    {!collapsed && <span>{m.label}</span>}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>

        <button
          type="button"
          onClick={toggle}
          style={{
            border: 'none',
            borderTop: '1px solid rgba(255,255,255,.12)',
            background: 'transparent',
            color: 'rgba(226,232,240,.75)',
            padding: '10px 16px',
            cursor: 'pointer',
            fontSize: 12,
            textAlign: 'left',
          }}
        >
          {collapsed ? '»' : '« 收起导航'}
        </button>
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            height: 52,
            flex: '0 0 52px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 18px',
            backgroundColor: '#ffffff',
            borderBottom: '1px solid #e2e8f0',
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
          className="no-print"
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#1a202c' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 11, color: '#718096' }}>{subtitle}</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{actions}</div>
        </header>

        <main style={{ padding: 16, flex: 1, minWidth: 0 }}>{children}</main>
      </div>
    </div>
  );
}
