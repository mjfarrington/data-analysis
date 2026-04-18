import { useState, useCallback } from 'react'
import {
  Box, Typography, Button, Table, TableHead, TableRow, TableCell,
  TableBody, Chip, IconButton, Dialog, DialogTitle, DialogContent,
  DialogActions, TextField, MenuItem, InputAdornment, Collapse,
  CircularProgress, Tooltip, Alert, alpha, useTheme,
} from '@mui/material'
import {
  Add, PlayArrow, Edit, Search, Refresh, Cancel,
  ExpandMore, ExpandLess, ErrorOutline, CheckCircleOutline,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { pipelinesApi, runsApi, Pipeline, RunDetail, RunStep } from '../api/client'

// ── Step Pips ─────────────────────────────────────────────────────────────────

function stepColor(status?: string): string {
  switch (status) {
    case 'running': return '#58a6ff'
    case 'completed': return '#3fb950'
    case 'failed': return '#f85149'
    case 'skipped': return '#d29922'
    default: return '#484f58'
  }
}

function StepPips({ statuses }: { statuses: Record<string, string> }) {
  const labels: Array<{ key: string; label: string }> = [
    { key: 'extract', label: 'E' },
    { key: 'transform', label: 'T' },
    { key: 'load', label: 'L' },
  ]
  return (
    <Box sx={{ display: 'flex', gap: 0.5 }}>
      {labels.map(({ key, label }) => {
        const status = statuses[key]
        const color = stepColor(status)
        return (
          <Tooltip key={key} title={`${label}: ${status ?? 'pending'}`}>
            <Box
              sx={{
                width: 22, height: 22, borderRadius: 0.75,
                bgcolor: alpha(color, 0.15),
                border: `1px solid ${color}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.65rem', fontWeight: 700, color,
                animation: status === 'running' ? 'pulse 1.2s infinite' : 'none',
                '@keyframes pulse': {
                  '0%,100%': { opacity: 1 },
                  '50%': { opacity: 0.5 },
                },
              }}
            >
              {label}
            </Box>
          </Tooltip>
        )
      })}
    </Box>
  )
}

// ── Inline Run Monitor ────────────────────────────────────────────────────────

function InlineRunMonitor({ runId, pipelineId, onDone }: { runId: number; pipelineId: number; onDone?: () => void }) {
  const theme = useTheme()
  const qc = useQueryClient()
  const terminal = ['completed', 'failed', 'cancelled']

  const { data: run, isLoading } = useQuery<RunDetail>({
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

  if (isLoading) return <Box sx={{ p: 2 }}><CircularProgress size={20} /></Box>
  if (!run) return null

  const isTerminal = terminal.includes(run.status)
  const isRunning = run.status === 'running' || run.status === 'pending'

  return (
    <Box sx={{ p: 2, bgcolor: alpha(theme.palette.background.paper, 0.5), borderTop: `1px solid ${theme.palette.divider}` }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <StatusChip status={run.status} />
        {run.duration_seconds != null && (
          <Typography variant="caption" color="text.secondary">
            Duration: {run.duration_seconds.toFixed(1)}s
          </Typography>
        )}
        {run.records_extracted != null && (
          <Typography variant="caption" color="text.secondary">
            Extracted: {run.records_extracted.toLocaleString()}
          </Typography>
        )}
        {run.records_loaded != null && (
          <Typography variant="caption" color="text.secondary">
            Loaded: {run.records_loaded.toLocaleString()}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {isRunning && (
          <Button size="small" color="error" startIcon={<Cancel />} onClick={() => cancelMut.mutate()}>
            Cancel
          </Button>
        )}
        {isTerminal && (
          <Button size="small" startIcon={<PlayArrow />} onClick={() => rerunMut.mutate()} disabled={rerunMut.isPending}>
            Re-run
          </Button>
        )}
      </Box>

      {/* Steps */}
      {run.steps && run.steps.length > 0 && (
        <Table size="small" sx={{ mb: 2 }}>
          <TableHead>
            <TableRow>
              {['Step', 'Type', 'Status', 'In', 'Out', 'Duration', 'Error'].map(h => (
                <TableCell key={h}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {[...run.steps].sort((a, b) => a.step_order - b.step_order).map((step: RunStep) => (
              <TableRow key={step.id}>
                <TableCell>{step.step_order}</TableCell>
                <TableCell>
                  <Chip label={step.step_type} size="small" sx={{ fontSize: '0.65rem' }} />
                </TableCell>
                <TableCell>
                  {step.status === 'running'
                    ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><CircularProgress size={12} /><Typography variant="caption">running</Typography></Box>
                    : <StatusChip status={step.status} />
                  }
                </TableCell>
                <TableCell>{step.records_in ?? '—'}</TableCell>
                <TableCell>{step.records_out ?? '—'}</TableCell>
                <TableCell>{step.duration_seconds != null ? `${step.duration_seconds.toFixed(1)}s` : '—'}</TableCell>
                <TableCell>
                  {step.error_message && (
                    <Tooltip title={step.error_message}>
                      <ErrorOutline fontSize="small" color="error" />
                    </Tooltip>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {run.error_message && (
        <Alert severity="error" sx={{ fontSize: '0.8rem' }}>{run.error_message}</Alert>
      )}
    </Box>
  )
}

// ── Status chip ───────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const colorMap: Record<string, 'success' | 'error' | 'warning' | 'info' | 'default'> = {
    active: 'success', completed: 'success', healthy: 'success',
    failed: 'error', inactive: 'default', cancelled: 'default',
    draft: 'warning', running: 'info', pending: 'info',
  }
  return (
    <Chip
      label={status}
      size="small"
      color={colorMap[status] ?? 'default'}
      sx={{ fontSize: '0.7rem', height: 20 }}
    />
  )
}

// ── Pipeline dialog ───────────────────────────────────────────────────────────

const SOURCE_TYPES = ['grpc', 'jdbc', 'datawarehouse', 'json', 'csv']
const LOAD_TARGETS = ['parquet', 'csv', 'spark_table']
const STATUSES = ['active', 'inactive', 'draft']

interface PipelineForm {
  name: string
  description: string
  status: string
  source_type: string
  load_target: string
}

function PipelineDialog({
  open, onClose, initial, onSave,
}: {
  open: boolean
  onClose: () => void
  initial?: Partial<PipelineForm>
  onSave: (data: PipelineForm) => Promise<void>
}) {
  const [form, setForm] = useState<PipelineForm>({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    status: initial?.status ?? 'draft',
    source_type: initial?.source_type ?? 'grpc',
    load_target: initial?.load_target ?? 'parquet',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function handleSave() {
    if (!form.name.trim()) { setErr('Name is required'); return }
    setSaving(true)
    try {
      await onSave(form)
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial ? 'Edit Pipeline' : 'New Pipeline'}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '16px !important' }}>
        {err && <Alert severity="error">{err}</Alert>}
        <TextField label="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} fullWidth size="small" />
        <TextField label="Description" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} fullWidth size="small" multiline rows={2} />
        <TextField label="Status" select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} fullWidth size="small">
          {STATUSES.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
        </TextField>
        <TextField label="Source Type" select value={form.source_type} onChange={e => setForm(f => ({ ...f, source_type: e.target.value }))} fullWidth size="small">
          {SOURCE_TYPES.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
        </TextField>
        <TextField label="Load Target" select value={form.load_target} onChange={e => setForm(f => ({ ...f, load_target: e.target.value }))} fullWidth size="small">
          {LOAD_TARGETS.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
        </TextField>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving}>
          {saving ? <CircularProgress size={18} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ── Main Pipelines page ───────────────────────────────────────────────────────

export default function Pipelines() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [newOpen, setNewOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Pipeline | null>(null)
  const [expandedRow, setExpandedRow] = useState<number | null>(null)
  const [activeRunId, setActiveRunId] = useState<Record<number, number>>({})

  const { data: pipelines = [], isLoading } = useQuery({
    queryKey: ['pipelines'],
    queryFn: pipelinesApi.list,
  })

  const createMut = useMutation({
    mutationFn: (data: Partial<Pipeline>) => pipelinesApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pipelines'] }),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Pipeline> }) =>
      pipelinesApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pipelines'] }),
  })

  const runMut = useMutation({
    mutationFn: (id: number) => pipelinesApi.run(id),
    onSuccess: (run, id) => {
      setActiveRunId(m => ({ ...m, [id]: run.id }))
      setExpandedRow(id)
      qc.invalidateQueries({ queryKey: ['pipelines'] })
    },
  })

  const filtered = pipelines.filter(p => {
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all' || p.status === statusFilter
    return matchSearch && matchStatus
  })

  const statusChips = ['all', 'active', 'inactive', 'draft']

  return (
    <Box sx={{ p: 3 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 3, gap: 2 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>Pipelines</Typography>
          <Typography variant="body2" color="text.secondary">
            Manage and run your ETL pipelines
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<Add />} onClick={() => setNewOpen(true)}>
          New Pipeline
        </Button>
      </Box>

      {/* Filter bar */}
      <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          placeholder="Search pipelines…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          size="small"
          sx={{ width: 240 }}
          InputProps={{
            startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment>,
          }}
        />
        <Box sx={{ display: 'flex', gap: 1 }}>
          {statusChips.map(s => (
            <Chip
              key={s}
              label={s.charAt(0).toUpperCase() + s.slice(1)}
              onClick={() => setStatusFilter(s)}
              variant={statusFilter === s ? 'filled' : 'outlined'}
              color={statusFilter === s ? 'primary' : 'default'}
              size="small"
            />
          ))}
        </Box>
        <IconButton size="small" onClick={() => qc.invalidateQueries({ queryKey: ['pipelines'] })}>
          <Refresh fontSize="small" />
        </IconButton>
      </Box>

      {/* Table */}
      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Box sx={{ bgcolor: 'background.paper', borderRadius: 2, border: `1px solid ${theme.palette.divider}`, overflow: 'hidden' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell width={40} />
                <TableCell>Name</TableCell>
                <TableCell>Source</TableCell>
                <TableCell>Target</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Last Run</TableCell>
                <TableCell>Steps</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map(pipeline => {
                const expanded = expandedRow === pipeline.id
                const runId = activeRunId[pipeline.id]
                return [
                  <TableRow
                    key={pipeline.id}
                    hover
                    sx={{ cursor: 'pointer', '&:last-child td': { border: 0 } }}
                  >
                    <TableCell>
                      <IconButton size="small" onClick={() => setExpandedRow(expanded ? null : pipeline.id)}>
                        {expanded ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
                      </IconButton>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>{pipeline.name}</Typography>
                      {pipeline.description && (
                        <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 200, display: 'block' }}>
                          {pipeline.description}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip label={pipeline.source_type} size="small" sx={{ fontSize: '0.7rem' }} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">{pipeline.load_target}</Typography>
                    </TableCell>
                    <TableCell>
                      <StatusChip status={pipeline.status} />
                    </TableCell>
                    <TableCell>
                      {pipeline.last_run ? (
                        <Box>
                          <StatusChip status={pipeline.last_run.status} />
                          {pipeline.last_run.started_at && (
                            <Typography variant="caption" color="text.secondary" display="block">
                              {new Date(pipeline.last_run.started_at).toLocaleString()}
                            </Typography>
                          )}
                        </Box>
                      ) : (
                        <Typography variant="caption" color="text.secondary">Never</Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <StepPips statuses={pipeline.last_run ? {
                        extract: pipeline.last_run.status,
                        transform: pipeline.last_run.status,
                        load: pipeline.last_run.status,
                      } : {}} />
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', gap: 0.5 }}>
                        <Tooltip title="Run">
                          <IconButton
                            size="small"
                            color="primary"
                            onClick={() => runMut.mutate(pipeline.id)}
                            disabled={runMut.isPending}
                          >
                            <PlayArrow fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Edit">
                          <IconButton size="small" onClick={() => setEditTarget(pipeline)}>
                            <Edit fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    </TableCell>
                  </TableRow>,
                  <TableRow key={`${pipeline.id}-expand`}>
                    <TableCell colSpan={8} sx={{ p: 0, border: 0 }}>
                      <Collapse in={expanded} unmountOnExit>
                        {runId ? (
                          <InlineRunMonitor
                            runId={runId}
                            pipelineId={pipeline.id}
                            onDone={() => setExpandedRow(null)}
                          />
                        ) : (
                          <Box sx={{ p: 2, color: 'text.secondary' }}>
                            <Typography variant="body2">
                              Run this pipeline to see live progress here.
                            </Typography>
                          </Box>
                        )}
                      </Collapse>
                    </TableCell>
                  </TableRow>,
                ]
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No pipelines found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      )}

      {/* New pipeline dialog */}
      <PipelineDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onSave={async data => { await createMut.mutateAsync(data as Partial<Pipeline>) }}
      />

      {/* Edit pipeline dialog */}
      {editTarget && (
        <PipelineDialog
          open={!!editTarget}
          onClose={() => setEditTarget(null)}
          initial={editTarget}
          onSave={async data => { await updateMut.mutateAsync({ id: editTarget.id, data: data as Partial<Pipeline> }) }}
        />
      )}
    </Box>
  )
}
