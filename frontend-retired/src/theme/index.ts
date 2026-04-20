import { createTheme, alpha, Theme } from '@mui/material/styles'

// ─── Theme builder ────────────────────────────────────────────────────────────
interface ThemeConfig {
  mode: 'light' | 'dark'
  bg: string
  surface: string
  paper: string
  border: string
  textPrimary: string
  textSecondary: string
  primary: string
  primaryLight: string
  primaryDark: string
  secondary: string
  success: string
  warning: string
  error: string
  tooltip?: string
}

function buildTheme(cfg: ThemeConfig): Theme {
  return createTheme({
    palette: {
      mode: cfg.mode,
      primary: { main: cfg.primary, light: cfg.primaryLight, dark: cfg.primaryDark },
      secondary: { main: cfg.secondary },
      success: { main: cfg.success },
      warning: { main: cfg.warning },
      error: { main: cfg.error },
      background: { default: cfg.bg, paper: cfg.paper },
      divider: cfg.border,
      text: { primary: cfg.textPrimary, secondary: cfg.textSecondary },
    },
    typography: {
      fontFamily: '"Inter", system-ui, sans-serif',
      h1: { fontWeight: 700 },
      h2: { fontWeight: 700 },
      h3: { fontWeight: 600 },
      h4: { fontWeight: 600 },
      h5: { fontWeight: 600 },
      h6: { fontWeight: 600 },
    },
    shape: { borderRadius: 10 },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            scrollbarColor: `${cfg.border} ${cfg.bg}`,
            '&::-webkit-scrollbar': { width: 8 },
            '&::-webkit-scrollbar-track': { background: cfg.bg },
            '&::-webkit-scrollbar-thumb': { background: cfg.border, borderRadius: 4 },
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none', border: `1px solid ${cfg.border}` },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            background: cfg.paper,
            backgroundImage: 'none',
            border: `1px solid ${cfg.border}`,
            '&:hover': { borderColor: alpha(cfg.primary, 0.5) },
            transition: 'border-color 0.2s',
          },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            background: cfg.surface,
            borderBottom: `1px solid ${cfg.border}`,
            boxShadow: 'none',
            color: cfg.textPrimary,
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: { background: cfg.surface, borderRight: `1px solid ${cfg.border}` },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: { textTransform: 'none', fontWeight: 500, borderRadius: 8 },
          contained: {
            boxShadow: 'none',
            '&:hover': { boxShadow: `0 0 12px ${alpha(cfg.primary, 0.4)}` },
          },
        },
      },
      MuiChip: {
        styleOverrides: { root: { borderRadius: 6, fontWeight: 500 } },
      },
      MuiTableCell: {
        styleOverrides: {
          head: {
            fontWeight: 600,
            color: cfg.textSecondary,
            fontSize: '0.75rem',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          },
          root: { borderColor: cfg.border },
        },
      },
      MuiLinearProgress: {
        styleOverrides: { root: { borderRadius: 4, backgroundColor: cfg.border } },
      },
      MuiInputBase: {
        styleOverrides: {
          input: { fontSize: '0.8rem' },
          inputSizeSmall: { fontSize: '0.8rem' },
        },
      },
      MuiInputLabel: {
        styleOverrides: {
          root: { fontSize: '0.8rem' },
          sizeSmall: { fontSize: '0.8rem' },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: { fontSize: '0.8rem' },
        },
      },
      MuiSelect: {
        styleOverrides: {
          select: { fontSize: '0.8rem' },
        },
      },
      MuiFormHelperText: {
        styleOverrides: {
          root: { fontSize: '0.7rem' },
        },
      },
      MuiAutocomplete: {
        styleOverrides: {
          option: { fontSize: '0.8rem' },
          noOptions: { fontSize: '0.8rem' },
          loading: { fontSize: '0.8rem' },
          groupLabel: { fontSize: '0.75rem' },
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: {
            '& .MuiOutlinedInput-root': {
              '& fieldset': { borderColor: cfg.border },
              '&:hover fieldset': { borderColor: alpha(cfg.primary, 0.5) },
            },
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            background: cfg.tooltip ?? cfg.surface,
            border: `1px solid ${cfg.border}`,
            fontSize: '0.75rem',
            color: cfg.textPrimary,
          },
        },
      },
    },
  })
}

// ─── Theme definitions ────────────────────────────────────────────────────────

export const darkTheme = buildTheme({
  mode: 'dark',
  bg: '#0a0e1a', surface: '#111827', paper: '#1a2236', border: '#2a3550',
  textPrimary: '#e2e8f0', textSecondary: '#94a3b8',
  primary: '#3b82f6', primaryLight: '#60a5fa', primaryDark: '#2563eb',
  secondary: '#06b6d4', success: '#10b981', warning: '#f59e0b', error: '#ef4444',
})

export const lightTheme = buildTheme({
  mode: 'light',
  bg: '#f1f5f9', surface: '#ffffff', paper: '#ffffff', border: '#e2e8f0',
  textPrimary: '#0f172a', textSecondary: '#475569',
  primary: '#2563eb', primaryLight: '#60a5fa', primaryDark: '#1d4ed8',
  secondary: '#0891b2', success: '#059669', warning: '#d97706', error: '#dc2626',
  tooltip: '#1e293b',
})

const solarizedDarkTheme = buildTheme({
  mode: 'dark',
  bg: '#002b36', surface: '#073642', paper: '#0a3d4a', border: '#1a4f5e',
  textPrimary: '#eee8d5', textSecondary: '#839496',
  primary: '#268bd2', primaryLight: '#4fa8e8', primaryDark: '#1a6fa8',
  secondary: '#2aa198', success: '#859900', warning: '#b58900', error: '#dc322f',
})

const solarizedLightTheme = buildTheme({
  mode: 'light',
  bg: '#fdf6e3', surface: '#eee8d5', paper: '#fdf6e3', border: '#ccc4b0',
  textPrimary: '#073642', textSecondary: '#657b83',
  primary: '#268bd2', primaryLight: '#4fa8e8', primaryDark: '#1a6fa8',
  secondary: '#2aa198', success: '#859900', warning: '#b58900', error: '#dc322f',
  tooltip: '#073642',
})

const nordTheme = buildTheme({
  mode: 'dark',
  bg: '#2e3440', surface: '#3b4252', paper: '#434c5e', border: '#4c566a',
  textPrimary: '#eceff4', textSecondary: '#d8dee9',
  primary: '#88c0d0', primaryLight: '#a3d4e2', primaryDark: '#5e9fb0',
  secondary: '#81a1c1', success: '#a3be8c', warning: '#ebcb8b', error: '#bf616a',
})

const draculaTheme = buildTheme({
  mode: 'dark',
  bg: '#282a36', surface: '#21222c', paper: '#2d2f3f', border: '#44475a',
  textPrimary: '#f8f8f2', textSecondary: '#6272a4',
  primary: '#bd93f9', primaryLight: '#d0b0ff', primaryDark: '#9a6fd8',
  secondary: '#ff79c6', success: '#50fa7b', warning: '#ffb86c', error: '#ff5555',
})

const gruvboxTheme = buildTheme({
  mode: 'dark',
  bg: '#282828', surface: '#1d2021', paper: '#32302f', border: '#504945',
  textPrimary: '#ebdbb2', textSecondary: '#a89984',
  primary: '#83a598', primaryLight: '#a0c4ba', primaryDark: '#5f8a7e',
  secondary: '#b8bb26', success: '#b8bb26', warning: '#fabd2f', error: '#fb4934',
})

const monokaiTheme = buildTheme({
  mode: 'dark',
  bg: '#272822', surface: '#1e1f1c', paper: '#2d2e2a', border: '#3e3d32',
  textPrimary: '#f8f8f2', textSecondary: '#75715e',
  primary: '#66d9e8', primaryLight: '#8ae6f3', primaryDark: '#3ec4d4',
  secondary: '#a6e22e', success: '#a6e22e', warning: '#e6db74', error: '#f92672',
})

const githubTheme = buildTheme({
  mode: 'light',
  bg: '#f6f8fa', surface: '#ffffff', paper: '#ffffff', border: '#d0d7de',
  textPrimary: '#1f2328', textSecondary: '#57606a',
  primary: '#0969da', primaryLight: '#4493f8', primaryDark: '#0550ae',
  secondary: '#0550ae', success: '#1a7f37', warning: '#9a6700', error: '#cf222e',
  tooltip: '#1f2328',
})

const githubDarkTheme = buildTheme({
  mode: 'dark',
  bg: '#0d1117', surface: '#161b22', paper: '#1c2128', border: '#30363d',
  textPrimary: '#e6edf3', textSecondary: '#7d8590',
  primary: '#4493f8', primaryLight: '#79b8ff', primaryDark: '#1f6feb',
  secondary: '#a371f7', success: '#3fb950', warning: '#d29922', error: '#f85149',
  tooltip: '#161b22',
})

// ─── Theme registry ───────────────────────────────────────────────────────────

export interface ThemeMeta {
  name: string
  label: string
  mode: 'light' | 'dark'
  group: string
  /** [bg, surface, accent] colours used in the Settings preview swatch */
  preview: [string, string, string]
  theme: Theme
}

export const THEMES: ThemeMeta[] = [
  // Dark
  { name: 'dark',            label: 'Dark',            mode: 'dark',  group: 'Dark',      preview: ['#0a0e1a', '#1a2236', '#3b82f6'], theme: darkTheme },
  { name: 'dracula',         label: 'Dracula',         mode: 'dark',  group: 'Dark',      preview: ['#282a36', '#2d2f3f', '#bd93f9'], theme: draculaTheme },
  { name: 'nord',            label: 'Nord',            mode: 'dark',  group: 'Dark',      preview: ['#2e3440', '#434c5e', '#88c0d0'], theme: nordTheme },
  { name: 'gruvbox',         label: 'Gruvbox',         mode: 'dark',  group: 'Dark',      preview: ['#282828', '#32302f', '#83a598'], theme: gruvboxTheme },
  { name: 'monokai',         label: 'Monokai',         mode: 'dark',  group: 'Dark',      preview: ['#272822', '#2d2e2a', '#66d9e8'], theme: monokaiTheme },
  { name: 'github-dark',     label: 'GitHub Dark',     mode: 'dark',  group: 'Dark',      preview: ['#0d1117', '#1c2128', '#4493f8'], theme: githubDarkTheme },
  // Solarized
  { name: 'solarized-dark',  label: 'Solarized Dark',  mode: 'dark',  group: 'Solarized', preview: ['#002b36', '#073642', '#268bd2'], theme: solarizedDarkTheme },
  { name: 'solarized-light', label: 'Solarized Light', mode: 'light', group: 'Solarized', preview: ['#fdf6e3', '#eee8d5', '#268bd2'], theme: solarizedLightTheme },
  // Light
  { name: 'light',           label: 'Light',           mode: 'light', group: 'Light',     preview: ['#f1f5f9', '#ffffff', '#2563eb'], theme: lightTheme },
  { name: 'github',          label: 'GitHub Light',    mode: 'light', group: 'Light',     preview: ['#f6f8fa', '#ffffff', '#0969da'], theme: githubTheme },
]

export const THEME_MAP: Record<string, ThemeMeta> = Object.fromEntries(
  THEMES.map((t) => [t.name, t]),
)

