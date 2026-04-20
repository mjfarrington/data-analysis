import { useState, useMemo, useCallback } from 'react'
import {
  Box, Typography, Button, Card, Table, TableHead, TableBody, TableRow, TableCell,
  IconButton, Tooltip, Chip, CircularProgress, alpha, Collapse, TextField,
  InputAdornment, Select, MenuItem, FormControl, InputLabel, Divider, LinearProgress,
} from '@mui/material'
import {
  Add, PlayArrow, Cancel, Refresh, Search, ExpandMore, ExpandLess,
  Storage, Code, Dataset, Edit, OpenInNew, ErrorOutline, CheckCircle,
  Timer, ArrowDownward, Segment as SegmentIcon,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import { formatDistanceToNow, differenceInSeconds } from 'date-fns'
import { parseApiDate } from '../utils/dates'
import { pipelinesApi, graphApi, runsApi, Pipeline, RunDetail, RunStep, GraphNode } from '../api/client'
import StatusChip from '../components/StatusChip'
import ExecutionContextBar from '../components/ExecutionContextBar'
import { useNavigate } from 'react-router-dom'

// ─── Constants ────────────────────────────────────────────────────────────────

const MONO = '"JetBrains Mono", "Fira Code", monospace'

const SOURCE_ICON: Record<string, React.ReactNode> = {
  grpc: <Code sx={{ fontSize: 14 }} />,
  jdbc: <Storage sx={{ fontSize: 14 }} />,
  datawarehouse: <Dataset sx={{ fontSize: 14 }} />,
}
const SOURCE_LABEL: Record<string, string> = {
  grpc: 'gRPC', jdbc: 'JDBC', datawarehouse: 'Data Warehouse',
}

const STEP_META: Record<string, { label: string; color: string }> = {
  extract:   { label: 'E', color: '#3b82f6' },
  transform: { label: 'T', color: '#8b5cf6' },
  load:      { label: 'L', color: '#10b981' },
}

const STATUS_COLOUR: Record<string, string> = {
  pending: '#fbbf24', running: '#f59e0b', completed: '#22c55e',
  failed: '#ef4444', cancelled: '#6b7280', skipped: '#334155',
}

function formatElapsed(secs: number) {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60), s = secs % 60
  if (m < 60) return `${m}m ${s}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// ─── Step status pills ────────────────────────────────────────────────────────

function StepPips({ statuses }: { statuses: Record<string, string> }) {
  return (
    <Box sx={{ display: 'flex', gap: 0.4, alignItems: 'center' }}>
      {['extract', 'transform', 'load'].map((s) => {
        const st = statuses[s]
        const color = st ? (STATUS_COLOUR[st] ?? '#475569') : '#1e293b'
        return (
          <Tooltip key={s} title={`${s}: ${st ?? 'no data'}`}>
            <Box sx={{
              width: 20, height: 20, borderRadius: 0.75,
              bgcolor: st ? alpha(color, 0.18) : '#1a2236',
              border: `1px solid ${st ? alpha(color, 0.5) : '#2a3550'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Typography sx={{ fontSize: '0.58rem', fontWeight: 700, color: st ? color : '#475569', fontFamily: MONO }}>
                {STEP_META[s].label}
              </Typography>
            </Box>
          </Tooltip>
        )
      })}
    </Box>
  )
}

// ─── Inline run step table ────────────────────────────────────────────────────

function RunStepTable({ steps }: { steps: RunStep[] }) {
  const sorted = [...steps].sort((a, b) => a.step_order - b.step_order)
  return (
    <Table size="small">
      <TableHead>
        <TableRow sx={{ '& th': { fontSize: '0.62rem', color: 'text.disabled', py: 0.4, borderColor: alpha('#ffffff', 0.05) } }}>
          <TableCell>Step</TableCell>
          <TableCell>Status</TableCell>
          <TableCell align="right">Records In</TableCell>
          <TableCell align="right">Records Out</TableCell>
          <TableCell align="right">Duration</TableCell>
          <TableCell>Error</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {sorted.map((step) => {
          const meta = STEP_META[step.step_type] ?? { label: step.step_type, color: '#64748b' }
          const statusColor = STATUS_COLOUR[step.status] ?? '#64748b'
          const isRunning = step.status === 'running'
          const dur = step.started_at && step.finished_at
            ? differenceInSeconds(parseApiDate(step.finished_at), parseApiDate(step.started_at))
            : null
          return (
            <TableRow key={step.id} sx={{ '& td': { py: 0.5, borderColor: alpha('#ffffff', 0.04) } }}>
              <TableCell>
                <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: meta.color, fontFamily: MONO }}>
                  {step.step_type}
                </Typography>
              </TableCell>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  {isRunning && <CircularProgress size={10} sx={{ color: statusColor }} />}
                  <Typography sx={{ fontFamily: MONO, fontSize: '0.72rem', color: statusColor, fontWeight: 600 }}>
                    {step.status}
                  </Typography>
                </Box>
              </TableCell>
              <TableCell align="right" sx={{ fontFamily: MONO, fontSize: '0.72rem', color: 'text.secondary' }}>
                {step.records_in > 0 ? step.records_in.toLocaleString() : '—'}
              </TableCell>
              <TableCell align="right" sx={{ fontFamily: MONO, fontSize: '0.72rem', fontWeight: step.records_out > 0 ? 600 : 400 }}>
                {step.records_out > 0 ? step.records_out.toLocaleString() : '—'}
              </TableCell>
              <TableCell align="right" sx={{ fontFamily: MONO, fontSize: '0.72rem', color: 'text.disabled' }}>
                {dur !== null ? formatElapsed(dur) : isRunning ? '…' : '—'}
              </TableCell>
              <TableCell sx={{ maxWidth: 200 }}>
                {step.error_message && (
                  <Tooltip title={step.error_message}>
                    <Typography sx={{ fontSize: '0.65rem', color: 'error.main',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {step.error_message}
                    </Typography>
                  </Tooltip>
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

// ─── Inline run monitor ───────────────────────────────────────────────────────

function InlineRunMonitor({ runId, pipelineId }: { runId: number; pipelineId: number }) {
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()

  const { data: run, isLoading } = useQuery<RunDetail>({
    queryKey: ['run-detail', runId],
    queryFn: () => runsApi.get(runId).then((r) => r.data),
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === 'running' || s === 'pending' ? 1500 : false
    },
  })

  const cancelMutation = useMutation({
    mutationFn: () => runsApi.cancel(runId),
    onSuccess: () => {
      enqueueSnackbar(`Run #${runId} cancelled`, { variant: 'info' })
      qc.invalidateQueries({ queryKey: ['pipelines'] })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const rerunMutation = useMutation({
    mutationFn: () => pipelinesApi.run(pipelineId),
    onSuccess: (r) => {
      enqueueSnackbar(`New run #${r.data.id} triggered`, { variant: 'success' })
      qc.invalidateQueries({ queryKey: ['pipelines'] })
      qc.invalidateQueries({ queryKey: ['graph'] })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 1.5, pl: 2, color: 'text.disabled' }}>
        <CircularProgress size={14} color="inherit" />
        <Typography sx={{ fontSize: '0.78rem' }}>Loading run details…</Typography>
      </Box>
    )
  }

  if (!run) return null

  const isActive = run.status === 'running' || run.status === 'pending'
  const elapsed = run.started_at
    ? differenceInSeconds(new Date(), parseApiDate(run.started_at))
    : null

  const dur = run.duration_seconds ?? (isActive ? elapsed : null)

  return (
    <Box sx={{ bgcolor: alpha('#0a0e1a', 0.6), borderTop: `1px solid ${alpha('#ffffff', 0.06)}`, p: 2 }}>
      {/* Run header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5, flexWrap: 'wrap' }}>
        <Typography sx={{ fontFamily: MONO, fontSize: '0.8rem', fontWeight: 700, color: 'primary.main' }}>
          Run #{run.id}
        </Typography>
        <StatusChip status={run.status} />
        {isActive && <LinearProgress sx={{ flex: 1, minWidth: 60, maxWidth: 120, height: 3, borderRadius: 2 }} />}

        {/* Stats */}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', ml: 0.5 }}>
          {dur !== null && (
            <Chip icon={<Timer sx={{ fontSize: 12 }} />} label={formatElapsed(dur)}
              size="small" variant="outlined" sx={{ fontFamily: MONO, fontSize: '0.68rem', height: 22 }} />
          )}
          {run.records_extracted > 0 && (
            <Chip icon={<ArrowDownward sx={{ fontSize: 12 }} />} label={run.records_extracted.toLocaleString()}
              size="small" variant="outlined" sx={{ fontFamily: MONO, fontSize: '0.68rem', height: 22 }} />
          )}
          {run.records_loaded > 0 && (
            <Chip icon={<Storage sx={{ fontSize: 12 }} />} label={`${run.records_loaded.toLocaleString()} loaded`}
              size="small" variant="outlined" sx={{ fontFamily: MONO, fontSize: '0.68rem', height: 22, color: '#22c55e', borderColor: alpha('#22c55e', 0.4) }} />
          )}
          {run.segments_processed > 0 && (
            <Chip icon={<SegmentIcon sx={{ fontSize: 12 }} />} label={`${run.segments_processed} segs`}
              size="small" variant="outlined" sx={{ fontFamily: MONO, fontSize: '0.68rem', height: 22 }} />
          )}
        </Box>

        <Box sx={{ flex: 1 }} />

        {/* Actions */}
        {isActive ? (
          <Button size="small" color="warning" variant="outlined" startIcon={<Cancel sx={{ fontSize: 14 }} />}
            disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}
            sx={{ fontSize: '0.72rem', height: 26 }}>
            Cancel
          </Button>
        ) : (
          <Button size="small" color="primary" variant="outlined" startIcon={<PlayArrow sx={{ fontSize: 14 }} />}
            disabled={rerunMutation.isPending} onClick={() => rerunMutation.mutate()}
            sx={{ fontSize: '0.72rem', height: 26 }}>
            Re-run
          </Button>
        )}
      </Box>

      {/* Error banner */}
      {run.error_message && (
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1.5, px: 1.5, py: 0.75,
          bgcolor: alpha('#ef4444', 0.08), border: `1px solid ${alpha('#ef4444', 0.2)}`, borderRadius: 1 }}>
          <ErrorOutline sx={{ fontSize: 14, color: 'error.main', mt: 0.1, flexShrink: 0 }} />
          <Typography sx={{ fontSize: '0.75rem', color: 'error.light' }}>{run.error_message}</Typography>
        </Box>
      )}

      {/* Step table */}
      {(run.steps?.length ?? 0) > 0 && (
        <RunStepTable steps={run.steps} />
      )}

      {(run.steps?.length ?? 0) === 0 && isActive && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.disabled', py: 1 }}>
          <CircularProgress size={12} color="inherit" />
          <Typography sx={{ fontSize: '0.75rem' }}>Waiting for steps to start…</Typography>
        </Box>
      )}
    </Box>
  )
}

// ─── Pipeline row ─────────────────────────────────────────────────────────────

function PipelineRow({
  pipeline,
  stepStatuses,
  activeRunId,
}: {
  pipeline: Pipeline
  stepStatuses: Record<string, string>
  activeRunId?: number
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()

  // Auto-expand if there's an active run
  const [expanded, setExpanded] = useState(() => !!activeRunId)
  const [monitorRunId, setMonitorRunId] = useState<number | null>(activeRunId ?? null)

  const lastRun = pipeline.last_run
  const isActive = lastRun?.status === 'running' || lastRun?.status === 'pending'

  const runMutation = useMutation({
    mutationFn: () => pipelinesApi.run(pipeline.id),
    onSuccess: (r) => {
      const id = r.data.id
      enqueueSnackbar(`Run #${id} started`, { variant: 'success' })
      qc.removeQueries({ queryKey: ['run-detail', id] })
      setMonitorRunId(id)
      setExpanded(true)
      qc.invalidateQueries({ queryKey: ['pipelines'] })
      qc.invalidateQueries({ queryKey: ['graph'] })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const cancelMutation = useMutation({
    mutationFn: () => runsApi.cancel(lastRun!.id),
    onSuccess: () => {
      enqueueSnackbar(`Run #${lastRun?.id} cancelled`, { variant: 'info' })
      qc.invalidateQueries({ queryKey: ['pipelines'] })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const toggleExpand = useCallback(() => {
    setExpanded((e) => {
      if (!e && lastRun) setMonitorRunId(lastRun.id)
      return !e
    })
  }, [lastRun])

  return (
    <>
      <TableRow
        hover
        sx={{
          cursor: 'pointer',
          ...(isActive ? { bgcolor: alpha('#f59e0b', 0.04) } : {}),
          ...(expanded ? { bgcolor: alpha('#3b82f6', 0.06) } : {}),
          '& td': { borderBottom: expanded ? 'none' : undefined },
        }}
        onClick={toggleExpand}
      >
        {/* Expand toggle */}
        <TableCell sx={{ width: 36, py: 0.75 }}>
          <IconButton size="small" sx={{ p: 0.25 }} onClick={(e) => { e.stopPropagation(); toggleExpand() }}>
            {expanded ? <ExpandLess sx={{ fontSize: 16 }} /> : <ExpandMore sx={{ fontSize: 16 }} />}
          </IconButton>
        </TableCell>

        {/* Name */}
        <TableCell sx={{ py: 0.75 }}>
          <Box>
            <Typography sx={{ fontWeight: 600, fontSize: '0.875rem' }}>{pipeline.name}</Typography>
            {pipeline.description && (
              <Typography sx={{ fontSize: '0.7rem', color: 'text.disabled' }}>{pipeline.description}</Typography>
            )}
            {pipeline.tags?.length > 0 && (
              <Box sx={{ display: 'flex', gap: 0.3, mt: 0.25, flexWrap: 'wrap' }}>
                {pipeline.tags.slice(0, 3).map((t) => (
                  <Chip key={t} label={t} size="small" sx={{ height: 16, fontSize: '0.62rem', bgcolor: alpha('#3b82f6', 0.1) }} />
                ))}
              </Box>
            )}
          </Box>
        </TableCell>

        {/* Source */}
        <TableCell sx={{ py: 0.75 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.secondary' }}>
            {SOURCE_ICON[pipeline.extract_config?.source_type] ?? <Storage sx={{ fontSize: 14 }} />}
            <Typography sx={{ fontSize: '0.75rem' }}>
              {SOURCE_LABEL[pipeline.extract_config?.source_type] ?? pipeline.extract_config?.source_type}
            </Typography>
          </Box>
        </TableCell>

        {/* Pipeline status */}
        <TableCell sx={{ py: 0.75 }}>
          <Chip
            label={pipeline.status}
            size="small"
            variant="outlined"
            color={pipeline.status === 'active' ? 'success' : pipeline.status === 'draft' ? 'default' : 'warning'}
            sx={{ fontSize: '0.68rem', height: 20 }}
          />
        </TableCell>

        {/* Last run status */}
        <TableCell sx={{ py: 0.75 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            {lastRun ? (
              <>
                <StatusChip status={lastRun.status} />
                {isActive && <CircularProgress size={12} sx={{ color: '#f59e0b' }} />}
              </>
            ) : (
              <Typography sx={{ fontSize: '0.72rem', color: 'text.disabled' }}>Never run</Typography>
            )}
          </Box>
        </TableCell>

        {/* Step statuses (E / T / L) */}
        <TableCell sx={{ py: 0.75 }}>
          <StepPips statuses={stepStatuses} />
        </TableCell>

        {/* Last run time */}
        <TableCell sx={{ py: 0.75 }}>
          <Typography sx={{ fontSize: '0.72rem', color: 'text.secondary' }}>
            {lastRun?.started_at
              ? formatDistanceToNow(parseApiDate(lastRun.started_at), { addSuffix: true })
              : '—'}
          </Typography>
        </TableCell>

        {/* Total runs */}
        <TableCell align="right" sx={{ py: 0.75, fontFamily: MONO, fontSize: '0.72rem', color: 'text.secondary' }}>
          {pipeline.total_runs}
        </TableCell>

        {/* Actions */}
        <TableCell sx={{ py: 0.75 }} onClick={(e) => e.stopPropagation()}>
          <Box sx={{ display: 'flex', gap: 0.25, justifyContent: 'flex-end' }}>
            <Tooltip title="Edit in Studio">
              <IconButton size="small" onClick={() => navigate(`/studio?id=${pipeline.id}`)}
                sx={{ color: 'text.disabled', '&:hover': { color: 'primary.main' } }}>
                <Edit sx={{ fontSize: 15 }} />
              </IconButton>
            </Tooltip>
            {isActive ? (
              <Tooltip title="Cancel run">
                <IconButton size="small" color="warning" disabled={cancelMutation.isPending}
                  onClick={() => cancelMutation.mutate()}>
                  <Cancel sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
            ) : (
              <Tooltip title="Run now">
                <IconButton size="small" color="primary" disabled={runMutation.isPending}
                  onClick={() => runMutation.mutate()}>
                  {runMutation.isPending
                    ? <CircularProgress size={14} />
                    : <PlayArrow sx={{ fontSize: 15 }} />}
                </IconButton>
              </Tooltip>
            )}
          </Box>
        </TableCell>
      </TableRow>

      {/* Expanded inline monitor */}
      <TableRow sx={{ '& td': { p: 0 } }}>
        <TableCell colSpan={9}>
          <Collapse in={expanded} timeout="auto" unmountOnExit>
            {monitorRunId !== null ? (
              <InlineRunMonitor key={monitorRunId} runId={monitorRunId} pipelineId={pipeline.id} />
            ) : (
              <Box sx={{ py: 2, px: 3, color: 'text.disabled' }}>
                <Typography sx={{ fontSize: '0.78rem' }}>No run selected. Use the Run button to start a run.</Typography>
              </Box>
            )}
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Pipelines() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const qc = useQueryClient()

  const { data: pipelines, isLoading: pipelinesLoading } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: () => pipelinesApi.list().then((r) => r.data),
    refetchInterval: 5_000,
  })

  const { data: graph } = useQuery({
    queryKey: ['graph'],
    queryFn: () => graphApi.graph().then((r) => r.data),
    refetchInterval: 5_000,
  })

  // Build step statuses map: pipelineId → { extract: status, transform: status, load: status }
  const stepStatusMap = useMemo(() => {
    const map: Record<number, Record<string, string>> = {}
    for (const node of graph?.nodes ?? []) {
      map[node.id] = node.last_run_step_statuses ?? {}
    }
    return map
  }, [graph])

  // Active run IDs from graph last_run_status
  const activeRunMap = useMemo(() => {
    const map: Record<number, number | undefined> = {}
    for (const p of pipelines ?? []) {
      if (p.last_run?.status === 'running' || p.last_run?.status === 'pending') {
        map[p.id] = p.last_run.id
      }
    }
    return map
  }, [pipelines])

  const filtered = useMemo(() => {
    return (pipelines ?? []).filter((p) => {
      if (search && !p.name.toLowerCase().includes(search.toLowerCase())
        && !p.description?.toLowerCase().includes(search.toLowerCase())) return false
      if (statusFilter !== 'all' && p.status !== statusFilter) return false
      if (sourceFilter !== 'all' && p.extract_config?.source_type !== sourceFilter) return false
      return true
    })
  }, [pipelines, search, statusFilter, sourceFilter])

  const activeCount = pipelines?.filter(
    (p) => p.last_run?.status === 'running' || p.last_run?.status === 'pending'
  ).length ?? 0

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 2 }}>
      {/* Execution context */}
      <ExecutionContextBar />

      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexShrink: 0 }}>
        <Box sx={{ flex: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="h5" fontWeight={700}>Pipelines</Typography>
            {activeCount > 0 && (
              <Chip
                label={`${activeCount} running`}
                size="small"
                color="warning"
                sx={{ height: 22, fontSize: '0.7rem', fontWeight: 600 }}
              />
            )}
          </Box>
          <Typography variant="caption" color="text.secondary">
            Build, run and monitor data pipelines
          </Typography>
        </Box>
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={() => {
            qc.invalidateQueries({ queryKey: ['pipelines'] })
            qc.invalidateQueries({ queryKey: ['graph'] })
          }}>
            <Refresh />
          </IconButton>
        </Tooltip>
        <Button variant="contained" size="small" startIcon={<Add />}
          onClick={() => navigate('/studio')}>
          New Pipeline
        </Button>
      </Box>

      {/* Filters */}
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexShrink: 0 }}>
        <TextField
          size="small"
          placeholder="Search pipelines…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ width: 260 }}
          InputProps={{
            startAdornment: <InputAdornment position="start"><Search sx={{ fontSize: 16 }} /></InputAdornment>,
          }}
        />
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel>Status</InputLabel>
          <Select value={statusFilter} label="Status" onChange={(e) => setStatusFilter(e.target.value)}>
            <MenuItem value="all">All statuses</MenuItem>
            <MenuItem value="active">Active</MenuItem>
            <MenuItem value="inactive">Inactive</MenuItem>
            <MenuItem value="draft">Draft</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel>Source</InputLabel>
          <Select value={sourceFilter} label="Source" onChange={(e) => setSourceFilter(e.target.value)}>
            <MenuItem value="all">All sources</MenuItem>
            <MenuItem value="grpc">gRPC</MenuItem>
            <MenuItem value="jdbc">JDBC</MenuItem>
            <MenuItem value="datawarehouse">Data Warehouse</MenuItem>
          </Select>
        </FormControl>
        {(search || statusFilter !== 'all' || sourceFilter !== 'all') && (
          <Button size="small" variant="text" onClick={() => {
            setSearch(''); setStatusFilter('all'); setSourceFilter('all')
          }}>Clear</Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {filtered.length} pipeline{filtered.length !== 1 ? 's' : ''}
          {pipelines && filtered.length !== pipelines.length ? ` (filtered from ${pipelines.length})` : ''}
        </Typography>
      </Box>

      {/* Pipeline table */}
      <Card sx={{ flex: 1, overflow: 'auto' }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 36 }} />
              <TableCell>Pipeline</TableCell>
              <TableCell>Source</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Last Run</TableCell>
              <TableCell>
                <Tooltip title="Extract / Transform / Load step statuses from last run">
                  <span>Steps</span>
                </Tooltip>
              </TableCell>
              <TableCell>Started</TableCell>
              <TableCell align="right">Runs</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {pipelinesLoading ? (
              <TableRow>
                <TableCell colSpan={9} align="center" sx={{ py: 6 }}>
                  <CircularProgress size={24} />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                  {(pipelines?.length ?? 0) === 0
                    ? 'No pipelines yet. Click "New Pipeline" to create one.'
                    : 'No pipelines match the current filters.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((p) => (
                <PipelineRow
                  key={p.id}
                  pipeline={p}
                  stepStatuses={stepStatusMap[p.id] ?? {}}
                  activeRunId={activeRunMap[p.id]}
                />
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </Box>
  )
}
