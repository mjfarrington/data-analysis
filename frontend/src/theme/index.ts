import { createTheme, alpha } from '@mui/material/styles'

const DARK_BG = '#0a0e1a'
const DARK_SURFACE = '#111827'
const DARK_PAPER = '#1a2236'
const DARK_BORDER = '#2a3550'
const ACCENT_BLUE = '#3b82f6'
const ACCENT_CYAN = '#06b6d4'
const ACCENT_GREEN = '#10b981'
const ACCENT_ORANGE = '#f59e0b'
const ACCENT_RED = '#ef4444'

export const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: ACCENT_BLUE, light: '#60a5fa', dark: '#2563eb' },
    secondary: { main: ACCENT_CYAN, light: '#67e8f9', dark: '#0891b2' },
    success: { main: ACCENT_GREEN },
    warning: { main: ACCENT_ORANGE },
    error: { main: ACCENT_RED },
    background: {
      default: DARK_BG,
      paper: DARK_PAPER,
    },
    divider: DARK_BORDER,
    text: { primary: '#e2e8f0', secondary: '#94a3b8' },
  },
  typography: {
    fontFamily: '"Inter", system-ui, sans-serif',
    h1: { fontWeight: 700 },
    h2: { fontWeight: 700 },
    h3: { fontWeight: 600 },
    h4: { fontWeight: 600 },
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
    body2: { color: '#94a3b8' },
    caption: { color: '#64748b' },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          scrollbarColor: `${DARK_BORDER} ${DARK_BG}`,
          '&::-webkit-scrollbar': { width: 8 },
          '&::-webkit-scrollbar-track': { background: DARK_BG },
          '&::-webkit-scrollbar-thumb': { background: DARK_BORDER, borderRadius: 4 },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: `1px solid ${DARK_BORDER}`,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          background: DARK_PAPER,
          backgroundImage: 'none',
          border: `1px solid ${DARK_BORDER}`,
          '&:hover': { borderColor: alpha(ACCENT_BLUE, 0.5) },
          transition: 'border-color 0.2s',
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          background: DARK_SURFACE,
          borderBottom: `1px solid ${DARK_BORDER}`,
          boxShadow: 'none',
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          background: DARK_SURFACE,
          borderRight: `1px solid ${DARK_BORDER}`,
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: { textTransform: 'none', fontWeight: 500, borderRadius: 8 },
        contained: {
          boxShadow: 'none',
          '&:hover': { boxShadow: `0 0 12px ${alpha(ACCENT_BLUE, 0.4)}` },
        },
      },
    },
    MuiChip: {
      styleOverrides: { root: { borderRadius: 6, fontWeight: 500 } },
    },
    MuiTableCell: {
      styleOverrides: {
        head: { fontWeight: 600, color: '#94a3b8', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' },
        root: { borderColor: DARK_BORDER },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { borderRadius: 4, backgroundColor: DARK_BORDER },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            '& fieldset': { borderColor: DARK_BORDER },
            '&:hover fieldset': { borderColor: alpha(ACCENT_BLUE, 0.5) },
          },
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { background: '#1e293b', border: `1px solid ${DARK_BORDER}`, fontSize: '0.75rem' },
      },
    },
  },
})

export const lightTheme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#2563eb' },
    secondary: { main: '#0891b2' },
    success: { main: '#059669' },
    warning: { main: '#d97706' },
    error: { main: '#dc2626' },
    background: { default: '#f1f5f9', paper: '#ffffff' },
    text: { primary: '#0f172a', secondary: '#475569' },
  },
  typography: {
    fontFamily: '"Inter", system-ui, sans-serif',
    h4: { fontWeight: 700 },
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiButton: {
      styleOverrides: { root: { textTransform: 'none', fontWeight: 500, borderRadius: 8 } },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
          border: '1px solid #e2e8f0',
        },
      },
    },
  },
})
