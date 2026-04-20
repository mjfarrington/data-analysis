import { useState } from 'react'
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom'
import {
  Box, AppBar, Toolbar, Drawer, List, ListItem,
  ListItemButton, ListItemIcon, ListItemText, IconButton, Tooltip,
  Divider, Avatar, Chip, alpha, useTheme, Button,
  ToggleButtonGroup, ToggleButton, Typography,
  Dialog, DialogTitle, DialogContent, DialogActions,
  Popover, TextField, CircularProgress,
} from '@mui/material'
import {
  Dashboard as DashboardIcon,
  AccountTree as PipelinesIcon,
  Schema as SchemaIcon,
  Code as CodeIcon,
  LibraryBooks as LibraryBooksIcon,
  Book as BookIcon,
  Storage as StorageIcon,
  History as HistoryIcon,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronRight,
  Logout,
  HubOutlined,
  MonitorHeart as MonitorHeartIcon,
  CalendarToday,
  Close,
  Brightness4,
  Brightness7,
  Water,
  Cable as CableIcon,
  FolderOpen as FolderOpenIcon,
  TableChart as TableChartIcon,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { servicesApi, contextApi } from '../api/client'
import { useAuthStore } from '../store/auth'
import { useThemeStore, ThemeMode, Density } from '../store/theme'

const SIDEBAR_FULL = 220
const SIDEBAR_MINI = 56

interface NavItem {
  label: string
  path: string
  icon: React.ReactNode
}

interface NavSection {
  section: string
  items: NavItem[]
}

const NAV: NavSection[] = [
  {
    section: 'Overview',
    items: [
      { label: 'Dashboard', path: '/dashboard', icon: <DashboardIcon fontSize="small" /> },
    ],
  },
  {
    section: 'Build',
    items: [
      { label: 'Pipelines', path: '/pipelines', icon: <PipelinesIcon fontSize="small" /> },
      { label: 'Workflows', path: '/workflows', icon: <SchemaIcon fontSize="small" /> },
      { label: 'Transform Jobs', path: '/transform-jobs', icon: <Water fontSize="small" /> },
    ],
  },
  {
    section: 'Transforms',
    items: [
      { label: 'SQL Files', path: '/sql-files', icon: <CodeIcon fontSize="small" /> },
      { label: 'Notebooks', path: '/notebooks', icon: <LibraryBooksIcon fontSize="small" /> },
      { label: 'Dictionaries', path: '/dictionaries', icon: <BookIcon fontSize="small" /> },
      { label: 'Catalogues', path: '/catalogues', icon: <TableChartIcon fontSize="small" /> },
    ],
  },
  {
    section: 'Explore',
    items: [
      { label: 'Data Explorer', path: '/explorer', icon: <StorageIcon fontSize="small" /> },
      { label: 'Data Browser',  path: '/data-browser', icon: <FolderOpenIcon fontSize="small" /> },
    ],
  },
  {
    section: 'Platform',
    items: [
      { label: 'Connections', path: '/connections', icon: <CableIcon fontSize="small" /> },
    ],
  },
  {
    section: 'Monitor',
    items: [
      { label: 'Run History', path: '/runs', icon: <HistoryIcon fontSize="small" /> },
      { label: 'Services', path: '/services', icon: <MonitorHeartIcon fontSize="small" /> },
    ],
  },
]

function ServiceDots({ overall }: { overall: string }) {
  const color =
    overall === 'healthy' ? 'success' :
    overall === 'degraded' ? 'warning' : 'error'
  return (
    <Tooltip title={`Services: ${overall}`}>
      <Box
        sx={{
          width: 8, height: 8, borderRadius: '50%',
          bgcolor: `${color}.main`,
          boxShadow: `0 0 5px currentColor`,
        }}
      />
    </Tooltip>
  )
}

export default function AppShell() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [collapsed, setCollapsed] = useState(false)
  const [quickSettingsOpen, setQuickSettingsOpen] = useState(false)
  const [dateAnchor, setDateAnchor] = useState<HTMLElement | null>(null)
  const [dateInput, setDateInput] = useState('')
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore(s => s.user)
  const logout = useAuthStore(s => s.logout)
  const setMode = useThemeStore(s => s.setMode)
  const themeMode = useThemeStore(s => s.mode)
  const density = useThemeStore(s => s.density)
  const setDensity = useThemeStore(s => s.setDensity)

  const { data: services } = useQuery({
    queryKey: ['services-status'],
    queryFn: servicesApi.status,
    refetchInterval: 15000,
    retry: false,
  })

  const { data: ctx } = useQuery({
    queryKey: ['execution-context'],
    queryFn: contextApi.get,
    staleTime: 60000,
    retry: false,
  })

  const updateCtxMut = useMutation({
    mutationFn: (date: string) =>
      contextApi.update({ business_date: date, namespace: ctx?.namespace ?? '' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['execution-context'] })
      setDateAnchor(null)
    },
  })

  const openDatePicker = (el: HTMLElement) => {
    setDateInput(ctx?.business_date ?? '')
    setDateAnchor(el)
  }

  const sidebarWidth = collapsed ? SIDEBAR_MINI : SIDEBAR_FULL

  // Shared styles for bottom sidebar nav buttons
  const bottomNavBtn = (active?: boolean) => ({
    minHeight: 34,
    px: collapsed ? 0 : 1.5,
    justifyContent: collapsed ? 'center' : 'flex-start',
    mx: 0.75, borderRadius: 1.5,
    ...(active && {
      bgcolor: alpha(theme.palette.primary.main, 0.12),
      color: 'primary.main',
      '& .MuiListItemIcon-root': { color: 'primary.main' },
    }),
    '&:hover': { bgcolor: alpha(theme.palette.action.hover, 0.08) },
  })

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>

      {/* ── Sidebar ─────────────────────────────────────────────────── */}
      <Drawer
        variant="permanent"
        sx={{
          width: sidebarWidth,
          flexShrink: 0,
          transition: 'width 0.18s ease',
          '& .MuiDrawer-paper': {
            width: sidebarWidth,
            transition: 'width 0.18s ease',
            overflow: 'hidden',
            bgcolor: 'background.paper',
            borderRight: `1px solid ${theme.palette.divider}`,
            display: 'flex',
            flexDirection: 'column',
          },
        }}
      >
        {/* Logo */}
        <Box
          sx={{
            height: 44, display: 'flex', alignItems: 'center',
            px: 1.75, gap: 1.25, borderBottom: `1px solid ${theme.palette.divider}`,
            flexShrink: 0,
          }}
        >
          <Box
            sx={{
              width: 26, height: 26, borderRadius: 1.5, flexShrink: 0,
              background: 'linear-gradient(135deg, #58a6ff 0%, #3fb950 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <HubOutlined sx={{ fontSize: 15, color: '#fff' }} />
          </Box>
          {!collapsed && (
            <Typography variant="subtitle2" fontWeight={700} noWrap sx={{ letterSpacing: '0.02em', fontSize: '0.82rem' }}>
              Data Studio
            </Typography>
          )}
        </Box>

        {/* Nav sections */}
        <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', py: 0.75 }}>
          {NAV.map(({ section, items }) => (
            <Box key={section}>
              {!collapsed && (
                <Typography
                  variant="caption"
                  sx={{
                    px: 2, pt: 1, pb: 0.25, display: 'block',
                    color: 'text.secondary', fontWeight: 600,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    fontSize: '0.6rem',
                  }}
                >
                  {section}
                </Typography>
              )}
              {collapsed && <Divider sx={{ my: 0.5, mx: 1 }} />}
              <List dense disablePadding>
                {items.map(item => {
                  const active = location.pathname.startsWith(item.path)
                  return (
                    <Tooltip
                      key={item.path}
                      title={collapsed ? item.label : ''}
                      placement="right"
                    >
                      <ListItem disablePadding sx={{ px: 0.75 }}>
                        <ListItemButton
                          component={Link}
                          to={item.path}
                          selected={active}
                          sx={{
                            minHeight: 32,
                            px: collapsed ? 0 : 1.25,
                            justifyContent: collapsed ? 'center' : 'flex-start',
                            borderRadius: 1.5,
                            '&.Mui-selected': {
                              bgcolor: alpha(theme.palette.primary.main, 0.12),
                              color: 'primary.main',
                              '& .MuiListItemIcon-root': { color: 'primary.main' },
                            },
                          }}
                        >
                          <ListItemIcon
                            sx={{
                              minWidth: collapsed ? 0 : 32,
                              color: active ? 'primary.main' : 'text.secondary',
                            }}
                          >
                            {item.icon}
                          </ListItemIcon>
                          {!collapsed && (
                            <ListItemText
                              primary={item.label}
                              primaryTypographyProps={{
                                variant: 'body2',
                                fontWeight: active ? 600 : 400,
                                fontSize: '0.8rem',
                              }}
                            />
                          )}
                        </ListItemButton>
                      </ListItem>
                    </Tooltip>
                  )
                })}
              </List>
            </Box>
          ))}
        </Box>

        {/* ── Bottom: user · settings · collapse ────────────────────── */}
        <Box sx={{ borderTop: `1px solid ${theme.palette.divider}`, flexShrink: 0, pb: 0.5 }}>

          {/* User */}
          <Tooltip title={collapsed ? (user?.username ?? 'Account') : ''} placement="right">
            <ListItem disablePadding sx={{ px: 0.75, pt: 0.5 }}>
              <ListItemButton
                onClick={() => setQuickSettingsOpen(true)}
                sx={bottomNavBtn()}
              >
                <ListItemIcon sx={{ minWidth: collapsed ? 0 : 32 }}>
                  <Avatar
                    sx={{
                      width: 22, height: 22,
                      fontSize: '0.68rem',
                      bgcolor: 'primary.main',
                    }}
                  >
                    {user?.username?.[0].toUpperCase() ?? '?'}
                  </Avatar>
                </ListItemIcon>
                {!collapsed && (
                  <ListItemText
                    primary={user?.username}
                    primaryTypographyProps={{
                      variant: 'body2',
                      fontWeight: 500,
                      fontSize: '0.8rem',
                      noWrap: true,
                    }}
                  />
                )}
              </ListItemButton>
            </ListItem>
          </Tooltip>

          {/* Settings */}
          <Tooltip title={collapsed ? 'Settings' : ''} placement="right">
            <ListItem disablePadding sx={{ px: 0.75 }}>
              <ListItemButton
                component={Link}
                to="/settings"
                sx={bottomNavBtn(location.pathname.startsWith('/settings'))}
              >
                <ListItemIcon
                  sx={{
                    minWidth: collapsed ? 0 : 32,
                    color: location.pathname.startsWith('/settings')
                      ? 'primary.main' : 'text.secondary',
                  }}
                >
                  <SettingsIcon sx={{ fontSize: 18 }} />
                </ListItemIcon>
                {!collapsed && (
                  <ListItemText
                    primary="Settings"
                    primaryTypographyProps={{
                      variant: 'body2',
                      fontWeight: location.pathname.startsWith('/settings') ? 600 : 400,
                      fontSize: '0.8rem',
                    }}
                  />
                )}
              </ListItemButton>
            </ListItem>
          </Tooltip>

          {/* Collapse toggle */}
          <ListItem disablePadding>
            <ListItemButton
              onClick={() => setCollapsed(v => !v)}
              sx={{ justifyContent: collapsed ? 'center' : 'flex-end', px: 2, py: 0.5 }}
            >
              {collapsed
                ? <ChevronRight sx={{ fontSize: 16 }} />
                : <ChevronLeft sx={{ fontSize: 16 }} />
              }
            </ListItemButton>
          </ListItem>
        </Box>
      </Drawer>

      {/* ── Main area ───────────────────────────────────────────────── */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {/* Top bar */}
        <AppBar
          position="static"
          elevation={0}
          sx={{
            bgcolor: 'background.paper',
            borderBottom: `1px solid ${theme.palette.divider}`,
            height: 44,
          }}
        >
          <Toolbar variant="dense" sx={{ minHeight: 44, gap: 1.5 }}>
            <Box sx={{ flex: 1 }} />

            {/* Business date — click to edit */}
            <Chip
              icon={<CalendarToday sx={{ fontSize: '0.72rem !important' }} />}
              label={ctx?.business_date ?? 'No date set'}
              size="small"
              variant="outlined"
              onClick={e => openDatePicker(e.currentTarget)}
              sx={{
                fontSize: '0.68rem', height: 22,
                cursor: 'pointer',
                '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
              }}
            />

            {/* Date edit popover */}
            <Popover
              open={Boolean(dateAnchor)}
              anchorEl={dateAnchor}
              onClose={() => setDateAnchor(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              PaperProps={{ sx: { p: 1.5, mt: 0.5, borderRadius: 1.5, minWidth: 220 } }}
            >
              <Typography variant="caption" fontWeight={700} color="text.secondary" display="block" mb={1}>
                Business Date
              </Typography>
              <TextField
                type="date"
                size="small"
                value={dateInput}
                onChange={e => setDateInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && dateInput) updateCtxMut.mutate(dateInput)
                  if (e.key === 'Escape') setDateAnchor(null)
                }}
                fullWidth
                autoFocus
                sx={{ mb: 1 }}
                inputProps={{ style: { fontSize: '0.82rem' } }}
              />
              <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                <Button size="small" onClick={() => setDateAnchor(null)} sx={{ fontSize: '0.72rem' }}>Cancel</Button>
                <Button
                  size="small"
                  variant="contained"
                  disabled={!dateInput || updateCtxMut.isPending}
                  onClick={() => updateCtxMut.mutate(dateInput)}
                  sx={{ fontSize: '0.72rem' }}
                >
                  {updateCtxMut.isPending ? <CircularProgress size={12} color="inherit" /> : 'Apply'}
                </Button>
              </Box>
            </Popover>

            {/* Service health */}
            {services && <ServiceDots overall={services.overall} />}
          </Toolbar>
        </AppBar>

        {/* Page content */}
        <Box sx={{ flex: 1, overflow: 'auto', bgcolor: 'background.default' }}>
          <Outlet />
        </Box>
      </Box>

      {/* ── Quick Settings Dialog ────────────────────────────────────── */}
      <Dialog
        open={quickSettingsOpen}
        onClose={() => setQuickSettingsOpen(false)}
        maxWidth="xs"
        fullWidth
        PaperProps={{ elevation: 8, sx: { borderRadius: 2 } }}
      >
        <DialogTitle sx={{ pb: 1.5, pt: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: '0.85rem' }}>
              {user?.username?.[0].toUpperCase() ?? '?'}
            </Avatar>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle2" fontWeight={700} noWrap>{user?.username}</Typography>
              <Typography variant="caption" color="text.secondary">Signed in</Typography>
            </Box>
            <IconButton size="small" onClick={() => setQuickSettingsOpen(false)} sx={{ opacity: 0.6 }}>
              <Close fontSize="small" />
            </IconButton>
          </Box>
        </DialogTitle>

        <Divider />

        <DialogContent sx={{ pt: 2, pb: 1.5 }}>
          {/* Theme */}
          <Typography
            variant="caption"
            fontWeight={700}
            color="text.secondary"
            letterSpacing="0.08em"
            textTransform="uppercase"
            display="block"
            mb={1}
          >
            Theme
          </Typography>
          <ToggleButtonGroup
            value={themeMode}
            exclusive
            onChange={(_, val) => val && setMode(val as ThemeMode)}
            size="small"
            fullWidth
            sx={{ mb: 2.5 }}
          >
            <ToggleButton value="github-dark" sx={{ flexDirection: 'column', py: 0.75, gap: 0.5, flex: 1, fontSize: '0.62rem' }}>
              <Brightness4 sx={{ fontSize: 15 }} />
              GitHub Dark
            </ToggleButton>
            <ToggleButton value="dark-blue" sx={{ flexDirection: 'column', py: 0.75, gap: 0.5, flex: 1, fontSize: '0.62rem' }}>
              <Water sx={{ fontSize: 15 }} />
              Dark Blue
            </ToggleButton>
            <ToggleButton value="light" sx={{ flexDirection: 'column', py: 0.75, gap: 0.5, flex: 1, fontSize: '0.62rem' }}>
              <Brightness7 sx={{ fontSize: 15 }} />
              Light
            </ToggleButton>
          </ToggleButtonGroup>

          {/* Density */}
          <Typography
            variant="caption"
            fontWeight={700}
            color="text.secondary"
            letterSpacing="0.08em"
            textTransform="uppercase"
            display="block"
            mb={1}
          >
            Layout Density
          </Typography>
          <ToggleButtonGroup
            value={density}
            exclusive
            onChange={(_, val) => val && setDensity(val as Density)}
            size="small"
            fullWidth
          >
            <ToggleButton value="normal" sx={{ flex: 1, fontSize: '0.75rem', py: 0.75 }}>
              Default
            </ToggleButton>
            <ToggleButton value="compact" sx={{ flex: 1, fontSize: '0.75rem', py: 0.75 }}>
              Compact
            </ToggleButton>
          </ToggleButtonGroup>
        </DialogContent>

        <Divider />

        <DialogActions sx={{ px: 2, py: 1.25 }}>
          <Button
            size="small"
            startIcon={<SettingsIcon sx={{ fontSize: '0.85rem !important' }} />}
            onClick={() => { setQuickSettingsOpen(false); navigate('/settings') }}
            sx={{ mr: 'auto', fontSize: '0.78rem' }}
          >
            More Settings
          </Button>
          <Button
            size="small"
            variant="outlined"
            color="error"
            startIcon={<Logout sx={{ fontSize: '0.85rem !important' }} />}
            onClick={() => { logout(); navigate('/login', { replace: true }) }}
            sx={{ fontSize: '0.78rem' }}
          >
            Sign out
          </Button>
        </DialogActions>
      </Dialog>

    </Box>
  )
}
