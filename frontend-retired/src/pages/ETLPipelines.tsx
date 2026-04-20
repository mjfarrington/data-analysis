import { useState } from 'react'
import {
  Box, Button, Card, CardContent, Typography, IconButton, Chip, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Grid, Tooltip, alpha, useTheme, Accordion, AccordionSummary, AccordionDetails,
  FormControlLabel, Switch, Alert, CircularProgress, InputAdornment,
  Paper, Select, FormControl, InputLabel, Popover,
} from '@mui/material'
import {
  Add, PlayArrow, Edit, Delete, ExpandMore, Schedule, ChevronRight,
  Storage, Code, CalendarToday, Tag, OpenInNew,
  AccountTree, NoteAlt, Hub,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useSnackbar } from 'notistack'
import { pipelinesApi, sqlFilesApi, connectionsApi, Pipeline, ExtractConfig, SourceType, ExecutionContext, RunTrigger } from '../api/client'
import StatusChip from '../components/StatusChip'
import DateField from '../components/DateField'
import ExecutionContextBar from '../components/ExecutionContextBar'
import ExtractConfigWizard from '../components/ExtractConfigWizard'
import { formatDistanceToNow } from 'date-fns'
import { parseApiDate } from '../utils/dates'

const SOURCE_ICONS: Record<SourceType, React.ReactNode> = {
  grpc: <Code fontSize="small" />,
  jdbc: <Storage fontSize="small" />,
  datawarehouse: <Hub fontSize="small" />,
}

const defaultExtractConfig = (): ExtractConfig => ({
  source_type: 'datawarehouse',
  apps: [],
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
  dw_connection_id: undefined,
})

const defaultPipeline = () => ({
  name: '',
  description: '',
  status: 'active' as 'active' | 'inactive' | 'draft',
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
            {pipeline.load_config.table_name ? (
              <Typography variant="body2" noWrap sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.78rem' }}>
                {'<prefix><date>.'}{pipeline.load_config.table_name}
              </Typography>
            ) : (
              <Typography variant="body2" color="text.secondary">extracts_&lt;app_id&gt;</Typography>
            )}
          </Grid>
          {(pipeline.extract_config.source_type === 'grpc' || !pipeline.extract_config.source_type) && (
            <Grid item xs={12}>
              <Typography variant="caption" color="text.secondary" display="block">Apps</Typography>
              <Typography variant="body2" noWrap>
                {pipeline.extract_config.apps?.slice(0, 3).map((a) => a.name || a.id).join(', ')}
                {(pipeline.extract_config.apps?.length ?? 0) > 3 &&
                  ` +${(pipeline.extract_config.apps?.length ?? 0) - 3}`}
              </Typography>
            </Grid>
          )}
          {pipeline.extract_config.source_type === 'jdbc' && (
            <Grid item xs={12}>
              <Typography variant="caption" color="text.secondary" display="block">Connection</Typography>
              <Typography variant="body2" noWrap sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.7rem' }}>
                {pipeline.extract_config.jdbc_url || '—'}
              </Typography>
            </Grid>
          )}
          {pipeline.extract_config.source_type === 'datawarehouse' && (
            <Grid item xs={12}>
              <Typography variant="caption" color="text.secondary" display="block">Connection</Typography>
              <Typography variant="body2" noWrap>
                {pipeline.extract_config.dw_connection_id ? `Connection #${pipeline.extract_config.dw_connection_id}` : '—'}
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
                    {formatDistanceToNow(parseApiDate(lastRun.created_at), { addSuffix: true })}
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
    status: (initial.status ?? 'active') as 'active' | 'inactive' | 'draft',
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
      target: (initial.load_config?.target ?? 'spark_table') as 'parquet' | 'csv' | 'spark_table',
      table_name: initial.load_config?.table_name,
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
  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.list().then((r) => r.data),
  })

  const setExtract = (key: string, val: unknown) =>
    setForm((f) => ({ ...f, extract_config: { ...f.extract_config, [key]: val } }))
  const setLoad = (key: string, val: unknown) =>
    setForm((f) => ({ ...f, load_config: { ...f.load_config, [key]: val } }))

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{initial ? 'Edit Pipeline' : 'New ETL Pipeline'}</DialogTitle>
      <DialogContent dividers>
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
          <Grid container spacing={1.5} alignItems="center">
            <Grid item>
              <AccountTree sx={{ fontSize: 20, color: 'primary.main', display: 'block' }} />
            </Grid>
            <Grid item xs>
              <TextField label="Name" value={form.name} fullWidth size="small"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </Grid>
            <Grid item xs={3}>
              <TextField select label="Status" value={form.status} fullWidth size="small"
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as typeof f.status }))}>
                <MenuItem value="active">Active</MenuItem>
                <MenuItem value="inactive">Inactive</MenuItem>
                <MenuItem value="draft">Draft</MenuItem>
              </TextField>
            </Grid>
          </Grid>
        </Paper>

        <Grid container spacing={2}>

          {/* ── Extract ── */}
          <Grid item xs={12}>
            <Accordion defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMore />}>
                <Typography variant="subtitle2" fontWeight={600}>Extract Configuration</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 1 }}>
                <ExtractConfigWizard
                  config={form.extract_config}
                  onChange={(key, val) => setExtract(key as string, val)}
                  sqlFiles={sqlFiles}
                  connections={connections}
                />
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
                    <TextField select label="Write Mode" value={form.load_config.mode} fullWidth size="small"
                      onChange={(e) => setLoad('mode', e.target.value)}>
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
    if (dateFrom) cfg.date_from = dateFrom
    if (dateTo) cfg.date_to = dateTo
    if (Object.keys(cfg).length) trigger.extract_config = cfg
    if (dateOverride) trigger.business_date = dateOverride
    mutation.mutate(trigger)
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Run Pipeline: {pipeline?.name}</DialogTitle>
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
            <Alert severity="warning" sx={{ py: 0.5, mt: 1.5 }}>
              No business date set — set one on the execution context bar.
            </Alert>
          )}
        </Paper>

        <Alert severity="info" sx={{ mb: 2 }}>
          Override extract config for this run, or leave blank to use pipeline defaults.
        </Alert>
        <Grid container spacing={2}>
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
        <Button variant="contained" startIcon={mutation.isPending ? <CircularProgress size={14} color="inherit" /> : <PlayArrow />}
          onClick={handleRun} disabled={mutation.isPending}>
          Run Now
        </Button>
      </DialogActions>
    </Dialog>
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
