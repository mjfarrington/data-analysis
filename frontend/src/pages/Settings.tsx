import { useState, useEffect } from 'react'
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider,
  Grid, IconButton, InputAdornment, MenuItem,
  Paper, Tab, Tabs, TextField, Tooltip, Typography, alpha, useTheme,
} from '@mui/material'
import {
  Add, Delete, Edit, Visibility, VisibilityOff, CheckCircle, Cancel,
  Palette, Link as LinkIcon,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import { connectionsApi, Connection, ConnectionPayload, ConnectionType } from '../api/client'
import { useThemeMode } from '../App'
import { useAppSettings, UIDensity, DiagramEdgeStyle } from '../hooks/useAppSettings'
import { THEMES } from '../theme'

// ─── Tab panel helper ─────────────────────────────────────────────────────────
function TabPanel({ value, index, children }: { value: number; index: number; children: React.ReactNode }) {
  if (value !== index) return null
  return <Box sx={{ pt: 3 }}>{children}</Box>
}

// ─── Appearance panel ─────────────────────────────────────────────────────────
function AppearancePanel() {
  const { themeName, setThemeName } = useThemeMode()
  const { settings, update } = useAppSettings()
  const theme = useTheme()

  const densityOptions: { value: UIDensity; label: string; desc: string }[] = [
    { value: 'comfortable', label: 'Comfortable', desc: 'Default spacing, larger click targets' },
    { value: 'compact', label: 'Compact', desc: 'Reduced padding, fits more on screen' },
  ]

  const edgeOptions: { value: DiagramEdgeStyle; label: string; desc: string }[] = [
    { value: 'bezier', label: 'Bezier', desc: 'Smooth curved lines' },
    { value: 'smoothstep', label: 'Smooth Step', desc: 'Rounded right-angle corners' },
    { value: 'step', label: 'Step', desc: 'Hard right-angle corners' },
    { value: 'straight', label: 'Straight', desc: 'Direct lines between nodes' },
  ]

  return (
    <Grid container spacing={3}>
      {/* Theme */}
      <Grid item xs={12}>
        <Typography variant="subtitle2" fontWeight={700} gutterBottom>Color Theme</Typography>
        {Array.from(new Set(THEMES.map((t) => t.group))).map((group) => (
          <Box key={group} sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block', textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: '0.7rem' }}>
              {group}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
              {THEMES.filter((t) => t.group === group).map((t) => {
                const active = themeName === t.name
                const [bg, surface, accent] = t.preview
                return (
                  <Paper
                    key={t.name}
                    variant="outlined"
                    onClick={() => setThemeName(t.name)}
                    sx={{
                      p: 1.5, cursor: 'pointer', width: 120,
                      borderColor: active ? 'primary.main' : undefined,
                      borderWidth: active ? 2 : 1,
                      bgcolor: active ? alpha(theme.palette.primary.main, 0.06) : undefined,
                      '&:hover': { borderColor: 'primary.main' },
                      transition: 'border-color 0.15s',
                    }}
                  >
                    <Box sx={{
                      width: '100%', height: 40, borderRadius: 1, mb: 1,
                      bgcolor: bg, border: `1px solid ${surface}`,
                      display: 'flex', flexDirection: 'column',
                      alignItems: 'flex-start', justifyContent: 'flex-end', p: '5px',
                      gap: '3px', overflow: 'hidden',
                    }}>
                      <Box sx={{ width: '55%', height: 4, borderRadius: 1, bgcolor: accent, opacity: 0.9 }} />
                      <Box sx={{ width: '80%', height: 3, borderRadius: 1, bgcolor: surface, opacity: 0.8, border: `1px solid ${accent}33` }} />
                      <Box sx={{ width: '40%', height: 3, borderRadius: 1, bgcolor: surface, opacity: 0.6 }} />
                    </Box>
                    <Typography variant="caption" fontWeight={active ? 700 : 400} display="block" noWrap>
                      {t.label}
                    </Typography>
                    {active && (
                      <Chip label="Active" size="small" color="primary"
                        sx={{ mt: 0.5, fontSize: '0.6rem', height: 16, '& .MuiChip-label': { px: 0.75 } }} />
                    )}
                  </Paper>
                )
              })}
            </Box>
          </Box>
        ))}
      </Grid>

      <Grid item xs={12}><Divider /></Grid>

      {/* Density */}
      <Grid item xs={12}>
        <Typography variant="subtitle2" fontWeight={700} gutterBottom>UI Density</Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {densityOptions.map((opt) => (
            <Paper
              key={opt.value}
              variant="outlined"
              onClick={() => update({ density: opt.value })}
              sx={{
                p: 2, cursor: 'pointer', minWidth: 160,
                borderColor: settings.density === opt.value ? 'primary.main' : undefined,
                borderWidth: settings.density === opt.value ? 2 : 1,
                bgcolor: settings.density === opt.value ? alpha(theme.palette.primary.main, 0.06) : undefined,
                '&:hover': { borderColor: 'primary.main' },
              }}
            >
              <Typography variant="body2" fontWeight={settings.density === opt.value ? 700 : 400}>{opt.label}</Typography>
              <Typography variant="caption" color="text.secondary">{opt.desc}</Typography>
              {settings.density === opt.value && (
                <Chip label="Active" size="small" color="primary"
                  sx={{ mt: 0.75, display: 'block', width: 'fit-content', fontSize: '0.65rem', height: 18 }} />
              )}
            </Paper>
          ))}
        </Box>
      </Grid>

      <Grid item xs={12}><Divider /></Grid>

      {/* Diagram edge style */}
      <Grid item xs={12}>
        <Typography variant="subtitle2" fontWeight={700} gutterBottom>Diagram Connector Style</Typography>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
          Controls how edges are drawn in the Pipeline Graph view
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {edgeOptions.map((opt) => (
            <Paper
              key={opt.value}
              variant="outlined"
              onClick={() => update({ diagramEdgeStyle: opt.value })}
              sx={{
                p: 2, cursor: 'pointer', minWidth: 150,
                borderColor: settings.diagramEdgeStyle === opt.value ? 'primary.main' : undefined,
                borderWidth: settings.diagramEdgeStyle === opt.value ? 2 : 1,
                bgcolor: settings.diagramEdgeStyle === opt.value ? alpha(theme.palette.primary.main, 0.06) : undefined,
                '&:hover': { borderColor: 'primary.main' },
              }}
            >
              <Typography variant="body2" fontWeight={settings.diagramEdgeStyle === opt.value ? 700 : 400}>{opt.label}</Typography>
              <Typography variant="caption" color="text.secondary">{opt.desc}</Typography>
              {settings.diagramEdgeStyle === opt.value && (
                <Chip label="Active" size="small" color="primary"
                  sx={{ mt: 0.75, display: 'block', width: 'fit-content', fontSize: '0.65rem', height: 18 }} />
              )}
            </Paper>
          ))}
        </Box>
      </Grid>
    </Grid>
  )
}

// ─── Connection form dialog ───────────────────────────────────────────────────
const CONN_TYPES: ConnectionType[] = ['jdbc', 'grpc', 'rest', 'other']

const emptyForm = (): ConnectionPayload => ({
  name: '', description: '', conn_type: 'jdbc',
  host: '', port: undefined, database: '', username: '', password: '', extra: {},
})

function ConnectionDialog({
  open, initial, onClose,
}: {
  open: boolean
  initial: Connection | null
  onClose: () => void
}) {
  const [form, setForm] = useState<ConnectionPayload>(emptyForm())
  const [showPass, setShowPass] = useState(false)
  const [passwordChanged, setPasswordChanged] = useState(false)
  const { enqueueSnackbar } = useSnackbar()
  const qc = useQueryClient()

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      if (initial) {
        setForm({
          name: initial.name,
          description: initial.description ?? '',
          conn_type: initial.conn_type,
          host: initial.host ?? '',
          port: initial.port,
          database: initial.database ?? '',
          username: initial.username ?? '',
          password: '',  // never pre-filled
          extra: initial.extra ?? {},
        })
        setPasswordChanged(false)
      } else {
        setForm(emptyForm())
        setPasswordChanged(false)
      }
    }
  }, [open, initial])

  const createMut = useMutation({
    mutationFn: (d: ConnectionPayload) => connectionsApi.create(d).then((r) => r.data),
    onSuccess: () => { enqueueSnackbar('Connection created', { variant: 'success' }); qc.invalidateQueries({ queryKey: ['connections'] }); onClose() },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const updateMut = useMutation({
    mutationFn: (d: Partial<ConnectionPayload>) => connectionsApi.update(initial!.id, d).then((r) => r.data),
    onSuccess: () => { enqueueSnackbar('Connection saved', { variant: 'success' }); qc.invalidateQueries({ queryKey: ['connections'] }); onClose() },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const isPending = createMut.isPending || updateMut.isPending

  const set = (k: keyof ConnectionPayload, v: unknown) => setForm((f) => ({ ...f, [k]: v }))

  const handleSave = () => {
    if (!form.name.trim()) return
    if (initial) {
      const payload: Partial<ConnectionPayload> = { ...form }
      if (!passwordChanged) delete payload.password
      updateMut.mutate(payload)
    } else {
      createMut.mutate(form)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial ? 'Edit Connection' : 'New Connection'}</DialogTitle>
      <DialogContent dividers>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={8}>
            <TextField label="Name *" value={form.name} fullWidth size="small"
              onChange={(e) => set('name', e.target.value)} />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField select label="Type" value={form.conn_type} fullWidth size="small"
              onChange={(e) => set('conn_type', e.target.value)}>
              {CONN_TYPES.map((t) => <MenuItem key={t} value={t}>{t.toUpperCase()}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={12}>
            <TextField label="Description" value={form.description ?? ''} fullWidth size="small"
              onChange={(e) => set('description', e.target.value)} />
          </Grid>
          <Grid item xs={12}><Divider><Typography variant="caption">Connection Details</Typography></Divider></Grid>
          <Grid item xs={12} sm={8}>
            <TextField label="Host / URL" value={form.host ?? ''} fullWidth size="small"
              placeholder="hostname or IP address"
              onChange={(e) => set('host', e.target.value)} />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField label="Port" type="number" value={form.port ?? ''} fullWidth size="small"
              onChange={(e) => set('port', e.target.value ? parseInt(e.target.value) : undefined)} />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField label="Database / Schema" value={form.database ?? ''} fullWidth size="small"
              onChange={(e) => set('database', e.target.value)} />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField label="Username" value={form.username ?? ''} fullWidth size="small"
              autoComplete="off"
              onChange={(e) => set('username', e.target.value)} />
          </Grid>
          <Grid item xs={12}>
            <TextField
              label={initial ? 'Password (leave blank to keep existing)' : 'Password'}
              value={form.password ?? ''}
              fullWidth size="small"
              type={showPass ? 'text' : 'password'}
              autoComplete="new-password"
              helperText="Encrypted before storage — never returned by the API"
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => setShowPass((v) => !v)} edge="end">
                      {showPass ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
              onChange={(e) => { set('password', e.target.value); setPasswordChanged(true) }}
            />
          </Grid>
          {initial?.has_password && !passwordChanged && (
            <Grid item xs={12}>
              <Alert severity="info" sx={{ py: 0.5 }}>
                A password is stored for this connection. Enter a new value above to replace it, or leave blank to keep it.
              </Alert>
            </Grid>
          )}
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={isPending || !form.name.trim()}
          startIcon={isPending ? <CircularProgress size={14} color="inherit" /> : undefined}>
          {initial ? 'Save Changes' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Connections panel ────────────────────────────────────────────────────────
function ConnectionsPanel() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Connection | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Connection | null>(null)
  const [testingId, setTestingId] = useState<number | null>(null)
  const [testResults, setTestResults] = useState<Record<number, { success: boolean; message: string }>>({})
  const { enqueueSnackbar } = useSnackbar()
  const qc = useQueryClient()
  const theme = useTheme()

  const { data: connections, isLoading } = useQuery<Connection[]>({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.list().then((r) => r.data),
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => connectionsApi.delete(id),
    onSuccess: () => { enqueueSnackbar('Connection deleted', { variant: 'info' }); qc.invalidateQueries({ queryKey: ['connections'] }); setDeleteTarget(null) },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const handleTest = async (conn: Connection) => {
    setTestingId(conn.id)
    try {
      const result = await connectionsApi.test(conn.id).then((r) => r.data)
      setTestResults((r) => ({ ...r, [conn.id]: result }))
      enqueueSnackbar(result.success ? `${conn.name}: connected` : `${conn.name}: ${result.message}`, {
        variant: result.success ? 'success' : 'error',
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Test failed'
      setTestResults((r) => ({ ...r, [conn.id]: { success: false, message: msg } }))
    } finally {
      setTestingId(null)
    }
  }

  const connTypeColor = (t: ConnectionType) => {
    const map: Record<ConnectionType, 'primary' | 'secondary' | 'warning' | 'default'> = {
      jdbc: 'primary', grpc: 'secondary', rest: 'warning', other: 'default',
    }
    return map[t]
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3, gap: 1 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle1" fontWeight={700}>Named Connections</Typography>
          <Typography variant="caption" color="text.secondary">
            Reusable connection configs for ETL jobs. Passwords are encrypted at rest and never exposed via the API.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<Add />}
          size="small"
          onClick={() => { setEditTarget(null); setDialogOpen(true) }}
        >
          Add Connection
        </Button>
      </Box>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      ) : !connections?.length ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <LinkIcon sx={{ fontSize: 40, color: 'text.disabled', mb: 1 }} />
          <Typography variant="body2" color="text.secondary">No connections configured yet</Typography>
          <Button variant="contained" startIcon={<Add />} size="small" sx={{ mt: 2 }}
            onClick={() => { setEditTarget(null); setDialogOpen(true) }}>
            Add First Connection
          </Button>
        </Paper>
      ) : (
        <Grid container spacing={2}>
          {connections.map((conn) => {
            const testResult = testResults[conn.id]
            return (
              <Grid item xs={12} md={6} key={conn.id}>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 2,
                    borderColor: testResult
                      ? (testResult.success ? 'success.main' : 'error.main')
                      : undefined,
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1 }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                        <Typography variant="subtitle2" fontWeight={700} noWrap>{conn.name}</Typography>
                        <Chip label={conn.conn_type} size="small" color={connTypeColor(conn.conn_type)} variant="outlined"
                          sx={{ fontSize: '0.65rem', height: 18, textTransform: 'uppercase' }} />
                        {conn.has_password && (
                          <Chip label="password" size="small" variant="outlined" color="default"
                            sx={{ fontSize: '0.65rem', height: 18 }} />
                        )}
                      </Box>
                      {conn.description && (
                        <Typography variant="caption" color="text.secondary" noWrap>{conn.description}</Typography>
                      )}
                      <Box sx={{ display: 'flex', gap: 2, mt: 0.5, flexWrap: 'wrap' }}>
                        {conn.host && <Typography variant="caption" color="text.secondary" fontFamily="monospace">{conn.host}{conn.port ? `:${conn.port}` : ''}</Typography>}
                        {conn.database && <Typography variant="caption" color="text.secondary">db: <strong>{conn.database}</strong></Typography>}
                        {conn.username && <Typography variant="caption" color="text.secondary">user: <strong>{conn.username}</strong></Typography>}
                      </Box>
                    </Box>
                    {testResult && (
                      <Tooltip title={testResult.message}>
                        {testResult.success
                          ? <CheckCircle sx={{ color: 'success.main', fontSize: 20, flexShrink: 0 }} />
                          : <Cancel sx={{ color: 'error.main', fontSize: 20, flexShrink: 0 }} />
                        }
                      </Tooltip>
                    )}
                  </Box>

                  <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
                    <Button size="small" variant="outlined"
                      startIcon={testingId === conn.id ? <CircularProgress size={12} /> : undefined}
                      onClick={() => handleTest(conn)}
                      disabled={testingId !== null}
                      sx={{ fontSize: '0.72rem' }}
                    >
                      Test
                    </Button>
                    <Button size="small" startIcon={<Edit sx={{ fontSize: 14 }} />}
                      onClick={() => { setEditTarget(conn); setDialogOpen(true) }}
                      sx={{ fontSize: '0.72rem' }}
                    >
                      Edit
                    </Button>
                    <Button size="small" color="error" startIcon={<Delete sx={{ fontSize: 14 }} />}
                      onClick={() => setDeleteTarget(conn)}
                      sx={{ fontSize: '0.72rem', ml: 'auto' }}
                    >
                      Delete
                    </Button>
                  </Box>
                </Paper>
              </Grid>
            )
          })}
        </Grid>
      )}

      {/* Create / edit dialog */}
      <ConnectionDialog
        open={dialogOpen}
        initial={editTarget}
        onClose={() => { setDialogOpen(false); setEditTarget(null) }}
      />

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete Connection</DialogTitle>
        <DialogContent>
          <Typography>
            Delete <strong>{deleteTarget?.name}</strong>? This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="error" variant="contained"
            onClick={() => deleteMut.mutate(deleteTarget!.id)}
            disabled={deleteMut.isPending}
            startIcon={deleteMut.isPending ? <CircularProgress size={14} color="inherit" /> : <Delete />}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

// ─── Main Settings page ───────────────────────────────────────────────────────
export default function Settings() {
  const [tab, setTab] = useState(0)

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5" fontWeight={700}>Settings</Typography>
        <Typography variant="caption" color="text.secondary">
          Manage appearance, connections, and platform configuration
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: 0 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ borderBottom: 1, borderColor: 'divider', px: 2 }}>
          <Tab
            icon={<Palette fontSize="small" />}
            iconPosition="start"
            label="Appearance"
            sx={{ fontSize: '0.875rem', minHeight: 48 }}
          />
          <Tab
            icon={<LinkIcon fontSize="small" />}
            iconPosition="start"
            label="Connections"
            sx={{ fontSize: '0.875rem', minHeight: 48 }}
          />
        </Tabs>

        <Box sx={{ p: 3 }}>
          <TabPanel value={tab} index={0}><AppearancePanel /></TabPanel>
          <TabPanel value={tab} index={1}><ConnectionsPanel /></TabPanel>
        </Box>
      </Paper>
    </Box>
  )
}
