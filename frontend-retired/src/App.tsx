import { useState, createContext, useContext, useMemo } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider, CssBaseline } from '@mui/material'
import { LocalizationProvider } from '@mui/x-date-pickers'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFnsV3'
import { THEME_MAP, THEMES } from './theme'
import Layout from './components/Layout'
import Pipelines from './pages/Pipelines'
import ETLRuns from './pages/ETLRuns'
import ETLChains from './pages/ETLChains'
import DataExplorer from './pages/DataExplorer'
import ErrorsPage from './pages/ErrorsPage'
import PipelineGraph from './pages/PipelineGraph'
import Services from './pages/Services'
import PipelineStudio from './pages/PipelineStudio'
import SqlBrowser from './pages/SqlBrowser'
import Notebooks from './pages/Notebooks'
import Settings from './pages/Settings'
import Admin from './pages/Admin'
import Dictionaries from './pages/Dictionaries'
import { AppSettingsProvider } from './hooks/useAppSettings'

const STORAGE_KEY = 'app-theme-v1'

interface ThemeContextType {
  themeName: string
  setThemeName: (name: string) => void
  mode: 'light' | 'dark'
  /** @deprecated use setThemeName; kept for backward compat */
  toggle: () => void
}
export const ThemeCtx = createContext<ThemeContextType>({
  themeName: 'dark', setThemeName: () => {}, mode: 'dark', toggle: () => {},
})
export const useThemeMode = () => useContext(ThemeCtx)

export default function App() {
  const [themeName, setThemeNameState] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? 'dark',
  )

  const setThemeName = (name: string) => {
    if (THEME_MAP[name]) {
      localStorage.setItem(STORAGE_KEY, name)
      setThemeNameState(name)
    }
  }

  const meta = THEME_MAP[themeName] ?? THEME_MAP['dark']
  const theme = useMemo(() => meta.theme, [meta])

  const toggle = () => {
    const current = THEME_MAP[themeName]
    const nextMode = current?.mode === 'dark' ? 'light' : 'dark'
    const next = THEMES.find((t) => t.mode === nextMode)
    if (next) setThemeName(next.name)
  }

  return (
    <ThemeCtx.Provider value={{ themeName, setThemeName, mode: meta.mode, toggle }}>
      <AppSettingsProvider>
        <ThemeProvider theme={theme}>
          <LocalizationProvider dateAdapter={AdapterDateFns}>
            <CssBaseline />
            <BrowserRouter>
              <Layout>
                <Routes>
                  <Route path="/" element={<Navigate to="/pipelines" replace />} />
                  <Route path="/pipelines" element={<Pipelines />} />
                  <Route path="/chains" element={<ETLChains />} />
                  <Route path="/studio" element={<PipelineStudio />} />
                  <Route path="/sql-browser" element={<SqlBrowser />} />
                  <Route path="/notebooks" element={<Notebooks />} />
                  <Route path="/graph" element={<PipelineGraph />} />
                  <Route path="/runs" element={<ETLRuns />} />
                  <Route path="/explorer" element={<DataExplorer />} />
                  <Route path="/errors" element={<ErrorsPage />} />
                  <Route path="/services" element={<Services />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/admin" element={<Admin />} />
                  <Route path="/dictionaries" element={<Dictionaries />} />
                  {/* Legacy redirects */}
                  <Route path="/dashboard" element={<Navigate to="/pipelines" replace />} />
                </Routes>
              </Layout>
            </BrowserRouter>
          </LocalizationProvider>
        </ThemeProvider>
      </AppSettingsProvider>
    </ThemeCtx.Provider>
  )
}
