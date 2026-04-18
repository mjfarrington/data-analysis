import { createTheme, Theme } from '@mui/material/styles'

// Slightly smaller than MUI's default (14) so all rem-based sizes scale down ~7 %
const BASE_FONT_SIZE = 13

const baseTypography = {
  fontFamily: '"Inter", "Roboto", "Helvetica Neue", Arial, sans-serif',
  fontSize: BASE_FONT_SIZE,
  h1: { fontWeight: 700 },
  h2: { fontWeight: 700 },
  h3: { fontWeight: 600 },
  h4: { fontWeight: 600 },
  h5: { fontWeight: 600 },
  h6: { fontWeight: 600 },
}

const baseShape = { borderRadius: 8 }

const scrollbarDark = {
  '*::-webkit-scrollbar': { width: '6px', height: '6px' },
  '*::-webkit-scrollbar-track': { background: 'transparent' },
  '*::-webkit-scrollbar-thumb': { background: '#30363d', borderRadius: '3px' },
  '*::-webkit-scrollbar-thumb:hover': { background: '#484f58' },
}

const baseButtonChipTable = {
  MuiButton: { styleOverrides: { root: { textTransform: 'none' as const, fontWeight: 500 } } },
  MuiChip: { styleOverrides: { root: { fontWeight: 500 } } },
}

// ── GitHub Dark ─────────────────────────────────────────────────────────────────────────
export const githubDarkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#58a6ff' },
    secondary: { main: '#3fb950' },
    background: { default: '#0d1117', paper: '#161b22' },
    error: { main: '#f85149' },
    warning: { main: '#d29922' },
    info: { main: '#58a6ff' },
    success: { main: '#3fb950' },
    divider: 'rgba(255,255,255,0.08)',
    text: { primary: '#e6edf3', secondary: '#8b949e' },
  },
  typography: baseTypography,
  shape: baseShape,
  components: {
    MuiCssBaseline: { styleOverrides: scrollbarDark },
    ...baseButtonChipTable,
    MuiTableCell: {
      styleOverrides: {
        head: { fontWeight: 600, color: '#8b949e', fontSize: '0.75rem', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none', border: '1px solid rgba(255,255,255,0.06)' },
      },
    },
  },
})

// ── Dark Blue ───────────────────────────────────────────────────────────────────────────
export const darkBlueTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#4da6ff' },
    secondary: { main: '#00d4aa' },
    background: { default: '#0a1628', paper: '#0f2040' },
    error: { main: '#ff5c5c' },
    warning: { main: '#ffb347' },
    info: { main: '#4da6ff' },
    success: { main: '#00d4aa' },
    divider: 'rgba(77,166,255,0.12)',
    text: { primary: '#cce3ff', secondary: '#7aaed6' },
  },
  typography: baseTypography,
  shape: baseShape,
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        '*::-webkit-scrollbar': { width: '6px', height: '6px' },
        '*::-webkit-scrollbar-track': { background: 'transparent' },
        '*::-webkit-scrollbar-thumb': { background: '#1a3a5c', borderRadius: '3px' },
        '*::-webkit-scrollbar-thumb:hover': { background: '#2a5080' },
      },
    },
    ...baseButtonChipTable,
    MuiTableCell: {
      styleOverrides: {
        head: { fontWeight: 600, color: '#7aaed6', fontSize: '0.75rem', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none', border: '1px solid rgba(77,166,255,0.1)' },
      },
    },
  },
})

// ── Light (GitHub Light) ───────────────────────────────────────────────────────────
export const lightTheme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#0969da' },
    secondary: { main: '#1a7f37' },
    background: { default: '#f6f8fa', paper: '#ffffff' },
    error: { main: '#cf222e' },
    warning: { main: '#9a6700' },
    info: { main: '#0969da' },
    success: { main: '#1a7f37' },
    divider: 'rgba(0,0,0,0.08)',
  },
  typography: baseTypography,
  shape: baseShape,
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        '*::-webkit-scrollbar': { width: '6px', height: '6px' },
        '*::-webkit-scrollbar-track': { background: 'transparent' },
        '*::-webkit-scrollbar-thumb': { background: '#d0d7de', borderRadius: '3px' },
        '*::-webkit-scrollbar-thumb:hover': { background: '#afb8c1' },
      },
    },
    ...baseButtonChipTable,
    MuiTableCell: {
      styleOverrides: {
        head: { fontWeight: 600, color: '#57606a', fontSize: '0.75rem', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
      },
    },
  },
})

// backwards-compat alias
export const darkTheme = githubDarkTheme

// ── Density override ──────────────────────────────────────────────────────────
// Applies compact spacing and a further font-size reduction on top of any base
// theme.  Call with density='normal' to return the theme unchanged.
export function applyDensity(theme: Theme, density: 'normal' | 'compact'): Theme {
  if (density === 'normal') return theme
  return createTheme(theme, {
    typography: { fontSize: BASE_FONT_SIZE - 1 }, // 12 px
    components: {
      MuiListItemButton: {
        styleOverrides: {
          root: { minHeight: 28, paddingTop: 3, paddingBottom: 3 },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: { padding: '4px 12px' },
          head: { padding: '4px 12px' },
        },
      },
      MuiChip: {
        styleOverrides: {
          sizeSmall: { height: 18, fontSize: '0.65rem' },
          sizeMedium: { height: 22, fontSize: '0.72rem' },
        },
      },
      MuiInputBase: {
        styleOverrides: {
          inputSizeSmall: {
            paddingTop: '4px',
            paddingBottom: '4px',
            fontSize: '0.78rem',
          },
        },
      },
      MuiCardContent: {
        styleOverrides: {
          root: { padding: '12px 14px', '&:last-child': { paddingBottom: 12 } },
        },
      },
      MuiButton: {
        styleOverrides: {
          sizeSmall: { padding: '2px 10px', fontSize: '0.73rem' },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: { minHeight: 36, fontSize: '0.78rem' },
        },
      },
    },
  })
}
