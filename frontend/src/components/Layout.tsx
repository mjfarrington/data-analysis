import { useState, useRef, ReactNode } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  AppBar, Box, Drawer, IconButton, List, ListItem, ListItemButton,
  ListItemIcon, ListItemText, Toolbar, Typography, Tooltip, Badge,
  useTheme, alpha, Divider,
} from '@mui/material'
import {
  Dashboard as DashboardIcon,
  PlayCircle as RunsIcon,
  Storage as DataIcon,
  BugReport as ErrorIcon,
  Brightness4, Brightness7,
  ChevronLeft, Menu as MenuIcon,
  Circle as DotIcon,
  Share as GraphIcon,
  HealthAndSafety as ServicesIcon,
  DeveloperBoard as StudioIcon,
  Code as SqlBrowserIcon,
  NoteAlt as NotebooksIcon,
  Settings as SettingsIcon,
  AdminPanelSettings as AdminIcon,
  DragIndicator as DragIcon,
  MenuBook as DictIcon,
} from '@mui/icons-material'
import { useQuery } from '@tanstack/react-query'
import { useThemeMode } from '../App'
import { servicesApi } from '../api/client'
import { useAppSettings } from '../hooks/useAppSettings'

const DRAWER_WIDTH = 220
const DRAWER_MINI = 64
const NAV_ORDER_KEY = 'sidebar_nav_order'

const ALL_NAV_ITEMS = [
  { label: 'Dashboard', path: '/dashboard', icon: <DashboardIcon /> },
  { label: 'Studio', path: '/studio', icon: <StudioIcon /> },
  { label: 'SQL Browser', path: '/sql-browser', icon: <SqlBrowserIcon /> },
  { label: 'Notebooks', path: '/notebooks', icon: <NotebooksIcon /> },
  { label: 'Pipeline Graph', path: '/graph', icon: <GraphIcon /> },
  { label: 'Runs', path: '/runs', icon: <RunsIcon /> },
  { label: 'Data Explorer', path: '/explorer', icon: <DataIcon /> },
  { label: 'Dictionaries', path: '/dictionaries', icon: <DictIcon /> },
  { label: 'Services', path: '/services', icon: <ServicesIcon /> },
  { label: 'Errors', path: '/errors', icon: <ErrorIcon /> },
]

function loadNavOrder(): typeof ALL_NAV_ITEMS {
  try {
    const saved = localStorage.getItem(NAV_ORDER_KEY)
    if (saved) {
      const paths: string[] = JSON.parse(saved)
      const ordered = paths
        .map((p) => ALL_NAV_ITEMS.find((n) => n.path === p))
        .filter(Boolean) as typeof ALL_NAV_ITEMS
      // append any new items not yet in saved order
      const extra = ALL_NAV_ITEMS.filter((n) => !paths.includes(n.path))
      return [...ordered, ...extra]
    }
  } catch { /* ignore */ }
  return ALL_NAV_ITEMS
}

function saveNavOrder(items: typeof ALL_NAV_ITEMS) {
  localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(items.map((n) => n.path)))
}

const settingsItem = { label: 'Settings', path: '/settings', icon: <SettingsIcon /> }
const adminItem = { label: 'Admin', path: '/admin', icon: <AdminIcon /> }

function OverallDot({ status }: { status: string }) {
  const color = status === 'healthy' ? 'success.main' : status === 'degraded' ? 'warning.main' : 'error.main'
  return <DotIcon sx={{ fontSize: 10, color, mr: 0.5 }} />
}

export default function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true)
  const [navItems, setNavItems] = useState(loadNavOrder)
  const { toggle, mode } = useThemeMode()
  const { settings: appSettings } = useAppSettings()
  const location = useLocation()
  const navigate = useNavigate()
  const theme = useTheme()

  // Drag-to-reorder state
  const dragIndex = useRef<number | null>(null)
  const dragOverIndex = useRef<number | null>(null)

  const handleDragStart = (index: number) => {
    dragIndex.current = index
  }
  const handleDragEnter = (index: number) => {
    dragOverIndex.current = index
  }
  const handleDragEnd = () => {
    const from = dragIndex.current
    const to = dragOverIndex.current
    if (from !== null && to !== null && from !== to) {
      setNavItems((prev) => {
        const updated = [...prev]
        const [moved] = updated.splice(from, 1)
        updated.splice(to, 0, moved)
        saveNavOrder(updated)
        return updated
      })
    }
    dragIndex.current = null
    dragOverIndex.current = null
  }

  const { data: status } = useQuery({
    queryKey: ['services-status'],
    queryFn: () => servicesApi.status().then((r) => r.data),
    refetchInterval: 15_000,
  })

  const unhealthyCount = status?.services.filter((s) => s.status === 'unhealthy').length ?? 0
  const drawerWidth = open ? DRAWER_WIDTH : DRAWER_MINI

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar */}
      <Drawer
        variant="permanent"
        sx={{
          width: drawerWidth,
          flexShrink: 0,
          transition: 'width 0.2s',
          '& .MuiDrawer-paper': {
            width: drawerWidth,
            overflowX: 'hidden',
            transition: 'width 0.2s',
          },
        }}
      >
        {/* Logo row */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: open ? 'space-between' : 'center',
            px: open ? 2 : 0,
            py: 1.5,
            minHeight: 56,
          }}
        >
          {open && (
            <Typography variant="subtitle1" fontWeight={700} noWrap sx={{ color: 'primary.main', letterSpacing: '-0.01em' }}>
              DataPlatform
            </Typography>
          )}
          <IconButton size="small" onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronLeft fontSize="small" /> : <MenuIcon fontSize="small" />}
          </IconButton>
        </Box>

        <Divider />

        {/* Overall health pill */}
        {open && status && (
          <Box sx={{ mx: 2, my: 1, px: 1.5, py: 0.75, borderRadius: 2, bgcolor: alpha(theme.palette.primary.main, 0.08), display: 'flex', alignItems: 'center' }}>
            <OverallDot status={status.overall} />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {status.overall.charAt(0).toUpperCase() + status.overall.slice(1)}
            </Typography>
          </Box>
        )}

        <List dense sx={{ px: 1, flex: 1, mt: 0.5 }}>
          {navItems.map((item, index) => {
            const active = location.pathname === item.path
            return (
              <ListItem
                key={item.path}
                disablePadding
                sx={{ mb: 0.5, '&:hover .drag-handle': { opacity: 1 } }}
                draggable={open}
                onDragStart={() => handleDragStart(index)}
                onDragEnter={() => handleDragEnter(index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => e.preventDefault()}
              >
                <Tooltip title={open ? '' : item.label} placement="right">
                  <ListItemButton
                    selected={active}
                    onClick={() => navigate(item.path)}
                    sx={{
                      borderRadius: 2,
                      minHeight: 40,
                      px: open ? 1.5 : 1,
                      justifyContent: open ? 'flex-start' : 'center',
                      '&.Mui-selected': {
                        bgcolor: alpha(theme.palette.primary.main, 0.15),
                        color: 'primary.main',
                        '& .MuiListItemIcon-root': { color: 'primary.main' },
                      },
                    }}
                  >
                    {open && (
                      <DragIcon
                        className="drag-handle"
                        sx={{
                          fontSize: 14,
                          color: 'text.disabled',
                          opacity: 0,
                          transition: 'opacity 0.15s',
                          cursor: 'grab',
                          mr: 0.5,
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <ListItemIcon
                      sx={{
                        minWidth: open ? 36 : 'unset',
                        justifyContent: 'center',
                        color: active ? 'primary.main' : 'text.secondary',
                      }}
                    >
                      {item.label === 'Errors' && unhealthyCount > 0 ? (
                        <Badge badgeContent={unhealthyCount} color="error">
                          {item.icon}
                        </Badge>
                      ) : item.icon}
                    </ListItemIcon>
                    {open && (
                      <ListItemText
                        primary={item.label}
                        primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: active ? 600 : 400 }}
                      />
                    )}
                  </ListItemButton>
                </Tooltip>
              </ListItem>
            )
          })}
        </List>

        <Divider />
        <List dense sx={{ px: 1, py: 0.5 }}>
          {[adminItem, settingsItem].map((item) => {
            const active = location.pathname === item.path
            return (
              <ListItem key={item.path} disablePadding sx={{ mb: 0.5 }}>
                <Tooltip title={open ? '' : item.label} placement="right">
                  <ListItemButton
                    selected={active}
                    onClick={() => navigate(item.path)}
                    sx={{
                      borderRadius: 2,
                      minHeight: 40,
                      px: open ? 1.5 : 1,
                      justifyContent: open ? 'flex-start' : 'center',
                      '&.Mui-selected': {
                        bgcolor: alpha(theme.palette.primary.main, 0.15),
                        color: 'primary.main',
                        '& .MuiListItemIcon-root': { color: 'primary.main' },
                      },
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: open ? 36 : 'unset', justifyContent: 'center', color: active ? 'primary.main' : 'text.secondary' }}>
                      {item.icon}
                    </ListItemIcon>
                    {open && (
                      <ListItemText
                        primary={item.label}
                        primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: active ? 600 : 400 }}
                      />
                    )}
                  </ListItemButton>
                </Tooltip>
              </ListItem>
            )
          })}
        </List>
        <Divider />
        <Box sx={{ px: 1, py: 1, display: 'flex', justifyContent: open ? 'flex-end' : 'center' }}>
          <Tooltip title="Toggle theme">
            <IconButton size="small" onClick={toggle}>
              {mode === 'dark' ? <Brightness7 fontSize="small" /> : <Brightness4 fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Box>
      </Drawer>

      {/* Main content */}
      <Box component="main" sx={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <AppBar position="sticky" elevation={0} sx={{ zIndex: 1 }}>
          <Toolbar variant="dense" sx={{ minHeight: 48 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary', flex: 1 }}>
              {[...navItems, settingsItem, adminItem].find((n) => n.path === location.pathname)?.label ?? 'Data Analysis Platform'}
            </Typography>
            {status && (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                {status.services.map((s) => (
                  <Tooltip key={s.name} title={`${s.name}: ${s.status}${s.latency_ms ? ` (${s.latency_ms.toFixed(0)}ms)` : ''}`}>
                    <DotIcon
                      sx={{
                        fontSize: 9,
                        color: s.status === 'healthy' ? 'success.main' : s.status === 'degraded' ? 'warning.main' : 'error.main',
                      }}
                    />
                  </Tooltip>
                ))}
              </Box>
            )}
          </Toolbar>
        </AppBar>
        <Box sx={{ flex: 1, p: appSettings.density === 'compact' ? 2 : 3, overflow: 'auto' }}>{children}</Box>
      </Box>
    </Box>
  )
}
