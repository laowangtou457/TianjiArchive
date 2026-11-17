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
// P5–P8 真实页面
import { DataImportPage } from './pages/collection/DataImportPage';
import { ReceivePage } from './pages/collection/ReceivePage';
import { DataLinkPage } from './pages/collection/DataLinkPage';
import { CollectionStagingPage } from './pages/collection/CollectionStagingPage';
import { AdminToolsPage } from './pages/settings/AdminToolsPage';
import { RetentionPage } from './pages/management/RetentionPage';
import { CategoryPage } from './pages/management/CategoryPage';
import { DestroyPage } from './pages/management/DestroyPage';
import { TransferPage } from './pages/management/TransferPage';
import { ErmsPage } from './pages/management/ErmsPage';
import { StkfPage } from './pages/management/StkfPage';
import { AuxEntityPage } from './pages/management/AuxEntityPage';
import { CompilationPage } from './pages/utilization/CompilationPage';
import { UsageLogPage } from './pages/utilization/UsageLogPage';
import { TemplatePage } from './pages/settings/TemplatePage';
import { MetadataPage } from './pages/settings/MetadataPage';
import { NoticePage } from './pages/settings/NoticePage';
import { DownloadPage } from './pages/settings/DownloadPage';
import { ReportDesignPage } from './pages/settings/ReportDesignPage';
import { ErCheckPage } from './pages/security/ErCheckPage';

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
          path="/system/org"
          element={
            <RequireAuth>
              <AdminToolsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/system/patch"
          element={
            <RequireAuth>
              <AdminToolsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/export-cd"
          element={
            <RequireAuth>
              <AdminToolsPage />
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
          path="/collection/staging"
          element={
            <RequireAuth>
              <CollectionStagingPage />
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
        {/* ------------------------------------------------ P5–P8 泰坦对齐功能 */}
        <Route
          path="/import"
          element={
            <RequireAuth>
              <DataImportPage />
            </RequireAuth>
          }
        />
        <Route
          path="/receive"
          element={
            <RequireAuth>
              <ReceivePage />
            </RequireAuth>
          }
        />
        <Route
          path="/datalink"
          element={
            <RequireAuth>
              <DataLinkPage />
            </RequireAuth>
          }
        />
        <Route
          path="/retention"
          element={
            <RequireAuth>
              <RetentionPage />
            </RequireAuth>
          }
        />
        <Route
          path="/category"
          element={
            <RequireAuth>
              <CategoryPage />
            </RequireAuth>
          }
        />
        <Route
          path="/destroy"
          element={
            <RequireAuth>
              <DestroyPage />
            </RequireAuth>
          }
        />
        <Route
          path="/transfer"
          element={
            <RequireAuth>
              <TransferPage />
            </RequireAuth>
          }
        />
        <Route
          path="/erms"
          element={
            <RequireAuth>
              <ErmsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/stkf"
          element={
            <RequireAuth>
              <StkfPage />
            </RequireAuth>
          }
        />
        <Route
          path="/auxentity"
          element={
            <RequireAuth>
              <AuxEntityPage />
            </RequireAuth>
          }
        />
        <Route
          path="/compilation"
          element={
            <RequireAuth>
              <CompilationPage />
            </RequireAuth>
          }
        />
        <Route
          path="/usage-log"
          element={
            <RequireAuth>
              <UsageLogPage />
            </RequireAuth>
          }
        />
        <Route
          path="/template"
          element={
            <RequireAuth>
              <TemplatePage />
            </RequireAuth>
          }
        />
        <Route
          path="/metadata"
          element={
            <RequireAuth>
              <MetadataPage />
            </RequireAuth>
          }
        />
        <Route
          path="/notice"
          element={
            <RequireAuth>
              <NoticePage />
            </RequireAuth>
          }
        />
        <Route
          path="/download"
          element={
            <RequireAuth>
              <DownloadPage />
            </RequireAuth>
          }
        />
        <Route
          path="/report-design"
          element={
            <RequireAuth>
              <ReportDesignPage />
            </RequireAuth>
          }
        />
        <Route
          path="/ercheck"
          element={
            <RequireAuth>
              <ErCheckPage />
            </RequireAuth>
          }
        />
        <Route
          path="/ask"
          element={
            <RequireAuth>
              <KnowledgePage />
            </RequireAuth>
          }
        />
        <Route path="*" element={ready ? <Navigate to="/" replace /> : <Box sx={{ p: 4 }}>加载中…</Box>} />
      </Routes>
    </BrowserRouter>
  );
}
