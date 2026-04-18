import { useMemo } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider, CssBaseline } from '@mui/material'
import { darkTheme, githubDarkTheme, darkBlueTheme, lightTheme, applyDensity } from './theme'
import { useAuthStore } from './store/auth'
import { useThemeStore } from './store/theme'

import AppShell from './components/AppShell'
import Login from './pages/Login'
import Pipelines from './pages/Pipelines'
import PipelineEditor from './pages/PipelineEditor'
import Workflows from './pages/Workflows'
import SqlFiles from './pages/SqlFiles'
import Notebooks from './pages/Notebooks'
import Dictionaries from './pages/Dictionaries'
import DataExplorer from './pages/DataExplorer'
import RunHistory from './pages/RunHistory'
import Services from './pages/Services'
import Settings from './pages/Settings'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
})

function AuthGuard({ children }: { children: React.ReactNode }) {
  const user = useAuthStore(s => s.user)
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AppRoutes() {
  const user = useAuthStore(s => s.user)

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/pipelines" replace /> : <Login />}
      />
      <Route
        path="/"
        element={
          <AuthGuard>
            <AppShell />
          </AuthGuard>
        }
      >
        <Route index element={<Navigate to="/pipelines" replace />} />
        <Route path="pipelines" element={<Pipelines />} />
        <Route path="pipelines/:id/edit" element={<PipelineEditor />} />
        <Route path="workflows" element={<Workflows />} />
        <Route path="sql-files" element={<SqlFiles />} />
        <Route path="notebooks" element={<Notebooks />} />
        <Route path="dictionaries" element={<Dictionaries />} />
        <Route path="explorer" element={<DataExplorer />} />
        <Route path="runs" element={<RunHistory />} />
        <Route path="services" element={<Services />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/pipelines" replace />} />
    </Routes>
  )
}

export default function App() {
  const mode = useThemeStore(s => s.mode)
  const density = useThemeStore(s => s.density)
  const themeMap = { 'github-dark': githubDarkTheme, 'dark-blue': darkBlueTheme, 'light': lightTheme }
  const theme = useMemo(() => applyDensity(themeMap[mode] ?? darkTheme, density), [mode, density])

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
