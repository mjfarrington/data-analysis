import { useState, useEffect, useCallback } from 'react'
import {
  Box, Typography, Button, TextField, CircularProgress, Chip, alpha,
  useTheme, IconButton, Alert, Paper, Divider, List, ListItemButton,
  ListItemIcon, ListItemText, ListSubheader, Select, MenuItem, FormControl,
  InputLabel, Dialog, DialogTitle, DialogContent, DialogActions,
  ToggleButton, ToggleButtonGroup, Tooltip, Stack,
} from '@mui/material'
import {
  Add, PlayArrow, Stop, Save, Delete, Code, NoteAlt, Refresh,
  CheckCircle, Error as ErrorIcon, HourglassBottom, RadioButtonUnchecked,
  FolderOpen, TableChart, AddCircleOutline, DeleteOutline, Close,
  Visibility,
} from '@mui/icons-material'
import {
  Table, TableHead, TableBody, TableRow, TableCell,
} from '@mui/material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import {
  sqlFilesApi, notebookFilesApi, transformJobsApi,
  SqlFile, NotebookFile, NotebookCell, TransformJob, TransformType, WriteMode,
} from '../api/client'
import { dataApi } from '../api/client'
import { formatDistanceToNow } from 'date-fns'
import { parseApiDate } from '../utils/dates'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONO = '"JetBrains Mono", "Fira Code", monospace'

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { color: 'success' | 'error' | 'warning' | 'default'; icon: JSX.Element }> = {
    completed: { color: 'success', icon: <CheckCircle sx={{ fontSize: 14 }} /> },
    failed: { color: 'error', icon: <ErrorIcon sx={{ fontSize: 14 }} /> },
    running: { color: 'warning', icon: <HourglassBottom sx={{ fontSize: 14 }} /> },
    idle: { color: 'default', icon: <RadioButtonUnchecked sx={{ fontSize: 14 }} /> },
  }
  const { color, icon } = map[status] ?? map.idle
  return (
    <Chip
      icon={icon}
      label={status}
      color={color}
      size="small"
      variant="outlined"
      sx={{ fontFamily: MONO, fontSize: '0.7rem', textTransform: 'capitalize' }}
    />
  )
}

// ─── Notebook cell editor ─────────────────────────────────────────────────────

function NotebookEditor({
  cells,
  onChange,
}: {
  cells: NotebookCell[]
  onChange: (cells: NotebookCell[]) => void
}) {
  const theme = useTheme()

  const update = (idx: number, patch: Partial<NotebookCell>) => {
    const next = cells.map((c, i) => (i === idx ? { ...c, ...patch } : c))
    onChange(next)
  }

  const insert = (idx: number) => {
    const next = [...cells]
    next.splice(idx + 1, 0, { type: 'code', source: '' })
    onChange(next)
  }

  const remove = (idx: number) => {
    onChange(cells.filter((_, i) => i !== idx))
  }

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 1 }}>
      {cells.length === 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', pt: 4 }}>
          <Button
            startIcon={<AddCircleOutline />}
            onClick={() => onChange([{ type: 'code', source: '' }])}
            size="small"
          >
            Add first cell
          </Button>
        </Box>
      )}
      {cells.map((cell, idx) => (
        <Box key={idx} sx={{ mb: 1.5 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              mb: 0.5,
              px: 0.5,
            }}
          >
            <ToggleButtonGroup
              value={cell.type}
              exclusive
              size="small"
              onChange={(_, val) => val && update(idx, { type: val })}
            >
              <ToggleButton value="code" sx={{ py: 0.25, px: 1, fontSize: '0.65rem' }}>
                Code
              </ToggleButton>
              <ToggleButton value="markdown" sx={{ py: 0.25, px: 1, fontSize: '0.65rem' }}>
                MD
              </ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1, ml: 0.5 }}>
              Cell {idx + 1}
              {idx === cells.length - 1 && cell.type === 'code' && (
                <span style={{ color: theme.palette.warning.main }}> — assign result_df here</span>
              )}
            </Typography>
            <Tooltip title="Insert cell below">
              <IconButton size="small" onClick={() => insert(idx)}>
                <AddCircleOutline sx={{ fontSize: 15 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Remove cell">
              <IconButton size="small" onClick={() => remove(idx)}>
                <DeleteOutline sx={{ fontSize: 15 }} />
              </IconButton>
            </Tooltip>
          </Box>
          <TextField
            fullWidth
            multiline
            minRows={3}
            maxRows={20}
            value={cell.source}
            onChange={(e) => update(idx, { source: e.target.value })}
            placeholder={
              cell.type === 'code'
                ? '# Python code — spark and source_df are available\nresult_df = source_df.filter(...)'
                : 'Markdown notes...'
            }
            InputProps={{
              sx: {
                fontFamily: cell.type === 'code' ? MONO : 'inherit',
                fontSize: '0.8rem',
                bgcolor: alpha(
                  cell.type === 'code'
                    ? theme.palette.primary.main
                    : theme.palette.text.primary,
                  0.04,
                ),
              },
            }}
          />
        </Box>
      ))}
    </Box>
  )
}

// ─── SQL editor panel ─────────────────────────────────────────────────────────

function SqlEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const theme = useTheme()
  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', p: 1 }}>
      <Alert
        severity="info"
        icon={false}
        sx={{ mb: 1, py: 0.5, fontSize: '0.75rem' }}
      >
        Write a SQL query that SELECTs from the virtual table named{' '}
        <code style={{ fontFamily: MONO }}>source</code>. The result will be written to the target table.
      </Alert>
      <TextField
        fullWidth
        multiline
        minRows={12}
        maxRows={40}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'SELECT *\nFROM source\nWHERE ...'}
        InputProps={{
          sx: {
            fontFamily: MONO,
            fontSize: '0.82rem',
            flex: 1,
            alignItems: 'flex-start',
          },
        }}
        sx={{ flex: 1 }}
      />
    </Box>
  )
}

// ─── Job form dialog ──────────────────────────────────────────────────────────

interface JobFormDialogProps {
  open: boolean
  onClose: () => void
  initial?: Partial<TransformJob>
  onSave: (data: Omit<TransformJob, 'id' | 'status' | 'last_run_at' | 'last_run_duration_s' | 'last_run_rows' | 'last_error' | 'created_at' | 'updated_at' | 'sql_file_name' | 'notebook_file_name'>) => void
  saving: boolean
}

function JobFormDialog({ open, onClose, initial, onSave, saving }: JobFormDialogProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [sourceDb, setSourceDb] = useState(initial?.source_database ?? '')
  const [sourceTable, setSourceTable] = useState(initial?.source_table ?? '')
  const [transformType, setTransformType] = useState<TransformType>(initial?.transform_type ?? 'sql')
  const [sqlFileId, setSqlFileId] = useState<number | ''>(initial?.sql_file_id ?? '')
  const [notebookFileId, setNotebookFileId] = useState<number | ''>(initial?.notebook_file_id ?? '')
  const [targetDb, setTargetDb] = useState(initial?.target_database ?? '')
  const [targetTable, setTargetTable] = useState(initial?.target_table ?? '')
  const [targetMode, setTargetMode] = useState<WriteMode>(initial?.target_mode ?? 'overwrite')

  const { data: sqlFiles } = useQuery({ queryKey: ['sql-files'], queryFn: () => sqlFilesApi.list().then((r) => r.data) })
  const { data: notebooks } = useQuery({ queryKey: ['notebook-files'], queryFn: () => notebookFilesApi.list().then((r) => r.data) })
  const { data: catalog } = useQuery({ queryKey: ['catalog'], queryFn: () => dataApi.catalog().then((r) => r.data) })

  const dbs = [...new Set((catalog ?? []).map((t) => t.database ?? '').filter(Boolean))]

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '')
      setDescription(initial?.description ?? '')
      setSourceDb(initial?.source_database ?? '')
      setSourceTable(initial?.source_table ?? '')
      setTransformType(initial?.transform_type ?? 'sql')
      setSqlFileId(initial?.sql_file_id ?? '')
      setNotebookFileId(initial?.notebook_file_id ?? '')
      setTargetDb(initial?.target_database ?? '')
      setTargetTable(initial?.target_table ?? '')
      setTargetMode(initial?.target_mode ?? 'overwrite')
    }
  }, [open, initial])

  const sourceTablesInDb = (catalog ?? [])
    .filter((t) => !sourceDb || t.database === sourceDb)
    .map((t) => t.name)

  const valid = name.trim() && sourceTable.trim() && targetTable.trim()

  const handleSave = () => {
    onSave({
      name: name.trim(),
      description: description.trim() || undefined,
      source_database: sourceDb || undefined,
      source_table: sourceTable.trim(),
      transform_type: transformType,
      sql_content: undefined,
      sql_file_id: sqlFileId !== '' ? Number(sqlFileId) : undefined,
      notebook_file_id: notebookFileId !== '' ? Number(notebookFileId) : undefined,
      target_database: targetDb || undefined,
      target_table: targetTable.trim(),
      target_mode: targetMode,
      tags: [],
    })
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial?.id ? 'Edit Transform Job' : 'New Transform Job'}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1.5 }}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required fullWidth size="small" />
        <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth size="small" />
        <Divider><Typography variant="caption" color="text.secondary">Source</Typography></Divider>
        <Stack direction="row" spacing={1}>
          <FormControl size="small" sx={{ flex: 1 }}>
            <InputLabel>Source Database</InputLabel>
            <Select value={sourceDb} label="Source Database" onChange={(e) => { setSourceDb(e.target.value); setSourceTable('') }}>
              <MenuItem value=""><em>Any / default</em></MenuItem>
              {dbs.map((d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ flex: 1 }}>
            <InputLabel>Source Table *</InputLabel>
            <Select value={sourceTable} label="Source Table *" onChange={(e) => setSourceTable(e.target.value)}>
              {sourceTablesInDb.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
            </Select>
          </FormControl>
        </Stack>
        <Divider><Typography variant="caption" color="text.secondary">Transformation</Typography></Divider>
        <FormControl size="small" fullWidth>
          <InputLabel>Transform Type</InputLabel>
          <Select value={transformType} label="Transform Type" onChange={(e) => setTransformType(e.target.value as TransformType)}>
            <MenuItem value="sql">SQL File</MenuItem>
            <MenuItem value="notebook">Python Notebook</MenuItem>
          </Select>
        </FormControl>
        {transformType === 'sql' ? (
          <FormControl size="small" fullWidth>
            <InputLabel>SQL File</InputLabel>
            <Select value={sqlFileId} label="SQL File" onChange={(e) => setSqlFileId(e.target.value as number | '')}>
              <MenuItem value=""><em>None (use inline SQL on job)</em></MenuItem>
              {(sqlFiles ?? []).map((f) => <MenuItem key={f.id} value={f.id}>{f.name}</MenuItem>)}
            </Select>
          </FormControl>
        ) : (
          <FormControl size="small" fullWidth>
            <InputLabel>Notebook</InputLabel>
            <Select value={notebookFileId} label="Notebook" onChange={(e) => setNotebookFileId(e.target.value as number | '')}>
              <MenuItem value=""><em>None — create one first</em></MenuItem>
              {(notebooks ?? []).map((n) => <MenuItem key={n.id} value={n.id}>{n.name}</MenuItem>)}
            </Select>
          </FormControl>
        )}
        <Divider><Typography variant="caption" color="text.secondary">Target</Typography></Divider>
        <Stack direction="row" spacing={1}>
          <FormControl size="small" sx={{ flex: 1 }}>
            <InputLabel>Target Database</InputLabel>
            <Select value={targetDb} label="Target Database" onChange={(e) => setTargetDb(e.target.value)}>
              <MenuItem value=""><em>Default</em></MenuItem>
              {dbs.map((d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
            </Select>
          </FormControl>
          <TextField label="Target Table *" value={targetTable} onChange={(e) => setTargetTable(e.target.value)} required size="small" sx={{ flex: 1 }} />
        </Stack>
        <FormControl size="small" fullWidth>
          <InputLabel>Write Mode</InputLabel>
          <Select value={targetMode} label="Write Mode" onChange={(e) => setTargetMode(e.target.value as WriteMode)}>
            <MenuItem value="overwrite">Overwrite</MenuItem>
            <MenuItem value="append">Append</MenuItem>
          </Select>
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={!valid || saving}>
          {saving ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Notebook file dialog ─────────────────────────────────────────────────────

function NotebookFileDialog({
  open,
  onClose,
  initial,
  onSave,
  saving,
}: {
  open: boolean
  onClose: () => void
  initial?: NotebookFile
  onSave: (data: Omit<NotebookFile, 'id' | 'created_at' | 'updated_at'>) => void
  saving: boolean
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [cells, setCells] = useState<NotebookCell[]>(initial?.cells ?? [{ type: 'code', source: '' }])

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '')
      setDescription(initial?.description ?? '')
      setCells(initial?.cells ?? [{ type: 'code', source: '' }])
    }
  }, [open, initial])

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { height: '85vh' } }}>
      <DialogTitle sx={{ pb: 1 }}>
        {initial?.id ? 'Edit Notebook' : 'New Notebook'}
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 1 }}>
        <Stack direction="row" spacing={1}>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required size="small" sx={{ flex: 2 }} />
          <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} size="small" sx={{ flex: 3 }} />
        </Stack>
        <Divider />
        <NotebookEditor cells={cells} onChange={setCells} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => onSave({ name: name.trim(), description: description.trim() || undefined, cells })}
          disabled={!name.trim() || saving}
        >
          {saving ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TransformJobs() {
  const theme = useTheme()
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()

  // ── Selection state ──
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null)
  const [selectedSqlFileId, setSelectedSqlFileId] = useState<number | null>(null)
  const [selectedNotebookId, setSelectedNotebookId] = useState<number | null>(null)
  const [editorTab, setEditorTab] = useState<'sql' | 'notebook'>('sql')

  // ── Dialog state ──
  const [jobDialogOpen, setJobDialogOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<TransformJob | null>(null)
  const [nbDialogOpen, setNbDialogOpen] = useState(false)
  const [editingNb, setEditingNb] = useState<NotebookFile | null>(null)
  const [deleteJobId, setDeleteJobId] = useState<number | null>(null)
  const [deleteNbId, setDeleteNbId] = useState<number | null>(null)

  // ── Preview state ──
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewJob, setPreviewJob] = useState<TransformJob | null>(null)
  const [previewResult, setPreviewResult] = useState<{ columns: string[]; rows: unknown[][]; row_count: number; duration_ms: number } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // ── Inline editor state (for the selected SQL file / notebook) ──
  const [sqlDraft, setSqlDraft] = useState('')
  const [nbCellsDraft, setNbCellsDraft] = useState<NotebookCell[]>([])
  const [draftDirty, setDraftDirty] = useState(false)

  // ── Queries ──
  const { data: jobs = [], isLoading: jobsLoading } = useQuery({
    queryKey: ['transform-jobs'],
    queryFn: () => transformJobsApi.list().then((r) => r.data),
    refetchInterval: 5000,
  })

  const { data: sqlFiles = [] } = useQuery({
    queryKey: ['sql-files'],
    queryFn: () => sqlFilesApi.list().then((r) => r.data),
  })

  const { data: notebooks = [] } = useQuery({
    queryKey: ['notebook-files'],
    queryFn: () => notebookFilesApi.list().then((r) => r.data),
  })

  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null

  // Load SQL file into draft when selected
  useEffect(() => {
    if (selectedSqlFileId !== null) {
      const sf = sqlFiles.find((f) => f.id === selectedSqlFileId)
      if (sf) { setSqlDraft(sf.content); setDraftDirty(false) }
    }
  }, [selectedSqlFileId, sqlFiles])

  // Load notebook cells into draft when selected
  useEffect(() => {
    if (selectedNotebookId !== null) {
      const nb = notebooks.find((n) => n.id === selectedNotebookId)
      if (nb) { setNbCellsDraft(nb.cells ?? []); setDraftDirty(false) }
    }
  }, [selectedNotebookId, notebooks])

  // ── Mutations ──
  const createJob = useMutation({
    mutationFn: transformJobsApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transform-jobs'] }); setJobDialogOpen(false); enqueueSnackbar('Job created', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to create job', { variant: 'error' }),
  })

  const updateJob = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof transformJobsApi.update>[1] }) => transformJobsApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transform-jobs'] }); setJobDialogOpen(false); enqueueSnackbar('Job saved', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to save job', { variant: 'error' }),
  })

  const deleteJob = useMutation({
    mutationFn: transformJobsApi.delete,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transform-jobs'] }); setDeleteJobId(null); if (selectedJobId === deleteJobId) setSelectedJobId(null); enqueueSnackbar('Job deleted', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to delete job', { variant: 'error' }),
  })

  const runJob = useMutation({
    mutationFn: transformJobsApi.run,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transform-jobs'] }); enqueueSnackbar('Job started', { variant: 'info' }) },
    onError: () => enqueueSnackbar('Failed to start job', { variant: 'error' }),
  })

  const createNb = useMutation({
    mutationFn: notebookFilesApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['notebook-files'] }); setNbDialogOpen(false); enqueueSnackbar('Notebook created', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to create notebook', { variant: 'error' }),
  })

  const updateNb = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof notebookFilesApi.update>[1] }) => notebookFilesApi.update(id, data),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['notebook-files'] })
      if (selectedNotebookId === res.data.id) { setNbCellsDraft(res.data.cells); setDraftDirty(false) }
      setNbDialogOpen(false)
      enqueueSnackbar('Notebook saved', { variant: 'success' })
    },
    onError: () => enqueueSnackbar('Failed to save notebook', { variant: 'error' }),
  })

  const deleteNb = useMutation({
    mutationFn: notebookFilesApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notebook-files'] })
      setDeleteNbId(null)
      if (selectedNotebookId === deleteNbId) setSelectedNotebookId(null)
      enqueueSnackbar('Notebook deleted', { variant: 'success' })
    },
    onError: () => enqueueSnackbar('Failed to delete notebook', { variant: 'error' }),
  })

  const saveSqlDraft = useMutation({
    mutationFn: () => sqlFilesApi.update(selectedSqlFileId!, { content: sqlDraft }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sql-files'] }); setDraftDirty(false); enqueueSnackbar('SQL saved', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to save SQL file', { variant: 'error' }),
  })

  const saveNbDraft = useMutation({
    mutationFn: () => notebookFilesApi.update(selectedNotebookId!, { cells: nbCellsDraft }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['notebook-files'] }); setDraftDirty(false); enqueueSnackbar('Notebook saved', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to save notebook', { variant: 'error' }),
  })

  const runPreview = useMutation({
    mutationFn: (job: TransformJob) => {
      // Resolve content from current draft if a file is selected in the editor
      const sqlContent = editorTab === 'sql' && selectedSqlFileId
        ? sqlDraft
        : job.sql_content ?? undefined
      const cells = editorTab === 'notebook' && selectedNotebookId
        ? nbCellsDraft
        : undefined
      return transformJobsApi.preview({
        source_database: job.source_database,
        source_table: job.source_table,
        transform_type: job.transform_type,
        sql_content: sqlContent,
        cells,
        limit: 100,
      })
    },
    onSuccess: (res) => { setPreviewResult(res.data); setPreviewError(null) },
    onError: (err: any) => {
      setPreviewResult(null)
      setPreviewError(err?.response?.data?.detail ?? 'Preview failed')
    },
  })

  const openPreview = (job: TransformJob) => {
    setPreviewJob(job)
    setPreviewResult(null)
    setPreviewError(null)
    setPreviewOpen(true)
    runPreview.mutate(job)
  }

  // ── Derived ──
  const panelBg = alpha(theme.palette.background.paper, 0.5)

  const handleJobSave = useCallback((data: Parameters<typeof createJob.mutate>[0]) => {
    if (editingJob?.id) updateJob.mutate({ id: editingJob.id, data })
    else createJob.mutate(data)
  }, [editingJob, createJob, updateJob])

  const handleNbSave = useCallback((data: Parameters<typeof createNb.mutate>[0]) => {
    if (editingNb?.id) updateNb.mutate({ id: editingNb.id, data })
    else createNb.mutate(data)
  }, [editingNb, createNb, updateNb])

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden', gap: 0 }}>
      {/* ── Left panel: file browser ── */}
      <Paper
        elevation={0}
        sx={{
          width: 240,
          flexShrink: 0,
          borderRight: `1px solid ${theme.palette.divider}`,
          display: 'flex',
          flexDirection: 'column',
          bgcolor: panelBg,
          overflow: 'hidden',
        }}
      >
        {/* SQL Files section */}
        <List
          dense
          subheader={
            <ListSubheader
              sx={{
                bgcolor: 'transparent',
                display: 'flex',
                alignItems: 'center',
                pr: 0.5,
                lineHeight: '36px',
                fontSize: '0.7rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'text.secondary',
              }}
            >
              <Code sx={{ fontSize: 14, mr: 0.5 }} />
              SQL Files
              <Box sx={{ flex: 1 }} />
              <Tooltip title="New SQL file">
                <IconButton
                  size="small"
                  onClick={() => {
                    sqlFilesApi.create({ name: 'new-transform.sql', file_type: 'transform', content: 'SELECT *\nFROM source' }).then((r) => {
                      qc.invalidateQueries({ queryKey: ['sql-files'] })
                      setSelectedSqlFileId(r.data.id)
                      setEditorTab('sql')
                    })
                  }}
                >
                  <Add sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </ListSubheader>
          }
          sx={{ overflowY: 'auto', maxHeight: '40%' }}
        >
          {sqlFiles.map((sf) => (
            <ListItemButton
              key={sf.id}
              dense
              selected={selectedSqlFileId === sf.id && editorTab === 'sql'}
              onClick={() => { setSelectedSqlFileId(sf.id); setEditorTab('sql') }}
              sx={{ pl: 2, py: 0.25 }}
            >
              <ListItemIcon sx={{ minWidth: 24 }}>
                <Code sx={{ fontSize: 14, color: 'primary.main' }} />
              </ListItemIcon>
              <ListItemText
                primary={sf.name}
                primaryTypographyProps={{ variant: 'caption', noWrap: true, sx: { fontFamily: MONO } }}
              />
            </ListItemButton>
          ))}
        </List>

        <Divider />

        {/* Notebook Files section */}
        <List
          dense
          subheader={
            <ListSubheader
              sx={{
                bgcolor: 'transparent',
                display: 'flex',
                alignItems: 'center',
                pr: 0.5,
                lineHeight: '36px',
                fontSize: '0.7rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'text.secondary',
              }}
            >
              <NoteAlt sx={{ fontSize: 14, mr: 0.5 }} />
              Notebooks
              <Box sx={{ flex: 1 }} />
              <Tooltip title="New notebook">
                <IconButton size="small" onClick={() => { setEditingNb(null); setNbDialogOpen(true) }}>
                  <Add sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </ListSubheader>
          }
          sx={{ overflowY: 'auto', flex: 1 }}
        >
          {notebooks.map((nb) => (
            <ListItemButton
              key={nb.id}
              dense
              selected={selectedNotebookId === nb.id && editorTab === 'notebook'}
              onClick={() => { setSelectedNotebookId(nb.id); setEditorTab('notebook') }}
              sx={{ pl: 2, py: 0.25 }}
            >
              <ListItemIcon sx={{ minWidth: 24 }}>
                <NoteAlt sx={{ fontSize: 14, color: 'warning.main' }} />
              </ListItemIcon>
              <ListItemText
                primary={nb.name}
                primaryTypographyProps={{ variant: 'caption', noWrap: true, sx: { fontFamily: MONO } }}
              />
              <Tooltip title="Edit metadata">
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditingNb(nb)
                    setNbDialogOpen(true)
                  }}
                >
                  <FolderOpen sx={{ fontSize: 13 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Delete notebook">
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleteNbId(nb.id)
                  }}
                >
                  <DeleteOutline sx={{ fontSize: 13 }} />
                </IconButton>
              </Tooltip>
            </ListItemButton>
          ))}
        </List>
      </Paper>

      {/* ── Centre panel: editor ── */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Editor toolbar */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 1.5,
            py: 0.75,
            borderBottom: `1px solid ${theme.palette.divider}`,
            bgcolor: panelBg,
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
            {editorTab === 'sql' && selectedSqlFileId
              ? sqlFiles.find((f) => f.id === selectedSqlFileId)?.name ?? '—'
              : editorTab === 'notebook' && selectedNotebookId
              ? notebooks.find((n) => n.id === selectedNotebookId)?.name ?? '—'
              : 'Select a file from the browser'}
          </Typography>
          {draftDirty && (
            <Chip label="unsaved" size="small" color="warning" variant="outlined" sx={{ fontSize: '0.65rem', height: 18 }} />
          )}
          <Box sx={{ flex: 1 }} />
          {draftDirty && editorTab === 'sql' && selectedSqlFileId && (
            <Button
              size="small"
              startIcon={saveSqlDraft.isPending ? <CircularProgress size={12} /> : <Save />}
              onClick={() => saveSqlDraft.mutate()}
              variant="outlined"
              disabled={saveSqlDraft.isPending}
            >
              Save
            </Button>
          )}
          {draftDirty && editorTab === 'notebook' && selectedNotebookId && (
            <Button
              size="small"
              startIcon={saveNbDraft.isPending ? <CircularProgress size={12} /> : <Save />}
              onClick={() => saveNbDraft.mutate()}
              variant="outlined"
              disabled={saveNbDraft.isPending}
            >
              Save
            </Button>
          )}
        </Box>

        {/* Editor body */}
        <Box sx={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          {editorTab === 'sql' && selectedSqlFileId && (
            <SqlEditor
              value={sqlDraft}
              onChange={(v) => { setSqlDraft(v); setDraftDirty(true) }}
            />
          )}
          {editorTab === 'notebook' && selectedNotebookId && (
            <NotebookEditor
              cells={nbCellsDraft}
              onChange={(c) => { setNbCellsDraft(c); setDraftDirty(true) }}
            />
          )}
          {!((editorTab === 'sql' && selectedSqlFileId) || (editorTab === 'notebook' && selectedNotebookId)) && (
            <Box
              sx={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'text.disabled',
                gap: 1,
              }}
            >
              <FolderOpen sx={{ fontSize: 48 }} />
              <Typography variant="body2">Select a SQL file or Notebook from the browser on the left</Typography>
            </Box>
          )}
        </Box>
      </Box>

      {/* ── Right panel: jobs ── */}
      <Paper
        elevation={0}
        sx={{
          width: 320,
          flexShrink: 0,
          borderLeft: `1px solid ${theme.palette.divider}`,
          display: 'flex',
          flexDirection: 'column',
          bgcolor: panelBg,
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 1.5,
            py: 0.75,
            borderBottom: `1px solid ${theme.palette.divider}`,
          }}
        >
          <Typography variant="subtitle2" fontWeight={600}>Transform Jobs</Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="Refresh">
            <IconButton size="small" onClick={() => qc.invalidateQueries({ queryKey: ['transform-jobs'] })}>
              <Refresh sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Button
            size="small"
            startIcon={<Add />}
            onClick={() => { setEditingJob(null); setJobDialogOpen(true) }}
            variant="contained"
            sx={{ py: 0.25, px: 1 }}
          >
            New
          </Button>
        </Box>

        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {jobsLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', pt: 4 }}>
              <CircularProgress size={24} />
            </Box>
          )}
          {!jobsLoading && jobs.length === 0 && (
            <Box sx={{ textAlign: 'center', pt: 6, px: 2, color: 'text.secondary' }}>
              <TableChart sx={{ fontSize: 40, mb: 1 }} />
              <Typography variant="body2">No transform jobs yet</Typography>
              <Typography variant="caption">Click "New" to create one</Typography>
            </Box>
          )}
          {jobs.map((job) => (
            <Box
              key={job.id}
              onClick={() => setSelectedJobId(job.id === selectedJobId ? null : job.id)}
              sx={{
                px: 1.5,
                py: 1,
                cursor: 'pointer',
                borderBottom: `1px solid ${theme.palette.divider}`,
                bgcolor: selectedJobId === job.id ? alpha(theme.palette.primary.main, 0.08) : 'transparent',
                '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.05) },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Typography variant="subtitle2" fontWeight={600} sx={{ flex: 1, fontSize: '0.82rem' }} noWrap>
                  {job.name}
                </Typography>
                <StatusChip status={job.status} />
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO, display: 'block' }} noWrap>
                {job.source_database ? `${job.source_database}.` : ''}{job.source_table}
                {' → '}
                {job.target_database ? `${job.target_database}.` : ''}{job.target_table}
              </Typography>
              {job.last_run_at && (
                <Typography variant="caption" color="text.secondary">
                  Last run {formatDistanceToNow(parseApiDate(job.last_run_at), { addSuffix: true })}
                  {job.last_run_rows != null && ` · ${job.last_run_rows.toLocaleString()} rows`}
                  {job.last_run_duration_s != null && ` · ${job.last_run_duration_s.toFixed(1)}s`}
                </Typography>
              )}
              {job.last_error && (
                <Alert severity="error" icon={false} sx={{ mt: 0.5, py: 0, px: 0.75, fontSize: '0.7rem' }}>
                  {job.last_error}
                </Alert>
              )}
              {selectedJobId === job.id && (
                <Box sx={{ display: 'flex', gap: 0.75, mt: 1, flexWrap: 'wrap' }}>
                  <Button
                    size="small"
                    variant="contained"
                    color="success"
                    startIcon={job.status === 'running' ? <CircularProgress size={12} color="inherit" /> : <PlayArrow />}
                    disabled={job.status === 'running' || runJob.isPending}
                    onClick={(e) => { e.stopPropagation(); runJob.mutate(job.id) }}
                    sx={{ py: 0.25 }}
                  >
                    Run
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    color="info"
                    startIcon={runPreview.isPending && previewJob?.id === job.id ? <CircularProgress size={12} color="inherit" /> : <Visibility />}
                    disabled={runPreview.isPending && previewJob?.id === job.id}
                    onClick={(e) => { e.stopPropagation(); openPreview(job) }}
                    sx={{ py: 0.25 }}
                  >
                    Preview
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<Code />}
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingJob(job)
                      setJobDialogOpen(true)
                    }}
                    sx={{ py: 0.25 }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    startIcon={<Delete />}
                    onClick={(e) => { e.stopPropagation(); setDeleteJobId(job.id) }}
                    sx={{ py: 0.25 }}
                  >
                    Delete
                  </Button>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      </Paper>

      {/* ── Dialogs ── */}
      <JobFormDialog
        open={jobDialogOpen}
        onClose={() => setJobDialogOpen(false)}
        initial={editingJob ?? undefined}
        onSave={handleJobSave}
        saving={createJob.isPending || updateJob.isPending}
      />

      <NotebookFileDialog
        open={nbDialogOpen}
        onClose={() => setNbDialogOpen(false)}
        initial={editingNb ?? undefined}
        onSave={handleNbSave}
        saving={createNb.isPending || updateNb.isPending}
      />

      {/* Delete job confirmation */}
      <Dialog open={deleteJobId !== null} onClose={() => setDeleteJobId(null)} maxWidth="xs">
        <DialogTitle>Delete job?</DialogTitle>
        <DialogContent>
          <Typography>This will permanently delete the transform job.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteJobId(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => deleteJobId && deleteJob.mutate(deleteJobId)}
            disabled={deleteJob.isPending}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete notebook confirmation */}
      <Dialog open={deleteNbId !== null} onClose={() => setDeleteNbId(null)} maxWidth="xs">
        <DialogTitle>Delete notebook?</DialogTitle>
        <DialogContent>
          <Typography>This will permanently delete the notebook file.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteNbId(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => deleteNbId && deleteNb.mutate(deleteNbId)}
            disabled={deleteNb.isPending}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Preview result dialog */}
      <Dialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        maxWidth="lg"
        fullWidth
        PaperProps={{ sx: { height: '80vh' } }}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
          <Visibility sx={{ fontSize: 18 }} />
          Preview — {previewJob?.name}
          {previewResult && (
            <Chip
              label={`${previewResult.row_count} rows · ${previewResult.duration_ms.toFixed(0)}ms`}
              size="small"
              color="info"
              variant="outlined"
              sx={{ ml: 1 }}
            />
          )}
          <Box sx={{ flex: 1 }} />
          <IconButton size="small" onClick={() => setPreviewOpen(false)}><Close sx={{ fontSize: 16 }} /></IconButton>
        </DialogTitle>
        <DialogContent sx={{ p: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {runPreview.isPending && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 1 }}>
              <CircularProgress size={24} />
              <Typography color="text.secondary">Running transform preview…</Typography>
            </Box>
          )}
          {previewError && !runPreview.isPending && (
            <Alert severity="error" sx={{ m: 2 }}>{previewError}</Alert>
          )}
          {previewResult && !runPreview.isPending && (
            <Box sx={{ overflow: 'auto', flex: 1 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    {previewResult.columns.map((col) => (
                      <TableCell
                        key={col}
                        sx={{
                          fontFamily: MONO,
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          whiteSpace: 'nowrap',
                          bgcolor: 'background.paper',
                        }}
                      >
                        {col}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {previewResult.rows.map((row, ri) => (
                    <TableRow key={ri} hover>
                      {row.map((cell, ci) => (
                        <TableCell
                          key={ci}
                          sx={{ fontFamily: MONO, fontSize: '0.72rem', whiteSpace: 'nowrap', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}
                        >
                          {cell === null || cell === undefined ? <Typography component="span" color="text.disabled" sx={{ fontStyle: 'italic', fontSize: 'inherit' }}>null</Typography> : String(cell)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ justifyContent: 'space-between' }}>
          <Button
            size="small"
            startIcon={runPreview.isPending ? <CircularProgress size={12} /> : <Visibility />}
            onClick={() => previewJob && runPreview.mutate(previewJob)}
            disabled={runPreview.isPending}
          >
            Re-run preview
          </Button>
          <Button onClick={() => setPreviewOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
