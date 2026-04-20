import { useState, ReactNode } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Box, Drawer, IconButton, List, ListItem, ListItemButton,
  ListItemIcon, ListItemText, Typography, Tooltip, Badge,
  useTheme, alpha, Divider, ListSubheader,
} from '@mui/material'
import {
  Brightness4, Brightness7,
  ChevronLeft, Menu as MenuIcon,
  Circle as DotIcon,
  AccountTree as WorkflowIcon,
  HealthAndSafety as ServicesIcon,
  Code as SqlBrowserIcon,
  NoteAlt as NotebooksIcon,
  Settings as SettingsIcon,
  AdminPanelSettings as AdminIcon,
  MenuBook as DictIcon,
  Storage as DataIcon,
  BugReport as ErrorIcon,
  PlayCircle as RunsIcon,
  Share as GraphIcon,
  Schema as PipelineIcon,
  Explore as ExploreIcon,
} from '@mui/icons-material'
import { useQuery } from '@tanstack/react-query'
import { useThemeMode } from '../App'
import { servicesApi } from '../api/client'
import { useAppSettings } from '../hooks/useAppSettings'

const DRAWER_WIDTH = 220
const DRAWER_MINI = 64

// ─── Nav structure ────────────────────────────────────────────────────────────

interface NavItem {
  label: string
  path: string
  icon: React.ReactNode
}

interface NavSection {
  title: string
  items: NavItem[]
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Build',
    items: [
      { label: 'Pipelines', path: '/pipelines', icon: <PipelineIcon /> },
      { label: 'Workflows', path: '/chains', icon: <WorkflowIcon /> },
    ],
  },
  {
    title: 'Transforms',
    items: [
      { label: 'SQL Browser', path: '/sql-browser', icon: <SqlBrowserIcon /> },
      { label: 'Notebooks', path: '/notebooks', icon: <NotebooksIcon /> },
      { label: 'Dictionaries', path: '/dictionaries', icon: <DictIcon /> },
    ],
  },
  {
    title: 'Explore',
    items: [
      { label: 'Data Explorer', path: '/explorer', icon: <ExploreIcon /> },
      { label: 'Pipeline Graph', path: '/graph', icon: <GraphIcon /> },
    ],
  },
  {
    title: 'Monitor',
    items: [
      { label: 'Run History', path: '/runs', icon: <RunsIcon /> },
    ],
  },
]

const BOTTOM_ITEMS: NavItem[] = [
  { label: 'Services', path: '/services', icon: <ServicesIcon /> },
  { label: 'Errors', path: '/errors', icon: <ErrorIcon /> },
  { label: 'Settings', path: '/settings', icon: <SettingsIcon /> },
  { label: 'Admin', path: '/admin', icon: <AdminIcon /> },
]

function OverallDot({ status }: { status: string }) {
  const color = status === 'healthy' ? 'success.main' : status === 'degraded' ? 'warning.main' : 'error.main'
  return <DotIcon sx={{ fontSize: 10, color, mr: 0.5 }} />
}

export default function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true)
  const { toggle, mode } = useThemeMode()
  const { settings: appSettings } = useAppSettings()
  const location = useLocation()
  const navigate = useNavigate()
  const theme = useTheme()

  const { data: status } = useQuery({
    queryKey: ['services-status'],
    queryFn: () => servicesApi.status().then((r) => r.data),
    refetchInterval: 15_000,
  })

  const unhealthyCount = status?.services.filter((s) => s.status === 'unhealthy').length ?? 0
  const drawerWidth = open ? DRAWER_WIDTH : DRAWER_MINI

  const allItems = [...NAV_SECTIONS.flatMap((s) => s.items), ...BOTTOM_ITEMS]
  const currentLabel = allItems.find((n) => n.path === location.pathname)?.label ?? 'Data Platform'

  const renderNavItem = (item: NavItem) => {
    const active = location.pathname === item.path
    const badgeCount = item.label === 'Errors' ? unhealthyCount : 0
    return (
      <ListItem key={item.path} disablePadding sx={{ mb: 0.25 }}>
        <Tooltip title={open ? '' : item.label} placement="right">
          <ListItemButton
            selected={active}
            onClick={() => navigate(item.path)}
            sx={{
              borderRadius: 1.5,
              minHeight: 38,
              px: open ? 1.5 : 1,
              justifyContent: open ? 'flex-start' : 'center',
              '&.Mui-selected': {
                bgcolor: alpha(theme.palette.primary.main, 0.15),
                color: 'primary.main',
                '& .MuiListItemIcon-root': { color: 'primary.main' },
              },
            }}
          >
            <ListItemIcon sx={{ minWidth: open ? 34 : 'unset', justifyContent: 'center',
              color: active ? 'primary.main' : 'text.secondary', fontSize: 20 }}>
              {badgeCount > 0
                ? <Badge badgeContent={badgeCount} color="error">{item.icon}</Badge>
                : item.icon}
            </ListItemIcon>
            {open && (
              <ListItemText
                primary={item.label}
                primaryTypographyProps={{ fontSize: '0.85rem', fontWeight: active ? 600 : 400 }}
              />
            )}
          </ListItemButton>
        </Tooltip>
      </ListItem>
    )
  }

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar */}
      <Drawer
        variant="permanent"
        sx={{
          width: drawerWidth, flexShrink: 0, transition: 'width 0.2s',
          '& .MuiDrawer-paper': { width: drawerWidth, overflowX: 'hidden', transition: 'width 0.2s' },
        }}
      >
        {/* Logo row */}
        <Box sx={{
          display: 'flex', alignItems: 'center',
          justifyContent: open ? 'space-between' : 'center',
          px: open ? 2 : 0, py: 1.5, minHeight: 52,
        }}>
          {open && (
            <Typography variant="subtitle1" fontWeight={700} noWrap
              sx={{ color: 'primary.main', letterSpacing: '-0.01em', fontSize: '0.95rem' }}>
              DataPlatform
            </Typography>
          )}
          <IconButton size="small" onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronLeft fontSize="small" /> : <MenuIcon fontSize="small" />}
          </IconButton>
        </Box>

        <Divider />

        {/* Health pill */}
        {open && status && (
          <Box sx={{ mx: 1.5, mt: 1, mb: 0.5, px: 1.25, py: 0.6, borderRadius: 1.5,
            bgcolor: alpha(theme.palette.primary.main, 0.07), display: 'flex', alignItems: 'center' }}>
            <OverallDot status={status.overall} />
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.75rem' }}>
              {status.overall.charAt(0).toUpperCase() + status.overall.slice(1)}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Box sx={{ display: 'flex', gap: 0.4 }}>
              {status.services.map((s) => (
                <Tooltip key={s.name} title={`${s.name}: ${s.status}`}>
                  <DotIcon sx={{ fontSize: 7,
                    color: s.status === 'healthy' ? 'success.main' : s.status === 'degraded' ? 'warning.main' : 'error.main' }} />
                </Tooltip>
              ))}
            </Box>
          </Box>
        )}

        {/* Main nav sections */}
        <Box sx={{ flex: 1, overflow: 'auto', mt: 0.5 }}>
          {NAV_SECTIONS.map((section) => (
            <Box key={section.title}>
              {open ? (
                <Typography sx={{ px: 2, pt: 1.5, pb: 0.25, fontSize: '0.62rem', fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.08em', color: 'text.disabled' }}>
                  {section.title}
                </Typography>
              ) : (
                <Divider sx={{ my: 0.5 }} />
              )}
              <List dense sx={{ px: 1, py: 0 }}>
                {section.items.map(renderNavItem)}
              </List>
            </Box>
          ))}
        </Box>

        <Divider />

        {/* Bottom items */}
        <List dense sx={{ px: 1, py: 0.5 }}>
          {BOTTOM_ITEMS.map(renderNavItem)}
        </List>

        <Divider />

        <Box sx={{ px: 1, py: 0.75, display: 'flex', justifyContent: open ? 'flex-end' : 'center' }}>
          <Tooltip title="Toggle theme">
            <IconButton size="small" onClick={toggle}>
              {mode === 'dark' ? <Brightness7 fontSize="small" /> : <Brightness4 fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Box>
      </Drawer>

      {/* Main content */}
      <Box component="main" sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Topbar */}
        <Box sx={{
          display: 'flex', alignItems: 'center', px: 2, py: 0, minHeight: 44,
          borderBottom: `1px solid ${alpha(theme.palette.divider, 0.8)}`,
          bgcolor: 'background.paper', flexShrink: 0,
        }}>
          <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 500, flex: 1 }}>
            {currentLabel}
          </Typography>
          {status && (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              {status.services.map((s) => (
                <Tooltip key={s.name} title={`${s.name}: ${s.status}${s.latency_ms ? ` (${s.latency_ms.toFixed(0)}ms)` : ''}`}>
                  <DotIcon sx={{ fontSize: 8,
                    color: s.status === 'healthy' ? 'success.main' : s.status === 'degraded' ? 'warning.main' : 'error.main' }} />
                </Tooltip>
              ))}
            </Box>
          )}
        </Box>

        {/* Page content */}
        <Box sx={{ flex: 1, p: appSettings.density === 'compact' ? 2 : 3, overflow: 'auto' }}>
          {children}
        </Box>
      </Box>
    </Box>
  )
}
