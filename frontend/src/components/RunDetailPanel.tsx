import { useState, useEffect, useRef } from 'react'
import {
  Box, Typography, Button, CircularProgress, Alert,
  alpha, useTheme, ToggleButtonGroup, ToggleButton,
  Chip, Collapse, Paper,
} from '@mui/material'
import { Cancel, AccountTree, FormatListBulleted, ExpandMore, ChevronRight, Schema } from '@mui/icons-material'
import { Refresh } from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { runsApi, pipelinesApi, RunDetail, RunStep } from '../api/client'
import { format, parseISO } from 'date-fns'
import RunLogPanel from './RunLogPanel'
import StatusChip from './StatusChip'
import RunGraphView from './RunGraphView'

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatDuration(seconds?: number): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`
}

export function formatRunDate(str?: string): string {
  if (!str) return '—'
  try { return format(parseISO(str.endsWith('Z') ? str : str + 'Z'), 'MMM d, HH:mm:ss') } catch { return str }
}

// ── Step tree ─────────────────────────────────────────────────────────────────

interface StepNode { step: RunStep; children: StepNode[] }

function buildStepTree(steps: RunStep[]): StepNode[] {
  const byId = new Map<number, StepNode>()
  for (const s of steps) byId.set(s.id, { step: s, children: [] })
  const roots: StepNode[] = []
  for (const node of byId.values()) {
    const pid = node.step.parent_step_id
    if (pid != null && byId.has(pid)) byId.get(pid)!.children.push(node)
    else roots.push(node)
  }
  const sort = (ns: StepNode[]) => { ns.sort((a, b) => a.step.step_order - b.step.step_order); ns.forEach(n => sort(n.children)) }
  sort(roots)
  return roots
}

function derivedStatus(node: StepNode): string {
  if (node.children.length === 0) return node.step.status
  const cs = node.children.map(derivedStatus)
  if (cs.some(s => s === 'failed')) return 'failed'
  if (cs.some(s => s === 'running' || s === 'pending')) return 'running'
  if (cs.every(s => s === 'completed')) return 'completed'
  return node.step.status
}

const STEP_COLORS: Record<string, string> = {
  extract: '#58a6ff', app: '#e3b341', chunk: '#a371f7',
  load: '#3fb950', filter: '#f0883e', sort: '#f0883e',
  join: '#f0883e', aggregate: '#f0883e', sql_transform: '#f0883e',
}

const TERMINAL = ['completed', 'failed', 'cancelled', 'completed_with_warnings']

function StepDot({ status, color }: { status: string; color: string }) {
  const size = 9
  if (status === 'running') return <CircularProgress size={size + 1} thickness={4} sx={{ color, flexShrink: 0 }} />
  const bg = status === 'completed' ? '#3fb950' : status === 'failed' ? '#f85149' : status === 'cancelled' ? '#6e7681' : undefined
  return <Box sx={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, bgcolor: bg, border: bg ? undefined : `1.5px solid ${alpha(color, 0.4)}` }} />
}

function StepTreeRow({ node, depth = 0 }: { node: StepNode; depth?: number }) {
  const status = derivedStatus(node)
  const [open, setOpen] = useState(() => !TERMINAL.includes(status) && depth < 2)
  const theme = useTheme()
  const prevStatusRef = useRef<string | null>(null)

  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (prev !== null && prev !== status && TERMINAL.includes(status)) {
      setOpen(false)
    }
  }, [status])

  const color = STEP_COLORS[node.step.step_type] ?? '#6e7681'
  const hasChildren = node.children.length > 0
  const done = node.children.filter(c => ['completed', 'failed', 'cancelled'].includes(derivedStatus(c))).length

  return (
    <>
      <Box
        onClick={hasChildren ? () => setOpen(o => !o) : undefined}
        sx={{
          display: 'flex', alignItems: 'center', gap: 1,
          pl: `${8 + depth * 20}px`, pr: 1.5,
          py: depth === 0 ? 0.75 : 0.5,
          cursor: hasChildren ? 'pointer' : 'default',
          borderTop: `1px solid ${alpha(theme.palette.divider, depth === 0 ? 0.6 : 0.2)}`,
          bgcolor: depth === 1 ? alpha(theme.palette.background.default, 0.5)
                : depth >= 2 ? alpha(theme.palette.background.default, 0.85)
                : 'transparent',
          '&:hover': hasChildren ? { bgcolor: alpha(theme.palette.text.primary, 0.08) } : {},
        }}
      >
        <Box sx={{ width: 14, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {hasChildren && (open
            ? <ExpandMore sx={{ fontSize: 14, color: 'text.disabled' }} />
            : <ChevronRight sx={{ fontSize: 14, color: 'text.disabled' }} />)}
        </Box>
        <StepDot status={status} color={color} />
        <Box component="span" sx={{
          fontSize: '0.62rem', fontWeight: 700, px: 0.75, py: 0.15,
          borderRadius: 0.5, bgcolor: alpha(color, 0.15), color,
          textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0,
        }}>
          {node.step.step_type}
        </Box>
        {node.step.step_label && (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {node.step.step_label}
          </Typography>
        )}
        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1.5, flexShrink: 0 }}>
          {hasChildren && node.children.length > 0 && (
            <Typography variant="caption" color="text.disabled">{done}/{node.children.length}</Typography>
          )}
          {node.step.records_out != null && (
            <Typography variant="caption" color="text.secondary">
              {node.step.records_out.toLocaleString()} rows
            </Typography>
          )}
          {node.step.duration_seconds != null && (
            <Typography variant="caption" color="text.disabled" sx={{ minWidth: 36, textAlign: 'right' }}>
              {node.step.duration_seconds < 60
                ? `${node.step.duration_seconds.toFixed(1)}s`
                : `${Math.floor(node.step.duration_seconds / 60)}m${(node.step.duration_seconds % 60).toFixed(0)}s`}
            </Typography>
          )}
          <StatusChip status={status} />
        </Box>
      </Box>
      {hasChildren && open && node.children.map(child => (
        <StepTreeRow key={child.step.id} node={child} depth={depth + 1} />
      ))}
    </>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

// ── JDBC Schema panel ──────────────────────────────────────────────────────────

interface SchemaField { name: string; type: string; nullable: boolean }

function JdbcSchemaPanel({ fields, schemaPath }: { fields: SchemaField[]; schemaPath?: string }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)

  return (
    <Box sx={{ mb: 2 }}>
      <Box
        onClick={() => setOpen(o => !o)}
        sx={{
          display: 'flex', alignItems: 'center', gap: 1, cursor: 'pointer',
          py: 0.75, px: 1.25,
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: open ? '4px 4px 0 0' : 1,
          bgcolor: alpha(theme.palette.primary.main, 0.05),
          '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) },
        }}
      >
        <Schema sx={{ fontSize: 15, color: 'primary.main' }} />
        <Typography variant="caption" sx={{ fontWeight: 700, flex: 1, color: 'primary.main' }}>
          JDBC Schema ({fields.length} field{fields.length !== 1 ? 's' : ''})
        </Typography>
        {schemaPath && (
          <Typography variant="caption" color="text.disabled" sx={{ fontFamily: 'monospace', fontSize: '0.62rem' }} noWrap>
            schema.json
          </Typography>
        )}
        {open ? <ExpandMore sx={{ fontSize: 14, color: 'text.secondary' }} /> : <ChevronRight sx={{ fontSize: 14, color: 'text.secondary' }} />}
      </Box>
      <Collapse in={open}>
        <Paper
          variant="outlined"
          sx={{ borderTop: 0, borderRadius: '0 0 4px 4px', overflow: 'hidden' }}
        >
          <Box sx={{ display: 'flex', px: 1.25, py: 0.5, bgcolor: alpha(theme.palette.background.default, 0.6), borderBottom: `1px solid ${theme.palette.divider}` }}>
            <Typography variant="caption" color="text.secondary" sx={{ flex: 2, fontWeight: 700, fontSize: '0.62rem', textTransform: 'uppercase' }}>Field</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ flex: 2, fontWeight: 700, fontSize: '0.62rem', textTransform: 'uppercase' }}>Type</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1, fontWeight: 700, fontSize: '0.62rem', textTransform: 'uppercase' }}>Nullable</Typography>
          </Box>
          {fields.map((f, i) => (
            <Box
              key={f.name}
              sx={{
                display: 'flex', alignItems: 'center', px: 1.25, py: 0.4,
                borderBottom: i < fields.length - 1 ? `1px solid ${alpha(theme.palette.divider, 0.4)}` : 'none',
                bgcolor: i % 2 === 0 ? 'transparent' : alpha(theme.palette.background.default, 0.3),
              }}
            >
              <Typography sx={{ flex: 2, fontFamily: 'monospace', fontSize: '0.72rem', fontWeight: 600 }}>{f.name}</Typography>
              <Box sx={{ flex: 2 }}>
                <Chip
                  label={f.type}
                  size="small"
                  sx={{ fontFamily: 'monospace', fontSize: '0.62rem', height: 18,
                    bgcolor: alpha(theme.palette.primary.main, 0.12), color: 'primary.main' }}
                />
              </Box>
              <Typography sx={{ flex: 1, fontSize: '0.68rem', color: f.nullable ? 'text.disabled' : 'success.main' }}>
                {f.nullable ? 'yes' : 'no'}
              </Typography>
            </Box>
          ))}
        </Paper>
      </Collapse>
    </Box>
  )
}

interface Props {
  runId: number
  /** When true the log panel fills to the bottom of the viewport */
  fillLogToBottom?: boolean
  /** Background colour for the panel wrapper */
  bgcolor?: string
  /** Called after a successful cancel */
  onCancelled?: () => void
  /** Hide the Steps/Graph toggle and force steps-only view */
  disableGraphView?: boolean
}

export default function RunDetailPanel({ runId, fillLogToBottom = false, bgcolor, onCancelled, disableGraphView = false }: Props) {
  const theme = useTheme()
  const qc = useQueryClient()
  const terminal = ['completed', 'failed', 'cancelled', 'completed_with_warnings']
  const [stepView, setStepView] = useState<'steps' | 'graph'>('steps')

  const { data: run, isLoading } = useQuery<RunDetail>({
    queryKey: ['run-detail', runId],
    queryFn: () => runsApi.get(runId),
    refetchInterval: r => {
      const status = (r.state.data as RunDetail | undefined)?.status
      return status && terminal.includes(status) ? false : 3000
    },
  })

  const { data: pipeline } = useQuery({
    queryKey: ['pipeline', run?.pipeline_id],
    queryFn: () => pipelinesApi.get(run!.pipeline_id),
    enabled: !!run?.pipeline_id,
    staleTime: 120_000,
  })

  const cancelMut = useMutation({
    mutationFn: () => runsApi.cancel(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['run-detail', runId] })
      qc.invalidateQueries({ queryKey: ['run', runId] })
      qc.invalidateQueries({ queryKey: ['pipelines'] })
      qc.invalidateQueries({ queryKey: ['all-runs'] })
      onCancelled?.()
    },
  })

  const retrySparkMut = useMutation({
    mutationFn: () => runsApi.retrySparkLoad(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['run-detail', runId] })
      qc.invalidateQueries({ queryKey: ['run', runId] })
      qc.invalidateQueries({ queryKey: ['all-runs'] })
    },
  })

  const rerunMut = useMutation({
    mutationFn: () => pipelinesApi.run(run!.pipeline_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['all-runs'] })
      qc.invalidateQueries({ queryKey: ['pipelines'] })
    },
  })

  if (isLoading) return <Box sx={{ p: 2 }}><CircularProgress size={20} /></Box>
  if (!run) return null

  const isRunning = run.status === 'running' || run.status === 'pending'
  const hasSparkWarning = run.status === 'completed_with_warnings'
  const hasCanvas = !!(pipeline?.canvas_config as any)?.nodes?.length

  return (
    <Box sx={{ p: 2, bgcolor: bgcolor ?? alpha(theme.palette.background.paper, 0.5) }}>
      {/* ── Status bar ── */}
      <Box sx={{ display: 'flex', gap: 2, mb: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <StatusChip status={run.status} />
        <Typography variant="caption" color="text.secondary">Run #{run.id}</Typography>
        <Typography variant="caption" color="text.secondary">Duration: {formatDuration(run.duration_seconds)}</Typography>
        {run.records_extracted != null && (
          <Typography variant="caption" color="text.secondary">Extracted: {run.records_extracted.toLocaleString()}</Typography>
        )}
        {run.records_loaded != null && (
          <Typography variant="caption" color="text.secondary">Loaded: {run.records_loaded.toLocaleString()}</Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {isRunning && (
          <Button size="small" color="error" startIcon={<Cancel />} onClick={() => cancelMut.mutate()} disabled={cancelMut.isPending}>
            Cancel
          </Button>
        )}
        {hasSparkWarning && (
          <Button
            size="small" color="warning"
            startIcon={retrySparkMut.isPending ? <CircularProgress size={14} color="inherit" /> : <Refresh />}
            onClick={() => retrySparkMut.mutate()}
            disabled={retrySparkMut.isPending}
          >
            Retry Spark Load
          </Button>
        )}
      </Box>

      {/* ── Steps / Graph toggle ── */}
      {run.steps.length > 0 && !disableGraphView && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
          <ToggleButtonGroup
            value={stepView} exclusive onChange={(_, v) => v && setStepView(v)} size="small"
            sx={{
              '& .MuiToggleButton-root': {
                py: 0.3,
                px: 1,
                fontSize: '0.7rem',
                color: 'text.primary',
                borderColor: alpha(theme.palette.divider, 0.9),
                '&:hover': {
                  bgcolor: alpha(theme.palette.text.primary, 0.08),
                },
              },
              '& .MuiToggleButton-root.Mui-selected': {
                bgcolor: alpha(theme.palette.primary.main, 0.18),
                color: theme.palette.text.primary,
                borderColor: alpha(theme.palette.primary.main, 0.5),
              },
              '& .MuiToggleButton-root.Mui-selected:hover': {
                bgcolor: alpha(theme.palette.primary.main, 0.25),
              },
            }}
          >
            <ToggleButton value="steps"><FormatListBulleted sx={{ fontSize: 13, mr: 0.5 }} /> Steps</ToggleButton>
            <ToggleButton value="graph" disabled={!hasCanvas}><AccountTree sx={{ fontSize: 13, mr: 0.5 }} /> Graph</ToggleButton>
          </ToggleButtonGroup>
        </Box>
      )}

      {/* ── Spark warning ── */}
      {hasSparkWarning && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <strong>Spark table registration failed.</strong>
          {run.error_message ? ` ${run.error_message}` : ' Parquet data was saved but could not be registered in the Spark catalog.'}
          {' '}Use <strong>Retry Spark Load</strong> to re-attempt without re-extracting.
          {retrySparkMut.isError && (
            <Box component="span" sx={{ display: 'block', mt: 0.5, color: 'error.main' }}>
              Retry failed: {(retrySparkMut.error as Error)?.message ?? 'Unknown error'}
            </Box>
          )}
        </Alert>
      )}

      {/* ── Step tree or graph ── */}
      {run.steps.length > 0 && (
        <Box sx={{ mb: 2 }}>
          {stepView === 'steps' ? (
            <Box sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: 1, overflow: 'hidden' }}>
              {buildStepTree(run.steps).map(node => (
                <StepTreeRow key={node.step.id} node={node} depth={0} />
              ))}
            </Box>
          ) : pipeline ? (
            <RunGraphView
              run={run}
              pipeline={pipeline}
              onRerun={() => rerunMut.mutate()}
              onRetrySparkLoad={() => retrySparkMut.mutate()}
              retryPending={retrySparkMut.isPending}
            />
          ) : (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
              <CircularProgress size={20} />
            </Box>
          )}
        </Box>
      )}

      {/* ── Error ── */}
      {run.error_message && !hasSparkWarning && (
        <Alert severity="error" sx={{ mb: 2 }}>{run.error_message}</Alert>
      )}

      {/* ── JDBC Schema ── */}
      {Array.isArray((run.run_metadata as any)?.jdbc_schema) && (run.run_metadata as any).jdbc_schema.length > 0 && (
        <JdbcSchemaPanel
          fields={(run.run_metadata as any).jdbc_schema as SchemaField[]}
          schemaPath={(run.run_metadata as any).jdbc_schema_path as string | undefined}
        />
      )}

      {/* ── Logs ── */}
      <RunLogPanel logs={run.logs} live={isRunning} defaultHeight={220} fillToBottom={fillLogToBottom} />
    </Box>
  )
}
