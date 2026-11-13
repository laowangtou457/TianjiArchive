import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import type { SearchSynonymDto } from '@tianji/shared';
import { searchApi } from '../../api';
import { ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

/**
 * 检索同义词维护（对齐泰坦 DARMS「同义词」功能）。
 *
 * ## 交互设计上的两个刻意选择
 *
 * 1) **一组一行，而不是「词 A → 词 B」成对维护**：同义是等价关系，成对维护
 *    必然出现「A→B 存了、B→A 没存」的不对称，用户搜 B 就搜不到 A 的档。
 * 2) **保存即生效**：不做「重建索引」这种重型动作，改完立刻能搜出来验证，
 *    否则运维改一条词要等几分钟才知道对不对。
 *
 * 状态列用开关直接改 enabled：停用比删除更常用（季节性词、临时活动词），
 * 停用保留词条便于以后恢复，也不丢备注。
 */
export function SynonymPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SearchSynonymDto | null>(null);
  const [wordsText, setWordsText] = useState('');
  const [note, setNote] = useState('');

  const listQuery = useQuery({
    queryKey: ['search-synonyms'],
    queryFn: () => searchApi.synonyms(),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const words = parseWords(wordsText);
      if (words.length < 2) throw new Error('至少填两个词，用逗号、顿号或空格分隔');
      if (editing) return searchApi.updateSynonym(editing.id, { words, note: note.trim() || null });
      return searchApi.createSynonym(words, note.trim() || undefined);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? '已保存' : '已新增同义词组', { variant: 'success' });
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['search-synonyms'] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : (err as Error).message, {
        variant: 'error',
      }),
  });

  const toggleMutation = useMutation({
    mutationFn: (row: SearchSynonymDto) =>
      searchApi.updateSynonym(row.id, { enabled: !row.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['search-synonyms'] }),
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '操作失败', { variant: 'error' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => searchApi.removeSynonym(id),
    onSuccess: () => {
      enqueueSnackbar('已删除', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['search-synonyms'] });
    },
    onError: (err: unknown) =>
      enqueueSnackbar(err instanceof ApiError ? err.message : '删除失败', { variant: 'error' }),
  });

  const openCreate = (): void => {
    setEditing(null);
    setWordsText('');
    setNote('');
    setDialogOpen(true);
  };

  const openEdit = (row: SearchSynonymDto): void => {
    setEditing(row);
    setWordsText(row.words.join('、'));
    setNote(row.note ?? '');
    setDialogOpen(true);
  };

  const rows = listQuery.data ?? [];

  return (
    <AppLayout title="检索同义词">
      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          一组内的词互为等价。检索时命中任一词，其余词会以 0.55 的权重参与召回（原词 1.0），
          用来「召回更多」而不会把精确命中的结果挤下去。<b>保存即生效</b>，无需重建索引。
        </Alert>

        <Card>
          <CardContent>
            <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
              <Typography variant="h6">同义词组（{rows.length}）</Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" onClick={() => void listQuery.refetch()}>
                  刷新
                </Button>
                <PermGate domain="PARAM" op="WRITE">
                  <Button variant="contained" onClick={openCreate}>
                    + 新建同义词组
                  </Button>
                </PermGate>
              </Stack>
            </Stack>

            {listQuery.isError && (
              <Alert severity="error">
                {listQuery.error instanceof ApiError
                  ? listQuery.error.message
                  : '加载失败（需要系统参数读权限）'}
              </Alert>
            )}

            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell width="46%">等价词组</TableCell>
                  <TableCell width="26%">备注</TableCell>
                  <TableCell width="10%" align="center">
                    启用
                  </TableCell>
                  <TableCell width="18%" align="right">
                    操作
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 && !listQuery.isLoading && (
                  <TableRow>
                    <TableCell colSpan={4}>
                      <Typography variant="body2" color="text.secondary">
                        还没有同义词组。点「新建同义词组」，例如：档案、卷宗、案卷。
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {row.words.map((w) => (
                          <Chip
                            key={w}
                            label={w}
                            size="small"
                            color={row.enabled ? 'default' : 'default'}
                            variant={row.enabled ? 'filled' : 'outlined'}
                          />
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {row.note ?? '—'}
                      </Typography>
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip title={row.enabled ? '停用后不再参与扩展' : '启用后立即参与检索扩展'}>
                        <Switch
                          size="small"
                          checked={row.enabled}
                          disabled={toggleMutation.isPending}
                          onChange={() => toggleMutation.mutate(row)}
                        />
                      </Tooltip>
                    </TableCell>
                    <TableCell align="right">
                      <PermGate domain="PARAM" op="WRITE">
                        <Button size="small" onClick={() => openEdit(row)}>
                          编辑
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          disabled={removeMutation.isPending}
                          onClick={() => {
                            if (window.confirm(`删除词组「${row.words.join('、')}」？`)) {
                              removeMutation.mutate(row.id);
                            }
                          }}
                        >
                          删除
                        </Button>
                      </PermGate>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Stack>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{editing ? '编辑同义词组' : '新建同义词组'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              label="等价词组"
              value={wordsText}
              onChange={(e) => setWordsText(e.target.value)}
              placeholder="例如：档案、卷宗、案卷"
              helperText="用逗号、顿号、空格或分号分隔，至少 2 个词；同一个词不能出现在两个组里"
              fullWidth
              autoFocus
            />
            <TextField
              label="备注（可选）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：业务口径，来源于《档案著录规则》"
              fullWidth
            />
            <Box>
              <Typography variant="caption" color="text.secondary">
                预览：
              </Typography>
              <Stack direction="row" spacing={0.5} mt={0.5} flexWrap="wrap" useFlexGap>
                {parseWords(wordsText).map((w) => (
                  <Chip key={w} label={w} size="small" />
                ))}
              </Stack>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}

/** 中英文分隔符统一处理：逗号/顿号/分号/空白都算分隔 */
function parseWords(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，、;；\s]+/)
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ];
}
