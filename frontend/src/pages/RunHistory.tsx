import { useState, useEffect, useRef } from 'react'
import {
  Box, Typography, Table, TableHead, TableRow, TableCell, TableBody,
  Chip, TextField, MenuItem, Button, CircularProgress, Collapse,
  Alert, IconButton, Tooltip, alpha, useTheme,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material'
import {
  ExpandMore, ExpandLess, ChevronRight, Cancel, PlayArrow, Refresh, Delete,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { runsApi, pipelinesApi, RunSummary, RunDetail, RunStep } from '../api/client'
import { format, parseISO } from 'date-fns'
import RunLogPanel from '../components/RunLogPanel'
import StatusChip from '../components/StatusChip'

// ── Step tree helpers (mirrors Pipelines.tsx InlineRunMonitor) ────────────────

interface StepNode { step: RunStep; children: StepNode[] }

function buildStepTree(steps: RunStep[]): StepNode[] {
  const byId = new Map<number, StepNode>()
  for (const s of steps) byId.set(s.id, { step: s, children: [] })
  const roots: StepNode[] = []
  for (const node of byId.values()) {
    const pid = node.step.parent_step_id
    if (pid != null && byId.has(pid)) byId.get(pid)!.children.push(node)
    else roots.push(node)
  }
  const sort = (ns: StepNode[]) => { ns.sort((a, b) => a.step.step_order - b.step.step_order); ns.forEach(n => sort(n.children)) }
  sort(roots)
  return roots
}

function derivedStatus(node: StepNode): string {
  if (node.children.length === 0) return node.step.status
  const cs = node.children.map(derivedStatus)
  if (cs.some(s => s === 'failed')) return 'failed'
  if (cs.some(s => s === 'running' || s === 'pending')) return 'running'
  if (cs.every(s => s === 'completed')) return 'completed'
  return node.step.status
}

const STEP_COLORS: Record<string, string> = {
  extract: '#58a6ff', app: '#e3b341', chunk: '#a371f7',
  load: '#3fb950', filter: '#f0883e', sort: '#f0883e',
  join: '#f0883e', aggregate: '#f0883e', sql_transform: '#f0883e',
}

function StepDot({ status, color }: { status: string; color: string }) {
  const size = 9
  if (status === 'running') return <CircularProgress size={size + 1} thickness={4} sx={{ color, flexShrink: 0 }} />
  const bg = status === 'completed' ? '#3fb950' : status === 'failed' ? '#f85149' : status === 'cancelled' ? '#6e7681' : undefined
  return <Box sx={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, bgcolor: bg, border: bg ? undefined : `1.5px solid ${alpha(color, 0.4)}` }} />
}

function StepTreeRow({ node, depth = 0 }: { node: StepNode; depth?: number }) {
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
  const hasChildren = node.children.length > 0
  const done = node.children.filter(c => ['completed','failed','cancelled'].includes(derivedStatus(c))).length

  return (
    <>
      <Box
        onClick={hasChildren ? () => setOpen(o => !o) : undefined}
        sx={{
          display: 'flex', alignItems: 'center', gap: 1,
          pl: `${8 + depth * 20}px`, pr: 1.5,
          py: depth === 0 ? 0.75 : 0.5,
          cursor: hasChildren ? 'pointer' : 'default',
          borderTop: `1px solid ${alpha(theme.palette.divider, depth === 0 ? 0.6 : 0.2)}`,
          bgcolor: depth === 1 ? alpha(theme.palette.background.default, 0.5)
                : depth >= 2 ? alpha(theme.palette.background.default, 0.85)
                : 'transparent',
          '&:hover': hasChildren ? { bgcolor: alpha(theme.palette.action.hover, 0.7) } : {},
        }}>
        <Box sx={{ width: 14, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {hasChildren && (open
            ? <ExpandMore sx={{ fontSize: 14, color: 'text.disabled' }} />
            : <ChevronRight sx={{ fontSize: 14, color: 'text.disabled' }} />)}
        </Box>
        <StepDot status={status} color={color} />
        <Box component="span" sx={{
          fontSize: '0.62rem', fontWeight: 700, px: 0.75, py: 0.15,
          borderRadius: 0.5, bgcolor: alpha(color, 0.15), color,
          textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0,
        }}>
          {node.step.step_type}
        </Box>
        {node.step.step_label && (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {node.step.step_label}
          </Typography>
        )}
        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1.5, flexShrink: 0 }}>
          {hasChildren && node.children.length > 0 && (
            <Typography variant="caption" color="text.disabled">
              {done}/{node.children.length}
            </Typography>
          )}
          {node.step.records_out != null && (
            <Typography variant="caption" color="text.secondary">
              {node.step.records_out.toLocaleString()} rows
            </Typography>
          )}
          {node.step.duration_seconds != null && (
            <Typography variant="caption" color="text.disabled" sx={{ minWidth: 36, textAlign: 'right' }}>
              {node.step.duration_seconds < 60
                ? `${node.step.duration_seconds.toFixed(1)}s`
                : `${Math.floor(node.step.duration_seconds / 60)}m${(node.step.duration_seconds % 60).toFixed(0)}s`}
            </Typography>
          )}
          <StatusChip status={status} />
        </Box>
      </Box>
      {hasChildren && open && node.children.map(child => (
        <StepTreeRow key={child.step.id} node={child} depth={depth + 1} />
      ))}
    </>
  )
}

function formatDuration(seconds?: number): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`
}

function formatDate(str?: string): string {
  if (!str) return '—'
  try { return format(parseISO(str.endsWith('Z') ? str : str + 'Z'), 'MMM d, HH:mm:ss') } catch { return str }
}

function RunDetailPanel({ runId }: { runId: number }) {
  const theme = useTheme()
  const qc = useQueryClient()
  const terminal = ['completed', 'failed', 'cancelled']

  const { data: run, isLoading } = useQuery<RunDetail>({
    queryKey: ['run-detail', runId],
    queryFn: () => runsApi.get(runId),
    refetchInterval: r => {
      const status = (r.state.data as RunDetail | undefined)?.status
      return status && terminal.includes(status) ? false : 3000
    },
  })

  const cancelMut = useMutation({
    mutationFn: () => runsApi.cancel(runId),
    onSuccess: () => {
      // Invalidate all views that show this run so every page updates immediately
      qc.invalidateQueries({ queryKey: ['run-detail', runId] })
      qc.invalidateQueries({ queryKey: ['run', runId] })
      qc.invalidateQueries({ queryKey: ['pipelines'] })
      qc.invalidateQueries({ queryKey: ['runs'] })
    },
  })

  if (isLoading) return <Box sx={{ p: 2 }}><CircularProgress size={20} /></Box>
  if (!run) return null

  const isRunning = run.status === 'running' || run.status === 'pending'

  return (
    <Box sx={{ p: 2, bgcolor: alpha(theme.palette.background.paper, 0.5) }}>
      <Box sx={{ display: 'flex', gap: 2, mb: 2, alignItems: 'center' }}>
        <StatusChip status={run.status} />
        <Typography variant="caption" color="text.secondary">Duration: {formatDuration(run.duration_seconds)}</Typography>
        {run.records_extracted != null && <Typography variant="caption" color="text.secondary">Extracted: {run.records_extracted.toLocaleString()}</Typography>}
        {run.records_loaded != null && <Typography variant="caption" color="text.secondary">Loaded: {run.records_loaded.toLocaleString()}</Typography>}
        <Box sx={{ flex: 1 }} />
        {isRunning && (
          <Button size="small" color="error" startIcon={<Cancel />} onClick={() => cancelMut.mutate()}>
            Cancel
          </Button>
        )}
      </Box>

      {/* Steps — hierarchical tree */}
      {run.steps.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="caption" fontWeight={700} color="text.secondary" textTransform="uppercase" letterSpacing="0.08em" display="block" mb={0.5}>
            Steps
          </Typography>
          <Box sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: 1, overflow: 'hidden' }}>
            {buildStepTree(run.steps).map(node => (
              <StepTreeRow key={node.step.id} node={node} depth={0} />
            ))}
          </Box>
        </Box>
      )}

      {run.error_message && (
        <Alert severity="error" sx={{ mb: 2 }}>{run.error_message}</Alert>
      )}

      {/* Logs */}
      <RunLogPanel logs={run.logs} live={isRunning} defaultHeight={220} />
    </Box>
  )
}

export default function RunHistory() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [pipelineFilter, setPipelineFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [clearConfirm, setClearConfirm] = useState(false)

  const { data: runs = [], isLoading } = useQuery({
    queryKey: ['all-runs'],
    queryFn: runsApi.list,
    refetchInterval: query => {
      const active = ((query.state.data as RunSummary[] | undefined) ?? []).some(
        r => r.status === 'running' || r.status === 'pending'
      )
      return active ? 3000 : 30_000
    },
  })

  // Auto-expand the most recent active run
  useEffect(() => {
    const active = runs.find(r => r.status === 'running' || r.status === 'pending')
    if (active && expandedId === null) setExpandedId(active.id)
  }, [runs])

  const { data: pipelines = [] } = useQuery({
    queryKey: ['pipelines'],
    queryFn: pipelinesApi.list,
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => runsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['all-runs'] }),
  })

  const clearMut = useMutation({
    mutationFn: () => runsApi.clearAll(pipelineFilter ? Number(pipelineFilter) : undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['all-runs'] })
      setClearConfirm(false)
    },
  })

  const STATUSES = ['', 'running', 'pending', 'completed', 'failed', 'cancelled']

  const filtered = runs.filter(run => {
    const matchStatus = !statusFilter || run.status === statusFilter
    const matchPipeline = !pipelineFilter || String((run as RunSummary & { pipeline_id?: number }).pipeline_id) === pipelineFilter
    return matchStatus && matchPipeline
  })

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 3 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>Run History</Typography>
          <Typography variant="body2" color="text.secondary">Monitor all pipeline executions</Typography>
        </Box>
        <IconButton onClick={() => qc.invalidateQueries({ queryKey: ['all-runs'] })}>
          <Refresh fontSize="small" />
        </IconButton>
        <Tooltip title="Delete all non-active runs">
          <Button
            size="small" color="error" startIcon={<Delete />}
            onClick={() => setClearConfirm(true)}
            sx={{ ml: 1 }}
          >
            Clear History
          </Button>
        </Tooltip>
      </Box>

      {/* Filters */}
      <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <TextField
          select label="Pipeline" value={pipelineFilter}
          onChange={e => setPipelineFilter(e.target.value)}
          size="small" sx={{ width: 200 }}
        >
          <MenuItem value="">All Pipelines</MenuItem>
          {pipelines.map(p => <MenuItem key={p.id} value={String(p.id)}>{p.name}</MenuItem>)}
        </TextField>
        <TextField
          select label="Status" value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          size="small" sx={{ width: 160 }}
        >
          {STATUSES.map(s => <MenuItem key={s} value={s}>{s || 'All'}</MenuItem>)}
        </TextField>
      </Box>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>
      ) : (
        <Box sx={{ bgcolor: 'background.paper', borderRadius: 2, border: `1px solid ${theme.palette.divider}`, overflow: 'hidden' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell width={40} />
                <TableCell>Run ID</TableCell>
                <TableCell>Pipeline</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Started</TableCell>
                <TableCell>Duration</TableCell>
                <TableCell>Extracted</TableCell>
                <TableCell>Loaded</TableCell>
                <TableCell>Error</TableCell>
                <TableCell width={48} />
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map(run => {
                const extended = run as RunSummary & { pipeline_id?: number }
                const pipeline = pipelines.find(p => p.id === extended.pipeline_id)
                const expanded = expandedId === run.id
                return [
                  <TableRow key={run.id} hover sx={{ cursor: 'pointer' }}>
                    <TableCell>
                      <IconButton size="small" onClick={() => setExpandedId(expanded ? null : run.id)}>
                        {expanded ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
                      </IconButton>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace">#{run.id}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>
                        {pipeline?.name ?? `Pipeline ${extended.pipeline_id}`}
                      </Typography>
                    </TableCell>
                    <TableCell><StatusChip status={run.status} /></TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {formatDate(run.started_at)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {formatDuration(run.duration_seconds)}
                      </Typography>
                    </TableCell>
                    <TableCell>{run.records_extracted?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell>{run.records_loaded?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell sx={{ maxWidth: 180 }}>
                      {run.error_message && (
                        <Tooltip title={run.error_message}>
                          <Typography variant="caption" color="error" noWrap sx={{ display: 'block', maxWidth: 180 }}>
                            {run.error_message}
                          </Typography>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>
                      {run.status !== 'running' && run.status !== 'pending' && (
                        <Tooltip title="Delete run">
                          <IconButton
                            size="small"
                            onClick={e => { e.stopPropagation(); deleteMut.mutate(run.id) }}
                            disabled={deleteMut.isPending}
                          >
                            <Delete sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>,
                  <TableRow key={`${run.id}-detail`}>
                    <TableCell colSpan={10} sx={{ p: 0, border: 0 }}>
                      <Collapse in={expanded} unmountOnExit>
                        <RunDetailPanel runId={run.id} />
                      </Collapse>
                    </TableCell>
                  </TableRow>,
                ]
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No runs found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      )}

      {/* Clear history confirm */}
      <Dialog open={clearConfirm} onClose={() => setClearConfirm(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Clear Run History</DialogTitle>
        <DialogContent>
          <Typography>
            {pipelineFilter
              ? 'Delete all completed, failed, and cancelled runs for the selected pipeline?'
              : 'Delete all completed, failed, and cancelled runs? Active runs will not be affected.'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClearConfirm(false)}>Cancel</Button>
          <Button variant="contained" color="error" disabled={clearMut.isPending} onClick={() => clearMut.mutate()}>
            Clear History
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
