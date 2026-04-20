import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Typography, Button, Chip, IconButton, Dialog, DialogTitle, DialogContent,
  DialogActions, TextField, InputAdornment, CircularProgress, Tooltip, Alert,
  alpha, useTheme, Table, TableHead, TableRow, TableCell, TableBody, LinearProgress,
} from '@mui/material'
import {
  Add, PlayArrow, Search, Refresh, Cancel, ErrorOutlined,
  OpenInNew, ArrowUpward, ArrowDownward, UnfoldMore,
  ExpandMore, ExpandLess, ChevronRight, Close, History,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { pipelinesApi, runsApi, Pipeline, RunDetail, RunStep } from '../api/client'
import { format, parseISO } from 'date-fns'
import RunLogPanel from '../components/RunLogPanel'
import StatusChip, { STATUS_COLOR } from '../components/StatusChip'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(str?: string): string {
  if (!str) return '—'
  try { return format(parseISO(str.endsWith('Z') ? str : str + 'Z'), 'MMM d, HH:mm') } catch { return str }
}

function formatDuration(s?: number): string {
  if (s == null) return '—'
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`
}

// ── Step tree helpers ─────────────────────────────────────────────────────────

interface StepNode {
  step: RunStep
  children: StepNode[]
}

function buildStepTree(steps: RunStep[]): StepNode[] {
  const byId = new Map<number, StepNode>()
  for (const s of steps) byId.set(s.id, { step: s, children: [] })
  const roots: StepNode[] = []
  for (const node of byId.values()) {
    const pid = node.step.parent_step_id
    if (pid != null && byId.has(pid)) {
      byId.get(pid)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  const sort = (nodes: StepNode[]) => {
    nodes.sort((a, b) => a.step.step_order - b.step.step_order)
    nodes.forEach(n => sort(n.children))
  }
  sort(roots)
  return roots
}

/** Derive display status from children — parent reflects collective child status */
function derivedStatus(node: StepNode): string {
  if (node.children.length === 0) return node.step.status
  const cs = node.children.map(derivedStatus)
  if (cs.some(s => s === 'failed')) return 'failed'
  if (cs.some(s => s === 'running' || s === 'pending')) return 'running'
  if (cs.every(s => s === 'completed')) return 'completed'
  if (cs.every(s => s === 'skipped')) return 'skipped'
  return node.step.status
}

const STEP_COLORS: Record<string, string> = {
  extract: '#58a6ff', app: '#e3b341', chunk: '#a371f7',
  load: '#3fb950', filter: '#f0883e', sort: '#f0883e',
  join: '#f0883e', aggregate: '#f0883e', sql_transform: '#f0883e',
}

function StepDot({ status, color }: { status: string; color: string }) {
  if (status === 'running') return <CircularProgress size={10} thickness={4} sx={{ color, flexShrink: 0 }} />
  if (status === 'completed') return <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: '#3fb950', flexShrink: 0 }} />
  if (status === 'failed') return <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: '#f85149', flexShrink: 0 }} />
  if (status === 'cancelled') return <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: '#6e7681', flexShrink: 0 }} />
  return <Box sx={{ width: 9, height: 9, borderRadius: '50%', border: `1.5px solid ${alpha(color, 0.35)}`, flexShrink: 0 }} />
}

/** Count immediate children in a terminal state to derive progress */
function countProgress(node: StepNode): { done: number; total: number } | null {
  if (node.children.length === 0) return null
  const done = node.children.filter(c => {
    const s = derivedStatus(c)
    return s === 'completed' || s === 'failed' || s === 'cancelled' || s === 'skipped'
  }).length
  return { done, total: node.children.length }
}

/**
 * A single drill-down row in the stage accordion.
 * Manages its own open/closed state — no prop drilling needed.
 * Depth 0 = top-level stage (Extract / Transform / Load)
 * Depth 1 = app iteration rows
 * Depth 2 = chunk rows (leaf, no expand)
 */
function StageRow({ node, depth = 0 }: { node: StepNode; depth?: number }) {
  const [open, setOpen] = useState(depth < 2)
  const theme = useTheme()
  const status = derivedStatus(node)
  const prevStatusRef = useRef<string | null>(null)

  // Collapse only when transitioning from an active state to terminal —
  // NOT when already terminal on first render (e.g. viewing history).
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (prev !== null && prev !== status &&
        (status === 'completed' || status === 'failed' || status === 'cancelled')) {
      setOpen(false)
    }
  }, [status])
  const color = STEP_COLORS[node.step.step_type] ?? '#6e7681'
  const barColor = status === 'completed' ? '#58a6ff' : color
  const progress = countProgress(node)
  const hasChildren = node.children.length > 0

  return (
    <>
      <Box
        onClick={hasChildren ? () => setOpen(o => !o) : undefined}
        sx={{
          display: 'flex', alignItems: 'center', gap: 1,
          pl: `${8 + depth * 20}px`, pr: 1.5,
          py: depth === 0 ? 0.75 : 0.5,
          cursor: hasChildren ? 'pointer' : 'default',
          borderTop: `1px solid ${alpha(theme.palette.divider, depth === 0 ? 0.6 : 0.25)}`,
          bgcolor: depth === 1 ? alpha(theme.palette.background.default, 0.5)
                : depth >= 2 ? alpha(theme.palette.background.default, 0.85)
                : 'transparent',
          opacity: status === 'skipped' ? 0.45 : 1,
          '&:hover': hasChildren ? { bgcolor: alpha(theme.palette.action.hover, 0.7) } : {},
        }}>
        {/* Expand chevron */}
        <Box sx={{ width: 14, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {hasChildren && (
            open
              ? <ExpandMore sx={{ fontSize: 14, color: 'text.disabled' }} />
              : <ChevronRight sx={{ fontSize: 14, color: 'text.disabled' }} />
          )}
        </Box>
        <StepDot status={status} color={color} />
        {/* Type badge */}
        <Box component="span" sx={{
          px: 0.5, lineHeight: '14px', borderRadius: 0.5,
          bgcolor: alpha(color, 0.12), color,
          fontSize: '0.55rem', fontFamily: 'monospace', fontWeight: 700, flexShrink: 0,
        }}>
          {node.step.step_type}
        </Box>
        <Typography variant="caption" noWrap sx={{
          flex: 1, minWidth: 0,
          fontSize: depth === 0 ? '0.76rem' : '0.7rem',
          fontWeight: depth === 0 ? 600 : 400,
          color: (status === 'pending' || status === 'skipped') ? 'text.disabled' : 'text.primary',
        }}>
          {node.step.step_label || node.step.step_type}
        </Typography>
        {/* Progress bar — only shown for parent nodes with children */}
        {progress && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexShrink: 0 }}>
            <Box sx={{ width: 72 }}>
              <LinearProgress
                variant={status === 'running' && progress.done === 0 ? 'indeterminate' : 'determinate'}
                value={Math.round((progress.done / progress.total) * 100)}
                sx={{ height: 3, borderRadius: 1.5, bgcolor: alpha(barColor, 0.15), '& .MuiLinearProgress-bar': { bgcolor: barColor } }}
              />
            </Box>
            <Typography variant="caption" sx={{ fontSize: '0.6rem', fontFamily: 'monospace', color: 'text.disabled', minWidth: 26 }}>
              {progress.done}/{progress.total}
            </Typography>
          </Box>
        )}
        {node.step.records_out != null && node.step.records_out > 0 && (
          <Typography variant="caption" sx={{ fontSize: '0.62rem', fontFamily: 'monospace', color: 'text.secondary', minWidth: 60, textAlign: 'right', flexShrink: 0 }}>
            {node.step.records_out.toLocaleString()}
          </Typography>
        )}
        {node.step.duration_seconds != null && (
          <Typography variant="caption" sx={{ fontSize: '0.62rem', color: 'text.disabled', minWidth: 38, textAlign: 'right', flexShrink: 0 }}>
            {formatDuration(node.step.duration_seconds)}
          </Typography>
        )}
        {node.step.error_message && (
          <Tooltip title={node.step.error_message}>
            <ErrorOutlined sx={{ fontSize: 12, color: 'error.main', flexShrink: 0 }} />
          </Tooltip>
        )}
      </Box>
      {open && node.children.map(child => (
        <StageRow key={child.step.id} node={child} depth={depth + 1} />
      ))}
    </>
  )
}

// ── Inline Run Monitor ────────────────────────────────────────────────────────
// Compact "flight strip" always visible for active runs.
// Stage dots show live status at a glance. Expand to drill into stages → apps → chunks.

function InlineRunMonitor({ runId, pipelineId, onClose, onDone }: {
  runId: number; pipelineId: number; onClose: () => void; onDone?: () => void
}) {
  const [detailsOpen, setDetailsOpen] = useState(true)
  const theme = useTheme()
  const qc = useQueryClient()
  const terminal = ['completed', 'failed', 'cancelled']

  const { data: run } = useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: () => runsApi.get(runId),
    refetchInterval: r => {
      const status = (r.state.data as RunDetail | undefined)?.status
      return status && terminal.includes(status) ? false : 2000
    },
  })

  const cancelMut = useMutation({
    mutationFn: () => runsApi.cancel(runId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run', runId] }),
  })

  const rerunMut = useMutation({
    mutationFn: () => pipelinesApi.run(pipelineId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pipelines'] }); onDone?.() },
  })

  const isTerminal = run ? terminal.includes(run.status) : false
  const isRunning = run?.status === 'running' || run?.status === 'pending'
  const roots = run?.steps ? buildStepTree(run.steps) : []

  return (
    <Box sx={{ borderTop: `2px solid ${alpha('#58a6ff', 0.25)}`, bgcolor: alpha(theme.palette.background.paper, 0.65) }}>

      {/* ── Compact strip — always visible ── */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.75, minHeight: 42 }}>

        {/* Stage flow dots — one per top-level step (Extract → Transform → Load) */}
        {roots.length > 0 ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4, flexShrink: 0 }}>
            {roots.map((node, i) => {
              const s = derivedStatus(node)
              const c = STEP_COLORS[node.step.step_type] ?? '#6e7681'
              return (
                <Box key={node.step.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
                  <Tooltip title={`${node.step.step_label || node.step.step_type}: ${s}`} arrow>
                    <Box sx={{ display: 'flex' }}><StepDot status={s} color={c} /></Box>
                  </Tooltip>
                  {i < roots.length - 1 && (
                    <Box sx={{ width: 8, height: 1, bgcolor: alpha(theme.palette.divider, 1.5) }} />
                  )}
                </Box>
              )
            })}
          </Box>
        ) : (
          <CircularProgress size={12} />
        )}

        {/* Divider */}
        <Box sx={{ width: 1, height: 18, bgcolor: theme.palette.divider, flexShrink: 0, mx: 0.25 }} />

        {/* Status + duration */}
        {run && <StatusChip status={run.status} />}
        {run?.duration_seconds != null && (
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: '0.72rem' }}>
            {formatDuration(run.duration_seconds)}
          </Typography>
        )}

        {/* Live indeterminate bar stretches across the middle while running */}
        {isRunning ? (
          <Box sx={{ flex: 1, mx: 0.5 }}>
            <LinearProgress sx={{ height: 2, borderRadius: 1, bgcolor: alpha('#58a6ff', 0.1), '& .MuiLinearProgress-bar': { bgcolor: '#58a6ff' } }} />
          </Box>
        ) : <Box sx={{ flex: 1 }} />}

        {/* Row count summary */}
        {run?.records_extracted != null && run.records_extracted > 0 && (
          <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.65rem', fontFamily: 'monospace', flexShrink: 0 }}>
            {run.records_extracted.toLocaleString()} rows
          </Typography>
        )}

        {isRunning && (
          <Button size="small" color="error" sx={{ py: 0.3, px: 1, fontSize: '0.7rem', minWidth: 0, flexShrink: 0 }}
            onClick={() => cancelMut.mutate()}>
            Cancel
          </Button>
        )}
        {isTerminal && (
          <Button size="small" sx={{ py: 0.3, px: 1, fontSize: '0.7rem', minWidth: 0, flexShrink: 0 }}
            onClick={() => rerunMut.mutate()} disabled={rerunMut.isPending}>
            Re-run
          </Button>
        )}

        {/* Expand / collapse detail accordion */}
        <Tooltip title={detailsOpen ? 'Hide steps' : 'Drill into steps'}>
          <IconButton size="small" onClick={() => setDetailsOpen(o => !o)} sx={{ p: 0.3, flexShrink: 0 }}>
            {detailsOpen ? <ExpandLess sx={{ fontSize: 16 }} /> : <ExpandMore sx={{ fontSize: 16 }} />}
          </IconButton>
        </Tooltip>

        {/* Dismiss strip */}
        <Tooltip title="Dismiss">
          <IconButton size="small" onClick={onClose} sx={{ p: 0.3, flexShrink: 0 }}>
            <Close sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* ── Stage accordion — only rendered when user expands ── */}
      {detailsOpen && roots.length > 0 && (
        <Box sx={{ borderTop: `1px solid ${alpha(theme.palette.divider, 0.5)}` }}>
          {roots.map(node => <StageRow key={node.step.id} node={node} />)}
        </Box>
      )}

      {run?.error_message && (
        <Alert severity="error" sx={{ mx: 2, mb: 1, mt: 0.5, fontSize: '0.8rem' }}>
          {run.error_message}
        </Alert>
      )}

      {/* ── Log panel ── */}
      <RunLogPanel logs={run?.logs ?? []} live={isRunning} defaultHeight={180} />
    </Box>
  )
}

// ── Quick-create dialog ───────────────────────────────────────────────────────

function QuickCreateDialog({ open, onClose, onCreate }: {
  open: boolean; onClose: () => void; onCreate: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function handleCreate() {
    if (!name.trim()) { setErr('Name is required'); return }
    setSaving(true)
    try { await onCreate(name.trim()); setName(''); setErr(''); onClose() }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Failed to create'); setSaving(false) }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>New Pipeline</DialogTitle>
      <DialogContent sx={{ pt: '16px !important' }}>
        {err && <Alert severity="error" sx={{ mb: 1.5 }}>{err}</Alert>}
        <TextField label="Pipeline name" value={name} onChange={e => { setName(e.target.value); setErr('') }}
          fullWidth size="small" autoFocus onKeyDown={e => e.key === 'Enter' && handleCreate()}
          helperText="You'll configure the pipeline in the visual editor" />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleCreate} disabled={saving || !name.trim()}
          startIcon={saving ? <CircularProgress size={14} /> : <OpenInNew sx={{ fontSize: 16 }} />}>
          Create &amp; Open
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ── Sortable column header ────────────────────────────────────────────────────

type SortField = 'name' | 'status' | 'last_run' | 'nodes'
type SortDir = 'asc' | 'desc'

function SortHeader({ field, label, current, dir, onSort }: {
  field: SortField; label: string; current: SortField; dir: SortDir; onSort: (f: SortField) => void
}) {
  const active = current === field
  return (
    <TableCell onClick={() => onSort(field)}
      sx={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', '&:hover': { color: 'primary.main' } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        {label}
        {active
          ? dir === 'asc' ? <ArrowUpward sx={{ fontSize: 14 }} /> : <ArrowDownward sx={{ fontSize: 14 }} />
          : <UnfoldMore sx={{ fontSize: 14, opacity: 0.3 }} />}
      </Box>
    </TableCell>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Pipelines() {
  const theme = useTheme()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [newOpen, setNewOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Pipeline | null>(null)
  const [runningMap, setRunningMap] = useState<Record<number, number>>({}) // pipelineId → runId
  const [expandedPipelines, setExpandedPipelines] = useState<Set<number>>(new Set())
  const initializedRef = useRef(false)
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const { data: pipelines = [], isLoading } = useQuery({
    queryKey: ['pipelines'],
    queryFn: pipelinesApi.list,
    refetchInterval: () => Object.keys(runningMap).length > 0 ? 3000 : 30_000,
  })

  // Auto-expand panels for runs that are already in-progress on first load
  useEffect(() => {
    if (!initializedRef.current && pipelines.length > 0) {
      initializedRef.current = true
      const running = pipelines
        .filter(p => ['running', 'pending'].includes(p.last_run?.status ?? ''))
        .map(p => p.id)
      if (running.length > 0)
        setExpandedPipelines(s => new Set([...s, ...running]))
    }
  }, [pipelines])

  const createMut = useMutation({
    mutationFn: (name: string) => pipelinesApi.create({ name, status: 'draft', source_type: 'datawarehouse', load_target: 'parquet' }),
    onSuccess: (pipeline) => { qc.invalidateQueries({ queryKey: ['pipelines'] }); navigate(`/pipelines/${pipeline.id}/edit`) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => pipelinesApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pipelines'] }); setDeleteTarget(null) },
  })

  const runMut = useMutation({
    mutationFn: (id: number) => pipelinesApi.run(id),
    onSuccess: (run, pipelineId) => {
      setRunningMap(m => ({ ...m, [pipelineId]: run.id }))
      setExpandedPipelines(s => new Set([...s, pipelineId]))
      qc.invalidateQueries({ queryKey: ['pipelines'] })
    },
  })

  const cancelRowMut = useMutation({
    mutationFn: (runId: number) => runsApi.cancel(runId),
    onSuccess: (_, runId) => {
      qc.invalidateQueries({ queryKey: ['pipelines'] })
      qc.invalidateQueries({ queryKey: ['run', runId] })
      qc.invalidateQueries({ queryKey: ['run-detail', runId] })
      qc.invalidateQueries({ queryKey: ['runs'] })
    },
  })

  function handleSort(field: SortField) {
    if (field === sortField) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
  }

  const filtered = pipelines
    .filter(p => {
      const ms = !search || p.name.toLowerCase().includes(search.toLowerCase())
      const mf = statusFilter === 'all' || p.status === statusFilter
      return ms && mf
    })
    .sort((a, b) => {
      let cmp = 0
      if (sortField === 'name') cmp = a.name.localeCompare(b.name)
      else if (sortField === 'status') cmp = a.status.localeCompare(b.status)
      else if (sortField === 'last_run') {
        const da = a.last_run?.started_at ?? ''; const db2 = b.last_run?.started_at ?? ''
        cmp = da < db2 ? -1 : da > db2 ? 1 : 0
      } else if (sortField === 'nodes') {
        cmp = ((a.canvas_config?.nodes as unknown[])?.length ?? 0) - ((b.canvas_config?.nodes as unknown[])?.length ?? 0)
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 3, gap: 2 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>Pipelines</Typography>
          <Typography variant="body2" color="text.secondary">Build and run visual ETL pipelines</Typography>
        </Box>
        <Button variant="contained" startIcon={<Add />} onClick={() => setNewOpen(true)}>New Pipeline</Button>
      </Box>

      <Box sx={{ display: 'flex', gap: 2, mb: 2.5, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField placeholder="Search pipelines…" value={search} onChange={e => setSearch(e.target.value)}
          size="small" sx={{ width: 240 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> }} />
        <Box sx={{ display: 'flex', gap: 1 }}>
          {['all', 'active', 'inactive', 'draft'].map(s => (
            <Chip key={s} label={s.charAt(0).toUpperCase() + s.slice(1)}
              onClick={() => setStatusFilter(s)}
              variant={statusFilter === s ? 'filled' : 'outlined'}
              color={statusFilter === s ? 'primary' : 'default'} size="small" />
          ))}
        </Box>
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={() => qc.invalidateQueries({ queryKey: ['pipelines'] })}>
            <Refresh fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>
      ) : (
        <Box sx={{ bgcolor: 'background.paper', borderRadius: 2, border: `1px solid ${theme.palette.divider}`, overflow: 'hidden' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <SortHeader field="name" label="Name" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortHeader field="status" label="Status" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortHeader field="nodes" label="Nodes" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortHeader field="last_run" label="Last Run" current={sortField} dir={sortDir} onSort={handleSort} />
                <TableCell>Last Status</TableCell>
                <TableCell>Duration</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map(pipeline => {
                const nodeCount = (pipeline.canvas_config?.nodes as unknown[])?.length ?? 0
                const sc = STATUS_COLOR[pipeline.status] ?? '#6e7681'
                const lrStatus = pipeline.last_run?.status
                const inProgressId = pipeline.last_run?.id && ['running', 'pending'].includes(pipeline.last_run.status ?? '')
                  ? pipeline.last_run.id : undefined
                const activeRunId = runningMap[pipeline.id] ?? inProgressId
                // Stop the spinner as soon as the pipeline query shows this run is terminal
                const activeRunDone = activeRunId != null &&
                  pipeline.last_run?.id === activeRunId &&
                  ['completed', 'failed', 'cancelled'].includes(pipeline.last_run?.status ?? '')
                const isRunningNow = !!activeRunId && !activeRunDone
                const isPanelOpen = expandedPipelines.has(pipeline.id)

                return (
                  <TableRow key={pipeline.id} hover sx={{ borderLeft: `3px solid ${sc}` }}>
                    <TableCell>
                      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                        <Typography variant="body2" fontWeight={600}
                          sx={{ cursor: 'pointer', '&:hover': { color: 'primary.main' } }}
                          onClick={() => navigate(`/pipelines/${pipeline.id}/edit`)}>
                          {pipeline.name}
                        </Typography>
                        {pipeline.description && (
                          <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 280 }}>
                            {pipeline.description}
                          </Typography>
                        )}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <StatusChip status={pipeline.status} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {nodeCount > 0 ? `${nodeCount}` : '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">{formatDate(pipeline.last_run?.started_at)}</Typography>
                    </TableCell>
                    <TableCell>
                      {lrStatus
                        ? <StatusChip status={lrStatus} />
                        : <Typography variant="caption" color="text.disabled">—</Typography>}
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">{formatDuration(pipeline.last_run?.duration_seconds)}</Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'flex-end' }}>
                        <Tooltip title="Open Editor">
                          <IconButton size="small" onClick={() => navigate(`/pipelines/${pipeline.id}/edit`)}>
                            <OpenInNew sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Run pipeline">
                          <span>
                            <IconButton size="small" color="success"
                              onClick={() => runMut.mutate(pipeline.id)}
                              disabled={isRunningNow || runMut.isPending}>
                              {isRunningNow
                                ? <CircularProgress size={14} color="inherit" />
                                : <PlayArrow sx={{ fontSize: 16 }} />}
                            </IconButton>
                          </span>
                        </Tooltip>
                        {isRunningNow && activeRunId && (
                          <Tooltip title="Cancel run">
                            <span>
                              <IconButton size="small" color="error"
                                onClick={() => cancelRowMut.mutate(activeRunId)}
                                disabled={cancelRowMut.isPending}>
                                <Cancel sx={{ fontSize: 16 }} />
                              </IconButton>
                            </span>
                          </Tooltip>
                        )}
                        {pipeline.last_run?.id && (
                          <Tooltip title={isPanelOpen ? 'Close run detail' : 'View last run'}>
                            <IconButton size="small"
                              onClick={() => setExpandedPipelines(s => {
                                const n = new Set(s)
                                if (n.has(pipeline.id)) n.delete(pipeline.id)
                                else n.add(pipeline.id)
                                return n
                              })}
                              sx={{ transition: 'transform 0.2s', transform: isPanelOpen ? 'rotate(180deg)' : 'none' }}>
                              <ExpandMore sx={{ fontSize: 16 }} />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Box>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                    {pipelines.length === 0 ? 'No pipelines yet — create your first one' : 'No pipelines match your filters'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      )}

      {/* ── Run monitors — one panel per expanded pipeline ── */}
      {filtered.map(pipeline => {
        const panelRunId = runningMap[pipeline.id] ?? pipeline.last_run?.id
        if (!panelRunId || !expandedPipelines.has(pipeline.id)) return null
        const closePanel = () => setExpandedPipelines(s => { const n = new Set(s); n.delete(pipeline.id); return n })
        return (
          <Box key={`monitor-${pipeline.id}`} sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ px: 1, fontWeight: 600 }}>
              {pipeline.name}
            </Typography>
            <InlineRunMonitor runId={panelRunId} pipelineId={pipeline.id}
              onClose={closePanel}
              onDone={closePanel} />
          </Box>
        )
      })}

      <QuickCreateDialog open={newOpen} onClose={() => setNewOpen(false)}
        onCreate={async name => { await createMut.mutateAsync(name) }} />

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} maxWidth="xs">
        <DialogTitle>Delete Pipeline</DialogTitle>
        <DialogContent>
          <Typography>Permanently delete <strong>{deleteTarget?.name}</strong>? This cannot be undone.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={deleteMut.isPending}
            onClick={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}>
            {deleteMut.isPending ? <CircularProgress size={16} /> : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
