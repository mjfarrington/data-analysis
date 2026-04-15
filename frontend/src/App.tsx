import { useState, createContext, useContext, useMemo } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider, CssBaseline } from '@mui/material'
import { darkTheme, lightTheme } from './theme'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import ETLPipelines from './pages/ETLPipelines'
import ETLRuns from './pages/ETLRuns'
import DataExplorer from './pages/DataExplorer'
import ErrorsPage from './pages/ErrorsPage'

interface ThemeContextType {
  mode: 'light' | 'dark'
  toggle: () => void
}
export const ThemeCtx = createContext<ThemeContextType>({ mode: 'dark', toggle: () => {} })
export const useThemeMode = () => useContext(ThemeCtx)

export default function App() {
  const [mode, setMode] = useState<'light' | 'dark'>('dark')
  const toggle = () => setMode((m) => (m === 'dark' ? 'light' : 'dark'))
  const theme = useMemo(() => (mode === 'dark' ? darkTheme : lightTheme), [mode])

  return (
    <ThemeCtx.Provider value={{ mode, toggle }}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <BrowserRouter>
          <Layout>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/pipelines" element={<ETLPipelines />} />
              <Route path="/runs" element={<ETLRuns />} />
              <Route path="/explorer" element={<DataExplorer />} />
              <Route path="/errors" element={<ErrorsPage />} />
            </Routes>
          </Layout>
        </BrowserRouter>
      </ThemeProvider>
    </ThemeCtx.Provider>
  )
}
