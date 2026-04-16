import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Box, Paper, Typography, Button, IconButton, Chip, Divider,
  TextField, MenuItem, FormControlLabel, Switch, Alert, CircularProgress,
  InputAdornment, Grid, Accordion, AccordionSummary, AccordionDetails,
  Tabs, Tab, Tooltip, alpha, useTheme, Select, FormControl, InputLabel,
  Dialog, DialogTitle, DialogContent, DialogActions, Stack,
  List, ListItemButton, ListItemIcon, ListItemText, ListSubheader,
  ToggleButton, ToggleButtonGroup,
  Table, TableHead, TableBody, TableRow, TableCell,
  Badge,
} from '@mui/material'
import {
  Add, PlayArrow, Save, Delete, ExpandMore, Storage, Code, NoteAlt,
  Description, TableChart, Tag, CalendarToday, Edit, Refresh,
  AccountTree, Transform, KeyboardArrowUp, KeyboardArrowDown, DragIndicator,
  ArrowForward, AddCircleOutline, DeleteOutline, FolderOpen, Visibility,
  Close, Schedule, OpenInNew, Search, ContentCopy, Label, FilterList,
  ArrowRightAlt, CheckCircle, Error as ErrorIcon, HourglassEmpty,
  FiberManualRecord,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import { useNavigate } from 'react-router-dom'
import { formatDistanceToNow, format } from 'date-fns'
import { parseApiDate } from '../utils/dates'
import {
  pipelinesApi, transformJobsApi, chainsApi, sqlFilesApi, notebookFilesApi, dataApi,
  Pipeline, ExtractConfig, SourceType, ExecutionContext, RunTrigger,
  TransformJob, TransformType, WriteMode,
  ETLChain, ChainStep,
  NotebookFile, NotebookCell,
  SqlPreviewRequest, SqlPreviewResponse,
} from '../api/client'
import StatusChip from '../components/StatusChip'
import DateField from '../components/DateField'
import ExecutionContextBar from '../components/ExecutionContextBar'

// ─── Constants ────────────────────────────────────────────────────────────────

const MONO = '"JetBrains Mono", "Fira Code", monospace'

const SOURCE_ICONS: Record<SourceType, React.ReactNode> = {
  grpc: <Code fontSize="small" />,
  jdbc: <Storage fontSize="small" />,
  json: <Description fontSize="small" />,
  csv: <TableChart fontSize="small" />,
}

const defaultExtractConfig = (): ExtractConfig => ({
  source_type: 'grpc',
  application_ids: ['APP001'],
  dates: [],
  date_from: '',
  date_to: '',
  rows_per_segment: 100000,
  page_size: 10000,
  output_format: 'parquet',
  jdbc_url: '',
  jdbc_sql: '',
  jdbc_table: '',
  jdbc_date_column: '',
  jdbc_date_var_format: 'YYYYMMDD',
  jdbc_date_range_mode: 'single',
  jdbc_date_range_from: '',
  jdbc_date_range_to: '',
  jdbc_application_ids: [] as string[],
  file_path: '',
  file_encoding: 'utf-8',
  csv_delimiter: ',',
  csv_has_header: true,
  json_lines: true,
})

const defaultPipeline = () => ({
  name: '',
  description: '',
  tags: [] as string[],
  extract_config: defaultExtractConfig(),
  transform_config: {
    filters: {} as Record<string, string>,
    drop_columns: [] as string[],
    rename_columns: {} as Record<string, string>,
    dedup: true,
    dedup_keys: ['id'] as string[],
  },
  load_config: {
    target: 'spark_table' as 'parquet' | 'csv' | 'spark_table',
    table_name: undefined as string | undefined,
    partition_by: ['date', 'application_id'] as string[],
    mode: 'overwrite' as 'overwrite' | 'append',
  },
  schedule: '',
  schedule_enabled: false,
})

type PipelineFormData = ReturnType<typeof defaultPipeline>

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pipelineToForm(p: Pipeline): PipelineFormData {
  return {
    name: p.name,
    description: p.description || '',
    tags: p.tags ?? [],
    extract_config: { ...defaultExtractConfig(), ...p.extract_config, date_from: p.extract_config.date_from ?? '', date_to: p.extract_config.date_to ?? '' },
    transform_config: {
      filters: p.transform_config?.filters ?? {},
      drop_columns: p.transform_config?.drop_columns ?? [],
      rename_columns: p.transform_config?.rename_columns ?? {},
      dedup: p.transform_config?.dedup ?? true,
      dedup_keys: p.transform_config?.dedup_keys ?? ['id'],
    },
    load_config: {
      target: (p.load_config?.target ?? 'spark_table') as 'parquet' | 'csv' | 'spark_table',
      table_name: p.load_config?.table_name,
      partition_by: p.load_config?.partition_by ?? ['date', 'application_id'],
      mode: (p.load_config?.mode ?? 'overwrite') as 'overwrite' | 'append',
    },
    schedule: p.schedule || '',
    schedule_enabled: p.schedule_enabled,
  }
}

// ─── StepBadge ────────────────────────────────────────────────────────────────

function StepBadge({ step }: { step: ChainStep }) {
  const isPipeline = step.type === 'pipeline'
  return (
    <Chip
      icon={isPipeline ? <AccountTree sx={{ fontSize: 13 }} /> : <Transform sx={{ fontSize: 13 }} />}
      label={step.label ?? (isPipeline ? `Pipeline #${step.pipeline_id}` : `Transform #${step.transform_job_id}`)}
      size="small"
      variant="outlined"
      color={isPipeline ? 'primary' : 'warning'}
      sx={{ fontFamily: MONO, fontSize: '0.72rem' }}
    />
  )
}

// ─── NotebookEditor ───────────────────────────────────────────────────────────

function NotebookEditor({ cells, onChange }: { cells: NotebookCell[]; onChange: (cells: NotebookCell[]) => void }) {
  const theme = useTheme()

  const update = (idx: number, patch: Partial<NotebookCell>) =>
    onChange(cells.map((c, i) => (i === idx ? { ...c, ...patch } : c)))

  const insert = (idx: number) => {
    const next = [...cells]
    next.splice(idx + 1, 0, { type: 'code', source: '' })
    onChange(next)
  }

  const remove = (idx: number) => onChange(cells.filter((_, i) => i !== idx))

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 1 }}>
      {cells.length === 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', pt: 4 }}>
          <Button startIcon={<AddCircleOutline />} onClick={() => onChange([{ type: 'code', source: '' }])} size="small">
            Add first cell
          </Button>
        </Box>
      )}
      {cells.map((cell, idx) => (
        <Box key={idx} sx={{ mb: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5, px: 0.5 }}>
            <ToggleButtonGroup value={cell.type} exclusive size="small" onChange={(_, val) => val && update(idx, { type: val })}>
              <ToggleButton value="code" sx={{ py: 0.25, px: 1, fontSize: '0.65rem' }}>Code</ToggleButton>
              <ToggleButton value="markdown" sx={{ py: 0.25, px: 1, fontSize: '0.65rem' }}>MD</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1, ml: 0.5 }}>
              Cell {idx + 1}
              {idx === cells.length - 1 && cell.type === 'code' && (
                <span style={{ color: theme.palette.warning.main }}> — assign result_df here</span>
              )}
            </Typography>
            <Tooltip title="Insert cell below">
              <IconButton size="small" onClick={() => insert(idx)}><AddCircleOutline sx={{ fontSize: 15 }} /></IconButton>
            </Tooltip>
            <Tooltip title="Remove cell">
              <IconButton size="small" onClick={() => remove(idx)}><DeleteOutline sx={{ fontSize: 15 }} /></IconButton>
            </Tooltip>
          </Box>
          <TextField
            fullWidth multiline minRows={3} maxRows={20} value={cell.source}
            onChange={(e) => update(idx, { source: e.target.value })}
            placeholder={cell.type === 'code' ? '# Python code — spark and source_df are available\nresult_df = source_df.filter(...)' : 'Markdown notes...'}
            InputProps={{
              sx: {
                fontFamily: cell.type === 'code' ? MONO : 'inherit',
                fontSize: '0.8rem',
                bgcolor: alpha(cell.type === 'code' ? theme.palette.primary.main : theme.palette.text.primary, 0.04),
              },
            }}
          />
        </Box>
      ))}
    </Box>
  )
}

// ─── SqlEditor ────────────────────────────────────────────────────────────────

function SqlEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', p: 1 }}>
      <Alert severity="info" icon={false} sx={{ mb: 1, py: 0.5, fontSize: '0.75rem' }}>
        Write a SQL query that SELECTs from the virtual table named <code style={{ fontFamily: MONO }}>source</code>. The result will be written to the target table.
      </Alert>
      <TextField
        fullWidth multiline minRows={12} maxRows={40} value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'SELECT *\nFROM source\nWHERE ...'}
        InputProps={{ sx: { fontFamily: MONO, fontSize: '0.82rem', flex: 1, alignItems: 'flex-start' } }}
        sx={{ flex: 1 }}
      />
    </Box>
  )
}

// ─── Run Pipeline Dialog ──────────────────────────────────────────────────────

function RunPipelineDialog({ pipeline, open, onClose }: { pipeline: Pipeline | null; open: boolean; onClose: () => void }) {
  const [appIds, setAppIds] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateOverride, setDateOverride] = useState('')
  const { enqueueSnackbar } = useSnackbar()
  const qc = useQueryClient()

  const { data: ctx } = useQuery<ExecutionContext>({
    queryKey: ['execution-context'],
    queryFn: () => pipelinesApi.getContext().then((r) => r.data),
    enabled: open,
  })

  const resolvedDate = dateOverride || ctx?.business_date || ''
  const nsPrefix = ctx?.namespace_prefix || 'data_'
  const resolvedDb = resolvedDate ? `${nsPrefix}${resolvedDate.replace(/-/g, '')}` : null

  const mutation = useMutation({
    mutationFn: (trigger: RunTrigger) => pipelinesApi.run(pipeline!.id, trigger).then((r) => r.data),
    onSuccess: () => {
      enqueueSnackbar('Run started', { variant: 'success' })
      qc.invalidateQueries({ queryKey: ['pipelines'] })
      qc.invalidateQueries({ queryKey: ['runs-recent'] })
      onClose()
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const handleRun = () => {
    const trigger: RunTrigger = {}
    const cfg: Partial<ExtractConfig> = {}
    if (appIds.trim()) cfg.application_ids = appIds.split(',').map((s) => s.trim()).filter(Boolean)
    if (dateFrom) cfg.date_from = dateFrom
    if (dateTo) cfg.date_to = dateTo
    if (Object.keys(cfg).length) trigger.extract_config = cfg
    if (dateOverride) trigger.business_date = dateOverride
    mutation.mutate(trigger)
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Run: {pipeline?.name}</DialogTitle>
      <DialogContent dividers>
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Tag fontSize="small" color="primary" />
            <Typography variant="subtitle2" fontWeight={600}>Output</Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
            <CalendarToday sx={{ fontSize: 14, color: 'text.secondary' }} />
            <Typography variant="caption" color="text.secondary">
              Platform date: <strong>{ctx?.business_date ?? '(not set)'}</strong>
            </Typography>
          </Box>
          <DateField label="Business date override" value={dateOverride} fullWidth
            onChange={setDateOverride}
            helperText="Leave blank to use the platform business date" />
          {resolvedDb ? (
            <Alert severity="success" sx={{ py: 0.5, mt: 1.5 }}>
              <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                <strong>{resolvedDb}</strong>.<strong>{pipeline?.load_config?.table_name || 'extracts_<app_id>'}</strong>
              </Typography>
            </Alert>
          ) : (
            <Alert severity="warning" sx={{ py: 0.5, mt: 1.5 }}>No business date set — set one on the execution context bar.</Alert>
          )}
        </Paper>
        <Alert severity="info" sx={{ mb: 2 }}>Override extract config for this run, or leave blank to use pipeline defaults.</Alert>
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <TextField label="Application IDs (override)" value={appIds} fullWidth size="small" placeholder="APP001, APP002" onChange={(e) => setAppIds(e.target.value)} />
          </Grid>
          <Grid item xs={6}>
            <DateField label="Date From (override)" value={dateFrom} fullWidth onChange={setDateFrom} />
          </Grid>
          <Grid item xs={6}>
            <DateField label="Date To (override)" value={dateTo} fullWidth onChange={setDateTo} />
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" startIcon={mutation.isPending ? <CircularProgress size={14} color="inherit" /> : <PlayArrow />} onClick={handleRun} disabled={mutation.isPending}>
          Run Now
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── SQL Preview Dialog ────────────────────────────────────────────────────────

const DATE_VAR_FORMATS = ['YYYYMMDD', 'YYYY-MM-DD', 'YYYYMM', 'YYYY/MM/DD', 'DD/MM/YYYY', 'MM/DD/YYYY']
const DATE_RANGE_MODES = [
  { value: 'single', label: 'Single business date' },
  { value: 'current_month', label: 'Current month (first → last day)' },
  { value: 'previous_month', label: 'Previous month (first → last day)' },
  { value: 'custom', label: 'Custom range' },
]

function SqlPreviewDialog({
  open,
  onClose,
  extractConfig,
}: {
  open: boolean
  onClose: () => void
  extractConfig: ExtractConfig
}) {
  const [result, setResult] = useState<SqlPreviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const mut = useMutation({
    mutationFn: (req: SqlPreviewRequest) => sqlFilesApi.previewSql(req).then((r) => r.data),
    onSuccess: (data) => { setResult(data); setError(null) },
    onError: (e: Error) => { setError(e.message); setResult(null) },
  })

  // Fire preview when dialog opens
  useEffect(() => {
    if (!open) return
    setResult(null)
    setError(null)
    const req: SqlPreviewRequest = {
      date_var_format: extractConfig.jdbc_date_var_format ?? 'YYYYMMDD',
      date_range_mode: extractConfig.jdbc_date_range_mode ?? 'single',
      date_range_from: extractConfig.jdbc_date_range_from || undefined,
      date_range_to: extractConfig.jdbc_date_range_to || undefined,
    }
    if (extractConfig.jdbc_sql_file_id) {
      req.sql_file_id = extractConfig.jdbc_sql_file_id
    } else if (extractConfig.jdbc_sql?.trim()) {
      req.sql = extractConfig.jdbc_sql
    } else if (extractConfig.jdbc_table?.trim()) {
      req.sql = `SELECT * FROM ${extractConfig.jdbc_table}`
    }
    mut.mutate(req)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
        <Visibility fontSize="small" />
        SQL Preview — Resolved Variables
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={onClose}><Close fontSize="small" /></IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {mut.isPending && (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress size={28} />
          </Box>
        )}
        {error && <Alert severity="error" sx={{ m: 2 }}>{error}</Alert>}
        {result && (
          <Box>
            {!result.business_date && (
              <Alert severity="warning" sx={{ m: 2, mb: 0 }}>
                No business date set in the execution context — placeholders will not be substituted.
                Set a business date in the platform context bar above.
              </Alert>
            )}
            {Object.keys(result.variables).length > 0 && (
              <Box sx={{ px: 2, pt: 2 }}>
                <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Injected Variables
                </Typography>
                <Table size="small" sx={{ mt: 0.5, mb: 1 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontFamily: MONO, fontSize: '0.75rem', py: 0.5, fontWeight: 600 }}>Placeholder</TableCell>
                      <TableCell sx={{ fontFamily: MONO, fontSize: '0.75rem', py: 0.5, fontWeight: 600 }}>Resolved Value</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {Object.entries(result.variables).map(([ph, val]) => (
                      <TableRow key={ph}>
                        <TableCell sx={{ fontFamily: MONO, fontSize: '0.75rem', py: 0.5, color: 'warning.main' }}>{ph}</TableCell>
                        <TableCell sx={{ fontFamily: MONO, fontSize: '0.75rem', py: 0.5, color: 'success.main' }}>{val}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Divider />
              </Box>
            )}
            <Box sx={{ px: 2, pt: 1.5, pb: 2 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Resolved SQL
              </Typography>
              <Box
                component="pre"
                sx={{
                  mt: 0.5,
                  p: 1.5,
                  borderRadius: 1,
                  bgcolor: 'background.paper',
                  border: '1px solid',
                  borderColor: 'divider',
                  fontFamily: MONO,
                  fontSize: '0.78rem',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  overflowX: 'auto',
                  maxHeight: 420,
                  overflow: 'auto',
                }}
              >
                {result.resolved_sql}
              </Box>
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1, pl: 1 }}>
          {result?.business_date ? `Business date: ${result.business_date}` : 'No business date configured'}
        </Typography>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Tag Editor ──────────────────────────────────────────────────────────────

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const theme = useTheme()
  const [input, setInput] = useState('')
  const add = () => {
    const t = input.trim().toLowerCase().replace(/\s+/g, '-')
    if (t && !tags.includes(t)) onChange([...tags, t])
    setInput('')
  }
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
      {tags.map((t) => (
        <Chip key={t} label={t} size="small" icon={<Label sx={{ fontSize: 12 }} />}
          onDelete={() => onChange(tags.filter((x) => x !== t))}
          sx={{ fontSize: '0.72rem', bgcolor: alpha(theme.palette.primary.main, 0.12) }} />
      ))}
      <TextField
        size="small" value={input} placeholder="add tag…"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
        sx={{ width: 100, '& .MuiInputBase-input': { fontSize: '0.75rem', py: 0.4, px: 0.8 } }}
        InputProps={{ sx: { borderRadius: 3 } }}
      />
    </Box>
  )
}

// ─── Pipeline Config Form (inline) ───────────────────────────────────────────

function PipelineConfigForm({
  initial,
  onSave,
  saving,
}: {
  initial: Pipeline | null
  onSave: (data: PipelineFormData) => void
  saving: boolean
}) {
  const [form, setForm] = useState<PipelineFormData>(initial ? pipelineToForm(initial) : defaultPipeline())
  const [dirty, setDirty] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  const { data: sqlFiles = [] } = useQuery({
    queryKey: ['sql-files', 'extract'],
    queryFn: () => sqlFilesApi.list('extract').then((r) => r.data),
  })
  useEffect(() => {
    setForm(initial ? pipelineToForm(initial) : defaultPipeline())
    setDirty(false)
  }, [initial?.id])

  const update = (patch: Partial<PipelineFormData>) => { setForm((f) => ({ ...f, ...patch })); setDirty(true) }
  const setExtract = (key: string, val: unknown) => { setForm((f) => ({ ...f, extract_config: { ...f.extract_config, [key]: val } })); setDirty(true) }
  const setLoad = (key: string, val: unknown) => { setForm((f) => ({ ...f, load_config: { ...f.load_config, [key]: val } })); setDirty(true) }

  const source = form.extract_config.source_type ?? 'grpc'

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Name / description / tags */}
      <Grid container spacing={2}>
        <Grid item xs={12} sm={7}>
          <TextField label="Name" value={form.name} fullWidth size="small" onChange={(e) => update({ name: e.target.value })} />
        </Grid>
        <Grid item xs={12} sm={5}>
          <TextField label="Description" value={form.description} fullWidth size="small" onChange={(e) => update({ description: e.target.value })} />
        </Grid>
        <Grid item xs={12}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>Tags</Typography>
          <TagEditor tags={form.tags ?? []} onChange={(tags) => update({ tags })} />
        </Grid>
      </Grid>

      {/* Extract config */}
      <Accordion defaultExpanded>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="subtitle2" fontWeight={600}>Extract Configuration</Typography>
            <Chip label={source.toUpperCase()} size="small" icon={<>{SOURCE_ICONS[source as SourceType]}</>} color="primary" variant="outlined" />
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField select label="Source Type" value={source} fullWidth size="small" onChange={(e) => setExtract('source_type', e.target.value)}>
                <MenuItem value="grpc">gRPC (Data Extract Service)</MenuItem>
                <MenuItem value="jdbc">JDBC (SQL Database)</MenuItem>
                <MenuItem value="json">JSON File</MenuItem>
                <MenuItem value="csv">CSV File</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField select label="Output Format" value={form.extract_config.output_format} fullWidth size="small" onChange={(e) => setExtract('output_format', e.target.value)}>
                <MenuItem value="parquet">Parquet</MenuItem>
                <MenuItem value="csv">CSV</MenuItem>
              </TextField>
            </Grid>

            {source === 'grpc' && (
              <>
                <Grid item xs={12}>
                  <TextField label="Application IDs (comma-separated)" value={form.extract_config.application_ids?.join(', ') ?? ''} fullWidth size="small"
                    helperText="e.g. APP001, APP002, APP003"
                    onChange={(e) => setExtract('application_ids', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField label="Batch Page Size" type="number" value={form.extract_config.page_size} fullWidth size="small"
                    helperText="Records per gRPC request" InputProps={{ inputProps: { min: 100, max: 100000 } }}
                    onChange={(e) => setExtract('page_size', parseInt(e.target.value))} />
                </Grid>
              </>
            )}

            {source === 'jdbc' && (
              <>
                <Grid item xs={12}>
                  <TextField label="Connection URL" value={form.extract_config.jdbc_url ?? ''} fullWidth size="small"
                    placeholder="sqlite:///data/sources/sample.db" helperText="SQLAlchemy connection string"
                    onChange={(e) => setExtract('jdbc_url', e.target.value)} />
                </Grid>
                <Grid item xs={12}>
                  <TextField select label="SQL File" value={form.extract_config.jdbc_sql_file_id ?? ''} fullWidth size="small"
                    helperText="Choose a saved SQL file, or enter SQL below"
                    onChange={(e) => setExtract('jdbc_sql_file_id', e.target.value ? parseInt(String(e.target.value)) : undefined)}>
                    <MenuItem value="">— None (use inline SQL or table name) —</MenuItem>
                    {sqlFiles.map((f) => <MenuItem key={f.id} value={f.id}>{f.name}</MenuItem>)}
                  </TextField>
                </Grid>
                {!form.extract_config.jdbc_sql_file_id && (
                  <Grid item xs={12}>
                    <TextField label="Inline SQL" value={form.extract_config.jdbc_sql ?? ''} fullWidth size="small" multiline rows={4}
                      placeholder="SELECT * FROM transactions WHERE status = 'active'" helperText="Leave blank to use Table Name below"
                      inputProps={{ style: { fontFamily: MONO, fontSize: '0.8rem' } }}
                      onChange={(e) => setExtract('jdbc_sql', e.target.value)} />
                  </Grid>
                )}
                {!form.extract_config.jdbc_sql_file_id && !form.extract_config.jdbc_sql && (
                  <Grid item xs={12} sm={6}>
                    <TextField label="Table Name" value={form.extract_config.jdbc_table ?? ''} fullWidth size="small" placeholder="transactions"
                      helperText="Simple table name (no SQL needed)" onChange={(e) => setExtract('jdbc_table', e.target.value)} />
                  </Grid>
                )}
                <Grid item xs={12} sm={6}>
                  <TextField label="Date Column (optional)" value={form.extract_config.jdbc_date_column ?? ''} fullWidth size="small"
                    placeholder="business_date" helperText="Column used to filter by business date"
                    onChange={(e) => setExtract('jdbc_date_column', e.target.value)} />
                </Grid>
                <Grid item xs={12}>
                  <TextField label="Application IDs (comma-separated)" value={form.extract_config.jdbc_application_ids?.join(', ') ?? ''} fullWidth size="small"
                    placeholder="APP001, APP002" helperText="Injected as $app_id — pipeline runs once per ID"
                    onChange={(e) => setExtract('jdbc_application_ids', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
                </Grid>

                {/* SQL variable injection */}
                <Grid item xs={12}><Divider><Typography variant="caption">SQL Variable Injection</Typography></Divider></Grid>
                <Grid item xs={12}>
                  <Typography variant="caption" color="text.secondary">
                    Use <code style={{ fontFamily: MONO }}>$business_date</code>, <code style={{ fontFamily: MONO }}>$business_date_from</code>,{' '}
                    <code style={{ fontFamily: MONO }}>$business_date_to</code>, <code style={{ fontFamily: MONO }}>$business_date_range</code>, or <code style={{ fontFamily: MONO }}>$app_id</code> in your SQL.
                    These are substituted from the global execution context at run time.
                  </Typography>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField select label="Date Format" value={form.extract_config.jdbc_date_var_format ?? 'YYYYMMDD'} fullWidth size="small"
                    helperText="Format applied to $business_date* placeholders"
                    onChange={(e) => setExtract('jdbc_date_var_format', e.target.value)}>
                    {DATE_VAR_FORMATS.map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField select label="Date Range" value={form.extract_config.jdbc_date_range_mode ?? 'single'} fullWidth size="small"
                    helperText="$business_date_range → BETWEEN from AND to"
                    onChange={(e) => setExtract('jdbc_date_range_mode', e.target.value)}>
                    {DATE_RANGE_MODES.map((m) => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
                  </TextField>
                </Grid>
                {form.extract_config.jdbc_date_range_mode === 'custom' && (
                  <>
                    <Grid item xs={12} sm={6}>
                      <DateField label="Range From" value={form.extract_config.jdbc_date_range_from ?? ''} fullWidth
                        helperText="Custom range start"
                        onChange={(v) => setExtract('jdbc_date_range_from', v)} />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <DateField label="Range To" value={form.extract_config.jdbc_date_range_to ?? ''} fullWidth
                        helperText="Custom range end"
                        onChange={(v) => setExtract('jdbc_date_range_to', v)} />
                    </Grid>
                  </>
                )}
                <Grid item xs={12}>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<Visibility />}
                    onClick={() => setPreviewOpen(true)}
                    disabled={!form.extract_config.jdbc_sql_file_id && !form.extract_config.jdbc_sql?.trim() && !form.extract_config.jdbc_table?.trim()}
                  >
                    Preview SQL with Variables
                  </Button>
                </Grid>
              </>
            )}

            {(source === 'json' || source === 'csv') && (
              <>
                <Grid item xs={12}>
                  <TextField label="File Path" value={form.extract_config.file_path ?? ''} fullWidth size="small"
                    placeholder="transactions.csv" helperText="Relative to data/sources/ directory"
                    InputProps={{ startAdornment: <InputAdornment position="start"><Typography variant="caption" color="text.secondary" noWrap>data/sources/</Typography></InputAdornment> }}
                    onChange={(e) => setExtract('file_path', e.target.value)} />
                </Grid>
                {source === 'csv' && (
                  <>
                    <Grid item xs={6} sm={4}>
                      <TextField label="Delimiter" value={form.extract_config.csv_delimiter ?? ','} fullWidth size="small" onChange={(e) => setExtract('csv_delimiter', e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={4}>
                      <FormControlLabel control={<Switch checked={form.extract_config.csv_has_header ?? true} onChange={(e) => setExtract('csv_has_header', e.target.checked)} />} label="Header row" />
                    </Grid>
                  </>
                )}
                {source === 'json' && (
                  <Grid item xs={6}>
                    <FormControlLabel control={<Switch checked={form.extract_config.json_lines ?? true} onChange={(e) => setExtract('json_lines', e.target.checked)} />} label="JSONL (one object per line)" />
                  </Grid>
                )}
              </>
            )}

            <Grid item xs={12}><Divider><Typography variant="caption">Business Date Range</Typography></Divider></Grid>
            <Grid item xs={12} sm={6}>
              <DateField label="Date From" value={form.extract_config.date_from ?? ''} fullWidth
                onChange={(v) => setExtract('date_from', v)} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <DateField label="Date To" value={form.extract_config.date_to ?? ''} fullWidth
                onChange={(v) => setExtract('date_to', v)} />
            </Grid>

            <Grid item xs={12}><Divider><Typography variant="caption">Segmentation</Typography></Divider></Grid>
            <Grid item xs={12} sm={6}>
              <TextField label="Rows per Segment" type="number" value={form.extract_config.rows_per_segment ?? 100000} fullWidth size="small"
                helperText="Max rows per output file" InputProps={{ inputProps: { min: 1000 } }}
                onChange={(e) => setExtract('rows_per_segment', parseInt(e.target.value))} />
            </Grid>
          </Grid>
        </AccordionDetails>
      </Accordion>

      {/* Load config */}
      <Accordion>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Typography variant="subtitle2" fontWeight={600}>Load Configuration</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <TextField select label="Write Mode" value={form.load_config.mode} fullWidth size="small" onChange={(e) => setLoad('mode', e.target.value)}>
                <MenuItem value="overwrite">Overwrite</MenuItem>
                <MenuItem value="append">Append</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={6}>
              <TextField label="Table Name" value={form.load_config.table_name || ''} fullWidth size="small"
                placeholder="e.g. transactions"
                helperText="Saved to <prefix><date>.<table_name> in Spark"
                onChange={(e) => setLoad('table_name', e.target.value)} />
            </Grid>
          </Grid>
        </AccordionDetails>
      </Accordion>

      {/* Schedule */}
      <Accordion>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="subtitle2" fontWeight={600}>Schedule</Typography>
            {form.schedule_enabled && form.schedule && (
              <Chip label={form.schedule} size="small" variant="outlined" icon={<Schedule sx={{ fontSize: 12 }} />} sx={{ fontFamily: MONO, fontSize: '0.72rem' }} />
            )}
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={8}>
              <TextField label="Cron Expression" value={form.schedule} fullWidth size="small" placeholder="0 2 * * *" helperText="Cron: minute hour day month weekday" onChange={(e) => update({ schedule: e.target.value })} />
            </Grid>
            <Grid item xs={4}>
              <FormControlLabel control={<Switch checked={form.schedule_enabled} onChange={(e) => update({ schedule_enabled: e.target.checked })} />} label="Enabled" />
            </Grid>
          </Grid>
        </AccordionDetails>
      </Accordion>

      {/* Save bar */}
      {dirty && (
        <Box sx={{ display: 'flex', gap: 1, pt: 1 }}>
          <Button variant="contained" startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <Save />}
            onClick={() => onSave(form)} disabled={saving || !form.name.trim()}>
            {initial ? 'Save Changes' : 'Create Pipeline'}
          </Button>
          <Button variant="outlined" onClick={() => { setForm(initial ? pipelineToForm(initial) : defaultPipeline()); setDirty(false) }}>
            Reset
          </Button>
        </Box>
      )}

      {/* SQL variable preview dialog */}
      <SqlPreviewDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        extractConfig={form.extract_config}
      />
    </Box>
  )
}

// ─── Job Form Dialog ──────────────────────────────────────────────────────────

function JobFormDialog({
  open, onClose, initial, onSave, saving,
}: {
  open: boolean
  onClose: () => void
  initial?: Partial<TransformJob>
  onSave: (data: Omit<TransformJob, 'id' | 'status' | 'last_run_at' | 'last_run_duration_s' | 'last_run_rows' | 'last_error' | 'created_at' | 'updated_at' | 'sql_file_name' | 'notebook_file_name'>) => void
  saving: boolean
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [tags, setTags] = useState<string[]>(initial?.tags ?? [])
  const [sourceDb, setSourceDb] = useState(initial?.source_database ?? '')
  const [sourceTable, setSourceTable] = useState(initial?.source_table ?? '')
  const [transformType, setTransformType] = useState<TransformType>(initial?.transform_type ?? 'sql')
  const [sqlFileId, setSqlFileId] = useState<number | ''>(initial?.sql_file_id ?? '')
  const [notebookFileId, setNotebookFileId] = useState<number | ''>(initial?.notebook_file_id ?? '')
  const [targetDb, setTargetDb] = useState(initial?.target_database ?? '')
  const [targetTable, setTargetTable] = useState(initial?.target_table ?? '')
  const [targetMode, setTargetMode] = useState<WriteMode>(initial?.target_mode ?? 'overwrite')

  const { data: sqlFiles } = useQuery({ queryKey: ['sql-files', 'transform'], queryFn: () => sqlFilesApi.list('transform').then((r) => r.data) })
  const { data: notebooks } = useQuery({ queryKey: ['notebook-files'], queryFn: () => notebookFilesApi.list().then((r) => r.data) })
  const { data: catalog } = useQuery({ queryKey: ['catalog'], queryFn: () => dataApi.catalog().then((r) => r.data) })
  const dbs = [...new Set((catalog ?? []).map((t) => t.database ?? '').filter(Boolean))]
  const sourceTablesInDb = (catalog ?? []).filter((t) => !sourceDb || t.database === sourceDb).map((t) => t.name)

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? ''); setDescription(initial?.description ?? ''); setTags(initial?.tags ?? [])
      setSourceDb(initial?.source_database ?? ''); setSourceTable(initial?.source_table ?? '')
      setTransformType(initial?.transform_type ?? 'sql')
      setSqlFileId(initial?.sql_file_id ?? ''); setNotebookFileId(initial?.notebook_file_id ?? '')
      setTargetDb(initial?.target_database ?? ''); setTargetTable(initial?.target_table ?? '')
      setTargetMode(initial?.target_mode ?? 'overwrite')
    }
  }, [open, initial])

  const valid = name.trim() && sourceTable.trim() && targetTable.trim()

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial?.id ? 'Edit Transform Job' : 'New Transform Job'}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1.5 }}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required fullWidth size="small" />
        <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth size="small" />
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>Tags</Typography>
          <TagEditor tags={tags} onChange={setTags} />
        </Box>
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
            <InputLabel>SQL Transform File</InputLabel>
            <Select value={sqlFileId} label="SQL Transform File" onChange={(e) => setSqlFileId(e.target.value as number | '')}>
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
        <Button variant="contained" onClick={() => onSave({ name: name.trim(), description: description.trim() || undefined, tags, source_database: sourceDb || undefined, source_table: sourceTable.trim(), transform_type: transformType, sql_content: undefined, sql_file_id: sqlFileId !== '' ? Number(sqlFileId) : undefined, notebook_file_id: notebookFileId !== '' ? Number(notebookFileId) : undefined, target_database: targetDb || undefined, target_table: targetTable.trim(), target_mode: targetMode })} disabled={!valid || saving}>
          {saving ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Notebook File Dialog ─────────────────────────────────────────────────────

function NotebookFileDialog({ open, onClose, initial, onSave, saving }: {
  open: boolean; onClose: () => void; initial?: NotebookFile
  onSave: (data: Omit<NotebookFile, 'id' | 'created_at' | 'updated_at'>) => void; saving: boolean
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [cells, setCells] = useState<NotebookCell[]>(initial?.cells ?? [{ type: 'code', source: '' }])

  useEffect(() => {
    if (open) { setName(initial?.name ?? ''); setDescription(initial?.description ?? ''); setCells(initial?.cells ?? [{ type: 'code', source: '' }]) }
  }, [open, initial])

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { height: '85vh' } }}>
      <DialogTitle>{initial?.id ? 'Edit Notebook' : 'New Notebook'}</DialogTitle>
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
        <Button variant="contained" onClick={() => onSave({ name: name.trim(), description: description.trim() || undefined, cells })} disabled={!name.trim() || saving}>
          {saving ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Status Dot ──────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'running' ? '#29b6f6'
    : status === 'completed' ? '#66bb6a'
    : status === 'failed' ? '#f44336'
    : status === 'active' ? '#66bb6a'
    : '#9e9e9e'
  return <FiberManualRecord sx={{ fontSize: 8, color, flexShrink: 0 }} />
}

// ─── Chain Flow Diagram ───────────────────────────────────────────────────────

function ChainFlowDiagram({
  chain,
  pipelines,
  jobs,
  onRun,
  running,
}: {
  chain: ETLChain
  pipelines: Pipeline[]
  jobs: TransformJob[]
  onRun: () => void
  running: boolean
}) {
  const theme = useTheme()
  if (chain.steps.length === 0) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 4, color: 'text.disabled', gap: 1 }}>
        <AccountTree sx={{ fontSize: 40, opacity: 0.3 }} />
        <Typography variant="body2">No steps defined — add steps below</Typography>
      </Box>
    )
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {/* Run button */}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 0.5 }}>
        <Button
          variant="contained" color="success" size="small"
          startIcon={running ? <CircularProgress size={13} color="inherit" /> : <PlayArrow />}
          disabled={running} onClick={onRun}
        >
          Run Chain
        </Button>
      </Box>
      {/* Flow */}
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
        {chain.steps.map((step, idx) => {
          const isPipeline = step.type === 'pipeline'
          const item = isPipeline
            ? pipelines.find((p) => p.id === step.pipeline_id)
            : jobs.find((j) => j.id === step.transform_job_id)
          const color = isPipeline ? 'primary' : 'warning'
          return (
            <Box key={idx} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              {idx > 0 && (
                <ArrowRightAlt sx={{ color: 'text.disabled', fontSize: 20 }} />
              )}
              <Paper
                variant="outlined"
                sx={{
                  px: 1.5, py: 1,
                  borderColor: `${color}.main`,
                  bgcolor: alpha(theme.palette[color].main, 0.08),
                  minWidth: 110, maxWidth: 180,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.25 }}>
                  {isPipeline
                    ? <Storage sx={{ fontSize: 13, color: `${color}.main` }} />
                    : <Transform sx={{ fontSize: 13, color: `${color}.main` }} />}
                  <Typography variant="caption" fontWeight={700} color={`${color}.main`} sx={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    {isPipeline ? 'Extract' : 'Transform'}
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.6rem' }}>{idx + 1}</Typography>
                </Box>
                <Typography variant="body2" sx={{ fontSize: '0.78rem', fontWeight: 500 }} noWrap>
                  {step.label ?? item?.name ?? `#${step.pipeline_id ?? step.transform_job_id}`}
                </Typography>
                {item && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4, mt: 0.5 }}>
                    <StatusDot status={(item as any).status ?? 'idle'} />
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
                      {(item as any).status ?? 'idle'}
                    </Typography>
                  </Box>
                )}
              </Paper>
            </Box>
          )
        })}
        {/* Terminal node */}
        <ArrowRightAlt sx={{ color: 'text.disabled', fontSize: 20 }} />
        <Paper variant="outlined" sx={{ px: 1.5, py: 1, borderColor: 'success.main', bgcolor: alpha(theme.palette.success.main, 0.06), minWidth: 80 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <CheckCircle sx={{ fontSize: 13, color: 'success.main' }} />
            <Typography variant="caption" fontWeight={700} color="success.main" sx={{ fontSize: '0.65rem', textTransform: 'uppercase' }}>Done</Typography>
          </Box>
        </Paper>
      </Box>
      {/* Status bar */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
        <StatusChip status={chain.status} />
        {chain.last_run_at && (
          <Tooltip title={formatDistanceToNow(parseApiDate(chain.last_run_at), { addSuffix: true })}>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
              {format(parseApiDate(chain.last_run_at), 'dd MMM yyyy HH:mm:ss')}
              {chain.last_run_duration_s != null && ` · ${chain.last_run_duration_s.toFixed(1)}s`}
            </Typography>
          </Tooltip>
        )}
      </Box>
      {chain.last_error && (
        <Alert severity="error" icon={<ErrorIcon fontSize="small" />} sx={{ py: 0.5, fontSize: '0.75rem' }}>{chain.last_error}</Alert>
      )}
    </Box>
  )
}

// ─── Transform Flow Diagram ───────────────────────────────────────────────────

type TransformNode = 'source' | 'transform' | 'target'

function TransformFlowDiagram({
  job,
  activeNode,
  onNodeClick,
}: {
  job: TransformJob
  activeNode: TransformNode | null
  onNodeClick: (node: TransformNode) => void
}) {
  const theme = useTheme()

  const NodeBox = ({
    id, label, sublabel, color, icon,
  }: {
    id: TransformNode; label: string; sublabel: string; color: 'info' | 'warning' | 'success'; icon: React.ReactNode
  }) => {
    const active = activeNode === id
    return (
      <Paper
        variant="outlined"
        onClick={() => onNodeClick(id)}
        sx={{
          px: 2, py: 1.5,
          minWidth: 140, maxWidth: 220,
          cursor: 'pointer',
          borderColor: active ? `${color}.main` : alpha(theme.palette[color].main, 0.35),
          bgcolor: active ? alpha(theme.palette[color].main, 0.12) : alpha(theme.palette[color].main, 0.04),
          boxShadow: active ? `0 0 0 2px ${alpha(theme.palette[color].main, 0.4)}` : 'none',
          transition: 'all 0.15s',
          '&:hover': { borderColor: `${color}.main`, bgcolor: alpha(theme.palette[color].main, 0.08) },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
          <Box sx={{ color: `${color}.main`, display: 'flex' }}>{icon}</Box>
          <Typography variant="caption" fontWeight={700} color={`${color}.main`}
            sx={{ fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {label}
          </Typography>
        </Box>
        <Typography variant="body2" fontWeight={600} sx={{ fontFamily: MONO, fontSize: '0.8rem' }} noWrap>
          {sublabel}
        </Typography>
      </Paper>
    )
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', py: 1 }}>
      <NodeBox
        id="source" label="Source" color="info" icon={<Storage sx={{ fontSize: 14 }} />}
        sublabel={`${job.source_database ? job.source_database + '.' : ''}${job.source_table}`}
      />
      <ArrowRightAlt sx={{ color: 'text.disabled', fontSize: 28, flexShrink: 0 }} />
      <NodeBox
        id="transform"
        label={job.transform_type === 'sql' ? 'SQL Transform' : 'Notebook'}
        color="warning"
        icon={job.transform_type === 'sql' ? <Code sx={{ fontSize: 14 }} /> : <NoteAlt sx={{ fontSize: 14 }} />}
        sublabel={job.sql_file_name ?? job.notebook_file_name ?? 'inline'}
      />
      <ArrowRightAlt sx={{ color: 'text.disabled', fontSize: 28, flexShrink: 0 }} />
      <NodeBox
        id="target"
        label={`Target · ${job.target_mode}`}
        color="success"
        icon={<TableChart sx={{ fontSize: 14 }} />}
        sublabel={`${job.target_database ? job.target_database + '.' : ''}${job.target_table}`}
      />
      <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.68rem', ml: 'auto' }}>
        Click a node to preview data or view the transform
      </Typography>
    </Box>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PipelineStudio() {
  const theme = useTheme()
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()
  const navigate = useNavigate()

  // ── Top-level tab: 0=Extracts, 1=Transformations, 2=Pipelines ──
  const [mainTab, setMainTab] = useState(0)

  // ── Search / tag filter (shared across tabs) ──
  const [search, setSearch] = useState('')
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null)

  // ── Extract state ──
  type ExtractSelection = { id: number; isNew: false } | { id: null; isNew: true } | null
  const [extractSel, setExtractSel] = useState<ExtractSelection>(null)
  const [runPipelineTarget, setRunPipelineTarget] = useState<Pipeline | null>(null)
  const [deletePipelineId, setDeletePipelineId] = useState<number | null>(null)
  const [clonePipelineTarget, setClonePipelineTarget] = useState<Pipeline | null>(null)
  const [cloneName, setCloneName] = useState('')

  // ── Transform state ──
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null)
  const [activeNode, setActiveNode] = useState<TransformNode | null>(null)
  // Bottom panel content: 'sql' | 'notebook' | 'source-preview' | 'target-preview' | null
  const [bottomPanel, setBottomPanel] = useState<'sql' | 'notebook' | 'source-preview' | 'target-preview' | null>(null)
  const [sqlDraft, setSqlDraft] = useState('')
  const [sqlFileId, setSqlFileId] = useState<number | null>(null)
  const [nbCellsDraft, setNbCellsDraft] = useState<NotebookCell[]>([])
  const [nbFileId, setNbFileId] = useState<number | null>(null)
  const [draftDirty, setDraftDirty] = useState(false)
  const [sourcePreviewResult, setSourcePreviewResult] = useState<{ columns: string[]; rows: unknown[][] } | null>(null)
  const [sourcePreviewError, setSourcePreviewError] = useState<string | null>(null)
  const [targetPreviewResult, setTargetPreviewResult] = useState<{ columns: string[]; rows: unknown[][] } | null>(null)
  const [targetPreviewError, setTargetPreviewError] = useState<string | null>(null)
  const [jobDialogOpen, setJobDialogOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<TransformJob | null>(null)
  const [deleteJobId, setDeleteJobId] = useState<number | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewJob, setPreviewJob] = useState<TransformJob | null>(null)
  const [previewResult, setPreviewResult] = useState<{ columns: string[]; rows: unknown[][]; row_count: number; duration_ms: number } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // ── Chain state ──
  type ChainSelection = { id: number; isNew: false } | { id: null; isNew: true } | null
  const [chainSel, setChainSel] = useState<ChainSelection>(null)
  const [chainForm, setChainForm] = useState<Pick<ETLChain, 'name' | 'description' | 'steps'>>({ name: '', description: '', steps: [] })
  const [chainDirty, setChainDirty] = useState(false)
  const [addStepType, setAddStepType] = useState<'pipeline' | 'transform'>('pipeline')
  const [addStepId, setAddStepId] = useState<number | ''>('')
  const [deleteChainId, setDeleteChainId] = useState<number | null>(null)

  // ── Queries ──
  const { data: pipelines = [], isLoading: pipelinesLoading } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => pipelinesApi.list().then((r) => r.data),
    refetchInterval: 10_000,
  })

  const { data: jobs = [], isLoading: jobsLoading } = useQuery({
    queryKey: ['transform-jobs'],
    queryFn: () => transformJobsApi.list().then((r) => r.data),
    refetchInterval: 5_000,
  })

  const { data: sqlFiles = [] } = useQuery({
    queryKey: ['sql-files'],
    queryFn: () => sqlFilesApi.list().then((r) => r.data),
  })

  const { data: chains = [], isLoading: chainsLoading } = useQuery({
    queryKey: ['etl-chains'],
    queryFn: () => chainsApi.list().then((r) => r.data),
    refetchInterval: 5_000,
  })

  // ── Derived ──
  const selectedPipeline = extractSel && !extractSel.isNew
    ? pipelines.find((p) => p.id === extractSel.id) ?? null : null
  const selectedJob = selectedJobId ? jobs.find((j) => j.id === selectedJobId) ?? null : null
  const selectedChain = chainSel && !chainSel.isNew
    ? chains.find((c) => c.id === chainSel.id) ?? null : null

  const panelBg = alpha(theme.palette.background.paper, 0.5)

  const allTags = useMemo(() => {
    const set = new Set<string>()
    pipelines.forEach((p) => (p.tags ?? []).forEach((t) => set.add(t)))
    jobs.forEach((j) => (j.tags ?? []).forEach((t) => set.add(t)))
    return [...set].sort()
  }, [pipelines, jobs])

  const matchesSearch = (name: string, tags: string[] = []) => {
    if (activeTagFilter && !tags.includes(activeTagFilter)) return false
    if (!search) return true
    return name.toLowerCase().includes(search.toLowerCase())
  }

  const filteredPipelines = pipelines.filter((p) => matchesSearch(p.name, p.tags ?? []))
  const filteredJobs = jobs.filter((j) => matchesSearch(j.name, j.tags ?? []))
  const filteredChains = chains.filter((c) => matchesSearch(c.name))

  // ── Load SQL/notebook into editor when job selection changes ──
  useEffect(() => {
    if (!selectedJob) { setBottomPanel(null); return }
    setActiveNode(null)
    setBottomPanel(null)
    setDraftDirty(false)
    if (selectedJob.transform_type === 'sql') {
      const sf = selectedJob.sql_file_id
        ? sqlFiles.find((f) => f.id === selectedJob.sql_file_id)
        : null
      setSqlDraft(sf?.content ?? selectedJob.sql_content ?? '')
      setSqlFileId(sf?.id ?? null)
    } else {
      setNbCellsDraft([])
      setNbFileId(null)
    }
  }, [selectedJobId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handle node click (TransformFlowDiagram) ──
  const handleNodeClick = async (node: TransformNode) => {
    if (!selectedJob) return
    if (activeNode === node) { setActiveNode(null); setBottomPanel(null); return }
    setActiveNode(node)
    if (node === 'transform') {
      setBottomPanel(selectedJob.transform_type === 'sql' ? 'sql' : 'notebook')
      // Lazy-load notebook cells
      if (selectedJob.transform_type === 'notebook' && selectedJob.notebook_file_id && nbCellsDraft.length === 0) {
        try {
          const res = await notebookFilesApi.get(selectedJob.notebook_file_id)
          setNbCellsDraft(res.data.cells ?? [])
          setNbFileId(res.data.id)
        } catch { /* ignore */ }
      }
    } else if (node === 'source') {
      setBottomPanel('source-preview')
      setSourcePreviewResult(null)
      setSourcePreviewError(null)
      const sql = `SELECT * FROM ${selectedJob.source_database ? `\`${selectedJob.source_database}\`.` : ''}\`${selectedJob.source_table}\` LIMIT 100`
      try {
        const res = await dataApi.query(sql, 100, 0, selectedJob.source_database ?? undefined)
        setSourcePreviewResult({ columns: res.data.columns, rows: res.data.rows })
      } catch (e: any) {
        setSourcePreviewError(e?.response?.data?.detail ?? 'Preview failed')
      }
    } else if (node === 'target') {
      setBottomPanel('target-preview')
      setTargetPreviewResult(null)
      setTargetPreviewError(null)
      const sql = `SELECT * FROM ${selectedJob.target_database ? `\`${selectedJob.target_database}\`.` : ''}\`${selectedJob.target_table}\` LIMIT 100`
      try {
        const res = await dataApi.query(sql, 100, 0, selectedJob.target_database ?? undefined)
        setTargetPreviewResult({ columns: res.data.columns, rows: res.data.rows })
      } catch (e: any) {
        setTargetPreviewError(e?.response?.data?.detail ?? 'No data yet or table does not exist')
      }
    }
  }

  // ── Sync chain form when chain changes ──
  useEffect(() => {
    if (selectedChain) {
      setChainForm({ name: selectedChain.name, description: selectedChain.description ?? '', steps: selectedChain.steps })
      setChainDirty(false)
    }
  }, [selectedChain?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pipeline mutations ──
  const createPipeline = useMutation({
    mutationFn: (d: Parameters<typeof pipelinesApi.create>[0]) => pipelinesApi.create(d).then((r) => r.data),
    onSuccess: (created) => { qc.invalidateQueries({ queryKey: ['pipelines'] }); setExtractSel({ id: created.id, isNew: false }); enqueueSnackbar('Pipeline created', { variant: 'success' }) },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const updatePipeline = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Pipeline> }) => pipelinesApi.update(id, data).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pipelines'] }); enqueueSnackbar('Pipeline saved', { variant: 'success' }) },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const deletePipeline = useMutation({
    mutationFn: (id: number) => pipelinesApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pipelines'] }); setDeletePipelineId(null); setExtractSel(null); enqueueSnackbar('Pipeline deleted', { variant: 'info' }) },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const handlePipelineSave = (form: PipelineFormData) => {
    if (extractSel?.isNew) createPipeline.mutate(form)
    else if (extractSel && !extractSel.isNew) updatePipeline.mutate({ id: extractSel.id, data: form })
  }

  // ── Transform mutations ──
  const createJob = useMutation({
    mutationFn: transformJobsApi.create,
    onSuccess: (res) => { qc.invalidateQueries({ queryKey: ['transform-jobs'] }); setSelectedJobId(res.data.id); setJobDialogOpen(false); enqueueSnackbar('Job created', { variant: 'success' }) },
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
    onError: (e: any) => enqueueSnackbar(e?.response?.data?.detail ?? 'Failed to start job', { variant: 'error' }),
  })

  const cancelJob = useMutation({
    mutationFn: transformJobsApi.cancel,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transform-jobs'] }); enqueueSnackbar('Job cancelled', { variant: 'warning' }) },
    onError: (e: any) => enqueueSnackbar(e?.response?.data?.detail ?? 'Failed to cancel job', { variant: 'error' }),
  })

  const saveSqlDraft = useMutation({
    mutationFn: () => sqlFilesApi.update(sqlFileId!, { content: sqlDraft }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sql-files'] }); setDraftDirty(false); enqueueSnackbar('SQL saved', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to save SQL', { variant: 'error' }),
  })

  const saveNbDraft = useMutation({
    mutationFn: () => notebookFilesApi.update(nbFileId!, { cells: nbCellsDraft }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['notebook-files'] }); setDraftDirty(false); enqueueSnackbar('Notebook saved', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to save notebook', { variant: 'error' }),
  })

  const runPreview = useMutation({
    mutationFn: (job: TransformJob) => {
      const sqlContent = sqlDraft || job.sql_content || undefined
      const cells = nbCellsDraft.length > 0 ? nbCellsDraft : undefined
      return transformJobsApi.preview({ source_database: job.source_database, source_table: job.source_table, transform_type: job.transform_type, sql_content: sqlContent, cells, limit: 100 })
    },
    onSuccess: (res) => { setPreviewResult(res.data); setPreviewError(null) },
    onError: (err: any) => { setPreviewResult(null); setPreviewError(err?.response?.data?.detail ?? 'Preview failed') },
  })

  const openPreview = (job: TransformJob) => { setPreviewJob(job); setPreviewResult(null); setPreviewError(null); setPreviewOpen(true); runPreview.mutate(job) }

  const handleJobSave = useCallback((data: Parameters<typeof createJob.mutate>[0]) => {
    if (editingJob?.id) updateJob.mutate({ id: editingJob.id, data })
    else createJob.mutate(data)
  }, [editingJob, createJob, updateJob])

  // ── Chain mutations ──
  const createChain = useMutation({
    mutationFn: chainsApi.create,
    onSuccess: (res) => { qc.invalidateQueries({ queryKey: ['etl-chains'] }); setChainSel({ id: res.data.id, isNew: false }); enqueueSnackbar('Chain created', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to create chain', { variant: 'error' }),
  })

  const updateChain = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof chainsApi.update>[1] }) => chainsApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['etl-chains'] }); setChainDirty(false); enqueueSnackbar('Chain saved', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to save chain', { variant: 'error' }),
  })

  const deleteChain = useMutation({
    mutationFn: chainsApi.delete,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['etl-chains'] }); setDeleteChainId(null); setChainSel(null); enqueueSnackbar('Chain deleted', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to delete chain', { variant: 'error' }),
  })

  const runChain = useMutation({
    mutationFn: chainsApi.run,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['etl-chains'] }); enqueueSnackbar('Chain started', { variant: 'info' }) },
    onError: (err: any) => enqueueSnackbar(err?.response?.data?.detail ?? 'Failed to start chain', { variant: 'error' }),
  })

  const handleChainSave = () => {
    if (chainSel?.isNew) createChain.mutate(chainForm)
    else if (chainSel && !chainSel.isNew) updateChain.mutate({ id: chainSel.id, data: chainForm })
  }

  // ─── Shared sidebar search bar ────────────────────────────────────────────

  const SearchBar = () => (
    <Box sx={{ px: 1, py: 0.75, borderBottom: `1px solid ${theme.palette.divider}` }}>
      <TextField
        size="small" fullWidth placeholder="Search…" value={search}
        onChange={(e) => setSearch(e.target.value)}
        InputProps={{
          startAdornment: <InputAdornment position="start"><Search sx={{ fontSize: 15, color: 'text.secondary' }} /></InputAdornment>,
          endAdornment: search ? (
            <InputAdornment position="end">
              <IconButton size="small" onClick={() => setSearch('')}><Close sx={{ fontSize: 13 }} /></IconButton>
            </InputAdornment>
          ) : null,
          sx: { fontSize: '0.8rem' },
        }}
        sx={{ '& .MuiInputBase-root': { borderRadius: 2 } }}
      />
    </Box>
  )

  const TagFilterBar = () => allTags.length === 0 ? null : (
    <Box sx={{ px: 1, py: 0.5, display: 'flex', flexWrap: 'wrap', gap: 0.4, borderBottom: `1px solid ${theme.palette.divider}` }}>
      {allTags.map((t) => (
        <Chip key={t} label={t} size="small" icon={<Label sx={{ fontSize: 11 }} />}
          onClick={() => setActiveTagFilter(activeTagFilter === t ? null : t)}
          sx={{
            fontSize: '0.65rem', height: 18, cursor: 'pointer',
            bgcolor: activeTagFilter === t ? 'primary.main' : alpha(theme.palette.primary.main, 0.12),
            color: activeTagFilter === t ? 'primary.contrastText' : 'primary.main',
            '& .MuiChip-icon': { color: 'inherit' },
          }}
        />
      ))}
      {activeTagFilter && (
        <Chip label="clear" size="small" variant="outlined" onClick={() => setActiveTagFilter(null)}
          sx={{ fontSize: '0.65rem', height: 18, cursor: 'pointer' }} />
      )}
    </Box>
  )

  // ─── TAB 0: EXTRACTS ──────────────────────────────────────────────────────

  const renderExtractsTab = () => (
    <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      {/* Left sidebar */}
      <Paper elevation={0} sx={{ width: 240, flexShrink: 0, borderRight: `1px solid ${theme.palette.divider}`, display: 'flex', flexDirection: 'column', bgcolor: panelBg, overflow: 'hidden' }}>
        <Box sx={{ px: 1.5, py: 0.75, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Storage sx={{ fontSize: 13, color: 'primary.main' }} />
          <Typography variant="caption" fontWeight={700} sx={{ flex: 1, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.07em', color: 'text.secondary' }}>
            Extracts ({filteredPipelines.length})
          </Typography>
          <Tooltip title="New extract pipeline">
            <IconButton size="small" onClick={() => setExtractSel({ id: null, isNew: true })}><Add sx={{ fontSize: 14 }} /></IconButton>
          </Tooltip>
        </Box>
        <SearchBar />
        <TagFilterBar />
        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {pipelinesLoading && <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}><CircularProgress size={20} /></Box>}
          {!pipelinesLoading && filteredPipelines.length === 0 && (
            <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
              <Storage sx={{ fontSize: 32, opacity: 0.2, mb: 1 }} />
              <Typography variant="caption" color="text.disabled" display="block">No extract pipelines</Typography>
              <Button size="small" startIcon={<Add />} sx={{ mt: 1 }} onClick={() => setExtractSel({ id: null, isNew: true })}>Create first</Button>
            </Box>
          )}
          {filteredPipelines.map((p) => {
            const active = !extractSel?.isNew && (extractSel as any)?.id === p.id
            return (
              <ListItemButton key={p.id} dense selected={active}
                onClick={() => setExtractSel({ id: p.id, isNew: false })}
                sx={{ pl: 1.5, pr: 0.5, py: 0.75, borderBottom: `1px solid ${alpha(theme.palette.divider, 0.5)}` }}>
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, width: '100%', minWidth: 0 }}>
                  <Box sx={{ color: 'text.secondary', mt: 0.2, flexShrink: 0 }}>{SOURCE_ICONS[p.extract_config.source_type ?? 'grpc']}</Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Typography variant="body2" fontWeight={active ? 600 : 400} noWrap sx={{ flex: 1, fontSize: '0.8rem' }}>{p.name}</Typography>
                      <StatusDot status={p.status} />
                    </Box>
                    {(p.tags ?? []).length > 0 && (
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.3, mt: 0.25 }}>
                        {(p.tags ?? []).map((t) => (
                          <Chip key={t} label={t} size="small" sx={{ height: 14, fontSize: '0.6rem', bgcolor: alpha(theme.palette.primary.main, 0.1), '& .MuiChip-label': { px: 0.5 } }} />
                        ))}
                      </Box>
                    )}
                    {p.last_run && (
                      <Tooltip title={formatDistanceToNow(parseApiDate(p.last_run.created_at), { addSuffix: true })}>
                        <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.65rem', fontFamily: MONO }}>
                          {format(parseApiDate(p.last_run.created_at), 'dd MMM HH:mm:ss')}
                        </Typography>
                      </Tooltip>
                    )}
                  </Box>
                </Box>
              </ListItemButton>
            )
          })}
        </Box>
      </Paper>

      {/* Center: config form */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', bgcolor: alpha(theme.palette.background.default, 0.5) }}>
        {extractSel ? (
          <>
            <Box sx={{ px: 2, pt: 1.5, pb: 0.5 }}><ExecutionContextBar /></Box>
            <PipelineConfigForm initial={selectedPipeline} onSave={handlePipelineSave} saving={createPipeline.isPending || updatePipeline.isPending} />
          </>
        ) : (
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'text.disabled', gap: 2, p: 4 }}>
            <Storage sx={{ fontSize: 56, opacity: 0.2 }} />
            <Typography variant="h6" color="text.disabled">Select an extract pipeline</Typography>
            <Button variant="contained" startIcon={<Add />} onClick={() => setExtractSel({ id: null, isNew: true })}>New Extract</Button>
          </Box>
        )}
      </Box>

      {/* Right: action panel */}
      <Paper elevation={0} sx={{ width: 210, flexShrink: 0, borderLeft: `1px solid ${theme.palette.divider}`, bgcolor: panelBg, overflow: 'auto' }}>
        {selectedPipeline ? (
          <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="subtitle2" fontWeight={700} noWrap sx={{ flex: 1 }}>{selectedPipeline.name}</Typography>
              <StatusChip status={selectedPipeline.status} />
            </Box>
            <Button variant="contained" color="success" fullWidth startIcon={<PlayArrow />} onClick={() => setRunPipelineTarget(selectedPipeline)}>Run Pipeline</Button>
            <Tooltip title="Clone with a different name — reuses all config">
              <Button variant="outlined" fullWidth startIcon={<ContentCopy />} onClick={() => { setClonePipelineTarget(selectedPipeline); setCloneName(`${selectedPipeline.name} (copy)`) }}>Clone</Button>
            </Tooltip>
            <Button variant="outlined" fullWidth startIcon={<OpenInNew />} onClick={() => navigate('/explorer')}>Explore Data</Button>
            <Button variant="outlined" color="error" fullWidth startIcon={<Delete />} onClick={() => setDeletePipelineId(selectedPipeline.id)}>Delete</Button>
            <Divider />
            {[['Total runs', selectedPipeline.total_runs], ['Source', (selectedPipeline.extract_config.source_type ?? 'grpc').toUpperCase()], ['Target', selectedPipeline.load_config?.target?.toUpperCase() ?? '—']].map(([label, value]) => (
              <Box key={label as string} sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Typography variant="caption" color="text.secondary">{label}</Typography>
                <Typography variant="caption" fontWeight={600}>{value}</Typography>
              </Box>
            ))}
            {selectedPipeline.last_run && (
              <>
                <Divider />
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <StatusChip status={selectedPipeline.last_run.status} />
                  <Tooltip title={formatDistanceToNow(parseApiDate(selectedPipeline.last_run.created_at), { addSuffix: true })}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                      {format(parseApiDate(selectedPipeline.last_run.created_at), 'dd MMM yyyy HH:mm:ss')}
                    </Typography>
                  </Tooltip>
                </Box>
              </>
            )}
            {selectedPipeline.schedule_enabled && selectedPipeline.schedule && (
              <>
                <Divider />
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Schedule sx={{ fontSize: 13, color: 'text.secondary' }} />
                  <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary' }}>{selectedPipeline.schedule}</Typography>
                </Box>
              </>
            )}
          </Box>
        ) : (
          <Box sx={{ p: 2, color: 'text.disabled', display: 'flex', flexDirection: 'column', alignItems: 'center', pt: 6, gap: 1 }}>
            <Typography variant="caption" align="center">Select a pipeline to see actions</Typography>
          </Box>
        )}
      </Paper>
    </Box>
  )

  // ─── TAB 1: TRANSFORMATIONS ───────────────────────────────────────────────

  const renderTransformationsTab = () => (
    <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      {/* Left sidebar */}
      <Paper elevation={0} sx={{ width: 240, flexShrink: 0, borderRight: `1px solid ${theme.palette.divider}`, display: 'flex', flexDirection: 'column', bgcolor: panelBg, overflow: 'hidden' }}>
        <Box sx={{ px: 1.5, py: 0.75, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Transform sx={{ fontSize: 13, color: 'warning.main' }} />
          <Typography variant="caption" fontWeight={700} sx={{ flex: 1, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.07em', color: 'text.secondary' }}>
            Jobs ({filteredJobs.length})
          </Typography>
          <Tooltip title="New transform job">
            <IconButton size="small" onClick={() => { setEditingJob(null); setJobDialogOpen(true) }}><Add sx={{ fontSize: 14 }} /></IconButton>
          </Tooltip>
        </Box>
        <SearchBar />
        <TagFilterBar />
        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {jobsLoading && <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}><CircularProgress size={20} /></Box>}
          {!jobsLoading && filteredJobs.length === 0 && (
            <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
              <Transform sx={{ fontSize: 32, opacity: 0.2, mb: 1 }} />
              <Typography variant="caption" color="text.disabled" display="block">No transform jobs</Typography>
              <Button size="small" startIcon={<Add />} sx={{ mt: 1 }} onClick={() => { setEditingJob(null); setJobDialogOpen(true) }}>Create first</Button>
            </Box>
          )}
          {filteredJobs.map((j) => {
            const active = selectedJobId === j.id
            return (
              <ListItemButton key={j.id} dense selected={active}
                onClick={() => setSelectedJobId(j.id)}
                sx={{ pl: 1.5, pr: 0.5, py: 0.75, borderBottom: `1px solid ${alpha(theme.palette.divider, 0.5)}` }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Typography variant="body2" fontWeight={active ? 600 : 400} noWrap sx={{ flex: 1, fontSize: '0.8rem' }}>{j.name}</Typography>
                    <StatusDot status={j.status} />
                  </Box>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ fontSize: '0.68rem', fontFamily: MONO }}>
                    {j.source_database ? `${j.source_database}.` : ''}{j.source_table} → {j.target_database ? `${j.target_database}.` : ''}{j.target_table}
                  </Typography>
                  {(j.tags ?? []).length > 0 && (
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.3, mt: 0.25 }}>
                      {(j.tags ?? []).map((t) => (
                        <Chip key={t} label={t} size="small" sx={{ height: 14, fontSize: '0.6rem', bgcolor: alpha(theme.palette.warning.main, 0.12), '& .MuiChip-label': { px: 0.5 } }} />
                      ))}
                    </Box>
                  )}
                </Box>
              </ListItemButton>
            )
          })}
        </Box>
      </Paper>

      {/* Center: job detail + bottom panel */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', bgcolor: alpha(theme.palette.background.default, 0.5) }}>
        {selectedJob ? (
          <>
            {/* Job header */}
            <Box sx={{ px: 2, pt: 1.5, pb: 0, display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
              <Transform color="warning" />
              <Typography variant="h6" fontWeight={700}>{selectedJob.name}</Typography>
              <StatusChip status={selectedJob.status} />
              <Box sx={{ flex: 1 }} />
              {selectedJob.status === 'running' ? (
                <Button size="small" variant="outlined" color="error"
                  startIcon={cancelJob.isPending ? <CircularProgress size={12} color="inherit" /> : <Close />}
                  disabled={cancelJob.isPending}
                  onClick={() => cancelJob.mutate(selectedJob.id)}>
                  Stop
                </Button>
              ) : (
                <Button size="small" variant="contained" color="success"
                  startIcon={runJob.isPending ? <CircularProgress size={12} color="inherit" /> : <PlayArrow />}
                  disabled={runJob.isPending}
                  onClick={() => runJob.mutate(selectedJob.id)}>
                  Run
                </Button>
              )}
              <Button size="small" variant="outlined" startIcon={<Visibility />} onClick={() => openPreview(selectedJob)}>Preview</Button>
              <Button size="small" variant="outlined" startIcon={<Edit />} onClick={() => { setEditingJob(selectedJob); setJobDialogOpen(true) }}>Edit</Button>
              <Button size="small" variant="outlined" color="error" startIcon={<Delete />} onClick={() => setDeleteJobId(selectedJob.id)}>Delete</Button>
            </Box>

            {/* Flow diagram */}
            <Box sx={{ px: 2, pt: 1, flexShrink: 0, borderBottom: `1px solid ${theme.palette.divider}` }}>
              <TransformFlowDiagram job={selectedJob} activeNode={activeNode} onNodeClick={handleNodeClick} />
            </Box>

            {/* Stats row */}
            {selectedJob.last_run_at && (
              <Box sx={{ px: 2, py: 0.75, display: 'flex', alignItems: 'center', gap: 2, borderBottom: `1px solid ${theme.palette.divider}`, flexShrink: 0, bgcolor: panelBg }}>
                <Tooltip title={formatDistanceToNow(parseApiDate(selectedJob.last_run_at), { addSuffix: true })}>
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                    {format(parseApiDate(selectedJob.last_run_at), 'dd MMM yyyy HH:mm:ss')}
                  </Typography>
                </Tooltip>
                {selectedJob.last_run_duration_s != null && (
                  <Typography variant="caption" color="text.secondary">Duration: <strong>{selectedJob.last_run_duration_s.toFixed(1)}s</strong></Typography>
                )}
                {selectedJob.last_run_rows != null && (
                  <Typography variant="caption" color="text.secondary">Rows: <strong>{selectedJob.last_run_rows.toLocaleString()}</strong></Typography>
                )}
              </Box>
            )}
            {selectedJob.last_error && (
              <Alert severity="error" icon={<ErrorIcon fontSize="small" />} sx={{ mx: 2, my: 0.5, py: 0.5, fontSize: '0.75rem', flexShrink: 0 }}>{selectedJob.last_error}</Alert>
            )}

            {/* Bottom panel */}
            {bottomPanel && (
              <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderTop: `1px solid ${theme.palette.divider}`, minHeight: 0 }}>
                {/* Panel toolbar */}
                <Box sx={{ px: 1.5, py: 0.5, display: 'flex', alignItems: 'center', gap: 1, bgcolor: panelBg, borderBottom: `1px solid ${theme.palette.divider}`, flexShrink: 0 }}>
                  {bottomPanel === 'sql' && <Code sx={{ fontSize: 14, color: 'warning.main' }} />}
                  {bottomPanel === 'notebook' && <NoteAlt sx={{ fontSize: 14, color: 'warning.main' }} />}
                  {(bottomPanel === 'source-preview' || bottomPanel === 'target-preview') && <TableChart sx={{ fontSize: 14, color: 'info.main' }} />}
                  <Typography variant="caption" fontWeight={600} sx={{ flex: 1 }}>
                    {bottomPanel === 'sql' && `SQL — ${selectedJob.sql_file_name ?? 'inline'}`}
                    {bottomPanel === 'notebook' && `Notebook — ${selectedJob.notebook_file_name ?? 'attached'}`}
                    {bottomPanel === 'source-preview' && `Source Preview — ${selectedJob.source_table}`}
                    {bottomPanel === 'target-preview' && `Target Preview — ${selectedJob.target_table}`}
                  </Typography>
                  {draftDirty && bottomPanel === 'sql' && sqlFileId && (
                    <Button size="small" variant="outlined" startIcon={saveSqlDraft.isPending ? <CircularProgress size={11} /> : <Save />}
                      disabled={saveSqlDraft.isPending} onClick={() => saveSqlDraft.mutate()}>Save</Button>
                  )}
                  {draftDirty && bottomPanel === 'notebook' && nbFileId && (
                    <Button size="small" variant="outlined" startIcon={saveNbDraft.isPending ? <CircularProgress size={11} /> : <Save />}
                      disabled={saveNbDraft.isPending} onClick={() => saveNbDraft.mutate()}>Save</Button>
                  )}
                  <IconButton size="small" onClick={() => { setActiveNode(null); setBottomPanel(null) }}><Close sx={{ fontSize: 14 }} /></IconButton>
                </Box>
                {/* Panel content */}
                <Box sx={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
                  {bottomPanel === 'sql' && (
                    <SqlEditor value={sqlDraft} onChange={(v) => { setSqlDraft(v); setDraftDirty(true) }} />
                  )}
                  {bottomPanel === 'notebook' && (
                    <NotebookEditor cells={nbCellsDraft} onChange={(c) => { setNbCellsDraft(c); setDraftDirty(true) }} />
                  )}
                  {(bottomPanel === 'source-preview' || bottomPanel === 'target-preview') && (() => {
                    const isSource = bottomPanel === 'source-preview'
                    const result = isSource ? sourcePreviewResult : targetPreviewResult
                    const error = isSource ? sourcePreviewError : targetPreviewError
                    const loading = !result && !error
                    return (
                      <Box sx={{ flex: 1, overflow: 'auto' }}>
                        {loading && <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={24} /></Box>}
                        {error && <Alert severity="warning" sx={{ m: 2 }}>{error}</Alert>}
                        {result && (
                          <Table size="small" stickyHeader>
                            <TableHead>
                              <TableRow>
                                {result.columns.map((col) => (
                                  <TableCell key={col} sx={{ fontFamily: MONO, fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap', bgcolor: 'background.paper' }}>{col}</TableCell>
                                ))}
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {result.rows.map((row, ri) => (
                                <TableRow key={ri} hover>
                                  {(row as unknown[]).map((cell, ci) => (
                                    <TableCell key={ci} sx={{ fontFamily: MONO, fontSize: '0.72rem', whiteSpace: 'nowrap' }}>
                                      {cell === null ? <span style={{ color: theme.palette.text.disabled }}>null</span> : String(cell)}
                                    </TableCell>
                                  ))}
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        )}
                      </Box>
                    )
                  })()}
                </Box>
              </Box>
            )}

            {/* Placeholder when no node selected */}
            {!bottomPanel && (
              <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.disabled', flexDirection: 'column', gap: 1, p: 3 }}>
                <Typography variant="body2" color="text.disabled">Click a node above to view source data, the transform script, or the target output.</Typography>
              </Box>
            )}
          </>
        ) : (
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'text.disabled', gap: 2, p: 4 }}>
            <Transform sx={{ fontSize: 56, opacity: 0.2 }} />
            <Typography variant="h6" color="text.disabled">Select a transform job</Typography>
            <Button variant="contained" startIcon={<Add />} onClick={() => { setEditingJob(null); setJobDialogOpen(true) }}>New Transform Job</Button>
          </Box>
        )}
      </Box>

    </Box>
  )

  // ─── TAB 2: PIPELINES (CHAINS) ────────────────────────────────────────────

  const renderPipelinesTab = () => {
    const isNew = chainSel?.isNew === true

    const moveStep = (idx: number, dir: -1 | 1) => {
      const next = [...chainForm.steps]; const target = idx + dir
      if (target < 0 || target >= next.length) return
      ;[next[idx], next[target]] = [next[target], next[idx]]
      setChainForm((f) => ({ ...f, steps: next })); setChainDirty(true)
    }
    const removeStep = (idx: number) => { setChainForm((f) => ({ ...f, steps: f.steps.filter((_, i) => i !== idx) })); setChainDirty(true) }
    const addStep = () => {
      if (addStepId === '') return
      const step: ChainStep = addStepType === 'pipeline'
        ? { type: 'pipeline', pipeline_id: Number(addStepId), label: pipelines.find((p) => p.id === Number(addStepId))?.name }
        : { type: 'transform', transform_job_id: Number(addStepId), label: jobs.find((j) => j.id === Number(addStepId))?.name }
      setChainForm((f) => ({ ...f, steps: [...f.steps, step] })); setChainDirty(true); setAddStepId('')
    }

    return (
      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left sidebar */}
        <Paper elevation={0} sx={{ width: 240, flexShrink: 0, borderRight: `1px solid ${theme.palette.divider}`, display: 'flex', flexDirection: 'column', bgcolor: panelBg, overflow: 'hidden' }}>
          <Box sx={{ px: 1.5, py: 0.75, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <AccountTree sx={{ fontSize: 13, color: 'primary.main' }} />
            <Typography variant="caption" fontWeight={700} sx={{ flex: 1, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.07em', color: 'text.secondary' }}>
              Pipelines ({filteredChains.length})
            </Typography>
            <Tooltip title="New pipeline chain">
              <IconButton size="small" onClick={() => { setChainSel({ id: null, isNew: true }); setChainForm({ name: '', description: '', steps: [] }); setChainDirty(false) }}><Add sx={{ fontSize: 14 }} /></IconButton>
            </Tooltip>
          </Box>
          <SearchBar />
          <Box sx={{ flex: 1, overflowY: 'auto' }}>
            {chainsLoading && <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}><CircularProgress size={20} /></Box>}
            {!chainsLoading && filteredChains.length === 0 && (
              <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
                <AccountTree sx={{ fontSize: 32, opacity: 0.2, mb: 1 }} />
                <Typography variant="caption" color="text.disabled" display="block">No pipelines yet</Typography>
                <Button size="small" startIcon={<Add />} sx={{ mt: 1 }} onClick={() => { setChainSel({ id: null, isNew: true }); setChainForm({ name: '', description: '', steps: [] }); setChainDirty(false) }}>Create first</Button>
              </Box>
            )}
            {filteredChains.map((c) => {
              const active = !chainSel?.isNew && (chainSel as any)?.id === c.id
              return (
                <ListItemButton key={c.id} dense selected={active}
                  onClick={() => setChainSel({ id: c.id, isNew: false })}
                  sx={{ pl: 1.5, pr: 0.5, py: 0.75, borderBottom: `1px solid ${alpha(theme.palette.divider, 0.5)}` }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Typography variant="body2" fontWeight={active ? 600 : 400} noWrap sx={{ flex: 1, fontSize: '0.8rem' }}>{c.name}</Typography>
                      <StatusDot status={c.status} />
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.68rem' }}>
                      {c.steps.length} step{c.steps.length !== 1 ? 's' : ''}
                      {c.last_run_at && ` · ${format(parseApiDate(c.last_run_at), 'dd MMM HH:mm:ss')}`}
                    </Typography>
                  </Box>
                </ListItemButton>
              )
            })}
          </Box>
        </Paper>

        {/* Center: chain builder */}
        <Box sx={{ flex: 1, overflow: 'auto', bgcolor: alpha(theme.palette.background.default, 0.5) }}>
          {chainSel ? (
            <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {/* Header */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <AccountTree color="primary" />
                <Typography variant="h6" fontWeight={700}>{isNew ? 'New Pipeline' : (selectedChain?.name ?? 'Pipeline')}</Typography>
                {selectedChain && <StatusChip status={selectedChain.status} />}
                <Box sx={{ flex: 1 }} />
                {selectedChain && (
                  <Button size="small" variant="outlined" color="error" startIcon={<Delete />} onClick={() => setDeleteChainId(selectedChain.id)}>Delete</Button>
                )}
              </Box>

              {/* Name/desc */}
              <Grid container spacing={2}>
                <Grid item xs={7}>
                  <TextField label="Pipeline Name" value={chainForm.name} fullWidth size="small" required
                    onChange={(e) => { setChainForm((f) => ({ ...f, name: e.target.value })); setChainDirty(true) }} />
                </Grid>
                <Grid item xs={5}>
                  <TextField label="Description" value={chainForm.description ?? ''} fullWidth size="small"
                    onChange={(e) => { setChainForm((f) => ({ ...f, description: e.target.value })); setChainDirty(true) }} />
                </Grid>
              </Grid>

              {/* Visual flow */}
              {!isNew && selectedChain && (
                <Paper variant="outlined" sx={{ p: 2 }}>
                  <ChainFlowDiagram
                    chain={selectedChain} pipelines={pipelines} jobs={jobs}
                    onRun={() => runChain.mutate(selectedChain.id)}
                    running={selectedChain.status === 'running' || runChain.isPending}
                  />
                </Paper>
              )}

              {/* Step list */}
              <Divider><Typography variant="caption" color="text.secondary">Steps</Typography></Divider>
              {chainForm.steps.length === 0 && (
                <Typography variant="caption" color="text.disabled" sx={{ textAlign: 'center', py: 1 }}>
                  No steps yet — add extracts and transforms below
                </Typography>
              )}
              {chainForm.steps.map((step, idx) => (
                <Box key={idx} sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.75, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
                  <DragIndicator sx={{ fontSize: 16, color: 'text.disabled' }} />
                  <Typography variant="caption" color="text.secondary" sx={{ minWidth: 18 }}>{idx + 1}.</Typography>
                  <StepBadge step={step} />
                  <Box sx={{ flex: 1 }} />
                  <IconButton size="small" disabled={idx === 0} onClick={() => moveStep(idx, -1)}><KeyboardArrowUp sx={{ fontSize: 16 }} /></IconButton>
                  <IconButton size="small" disabled={idx === chainForm.steps.length - 1} onClick={() => moveStep(idx, 1)}><KeyboardArrowDown sx={{ fontSize: 16 }} /></IconButton>
                  <IconButton size="small" color="error" onClick={() => removeStep(idx)}><Delete sx={{ fontSize: 15 }} /></IconButton>
                </Box>
              ))}

              <Divider><Typography variant="caption" color="text.secondary">Add step</Typography></Divider>
              <Stack direction="row" spacing={1} alignItems="flex-end">
                <FormControl size="small" sx={{ width: 130 }}>
                  <InputLabel>Type</InputLabel>
                  <Select value={addStepType} label="Type" onChange={(e) => { setAddStepType(e.target.value as 'pipeline' | 'transform'); setAddStepId('') }}>
                    <MenuItem value="pipeline">Extract</MenuItem>
                    <MenuItem value="transform">Transform</MenuItem>
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ flex: 1 }}>
                  <InputLabel>{addStepType === 'pipeline' ? 'Extract Pipeline' : 'Transform Job'}</InputLabel>
                  <Select value={addStepId} label={addStepType === 'pipeline' ? 'Extract Pipeline' : 'Transform Job'}
                    onChange={(e) => setAddStepId(e.target.value as number)}>
                    {addStepType === 'pipeline'
                      ? pipelines.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)
                      : jobs.map((j) => <MenuItem key={j.id} value={j.id}>{j.name}</MenuItem>)}
                  </Select>
                </FormControl>
                <Button variant="outlined" size="small" onClick={addStep} disabled={addStepId === ''} startIcon={<Add />}>Add</Button>
              </Stack>

              {chainDirty && (
                <Box sx={{ display: 'flex', gap: 1, pt: 1 }}>
                  <Button variant="contained"
                    startIcon={(createChain.isPending || updateChain.isPending) ? <CircularProgress size={14} color="inherit" /> : <Save />}
                    onClick={handleChainSave}
                    disabled={!chainForm.name.trim() || chainForm.steps.length === 0 || createChain.isPending || updateChain.isPending}>
                    {isNew ? 'Create Pipeline' : 'Save Changes'}
                  </Button>
                  <Button variant="outlined" onClick={() => {
                    if (selectedChain) { setChainForm({ name: selectedChain.name, description: selectedChain.description ?? '', steps: selectedChain.steps }); setChainDirty(false) }
                    else { setChainForm({ name: '', description: '', steps: [] }); setChainDirty(false) }
                  }}>Reset</Button>
                </Box>
              )}
            </Box>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'text.disabled', gap: 2, p: 4 }}>
              <AccountTree sx={{ fontSize: 56, opacity: 0.2 }} />
              <Typography variant="h6" color="text.disabled">Select or create a pipeline</Typography>
              <Typography variant="body2" color="text.disabled" align="center">
                Pipelines chain together Extract and Transform steps into an automated sequence.
              </Typography>
              <Button variant="contained" startIcon={<Add />} onClick={() => { setChainSel({ id: null, isNew: true }); setChainForm({ name: '', description: '', steps: [] }); setChainDirty(false) }}>
                New Pipeline
              </Button>
            </Box>
          )}
        </Box>

        {/* Right: chain action panel */}
        <Paper elevation={0} sx={{ width: 210, flexShrink: 0, borderLeft: `1px solid ${theme.palette.divider}`, bgcolor: panelBg, overflow: 'auto' }}>
          {selectedChain ? (
            <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="subtitle2" fontWeight={700} noWrap sx={{ flex: 1 }}>{selectedChain.name}</Typography>
                <StatusChip status={selectedChain.status} />
              </Box>
              <Button variant="contained" color="success" fullWidth
                startIcon={selectedChain.status === 'running' || runChain.isPending ? <CircularProgress size={14} color="inherit" /> : <PlayArrow />}
                disabled={selectedChain.status === 'running' || runChain.isPending}
                onClick={() => runChain.mutate(selectedChain.id)}>
                Run Pipeline
              </Button>
              <Button variant="outlined" color="error" fullWidth startIcon={<Delete />} onClick={() => setDeleteChainId(selectedChain.id)}>Delete</Button>
              {selectedChain.last_run_at && (
                <>
                  <Divider />
                  <Tooltip title={formatDistanceToNow(parseApiDate(selectedChain.last_run_at), { addSuffix: true })}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                      {format(parseApiDate(selectedChain.last_run_at), 'dd MMM yyyy HH:mm:ss')}
                      {selectedChain.last_run_duration_s != null && ` · ${selectedChain.last_run_duration_s.toFixed(1)}s`}
                    </Typography>
                  </Tooltip>
                </>
              )}
              {selectedChain.last_error && <Alert severity="error" icon={false} sx={{ py: 0.5, fontSize: '0.72rem' }}>{selectedChain.last_error}</Alert>}
            </Box>
          ) : (
            <Box sx={{ p: 2, color: 'text.disabled', display: 'flex', flexDirection: 'column', alignItems: 'center', pt: 6, gap: 1 }}>
              <Typography variant="caption" align="center">Select a pipeline to see actions</Typography>
            </Box>
          )}
        </Paper>
      </Box>
    )
  }

  // ─── Layout ────────────────────────────────────────────────────────────────

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Tab bar */}
      <Box sx={{ borderBottom: `1px solid ${theme.palette.divider}`, bgcolor: panelBg, px: 2, pt: 0.5, display: 'flex', alignItems: 'flex-end', gap: 0 }}>
        <Tabs value={mainTab} onChange={(_, v) => setMainTab(v)} sx={{ minHeight: 42 }}>
          <Tab label="Extracts" icon={<Storage sx={{ fontSize: 15 }} />} iconPosition="start" sx={{ minHeight: 42, fontSize: '0.82rem', textTransform: 'none', gap: 0.5, px: 2 }} />
          <Tab label="Transformations" icon={<Transform sx={{ fontSize: 15 }} />} iconPosition="start" sx={{ minHeight: 42, fontSize: '0.82rem', textTransform: 'none', gap: 0.5, px: 2 }} />
          <Tab label="Pipelines" icon={<AccountTree sx={{ fontSize: 15 }} />} iconPosition="start" sx={{ minHeight: 42, fontSize: '0.82rem', textTransform: 'none', gap: 0.5, px: 2 }} />
        </Tabs>
        <Box sx={{ flex: 1 }} />
        <Box sx={{ pb: 0.5 }}><ExecutionContextBar /></Box>
      </Box>

      {/* Tab content */}
      <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {mainTab === 0 && renderExtractsTab()}
        {mainTab === 1 && renderTransformationsTab()}
        {mainTab === 2 && renderPipelinesTab()}
      </Box>

      {/* ── Dialogs ── */}
      <RunPipelineDialog pipeline={runPipelineTarget} open={runPipelineTarget !== null} onClose={() => setRunPipelineTarget(null)} />

      <JobFormDialog open={jobDialogOpen} onClose={() => setJobDialogOpen(false)} initial={editingJob ?? undefined} onSave={handleJobSave} saving={createJob.isPending || updateJob.isPending} />

      {/* Clone pipeline */}
      <Dialog open={clonePipelineTarget !== null} onClose={() => setClonePipelineTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Clone Extract Pipeline</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Creates a copy of <strong>{clonePipelineTarget?.name}</strong> reusing all config.
          </Typography>
          <TextField label="New pipeline name" value={cloneName} onChange={(e) => setCloneName(e.target.value)} fullWidth size="small" autoFocus />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClonePipelineTarget(null)}>Cancel</Button>
          <Button variant="contained" disabled={!cloneName.trim() || createPipeline.isPending}
            onClick={() => {
              if (!clonePipelineTarget || !cloneName.trim()) return
              createPipeline.mutate({ ...pipelineToForm(clonePipelineTarget), name: cloneName.trim() })
              setClonePipelineTarget(null)
            }}>
            {createPipeline.isPending ? <CircularProgress size={16} /> : 'Clone'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete pipeline */}
      <Dialog open={deletePipelineId !== null} onClose={() => setDeletePipelineId(null)} maxWidth="xs">
        <DialogTitle>Delete pipeline?</DialogTitle>
        <DialogContent><Typography>This will permanently delete the pipeline.</Typography></DialogContent>
        <DialogActions>
          <Button onClick={() => setDeletePipelineId(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => deletePipelineId && deletePipeline.mutate(deletePipelineId)} disabled={deletePipeline.isPending}>Delete</Button>
        </DialogActions>
      </Dialog>

      {/* Delete job */}
      <Dialog open={deleteJobId !== null} onClose={() => setDeleteJobId(null)} maxWidth="xs">
        <DialogTitle>Delete transform job?</DialogTitle>
        <DialogContent><Typography>This will permanently delete this job.</Typography></DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteJobId(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => deleteJobId && deleteJob.mutate(deleteJobId)} disabled={deleteJob.isPending}>Delete</Button>
        </DialogActions>
      </Dialog>

      {/* Delete chain */}
      <Dialog open={deleteChainId !== null} onClose={() => setDeleteChainId(null)} maxWidth="xs">
        <DialogTitle>Delete pipeline chain?</DialogTitle>
        <DialogContent><Typography>This will permanently delete this pipeline chain.</Typography></DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteChainId(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => deleteChainId && deleteChain.mutate(deleteChainId)} disabled={deleteChain.isPending}>Delete</Button>
        </DialogActions>
      </Dialog>

      {/* Transform output preview dialog */}
      <Dialog open={previewOpen} onClose={() => setPreviewOpen(false)} maxWidth="lg" fullWidth PaperProps={{ sx: { height: '80vh' } }}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
          <Visibility sx={{ fontSize: 18 }} />
          Output Preview — {previewJob?.name}
          {previewResult && (
            <Chip label={`${previewResult.row_count} rows · ${previewResult.duration_ms.toFixed(0)}ms`} size="small" color="info" variant="outlined" sx={{ ml: 1 }} />
          )}
          <Box sx={{ flex: 1 }} />
          <IconButton size="small" onClick={() => setPreviewOpen(false)}><Close sx={{ fontSize: 16 }} /></IconButton>
        </DialogTitle>
        <DialogContent sx={{ p: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {runPreview.isPending && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 1 }}>
              <CircularProgress size={24} /><Typography color="text.secondary">Running transform preview…</Typography>
            </Box>
          )}
          {previewError && !runPreview.isPending && <Alert severity="error" sx={{ m: 2 }}>{previewError}</Alert>}
          {previewResult && !runPreview.isPending && (
            <Box sx={{ overflow: 'auto', flex: 1 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    {previewResult.columns.map((col) => (
                      <TableCell key={col} sx={{ fontFamily: MONO, fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap', bgcolor: 'background.paper' }}>{col}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {previewResult.rows.map((row, ri) => (
                    <TableRow key={ri} hover>
                      {(row as unknown[]).map((cell, ci) => (
                        <TableCell key={ci} sx={{ fontFamily: MONO, fontSize: '0.72rem', whiteSpace: 'nowrap' }}>
                          {cell === null ? <span style={{ color: theme.palette.text.disabled }}>null</span> : String(cell)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </DialogContent>
      </Dialog>
    </Box>
  )
}
