import { type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Box, Button, Card, CircularProgress, Typography } from '@mui/material';
import { useNavigate, useParams } from 'react-router-dom';
import { workflowApi } from '../../api';
import { AppLayout } from '../../components/AppLayout';
import { WorkflowGraph } from '../../components/WorkflowGraph';

/**
 * 流程图页面：从「审批中心 → 流程配置」点「流程图」进入，
 * 独立界面展示该流程的节点链路与每个环节的审批角色。
 */
export function WorkflowGraphPage(): ReactElement {
  const { defId } = useParams<{ defId: string }>();
  const navigate = useNavigate();
  const defsQuery = useQuery({ queryKey: ['workflow-defs'], queryFn: workflowApi.defs });
  const def = defsQuery.data?.find((d) => d.id === defId);

  return (
    <AppLayout
      title="流程图"
      subtitle={def ? `${def.name}（${def.description ?? '无备注'}）` : '查看流程节点与审批角色'}
      actions={
        <Button size="small" onClick={() => navigate('/workflow')}>
          返回审批中心
        </Button>
      }
    >
      <Card variant="outlined" sx={{ minHeight: 300 }}>
        {defsQuery.isLoading && (
          <Box sx={{ textAlign: 'center', py: 8 }}>
            <CircularProgress size={26} />
          </Box>
        )}
        {!defsQuery.isLoading && !def && (
          <Alert severity="warning" sx={{ m: 2 }}>
            未找到该流程定义（可能已被删除），请返回审批中心重新选择。
          </Alert>
        )}
        {def && (
          <>
            {def.description && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 2, pt: 1.5 }}>
                {def.description}
              </Typography>
            )}
            <WorkflowGraph def={def} />
          </>
        )}
      </Card>
    </AppLayout>
  );
}
