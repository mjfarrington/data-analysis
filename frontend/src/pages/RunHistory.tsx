import { useState } from 'react'
import {
  Box, Typography, Table, TableHead, TableRow, TableCell, TableBody,
  Chip, TextField, MenuItem, Button, CircularProgress, Collapse,
  Alert, IconButton, Tooltip, alpha, useTheme,
} from '@mui/material'
import {
  ExpandMore, ExpandLess, Cancel, PlayArrow, Refresh,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { runsApi, pipelinesApi, RunSummary, RunDetail, RunLog, RunStep } from '../api/client'
import { format, parseISO } from 'date-fns'

function levelColor(level: string): string {
  switch (level.toUpperCase()) {
    case 'ERROR': return '#f85149'
    case 'WARNING': case 'WARN': return '#d29922'
    case 'INFO': return '#8b949e'
    default: return '#8b949e'
  }
}

function StatusChip({ status }: { status: string }) {
  const colorMap: Record<string, 'success' | 'error' | 'warning' | 'info' | 'default'> = {
    completed: 'success', failed: 'error', cancelled: 'default',
    running: 'info', pending: 'info',
  }
  return (
    <Chip label={status} size="small" color={colorMap[status] ?? 'default'} sx={{ fontSize: '0.7rem', height: 20 }} />
  )
}

function formatDuration(seconds?: number): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`
}

function formatDate(str?: string): string {
  if (!str) return '—'
  try { return format(parseISO(str), 'MMM d, HH:mm:ss') } catch { return str }
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run-detail', runId] }),
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

      {/* Steps */}
      {run.steps.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="caption" fontWeight={700} color="text.secondary" textTransform="uppercase" letterSpacing="0.08em" display="block" mb={1}>
            Steps
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                {['#', 'Type', 'Status', 'Records In', 'Records Out', 'Duration', 'Error'].map(h => (
                  <TableCell key={h}>{h}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {[...run.steps].sort((a, b) => a.step_order - b.step_order).map((step: RunStep) => (
                <TableRow key={step.id}>
                  <TableCell>{step.step_order}</TableCell>
                  <TableCell><Chip label={step.step_type} size="small" sx={{ fontSize: '0.65rem' }} /></TableCell>
                  <TableCell><StatusChip status={step.status} /></TableCell>
                  <TableCell>{step.records_in?.toLocaleString() ?? '—'}</TableCell>
                  <TableCell>{step.records_out?.toLocaleString() ?? '—'}</TableCell>
                  <TableCell>{formatDuration(step.duration_seconds)}</TableCell>
                  <TableCell sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', color: 'error.main', fontSize: '0.75rem' }}>
                    {step.error_message ?? ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}

      {run.error_message && (
        <Alert severity="error" sx={{ mb: 2 }}>{run.error_message}</Alert>
      )}

      {/* Logs */}
      {run.logs.length > 0 && (
        <Box>
          <Typography variant="caption" fontWeight={700} color="text.secondary" textTransform="uppercase" letterSpacing="0.08em" display="block" mb={1}>
            Logs
          </Typography>
          <Box
            sx={{
              maxHeight: 200, overflowY: 'auto',
              bgcolor: theme.palette.mode === 'dark' ? '#0d1117' : '#f8f9fa',
              borderRadius: 1, p: 1.5,
              border: `1px solid ${theme.palette.divider}`,
              fontFamily: 'monospace', fontSize: '0.78rem',
            }}
          >
            {run.logs.map((log: RunLog, i: number) => (
              <Box key={i} sx={{ display: 'flex', gap: 1.5, mb: 0.25 }}>
                <Typography component="span" sx={{ color: 'text.disabled', fontSize: 'inherit', flexShrink: 0 }}>
                  {log.timestamp ? format(parseISO(log.timestamp), 'HH:mm:ss') : ''}
                </Typography>
                <Typography component="span" sx={{ color: levelColor(log.level), fontWeight: 600, flexShrink: 0, fontSize: 'inherit', width: 50 }}>
                  [{log.level}]
                </Typography>
                {log.step && (
                  <Typography component="span" sx={{ color: 'text.secondary', flexShrink: 0, fontSize: 'inherit' }}>
                    [{log.step}]
                  </Typography>
                )}
                <Typography component="span" sx={{ color: 'text.primary', fontSize: 'inherit' }}>
                  {log.message}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

export default function RunHistory() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [pipelineFilter, setPipelineFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const { data: runs = [], isLoading } = useQuery({
    queryKey: ['all-runs'],
    queryFn: runsApi.list,
  })

  const { data: pipelines = [] } = useQuery({
    queryKey: ['pipelines'],
    queryFn: pipelinesApi.list,
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
                  </TableRow>,
                  <TableRow key={`${run.id}-detail`}>
                    <TableCell colSpan={9} sx={{ p: 0, border: 0 }}>
                      <Collapse in={expanded} unmountOnExit>
                        <RunDetailPanel runId={run.id} />
                      </Collapse>
                    </TableCell>
                  </TableRow>,
                ]
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No runs found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      )}
    </Box>
  )
}
