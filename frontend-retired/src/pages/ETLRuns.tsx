import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Box, Typography, Card, Chip, IconButton, Tooltip, LinearProgress,
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Tab, Tabs,
  Table, TableHead, TableBody, TableRow, TableCell, alpha, useTheme,
  CircularProgress, Divider, Paper, Checkbox, Stack, Badge,
  TextField, InputAdornment, ToggleButton, ToggleButtonGroup, Collapse,
} from '@mui/material'
import {
  Refresh, Cancel, Circle, Delete, ClearAll, ErrorOutline,
  CheckCircleOutline, HourglassEmpty, Speed, DataObject,
  ExpandMore, ExpandLess, FilterList, Search, Clear, Timer,
  Segment as SegmentIcon, Apps as AppsIcon, StorageOutlined,
  WarningAmber, FiberManualRecord, ArrowDownward,
  Replay, OpenInNew, PlayArrow,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import { formatDistanceToNow, format, differenceInSeconds } from 'date-fns'
import { parseApiDate } from '../utils/dates'
import { runsApi, pipelinesApi, adminApi, RunDetail, RunSummary, RunLog, ExtractJob, RunStep } from '../api/client'
import StatusChip from '../components/StatusChip'
import { useWebSocket } from '../hooks/useWebSocket'

// ─── Constants ────────────────────────────────────────────────────────────────

const MONO = '"JetBrains Mono", "Fira Code", monospace'

const LOG_LEVEL_COLOR: Record<string, string> = {
  INFO: '#3b82f6', WARN: '#f59e0b', WARNING: '#f59e0b', ERROR: '#ef4444', DEBUG: '#6b7280',
}

const STATUS_COLOR: Record<string, string> = {
  completed: '#22c55e', failed: '#ef4444', running: '#f59e0b',
  pending: '#fbbf24', cancelled: '#6b7280',
}

// ─── Live elapsed timer ───────────────────────────────────────────────────────

function useElapsedTimer(startedAt: string | undefined | null, stopped: boolean) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!startedAt || stopped) {
      if (startedAt) setElapsed(differenceInSeconds(new Date(), parseApiDate(startedAt)))
      return
    }
    const tick = () => setElapsed(differenceInSeconds(new Date(), parseApiDate(startedAt)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [startedAt, stopped])
  return elapsed
}

function formatElapsed(secs: number) {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60), s = secs % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// ─── Log line ─────────────────────────────────────────────────────────────────

function LogLine({ entry, highlight }: { entry: RunLog; highlight?: boolean }) {
  const color = LOG_LEVEL_COLOR[entry.level] || '#94a3b8'
  return (
    <Box
      sx={{
        display: 'flex', gap: 1.5, py: 0.3, px: 1,
        fontFamily: MONO, fontSize: '0.73rem', lineHeight: 1.5,
        borderRadius: 0.5,
        bgcolor: highlight ? alpha('#ef4444', 0.08) : 'transparent',
        '&:hover': { bgcolor: alpha('#ffffff', 0.03) },
      }}
    >
      <Typography component="span" sx={{ color: 'text.disabled', flexShrink: 0, minWidth: 75 }}>
        {format(parseApiDate(entry.timestamp), 'HH:mm:ss.SSS')}
      </Typography>
      <Typography component="span" sx={{ color, flexShrink: 0, minWidth: 42, fontWeight: 700 }}>
        {entry.level.slice(0, 4)}
      </Typography>
      {entry.step && (
        <Typography component="span" sx={{ color: '#818cf8', flexShrink: 0, minWidth: 56, fontSize: '0.7rem' }}>
          [{entry.step}]
        </Typography>
      )}
      <Typography component="span" sx={{ color: 'text.primary', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
        {entry.message}
      </Typography>
    </Box>
  )
}

// ─── Segment card ─────────────────────────────────────────────────────────────

function SegmentCard({ job }: { job: ExtractJob }) {
  const theme = useTheme()
  const isRunning = job.status === 'running'
  const isFailed = job.status === 'failed'
  const isPending = job.status === 'pending'
  const elapsed = useElapsedTimer(job.started_at, !isRunning)

  const dur = job.started_at && job.finished_at
    ? differenceInSeconds(parseApiDate(job.finished_at), parseApiDate(job.started_at))
    : isRunning ? elapsed : null

  const segLabel = job.total_segments
    ? `${job.segment + 1} / ${job.total_segments}`
    : `${job.segment + 1}`

  const color = STATUS_COLOR[job.status] || '#94a3b8'

  return (
    <Box
      sx={{
        border: `1px solid ${isFailed ? alpha('#ef4444', 0.4) : isPending ? alpha('#fbbf24', 0.35) : alpha(color, 0.25)}`,
        borderRadius: 1.5,
        p: 1.25,
        bgcolor: isFailed
          ? alpha('#ef4444', 0.05)
          : isRunning
            ? alpha('#f59e0b', 0.04)
            : isPending
              ? alpha('#fbbf24', 0.05)
              : alpha(theme.palette.background.paper, 0.6),
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {isRunning && (
        <LinearProgress
          sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2 }}
          color="warning"
        />
      )}
      {/* Header row */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75 }}>
        <FiberManualRecord sx={{ fontSize: 8, color, flexShrink: 0 }} />
        <Typography sx={{ fontFamily: MONO, fontSize: '0.7rem', fontWeight: 700, color: 'text.secondary', flex: 1 }}>
          seg {segLabel}
        </Typography>
        {dur !== null && (
          <Typography sx={{ fontFamily: MONO, fontSize: '0.68rem', color: isRunning ? 'warning.main' : 'text.disabled' }}>
            {formatElapsed(dur)}{isRunning ? '…' : ''}
          </Typography>
        )}
      </Box>

      {/* Metrics */}
      <Box sx={{ display: 'flex', gap: 1.5 }}>
        <Box>
          <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled' }}>Records</Typography>
          <Typography sx={{ fontFamily: MONO, fontSize: '0.78rem', fontWeight: 600 }}>
            {isRunning ? '…' : job.records_count.toLocaleString()}
          </Typography>
        </Box>
        <Box>
          <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled' }}>Date</Typography>
          <Typography sx={{ fontFamily: MONO, fontSize: '0.72rem' }}>{job.date}</Typography>
        </Box>
        {job.output_format && (
          <Box>
            <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled' }}>Format</Typography>
            <Chip label={job.output_format.toUpperCase()} size="small"
              sx={{ height: 16, fontSize: '0.62rem', mt: 0.25 }} />
          </Box>
        )}
      </Box>

      {/* Error message */}
      {isFailed && job.error_message && (
        <Box sx={{ mt: 0.75, display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
          <ErrorOutline sx={{ fontSize: 12, color: 'error.main', mt: 0.1, flexShrink: 0 }} />
          <Typography sx={{ fontSize: '0.68rem', color: 'error.main', wordBreak: 'break-word', lineHeight: 1.4 }}>
            {job.error_message}
          </Typography>
        </Box>
      )}

      {/* Output path */}
      {job.output_path && !isFailed && (
        <Tooltip title={job.output_path}>
          <Typography sx={{ fontSize: '0.63rem', color: 'text.disabled', mt: 0.5, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {job.output_path.split('/').slice(-2).join('/')}
          </Typography>
        </Tooltip>
      )}
    </Box>
  )
}

// ─── App-id progress section ──────────────────────────────────────────────────

function AppProgress({ appId, jobs }: { appId: string; jobs: ExtractJob[] }) {
  const theme = useTheme()
  const total = jobs.reduce((s, j) => s + j.records_count, 0)
  const done = jobs.filter((j) => j.status === 'completed').length
  const failed = jobs.filter((j) => j.status === 'failed').length
  const running = jobs.filter((j) => j.status === 'running').length
  const allDone = jobs.length > 0 && done === jobs.length && failed === 0

  // Sync collapse state when allDone changes (expand for new runs, collapse when complete)
  const [collapsed, setCollapsed] = useState(() => allDone)
  useEffect(() => {
    setCollapsed(allDone)
  }, [allDone])

  return (
    <Box sx={{ mb: 2 }}>
      {/* App header */}
      <Box
        onClick={() => setCollapsed((c) => !c)}
        sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: collapsed ? 0 : 1, px: 0.5, cursor: 'pointer',
          '&:hover': { opacity: 0.85 } }}
      >
        <AppsIcon sx={{ fontSize: 14, color: 'primary.main' }} />
        <Typography sx={{ fontFamily: MONO, fontWeight: 700, fontSize: '0.8rem', color: 'primary.main' }}>
          {appId}
        </Typography>
        <Chip label={`${done}/${jobs.length} segs`} size="small"
          sx={{ height: 18, fontSize: '0.65rem' }} variant="outlined" />
        {running > 0 && (
          <Chip label={`${running} running`} size="small" color="warning"
            sx={{ height: 18, fontSize: '0.65rem' }} />
        )}
        {failed > 0 && (
          <Chip label={`${failed} failed`} size="small" color="error"
            sx={{ height: 18, fontSize: '0.65rem' }} />
        )}
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontFamily: MONO, fontSize: '0.75rem', color: 'text.secondary' }}>
          {total.toLocaleString()} rows
        </Typography>
        <IconButton size="small" sx={{ p: 0.25, ml: 0.5 }} onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c) }}>
          {collapsed ? <ExpandMore sx={{ fontSize: 16 }} /> : <ExpandLess sx={{ fontSize: 16 }} />}
        </IconButton>
      </Box>

      <Collapse in={!collapsed}>
        {/* Segment progress bar */}
        {jobs.length > 0 && (
          <Box sx={{ px: 0.5, mb: 1 }}>
            <Box sx={{ display: 'flex', height: 6, borderRadius: 1, overflow: 'hidden', bgcolor: alpha(theme.palette.divider, 0.3) }}>
              {jobs.map((j) => (
                <Box key={j.id} sx={{
                  flex: 1,
                  bgcolor: STATUS_COLOR[j.status] || '#6b7280',
                  mx: 0.15,
                  borderRadius: 0.5,
                }} />
              ))}
            </Box>
          </Box>
        )}

        {/* Segment cards — fixed 5-column grid */}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 1 }}>
          {jobs.map((j) => <SegmentCard key={j.id} job={j} />)}
        </Box>
        {jobs.length === 0 && (
          <Typography sx={{ fontSize: '0.75rem', color: 'text.disabled', pl: 0.5 }}>
            Waiting for segments...
          </Typography>
        )}
      </Collapse>
    </Box>
  )
}

// ─── Pipeline Step Stepper ────────────────────────────────────────────────────

const STEP_META: Record<string, { label: string; color: string; icon: string }> = {
  extract:   { label: 'Extract',   color: '#3b82f6', icon: '⬇' },
  transform: { label: 'Transform', color: '#8b5cf6', icon: '⚙' },
  load:      { label: 'Load',      color: '#10b981', icon: '⬆' },
}

const STEP_STATUS_COLOR: Record<string, string> = {
  pending:   '#475569',
  running:   '#f59e0b',
  completed: '#22c55e',
  failed:    '#ef4444',
  cancelled: '#6b7280',
  skipped:   '#334155',
}

function RunStepStepper({ steps }: { steps: RunStep[] }) {
  const sorted = [...steps].sort((a, b) => a.step_order - b.step_order)

  return (
    <Table size="small" sx={{ mb: 1.5 }}>
      <TableHead>
        <TableRow sx={{ '& th': { fontSize: '0.65rem', color: 'text.disabled', py: 0.5, borderColor: alpha('#ffffff', 0.06) } }}>
          <TableCell>Step</TableCell>
          <TableCell>Status</TableCell>
          <TableCell align="right">In</TableCell>
          <TableCell align="right">Out</TableCell>
          <TableCell align="right">Duration</TableCell>
          <TableCell>Error</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {sorted.map((step) => {
          const meta = STEP_META[step.step_type] ?? { label: step.step_type, color: '#64748b', icon: '●' }
          const statusColor = STEP_STATUS_COLOR[step.status] ?? '#64748b'
          const isRunning = step.status === 'running'
          const dur = step.started_at && step.finished_at
            ? differenceInSeconds(parseApiDate(step.finished_at), parseApiDate(step.started_at))
            : null
          return (
            <TableRow key={step.id} sx={{ '& td': { py: 0.6, borderColor: alpha('#ffffff', 0.05) } }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <Typography sx={{ fontSize: '0.75rem', lineHeight: 1 }}>{meta.icon}</Typography>
                  <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: meta.color }}>{meta.label}</Typography>
                </Box>
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

// ─── Stat pill ────────────────────────────────────────────────────────────────

function StatPill({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string | number; color?: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1.25, py: 0.5, borderRadius: 1,
      bgcolor: alpha('#ffffff', 0.04), border: `1px solid ${alpha('#ffffff', 0.08)}` }}>
      <Box sx={{ color: color || 'text.secondary', display: 'flex' }}>{icon}</Box>
      <Box>
        <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', lineHeight: 1.1 }}>{label}</Typography>
        <Typography sx={{ fontFamily: MONO, fontSize: '0.8rem', fontWeight: 600, color: color || 'text.primary', lineHeight: 1.2 }}>
          {typeof value === 'number' ? value.toLocaleString() : value}
        </Typography>
      </Box>
    </Box>
  )
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function DetailPanel({ runId, onClose, onRerun }: { runId: number; onClose: () => void; onRerun: (pipelineId: number, runId: number) => void }) {
  const theme = useTheme()
  const [tab, setTab] = useState(0)
  const [logFilter, setLogFilter] = useState<string>('ALL')
  const [logSearch, setLogSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const logEndRef = useRef<HTMLDivElement>(null)
  const errorRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const [errorIdx, setErrorIdx] = useState(0)

  const { messages: wsLogs } = useWebSocket<RunLog>(`/ws/logs/${runId}`, true)

  const { data: run } = useQuery({
    queryKey: ['run-detail', runId],
    queryFn: () => runsApi.get(runId).then((r) => r.data),
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === 'running' || s === 'pending' ? 1500 : false
    },
  })

  const isActive = run?.status === 'running' || run?.status === 'pending'
  const elapsed = useElapsedTimer(run?.started_at, !isActive)

  // Merge persisted + live logs, dedup by id
  const allLogs = useMemo(() => {
    const seen = new Set<number>()
    const merged: RunLog[] = []
    for (const l of [...(run?.logs || []), ...wsLogs]) {
      if (!seen.has(l.id)) { seen.add(l.id); merged.push(l) }
    }
    return merged.sort((a, b) => a.id - b.id)
  }, [run?.logs, wsLogs])

  // Auto-scroll logs
  useEffect(() => {
    if (autoScroll && tab === 1) logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [allLogs, autoScroll, tab])

  // Group extract jobs by app_id, ordered deterministically
  const jobsByApp = useMemo(() => {
    const map = new Map<string, ExtractJob[]>()
    for (const j of run?.extract_jobs || []) {
      const key = j.application_id || 'default'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(j)
    }
    return map
  }, [run?.extract_jobs])

  const appIds = Array.from(jobsByApp.keys())

  // Log filtering
  const filteredLogs = useMemo(() => {
    return allLogs.filter((l) => {
      if (logFilter !== 'ALL' && l.level !== logFilter) return false
      if (logSearch && !l.message.toLowerCase().includes(logSearch.toLowerCase())) return false
      return true
    })
  }, [allLogs, logFilter, logSearch])

  const errorLogs = filteredLogs.filter((l) => l.level === 'ERROR')

  const jumpToError = (direction: 1 | -1) => {
    const next = (errorIdx + direction + errorLogs.length) % errorLogs.length
    setErrorIdx(next)
    const el = errorRefs.current.get(errorLogs[next]?.id)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  if (!run) return (
    <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <CircularProgress size={24} />
    </Box>
  )

  const dur = run.duration_seconds ?? (isActive ? elapsed : null)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', bgcolor: '#0a0e1a' }}>
      {/* Panel header */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1,
        borderBottom: `1px solid ${alpha('#ffffff', 0.08)}`,
        bgcolor: '#0d1120', flexShrink: 0,
      }}>
        <Typography sx={{ fontFamily: MONO, fontWeight: 700, fontSize: '0.85rem', color: 'primary.main' }}>
          Run #{run.id}
        </Typography>
        <StatusChip status={run.status} />
        {isActive && <CircularProgress size={14} sx={{ color: 'warning.main' }} />}

        <Box sx={{ display: 'flex', gap: 0.75, ml: 1, flexWrap: 'wrap' }}>
          <StatPill icon={<Timer sx={{ fontSize: 14 }} />} label="Elapsed"
            value={dur !== null ? formatElapsed(dur) : '—'}
            color={isActive ? '#f59e0b' : undefined} />
          <StatPill icon={<ArrowDownward sx={{ fontSize: 14 }} />} label="Extracted"
            value={run.records_extracted} />
          <StatPill icon={<StorageOutlined sx={{ fontSize: 14 }} />} label="Loaded"
            value={run.records_loaded} />
          <StatPill icon={<SegmentIcon sx={{ fontSize: 14 }} />} label="Segments"
            value={run.segments_processed} />
          {appIds.length > 0 && (
            <StatPill icon={<AppsIcon sx={{ fontSize: 14 }} />} label="App IDs"
              value={appIds.length} />
          )}
          {errorLogs.length > 0 && (
            <StatPill icon={<ErrorOutline sx={{ fontSize: 14 }} />} label="Errors"
              value={errorLogs.length} color="#ef4444" />
          )}
        </Box>

        <Box sx={{ flex: 1 }} />
        <Chip label={`Pipeline #${run.pipeline_id}`} size="small" variant="outlined"
          sx={{ fontFamily: MONO, fontSize: '0.7rem', height: 22 }} />
        {!isActive && (
          <Tooltip title="Re-run this pipeline">
            <Button
              size="small"
              variant="outlined"
              color="primary"
              startIcon={<Replay sx={{ fontSize: 14 }} />}
              onClick={() => onRerun(run.pipeline_id, run.id)}
              sx={{ fontSize: '0.72rem', height: 26, px: 1.25 }}
            >
              Re-run
            </Button>
          </Tooltip>
        )}
        <IconButton size="small" onClick={onClose} sx={{ color: 'text.disabled', ml: 0.5 }}>
          <ExpandMore sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>

      {/* Error banner */}
      {run.error_message && (
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.75,
          bgcolor: alpha('#ef4444', 0.08), borderBottom: `1px solid ${alpha('#ef4444', 0.2)}`,
          flexShrink: 0,
        }}>
          <ErrorOutline sx={{ fontSize: 14, color: 'error.main' }} />
          <Typography sx={{ fontSize: '0.75rem', color: 'error.light', flex: 1 }}>
            {run.error_message}
          </Typography>
        </Box>
      )}

      {/* Tabs */}
      <Box sx={{ borderBottom: `1px solid ${alpha('#ffffff', 0.08)}`, flexShrink: 0 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}
          sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36, fontSize: '0.72rem', py: 0 } }}>
          <Tab label={
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Speed sx={{ fontSize: 13 }} />
              <span>Progress ({appIds.length} app{appIds.length !== 1 ? 's' : ''})</span>
            </Box>
          } />
          <Tab label={
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <DataObject sx={{ fontSize: 13 }} />
              <span>Logs ({allLogs.length})</span>
              {errorLogs.length > 0 && (
                <Chip label={errorLogs.length} size="small" color="error"
                  sx={{ height: 16, fontSize: '0.6rem', ml: 0.25 }} />
              )}
            </Box>
          } />
        </Tabs>
      </Box>

      {/* Progress tab */}
      {tab === 0 && (
        <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
          {/* Step-level pipeline progress */}
          {(run.steps?.length ?? 0) > 0 && (
            <>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.75, gap: 1 }}>
                <Typography sx={{ fontSize: '0.68rem', color: 'text.disabled', textTransform: 'uppercase', letterSpacing: '0.08em', flex: 1 }}>
                  Pipeline Steps
                </Typography>
                {run.steps.some((s) => s.status === 'failed') && (
                  <Tooltip title="One or more steps failed — re-run will retry from the start">
                    <Chip
                      icon={<WarningAmber sx={{ fontSize: 12 }} />}
                      label="Step failed"
                      size="small"
                      color="error"
                      variant="outlined"
                      sx={{ height: 20, fontSize: '0.62rem' }}
                    />
                  </Tooltip>
                )}
              </Box>
              <RunStepStepper steps={run.steps} />
              <Divider sx={{ mb: 2, borderColor: alpha('#ffffff', 0.06) }} />
            </>
          )}

          {appIds.length === 0 && isActive && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, color: 'text.disabled', pt: 2, pl: 1 }}>
              <CircularProgress size={16} color="inherit" />
              <Typography sx={{ fontSize: '0.78rem' }}>Waiting for extract jobs to start...</Typography>
            </Box>
          )}
          {appIds.length === 0 && !isActive && (
            <Typography sx={{ fontSize: '0.78rem', color: 'text.disabled', pl: 1 }}>No extract jobs recorded.</Typography>
          )}
          {appIds.map((appId) => (
            <AppProgress key={appId} appId={appId} jobs={jobsByApp.get(appId)!} />
          ))}
        </Box>
      )}

      {/* Logs tab */}
      {tab === 1 && (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Log toolbar */}
          <Box sx={{
            display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.75,
            borderBottom: `1px solid ${alpha('#ffffff', 0.06)}`, flexShrink: 0,
          }}>
            <ToggleButtonGroup
              value={logFilter} exclusive
              onChange={(_, v) => { if (v) setLogFilter(v) }}
              size="small"
              sx={{ '& .MuiToggleButton-root': { py: 0.25, px: 1, fontSize: '0.65rem', fontFamily: MONO } }}
            >
              {['ALL', 'INFO', 'WARN', 'ERROR'].map((lvl) => (
                <ToggleButton key={lvl} value={lvl}
                  sx={{ color: lvl === 'ALL' ? undefined : LOG_LEVEL_COLOR[lvl] }}>
                  {lvl}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>

            <TextField
              size="small"
              placeholder="Filter logs..."
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              sx={{ width: 200, '& .MuiInputBase-input': { fontSize: '0.75rem', py: 0.5 } }}
              InputProps={{
                startAdornment: <InputAdornment position="start"><Search sx={{ fontSize: 14 }} /></InputAdornment>,
                endAdornment: logSearch ? (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => setLogSearch('')}><Clear sx={{ fontSize: 12 }} /></IconButton>
                  </InputAdornment>
                ) : null,
              }}
            />

            {errorLogs.length > 0 && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Tooltip title="Previous error">
                  <IconButton size="small" onClick={() => jumpToError(-1)}
                    sx={{ color: 'error.main' }}>
                    <ExpandLess sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
                <Typography sx={{ fontSize: '0.7rem', color: 'error.main', fontFamily: MONO }}>
                  {errorIdx + 1}/{errorLogs.length}
                </Typography>
                <Tooltip title="Next error">
                  <IconButton size="small" onClick={() => jumpToError(1)}
                    sx={{ color: 'error.main' }}>
                    <ExpandMore sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            )}

            <Box sx={{ flex: 1 }} />

            <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled' }}>
              {filteredLogs.length} / {allLogs.length} entries
            </Typography>

            <Tooltip title={autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}>
              <IconButton size="small" onClick={() => setAutoScroll(!autoScroll)}
                sx={{ color: autoScroll ? 'primary.main' : 'text.disabled' }}>
                <ArrowDownward sx={{ fontSize: 15 }} />
              </IconButton>
            </Tooltip>
          </Box>

          {/* Log stream */}
          <Box sx={{ flex: 1, overflow: 'auto', bgcolor: '#050810', py: 1 }}>
            {filteredLogs.length === 0 ? (
              <Typography sx={{ fontSize: '0.75rem', color: 'text.disabled', fontFamily: MONO, px: 2, pt: 1 }}>
                {allLogs.length === 0 ? 'Waiting for logs...' : 'No matching log entries.'}
              </Typography>
            ) : (
              filteredLogs.map((l) => {
                const isErr = l.level === 'ERROR'
                return (
                  <Box key={l.id} ref={isErr ? (el) => { if (el) errorRefs.current.set(l.id, el as HTMLDivElement) } : undefined}>
                    <LogLine entry={l} highlight={isErr} />
                  </Box>
                )
              })
            )}
            <div ref={logEndRef} />
          </Box>
        </Box>
      )}
    </Box>
  )
}

// ─── Active run badge ─────────────────────────────────────────────────────────

function ActiveRunBadge({ run, selected, onClick }: { run: RunSummary; selected: boolean; onClick: () => void }) {
  const elapsed = useElapsedTimer(run.started_at, false)
  return (
    <Box
      onClick={onClick}
      sx={{
        display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.75, borderRadius: 1.5,
        cursor: 'pointer',
        border: `1px solid ${selected ? alpha('#f59e0b', 0.6) : alpha('#f59e0b', 0.25)}`,
        bgcolor: selected ? alpha('#f59e0b', 0.1) : alpha('#f59e0b', 0.04),
        transition: 'all 0.15s',
        '&:hover': { bgcolor: alpha('#f59e0b', 0.12) },
      }}
    >
      <CircularProgress size={10} sx={{ color: '#f59e0b' }} />
      <Typography sx={{ fontFamily: MONO, fontSize: '0.75rem', fontWeight: 600 }}>
        #{run.id}
      </Typography>
      <Typography sx={{ fontFamily: MONO, fontSize: '0.68rem', color: 'text.secondary' }}>
        Pipeline #{run.pipeline_id}
      </Typography>
      <Typography sx={{ fontFamily: MONO, fontSize: '0.68rem', color: '#f59e0b' }}>
        {formatElapsed(elapsed)}
      </Typography>
    </Box>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ETLRuns() {
  const [focusedRunId, setFocusedRunId] = useState<number | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const { enqueueSnackbar } = useSnackbar()
  const qc = useQueryClient()
  const theme = useTheme()

  const { data: runs, isLoading } = useQuery({
    queryKey: ['all-runs'],
    queryFn: () => runsApi.list(undefined, 100).then((r) => r.data),
    refetchInterval: 3_000,
  })

  const activeRuns = runs?.filter((r) => r.status === 'running' || r.status === 'pending') ?? []
  const terminalRuns = runs?.filter((r) => !['running', 'pending'].includes(r.status)) ?? []

  // Auto-open panel for new active runs
  useEffect(() => {
    if (activeRuns.length > 0 && !panelOpen) {
      qc.removeQueries({ queryKey: ['run-detail', activeRuns[0].id] })
      setFocusedRunId(activeRuns[0].id)
      setPanelOpen(true)
    }
  }, [activeRuns.length]) // eslint-disable-line

  const handleSelectRun = (id: number) => {
    // Remove stale cache so DetailPanel always shows fresh data
    qc.removeQueries({ queryKey: ['run-detail', id] })
    setFocusedRunId(id)
    setPanelOpen(true)
  }

  const cancelMutation = useMutation({
    mutationFn: (id: number) => runsApi.cancel(id),
    onSuccess: (_, id) => {
      enqueueSnackbar(`Run #${id} cancel requested`, { variant: 'info' })
      qc.invalidateQueries({ queryKey: ['all-runs'] })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const rerunMutation = useMutation({
    mutationFn: ({ pipelineId }: { pipelineId: number; fromRunId: number }) =>
      pipelinesApi.run(pipelineId),
    onSuccess: (r, { fromRunId }) => {
      enqueueSnackbar(`New run #${r.data.id} triggered (re-run of pipeline #${r.data.pipeline_id})`, { variant: 'success' })
      qc.invalidateQueries({ queryKey: ['all-runs'] })
      // Switch detail panel to the new run
      qc.removeQueries({ queryKey: ['run-detail', r.data.id] })
      setFocusedRunId(r.data.id)
      setPanelOpen(true)
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const handleRerun = (pipelineId: number, fromRunId: number) => {
    rerunMutation.mutate({ pipelineId, fromRunId })
  }

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => adminApi.deleteRuns(ids),
    onSuccess: () => {
      enqueueSnackbar(`Deleted ${selected.size} run(s)`, { variant: 'success' })
      setSelected(new Set())
      qc.invalidateQueries({ queryKey: ['all-runs'] })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const clearAllMutation = useMutation({
    mutationFn: () => adminApi.deleteRuns(),
    onSuccess: (r) => {
      enqueueSnackbar(r.data.message, { variant: 'success' })
      setSelected(new Set())
      setConfirmClearAll(false)
      setPanelOpen(false)
      setFocusedRunId(null)
      qc.removeQueries({ queryKey: ['run-detail'] })
      qc.invalidateQueries({ queryKey: ['all-runs'] })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const allTerminalSelected = terminalRuns.length > 0 && terminalRuns.every((r) => selected.has(r.id))
  const toggleSelectAll = () => {
    setSelected(allTerminalSelected ? new Set() : new Set(terminalRuns.map((r) => r.id)))
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* ── Top section ── */}
      <Box sx={{ flex: panelOpen ? '0 0 auto' : '1 1 auto', overflow: 'auto', display: 'flex', flexDirection: 'column', maxHeight: panelOpen ? '45%' : '100%', transition: 'max-height 0.2s' }}>

        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', px: 2, pt: 2, pb: 1, flexShrink: 0 }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="h5" fontWeight={700}>ETL Runs</Typography>
            <Typography variant="caption" color="text.secondary">Live monitoring and history</Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            {selected.size > 0 && (
              <Button size="small" color="error" variant="outlined" startIcon={<Delete />}
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(Array.from(selected))}>
                Delete ({selected.size})
              </Button>
            )}
            <Button size="small" color="warning" variant="outlined" startIcon={<ClearAll />}
              onClick={() => setConfirmClearAll(true)}>
              Clear All
            </Button>
            <IconButton size="small" onClick={() => qc.invalidateQueries({ queryKey: ['all-runs'] })}>
              <Refresh />
            </IconButton>
          </Box>
        </Box>

        {/* Active run badges */}
        {activeRuns.length > 0 && (
          <Box sx={{ display: 'flex', gap: 1, px: 2, pb: 1, flexWrap: 'wrap', flexShrink: 0 }}>
            {activeRuns.map((r) => (
              <ActiveRunBadge key={r.id} run={r}
                selected={focusedRunId === r.id && panelOpen}
                onClick={() => handleSelectRun(r.id)} />
            ))}
          </Box>
        )}

        {/* Runs table */}
        <Box sx={{ flex: 1, overflow: 'auto', px: 2, pb: 2 }}>
          <Card>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox size="small" indeterminate={selected.size > 0 && !allTerminalSelected}
                      checked={allTerminalSelected} onChange={toggleSelectAll} />
                  </TableCell>
                  <TableCell>Run</TableCell>
                  <TableCell>Pipeline</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Triggered</TableCell>
                  <TableCell align="right">Extracted</TableCell>
                  <TableCell align="right">Loaded</TableCell>
                  <TableCell align="right">Segs</TableCell>
                  <TableCell>Duration</TableCell>
                  <TableCell>Started</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={11} align="center" sx={{ py: 4 }}><CircularProgress size={24} /></TableCell></TableRow>
                ) : !runs?.length ? (
                  <TableRow><TableCell colSpan={11} align="center" sx={{ py: 4, color: 'text.secondary' }}>No runs yet</TableCell></TableRow>
                ) : runs.map((r) => {
                  const isActive = r.status === 'running' || r.status === 'pending'
                  const isSelected = selected.has(r.id)
                  const isFocused = focusedRunId === r.id && panelOpen
                  return (
                    <TableRow key={r.id}
                      sx={{
                        cursor: 'pointer',
                        '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.04) },
                        ...(isActive ? { bgcolor: alpha('#f59e0b', 0.04) } : {}),
                        ...(isFocused ? { bgcolor: alpha(theme.palette.primary.main, 0.08) } : {}),
                        ...(isSelected ? { bgcolor: alpha(theme.palette.error.main, 0.05) } : {}),
                      }}
                      onClick={() => handleSelectRun(r.id)}
                    >
                      <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                        {!isActive && (
                          <Checkbox size="small" checked={isSelected} onChange={() => {
                            setSelected((prev) => {
                              const next = new Set(prev)
                              if (next.has(r.id)) next.delete(r.id); else next.add(r.id)
                              return next
                            })
                          }} />
                        )}
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO, fontSize: '0.8rem', fontWeight: 600, color: 'primary.main' }}>
                        #{r.id} {isActive && <CircularProgress size={10} sx={{ ml: 0.5 }} />}
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO, fontSize: '0.8rem' }}>#{r.pipeline_id}</TableCell>
                      <TableCell><StatusChip status={r.status} /></TableCell>
                      <TableCell><Chip label={r.triggered_by} size="small" variant="outlined" sx={{ fontSize: '0.7rem' }} /></TableCell>
                      <TableCell align="right" sx={{ fontFamily: MONO, fontSize: '0.8rem' }}>{r.records_extracted.toLocaleString()}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: MONO, fontSize: '0.8rem' }}>{r.records_loaded.toLocaleString()}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: MONO, fontSize: '0.8rem' }}>{r.segments_processed}</TableCell>
                      <TableCell sx={{ fontFamily: MONO, fontSize: '0.8rem' }}>
                        {r.duration_seconds ? formatElapsed(Math.round(r.duration_seconds)) : isActive ? '…' : '—'}
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary">
                          {r.started_at ? formatDistanceToNow(parseApiDate(r.started_at), { addSuffix: true }) : '—'}
                        </Typography>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {isActive ? (
                          <Tooltip title="Cancel run">
                            <IconButton size="small" color="warning" onClick={() => cancelMutation.mutate(r.id)}>
                              <Cancel fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        ) : (
                          <Tooltip title="Re-run pipeline">
                            <IconButton size="small" color="primary"
                              disabled={rerunMutation.isPending}
                              onClick={() => handleRerun(r.pipeline_id, r.id)}>
                              <Replay sx={{ fontSize: 16 }} />
                            </IconButton>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Card>
        </Box>
      </Box>

      {/* ── Detail panel ── */}
      {panelOpen && focusedRunId !== null && (
        <>
          <Divider />
          <Box sx={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden' }}>
            <DetailPanel key={focusedRunId} runId={focusedRunId} onClose={() => setPanelOpen(false)} onRerun={handleRerun} />
          </Box>
        </>
      )}

      {/* Clear all dialog */}
      <Dialog open={confirmClearAll} onClose={() => setConfirmClearAll(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Clear all run history?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Permanently deletes all completed, failed, and cancelled runs. Active runs are not affected.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmClearAll(false)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={clearAllMutation.isPending}
            onClick={() => clearAllMutation.mutate()}>
            Clear All
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
