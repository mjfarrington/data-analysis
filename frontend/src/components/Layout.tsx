import { useState, ReactNode } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  AppBar, Box, Drawer, IconButton, List, ListItem, ListItemButton,
  ListItemIcon, ListItemText, Toolbar, Typography, Tooltip, Badge,
  useTheme, alpha, Divider,
} from '@mui/material'
import {
  Dashboard as DashboardIcon,
  AccountTree as PipelineIcon,
  PlayCircle as RunsIcon,
  Storage as DataIcon,
  BugReport as ErrorIcon,
  Brightness4, Brightness7,
  ChevronLeft, Menu as MenuIcon,
  Circle as DotIcon,
} from '@mui/icons-material'
import { useQuery } from '@tanstack/react-query'
import { useThemeMode } from '../App'
import { servicesApi } from '../api/client'

const DRAWER_WIDTH = 220
const DRAWER_MINI = 64

const navItems = [
  { label: 'Dashboard', path: '/dashboard', icon: <DashboardIcon /> },
  { label: 'ETL Pipelines', path: '/pipelines', icon: <PipelineIcon /> },
  { label: 'Runs', path: '/runs', icon: <RunsIcon /> },
  { label: 'Data Explorer', path: '/explorer', icon: <DataIcon /> },
  { label: 'Errors', path: '/errors', icon: <ErrorIcon /> },
]

function OverallDot({ status }: { status: string }) {
  const color = status === 'healthy' ? 'success.main' : status === 'degraded' ? 'warning.main' : 'error.main'
  return <DotIcon sx={{ fontSize: 10, color, mr: 0.5 }} />
}

export default function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true)
  const { toggle, mode } = useThemeMode()
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
          {navItems.map((item) => {
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
              {navItems.find((n) => n.path === location.pathname)?.label ?? 'Data Analysis Platform'}
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
        <Box sx={{ flex: 1, p: 3, overflow: 'auto' }}>{children}</Box>
      </Box>
    </Box>
  )
}
