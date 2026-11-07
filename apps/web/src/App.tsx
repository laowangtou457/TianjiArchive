import type { ReactElement } from 'react';
import { SnackbarProvider } from 'notistack';
import { AppRoutes } from './router';

/**
 * 应用根组件。
 *
 * 包裹 notistack（全局轻提示），路由由 AppRoutes 承载。
 * 说明：notistack 为 MUI 生态标准提示库，已在 package.json 声明。
 */
export function App(): ReactElement {
  return (
    <SnackbarProvider
      maxSnack={3}
      anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      autoHideDuration={3000}
      dense
    >
      <AppRoutes />
    </SnackbarProvider>
  );
}
