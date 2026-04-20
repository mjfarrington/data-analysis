import { useState } from 'react'
import {
  Box, Typography, Button, Card, CardContent, CardActions,
  Chip, IconButton, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, MenuItem, Divider, CircularProgress, Alert, alpha, useTheme,
  Tooltip, Grid, FormControl, InputLabel, Select, Tabs, Tab,
} from '@mui/material'
import {
  Add, PlayArrow, Edit, Delete, CheckCircleOutlined, ErrorOutlined,
  Schedule, LibraryBooks, Code, PlayCircleOutlined,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { transformApi, sqlFilesApi, TransformJob } from '../api/client'
import StatusChip from '../components/StatusChip'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmt(s?: string | null) {
  if (!s) return '—'
  return new Date(s).toLocaleString()
}
function fmtDur(s?: number | null) {
  if (s == null) return null
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`
}

// ─────────────────────────────────────────────────────────────────────────────
// Create / Edit dialog
// ─────────────────────────────────────────────────────────────────────────────

interface JobDialogProps {
  open: boolean
  onClose: () => void
  initial?: TransformJob
  onSave: (data: Partial<TransformJob>) => Promise<void>
  onDelete?: () => Promise<void>
}

function JobDialog({ open, onClose, initial, onSave, onDelete }: JobDialogProps) {
  const [tab, setTab] = useState(0)
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [transformType, setTransformType] = useState<'sql' | 'notebook'>(initial?.transform_type ?? 'notebook')
  const [sourceDb, setSourceDb] = useState(initial?.source_database ?? '')
  const [sourceTable, setSourceTable] = useState(initial?.source_table ?? '')
  const [targetDb, setTargetDb] = useState(initial?.target_database ?? '')
  const [targetTable, setTargetTable] = useState(initial?.target_table ?? '')
  const [targetMode, setTargetMode] = useState(initial?.target_mode ?? 'overwrite')
  const [sqlFileId, setSqlFileId] = useState<number | ''>(initial?.sql_file_id ?? '')
  const [notebookFileId, setNotebookFileId] = useState<number | ''>(initial?.notebook_file_id ?? '')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [err, setErr] = useState('')

  const { data: sqlFiles = [] } = useQuery({ queryKey: ['sql-files'], queryFn: sqlFilesApi.list })
  const { data: notebooks = [] } = useQuery({ queryKey: ['notebooks'], queryFn: transformApi.listNotebooks })

  async function handleSave() {
    setErr('')
    if (!name.trim()) { setErr('Name is required'); return }
    if (!sourceTable.trim()) { setErr('Source table is required'); return }
    if (!targetTable.trim()) { setErr('Target table is required'); return }
    setSaving(true)
    try {
      await onSave({
        name,
        description,
        transform_type: transformType,
        source_database: sourceDb || undefined,
        source_table: sourceTable,
        target_database: targetDb || undefined,
        target_table: targetTable,
        target_mode: targetMode,
        sql_file_id: transformType === 'sql' && sqlFileId !== '' ? Number(sqlFileId) : undefined,
        notebook_file_id: transformType === 'notebook' && notebookFileId !== '' ? Number(notebookFileId) : undefined,
      })
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    } finally { setSaving(false) }
  }

  async function handleDelete() {
    if (!onDelete) return
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return
    setDeleting(true)
    try { await onDelete(); onClose() } finally { setDeleting(false) }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial ? 'Edit Transform Job' : 'New Transform Job'}</DialogTitle>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }}>
        <Tab label="General" sx={{ fontSize: '0.82rem' }} />
        <Tab label="Source / Target" sx={{ fontSize: '0.82rem' }} />
      </Tabs>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '20px !important' }}>
        {err && <Alert severity="error">{err}</Alert>}

        {tab === 0 && (
          <>
            <TextField label="Name" value={name} onChange={e => setName(e.target.value)} size="small" fullWidth />
            <TextField
              label="Description" value={description}
              onChange={e => setDescription(e.target.value)}
              size="small" fullWidth multiline rows={2}
            />
            <FormControl size="small" fullWidth>
              <InputLabel>Transform type</InputLabel>
              <Select
                label="Transform type"
                value={transformType}
                onChange={e => setTransformType(e.target.value as 'sql' | 'notebook')}
              >
                <MenuItem value="notebook">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <LibraryBooks fontSize="small" sx={{ color: '#8b5cf6' }} />
                    <Typography sx={{ fontSize: '0.88rem' }}>Notebook</Typography>
                  </Box>
                </MenuItem>
                <MenuItem value="sql">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Code fontSize="small" sx={{ color: '#3b82f6' }} />
                    <Typography sx={{ fontSize: '0.88rem' }}>SQL</Typography>
                  </Box>
                </MenuItem>
              </Select>
            </FormControl>

            {transformType === 'notebook' ? (
              <FormControl size="small" fullWidth>
                <InputLabel>Notebook</InputLabel>
                <Select
                  label="Notebook"
                  value={notebookFileId}
                  onChange={e => setNotebookFileId(Number(e.target.value))}
                >
                  <MenuItem value=""><em>None</em></MenuItem>
                  {notebooks.map(n => (
                    <MenuItem key={n.id} value={n.id}>
                      <Typography sx={{ fontSize: '0.85rem' }}>{n.name}</Typography>
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            ) : (
              <FormControl size="small" fullWidth>
                <InputLabel>SQL File</InputLabel>
                <Select
                  label="SQL File"
                  value={sqlFileId}
                  onChange={e => setSqlFileId(Number(e.target.value))}
                >
                  <MenuItem value=""><em>None</em></MenuItem>
                  {sqlFiles.filter(f => f.file_type === 'transform').map(f => (
                    <MenuItem key={f.id} value={f.id}>
                      <Typography sx={{ fontSize: '0.85rem' }}>{f.name}</Typography>
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}
          </>
        )}

        {tab === 1 && (
          <>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>Source</Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                label="Database" value={sourceDb}
                onChange={e => setSourceDb(e.target.value)}
                size="small" sx={{ flex: 1 }} placeholder="default"
              />
              <TextField
                label="Table *" value={sourceTable}
                onChange={e => setSourceTable(e.target.value)}
                size="small" sx={{ flex: 2 }}
              />
            </Box>
            <Divider />
            <Typography variant="caption" color="text.secondary" fontWeight={600}>Target</Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                label="Database" value={targetDb}
                onChange={e => setTargetDb(e.target.value)}
                size="small" sx={{ flex: 1 }} placeholder="default"
              />
              <TextField
                label="Table *" value={targetTable}
                onChange={e => setTargetTable(e.target.value)}
                size="small" sx={{ flex: 2 }}
              />
            </Box>
            <FormControl size="small" fullWidth>
              <InputLabel>Write mode</InputLabel>
              <Select label="Write mode" value={targetMode} onChange={e => setTargetMode(e.target.value)}>
                <MenuItem value="overwrite">Overwrite</MenuItem>
                <MenuItem value="append">Append</MenuItem>
                <MenuItem value="ignore">Ignore if exists</MenuItem>
                <MenuItem value="error">Error if exists</MenuItem>
              </Select>
            </FormControl>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <Box>
          {initial && onDelete && (
            <Button color="error" onClick={handleDelete} disabled={deleting} size="small">
              {deleting ? <CircularProgress size={16} /> : 'Delete'}
            </Button>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="contained" onClick={handleSave} disabled={saving}>
            {saving ? <CircularProgress size={18} /> : 'Save'}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function TransformJobs() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [newOpen, setNewOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<TransformJob | null>(null)
  const [runStatus, setRunStatus] = useState<Record<number, 'running' | 'done' | 'error'>>({})

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['transform-jobs'],
    queryFn: transformApi.listJobs,
  })

  const createMut = useMutation({
    mutationFn: (data: Partial<TransformJob>) => transformApi.createJob(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transform-jobs'] }),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<TransformJob> }) =>
      transformApi.updateJob(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transform-jobs'] }),
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => transformApi.deleteJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transform-jobs'] }),
  })
  const runMut = useMutation({
    mutationFn: (id: number) => transformApi.runJob(id),
    onSuccess: (_, id) => { setRunStatus(m => ({ ...m, [id]: 'done' })) },
    onError: (_, id) => { setRunStatus(m => ({ ...m, [id]: 'error' })) },
  })

  function handleRun(id: number) {
    setRunStatus(m => ({ ...m, [id]: 'running' }))
    runMut.mutate(id)
  }

  if (isLoading) return (
    <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>
  )

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 3 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>Transform Jobs</Typography>
          <Typography variant="body2" color="text.secondary">
            Reusable notebook or SQL steps that can be run standalone or as part of a Workflow
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<Add />} onClick={() => setNewOpen(true)}>
          New Job
        </Button>
      </Box>

      {jobs.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 10, color: 'text.secondary' }}>
          <PlayCircleOutlined sx={{ fontSize: 52, opacity: 0.25, mb: 2 }} />
          <Typography variant="body1">No transform jobs yet.</Typography>
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            Create a job to run a notebook or SQL transform on your data.
          </Typography>
        </Box>
      ) : (
        <Grid container spacing={2}>
          {jobs.map(job => {
            const rs = runStatus[job.id]
            const isRunning = rs === 'running'
            const isNotebook = job.transform_type === 'notebook'
            return (
              <Grid item xs={12} md={6} lg={4} key={job.id}>
                <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                  <CardContent sx={{ flex: 1 }}>
                    {/* Header */}
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1.5 }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="subtitle1" fontWeight={600} noWrap>{job.name}</Typography>
                        {job.description && (
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                            {job.description}
                          </Typography>
                        )}
                      </Box>
                      <Chip
                        icon={isNotebook
                          ? <LibraryBooks sx={{ fontSize: '0.75rem !important' }} />
                          : <Code sx={{ fontSize: '0.75rem !important' }} />}
                        label={isNotebook ? 'notebook' : 'sql'}
                        size="small"
                        sx={{
                          fontSize: '0.62rem', height: 20,
                          bgcolor: alpha(isNotebook ? '#8b5cf6' : '#3b82f6', 0.12),
                          color: isNotebook ? '#8b5cf6' : '#3b82f6',
                          border: 'none',
                        }}
                      />
                    </Box>

                    {/* Source → Target */}
                    <Box sx={{
                      display: 'flex', alignItems: 'center', gap: 0.75, mb: 1.5,
                      p: 1, borderRadius: 1,
                      bgcolor: alpha(theme.palette.background.default, 0.5),
                      border: `1px solid ${theme.palette.divider}`,
                    }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.6rem', textTransform: 'uppercase' }}>Source</Typography>
                        <Typography sx={{ fontSize: '0.78rem', fontFamily: '"JetBrains Mono", monospace' }} noWrap>
                          {job.source_database ? `${job.source_database}.` : ''}{job.source_table}
                        </Typography>
                      </Box>
                      <Typography color="text.disabled" sx={{ fontSize: '0.9rem' }}>→</Typography>
                      <Box sx={{ flex: 1, minWidth: 0, textAlign: 'right' }}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.6rem', textTransform: 'uppercase' }}>Target</Typography>
                        <Typography sx={{ fontSize: '0.78rem', fontFamily: '"JetBrains Mono", monospace' }} noWrap>
                          {job.target_database ? `${job.target_database}.` : ''}{job.target_table}
                        </Typography>
                      </Box>
                    </Box>

                    {/* Transform resource */}
                    {(job.notebook_file_name || job.sql_file_name) && (
                      <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary', mb: 1 }}>
                        {isNotebook ? '📓' : '📄'} {job.notebook_file_name ?? job.sql_file_name}
                      </Typography>
                    )}

                    {/* Run status */}
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                      <StatusChip status={job.status} />
                      {rs === 'done' && (
                        <Chip icon={<CheckCircleOutlined sx={{ fontSize: '0.8rem !important' }} />}
                          label="Run complete" size="small" color="success" variant="outlined" sx={{ fontSize: '0.65rem', height: 20 }} />
                      )}
                      {rs === 'error' && (
                        <Chip icon={<ErrorOutlined sx={{ fontSize: '0.8rem !important' }} />}
                          label="Run failed" size="small" color="error" variant="outlined" sx={{ fontSize: '0.65rem', height: 20 }} />
                      )}
                    </Box>

                    {/* Last run info */}
                    {job.last_run_at && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
                        <Schedule sx={{ fontSize: 12, color: 'text.disabled' }} />
                        <Typography sx={{ fontSize: '0.7rem', color: 'text.disabled' }}>
                          {fmt(job.last_run_at)}
                          {job.last_run_duration_s != null && ` · ${fmtDur(job.last_run_duration_s)}`}
                          {job.last_run_rows != null && ` · ${job.last_run_rows.toLocaleString()} rows`}
                        </Typography>
                      </Box>
                    )}
                    {job.last_error && (
                      <Typography sx={{ fontSize: '0.7rem', color: 'error.main', mt: 0.5 }} noWrap>
                        {job.last_error}
                      </Typography>
                    )}
                  </CardContent>
                  <CardActions sx={{ pt: 0, justifyContent: 'space-between' }}>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <Tooltip title="Run job">
                        <IconButton size="small" color="primary" onClick={() => handleRun(job.id)} disabled={isRunning}>
                          {isRunning ? <CircularProgress size={14} /> : <PlayArrow fontSize="small" />}
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => setEditTarget(job)}>
                          <Edit fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                    <Chip
                      label={job.target_mode}
                      size="small"
                      variant="outlined"
                      sx={{ fontSize: '0.6rem', height: 18 }}
                    />
                  </CardActions>
                </Card>
              </Grid>
            )
          })}
        </Grid>
      )}

      <JobDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onSave={async data => { await createMut.mutateAsync(data) }}
      />
      {editTarget && (
        <JobDialog
          open
          onClose={() => setEditTarget(null)}
          initial={editTarget}
          onSave={async data => { await updateMut.mutateAsync({ id: editTarget.id, data }) }}
          onDelete={async () => { await deleteMut.mutateAsync(editTarget.id) }}
        />
      )}
    </Box>
  )
}
