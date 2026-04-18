import { create } from 'zustand'

export type ThemeMode = 'github-dark' | 'dark-blue' | 'light'
export type Density = 'normal' | 'compact'

interface ThemeState {
  mode: ThemeMode
  density: Density
  setMode: (mode: ThemeMode) => void
  setDensity: (density: Density) => void
}

const THEME_KEY = 'data_studio_theme'
const DENSITY_KEY = 'data_studio_density'

function loadMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark-blue' || saved === 'github-dark') return saved
  return 'github-dark'
}

function loadDensity(): Density {
  return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'normal'
}

export const useThemeStore = create<ThemeState>()((set) => ({
  mode: loadMode(),
  density: loadDensity(),
  setMode: (mode) => {
    localStorage.setItem(THEME_KEY, mode)
    set({ mode })
  },
  setDensity: (density) => {
    localStorage.setItem(DENSITY_KEY, density)
    set({ density })
  },
}))
