import { useEffect, type ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { CircularProgress, Box } from '@mui/material';
import { useAuthStore } from './stores/authStore';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { FondsListPage } from './pages/fonds/FondsListPage';
import { VolumeListPage } from './pages/catalog/VolumeListPage';
import { ItemEditorPage } from './pages/catalog/ItemEditorPage';
import { RuleConfigPage } from './pages/catalog/RuleConfigPage';
import { SearchPage } from './pages/search/SearchPage';
import { BorrowPage } from './pages/borrow/BorrowPage';
import { ReportPage } from './pages/report/ReportPage';
import { BackupPage } from './pages/system/BackupPage';
import { UsersPage } from './pages/system/UsersPage';
import { DictPage } from './pages/system/DictPage';
import { ParamsPage } from './pages/system/ParamsPage';
import { SynonymPage } from './pages/system/SynonymPage';
import { AuditPage } from './pages/system/AuditPage';
import { RecyclePage } from './pages/RecyclePage';
import { KbPage } from './pages/KbPage';
import { AppraisalPage } from './pages/appraisal/AppraisalPage';
import { OpenPage } from './pages/open/OpenPage';
import { WorkflowPage } from './pages/workflow/WorkflowPage';
import { WorkflowGraphPage } from './pages/workflow/WorkflowGraphPage';
import { KnowledgePage } from './pages/knowledge/KnowledgePage';
import { WikiHomePage } from './pages/wiki/WikiHomePage';
import { FeaturePlaceholder } from './pages/FeaturePlaceholder';

/** P5–P8 规划中功能的占位页配置（真实页面落地后逐个替换） */
const PLACEHOLDERS: Record<string, { title: string; section: string; features: string[] }> = {
  '/import': { title: '数据导入', section: '档案收集', features: ['建立批次', '模板配置', '数据导入', '确认', '记录明细'] },
  '/receive': { title: '档案接收', section: '档案收集', features: ['上传接收包', '查看接收包', '确认', '退回', '打印', '检测方案'] },
  '/datalink': { title: '电子文件挂接', section: '档案收集', features: ['建立批次', '规则设置', '上传挂接包', '预挂接管理', '确认挂接', '挂接明细'] },
  '/retention': { title: '保管期限表', section: '档案管理', features: ['增加', '删除', '修改', '期限依据文档'] },
  '/category': { title: '门类管理', section: '档案管理', features: ['门类模板化著录', '照片/录音/录像档案', '资料管理', '专业档案', '会计档案'] },
  '/destroy': { title: '销毁批次', section: '档案管理', features: ['建立销毁批次', '审核', '执行销毁', '还原', '销毁清册'] },
  '/transfer': { title: '移交管理', section: '档案管理', features: ['实体档案移交', '电子档案移交', '管理条目', '查看移交包', '下载', '检测方案'] },
  '/erms': { title: '长期保管', section: '档案管理', features: ['查看封装包', '手工执行', '计划设置', '任务设置', '状态重置', '电子库房'] },
  '/stkf': { title: '实体库房', section: '档案管理', features: ['增加库房', '库房初始化', '进入库房', '库位管理', '上架/下架'] },
  '/auxentity': { title: '辅助实体', section: '档案管理', features: ['入库', '出库', '更新', '装具管理', '查看明细'] },
  '/compilation': { title: '编研管理', section: '档案利用', features: ['编研成果', '发布/取消发布', '下载', '编研成果信息管理'] },
  '/usage-log': { title: '利用日志', section: '档案利用', features: ['利用登记', '查看借阅单', '利用情况管理'] },
  '/template': { title: '分类模板', section: '系统设置', features: ['档号设置', '主题词管理', '列表视图管理', '著录视图管理', '著录字段设置', '复制模板', '导入/导出模板'] },
  '/metadata': { title: '元数据标准', section: '系统设置', features: ['元数据字段定义', '字段类型', '校验规则'] },
  '/notice': { title: '公告管理', section: '系统设置', features: ['增加', '修改', '删除', '发布', '撤销'] },
  '/download': { title: '下载中心', section: '系统设置', features: ['增加', '修改', '删除', '发布', '撤销', '下载'] },
  '/report-design': { title: '报表管理', section: '系统设置', features: ['报表分类', '字段设置', '数据源设置', '报表样式上传下载', '隐藏/取消隐藏'] },
  '/ercheck': { title: '四性检测', section: '系统安全', features: ['检测项设置', '增加/删除/修改', '真实性检测', '完整性检测', '可用性检测', '安全性检测'] },
  '/ask': { title: '智能问答', section: 'RAG', features: ['自然语言提问', '带引用回答', '打开原件定位', '检索片段溯源'] },
};

/** 路由守卫：未登录跳 /login */
function RequireAuth(props: { children: ReactElement }): ReactElement {
  const profile = useAuthStore((s) => s.profile);
  const ready = useAuthStore((s) => s.ready);
  const location = useLocation();

  if (!ready) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <CircularProgress size={28} />
      </Box>
    );
  }
  if (!profile) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return props.children;
}

/** 路由表 */
export function AppRoutes(): ReactElement {
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const ready = useAuthStore((s) => s.ready);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/search"
          element={
            <RequireAuth>
              <SearchPage />
            </RequireAuth>
          }
        />
        <Route
          path="/borrow"
          element={
            <RequireAuth>
              <BorrowPage />
            </RequireAuth>
          }
        />
        <Route
          path="/appraisal"
          element={
            <RequireAuth>
              <AppraisalPage />
            </RequireAuth>
          }
        />
        <Route
          path="/open"
          element={
            <RequireAuth>
              <OpenPage />
            </RequireAuth>
          }
        />
        <Route
          path="/workflow"
          element={
            <RequireAuth>
              <WorkflowPage />
            </RequireAuth>
          }
        />
        <Route
          path="/workflow/defs/:defId/graph"
          element={
            <RequireAuth>
              <WorkflowGraphPage />
            </RequireAuth>
          }
        />
        <Route
          path="/knowledge"
          element={
            <RequireAuth>
              <KnowledgePage />
            </RequireAuth>
          }
        />
        <Route
          path="/wiki"
          element={
            <RequireAuth>
              <WikiHomePage />
            </RequireAuth>
          }
        />
        <Route
          path="/kb"
          element={
            <RequireAuth>
              <KbPage />
            </RequireAuth>
          }
        />
        <Route
          path="/fonds"
          element={
            <RequireAuth>
              <FondsListPage />
            </RequireAuth>
          }
        />
        <Route
          path="/catalog"
          element={
            <RequireAuth>
              <VolumeListPage />
            </RequireAuth>
          }
        />
        <Route
          path="/catalog/:volumeId"
          element={
            <RequireAuth>
              <ItemEditorPage />
            </RequireAuth>
          }
        />
        <Route
          path="/items/:itemId"
          element={
            <RequireAuth>
              <ItemEditorPage />
            </RequireAuth>
          }
        />
        <Route
          path="/rules"
          element={
            <RequireAuth>
              <RuleConfigPage />
            </RequireAuth>
          }
        />
        <Route
          path="/recycle"
          element={
            <RequireAuth>
              <RecyclePage />
            </RequireAuth>
          }
        />
        <Route
          path="/report"
          element={
            <RequireAuth>
              <ReportPage />
            </RequireAuth>
          }
        />
        <Route
          path="/backup"
          element={
            <RequireAuth>
              <BackupPage />
            </RequireAuth>
          }
        />
        <Route
          path="/audit"
          element={
            <RequireAuth>
              <AuditPage />
            </RequireAuth>
          }
        />
        <Route
          path="/system/users"
          element={
            <RequireAuth>
              <UsersPage />
            </RequireAuth>
          }
        />
        <Route
          path="/system/roles"
          element={
            <RequireAuth>
              <UsersPage initialTab={1} />
            </RequireAuth>
          }
        />
        <Route
          path="/system/dict"
          element={
            <RequireAuth>
              <DictPage />
            </RequireAuth>
          }
        />
        <Route
          path="/system/params"
          element={
            <RequireAuth>
              <ParamsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/system/synonyms"
          element={
            <RequireAuth>
              <SynonymPage />
            </RequireAuth>
          }
        />
        {/* ------------------------------------------------ P5–P8 规划功能（占位，逐个替换为真实页） */}
        {Object.entries(PLACEHOLDERS).map(([path, cfg]) => (
          <Route
            key={path}
            path={path}
            element={
              <RequireAuth>
                <FeaturePlaceholder title={cfg.title} section={cfg.section} features={cfg.features} />
              </RequireAuth>
            }
          />
        ))}
        <Route path="*" element={ready ? <Navigate to="/" replace /> : <Box sx={{ p: 4 }}>加载中…</Box>} />
      </Routes>
    </BrowserRouter>
  );
}
