import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Divider,
  FormControlLabel,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { api, ApiError } from '../../api/client';
import { AppLayout } from '../../components/AppLayout';
import { PermGate } from '../../components/PermGate';

const STEPS = ['建立批次', '模板配置', '数据导入', '确认', '记录明细'];

interface ImportBatch {
  id: string;
  batchNo: string;
  name: string;
  status: 'CREATED' | 'UPLOADED' | 'CONFIRMED';
  fileCount: number;
  successCount: number;
  failCount: number;
  createdAt: string;
}

interface ImportTemplateField {
  key: 'danghao' | 'title' | 'responsible' | 'year' | 'securityLevel';
  label: string;
  enabled: boolean;
}

interface ImportDetailRow {
  line: number;
  danghao: string;
  title: string;
  responsible: string | null;
  year: number | null;
  securityLevel: string;
  valid: boolean;
  error: string | null;
  imported: boolean;
}

interface ImportBatchDetail extends ImportBatch {
  details: ImportDetailRow[];
}

const DEFAULT_TEMPLATE: ImportTemplateField[] = [
  { key: 'danghao', label: '档号', enabled: true },
  { key: 'title', label: '题名', enabled: true },
  { key: 'responsible', label: '责任者', enabled: true },
  { key: 'year', label: '年度', enabled: true },
  { key: 'securityLevel', label: '密级', enabled: true },
];

const STATUS_LABEL: Record<ImportBatch['status'], string> = {
  CREATED: '已建立',
  UPLOADED: '已导入',
  CONFIRMED: '已确认',
};

const STATUS_COLOR: Record<ImportBatch['status'], 'default' | 'info' | 'success'> = {
  CREATED: 'default',
  UPLOADED: 'info',
  CONFIRMED: 'success',
};

/**
 * 数据导入页 P5：泰坦五步向导（建立批次 → 模板配置 → 数据导入 → 确认 → 记录明细）。
 * 文本域粘贴 CSV（档号,题名,责任者,年度,密级），支持 JSON 数组。
 */
export function DataImportPage(): ReactElement {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [activeStep, setActiveStep] = useState<number>(0);
  const [batchName, setBatchName] = useState<string>('');
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [template, setTemplate] = useState<ImportTemplateField[]>(DEFAULT_TEMPLATE);
  const [content, setContent] = useState<string>('');
  const [detail, setDetail] = useState<ImportBatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const batchQuery = useQuery({
    queryKey: ['import-batches'],
    queryFn: (): Promise<ImportBatch[]> => api.get('/datainfo/import/batches'),
  });

  const showError = (err: unknown, fallback: string): void => {
    setError(err instanceof ApiError ? err.message : fallback);
  };

  const createMutation = useMutation({
    mutationFn: (): Promise<ImportBatch> =>
      api.post('/datainfo/import/batches', { name: batchName.trim() }),
    onSuccess: (created) => {
      setBatch(created);
      setDetail(null);
      setError(null);
      setActiveStep(1);
      enqueueSnackbar('批次已建立', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['import-batches'] });
    },
    onError: (err: unknown) => showError(err, '建立批次失败'),
  });

  const uploadMutation = useMutation({
    mutationFn: (): Promise<ImportBatchDetail> =>
      api.post(`/datainfo/import/batches/${batch?.id ?? ''}/upload`, {
        content,
        templateJson: template,
      }),
    onSuccess: (res) => {
      setDetail(res);
      setError(null);
      setActiveStep(3);
      enqueueSnackbar(`解析完成：成功 ${res.successCount} 行，失败 ${res.failCount} 行`, {
        variant: res.failCount > 0 ? 'warning' : 'success',
      });
      void qc.invalidateQueries({ queryKey: ['import-batches'] });
    },
    onError: (err: unknown) => showError(err, '导入解析失败'),
  });

  const confirmMutation = useMutation({
    mutationFn: (): Promise<{ inserted: number; skipped: number }> =>
      api.post(`/datainfo/import/batches/${batch?.id ?? ''}/confirm`),
    onSuccess: (res) => {
      setActiveStep(4);
      setError(null);
      enqueueSnackbar(`确认入库 ${res.inserted} 条，跳过 ${res.skipped} 条`, { variant: 'success' });
      if (batch) {
        void api
          .get<ImportBatchDetail>(`/datainfo/import/batches/${batch.id}/detail`)
          .then(setDetail)
          .catch((err: unknown) => showError(err, '加载明细失败'));
      }
      void qc.invalidateQueries({ queryKey: ['import-batches'] });
    },
    onError: (err: unknown) => showError(err, '确认入库失败'),
  });

  const viewDetail = (item: ImportBatch): void => {
    setBatch(item);
    setError(null);
    void api
      .get<ImportBatchDetail>(`/datainfo/import/batches/${item.id}/detail`)
      .then((res) => {
        setDetail(res);
        setActiveStep(4);
      })
      .catch((err: unknown) => showError(err, '加载明细失败'));
  };

  const toggleColumn = (key: ImportTemplateField['key']): void => {
    setTemplate((prev) => prev.map((f) => (f.key === key ? { ...f, enabled: !f.enabled } : f)));
  };

  const details = detail?.details ?? [];
  const currentBatch = detail ?? batch;

  return (
    <AppLayout title="数据导入" subtitle="建立批次 → 模板配置 → 数据导入 → 确认 → 记录明细 · 权限域 IMPORT_EXPORT">
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card sx={{ mb: 1.5 }}>
        <CardContent sx={{ p: 1.5 }}>
          <Stepper activeStep={activeStep} alternativeLabel>
            {STEPS.map((label) => (
              <Step key={label}>
                <StepLabel>{label}</StepLabel>
              </Step>
            ))}
          </Stepper>
        </CardContent>
      </Card>

      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Card sx={{ flex: 1, minWidth: 0 }}>
          <CardContent sx={{ p: 2 }}>
            {/* 步骤 1：建立批次 */}
            {activeStep === 0 && (
              <Stack spacing={1.5}>
                <Typography variant="subtitle1">第一步 · 建立导入批次</Typography>
                <TextField
                  size="small"
                  label="批次名称 *"
                  value={batchName}
                  onChange={(e) => setBatchName(e.target.value)}
                  placeholder="例如：2026 年度文书档案移交导入"
                  sx={{ maxWidth: 460 }}
                />
                <Stack direction="row" spacing={1}>
                  <PermGate domain="IMPORT_EXPORT" op="WRITE">
                    <Button
                      variant="contained"
                      onClick={() => createMutation.mutate()}
                      disabled={createMutation.isPending || !batchName.trim()}
                    >
                      建立批次
                    </Button>
                  </PermGate>
                  {batch && (
                    <Button onClick={() => setActiveStep(1)}>进入模板配置</Button>
                  )}
                </Stack>
                {batch && (
                  <Alert severity="info">
                    当前批次：{batch.batchNo} · {batch.name}（{STATUS_LABEL[batch.status]}）
                  </Alert>
                )}
              </Stack>
            )}

            {/* 步骤 2：模板配置 */}
            {activeStep === 1 && (
              <Stack spacing={1.5}>
                <Typography variant="subtitle1">第二步 · 模板字段配置（勾选需要导入的列）</Typography>
                <Typography variant="caption" color="text.secondary">
                  列顺序：{template.filter((f) => f.enabled).map((f) => f.label).join(' → ') || '（未选择任何列）'}
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {DEFAULT_TEMPLATE.map((field) => (
                    <FormControlLabel
                      key={field.key}
                      control={
                        <Checkbox
                          checked={template.find((f) => f.key === field.key)?.enabled ?? false}
                          onChange={() => toggleColumn(field.key)}
                        />
                      }
                      label={field.label}
                    />
                  ))}
                </Stack>
                <Alert severity="info">
                  档号列为必填项；关闭其它列时，请保证粘贴文本的列顺序与此处一致。
                </Alert>
                <Stack direction="row" spacing={1}>
                  <Button onClick={() => setActiveStep(0)}>上一步</Button>
                  <Button
                    variant="contained"
                    onClick={() => setActiveStep(2)}
                    disabled={!template.find((f) => f.key === 'danghao')?.enabled}
                  >
                    下一步：数据导入
                  </Button>
                </Stack>
              </Stack>
            )}

            {/* 步骤 3：数据导入 */}
            {activeStep === 2 && (
              <Stack spacing={1.5}>
                <Typography variant="subtitle1">第三步 · 粘贴数据（每行一条，逗号分隔）</Typography>
                <Typography variant="caption" color="text.secondary" component="pre">
                  {`档号,题名,责任者,年度,密级\nDA-2026-0001,关于档案管理的通知,办公室,2026,PUBLIC`}
                </Typography>
                <TextField
                  label="CSV / JSON 文本"
                  placeholder="档号,题名,责任者,年度,密级"
                  multiline
                  minRows={10}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  fullWidth
                />
                <Stack direction="row" spacing={1}>
                  <Button onClick={() => setActiveStep(1)}>上一步</Button>
                  <PermGate domain="IMPORT_EXPORT" op="WRITE">
                    <Button
                      variant="contained"
                      onClick={() => uploadMutation.mutate()}
                      disabled={uploadMutation.isPending || !content.trim() || !batch}
                    >
                      解析并导入
                    </Button>
                  </PermGate>
                </Stack>
              </Stack>
            )}

            {/* 步骤 4：确认 */}
            {activeStep === 3 && (
              <Stack spacing={1.5}>
                <Typography variant="subtitle1">第四步 · 确认入库</Typography>
                <Alert severity={detail && detail.failCount > 0 ? 'warning' : 'info'}>
                  批次 {currentBatch?.batchNo ?? ''}：共 {currentBatch?.fileCount ?? 0} 行，成功{' '}
                  {currentBatch?.successCount ?? 0} 行，失败 {currentBatch?.failCount ?? 0} 行。
                  确认后将把有效明细写入档案库（已存在档号自动跳过）。
                </Alert>
                <Stack direction="row" spacing={1}>
                  <Button onClick={() => setActiveStep(2)}>上一步</Button>
                  <PermGate domain="IMPORT_EXPORT" op="WRITE">
                    <Button
                      variant="contained"
                      color="success"
                      onClick={() => confirmMutation.mutate()}
                      disabled={confirmMutation.isPending || !batch}
                    >
                      确认入库
                    </Button>
                  </PermGate>
                </Stack>
              </Stack>
            )}

            {/* 步骤 5：记录明细 */}
            {activeStep === 4 && (
              <Stack spacing={1.5}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="subtitle1">第五步 · 记录明细</Typography>
                  <Button size="small" onClick={() => setActiveStep(0)}>
                    新建批次
                  </Button>
                </Stack>
                <Divider />
                <Table size="small" className="dense-table">
                  <TableHead>
                    <TableRow>
                      <TableCell width={54}>行</TableCell>
                      <TableCell>档号</TableCell>
                      <TableCell>题名</TableCell>
                      <TableCell>责任者</TableCell>
                      <TableCell width={80}>年度</TableCell>
                      <TableCell width={90}>密级</TableCell>
                      <TableCell width={130}>结果</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {details.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                          暂无明细，请从上方批次列表选择或重新导入
                        </TableCell>
                      </TableRow>
                    )}
                    {details.map((row) => (
                      <TableRow key={row.line} hover>
                        <TableCell>{row.line}</TableCell>
                        <TableCell className="mono">{row.danghao || '—'}</TableCell>
                        <TableCell>{row.title || '—'}</TableCell>
                        <TableCell>{row.responsible || '—'}</TableCell>
                        <TableCell>{row.year ?? '—'}</TableCell>
                        <TableCell>{row.securityLevel}</TableCell>
                        <TableCell>
                          {row.imported ? (
                            <Chip label="已入库" color="success" size="small" variant="outlined" />
                          ) : row.valid ? (
                            <Chip label="待确认/跳过" size="small" variant="outlined" />
                          ) : (
                            <Chip label={row.error ?? '校验失败'} color="error" size="small" variant="outlined" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Stack>
            )}
          </CardContent>
        </Card>

        <Card sx={{ width: 320, flex: '0 0 320px' }}>
          <CardContent sx={{ p: 1.5 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              历史批次
            </Typography>
            <Stack spacing={1}>
              {(batchQuery.data ?? []).map((item) => (
                <Stack
                  key={item.id}
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, px: 1, py: 0.6 }}
                >
                  <Stack sx={{ minWidth: 0 }}>
                    <Typography variant="body2" noWrap>
                      {item.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" className="mono">
                      {item.batchNo}
                    </Typography>
                  </Stack>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Chip
                      label={STATUS_LABEL[item.status]}
                      color={STATUS_COLOR[item.status]}
                      size="small"
                      variant="outlined"
                      sx={{ height: 18 }}
                    />
                    <Button size="small" onClick={() => viewDetail(item)}>
                      明细
                    </Button>
                  </Stack>
                </Stack>
              ))}
              {(batchQuery.data ?? []).length === 0 && (
                <Typography variant="caption" color="text.secondary">
                  暂无批次，先在左侧建立。
                </Typography>
              )}
            </Stack>
          </CardContent>
        </Card>
      </Stack>
    </AppLayout>
  );
}
