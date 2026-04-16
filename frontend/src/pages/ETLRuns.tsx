import { useState } from 'react'
import {
  Box, Typography, Card, CardContent, Chip, IconButton, Tooltip, LinearProgress,
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Tab, Tabs,
  Table, TableHead, TableBody, TableRow, TableCell, alpha, useTheme,
  CircularProgress, Divider, Paper, Checkbox,
} from '@mui/material'
import { Refresh, Cancel, ExpandMore, ExpandLess, Circle, Delete, ClearAll } from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import { runsApi, adminApi, RunDetail, RunLog } from '../api/client'
import StatusChip from '../components/StatusChip'
import { formatDistanceToNow, format } from 'date-fns'
import { parseApiDate } from '../utils/dates'
import { useWebSocket } from '../hooks/useWebSocket'

const LOG_LEVEL_COLOR: Record<string, string> = {
  INFO: '#3b82f6', WARN: '#f59e0b', WARNING: '#f59e0b', ERROR: '#ef4444', DEBUG: '#94a3b8',
}

function LogLine({ entry }: { entry: RunLog }) {
  const color = LOG_LEVEL_COLOR[entry.level] || '#94a3b8'
  return (
    <Box sx={{ display: 'flex', gap: 1.5, py: 0.25, fontFamily: '"JetBrains Mono", monospace', fontSize: '0.75rem', lineHeight: 1.5 }}>
      <Typography component="span" sx={{ color: 'text.secondary', flexShrink: 0, minWidth: 80 }}>
        {format(parseApiDate(entry.timestamp), 'HH:mm:ss.SSS')}
      </Typography>
      <Typography component="span" sx={{ color, flexShrink: 0, minWidth: 45, fontWeight: 600 }}>
        {entry.level.padEnd(5)}
      </Typography>
      {entry.step && (
        <Typography component="span" sx={{ color: '#6366f1', flexShrink: 0, minWidth: 60 }}>
          [{entry.step}]
        </Typography>
      )}
      <Typography component="span" sx={{ color: 'text.primary', wordBreak: 'break-all' }}>
        {entry.message}
      </Typography>
    </Box>
  )
}

function RunDetailDialog({ runId, open, onClose }: { runId: number; open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState(0)
  const theme = useTheme()
  const { messages: wsLogs } = useWebSocket<RunLog>(`/ws/logs/${runId}`, open)

  const { data: run, isLoading } = useQuery({
    queryKey: ['run-detail', runId],
    queryFn: () => runsApi.get(runId).then((r) => r.data),
    enabled: open,
    refetchInterval: (q) => (q.state.data?.status === 'running' || q.state.data?.status === 'pending' ? 2000 : false),
  })

  const allLogs = [
    ...(run?.logs || []),
    ...wsLogs.filter((w) => !run?.logs.find((l) => l.id === w.id)),
  ]

  const isActive = run?.status === 'running' || run?.status === 'pending'

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth PaperProps={{ sx: { height: '85vh' } }}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.5, pb: 1 }}>
        <Typography variant="h6" fontWeight={700}>Run #{runId}</Typography>
        {run && <StatusChip status={run.status} />}
        {isActive && <CircularProgress size={16} />}
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={onClose}>×</IconButton>
      </DialogTitle>

      {isLoading ? (
        <DialogContent><LinearProgress /></DialogContent>
      ) : run ? (
        <DialogContent dividers sx={{ p: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Summary strip */}
          <Box sx={{ display: 'flex', gap: 3, p: 2, bgcolor: alpha(theme.palette.primary.main, 0.04) }}>
            {[
              { label: 'Pipeline', value: `#${run.pipeline_id}` },
              { label: 'Extracted', value: run.records_extracted.toLocaleString() },
              { label: 'Loaded', value: run.records_loaded.toLocaleString() },
              { label: 'Segments', value: run.segments_processed },
              { label: 'Duration', value: run.duration_seconds ? `${run.duration_seconds.toFixed(1)}s` : '—' },
            ].map((m) => (
              <Box key={m.label}>
                <Typography variant="caption" color="text.secondary">{m.label}</Typography>
                <Typography variant="subtitle2" fontWeight={600}>{m.value}</Typography>
              </Box>
            ))}
          </Box>

          {run.error_message && (
            <Box sx={{ mx: 2, my: 1, p: 1.5, bgcolor: alpha(theme.palette.error.main, 0.08), borderRadius: 2, border: `1px solid ${alpha(theme.palette.error.main, 0.3)}` }}>
              <Typography variant="caption" color="error.main" fontWeight={600}>Error: </Typography>
              <Typography variant="caption" color="text.secondary">{run.error_message}</Typography>
            </Box>
          )}

          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }} variant="scrollable">
            <Tab label={`Logs (${allLogs.length})`} />
            <Tab label={`Extract Jobs (${run.extract_jobs?.length ?? 0})`} />
          </Tabs>

          {tab === 0 && (
            <Box sx={{ flex: 1, overflow: 'auto', p: 2, bgcolor: '#050810' }}>
              {allLogs.length === 0 ? (
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                  Waiting for logs...
                </Typography>
              ) : (
                allLogs.map((l) => <LogLine key={l.id} entry={l} />)
              )}
            </Box>
          )}

          {tab === 1 && (
            <Box sx={{ flex: 1, overflow: 'auto' }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>App ID</TableCell>
                    <TableCell>Date</TableCell>
                    <TableCell>Seg</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Records</TableCell>
                    <TableCell>Format</TableCell>
                    <TableCell>Error</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {run.extract_jobs?.map((j) => (
                    <TableRow key={j.id} sx={{ '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.04) } }}>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{j.application_id}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{j.date}</TableCell>
                      <TableCell>{j.segment}</TableCell>
                      <TableCell><StatusChip status={j.status} /></TableCell>
                      <TableCell align="right">{j.records_count.toLocaleString()}</TableCell>
                      <TableCell><Chip label={j.output_format.toUpperCase()} size="small" variant="outlined" /></TableCell>
                      <TableCell sx={{ maxWidth: 200 }}>
                        <Typography variant="caption" color="error.main" noWrap>{j.error_message || '—'}</Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </DialogContent>
      ) : null}

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

export default function ETLRuns() {
  const [selectedRun, setSelectedRun] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const { enqueueSnackbar } = useSnackbar()
  const qc = useQueryClient()
  const theme = useTheme()
  const { messages: liveUpdates } = useWebSocket('/ws/logs', true)

  const { data: runs, isLoading } = useQuery({
    queryKey: ['all-runs'],
    queryFn: () => runsApi.list(undefined, 100).then((r) => r.data),
    refetchInterval: 5_000,
  })

  const cancelMutation = useMutation({
    mutationFn: (id: number) => runsApi.cancel(id),
    onSuccess: (_, id) => {
      enqueueSnackbar(`Run #${id} cancel requested`, { variant: 'info' })
      qc.invalidateQueries({ queryKey: ['all-runs'] })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

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
      qc.invalidateQueries({ queryKey: ['all-runs'] })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const terminalRuns = runs?.filter((r) => !['running', 'pending'].includes(r.status)) ?? []
  const allTerminalSelected = terminalRuns.length > 0 && terminalRuns.every((r) => selected.has(r.id))

  const toggleSelectAll = () => {
    if (allTerminalSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(terminalRuns.map((r) => r.id)))
    }
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>ETL Runs</Typography>
          <Typography variant="caption" color="text.secondary">History and live monitoring of pipeline executions</Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          {selected.size > 0 && (
            <Button
              size="small" color="error" variant="outlined" startIcon={<Delete />}
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate(Array.from(selected))}
            >
              Delete ({selected.size})
            </Button>
          )}
          <Button
            size="small" color="warning" variant="outlined" startIcon={<ClearAll />}
            onClick={() => setConfirmClearAll(true)}
          >
            Clear All
          </Button>
          <IconButton onClick={() => qc.invalidateQueries({ queryKey: ['all-runs'] })}>
            <Refresh />
          </IconButton>
        </Box>
      </Box>

      <Card>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  size="small"
                  indeterminate={selected.size > 0 && !allTerminalSelected}
                  checked={allTerminalSelected}
                  onChange={toggleSelectAll}
                />
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
              <TableCell>Actions</TableCell>
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
              return (
                <TableRow
                  key={r.id}
                  sx={{
                    cursor: 'pointer',
                    '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.04) },
                    ...(isActive ? { bgcolor: alpha(theme.palette.warning.main, 0.04) } : {}),
                    ...(isSelected ? { bgcolor: alpha(theme.palette.error.main, 0.05) } : {}),
                  }}
                  onClick={() => setSelectedRun(r.id)}
                >
                  <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                    {!isActive && (
                      <Checkbox
                        size="small"
                        checked={isSelected}
                        onChange={() => {
                          setSelected((prev) => {
                            const next = new Set(prev)
                            if (next.has(r.id)) next.delete(r.id)
                            else next.add(r.id)
                            return next
                          })
                        }}
                      />
                    )}
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 600, color: 'primary.main' }}>
                    #{r.id} {isActive && <CircularProgress size={10} sx={{ ml: 0.5 }} />}
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>#{r.pipeline_id}</TableCell>
                  <TableCell><StatusChip status={r.status} /></TableCell>
                  <TableCell><Chip label={r.triggered_by} size="small" variant="outlined" sx={{ fontSize: '0.7rem' }} /></TableCell>
                  <TableCell align="right">{r.records_extracted.toLocaleString()}</TableCell>
                  <TableCell align="right">{r.records_loaded.toLocaleString()}</TableCell>
                  <TableCell align="right">{r.segments_processed}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                    {r.duration_seconds ? `${r.duration_seconds.toFixed(1)}s` : isActive ? '…' : '—'}
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {r.started_at ? formatDistanceToNow(parseApiDate(r.started_at), { addSuffix: true }) : '—'}
                    </Typography>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {isActive && (
                      <Tooltip title="Cancel run">
                        <IconButton size="small" color="warning" onClick={() => cancelMutation.mutate(r.id)}>
                          <Cancel fontSize="small" />
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

      {selectedRun !== null && (
        <RunDetailDialog runId={selectedRun} open onClose={() => setSelectedRun(null)} />
      )}

      <Dialog open={confirmClearAll} onClose={() => setConfirmClearAll(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Clear all run history?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This will permanently delete all completed, failed, and cancelled runs.
            Active and pending runs are not affected.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmClearAll(false)}>Cancel</Button>
          <Button
            color="error" variant="contained"
            disabled={clearAllMutation.isPending}
            onClick={() => clearAllMutation.mutate()}
          >
            Clear All
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
