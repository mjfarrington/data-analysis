import { useState } from 'react'
import {
  Box, Button, Card, CardContent, Typography, IconButton, Chip, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Grid, Tooltip, alpha, useTheme, Accordion, AccordionSummary, AccordionDetails,
  FormControlLabel, Switch, Alert, CircularProgress, InputAdornment,
  Paper, Select, FormControl, InputLabel,
} from '@mui/material'
import {
  Add, PlayArrow, Edit, Delete, ExpandMore, Schedule, ChevronRight,
  Storage, Description, TableChart, Code, CalendarToday, Tag, OpenInNew,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useSnackbar } from 'notistack'
import { pipelinesApi, sqlFilesApi, Pipeline, ExtractConfig, SourceType, ExecutionContext, RunTrigger } from '../api/client'
import StatusChip from '../components/StatusChip'
import { formatDistanceToNow } from 'date-fns'

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
  file_path: '',
  file_encoding: 'utf-8',
  csv_delimiter: ',',
  csv_has_header: true,
  json_lines: true,
})

const defaultPipeline = () => ({
  name: '',
  description: '',
  extract_config: defaultExtractConfig(),
  transform_config: {
    filters: {} as Record<string, string>,
    drop_columns: [] as string[],
    rename_columns: {} as Record<string, string>,
    dedup: true,
    dedup_keys: ['id'] as string[],
  },
  load_config: {
    target: 'parquet' as 'parquet' | 'csv' | 'spark_table',
    table_name: undefined as string | undefined,
    use_namespace: false,
    partition_by: ['date', 'application_id'] as string[],
    mode: 'overwrite' as 'overwrite' | 'append',
  },
  schedule: '',
  schedule_enabled: false,
})

function PipelineCard({ pipeline, onEdit, onDelete, onRun }: {
  pipeline: Pipeline
  onEdit: (p: Pipeline) => void
  onDelete: (p: Pipeline) => void
  onRun: (p: Pipeline) => void
}) {
  const theme = useTheme()
  const navigate = useNavigate()
  const lastRun = pipeline.last_run

  return (
    <Card sx={{ transition: 'transform 0.15s', '&:hover': { transform: 'translateY(-2px)' } }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
              <Typography variant="subtitle1" fontWeight={600} noWrap>{pipeline.name}</Typography>
              <StatusChip status={pipeline.status} />
            </Box>
            {pipeline.description && (
              <Typography variant="body2" color="text.secondary" noWrap sx={{ mb: 1 }}>
                {pipeline.description}
              </Typography>
            )}
          </Box>
          <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
            <Tooltip title="Run now">
              <IconButton size="small" color="primary" onClick={() => onRun(pipeline)}>
                <PlayArrow fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Explore extracted data">
              <IconButton size="small" color="secondary"
                onClick={() => navigate('/explorer')}
              >
                <OpenInNew fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Edit">
              <IconButton size="small" onClick={() => onEdit(pipeline)}>
                <Edit fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Delete">
              <IconButton size="small" color="error" onClick={() => onDelete(pipeline)}>
                <Delete fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>

        <Divider sx={{ my: 1 }} />

        <Grid container spacing={1}>
          <Grid item xs={6}>
            <Typography variant="caption" color="text.secondary" display="block">Source</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {SOURCE_ICONS[pipeline.extract_config.source_type ?? 'grpc']}
              <Typography variant="body2">
                {(pipeline.extract_config.source_type ?? 'grpc').toUpperCase()}
              </Typography>
            </Box>
          </Grid>
          <Grid item xs={6}>
            <Typography variant="caption" color="text.secondary" display="block">Output</Typography>
            <Typography variant="body2">{pipeline.load_config.target.toUpperCase()}</Typography>
            {pipeline.load_config.use_namespace && (
              <Chip label="namespace" size="small" color="primary" variant="outlined"
                sx={{ fontSize: '0.62rem', height: 16, mt: 0.25 }} />
            )}
            {!pipeline.load_config.use_namespace && pipeline.load_config.table_name && (
              <Typography variant="caption" color="text.secondary" noWrap sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.7rem' }}>
                {pipeline.load_config.table_name}
              </Typography>
            )}
          </Grid>
          {pipeline.extract_config.source_type === 'grpc' || !pipeline.extract_config.source_type ? (
            <Grid item xs={12}>
              <Typography variant="caption" color="text.secondary" display="block">Apps</Typography>
              <Typography variant="body2" noWrap>
                {pipeline.extract_config.application_ids?.slice(0, 3).join(', ')}
                {(pipeline.extract_config.application_ids?.length ?? 0) > 3 &&
                  ` +${pipeline.extract_config.application_ids.length - 3}`}
              </Typography>
            </Grid>
          ) : pipeline.extract_config.source_type === 'jdbc' ? (
            <Grid item xs={12}>
              <Typography variant="caption" color="text.secondary" display="block">Connection</Typography>
              <Typography variant="body2" noWrap sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.7rem' }}>
                {pipeline.extract_config.jdbc_url || '—'}
              </Typography>
            </Grid>
          ) : (
            <Grid item xs={12}>
              <Typography variant="caption" color="text.secondary" display="block">File</Typography>
              <Typography variant="body2" noWrap sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.7rem' }}>
                {pipeline.extract_config.file_path || '—'}
              </Typography>
            </Grid>
          )}
          <Grid item xs={6}>
            <Typography variant="caption" color="text.secondary" display="block">Rows/Segment</Typography>
            <Typography variant="body2">
              {(pipeline.extract_config.rows_per_segment ?? 100000).toLocaleString()}
            </Typography>
          </Grid>
          <Grid item xs={6}>
            <Typography variant="caption" color="text.secondary" display="block">Total Runs</Typography>
            <Typography variant="body2">{pipeline.total_runs}</Typography>
          </Grid>
          <Grid item xs={12}>
            <Typography variant="caption" color="text.secondary" display="block">Last Run</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {lastRun ? (
                <>
                  <StatusChip status={lastRun.status} />
                  <Typography variant="caption" color="text.secondary">
                    {formatDistanceToNow(new Date(lastRun.created_at), { addSuffix: true })}
                  </Typography>
                </>
              ) : (
                <Typography variant="caption" color="text.secondary">Never</Typography>
              )}
            </Box>
          </Grid>
        </Grid>

        {pipeline.schedule_enabled && pipeline.schedule && (
          <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Schedule sx={{ fontSize: 14, color: 'text.secondary' }} />
            <Typography variant="caption" sx={{ fontFamily: '"JetBrains Mono", monospace', color: 'text.secondary' }}>
              {pipeline.schedule}
            </Typography>
          </Box>
        )}
      </CardContent>
    </Card>
  )
}

function PipelineDialog({ open, initial, onClose, onSave }: {
  open: boolean
  initial?: Pipeline | null
  onClose: () => void
  onSave: (data: ReturnType<typeof defaultPipeline>) => void
}) {
  const [form, setForm] = useState<ReturnType<typeof defaultPipeline>>(initial ? {
    name: initial.name,
    description: initial.description || '',
    extract_config: {
      ...defaultExtractConfig(),
      ...initial.extract_config,
      date_from: initial.extract_config.date_from ?? '',
      date_to: initial.extract_config.date_to ?? '',
    },
    transform_config: {
      filters: initial.transform_config?.filters ?? {},
      drop_columns: initial.transform_config?.drop_columns ?? [],
      rename_columns: initial.transform_config?.rename_columns ?? {},
      dedup: initial.transform_config?.dedup ?? true,
      dedup_keys: initial.transform_config?.dedup_keys ?? ['id'],
    },
    load_config: {
      target: (initial.load_config?.target ?? 'parquet') as 'parquet' | 'csv' | 'spark_table',
      table_name: initial.load_config?.table_name,
      use_namespace: initial.load_config?.use_namespace ?? false,
      partition_by: initial.load_config?.partition_by ?? ['date', 'application_id'],
      mode: (initial.load_config?.mode ?? 'overwrite') as 'overwrite' | 'append',
    },
    schedule: initial.schedule || '',
    schedule_enabled: initial.schedule_enabled,
  } : defaultPipeline())

  const { data: sqlFiles = [] } = useQuery({
    queryKey: ['sql-files'],
    queryFn: () => sqlFilesApi.list().then((r) => r.data),
  })

  const source = form.extract_config.source_type ?? 'grpc'

  const setExtract = (key: string, val: unknown) =>
    setForm((f) => ({ ...f, extract_config: { ...f.extract_config, [key]: val } }))
  const setLoad = (key: string, val: unknown) =>
    setForm((f) => ({ ...f, load_config: { ...f.load_config, [key]: val } }))

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{initial ? 'Edit Pipeline' : 'New ETL Pipeline'}</DialogTitle>
      <DialogContent dividers>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={8}>
            <TextField label="Name" value={form.name} fullWidth size="small"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField label="Description" value={form.description} fullWidth size="small"
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </Grid>

          {/* ── Extract ── */}
          <Grid item xs={12}>
            <Accordion defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="subtitle2" fontWeight={600}>Extract Configuration</Typography>
                  <Chip
                    label={source.toUpperCase()}
                    size="small"
                    icon={<>{SOURCE_ICONS[source as SourceType]}</>}
                    color="primary"
                    variant="outlined"
                  />
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                <Grid container spacing={2}>

                  {/* Source type */}
                  <Grid item xs={12} sm={6}>
                    <TextField select label="Source Type" value={source} fullWidth size="small"
                      onChange={(e) => setExtract('source_type', e.target.value)}>
                      <MenuItem value="grpc">gRPC (Data Extract Service)</MenuItem>
                      <MenuItem value="jdbc">JDBC (SQL Database)</MenuItem>
                      <MenuItem value="json">JSON File</MenuItem>
                      <MenuItem value="csv">CSV File</MenuItem>
                    </TextField>
                  </Grid>

                  {/* Output format */}
                  <Grid item xs={12} sm={6}>
                    <TextField select label="Output Format" value={form.extract_config.output_format} fullWidth size="small"
                      onChange={(e) => setExtract('output_format', e.target.value)}>
                      <MenuItem value="parquet">Parquet</MenuItem>
                      <MenuItem value="csv">CSV</MenuItem>
                    </TextField>
                  </Grid>

                  {/* ── gRPC params ── */}
                  {source === 'grpc' && (
                    <>
                      <Grid item xs={12}>
                        <TextField
                          label="Application IDs (comma-separated)"
                          value={form.extract_config.application_ids?.join(', ') ?? ''}
                          fullWidth size="small"
                          helperText="e.g. APP001, APP002, APP003"
                          onChange={(e) => setExtract('application_ids',
                            e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                        />
                      </Grid>
                      <Grid item xs={12} sm={6}>
                        <TextField label="Batch Page Size" type="number"
                          value={form.extract_config.page_size} fullWidth size="small"
                          helperText="Records per gRPC request"
                          InputProps={{ inputProps: { min: 100, max: 100000 } }}
                          onChange={(e) => setExtract('page_size', parseInt(e.target.value))} />
                      </Grid>
                    </>
                  )}

                  {/* ── JDBC params ── */}
                  {source === 'jdbc' && (
                    <>
                      <Grid item xs={12}>
                        <TextField
                          label="Connection URL"
                          value={form.extract_config.jdbc_url ?? ''} fullWidth size="small"
                          placeholder="sqlite:///data/sources/sample.db  or  postgresql://user:pass@host/db"
                          helperText="SQLAlchemy connection string"
                          onChange={(e) => setExtract('jdbc_url', e.target.value)} />
                      </Grid>
                      <Grid item xs={12}>
                        <TextField select label="SQL File"
                          value={form.extract_config.jdbc_sql_file_id ?? ''}
                          fullWidth size="small"
                          helperText="Choose a saved SQL file, or enter SQL below"
                          onChange={(e) => setExtract('jdbc_sql_file_id', e.target.value ? parseInt(String(e.target.value)) : undefined)}>
                          <MenuItem value="">— None (use inline SQL or table name) —</MenuItem>
                          {sqlFiles.map((f) => (
                            <MenuItem key={f.id} value={f.id}>{f.name}</MenuItem>
                          ))}
                        </TextField>
                      </Grid>
                      {!form.extract_config.jdbc_sql_file_id && (
                        <Grid item xs={12}>
                          <TextField
                            label="Inline SQL"
                            value={form.extract_config.jdbc_sql ?? ''} fullWidth size="small"
                            multiline rows={4}
                            placeholder="SELECT * FROM transactions WHERE status = 'active'"
                            helperText="Leave blank to use Table Name below"
                            inputProps={{ style: { fontFamily: '"JetBrains Mono", monospace', fontSize: '0.8rem' } }}
                            onChange={(e) => setExtract('jdbc_sql', e.target.value)} />
                        </Grid>
                      )}
                      {!form.extract_config.jdbc_sql_file_id && !form.extract_config.jdbc_sql && (
                        <Grid item xs={12} sm={6}>
                          <TextField label="Table Name" value={form.extract_config.jdbc_table ?? ''}
                            fullWidth size="small" placeholder="transactions"
                            helperText="Simple table name (no SQL needed)"
                            onChange={(e) => setExtract('jdbc_table', e.target.value)} />
                        </Grid>
                      )}
                      <Grid item xs={12} sm={6}>
                        <TextField label="Date Column (optional)"
                          value={form.extract_config.jdbc_date_column ?? ''} fullWidth size="small"
                          placeholder="business_date"
                          helperText="Column used to filter by business date"
                          onChange={(e) => setExtract('jdbc_date_column', e.target.value)} />
                      </Grid>
                    </>
                  )}

                  {/* ── File (JSON/CSV) params ── */}
                  {(source === 'json' || source === 'csv') && (
                    <>
                      <Grid item xs={12}>
                        <TextField
                          label="File Path"
                          value={form.extract_config.file_path ?? ''} fullWidth size="small"
                          placeholder="transactions.csv"
                          helperText="Relative to data/sources/ directory"
                          InputProps={{
                            startAdornment: (
                              <InputAdornment position="start">
                                <Typography variant="caption" color="text.secondary" noWrap>
                                  data/sources/
                                </Typography>
                              </InputAdornment>
                            ),
                          }}
                          onChange={(e) => setExtract('file_path', e.target.value)} />
                      </Grid>
                      {source === 'csv' && (
                        <>
                          <Grid item xs={6} sm={4}>
                            <TextField label="Delimiter" value={form.extract_config.csv_delimiter ?? ','}
                              fullWidth size="small"
                              onChange={(e) => setExtract('csv_delimiter', e.target.value)} />
                          </Grid>
                          <Grid item xs={6} sm={4}>
                            <FormControlLabel
                              control={
                                <Switch
                                  checked={form.extract_config.csv_has_header ?? true}
                                  onChange={(e) => setExtract('csv_has_header', e.target.checked)}
                                />
                              }
                              label="Header row"
                            />
                          </Grid>
                        </>
                      )}
                      {source === 'json' && (
                        <Grid item xs={6}>
                          <FormControlLabel
                            control={
                              <Switch
                                checked={form.extract_config.json_lines ?? true}
                                onChange={(e) => setExtract('json_lines', e.target.checked)}
                              />
                            }
                            label="JSONL (one object per line)"
                          />
                        </Grid>
                      )}
                    </>
                  )}

                  {/* ── Date range (all sources) ── */}
                  <Grid item xs={12}>
                    <Divider><Typography variant="caption">Business Date Range</Typography></Divider>
                  </Grid>
                  <Grid item xs={12} sm={6}>
                    <TextField label="Date From" type="date"
                      value={form.extract_config.date_from ?? ''} fullWidth size="small"
                      InputLabelProps={{ shrink: true }}
                      onChange={(e) => setExtract('date_from', e.target.value)} />
                  </Grid>
                  <Grid item xs={12} sm={6}>
                    <TextField label="Date To" type="date"
                      value={form.extract_config.date_to ?? ''} fullWidth size="small"
                      InputLabelProps={{ shrink: true }}
                      onChange={(e) => setExtract('date_to', e.target.value)} />
                  </Grid>

                  {/* ── Segmentation (all sources) ── */}
                  <Grid item xs={12}>
                    <Divider><Typography variant="caption">Segmentation</Typography></Divider>
                  </Grid>
                  <Grid item xs={12} sm={6}>
                    <TextField
                      label="Rows per Segment"
                      type="number"
                      value={form.extract_config.rows_per_segment ?? 100000}
                      fullWidth size="small"
                      helperText="Max rows per output file (e.g. 100,000 → 24 files from 2.4M rows)"
                      InputProps={{ inputProps: { min: 1000 } }}
                      onChange={(e) => setExtract('rows_per_segment', parseInt(e.target.value))} />
                  </Grid>
                </Grid>
              </AccordionDetails>
            </Accordion>
          </Grid>

          <Grid item xs={12}>
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Typography variant="subtitle2" fontWeight={600}>Load Configuration</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Grid container spacing={2}>
                  <Grid item xs={6}>
                    <TextField select label="Target" value={form.load_config.target} fullWidth size="small"
                      onChange={(e) => setLoad('target', e.target.value)}>
                      <MenuItem value="parquet">Parquet files</MenuItem>
                      <MenuItem value="csv">CSV files</MenuItem>
                      <MenuItem value="spark_table">Spark Table</MenuItem>
                    </TextField>
                  </Grid>
                  <Grid item xs={6}>
                    <TextField select label="Write Mode" value={form.load_config.mode} fullWidth size="small"
                      onChange={(e) => setLoad('mode', e.target.value)}>
                      <MenuItem value="overwrite">Overwrite</MenuItem>
                      <MenuItem value="append">Append</MenuItem>
                    </TextField>
                  </Grid>
                  <Grid item xs={12}>
                    <TextField label="Table Name" value={form.load_config.table_name || ''} fullWidth size="small"
                      placeholder="e.g. transactions, events.daily_summary"
                      helperText="Static table name — ignored when 'Use namespace' is on"
                      onChange={(e) => setLoad('table_name', e.target.value)} />
                  </Grid>
                  <Grid item xs={12}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={form.load_config.use_namespace ?? false}
                          onChange={(e) => setLoad('use_namespace', e.target.checked)}
                          size="small"
                        />
                      }
                      label={
                        <Box>
                          <Typography variant="body2">Use platform namespace</Typography>
                          <Typography variant="caption" color="text.secondary">
                            Table name will be resolved from the platform execution context (prefix + business date) at run time
                          </Typography>
                        </Box>
                      }
                    />
                  </Grid>
                </Grid>
              </AccordionDetails>
            </Accordion>
          </Grid>

          <Grid item xs={12}>
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Typography variant="subtitle2" fontWeight={600}>Schedule</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Grid container spacing={2} alignItems="center">
                  <Grid item xs={8}>
                    <TextField label="Cron Expression" value={form.schedule} fullWidth size="small"
                      placeholder="0 2 * * *" helperText="Cron: minute hour day month weekday"
                      onChange={(e) => setForm((f) => ({ ...f, schedule: e.target.value }))} />
                  </Grid>
                  <Grid item xs={4}>
                    <FormControlLabel
                      control={<Switch checked={form.schedule_enabled} onChange={(e) => setForm((f) => ({ ...f, schedule_enabled: e.target.checked }))} />}
                      label="Enabled"
                    />
                  </Grid>
                </Grid>
              </AccordionDetails>
            </Accordion>
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => onSave(form)} disabled={!form.name.trim()}>
          {initial ? 'Save Changes' : 'Create Pipeline'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function RunDialog({ pipeline, open, onClose }: { pipeline: Pipeline | null; open: boolean; onClose: () => void }) {
  const [appIds, setAppIds] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [useNamespace, setUseNamespace] = useState(false)
  const [nsDateOverride, setNsDateOverride] = useState('')
  const { enqueueSnackbar } = useSnackbar()
  const qc = useQueryClient()

  const { data: ctx } = useQuery<ExecutionContext>({
    queryKey: ['execution-context'],
    queryFn: () => pipelinesApi.getContext().then((r) => r.data),
    enabled: open,
  })

  // default useNamespace from pipeline's load_config
  useState(() => {
    if (pipeline) setUseNamespace(pipeline.load_config?.use_namespace ?? false)
  })

  // Resolved namespace for display
  const resolvedDate = nsDateOverride || ctx?.business_date || ''
  const resolvedPrefix = ctx?.namespace_prefix ?? ''
  const resolvedNamespace = resolvedDate
    ? `${resolvedPrefix}${resolvedDate.replace(/-/g, '')}`
    : null

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
    if (useNamespace) {
      trigger.use_namespace = true
      if (nsDateOverride) trigger.business_date = nsDateOverride
    } else {
      trigger.use_namespace = false
    }
    mutation.mutate(trigger)
  }

  const pipelineUsesNs = pipeline?.load_config?.use_namespace ?? false

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Run Pipeline: {pipeline?.name}</DialogTitle>
      <DialogContent dividers>
        {/* Namespace section */}
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Tag fontSize="small" color="primary" />
            <Typography variant="subtitle2" fontWeight={600}>Table Namespace</Typography>
            {pipelineUsesNs && (
              <Chip label="pipeline default: on" size="small" color="primary" variant="outlined" sx={{ fontSize: '0.65rem', height: 18 }} />
            )}
          </Box>
          <FormControlLabel
            control={<Switch checked={useNamespace} onChange={(e) => setUseNamespace(e.target.checked)} size="small" />}
            label={<Typography variant="body2">Save to namespace table</Typography>}
          />
          {useNamespace && (
            <Box sx={{ mt: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <CalendarToday sx={{ fontSize: 14, color: 'text.secondary' }} />
                <Typography variant="caption" color="text.secondary">
                  Platform date: <strong>{ctx?.business_date ?? '(not set)'}</strong>
                  {ctx?.namespace_prefix && <> · prefix: <strong>{ctx.namespace_prefix}</strong></>}
                </Typography>
              </Box>
              <TextField
                label="Business date override (optional)" type="date" value={nsDateOverride}
                fullWidth size="small" InputLabelProps={{ shrink: true }}
                onChange={(e) => setNsDateOverride(e.target.value)}
                helperText="Leave blank to use the platform business date"
              />
              {resolvedNamespace ? (
                <Alert severity="success" sx={{ py: 0.5 }}>
                  Spark database: <strong>{resolvedNamespace}</strong><br />
                  Table: <strong>{pipeline?.load_config?.table_name || `extracts_<app_id>`}</strong><br />
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', mt: 0.5, display: 'block' }}>
                    Full path: {resolvedNamespace}.{pipeline?.load_config?.table_name || 'extracts_<app_id>'}
                  </Typography>
                </Alert>
              ) : (
                <Alert severity="warning" sx={{ py: 0.5 }}>
                  No business date set. Set one above or on the platform context bar.
                </Alert>
              )}
            </Box>
          )}
        </Paper>

        <Alert severity="info" sx={{ mb: 2 }}>
          Override extract config for this run, or leave blank to use pipeline defaults.
        </Alert>
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <TextField label="Application IDs (override)" value={appIds} fullWidth size="small"
              placeholder="APP001, APP002"
              onChange={(e) => setAppIds(e.target.value)} />
          </Grid>
          <Grid item xs={6}>
            <TextField label="Date From (override)" type="date" value={dateFrom} fullWidth size="small"
              InputLabelProps={{ shrink: true }} onChange={(e) => setDateFrom(e.target.value)} />
          </Grid>
          <Grid item xs={6}>
            <TextField label="Date To (override)" type="date" value={dateTo} fullWidth size="small"
              InputLabelProps={{ shrink: true }} onChange={(e) => setDateTo(e.target.value)} />
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" startIcon={mutation.isPending ? <CircularProgress size={14} color="inherit" /> : <PlayArrow />}
          onClick={handleRun} disabled={mutation.isPending}>
          Run Now
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Platform execution context bar ──────────────────────────────────────────
function ExecutionContextBar() {
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()
  const [editing, setEditing] = useState(false)
  const [date, setDate] = useState('')
  const [prefix, setPrefix] = useState('')

  const { data: ctx, isLoading } = useQuery<ExecutionContext>({
    queryKey: ['execution-context'],
    queryFn: () => pipelinesApi.getContext().then((r) => r.data),
    refetchInterval: 60_000,
  })

  const mut = useMutation({
    mutationFn: (d: { business_date?: string | null; namespace_prefix?: string }) =>
      pipelinesApi.updateContext(d).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['execution-context'] })
      setEditing(false)
      enqueueSnackbar('Execution context updated', { variant: 'success' })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const theme = useTheme()

  const handleEdit = () => {
    setDate(ctx?.business_date ?? '')
    setPrefix(ctx?.namespace_prefix ?? '')
    setEditing(true)
  }

  const handleSave = () => {
    mut.mutate({
      business_date: date || null,
      namespace_prefix: prefix,
    })
  }

  const handleClear = () => {
    mut.mutate({ business_date: null, namespace_prefix: '' })
  }

  if (isLoading) return null

  return (
    <Paper
      variant="outlined"
      sx={{
        mb: 2, px: 2, py: 1,
        display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
        bgcolor: alpha(theme.palette.primary.main, 0.04),
        borderColor: alpha(theme.palette.primary.main, 0.2),
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <CalendarToday sx={{ fontSize: 16, color: 'primary.main' }} />
        <Typography variant="caption" fontWeight={600} color="primary.main">Execution Context</Typography>
      </Box>

      {!editing ? (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="caption" color="text.secondary">Business date:</Typography>
            <Chip
              size="small"
              label={ctx?.business_date ?? 'not set'}
              color={ctx?.business_date ? 'primary' : 'default'}
              variant="outlined"
              sx={{ fontSize: '0.72rem', height: 20 }}
            />
          </Box>
          {ctx?.namespace_prefix && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="caption" color="text.secondary">Prefix:</Typography>
              <Chip size="small" label={ctx.namespace_prefix} variant="outlined"
                sx={{ fontSize: '0.72rem', height: 20, fontFamily: 'monospace' }} />
            </Box>
          )}
          {ctx?.namespace && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Tag sx={{ fontSize: 14, color: 'success.main' }} />
              <Typography variant="caption" color="text.secondary">Active DB:</Typography>
              <Typography variant="caption" fontWeight={600} sx={{ fontFamily: 'monospace', color: 'success.main' }}>
                {ctx.namespace}
              </Typography>
            </Box>
          )}
          <Box sx={{ display: 'flex', gap: 0.75, ml: 'auto' }}>
            <Button size="small" variant="outlined" startIcon={<Edit />} onClick={handleEdit} sx={{ py: 0.25 }}>
              Edit
            </Button>
            {ctx?.business_date && (
              <Button size="small" color="warning" onClick={handleClear} disabled={mut.isPending} sx={{ py: 0.25 }}>
                Clear
              </Button>
            )}
          </Box>
        </>
      ) : (
        <>
          <TextField
            label="Business date" type="date" value={date} size="small"
            InputLabelProps={{ shrink: true }}
            onChange={(e) => setDate(e.target.value)}
            sx={{ width: 160 }}
          />
          <TextField
            label="Table prefix" value={prefix} size="small"
            placeholder="e.g. markets_"
            onChange={(e) => setPrefix(e.target.value)}
            sx={{ width: 160 }}
            helperText={date ? `→ ${prefix}${date.replace(/-/g, '')}` : ''}
          />
          <Box sx={{ display: 'flex', gap: 0.75, ml: 'auto' }}>
            <Button size="small" onClick={() => setEditing(false)} sx={{ py: 0.25 }}>Cancel</Button>
            <Button size="small" variant="contained" onClick={handleSave} disabled={mut.isPending} sx={{ py: 0.25 }}>
              {mut.isPending ? <CircularProgress size={12} color="inherit" /> : 'Save'}
            </Button>
          </Box>
        </>
      )}
    </Paper>
  )
}

export default function ETLPipelines() {
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Pipeline | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Pipeline | null>(null)
  const [runTarget, setRunTarget] = useState<Pipeline | null>(null)
  const { enqueueSnackbar } = useSnackbar()
  const qc = useQueryClient()

  const { data: pipelines, isLoading } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => pipelinesApi.list().then((r) => r.data),
    refetchInterval: 10_000,
  })

  const createMutation = useMutation({
    mutationFn: (d: Parameters<typeof pipelinesApi.create>[0]) => pipelinesApi.create(d).then((r) => r.data),
    onSuccess: () => { enqueueSnackbar('Pipeline created', { variant: 'success' }); qc.invalidateQueries({ queryKey: ['pipelines'] }); setCreateOpen(false) },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: unknown }) =>
      pipelinesApi.update(id, data as Partial<Pipeline>).then((r) => r.data),
    onSuccess: () => { enqueueSnackbar('Pipeline updated', { variant: 'success' }); qc.invalidateQueries({ queryKey: ['pipelines'] }); setEditTarget(null) },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => pipelinesApi.delete(id),
    onSuccess: () => { enqueueSnackbar('Pipeline deleted', { variant: 'info' }); qc.invalidateQueries({ queryKey: ['pipelines'] }); setDeleteTarget(null) },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, gap: 1 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>ETL Pipelines</Typography>
          <Typography variant="caption" color="text.secondary">Create and manage Extract → Transform → Load workflows</Typography>
        </Box>
        <Button variant="contained" startIcon={<Add />} onClick={() => setCreateOpen(true)}>
          New Pipeline
        </Button>
      </Box>

      <ExecutionContextBar />

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : !pipelines?.length ? (
        <Card sx={{ textAlign: 'center', py: 8 }}>
          <CardContent>
            <Typography variant="h6" color="text.secondary" gutterBottom>No pipelines yet</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Create your first ETL pipeline to start extracting data from the gRPC API.
            </Typography>
            <Button variant="contained" startIcon={<Add />} onClick={() => setCreateOpen(true)}>
              Create Pipeline
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Grid container spacing={2}>
          {pipelines.map((p) => (
            <Grid item xs={12} sm={6} lg={4} key={p.id}>
              <PipelineCard
                pipeline={p}
                onEdit={setEditTarget}
                onDelete={setDeleteTarget}
                onRun={setRunTarget}
              />
            </Grid>
          ))}
        </Grid>
      )}

      {/* Create dialog */}
      <PipelineDialog open={createOpen} initial={null} onClose={() => setCreateOpen(false)}
        onSave={(data) => createMutation.mutate(data)} />

      {/* Edit dialog */}
      {editTarget && (
        <PipelineDialog open onClose={() => setEditTarget(null)} initial={editTarget}
          onSave={(data) => updateMutation.mutate({ id: editTarget.id, data })} />
      )}

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete Pipeline</DialogTitle>
        <DialogContent>
          <Typography>Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? All runs and logs will be removed.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => deleteMutation.mutate(deleteTarget!.id)} disabled={deleteMutation.isPending}>
            {deleteMutation.isPending ? <CircularProgress size={18} color="inherit" /> : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Run dialog */}
      <RunDialog pipeline={runTarget} open={!!runTarget} onClose={() => setRunTarget(null)} />
    </Box>
  )
}
