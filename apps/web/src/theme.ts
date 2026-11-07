import { createTheme, type Theme } from '@mui/material/styles';

/**
 * MUI 主题：政务风格（深靛蓝主色 + 高密度表格）。
 * 与 tailwind.config.ts 的 brand 色阶保持一致。
 */
export const theme: Theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#1a2b7a', light: '#4f6ef7', dark: '#152260', contrastText: '#ffffff' },
    secondary: { main: '#b7791f', contrastText: '#ffffff' },
    success: { main: '#2f855a' },
    warning: { main: '#c05621' },
    error: { main: '#c53030' },
    info: { main: '#2b6cb0' },
    background: { default: '#f5f7fb', paper: '#ffffff' },
    text: { primary: '#1a202c', secondary: '#4a5568' },
    divider: '#e2e8f0',
  },
  typography: {
    fontFamily:
      '"PingFang SC","Microsoft YaHei","Source Han Sans SC","Noto Sans CJK SC",system-ui,-apple-system,"Segoe UI",sans-serif',
    fontSize: 13,
    h1: { fontSize: '1.5rem', fontWeight: 600 },
    h2: { fontSize: '1.25rem', fontWeight: 600 },
    h3: { fontSize: '1.125rem', fontWeight: 600 },
    h4: { fontSize: '1rem', fontWeight: 600 },
    h5: { fontSize: '0.9375rem', fontWeight: 600 },
    h6: { fontSize: '0.875rem', fontWeight: 600 },
    body1: { fontSize: '0.875rem' },
    body2: { fontSize: '0.8125rem' },
    button: { textTransform: 'none', fontSize: '0.8125rem', fontWeight: 500 },
  },
  shape: { borderRadius: 4 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { fontSize: '13px' },
        '*::-webkit-scrollbar': { width: 8, height: 8 },
        '*::-webkit-scrollbar-thumb': { backgroundColor: '#cbd5e0', borderRadius: 4 },
        '*::-webkit-scrollbar-track': { backgroundColor: 'transparent' },
      },
    },
    MuiButton: {
      defaultProps: { size: 'small', disableElevation: true },
      styleOverrides: { root: { minHeight: 30 } },
    },
    MuiTextField: { defaultProps: { size: 'small', variant: 'outlined' } },
    MuiSelect: { defaultProps: { size: 'small' } },
    MuiFormControl: { defaultProps: { size: 'small' } },
    MuiTableCell: {
      styleOverrides: {
        root: { padding: '6px 10px', fontSize: '0.8125rem' },
        head: { fontWeight: 600, backgroundColor: '#f7fafc', whiteSpace: 'nowrap' },
      },
    },
    MuiTableRow: { styleOverrides: { root: { '&:hover': { backgroundColor: '#f7fafc' } } } },
    MuiChip: { defaultProps: { size: 'small' } },
    MuiTooltip: { defaultProps: { arrow: true } },
    MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { border: '1px solid #e2e8f0' } } },
    MuiDialog: { defaultProps: { maxWidth: 'md', fullWidth: true } },
  },
});
