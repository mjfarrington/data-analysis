import { useState } from 'react'
import {
  Box, Typography, Button, IconButton, Tooltip,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, Chip, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, Select, MenuItem, FormControl, InputLabel,
  CircularProgress, Alert, Divider, Stack,
} from '@mui/material'
import {
  Add, Edit, Delete, PlayArrow as TestIcon,
  Storage as StorageIcon, CheckCircle, Error as ErrorIcon,
  ContentCopy, Visibility, VisibilityOff,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { connectionsApi, Connection } from '../api/client'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CONN_TYPES = ['jdbc', 'datawarehouse', 'grpc', 'rest', 'other']
const DIALECTS   = ['postgresql', 'mysql', 'mssql', 'oracle', 'sqlite', 'redshift', 'snowflake', 'bigquery']

function connTypeBadge(t: string) {
  const map: Record<string, 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info'> = {
    jdbc: 'primary', datawarehouse: 'secondary', grpc: 'warning', rest: 'info', other: 'default',
  }
  return map[t] ?? 'default'
}

// ─────────────────────────────────────────────────────────────────────────────
// Test result display
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Connection form (create / edit)
// ─────────────────────────────────────────────────────────────────────────────

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
}

const EMPTY_FORM: FormState = {
  name: '', description: '', conn_type: 'jdbc',
  host: 'localhost', port: '5432', database: '', username: '', password: '',
  dialect: 'postgresql',
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
          dialect: (initial.extra?.dialect as string) ?? 'postgresql',
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
    saveMutation.mutate({
      name: form.name,
      description: form.description || undefined,
      conn_type: form.conn_type,
      host: form.host || undefined,
      port: form.port ? Number(form.port) : undefined,
      database: form.database || undefined,
      username: form.username || undefined,
      password: form.password || undefined,
      extra: { dialect: form.dialect },
    })
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await connectionsApi.testAdhoc({
        conn_type: form.conn_type,
        host:     form.host     || undefined,
        port:     form.port     ? Number(form.port) : undefined,
        database: form.database || undefined,
        username: form.username || undefined,
        // For edit: use form password if filled, else fall back to saved connection test
        password: form.password || (isEdit ? undefined : undefined),
        extra: { dialect: form.dialect },
      })
      setTestResult(r)
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

          {(form.conn_type === 'jdbc' || form.conn_type === 'datawarehouse') && (
            <FormControl size="small" fullWidth>
              <InputLabel>Dialect</InputLabel>
              <Select label="Dialect" value={form.dialect} onChange={e => setForm(f => ({ ...f, dialect: e.target.value as string }))}>
                {DIALECTS.map(d => <MenuItem key={d} value={d}>{d}</MenuItem>)}
              </Select>
            </FormControl>
          )}

          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField label="Host" value={form.host} onChange={set('host')} size="small" sx={{ flex: 3 }} />
            <TextField label="Port" value={form.port} onChange={set('port')} size="small" sx={{ flex: 1 }} type="number" />
          </Box>

          <TextField label="Database" value={form.database} onChange={set('database')} size="small"
            helperText={(form.conn_type === 'jdbc' || form.conn_type === 'datawarehouse') && !form.database ? 'Required for JDBC connections' : undefined}
            error={(form.conn_type === 'jdbc' || form.conn_type === 'datawarehouse') && !form.database}
          />
          <TextField label="Username" value={form.username} onChange={set('username')} size="small" />

          <TextField
            label={isEdit ? 'Password (leave blank to keep current)' : 'Password'}
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
              disabled={testing || !form.host}
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

// ─────────────────────────────────────────────────────────────────────────────
// Delete confirm dialog
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function Connections() {
  const { data: connections = [], isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
  })

  const [createOpen, setCreateOpen] = useState(false)
  const [editConn, setEditConn] = useState<Connection | null>(null)
  const [deleteConn, setDeleteConn] = useState<Connection | null>(null)
  const [testResults, setTestResults] = useState<Record<number, TestResult>>({})
  const [testingId, setTestingId] = useState<number | null>(null)

  const handleTest = async (conn: Connection) => {
    setTestingId(conn.id)
    try {
      const r = await connectionsApi.test(conn.id)
      setTestResults(prev => ({ ...prev, [conn.id]: r }))
    } catch (e: unknown) {
      setTestResults(prev => ({ ...prev, [conn.id]: { ok: false, latency_ms: 0, message: String(e) } }))
    } finally {
      setTestingId(null)
    }
  }

  const copyUrl = (conn: Connection) => {
    const dialect = (conn.extra?.dialect as string) ?? 'postgresql'
    const url = `${dialect}://${conn.username ?? ''}@${conn.host ?? 'localhost'}:${conn.port ?? 5432}/${conn.database ?? ''}`
    navigator.clipboard.writeText(url)
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
                <TableCell sx={{ fontWeight: 700 }}>Host</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Database</TableCell>
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
                        {conn.host ?? '—'}{conn.port ? `:${conn.port}` : ''}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace" fontSize="0.75rem">
                        {conn.database ?? '—'}
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

      {createOpen && (
        <ConnectionDialog open onClose={() => setCreateOpen(false)} />
      )}
      {editConn && (
        <ConnectionDialog open onClose={() => setEditConn(null)} initial={editConn} />
      )}
      {deleteConn && (
        <DeleteDialog conn={deleteConn} onClose={() => setDeleteConn(null)} />
      )}
    </Box>
  )
}
