import { useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  ListItemText,
  MenuItem,
  OutlinedInput,
  Select,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TablePagination,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import {
  DATA_SCOPE_LABELS,
  DATA_SCOPE_VALUES,
  OPERATION_TYPE_VALUES,
  OPERATION_TYPE_LABELS,
  PERMISSION_DOMAIN_LABELS,
  PERMISSION_DOMAIN_VALUES,
  PERMISSION_MODE_SYMBOL,
  ROLE_LABELS,
  SECURITY_LEVEL_LABELS,
  SECURITY_LEVEL_VALUES,
  USER_STATUS_LABELS,
  UserStatus,
  PermissionMode,
  type DataScopeType,
  type OperationType,
  type PermissionDomain,
  type PermissionGrant,
  type RoleDto,
  type SecurityLevel,
  type UserDto,
} from '@tianji/shared';
import { fondsApi, userApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';
import { useAuthStore } from '../../stores/authStore';

/** 数据范围选项（本地补充：Service 端的 scopeType 与枚举同构） */
const SCOPE_VALUES: readonly DataScopeType[] = DATA_SCOPE_VALUES;

/** 用户状态选项（共享包未导出 VALUES，此处按枚举顺序声明） */
const USER_STATUS_VALUES: readonly UserStatus[] = ['ACTIVE', 'DISABLED', 'LOCKED'];

/** 页签 */
const TAB_USERS = 0;
const TAB_ROLES = 1;

/**
 * 用户与角色管理页（F-09）。
 *
 * Tab 1：用户列表（增删改、重置密码、数据范围、密级上限）
 * Tab 2：角色权限矩阵（域 × 操作 5×23 复选，保存后立即刷新当前用户快照）
 *
 * 注意：这里只是"配置"入口，真正裁决仍在服务端 PermissionGuard。
 */
export function UsersPage(props: { initialTab?: number }): ReactElement {
  const { initialTab = TAB_USERS } = props;
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const refreshProfile = useAuthStore((s) => s.refreshProfile);

  const [tab, setTab] = useState<number>(initialTab);
  const [page, setPage] = useState<number>(1);
  const [size, setSize] = useState<number>(20);
  const [keyword, setKeyword] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // ------------------------------ 用户
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [editTarget, setEditTarget] = useState<UserDto | null>(null);
  const [scopeTarget, setScopeTarget] = useState<UserDto | null>(null);
  const [pwdTarget, setPwdTarget] = useState<UserDto | null>(null);
  const [newPwd, setNewPwd] = useState<string>('');

  const [formUsername, setFormUsername] = useState<string>('');
  const [formDisplayName, setFormDisplayName] = useState<string>('');
  const [formPassword, setFormPassword] = useState<string>('');
  const [formLevel, setFormLevel] = useState<SecurityLevel>('INTERNAL');
  const [formStatus, setFormStatus] = useState<UserStatus>('ACTIVE');
  const [formRoleIds, setFormRoleIds] = useState<string[]>([]);
  const [formScopes, setFormScopes] = useState<Array<{ scopeType: DataScopeType; scopeRefId: string | null }>>([
    { scopeType: 'SELF', scopeRefId: null },
  ]);

  const usersQuery = useQuery({
    queryKey: ['users', page, size, keyword],
    queryFn: () => userApi.list({ page, size, keyword: keyword || undefined }),
    enabled: tab === TAB_USERS,
  });

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => userApi.roles(),
  });

  const fondsQuery = useQuery({ queryKey: ['fonds'], queryFn: () => fondsApi.list() });

  const users: UserDto[] = usersQuery.data?.list ?? [];
  const total: number = usersQuery.data?.total ?? 0;
  /** 角色列表（引用稳定，避免下游 useMemo 每次重算） */
  const roles: RoleDto[] = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);

  const invalidateUsers = (): void => {
    void qc.invalidateQueries({ queryKey: ['users'] });
  };

  // ------------------------------ 用户 CRUD
  const createMutation = useMutation({
    mutationFn: async () => {
      if (formUsername.trim().length < 3) throw new Error('用户名至少 3 个字符');
      if (formDisplayName.trim().length === 0) throw new Error('请填写显示名');
      if (formPassword.length < 8) throw new Error('初始密码至少 8 位');
      return userApi.create({
        username: formUsername.trim(),
        password: formPassword,
        displayName: formDisplayName.trim(),
        status: formStatus,
        maxSecurityLevel: formLevel,
        roleIds: formRoleIds,
        scopes: formScopes,
      });
    },
    onSuccess: () => {
      enqueueSnackbar('用户创建成功', { variant: 'success' });
      setCreateOpen(false);
      resetUserForm();
      invalidateUsers();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editTarget) throw new Error('未选择用户');
      if (formDisplayName.trim().length === 0) throw new Error('请填写显示名');
      return userApi.update(editTarget.id, {
        displayName: formDisplayName.trim(),
        status: formStatus,
        maxSecurityLevel: formLevel,
        roleIds: formRoleIds,
      });
    },
    onSuccess: () => {
      enqueueSnackbar('用户信息已更新', { variant: 'success' });
      setEditTarget(null);
      invalidateUsers();
      void refreshProfile();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  const disableMutation = useMutation({
    mutationFn: (id: string) => userApi.disable(id),
    onSuccess: () => {
      enqueueSnackbar('用户已停用', { variant: 'info' });
      invalidateUsers();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : '停用失败'),
  });

  const resetPwdMutation = useMutation({
    mutationFn: async () => {
      if (!pwdTarget) throw new Error('未选择用户');
      if (newPwd.length < 8) throw new Error('新密码至少 8 位');
      return userApi.resetPassword(pwdTarget.id, newPwd);
    },
    onSuccess: () => {
      enqueueSnackbar('密码已重置（请通知用户尽快修改）', { variant: 'success' });
      setPwdTarget(null);
      setNewPwd('');
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : '重置失败'),
  });

  const scopeMutation = useMutation({
    mutationFn: async () => {
      if (!scopeTarget) throw new Error('未选择用户');
      return userApi.updateScopes(scopeTarget.id, formScopes);
    },
    onSuccess: () => {
      enqueueSnackbar('数据范围已更新', { variant: 'success' });
      setScopeTarget(null);
      invalidateUsers();
      void refreshProfile();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : '更新失败'),
  });

  const resetUserForm = (): void => {
    setFormUsername('');
    setFormDisplayName('');
    setFormPassword('');
    setFormLevel('INTERNAL');
    setFormStatus('ACTIVE');
    setFormRoleIds([]);
    setFormScopes([{ scopeType: 'SELF', scopeRefId: null }]);
    setError(null);
  };

  /** 进入编辑态 */
  const openEdit = (u: UserDto): void => {
    setEditTarget(u);
    setFormDisplayName(u.displayName);
    setFormLevel(u.maxSecurityLevel);
    setFormStatus(u.status);
    setFormRoleIds(u.roles.map((r) => r.id));
  };

  /** 进入数据范围编辑 */
  const openScope = (u: UserDto): void => {
    setScopeTarget(u);
    setFormScopes(
      u.scopes.length > 0
        ? u.scopes.map((s) => ({ scopeType: s.scopeType as DataScopeType, scopeRefId: s.scopeRefId }))
        : [{ scopeType: 'SELF', scopeRefId: null }],
    );
  };

  // ------------------------------ 角色权限矩阵
  const [activeRoleId, setActiveRoleId] = useState<string>('');
  const activeRole: RoleDto | undefined = useMemo(() => {
    if (activeRoleId) return roles.find((r) => r.id === activeRoleId);
    return roles[0];
  }, [activeRoleId, roles]);

  /** 本地编辑态：domain → ops Set */
  const [matrix, setMatrix] = useState<Record<string, OperationType[]>>({});
  const [matrixRoleId, setMatrixRoleId] = useState<string>('');

  /** 切换角色时同步矩阵 */
  const matrixSourceId = activeRole?.id ?? '';
  if (activeRole && matrixRoleId !== matrixSourceId) {
    const init: Record<string, OperationType[]> = {};
    for (const domain of PERMISSION_DOMAIN_VALUES) {
      const g = activeRole.permissions.find((p) => p.domain === domain);
      init[domain] = g ? [...g.ops] : [];
    }
    setMatrix(init);
    setMatrixRoleId(matrixSourceId);
  }

  const toggleOp = (domain: PermissionDomain, op: OperationType): void => {
    setMatrix((prev) => {
      const ops = prev[domain] ?? [];
      const next = ops.includes(op) ? ops.filter((o) => o !== op) : [...ops, op];
      return { ...prev, [domain]: next };
    });
  };

  /** 整行全选/清空 */
  const toggleRow = (domain: PermissionDomain): void => {
    setMatrix((prev) => {
      const ops = prev[domain] ?? [];
      const full = OPERATION_TYPE_VALUES.every((o) => ops.includes(o));
      return { ...prev, [domain]: full ? [] : [...OPERATION_TYPE_VALUES] };
    });
  };

  const saveRoleMutation = useMutation({
    mutationFn: async () => {
      if (!activeRole) throw new Error('未选择角色');
      const permissions: PermissionGrant[] = PERMISSION_DOMAIN_VALUES.map((domain) => {
        const ops = matrix[domain] ?? [];
        const original = activeRole.permissions.find((p) => p.domain === domain);
        return {
          domain,
          ops,
          mode:
            ops.length === 0
              ? PermissionMode.NONE
              : ops.length === OPERATION_TYPE_VALUES.length
                ? PermissionMode.FULL
                : original?.mode === PermissionMode.READONLY && ops.length === 1 && ops[0] === 'READ'
                  ? PermissionMode.READONLY
                  : PermissionMode.LIMITED,
          scoped: original?.scoped ?? true,
          levelCapped: original?.levelCapped ?? true,
        };
      });
      return userApi.updateRolePermissions(activeRole.id, permissions);
    },
    onSuccess: () => {
      enqueueSnackbar('角色权限已保存，当前登录态将自动刷新', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['roles'] });
      void refreshProfile();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : '保存失败'),
  });

  return (
    <AppLayout
      title="用户与角色"
      subtitle="用户 CRUD + 数据范围 + 角色权限矩阵（四要素：角色 × 范围 × 密级 × 操作）"
      actions={
        tab === TAB_USERS ? (
          <PermGate domain="USER" op="WRITE">
            <Button
              size="small"
              variant="contained"
              onClick={() => {
                resetUserForm();
                setCreateOpen(true);
              }}
            >
              新建用户
            </Button>
          </PermGate>
        ) : (
          <PermGate domain="USER" op="WRITE">
            <Button
              size="small"
              variant="contained"
              onClick={() => saveRoleMutation.mutate()}
              disabled={saveRoleMutation.isPending || !activeRole}
            >
              保存权限矩阵
            </Button>
          </PermGate>
        )
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card>
        <CardContent sx={{ p: 1.5 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <Tabs value={tab} onChange={(_e, v: number) => setTab(v)} sx={{ minHeight: 34 }}>
              <Tab label="用户管理" sx={{ minHeight: 34, py: 0.5 }} />
              <Tab label="角色权限" sx={{ minHeight: 34, py: 0.5 }} />
            </Tabs>
            <Box sx={{ flex: 1 }} />
            {tab === TAB_USERS && (
              <TextField
                size="small"
                label="用户名/显示名"
                value={keyword}
                onChange={(e) => {
                  setKeyword(e.target.value);
                  setPage(1);
                }}
                sx={{ width: 200 }}
              />
            )}
          </Stack>

          {/* ---- Tab 用户 ---- */}
          {tab === TAB_USERS && (
            <>
              <Table size="small" className="dense-table">
                <TableHead>
                  <TableRow>
                    <TableCell width={130}>用户名</TableCell>
                    <TableCell width={130}>显示名</TableCell>
                    <TableCell width={160}>角色</TableCell>
                    <TableCell width={90}>密级上限</TableCell>
                    <TableCell width={140}>数据范围</TableCell>
                    <TableCell width={80}>状态</TableCell>
                    <TableCell width={130}>最近登录</TableCell>
                    <TableCell width={210}>操作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {usersQuery.isLoading && (
                    <TableRow>
                      <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                        加载中…
                      </TableCell>
                    </TableRow>
                  )}
                  {!usersQuery.isLoading && users.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                        暂无用户
                      </TableCell>
                    </TableRow>
                  )}
                  {users.map((u) => (
                    <TableRow key={u.id} hover>
                      <TableCell>
                        <Typography variant="body2" className="mono">
                          {u.username}
                        </Typography>
                      </TableCell>
                      <TableCell>{u.displayName}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                          {u.roles.map((r) => (
                            <Chip
                              key={r.id}
                              size="small"
                              label={ROLE_LABELS[r.code] ?? r.code}
                              variant="outlined"
                              sx={{ height: 18 }}
                            />
                          ))}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={SECURITY_LEVEL_LABELS[u.maxSecurityLevel]}
                          color={u.maxSecurityLevel === 'SECRET' ? 'error' : u.maxSecurityLevel === 'INTERNAL' ? 'warning' : 'success'}
                          variant="outlined"
                          sx={{ height: 18 }}
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption">
                          {u.scopes
                            .map((s) => {
                              if (s.scopeType === 'FONDS') {
                                const f = fondsQuery.data?.find((x) => x.id === s.scopeRefId);
                                return `全宗:${f?.fondsNo ?? s.scopeRefId?.slice(0, 6) ?? '-'}`;
                              }
                              return DATA_SCOPE_LABELS[s.scopeType as DataScopeType] ?? s.scopeType;
                            })
                            .join(' / ') || '—'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={USER_STATUS_LABELS[u.status] ?? u.status}
                          color={u.status === 'ACTIVE' ? 'success' : u.status === 'LOCKED' ? 'error' : 'default'}
                          variant="outlined"
                          sx={{ height: 18 }}
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption">
                          {u.lastLoginAt ? u.lastLoginAt.slice(0, 16).replace('T', ' ') : '从未登录'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.25} flexWrap="wrap" useFlexGap>
                          <PermGate domain="USER" op="WRITE">
                            <Button size="small" onClick={() => openEdit(u)}>
                              编辑
                            </Button>
                          </PermGate>
                          <PermGate domain="USER" op="WRITE">
                            <Button size="small" onClick={() => openScope(u)}>
                              范围
                            </Button>
                          </PermGate>
                          <PermGate domain="USER" op="WRITE">
                            <Button
                              size="small"
                              onClick={() => {
                                setPwdTarget(u);
                                setNewPwd('');
                              }}
                            >
                              重置密码
                            </Button>
                          </PermGate>
                          <PermGate domain="USER" op="DELETE">
                            <Button
                              size="small"
                              color="error"
                              onClick={() => {
                                if (window.confirm(`确认停用用户「${u.username}」？`)) {
                                  disableMutation.mutate(u.id);
                                }
                              }}
                            >
                              停用
                            </Button>
                          </PermGate>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <TablePagination
                component="div"
                count={total}
                page={page - 1}
                rowsPerPage={size}
                rowsPerPageOptions={[10, 20, 50]}
                onPageChange={(_e, p) => setPage(p + 1)}
                onRowsPerPageChange={(e) => {
                  setSize(Number(e.target.value));
                  setPage(1);
                }}
                labelRowsPerPage="每页"
                labelDisplayedRows={({ from, to, count }) => `${from}-${to} / 共 ${count} 条`}
              />
            </>
          )}

          {/* ---- Tab 角色权限矩阵 ---- */}
          {tab === TAB_ROLES && (
            <>
              <Stack direction="row" spacing={1} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
                {roles.map((r) => (
                  <Chip
                    key={r.id}
                    label={`${ROLE_LABELS[r.code] ?? r.code}${r.builtin ? '（内置）' : ''}`}
                    color={activeRole?.id === r.id ? 'primary' : 'default'}
                    variant={activeRole?.id === r.id ? 'filled' : 'outlined'}
                    onClick={() => setActiveRoleId(r.id)}
                  />
                ))}
                {roles.length === 0 && (
                  <Typography variant="caption" color="text.secondary">
                    暂无角色
                  </Typography>
                )}
              </Stack>

              {activeRole && (
                <>
                  <Alert severity="info" sx={{ mb: 1.5 }}>
                    图例：{PERMISSION_MODE_SYMBOL.FULL} 全权 · {PERMISSION_MODE_SYMBOL.LIMITED} 受限 ·{' '}
                    {PERMISSION_MODE_SYMBOL.READONLY} 只读 · {PERMISSION_MODE_SYMBOL.NONE} 无权限。
                    勾选即授予该「功能域 × 操作」，保存后立即生效（服务端 Guard 为准）。
                  </Alert>

                  <Table size="small" className="dense-table">
                    <TableHead>
                      <TableRow>
                        <TableCell width={190}>功能域</TableCell>
                        {OPERATION_TYPE_VALUES.map((op) => (
                          <TableCell key={op} align="center" width={70}>
                            {OPERATION_TYPE_LABELS[op]}
                            <Typography variant="caption" display="block" color="text.disabled">
                              {op}
                            </Typography>
                          </TableCell>
                        ))}
                        <TableCell align="center" width={80}>
                          整行
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {PERMISSION_DOMAIN_VALUES.map((domain) => {
                        const ops = matrix[domain] ?? [];
                        const full = OPERATION_TYPE_VALUES.every((o) => ops.includes(o));
                        return (
                          <TableRow key={domain} hover>
                            <TableCell>
                              <Tooltip title={domain}>
                                <Typography variant="body2">
                                  {PERMISSION_DOMAIN_LABELS[domain]}
                                </Typography>
                              </Tooltip>
                            </TableCell>
                            {OPERATION_TYPE_VALUES.map((op) => (
                              <TableCell key={`${domain}-${op}`} align="center" padding="none">
                                <Checkbox
                                  size="small"
                                  checked={ops.includes(op)}
                                  onChange={() => toggleOp(domain, op)}
                                />
                              </TableCell>
                            ))}
                            <TableCell align="center" padding="none">
                              <IconButton size="small" onClick={() => toggleRow(domain)}>
                                {full ? '⊖' : '⊕'}
                              </IconButton>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ---- 新建用户 ---- */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>新建用户</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField
              size="small"
              label="用户名 *"
              value={formUsername}
              onChange={(e) => setFormUsername(e.target.value)}
              helperText="登录账号，3~32 字符"
            />
            <TextField
              size="small"
              label="显示名 *"
              value={formDisplayName}
              onChange={(e) => setFormDisplayName(e.target.value)}
            />
            <TextField
              size="small"
              type="password"
              label="初始密码 *"
              value={formPassword}
              onChange={(e) => setFormPassword(e.target.value)}
              helperText="至少 8 位，建议含大小写字母与数字"
            />
            <TextField
              select
              size="small"
              label="密级上限"
              value={formLevel}
              onChange={(e) => setFormLevel(e.target.value as SecurityLevel)}
            >
              {SECURITY_LEVEL_VALUES.map((l) => (
                <MenuItem key={l} value={l}>
                  {SECURITY_LEVEL_LABELS[l]}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label="状态"
              value={formStatus}
              onChange={(e) => setFormStatus(e.target.value as UserStatus)}
            >
              {USER_STATUS_VALUES.map((s) => (
                <MenuItem key={s} value={s}>
                  {USER_STATUS_LABELS[s]}
                </MenuItem>
              ))}
            </TextField>
            <FormControl size="small">
              <InputLabel>角色</InputLabel>
              <Select
                multiple
                value={formRoleIds}
                onChange={(e) => setFormRoleIds(e.target.value as string[])}
                input={<OutlinedInput label="角色" />}
                renderValue={(selected) =>
                  (selected as string[])
                    .map((id) => {
                      const r = roles.find((x) => x.id === id);
                      return r ? (ROLE_LABELS[r.code] ?? r.code) : id;
                    })
                    .join(', ')
                }
              >
                {roles.map((r) => (
                  <MenuItem key={r.id} value={r.id}>
                    <Checkbox size="small" checked={formRoleIds.includes(r.id)} />
                    <ListItemText primary={`${ROLE_LABELS[r.code] ?? r.code} (${r.code})`} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Divider />
            <Typography variant="caption" color="text.secondary">
              数据范围
            </Typography>
            {formScopes.map((s, i) => (
              <Stack key={`${s.scopeType}-${i}`} direction="row" spacing={1} alignItems="center">
                <TextField
                  select
                  size="small"
                  label="范围类型"
                  value={s.scopeType}
                  onChange={(e) =>
                    setFormScopes((prev) =>
                      prev.map((x, idx) =>
                        idx === i
                          ? { scopeType: e.target.value as DataScopeType, scopeRefId: null }
                          : x,
                      ),
                    )
                  }
                  sx={{ width: 150 }}
                >
                  {SCOPE_VALUES.map((v) => (
                    <MenuItem key={v} value={v}>
                      {DATA_SCOPE_LABELS[v]}
                    </MenuItem>
                  ))}
                </TextField>
                {s.scopeType === 'FONDS' && (
                  <TextField
                    select
                    size="small"
                    label="全宗"
                    value={s.scopeRefId ?? ''}
                    onChange={(e) =>
                      setFormScopes((prev) =>
                        prev.map((x, idx) =>
                          idx === i ? { ...x, scopeRefId: e.target.value } : x,
                        ),
                      )
                    }
                    sx={{ flex: 1 }}
                  >
                    {(fondsQuery.data ?? []).map((f) => (
                      <MenuItem key={f.id} value={f.id}>
                        {f.fondsNo} {f.name}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
                <Button
                  size="small"
                  color="error"
                  onClick={() => setFormScopes((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  删除
                </Button>
              </Stack>
            ))}
            <Button
              size="small"
              onClick={() =>
                setFormScopes((prev) => [...prev, { scopeType: 'FONDS', scopeRefId: null }])
              }
            >
              + 添加范围
            </Button>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            创建
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---- 编辑用户 ---- */}
      <Dialog open={editTarget !== null} onClose={() => setEditTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>编辑用户 · {editTarget?.username}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField
              size="small"
              label="显示名 *"
              value={formDisplayName}
              onChange={(e) => setFormDisplayName(e.target.value)}
            />
            <TextField
              select
              size="small"
              label="密级上限"
              value={formLevel}
              onChange={(e) => setFormLevel(e.target.value as SecurityLevel)}
            >
              {SECURITY_LEVEL_VALUES.map((l) => (
                <MenuItem key={l} value={l}>
                  {SECURITY_LEVEL_LABELS[l]}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label="状态"
              value={formStatus}
              onChange={(e) => setFormStatus(e.target.value as UserStatus)}
            >
              {USER_STATUS_VALUES.map((s) => (
                <MenuItem key={s} value={s}>
                  {USER_STATUS_LABELS[s]}
                </MenuItem>
              ))}
            </TextField>
            <FormControl size="small">
              <InputLabel>角色</InputLabel>
              <Select
                multiple
                value={formRoleIds}
                onChange={(e) => setFormRoleIds(e.target.value as string[])}
                input={<OutlinedInput label="角色" />}
                renderValue={(selected) =>
                  (selected as string[])
                    .map((id) => {
                      const r = roles.find((x) => x.id === id);
                      return r ? (ROLE_LABELS[r.code] ?? r.code) : id;
                    })
                    .join(', ')
                }
              >
                {roles.map((r) => (
                  <MenuItem key={r.id} value={r.id}>
                    <Checkbox size="small" checked={formRoleIds.includes(r.id)} />
                    <ListItemText primary={ROLE_LABELS[r.code] ?? r.code} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditTarget(null)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => updateMutation.mutate()}
            disabled={updateMutation.isPending}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---- 数据范围 ---- */}
      <Dialog open={scopeTarget !== null} onClose={() => setScopeTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>数据范围 · {scopeTarget?.displayName}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Alert severity="info">
              数据范围决定用户能看到哪些全宗/机构的档案。四要素 Guard 会把它翻译成 SQL 的
              where 与 ES 的 filter；「本人创建」会附加 createdBy 条件。
            </Alert>
            {formScopes.map((s, i) => (
              <Stack key={`sc-${i}`} direction="row" spacing={1} alignItems="center">
                <TextField
                  select
                  size="small"
                  label="范围类型"
                  value={s.scopeType}
                  onChange={(e) =>
                    setFormScopes((prev) =>
                      prev.map((x, idx) =>
                        idx === i
                          ? { scopeType: e.target.value as DataScopeType, scopeRefId: null }
                          : x,
                      ),
                    )
                  }
                  sx={{ width: 150 }}
                >
                  {SCOPE_VALUES.map((v) => (
                    <MenuItem key={v} value={v}>
                      {DATA_SCOPE_LABELS[v]}
                    </MenuItem>
                  ))}
                </TextField>
                {s.scopeType === 'FONDS' && (
                  <TextField
                    select
                    size="small"
                    label="全宗"
                    value={s.scopeRefId ?? ''}
                    onChange={(e) =>
                      setFormScopes((prev) =>
                        prev.map((x, idx) =>
                          idx === i ? { ...x, scopeRefId: e.target.value } : x,
                        ),
                      )
                    }
                    sx={{ flex: 1 }}
                  >
                    {(fondsQuery.data ?? []).map((f) => (
                      <MenuItem key={f.id} value={f.id}>
                        {f.fondsNo} {f.name}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
                <Button
                  size="small"
                  color="error"
                  onClick={() => setFormScopes((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  删除
                </Button>
              </Stack>
            ))}
            <Button
              size="small"
              onClick={() =>
                setFormScopes((prev) => [...prev, { scopeType: 'FONDS', scopeRefId: null }])
              }
            >
              + 添加范围
            </Button>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setScopeTarget(null)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => scopeMutation.mutate()}
            disabled={scopeMutation.isPending}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---- 重置密码 ---- */}
      <Dialog open={pwdTarget !== null} onClose={() => setPwdTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>重置密码 · {pwdTarget?.username}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Alert severity="warning">重置后请通过安全渠道通知用户，并要求其首次登录后立即修改。</Alert>
            <TextField
              size="small"
              type="password"
              label="新密码 *"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              helperText="至少 8 位"
            />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPwdTarget(null)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => resetPwdMutation.mutate()}
            disabled={resetPwdMutation.isPending}
          >
            确认重置
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}
