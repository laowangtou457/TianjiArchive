import { useState, type ReactElement, type ReactNode } from 'react';

/** 侧栏菜单项 */
export interface MenuItem {
  key: string;
  label: string;
  path: string;
  icon: string;
  /** 分组标题（同级相同则归为一组） */
  group: string;
}

/** 菜单定义（与路由表一致） */
export const MENU: MenuItem[] = [
  { key: 'dashboard', label: '工作台', path: '/', icon: '◧', group: '概览' },
  { key: 'search', label: '综合检索', path: '/search', icon: '⌕', group: '检索利用' },
  { key: 'borrow', label: '借阅管理', path: '/borrow', icon: '⇄', group: '检索利用' },
  { key: 'kb', label: '片段检索', path: '/kb', icon: '◈', group: '检索利用' },
  { key: 'fonds', label: '全宗管理', path: '/fonds', icon: '▤', group: '档案业务' },
  { key: 'catalog', label: '档案著录', path: '/catalog', icon: '▥', group: '档案业务' },
  { key: 'rule', label: '档号规则', path: '/rules', icon: '⌗', group: '档案业务' },
  { key: 'recycle', label: '回收站', path: '/recycle', icon: '⌫', group: '档案业务' },
  { key: 'report', label: '统计报表', path: '/report', icon: '◔', group: '统计与运维' },
  { key: 'backup', label: '备份恢复', path: '/backup', icon: '⌸', group: '统计与运维' },
  { key: 'audit', label: '操作日志', path: '/audit', icon: '☰', group: '系统管理' },
  { key: 'users', label: '用户与角色', path: '/system/users', icon: '☗', group: '系统管理' },
  { key: 'dict', label: '数据字典', path: '/system/dict', icon: '≡', group: '系统管理' },
  { key: 'params', label: '系统参数', path: '/system/params', icon: '⚙', group: '系统管理' },
];

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
 */
export function AppLayout(props: AppLayoutProps): ReactElement {
  const { title, subtitle, actions, children } = props;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('tianji.sidebarCollapsed') === '1';
  });

  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('tianji.sidebarCollapsed', next ? '1' : '0');
  };

  const groups = Array.from(new Set(MENU.map((m) => m.group)));

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
              {MENU.filter((m) => m.group === g).map((m) => {
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
