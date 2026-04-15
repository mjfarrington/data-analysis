import { Box, Grid, Card, CardContent, Typography, CircularProgress, Divider, Button, Tooltip, LinearProgress, alpha, useTheme, Stack } from '@mui/material'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { servicesApi, runsApi, pipelinesApi, dataApi } from '../api/client'
import StatusChip from '../components/StatusChip'
import { Refresh, Speed, CheckCircle, Error as ErrorIcon, PlayArrow, LocalFireDepartment } from '@mui/icons-material'
import { formatDistanceToNow } from 'date-fns'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, BarChart, Bar, Legend,
} from 'recharts'
import { useNavigate } from 'react-router-dom'

function MetricCard({ title, value, subtitle, icon, color }: {
  title: string; value: string | number; subtitle?: string; icon: React.ReactNode; color: string
}) {
  const theme = useTheme()
  return (
    <Card>
      <CardContent sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, pb: '16px !important' }}>
        <Box sx={{ p: 1.2, borderRadius: 2, bgcolor: alpha(color, 0.15), color, display: 'flex' }}>
          {icon}
        </Box>
        <Box sx={{ flex: 1 }}>
          <Typography variant="caption" color="text.secondary" fontWeight={500} textTransform="uppercase" letterSpacing="0.05em">
            {title}
          </Typography>
          <Typography variant="h4" fontWeight={700} sx={{ lineHeight: 1.2, mt: 0.25 }}>
            {value}
          </Typography>
          {subtitle && <Typography variant="caption" color="text.secondary">{subtitle}</Typography>}
        </Box>
      </CardContent>
    </Card>
  )
}

function ServiceCard({ service }: { service: { name: string; status: string; latency_ms?: number; message?: string; url?: string } }) {
  const theme = useTheme()
  const color = service.status === 'healthy' ? theme.palette.success.main
    : service.status === 'degraded' ? theme.palette.warning.main
    : theme.palette.error.main
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', py: 0.75, gap: 1.5 }}>
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0,
        boxShadow: service.status === 'healthy' ? `0 0 6px ${color}` : 'none' }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={500} noWrap>{service.name}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap>{service.message || service.url || ''}</Typography>
      </Box>
      {service.latency_ms !== undefined && (
        <Tooltip title="Response latency">
          <Typography variant="caption" sx={{ color, fontFamily: '"JetBrains Mono", monospace', flexShrink: 0 }}>
            {service.latency_ms.toFixed(0)}ms
          </Typography>
        </Tooltip>
      )}
    </Box>
  )
}

const RUN_STATUS_COLOR: Record<string, string> = {
  completed: '#10b981', failed: '#ef4444', running: '#f59e0b', cancelled: '#6b7280', pending: '#3b82f6',
}

export default function Dashboard() {
  const theme = useTheme()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['services-status'],
    queryFn: () => servicesApi.status().then((r) => r.data),
    refetchInterval: 15_000,
  })

  const { data: runs } = useQuery({
    queryKey: ['runs-recent'],
    queryFn: () => runsApi.list(undefined, 30).then((r) => r.data),
    refetchInterval: 8_000,
  })

  const { data: pipelines } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => pipelinesApi.list().then((r) => r.data),
  })

  const { data: tables } = useQuery({
    queryKey: ['data-tables'],
    queryFn: () => dataApi.tables().then((r) => r.data),
    refetchInterval: 30_000,
  })

  const { data: errors } = useQuery({
    queryKey: ['errors-unresolved'],
    queryFn: () => dataApi.errors({ resolved: false, limit: 5 }).then((r) => r.data),
    refetchInterval: 20_000,
  })

  // Build run status chart data (last 20 runs grouped)
  const runChartData = (() => {
    if (!runs) return []
    return runs.slice(0, 20).reverse().map((r, i) => ({
      name: `#${r.id}`,
      records: r.records_loaded,
      duration: r.duration_seconds ? Math.round(r.duration_seconds) : 0,
      status: r.status,
    }))
  })()

  const runStats = (() => {
    if (!runs) return { completed: 0, failed: 0, running: 0 }
    return runs.reduce((acc, r) => {
      acc[r.status as keyof typeof acc] = (acc[r.status as keyof typeof acc] || 0) + 1
      return acc
    }, { completed: 0, failed: 0, running: 0 } as Record<string, number>)
  })()

  const totalRecords = runs?.reduce((s, r) => s + r.records_loaded, 0) ?? 0
  const totalSize = tables?.reduce((s, t) => s + t.size_bytes, 0) ?? 0
  const formatBytes = (b: number) => b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3, gap: 1 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>Dashboard</Typography>
          <Typography variant="caption" color="text.secondary">System overview and performance</Typography>
        </Box>
        <Button size="small" startIcon={<Refresh />} onClick={() => qc.invalidateQueries()} variant="outlined">
          Refresh
        </Button>
      </Box>

      {/* Metric cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <MetricCard
            title="Total Records"
            value={totalRecords > 1e6 ? `${(totalRecords / 1e6).toFixed(1)}M` : totalRecords.toLocaleString()}
            subtitle="across all runs"
            icon={<LocalFireDepartment fontSize="small" />}
            color={theme.palette.primary.main}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <MetricCard
            title="Pipelines"
            value={pipelines?.length ?? 0}
            subtitle={`${pipelines?.filter((p) => p.status === 'active').length ?? 0} active`}
            icon={<Speed fontSize="small" />}
            color={theme.palette.secondary.main}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <MetricCard
            title="Successful Runs"
            value={runStats.completed}
            subtitle={`${runStats.failed} failed`}
            icon={<CheckCircle fontSize="small" />}
            color={theme.palette.success.main}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <MetricCard
            title="Data Stored"
            value={formatBytes(totalSize)}
            subtitle={`${tables?.length ?? 0} partition sets`}
            icon={<ErrorIcon fontSize="small" />}
            color={theme.palette.warning.main}
          />
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        {/* Services status */}
        <Grid item xs={12} md={4}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5, gap: 1 }}>
                <Typography variant="subtitle2" fontWeight={600}>Services</Typography>
                {status && <StatusChip status={status.overall} size="small" />}
                {statusLoading && <CircularProgress size={14} />}
              </Box>
              <Divider sx={{ mb: 1.5 }} />
              {status?.services.map((s) => (
                <ServiceCard key={s.name} service={s} />
              ))}
              {!status && !statusLoading && (
                <Typography variant="body2" color="text.secondary">No status available</Typography>
              )}
              <Box sx={{ mt: 2, display: 'flex', gap: 1 }}>
                <Button size="small" variant="outlined" fullWidth onClick={() => navigate('/errors')}>
                  View Errors {errors && errors.length > 0 && `(${errors.length})`}
                </Button>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Run chart */}
        <Grid item xs={12} md={8}>
          <Card>
            <CardContent>
              <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 2 }}>
                Recent Runs — Records Loaded
              </Typography>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={runChartData}>
                  <defs>
                    <linearGradient id="records" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={theme.palette.primary.main} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={theme.palette.primary.main} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: theme.palette.text.secondary }} />
                  <YAxis tick={{ fontSize: 11, fill: theme.palette.text.secondary }} />
                  <RTooltip
                    contentStyle={{ background: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, borderRadius: 8 }}
                    labelStyle={{ color: theme.palette.text.primary }}
                  />
                  <Area type="monotone" dataKey="records" stroke={theme.palette.primary.main} fill="url(#records)" strokeWidth={2} name="Records" />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>

        {/* Recent runs table */}
        <Grid item xs={12} md={7}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, gap: 1 }}>
                <Typography variant="subtitle2" fontWeight={600} sx={{ flex: 1 }}>Recent Runs</Typography>
                <Button size="small" variant="text" onClick={() => navigate('/runs')}>View all</Button>
              </Box>
              {runs?.slice(0, 8).map((r) => (
                <Box
                  key={r.id}
                  sx={{
                    display: 'flex', alignItems: 'center', py: 0.75, gap: 1.5,
                    borderBottom: `1px solid ${theme.palette.divider}`,
                    '&:last-child': { borderBottom: 'none' },
                    cursor: 'pointer', '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.04) },
                    borderRadius: 1, px: 0.5,
                  }}
                  onClick={() => navigate('/runs')}
                >
                  <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: RUN_STATUS_COLOR[r.status] || '#999', flexShrink: 0 }} />
                  <Typography variant="caption" sx={{ fontFamily: '"JetBrains Mono", monospace', color: 'text.secondary', width: 40 }}>
                    #{r.id}
                  </Typography>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={500} noWrap>Pipeline #{r.pipeline_id}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {r.records_loaded.toLocaleString()} records · {r.segments_processed} segments
                    </Typography>
                  </Box>
                  <Box sx={{ textAlign: 'right' }}>
                    <StatusChip status={r.status} />
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                      {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                    </Typography>
                  </Box>
                </Box>
              ))}
              {!runs?.length && (
                <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 3 }}>
                  No runs yet. Create a pipeline and trigger a run.
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Active errors */}
        <Grid item xs={12} md={5}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <Typography variant="subtitle2" fontWeight={600} sx={{ flex: 1 }}>Active Errors</Typography>
                <Button size="small" variant="text" onClick={() => navigate('/errors')}>View all</Button>
              </Box>
              {errors?.length ? errors.map((e) => (
                <Box key={e.id} sx={{ mb: 1.5, p: 1.5, bgcolor: alpha(theme.palette.error.main, 0.08), borderRadius: 2, border: `1px solid ${alpha(theme.palette.error.main, 0.2)}` }}>
                  <Box sx={{ display: 'flex', gap: 1, mb: 0.25 }}>
                    <Typography variant="caption" sx={{ fontFamily: '"JetBrains Mono", monospace', color: 'error.main', fontWeight: 600 }}>{e.service}</Typography>
                    <Typography variant="caption" color="text.secondary">{formatDistanceToNow(new Date(e.timestamp), { addSuffix: true })}</Typography>
                  </Box>
                  <Typography variant="caption" noWrap display="block" color="text.secondary">{e.message}</Typography>
                </Box>
              )) : (
                <Stack alignItems="center" justifyContent="center" sx={{ py: 4, gap: 1 }}>
                  <CheckCircle sx={{ color: 'success.main', fontSize: 32 }} />
                  <Typography variant="body2" color="text.secondary">No active errors</Typography>
                </Stack>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  )
}
