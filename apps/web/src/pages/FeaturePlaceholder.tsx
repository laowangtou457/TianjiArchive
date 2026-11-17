import { type ReactElement } from 'react';
import { Alert, Box, Card, Chip, List, ListItem, ListItemText, Stack, Typography } from '@mui/material';
import { AppLayout } from '../components/AppLayout';

/**
 * 新功能占位页。
 * P5–P8 规划中的功能在真实实现落地前先挂本页，保证导航可点、系统可运行。
 * 真实页面完成后由 router 替换本组件。
 */
export function FeaturePlaceholder(props: {
  title: string;
  section: string;
  subtitle?: string;
  features: string[];
}): ReactElement {
  const { title, section, subtitle, features } = props;
  return (
    <AppLayout title={title} subtitle={subtitle ?? `${section} · 规划中功能`}>
      <Stack spacing={2}>
        <Alert severity="info">
          本模块已按泰坦 DARMS 功能树规划入口，正在按 <b>P5–P8</b> 分期实现。
          下方列出泰坦对应功能的完整清单，便于验收比对。
        </Alert>
        <Card variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1.5 }}>
            泰坦对应功能点（{features.length}）
          </Typography>
          <List dense>
            {features.map((f) => (
              <ListItem key={f} disableGutters>
                <ListItemText primary={f} />
                <Chip size="small" label="待实现" variant="outlined" />
              </ListItem>
            ))}
          </List>
        </Card>
        <Box sx={{ color: 'text.secondary', fontSize: 12 }}>
          功能树原文见工程 <code>docs/泰坦功能树-完整版.md</code>；差距与分期见{' '}
          <code>docs/泰坦功能全量对照与差距清单.md</code>。
        </Box>
      </Stack>
    </AppLayout>
  );
}
