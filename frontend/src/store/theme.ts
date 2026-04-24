import { create } from 'zustand'

export type ThemeMode = 'github-dark' | 'dark-blue' | 'light'
export type Density = 'normal' | 'compact'
export type LineRenderStyle = 'curved' | 'angled' | 'straight' | 'smooth'

interface ThemeState {
  mode: ThemeMode
  density: Density
  sqlMinimap: boolean
  lineRenderStyle: LineRenderStyle
  setMode: (mode: ThemeMode) => void
  setDensity: (density: Density) => void
  setSqlMinimap: (enabled: boolean) => void
  setLineRenderStyle: (style: LineRenderStyle) => void
}

const THEME_KEY = 'data_studio_theme'
const DENSITY_KEY = 'data_studio_density'
const SQL_MINIMAP_KEY = 'data_studio_sql_minimap'
const LINE_STYLE_KEY = 'data_studio_line_style'

function loadMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark-blue' || saved === 'github-dark') return saved
  return 'github-dark'
}

function loadDensity(): Density {
  return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'normal'
}

function loadSqlMinimap(): boolean {
  const saved = localStorage.getItem(SQL_MINIMAP_KEY)
  if (saved === null) return true
  return saved !== 'false'
}

function loadLineRenderStyle(): LineRenderStyle {
  const saved = localStorage.getItem(LINE_STYLE_KEY)
  if (saved === 'curved' || saved === 'angled' || saved === 'straight' || saved === 'smooth') return saved
  return 'curved'
}

function applyColorScheme(mode: ThemeMode) {
  document.documentElement.style.colorScheme = mode === 'light' ? 'light' : 'dark'
}

// Apply on initial load
applyColorScheme(loadMode())

export const useThemeStore = create<ThemeState>()((set) => ({
  mode: loadMode(),
  density: loadDensity(),
  sqlMinimap: loadSqlMinimap(),
  lineRenderStyle: loadLineRenderStyle(),
  setMode: (mode) => {
    localStorage.setItem(THEME_KEY, mode)
    applyColorScheme(mode)
    set({ mode })
  },
  setDensity: (density) => {
    localStorage.setItem(DENSITY_KEY, density)
    set({ density })
  },
  setSqlMinimap: (enabled) => {
    localStorage.setItem(SQL_MINIMAP_KEY, String(enabled))
    set({ sqlMinimap: enabled })
  },
  setLineRenderStyle: (style) => {
    localStorage.setItem(LINE_STYLE_KEY, style)
    set({ lineRenderStyle: style })
  },
}))
