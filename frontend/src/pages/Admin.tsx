import { useState } from 'react'
import {
  Box, Typography, Button, Chip, CircularProgress, Paper, Alert,
  Table, TableBody, TableCell, TableHead, TableRow, IconButton,
  Collapse, Tooltip, Dialog, DialogTitle, DialogContent, DialogActions,
  Grid, Card, CardContent, CardActions, Divider, LinearProgress, alpha,
  useTheme, List, ListItem, ListItemText, ListItemIcon, Checkbox,
} from '@mui/material'
import {
  ExpandMore, ExpandLess, Delete, Refresh, Warning, CheckCircle, Error as ErrorIcon,
  Storage, PlayArrow, FolderOpen, InsertDriveFile, RestartAlt,
  AutoDelete, ClearAll, Analytics, Power,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import { adminApi, StorageNode } from '../api/client'

function fmtBytes(b: number): string {
  if (b === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return `${(b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// ─── Storage tree node ────────────────────────────────────────────────────────

function StorageTreeNode({
  node,
  selected,
  onToggle,
  depth = 0,
}: {
  node: StorageNode
  selected: Set<string>
  onToggle: (path: string) => void
  depth?: number
}) {
  const [open, setOpen] = useState(depth < 1)
  const theme = useTheme()
  const hasChildren = node.is_dir && node.children.length > 0

  return (
    <>
      <TableRow
        hover
        sx={{
          bgcolor: selected.has(node.path) ? alpha(theme.palette.error.main, 0.06) : undefined,
          '& td': { py: 0.5 },
        }}
      >
        <TableCell sx={{ pl: 1 + depth * 3, width: 32 }}>
          <Checkbox
            size="small"
            checked={selected.has(node.path)}
            onChange={() => onToggle(node.path)}
          />
        </TableCell>
        <TableCell>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {hasChildren ? (
              <IconButton size="small" onClick={() => setOpen((o) => !o)} sx={{ p: 0.25 }}>
                {open ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
              </IconButton>
            ) : (
              <Box sx={{ width: 28 }} />
            )}
            {node.is_dir ? (
              <FolderOpen fontSize="small" sx={{ color: 'warning.main', flexShrink: 0 }} />
            ) : (
              <InsertDriveFile fontSize="small" sx={{ color: 'text.disabled', flexShrink: 0 }} />
            )}
            <Typography variant="body2" noWrap sx={{ maxWidth: 420 }}>{node.name}</Typography>
          </Box>
        </TableCell>
        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          <Chip label={fmtBytes(node.size_bytes)} size="small" variant="outlined"
            sx={{ fontSize: '0.7rem' }} />
        </TableCell>
      </TableRow>
      {hasChildren && open && node.children.map((child) => (
        <StorageTreeNode
          key={child.path}
          node={child}
          selected={selected}
          onToggle={onToggle}
          depth={depth + 1}
        />
      ))}
    </>
  )
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────

function ConfirmDialog({
  open, title, body, onConfirm, onClose, danger = true,
}: {
  open: boolean
  title: string
  body: string
  onConfirm: () => void
  onClose: () => void
  danger?: boolean
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Warning color="warning" /> {title}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2">{body}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button color={danger ? 'error' : 'primary'} variant="contained" onClick={onConfirm}>
          Confirm
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Storage section ──────────────────────────────────────────────────────────

function StorageSection() {
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState<null | 'purge-selected' | 'purge-all'>(null)

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['admin-storage'],
    queryFn: () => adminApi.storage().then((r) => r.data),
  })

  const purgePathMutation = useMutation({
    mutationFn: (path: string) => adminApi.purgePath(path).then((r) => r.data),
    onSuccess: (d) => {
      enqueueSnackbar(`Deleted: ${d.message}`, { variant: 'success' })
      setSelected(new Set())
      refetch()
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const purgeAllMutation = useMutation({
    mutationFn: () => adminApi.purgeAll().then((r) => r.data),
    onSuccess: (d) => {
      enqueueSnackbar(d.message, { variant: 'success' })
      setSelected(new Set())
      refetch()
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const handleConfirm = async () => {
    if (confirm === 'purge-selected') {
      for (const path of selected) {
        await purgePathMutation.mutateAsync(path)
      }
    } else if (confirm === 'purge-all') {
      await purgeAllMutation.mutateAsync()
    }
    setConfirm(null)
  }

  const togglePath = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="h6">Data Storage</Typography>
          {data && (
            <Chip label={`Total: ${fmtBytes(data.total_bytes)}`} size="small" color="primary" variant="outlined" />
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button size="small" startIcon={<Refresh />} onClick={() => refetch()} disabled={isFetching}>
            Refresh
          </Button>
          <Button
            size="small" color="warning" variant="outlined"
            startIcon={<AutoDelete />}
            disabled={selected.size === 0 || purgePathMutation.isPending}
            onClick={() => setConfirm('purge-selected')}
          >
            Purge Selected ({selected.size})
          </Button>
          <Button
            size="small" color="error" variant="outlined"
            startIcon={<ClearAll />}
            disabled={purgeAllMutation.isPending}
            onClick={() => setConfirm('purge-all')}
          >
            Purge Pipeline Data
          </Button>
        </Box>
      </Box>

      {isFetching && <LinearProgress sx={{ mb: 1 }} />}

      {data && (
        <Paper variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 32 }} />
                <TableCell>Path</TableCell>
                <TableCell align="right">Size</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.nodes.map((node) => (
                <StorageTreeNode key={node.path} node={node} selected={selected} onToggle={togglePath} />
              ))}
              {data.nodes.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No data directories found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Paper>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'purge-all' ? 'Purge all data?' : `Purge ${selected.size} item(s)?`}
        body={
          confirm === 'purge-all'
            ? 'This will delete all pipeline extract and parquet data from disk. The static directory will not be touched. This cannot be undone.'
            : `Delete the ${selected.size} selected path(s) from disk? This cannot be undone.`
        }
        onConfirm={handleConfirm}
        onClose={() => setConfirm(null)}
      />
    </Box>
  )
}

// ─── Runs section ─────────────────────────────────────────────────────────────

function RunsSection() {
  const { enqueueSnackbar } = useSnackbar()
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)

  const clearRunsMutation = useMutation({
    mutationFn: () => adminApi.deleteRuns().then((r) => r.data),
    onSuccess: (d) => {
      enqueueSnackbar(d.message, { variant: 'success' })
      setConfirm(false)
      qc.invalidateQueries({ queryKey: ['pipeline-graph'] })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  return (
    <Box>
      <Typography variant="h6" gutterBottom>Run History</Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        Clears all completed, failed, and cancelled run records from the database. Active and pending runs are not affected.
      </Alert>
      <Button
        color="error" variant="outlined" startIcon={<ClearAll />}
        onClick={() => setConfirm(true)}
      >
        Clear All Completed Runs
      </Button>

      <ConfirmDialog
        open={confirm}
        title="Clear all run history?"
        body="This will permanently delete all completed, failed, and cancelled run records. Running jobs are not affected."
        onConfirm={() => clearRunsMutation.mutate()}
        onClose={() => setConfirm(false)}
      />
    </Box>
  )
}

// ─── Stats section ────────────────────────────────────────────────────────────

function StatsSection() {
  const { enqueueSnackbar } = useSnackbar()
  const [confirm, setConfirm] = useState(false)

  const resetMutation = useMutation({
    mutationFn: () => adminApi.resetStats().then((r) => r.data),
    onSuccess: (d) => {
      enqueueSnackbar(d.message, { variant: 'success' })
      setConfirm(false)
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const clearErrorsMutation = useMutation({
    mutationFn: () => adminApi.clearErrors().then((r) => r.data),
    onSuccess: (d) => enqueueSnackbar(d.message, { variant: 'success' }),
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  return (
    <Box>
      <Typography variant="h6" gutterBottom>Pipeline Stats</Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        Resets per-pipeline status fields (last_run_status, last_run_at). Does not delete run history.
      </Alert>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Button
          color="warning" variant="outlined" startIcon={<Analytics />}
          onClick={() => setConfirm(true)}
        >
          Reset Pipeline Stats
        </Button>
        <Button
          color="error" variant="outlined" startIcon={<Delete />}
          disabled={clearErrorsMutation.isPending}
          onClick={() => clearErrorsMutation.mutate()}
        >
          Clear Error Logs
        </Button>
      </Box>

      <ConfirmDialog
        open={confirm}
        title="Reset pipeline stats?"
        body="This will clear last_run_status and last_run_at for all pipelines. Run history is preserved."
        danger={false}
        onConfirm={() => resetMutation.mutate()}
        onClose={() => setConfirm(false)}
      />
    </Box>
  )
}

// ─── Services section ─────────────────────────────────────────────────────────

const SERVICES: { key: string; label: string; description: string }[] = [
  { key: 'spark:master', label: 'Spark Master', description: 'Resource manager for the Spark cluster' },
  { key: 'spark:worker', label: 'Spark Worker', description: 'Executor nodes for Spark jobs' },
  { key: 'spark:thrift', label: 'Thrift Server', description: 'JDBC/ODBC endpoint over Spark SQL' },
  { key: 'spark:connect', label: 'Spark Connect', description: 'gRPC-based Spark Connect server' },
  { key: 'spark:history', label: 'History Server', description: 'Spark job history UI' },
  { key: 'grpc', label: 'gRPC Service', description: 'Data ingestion gRPC service' },
]

function ServiceCard({ svc }: { svc: typeof SERVICES[0] }) {
  const { enqueueSnackbar } = useSnackbar()
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const restartMutation = useMutation({
    mutationFn: () => adminApi.restartService(svc.key).then((r) => r.data),
    onSuccess: (d) => {
      setResult(d)
      enqueueSnackbar(`${svc.label}: ${d.ok ? 'Restarted' : 'Failed'}`, { variant: d.ok ? 'success' : 'error' })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  return (
    <Card variant="outlined" sx={{ display: 'flex', flexDirection: 'column' }}>
      <CardContent sx={{ pb: 1, flex: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Box>
            <Typography fontWeight={600} gutterBottom>{svc.label}</Typography>
            <Typography variant="caption" color="text.secondary">{svc.description}</Typography>
          </Box>
          {result && (
            result.ok
              ? <CheckCircle fontSize="small" color="success" />
              : <ErrorIcon fontSize="small" color="error" />
          )}
        </Box>
        {result && (
          <Typography variant="caption" sx={{ mt: 1, display: 'block', fontFamily: 'monospace', color: 'text.secondary', maxHeight: 60, overflow: 'hidden' }}>
            {result.message}
          </Typography>
        )}
      </CardContent>
      <CardActions sx={{ pt: 0 }}>
        <Button
          size="small" startIcon={restartMutation.isPending ? <CircularProgress size={14} /> : <RestartAlt />}
          onClick={() => restartMutation.mutate()}
          disabled={restartMutation.isPending}
          color="warning"
        >
          Restart
        </Button>
      </CardActions>
    </Card>
  )
}

function ServicesSection() {
  const { enqueueSnackbar } = useSnackbar()
  const [confirm, setConfirm] = useState(false)

  const restartAllMutation = useMutation({
    mutationFn: () => adminApi.restartService('all').then((r) => r.data),
    onSuccess: (d) => {
      enqueueSnackbar(`All services: ${d.ok ? 'restarted' : 'restart failed'}`, { variant: d.ok ? 'success' : 'error' })
      setConfirm(false)
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h6">Services</Typography>
        <Button
          color="error" variant="outlined" size="small"
          startIcon={restartAllMutation.isPending ? <CircularProgress size={14} /> : <Power />}
          onClick={() => setConfirm(true)}
          disabled={restartAllMutation.isPending}
        >
          Restart All
        </Button>
      </Box>
      <Alert severity="warning" sx={{ mb: 2 }}>
        Restarting services will interrupt any active ETL runs. Use with caution in production.
      </Alert>
      <Grid container spacing={2}>
        {SERVICES.map((svc) => (
          <Grid item xs={12} sm={6} md={4} key={svc.key}>
            <ServiceCard svc={svc} />
          </Grid>
        ))}
      </Grid>

      <ConfirmDialog
        open={confirm}
        title="Restart all services?"
        body="This will restart Spark master, workers, thrift server, Spark Connect, history server, and the gRPC service. Active runs will be interrupted."
        onConfirm={() => restartAllMutation.mutate()}
        onClose={() => setConfirm(false)}
      />
    </Box>
  )
}

// ─── Tabs ──────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'storage', label: 'Storage', icon: <Storage fontSize="small" /> },
  { key: 'runs', label: 'Run History', icon: <PlayArrow fontSize="small" /> },
  { key: 'stats', label: 'Stats', icon: <Analytics fontSize="small" /> },
  { key: 'services', label: 'Services', icon: <Power fontSize="small" /> },
] as const

type TabKey = typeof TABS[number]['key']

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Admin() {
  const [tab, setTab] = useState<TabKey>('storage')
  const theme = useTheme()

  return (
    <Box sx={{ p: 3, maxWidth: 1100, mx: 'auto' }}>
      <Typography variant="h5" fontWeight={700} gutterBottom>
        Admin
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Manage storage, run history, statistics, and platform services.
      </Typography>

      {/* Tab bar */}
      <Box sx={{ display: 'flex', gap: 1, mb: 3, borderBottom: 1, borderColor: 'divider' }}>
        {TABS.map((t) => (
          <Button
            key={t.key}
            startIcon={t.icon}
            onClick={() => setTab(t.key)}
            variant={tab === t.key ? 'contained' : 'text'}
            size="small"
            disableElevation
            sx={{
              borderRadius: '8px 8px 0 0',
              fontWeight: tab === t.key ? 700 : 400,
              mb: '-1px',
              borderBottom: tab === t.key ? `2px solid ${theme.palette.primary.main}` : 'none',
            }}
          >
            {t.label}
          </Button>
        ))}
      </Box>

      {tab === 'storage' && <StorageSection />}
      {tab === 'runs' && <RunsSection />}
      {tab === 'stats' && <StatsSection />}
      {tab === 'services' && <ServicesSection />}
    </Box>
  )
}
