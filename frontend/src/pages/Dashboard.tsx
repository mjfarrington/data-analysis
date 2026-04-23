import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Typography, Card, CardContent, CardActionArea,
  Chip, LinearProgress, Tooltip, alpha, useTheme,
  Table, TableHead, TableRow, TableCell, TableBody,
  CircularProgress, Alert, Divider, Stack,
} from '@mui/material'
import {
  AccountTree as PipelinesIcon,
  CheckCircleOutlined,
  ErrorOutlined,
  PlayCircleOutlined,
  MonitorHeart as ServicesIcon,
  Storage as StorageIcon,
  TrendingUp,
  AccessTime,
  Bolt,
  TableChart as TableChartIcon,
  Dataset as DatasetIcon,
} from '@mui/icons-material'
import { useQuery } from '@tanstack/react-query'
import { pipelinesApi, runsApi, servicesApi, contextApi, dataApi, Pipeline, RunSummary, ServicesStatus, DataTable } from '../api/client'
import StatusChip, { STATUS_COLOR } from '../components/StatusChip'
import { format, parseISO, isToday, formatDistanceToNow, subDays } from 'date-fns'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(seconds?: number): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`
}

function relativeTime(str?: string): string {
  if (!str) return '—'
  try { return formatDistanceToNow(parseISO(str), { addSuffix: true }) } catch { return str }
}

function shortDate(str?: string): string {
  if (!str) return '—'
  try {
    const d = parseISO(str)
    return isToday(d) ? format(d, 'HH:mm:ss') : format(d, 'MMM d, HH:mm')
  } catch { return str }
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string
  value: string | number
  sub?: string
  color: string
  icon: React.ReactNode
  onClick?: () => void
}

function StatCard({ label, value, sub, color, icon, onClick }: StatCardProps) {
  const inner = (
    <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Box sx={{
          width: 44, height: 44, borderRadius: 2, flexShrink: 0,
          bgcolor: alpha(color, 0.12),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color,
        }}>
          {icon}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ color: 'text.secondary', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.8, fontSize: '0.67rem', lineHeight: 1 }}>
            {label}
          </Typography>
          <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.25, mt: 0.35, color }}>
            {value}
          </Typography>
          {sub && (
            <Typography sx={{ color: 'text.secondary', mt: 0.2, display: 'block', fontSize: '0.7rem' }}>
              {sub}
            </Typography>
          )}
        </Box>
      </Box>
    </CardContent>
  )

  return (
    <Card sx={{ height: '100%', border: `1px solid ${alpha(color, 0.18)}` }}>
      {onClick ? (
        <CardActionArea onClick={onClick} sx={{ height: '100%', borderRadius: 'inherit' }}>{inner}</CardActionArea>
      ) : inner}
    </Card>
  )
}

// ── Service Row ───────────────────────────────────────────────────────────────

function ServiceRow({ svc }: { svc: { name: string; status: string; latency_ms?: number; message?: string } }) {
  const color = STATUS_COLOR[svc.status] ?? '#8b949e'

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.75 }}>
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0, boxShadow: `0 0 6px ${color}` }} />
      <Typography variant="body2" sx={{ flex: 1, fontWeight: 500 }}>{svc.name}</Typography>
      {svc.latency_ms != null && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{svc.latency_ms}ms</Typography>
      )}
      <StatusChip status={svc.status} />
    </Box>
  )
}

// ── Pipeline Sparkline (last-run status indicator) ────────────────────────────

function PipelineRow({ pipeline, onClick }: { pipeline: Pipeline; onClick: () => void }) {
  const theme = useTheme()
  const status = pipeline.last_run?.status
  const statusColor = STATUS_COLOR[status ?? ''] ?? theme.palette.divider

  return (
    <TableRow
      hover
      onClick={onClick}
      sx={{ cursor: 'pointer', '&:last-child td': { border: 0 } }}
    >
      <TableCell sx={{ py: 1, pl: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ width: 3, height: 28, borderRadius: 2, bgcolor: statusColor, flexShrink: 0 }} />
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 500, lineHeight: 1.2 }}>{pipeline.name}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{pipeline.source_type} → {pipeline.load_target}</Typography>
          </Box>
        </Box>
      </TableCell>
      <TableCell sx={{ py: 1 }} align="right">
        {status
          ? <StatusChip status={status} />
          : <Typography variant="caption" sx={{ color: 'text.secondary' }}>never run</Typography>
        }
      </TableCell>
      <TableCell sx={{ py: 1, pr: 0 }} align="right">
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {pipeline.last_run ? relativeTime(pipeline.last_run.started_at) : '—'}
        </Typography>
      </TableCell>
    </TableRow>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const theme = useTheme()
  const navigate = useNavigate()

  const { data: pipelines = [], isLoading: pipelinesLoading } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: pipelinesApi.list,
    refetchInterval: 30_000,
  })

  const { data: runs = [], isLoading: runsLoading } = useQuery<RunSummary[]>({
    queryKey: ['runs'],
    queryFn: runsApi.list,
    refetchInterval: 10_000,
  })

  const { data: services } = useQuery<ServicesStatus>({
    queryKey: ['services-status'],
    queryFn: servicesApi.status,
    refetchInterval: 15_000,
    retry: false,
  })

  const { data: ctx } = useQuery({
    queryKey: ['execution-context'],
    queryFn: contextApi.get,
    staleTime: 60_000,
  })

  const { data: tables = [], isLoading: tablesLoading } = useQuery<DataTable[]>({
    queryKey: ['data-tables'],
    queryFn: dataApi.listTables,
    refetchInterval: 60_000,
    retry: false,
  })

  // ── Derived stats ──────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const runsToday = runs.filter(r => r.started_at && isToday(parseISO(r.started_at)))
    const failed = runsToday.filter(r => r.status === 'failed').length
    const completed = runsToday.filter(r => r.status === 'completed' || r.status === 'completed_with_warnings').length
    const running = runs.filter(r => r.status === 'running' || r.status === 'pending').length
    const activePipelines = pipelines.filter(p => p.status === 'active').length
    return { runsToday: runsToday.length, failed, completed, running, activePipelines }
  }, [pipelines, runs])

  const recentRuns = useMemo(() => runs.slice(0, 10), [runs])

  const sortedPipelines = useMemo(() =>
    [...pipelines].sort((a, b) => {
      const at = a.last_run?.started_at ?? ''
      const bt = b.last_run?.started_at ?? ''
      return bt.localeCompare(at)
    }),
  [pipelines])

  const runsByDay = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = subDays(new Date(), 6 - i)
      return { label: format(d, 'EEE'), date: format(d, 'yyyy-MM-dd') }
    })
    const dayMap: Record<string, { label: string; completed: number; failed: number }> = {}
    days.forEach(({ label, date }) => { dayMap[date] = { label, completed: 0, failed: 0 } })
    runs.forEach(r => {
      if (!r.started_at) return
      try {
        const date = format(parseISO(r.started_at), 'yyyy-MM-dd')
        if (dayMap[date]) {
          if (r.status === 'completed' || r.status === 'completed_with_warnings') dayMap[date].completed++
          else if (r.status === 'failed') dayMap[date].failed++
        }
      } catch { /* skip */ }
    })
    return days.map(({ date }) => dayMap[date])
  }, [runs])

  const statusBreakdown = useMemo(() => {
    const counts: Record<string, number> = {}
    runs.forEach(r => { counts[r.status] = (counts[r.status] ?? 0) + 1 })
    return Object.entries(counts)
      .map(([status, value]) => ({ status, value }))
      .sort((a, b) => b.value - a.value)
  }, [runs])

  const avgDuration = useMemo(() => {
    const withDur = runs.filter(r => r.duration_seconds != null && r.status === 'completed')
    if (!withDur.length) return null
    return withDur.reduce((s, r) => s + (r.duration_seconds ?? 0), 0) / withDur.length
  }, [runs])

  const totalRows = useMemo(() =>
    tables.reduce((s, t) => s + (t.row_count ?? 0), 0)
  , [tables])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Box sx={{ p: 3, maxWidth: 1400, mx: 'auto' }}>

      {/* Header */}
      <Box sx={{ mb: 3, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>Dashboard</Typography>
          {ctx && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Business date: <strong>{ctx.business_date}</strong>&nbsp;·&nbsp;Namespace: <strong>{ctx.namespace}</strong>
            </Typography>
          )}
        </Box>
        {stats.running > 0 && (
          <Chip
            icon={<Bolt fontSize="small" />}
            label={`${stats.running} run${stats.running > 1 ? 's' : ''} in progress`}
            color="info"
            size="small"
            sx={{ animation: 'pulse 1.4s infinite' }}
          />
        )}
      </Box>

      {/* Stat cards */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2,1fr)', sm: 'repeat(3,1fr)', md: 'repeat(6,1fr)' }, gap: 2, mb: 2 }}>
        <StatCard
          label="Pipelines"
          value={pipelines.length}
          sub={`${stats.activePipelines} active`}
          color={theme.palette.primary.main}
          icon={<PipelinesIcon />}
          onClick={() => navigate('/pipelines')}
        />
        <StatCard
          label="Runs Today"
          value={stats.runsToday}
          sub={`${stats.completed} completed`}
          color={theme.palette.success.main}
          icon={<TrendingUp />}
          onClick={() => navigate('/runs')}
        />
        <StatCard
          label="Failed Today"
          value={stats.failed}
          sub={stats.failed > 0 ? 'needs attention' : 'all clear'}
          color={stats.failed > 0 ? theme.palette.error.main : theme.palette.success.main}
          icon={<ErrorOutlined />}
          onClick={() => navigate('/runs')}
        />
        <StatCard
          label="Services"
          value={services?.overall === 'healthy' ? 'Healthy' : services?.overall ?? '—'}
          sub={services ? `${services.services.filter(s => s.status === 'healthy').length}/${services.services.length} up` : undefined}
          color={
            services?.overall === 'healthy' ? theme.palette.success.main :
            services?.overall === 'degraded' ? theme.palette.warning.main :
            theme.palette.error.main
          }
          icon={<ServicesIcon />}
          onClick={() => navigate('/services')}
        />
        <StatCard
          label="Tables"
          value={tablesLoading ? '…' : tables.length}
          sub={tables.length > 0 ? `${tables.filter(t => (t.row_count ?? 0) > 0).length} with data` : 'no data store'}
          color={theme.palette.info.main}
          icon={<TableChartIcon />}
          onClick={() => navigate('/explorer')}
        />
        <StatCard
          label="Total Rows"
          value={tablesLoading ? '…' : totalRows >= 1_000_000 ? `${(totalRows / 1_000_000).toFixed(1)}M` : totalRows >= 1_000 ? `${(totalRows / 1_000).toFixed(1)}K` : totalRows}
          sub={totalRows > 0 ? 'across all tables' : 'no rows yet'}
          color={theme.palette.secondary.main}
          icon={<DatasetIcon />}
          onClick={() => navigate('/explorer')}
        />
      </Box>

      {/* Two-column body */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '2fr 1fr' }, gap: 2, alignItems: 'start' }}>
        <Stack spacing={2}>
          <Card>
            <CardContent sx={{ pb: '12px !important' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>Run Activity — last 7 days</Typography>
              {runs.length === 0 ? (
                <Box sx={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Typography variant="caption" color="text.secondary">No run data yet</Typography>
                </Box>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={runsByDay} barGap={3} barSize={16}>
                    <CartesianGrid strokeDasharray="3 3" stroke={alpha(theme.palette.divider, 0.6)} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: theme.palette.text.secondary }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: theme.palette.text.secondary }} axisLine={false} tickLine={false} width={24} />
                    <ChartTooltip
                      contentStyle={{
                        background: theme.palette.background.paper,
                        border: `1px solid ${theme.palette.divider}`,
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      cursor={{ fill: alpha(theme.palette.action.hover, 0.08) }}
                    />
                    <Bar dataKey="completed" stackId="a" fill={theme.palette.success.main} name="Completed" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="failed" stackId="a" fill={theme.palette.error.main} name="Failed" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
              <Box sx={{ display: 'flex', gap: 2, mt: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: 'success.main' }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.7rem' }}>Completed</Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: 'error.main' }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.7rem' }}>Failed</Typography>
                </Box>
                {avgDuration != null && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 'auto' }}>
                    <AccessTime sx={{ fontSize: 13, color: 'text.secondary' }} />
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.7rem' }}>
                      avg {formatDuration(avgDuration)}
                    </Typography>
                  </Box>
                )}
              </Box>
            </CardContent>
          </Card>

          <Card>
            <CardContent sx={{ pb: 0 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Recent Runs</Typography>
                <Typography
                  variant="caption"
                  sx={{ color: 'primary.main', cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
                  onClick={() => navigate('/runs')}
                >
                  View all →
                </Typography>
              </Box>
              {runsLoading ? (
                <Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}>
                  <CircularProgress size={28} />
                </Box>
              ) : recentRuns.length === 0 ? (
                <Alert severity="info" sx={{ mt: 1 }}>No runs yet. Trigger a pipeline to get started.</Alert>
              ) : (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ pl: 0, color: 'text.secondary', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Pipeline</TableCell>
                      <TableCell sx={{ color: 'text.secondary', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Status</TableCell>
                      <TableCell sx={{ color: 'text.secondary', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }} align="right">Records</TableCell>
                      <TableCell sx={{ color: 'text.secondary', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }} align="right">Duration</TableCell>
                      <TableCell sx={{ pr: 0, color: 'text.secondary', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }} align="right">Started</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {recentRuns.map(run => {
                      const pipeline = pipelines.find(p => p.last_run?.id === run.id)
                      return (
                        <TableRow
                          key={run.id}
                          hover
                          onClick={() => navigate('/runs')}
                          sx={{ cursor: 'pointer', '&:last-child td': { border: 0 } }}
                        >
                          <TableCell sx={{ pl: 0, py: 1 }}>
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                              {pipeline?.name ?? `Run #${run.id}`}
                            </Typography>
                          </TableCell>
                          <TableCell sx={{ py: 1 }}>
                            <StatusChip status={run.status} />
                            {run.status === 'running' && (
                              <LinearProgress sx={{ mt: 0.5, borderRadius: 1, height: 2 }} />
                            )}
                          </TableCell>
                          <TableCell sx={{ py: 1 }} align="right">
                            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                              {run.records_loaded != null
                                ? `${run.records_loaded.toLocaleString()} loaded`
                                : run.records_extracted != null
                                ? `${run.records_extracted.toLocaleString()} extracted`
                                : '—'}
                            </Typography>
                          </TableCell>
                          <TableCell sx={{ py: 1 }} align="right">
                            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                              {formatDuration(run.duration_seconds)}
                            </Typography>
                          </TableCell>
                          <TableCell sx={{ pr: 0, py: 1 }} align="right">
                            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                              {shortDate(run.started_at)}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </Stack>

        <Stack spacing={2}>
          <Card>
            <CardContent sx={{ pb: '12px !important' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>Status Breakdown</Typography>
              {statusBreakdown.length === 0 ? (
                <Box sx={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Typography variant="caption" color="text.secondary">No run data yet</Typography>
                </Box>
              ) : (
                <Box sx={{ position: 'relative' }}>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie
                        data={statusBreakdown}
                        dataKey="value"
                        nameKey="status"
                        cx="50%" cy="50%"
                        innerRadius={52}
                        outerRadius={76}
                        paddingAngle={2}
                        strokeWidth={0}
                      >
                        {statusBreakdown.map(entry => (
                          <Cell key={entry.status} fill={STATUS_COLOR[entry.status] ?? '#8b949e'} />
                        ))}
                      </Pie>
                      <ChartTooltip
                        contentStyle={{
                          background: theme.palette.background.paper,
                          border: `1px solid ${theme.palette.divider}`,
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        formatter={(value, name) => [`${value} runs`, name]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <Box sx={{
                    position: 'absolute', inset: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    pointerEvents: 'none',
                  }}>
                    <Box sx={{ textAlign: 'center' }}>
                      <Typography variant="h4" sx={{ fontWeight: 700, lineHeight: 1 }}>{runs.length}</Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>total runs</Typography>
                    </Box>
                  </Box>
                </Box>
              )}
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
                {statusBreakdown.map(entry => (
                  <Box key={entry.status} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: STATUS_COLOR[entry.status] ?? '#8b949e', flexShrink: 0 }} />
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.68rem' }}>
                      {entry.status} <strong>{entry.value}</strong>
                    </Typography>
                  </Box>
                ))}
              </Box>
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Service Health</Typography>
                {services?.overall && <StatusChip status={services.overall} />}
              </Box>
              {services ? (
                <Box>
                  {services.services.map((svc, i) => (
                    <Box key={svc.name}>
                      <ServiceRow svc={svc} />
                      {i < services.services.length - 1 && <Divider sx={{ opacity: 0.4 }} />}
                    </Box>
                  ))}
                </Box>
              ) : (
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Loading…</Typography>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent sx={{ pb: '12px !important' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Pipelines</Typography>
                <Typography
                  variant="caption"
                  sx={{ color: 'primary.main', cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
                  onClick={() => navigate('/pipelines')}
                >
                  Manage →
                </Typography>
              </Box>
              {pipelinesLoading ? (
                <CircularProgress size={20} />
              ) : sortedPipelines.length === 0 ? (
                <Alert severity="info" sx={{ fontSize: '0.75rem' }}>No pipelines yet.</Alert>
              ) : (
                <Table size="small">
                  <TableBody>
                    {sortedPipelines.slice(0, 6).map(p => (
                      <PipelineRow key={p.id} pipeline={p} onClick={() => navigate(`/pipelines/${p.id}/edit`)} />
                    ))}
                  </TableBody>
                </Table>
              )}
              {sortedPipelines.length > 6 && (
                <Typography
                  variant="caption"
                  sx={{ color: 'text.secondary', mt: 0.5, display: 'block', cursor: 'pointer', '&:hover': { color: 'primary.main' } }}
                  onClick={() => navigate('/pipelines')}
                >
                  +{sortedPipelines.length - 6} more
                </Typography>
              )}
            </CardContent>
          </Card>

        </Stack>
      </Box>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </Box>
  )
}
