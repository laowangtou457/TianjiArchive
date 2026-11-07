import { useState, type ReactElement } from 'react';
import { Alert, Box, Button, Card, CardContent, Stack, TextField, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

/**
 * 登录页。
 * 等保要求：失败提示统一为「用户名或密码错误」，不区分是否存在账号（防枚举）。
 */
export function LoginPage(): ReactElement {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const loading = useAuthStore((s) => s.loading);
  const error = useAuthStore((s) => s.error);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');

  const submit = async (): Promise<void> => {
    try {
      await login(username.trim(), password);
      navigate('/', { replace: true });
    } catch {
      // 错误已写入 store.error
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg,#152260 0%,#1f359b 55%,#4f6ef7 100%)',
      }}
    >
      <Card sx={{ width: 380, p: 1 }}>
        <CardContent>
          <Stack spacing={0.5} sx={{ mb: 3 }}>
            <Typography variant="h2" sx={{ color: '#1a2b7a' }}>
              天玑档案管理系统
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Tianji Archive Management System · 本地复刻版
            </Typography>
          </Stack>

          <Stack
            component="form"
            spacing={2}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <TextField
              label="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              fullWidth
              autoComplete="username"
            />
            <TextField
              label="密码"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              fullWidth
              autoComplete="current-password"
              helperText="连续 5 次输错将锁定 30 分钟"
            />
            {error && <Alert severity="error">{error}</Alert>}
            <Button type="submit" variant="contained" size="medium" disabled={loading || !password}>
              {loading ? '登录中…' : '登 录'}
            </Button>
            <Typography variant="caption" color="text.secondary" align="center">
              默认管理员 admin / Tianji@2024（首次登录后请立即修改）
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
