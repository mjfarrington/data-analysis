import { useState, useRef } from 'react'
import {
  Box, Typography, Button, IconButton, Tooltip,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, Chip, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, Select, MenuItem, FormControl, InputLabel,
  CircularProgress, Alert, Divider, Stack, LinearProgress,
} from '@mui/material'
import {
  Add, Edit, Delete, PlayArrow as TestIcon,
  Storage as StorageIcon, CheckCircle, Error as ErrorIcon,
  ContentCopy, Visibility, VisibilityOff,
  CloudDownload as ExtractIcon, Stop as StopIcon,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { connectionsApi, Connection } from '../api/client'

// ───────────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────────

const CONN_TYPES     = ['jdbc', 'datawarehouse', 's3', 'grpc', 'rest', 'other']
const DIALECTS       = ['postgresql', 'mysql', 'mssql', 'oracle', 'sqlite', 'redshift', 'snowflake', 'bigquery']
const DW_DIALECTS    = ['spark', 'impala']
const DW_ENVS        = ['PROD', 'UAT']
const S3_FORMATS     = ['auto', 'parquet', 'csv', 'json', 'orc']
const S3_WRITE_MODES = ['overwrite', 'append', 'ignore', 'error']

function connTypeBadge(t: string) {
  const map: Record<string, 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info'> = {
    jdbc: 'primary', datawarehouse: 'secondary', s3: 'success', grpc: 'warning', rest: 'info', other: 'default',
  }
  return map[t] ?? 'default'
}

// ───────────────────────────────────────────────────────────────────────────────
// Test result display
// ───────────────────────────────────────────────────────────────────────────────

interface TestResult { ok: boolean; latency_ms: number; message: string }

function TestBadge({ result }: { result: TestResult }) {
  return (
    <Alert
      severity={result.ok ? 'success' : 'error'}
      icon={result.ok ? <CheckCircle /> : <ErrorIcon />}
      sx={{ py: 0.5, '& .MuiAlert-message': { display: 'flex', alignItems: 'center', gap: 1 } }}
    >
      {result.message}
      {result.ok && <Chip label={`${result.latency_ms} ms`} size="small" color="success" variant="outlined" />}
    </Alert>
  )
}

// ───────────────────────────────────────────────────────────────────────────────
// Connection form (create / edit)
// ───────────────────────────────────────────────────────────────────────────────

interface FormState {
  name: string
  description: string
  conn_type: string
  host: string
  port: string
  database: string
  username: string
  password: string
  dialect: string
  environment: string
  s3_bucket: string
  s3_region: string
  s3_endpoint: string
}

const EMPTY_FORM: FormState = {
  name: '', description: '', conn_type: 'jdbc',
  host: 'localhost', port: '5432', database: '', username: '', password: '',
  dialect: 'postgresql', environment: 'PROD',
  s3_bucket: '', s3_region: 'us-east-1', s3_endpoint: '',
}

function ConnectionDialog({
  open, onClose, initial,
}: {
  open: boolean
  onClose: () => void
  initial?: Connection | null
}) {
  const qc = useQueryClient()
  const isEdit = !!initial
  const [form, setForm] = useState<FormState>(
    initial
      ? {
          name: initial.name,
          description: initial.description ?? '',
          conn_type: initial.conn_type,
          host: initial.host ?? '',
          port: String(initial.port ?? ''),
          database: initial.database ?? '',
          username: initial.username ?? '',
          password: '',
          dialect: (initial.extra?.dialect as string) ?? (initial.conn_type === 'datawarehouse' ? 'spark' : 'postgresql'),
          environment: (initial.extra?.environment as string) ?? 'PROD',
          s3_bucket: (initial.extra?.bucket as string) ?? '',
          s3_region: (initial.extra?.region as string) ?? 'us-east-1',
          s3_endpoint: (initial.extra?.endpoint_url as string) ?? '',
        }
      : { ...EMPTY_FORM },
  )
  const [showPw, setShowPw] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | { value: unknown }>) =>
    setForm(f => ({ ...f, [k]: e.target.value as string }))

  const saveMutation = useMutation({
    mutationFn: (payload: Parameters<typeof connectionsApi.create>[0]) =>
      isEdit ? connectionsApi.update(initial!.id, payload) : connectionsApi.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] })
      onClose()
    },
  })

  const handleSave = () => {
    const isDW = form.conn_type === 'datawarehouse'
    const isS3 = form.conn_type === 's3'
    saveMutation.mutate({
      name: form.name,
      description: form.description || undefined,
      conn_type: form.conn_type,
      host: (isDW || isS3) ? undefined : (form.host || undefined),
      port: (isDW || isS3) ? undefined : (form.port ? Number(form.port) : undefined),
      database: (isDW || isS3) ? undefined : (form.database || undefined),
      username: form.username || undefined,
      password: form.password || undefined,
      extra: isDW
        ? { dialect: form.dialect, environment: form.environment }
        : isS3
          ? {
              bucket: form.s3_bucket,
              region: form.s3_region,
              ...(form.s3_endpoint ? { endpoint_url: form.s3_endpoint } : {}),
            }
          : { dialect: form.dialect },
    })
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      if (form.conn_type === 's3' && isEdit && initial?.id) {
        const r = await connectionsApi.testS3(initial.id)
        setTestResult(r)
      } else {
        const r = await connectionsApi.testAdhoc({
          conn_type: form.conn_type,
          host:     form.host     || undefined,
          port:     form.port     ? Number(form.port) : undefined,
          database: form.database || undefined,
          username: form.username || undefined,
          password: form.password || undefined,
          extra: form.conn_type === 's3'
            ? { bucket: form.s3_bucket, region: form.s3_region, ...(form.s3_endpoint ? { endpoint_url: form.s3_endpoint } : {}) }
            : { dialect: form.dialect },
        })
        setTestResult(r)
      }
    } catch (e: unknown) {
      setTestResult({ ok: false, latency_ms: 0, message: String(e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{isEdit ? `Edit: ${initial!.name}` : 'New Connection'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Name" value={form.name} onChange={set('name')} size="small" required />
          <TextField label="Description" value={form.description} onChange={set('description')} size="small" />

          <FormControl size="small" fullWidth>
            <InputLabel>Type</InputLabel>
            <Select label="Type" value={form.conn_type} onChange={e => setForm(f => ({ ...f, conn_type: e.target.value as string }))}>
              {CONN_TYPES.map(t => <MenuItem key={t} value={t}>{t}</MenuItem>)}
            </Select>
          </FormControl>

          {form.conn_type === 'datawarehouse' && (<>
            <FormControl size="small" fullWidth>
              <InputLabel>Datasource / Dialect</InputLabel>
              <Select label="Datasource / Dialect" value={form.dialect}
                onChange={e => setForm(f => ({ ...f, dialect: e.target.value as string }))}>
                {DW_DIALECTS.map(d => <MenuItem key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel>Environment</InputLabel>
              <Select label="Environment" value={form.environment}
                onChange={e => setForm(f => ({ ...f, environment: e.target.value as string }))}>
                {DW_ENVS.map(env => <MenuItem key={env} value={env}>{env}</MenuItem>)}
              </Select>
            </FormControl>
          </>)}

          {form.conn_type === 'jdbc' && (
            <FormControl size="small" fullWidth>
              <InputLabel>Dialect</InputLabel>
              <Select label="Dialect" value={form.dialect}
                onChange={e => setForm(f => ({ ...f, dialect: e.target.value as string }))}>
                {DIALECTS.map(d => <MenuItem key={d} value={d}>{d}</MenuItem>)}
              </Select>
            </FormControl>
          )}

          {form.conn_type !== 'datawarehouse' && form.conn_type !== 's3' && (<>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField label="Host" value={form.host} onChange={set('host')} size="small" sx={{ flex: 3 }} />
              <TextField label="Port" value={form.port} onChange={set('port')} size="small" sx={{ flex: 1 }} type="number" />
            </Box>
            <TextField label="Database" value={form.database} onChange={set('database')} size="small"
              helperText={form.conn_type === 'jdbc' && !form.database ? 'Required for JDBC connections' : undefined}
              error={form.conn_type === 'jdbc' && !form.database}
            />
          </>)}

          {form.conn_type === 's3' && (<>
            <TextField label="Bucket" value={form.s3_bucket} onChange={set('s3_bucket')} size="small"
              required placeholder="my-data-bucket" helperText="S3 bucket name (no s3:// prefix)" />
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField label="Region" value={form.s3_region} onChange={set('s3_region')} size="small" sx={{ flex: 1 }}
                placeholder="us-east-1" />
              <TextField label="Endpoint URL (optional)" value={form.s3_endpoint} onChange={set('s3_endpoint')} size="small" sx={{ flex: 2 }}
                placeholder="https://minio.example.com" />
            </Box>
          </>)}

          <TextField
            label={form.conn_type === 's3' ? 'Access Key ID' : 'Username'}
            value={form.username} onChange={set('username')} size="small"
          />
          <TextField
            label={
              form.conn_type === 's3'
                ? (isEdit ? 'Secret Access Key (leave blank to keep)' : 'Secret Access Key')
                : (isEdit ? 'Password (leave blank to keep current)' : 'Password')
            }
            value={form.password}
            onChange={set('password')}
            size="small"
            type={showPw ? 'text' : 'password'}
            InputProps={{
              endAdornment: (
                <IconButton size="small" onClick={() => setShowPw(v => !v)}>
                  {showPw ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                </IconButton>
              ),
            }}
          />

          {saveMutation.isError && (
            <Alert severity="error">{String(saveMutation.error)}</Alert>
          )}

          <Divider />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Button
              variant="outlined"
              size="small"
              startIcon={testing ? <CircularProgress size={14} /> : <TestIcon />}
              onClick={handleTest}
              disabled={testing || (!form.host && form.conn_type !== 'datawarehouse' && form.conn_type !== 's3')}
            >
              Test Connection
            </Button>
            {!isEdit && (
              <Typography variant="caption" color="text.secondary">
                Password required for test
              </Typography>
            )}
          </Box>
          {testResult && <TestBadge result={testResult} />}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={!form.name || saveMutation.isPending}
          startIcon={saveMutation.isPending ? <CircularProgress size={14} /> : undefined}
        >
          {isEdit ? 'Save' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ───────────────────────────────────────────────────────────────────────────────
// Delete confirm dialog
// ───────────────────────────────────────────────────────────────────────────────

function DeleteDialog({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  const qc = useQueryClient()
  const del = useMutation({
    mutationFn: () => connectionsApi.delete(conn.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); onClose() },
  })
  return (
    <Dialog open onClose={onClose} maxWidth="xs">
      <DialogTitle>Delete Connection</DialogTitle>
      <DialogContent>
        <Typography>Delete <strong>{conn.name}</strong>? This cannot be undone.</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button color="error" variant="contained" onClick={() => del.mutate()} disabled={del.isPending}>
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ───────────────────────────────────────────────────────────────────────────────
// S3 Ingest Panel
// ───────────────────────────────────────────────────────────────────────────────

interface S3IngestEvent {
  event:         string
  message?:      string
  count?:        number
  files?:        string[]
  file?:         string
  index?:        number
  total?:        number
  columns?:      string[]
  column_count?: number
  target?:       string
  rows?:         number
  duration_s?:   number
  files_ingested?: number
  detail?:       string
}

function S3IngestPanel({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  const bucket = (conn.extra?.bucket as string) ?? ''
  const region = (conn.extra?.region as string) ?? 'us-east-1'

  const [prefix,       setPrefix]       = useState('')
  const [pattern,      setPattern]      = useState('*')
  const [fmt,          setFmt]          = useState('auto')
  const [writeMode,    setWriteMode]    = useState('overwrite')
  const [targetDb,     setTargetDb]     = useState('default')
  const [targetTable,  setTargetTable]  = useState('')
  const [transformSql, setTransformSql] = useState('')
  const [csvSep,       setCsvSep]       = useState(',')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [running,      setRunning]      = useState(false)
  const [events,       setEvents]       = useState<S3IngestEvent[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const logRef   = useRef<HTMLDivElement>(null)

  const matchedEvent = events.find(e => e.event === 'matched')
  const lastDownload = [...events].reverse().find(e => e.event === 'download')
  const schemaEvent  = events.find(e => e.event === 'schema')
  const doneEvent    = events.find(e => e.event === 'done')
  const errorEvent   = events.find(e => e.event === 'error')
  const downloadProgress = lastDownload && matchedEvent?.count
    ? Math.round((lastDownload.index! / matchedEvent.count) * 100)
    : 0

  const handleStart = async () => {
    if (!targetTable.trim()) return
    setEvents([])
    setRunning(true)
    abortRef.current = new AbortController()
    try {
      const resp = await fetch(
        `${import.meta.env.VITE_API_URL ?? 'http://localhost:8000/api/v1'}/connections/${conn.id}/s3-ingest`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prefix, pattern, format: fmt, write_mode: writeMode,
            target_db: targetDb, target_table: targetTable,
            transform_sql: transformSql || null, csv_sep: csvSep,
          }),
          signal: abortRef.current.signal,
        },
      )
      if (!resp.ok) {
        const txt = await resp.text()
        setEvents([{ event: 'error', message: `HTTP ${resp.status}: ${txt}` }])
        return
      }
      const reader  = resp.body?.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (reader) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const ev: S3IngestEvent = JSON.parse(line.slice(6))
              setEvents(prev => [...prev, ev])
              setTimeout(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }), 50)
              if (ev.event === 'done' || ev.event === 'error') break
            } catch { /* skip malformed */ }
          }
        }
      }
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError')
        setEvents(prev => [...prev, { event: 'error', message: String(e) }])
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <ExtractIcon color="success" fontSize="small" />
        S3 Ingest — {conn.name}
        <Chip label={`s3://${bucket}`} size="small" color="success" sx={{ ml: 1, fontFamily: 'monospace' }} />
        <Chip label={region} size="small" variant="outlined" />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>

          <Typography variant="subtitle2" color="text.secondary">Source</Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField label="Prefix (path)" value={prefix} onChange={e => setPrefix(e.target.value)}
              size="small" sx={{ flex: 3 }} placeholder="data/trades/2026-04-16/" />
            <TextField label="File pattern" value={pattern} onChange={e => setPattern(e.target.value)}
              size="small" sx={{ flex: 2 }} placeholder="*.parquet" />
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel>Format</InputLabel>
              <Select label="Format" value={fmt} onChange={e => setFmt(e.target.value)}>
                {S3_FORMATS.map(f => <MenuItem key={f} value={f}>{f}</MenuItem>)}
              </Select>
            </FormControl>
            {fmt === 'csv' && (
              <TextField label="CSV separator" value={csvSep} onChange={e => setCsvSep(e.target.value)}
                size="small" sx={{ flex: 1 }} />
            )}
          </Box>

          <Typography variant="subtitle2" color="text.secondary">Target (Spark table)</Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField label="Database" value={targetDb} onChange={e => setTargetDb(e.target.value)}
              size="small" sx={{ flex: 1 }} />
            <TextField label="Table *" value={targetTable} onChange={e => setTargetTable(e.target.value)}
              size="small" sx={{ flex: 2 }} required error={!targetTable} />
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel>Write mode</InputLabel>
              <Select label="Write mode" value={writeMode} onChange={e => setWriteMode(e.target.value)}>
                {S3_WRITE_MODES.map(m => <MenuItem key={m} value={m}>{m}</MenuItem>)}
              </Select>
            </FormControl>
          </Box>

          <Button size="small" onClick={() => setShowAdvanced(v => !v)} sx={{ alignSelf: 'flex-start', textTransform: 'none' }}>
            {showAdvanced ? 'Hide' : 'Show'} SQL transformation (optional)
          </Button>
          {showAdvanced && (
            <TextField
              label="Transform SQL" multiline minRows={3}
              value={transformSql} onChange={e => setTransformSql(e.target.value)}
              size="small"
              placeholder="SELECT * FROM {source} WHERE trade_date >= '2026-01-01'"
              helperText="Use {source} to reference the ingested data."
              inputProps={{ style: { fontFamily: 'monospace', fontSize: '0.8rem' } }}
            />
          )}

          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Button
              variant="contained" color="success"
              startIcon={running ? <CircularProgress size={14} sx={{ color: 'inherit' }} /> : <ExtractIcon />}
              onClick={handleStart} disabled={running || !targetTable.trim()}
            >
              {running ? 'Ingesting…' : 'Start Ingest'}
            </Button>
            {running && (
              <Button variant="outlined" color="error" startIcon={<StopIcon />}
                onClick={() => { abortRef.current?.abort(); setRunning(false) }}>
                Stop
              </Button>
            )}
          </Box>

          {matchedEvent && (
            <Alert severity="info" sx={{ py: 0.5 }}>
              Matched <strong>{matchedEvent.count}</strong> file(s).
              {matchedEvent.files && matchedEvent.files.length > 0 && (
                <Typography variant="caption" sx={{ display: 'block', mt: 0.5, fontFamily: 'monospace' }}>
                  {matchedEvent.files.slice(0, 5).join(', ')}
                  {(matchedEvent.count ?? 0) > 5 ? ` … +${(matchedEvent.count ?? 0) - 5} more` : ''}
                </Typography>
              )}
            </Alert>
          )}

          {running && lastDownload && (
            <Box>
              <Typography variant="caption" color="text.secondary">
                Downloading {lastDownload.index}/{lastDownload.total}: {lastDownload.file}
              </Typography>
              <LinearProgress color="success" variant="determinate" value={downloadProgress} />
            </Box>
          )}

          {schemaEvent?.columns && (
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
                Schema ({schemaEvent.column_count} columns)
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {schemaEvent.columns.map(c => <Chip key={c} label={c} size="small" variant="outlined" />)}
              </Box>
            </Box>
          )}

          {doneEvent && (
            <Alert severity="success">
              Done — <strong>{doneEvent.rows?.toLocaleString()}</strong> rows written to{' '}
              <code>{doneEvent.target}</code> in {doneEvent.duration_s}s ({doneEvent.files_ingested} file(s))
            </Alert>
          )}

          {errorEvent && (
            <Alert severity="error">
              <strong>{errorEvent.message}</strong>
              {errorEvent.detail && (
                <Box component="pre" sx={{ mt: 0.5, fontSize: '0.7rem', whiteSpace: 'pre-wrap' }}>{errorEvent.detail}</Box>
              )}
            </Alert>
          )}

          {events.length > 0 && (
            <Box>
              <Typography variant="caption" color="text.secondary">Event log</Typography>
              <Box ref={logRef} sx={{
                maxHeight: 180, overflow: 'auto', bgcolor: 'grey.900',
                borderRadius: 1, p: 1, mt: 0.5, fontFamily: 'monospace', fontSize: '0.72rem',
              }}>
                {events.map((ev, i) => (
                  <Box key={i} sx={{ color: ev.event === 'error' ? 'error.light' : ev.event === 'done' ? 'success.light' : 'grey.400' }}>
                    [{ev.event}] {ev.message ?? (ev.file ?? JSON.stringify(ev))}
                  </Box>
                ))}
              </Box>
            </Box>
          )}

        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={running}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

// ───────────────────────────────────────────────────────────────────────────────
// Main page
// ───────────────────────────────────────────────────────────────────────────────

export default function Connections() {
  const { data: connections = [], isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
  })

  const [createOpen,   setCreateOpen]   = useState(false)
  const [editConn,     setEditConn]     = useState<Connection | null>(null)
  const [deleteConn,   setDeleteConn]   = useState<Connection | null>(null)
  const [testResults,  setTestResults]  = useState<Record<number, TestResult>>({})
  const [testingId,    setTestingId]    = useState<number | null>(null)
  const [s3IngestConn, setS3IngestConn] = useState<Connection | null>(null)

  const handleTest = async (conn: Connection) => {
    setTestingId(conn.id)
    try {
      const testFn = conn.conn_type === 's3' ? connectionsApi.testS3 : connectionsApi.test
      const r = await testFn(conn.id)
      setTestResults(prev => ({ ...prev, [conn.id]: r }))
    } catch (e: unknown) {
      setTestResults(prev => ({ ...prev, [conn.id]: { ok: false, latency_ms: 0, message: String(e) } }))
    } finally {
      setTestingId(null)
    }
  }

  const copyUrl = (conn: Connection) => {
    if (conn.conn_type === 's3') {
      navigator.clipboard.writeText(`s3://${(conn.extra?.bucket as string) ?? ''}`)
    } else {
      const dialect = (conn.extra?.dialect as string) ?? 'postgresql'
      const url = `${dialect}://${conn.username ?? ''}@${conn.host ?? 'localhost'}:${conn.port ?? 5432}/${conn.database ?? ''}`
      navigator.clipboard.writeText(url)
    }
  }

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <StorageIcon color="primary" />
          <Typography variant="h5" fontWeight={700}>Connections</Typography>
          <Chip label={connections.length} size="small" />
        </Box>
        <Button variant="contained" startIcon={<Add />} onClick={() => setCreateOpen(true)}>
          New Connection
        </Button>
      </Box>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
          <CircularProgress />
        </Box>
      ) : connections.length === 0 ? (
        <Paper sx={{ p: 6, textAlign: 'center' }}>
          <StorageIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
          <Typography color="text.secondary">No connections yet. Create one to get started.</Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Name</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Type</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Host / Bucket</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Database / Region</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Username</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {connections.map(conn => {
                const tr = testResults[conn.id]
                return (
                  <TableRow key={conn.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>{conn.name}</Typography>
                      {conn.description && (
                        <Typography variant="caption" color="text.secondary">{conn.description}</Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip label={conn.conn_type} size="small" color={connTypeBadge(conn.conn_type)} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace" fontSize="0.75rem">
                        {conn.conn_type === 's3'
                          ? `s3://${(conn.extra?.bucket as string) ?? ''}`
                          : (conn.host ?? '—') + (conn.port ? `:${conn.port}` : '')}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace" fontSize="0.75rem">
                        {conn.conn_type === 's3'
                          ? ((conn.extra?.region as string) ?? 'us-east-1')
                          : (conn.database ?? '—')}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontSize="0.8rem">{conn.username ?? '—'}</Typography>
                    </TableCell>
                    <TableCell sx={{ minWidth: 160 }}>
                      {tr ? (
                        <Chip
                          icon={tr.ok ? <CheckCircle sx={{ fontSize: '0.9rem !important' }} /> : <ErrorIcon sx={{ fontSize: '0.9rem !important' }} />}
                          label={tr.ok ? `OK · ${tr.latency_ms} ms` : 'Failed'}
                          size="small"
                          color={tr.ok ? 'success' : 'error'}
                          variant="outlined"
                        />
                      ) : (
                        <Typography variant="caption" color="text.disabled">Not tested</Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.5 }}>
                        {conn.conn_type === 's3' && (
                          <Tooltip title="S3 Ingest to Spark">
                            <IconButton size="small" color="success" onClick={() => setS3IngestConn(conn)}>
                              <ExtractIcon sx={{ fontSize: 16 }} />
                            </IconButton>
                          </Tooltip>
                        )}
                        <Tooltip title="Copy connection URL">
                          <IconButton size="small" onClick={() => copyUrl(conn)}>
                            <ContentCopy sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Test connection">
                          <IconButton size="small" onClick={() => handleTest(conn)} disabled={testingId === conn.id}>
                            {testingId === conn.id
                              ? <CircularProgress size={14} />
                              : <TestIcon sx={{ fontSize: 16 }} />}
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Edit">
                          <IconButton size="small" onClick={() => setEditConn(conn)}>
                            <Edit sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete">
                          <IconButton size="small" color="error" onClick={() => setDeleteConn(conn)}>
                            <Delete sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {createOpen && <ConnectionDialog open onClose={() => setCreateOpen(false)} />}
      {editConn   && <ConnectionDialog open onClose={() => setEditConn(null)} initial={editConn} />}
      {deleteConn && <DeleteDialog conn={deleteConn} onClose={() => setDeleteConn(null)} />}
      {s3IngestConn && <S3IngestPanel conn={s3IngestConn} onClose={() => setS3IngestConn(null)} />}
    </Box>
  )
}
