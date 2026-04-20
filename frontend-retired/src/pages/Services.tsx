import {
  Box, Card, CardContent, CardHeader, Chip, CircularProgress, Divider,
  Grid, IconButton, LinearProgress, Stack, Tooltip, Typography,
  alpha, useTheme, Button, Table, TableBody, TableCell,
  TableHead, TableRow,
} from '@mui/material'
import {
  CheckCircle, Cancel, Help, Refresh,
  Storage as StorageIcon,
  SettingsEthernet as ConnectIcon,
  History as HistoryIcon,
  Memory as WorkerIcon,
  Hub as MasterIcon,
  Code as GrpcIcon,
  Web as FrontendIcon,
  Api as ApiIcon,
  PlayArrow, Stop,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { servicesApi, type ServiceInfo, type SparkTestItem } from '../api/client'
import { formatDistanceToNow } from 'date-fns'
import { parseApiDate } from '../utils/dates'

import { Theme } from '@mui/material/styles'

// ─── Colour helpers ───────────────────────────────────────────────────────────
function statusColor(status: string, theme: Theme) {
  switch (status) {
    case 'healthy':   return theme.palette.success.main
    case 'degraded':  return theme.palette.warning.main
    case 'unhealthy': return theme.palette.error.main
    case 'passed':    return theme.palette.success.main
    case 'failed':    return theme.palette.error.main
    case 'skipped':   return theme.palette.text.disabled
    default:          return theme.palette.text.secondary
  }
}

function StatusDot({ status, size = 10 }: { status: string; size?: number }) {
  const theme = useTheme()
  const color = statusColor(status, theme)
  const glow = (status === 'healthy' || status === 'passed') ? `0 0 7px ${color}` : 'none'
  return (
    <Box sx={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      bgcolor: color, boxShadow: glow,
    }} />
  )
}

// ─── Service icon map ─────────────────────────────────────────────────────────
function ServiceIcon({ name }: { name: string }) {
  const theme = useTheme()
  const map: Record<string, React.ReactNode> = {
    'Spark Master':        <MasterIcon fontSize="small" />,
    'Spark Worker':        <WorkerIcon fontSize="small" />,
    'Spark History':       <HistoryIcon fontSize="small" />,
    'Spark Connect':       <ConnectIcon fontSize="small" />,
    'Data Extract gRPC':   <GrpcIcon fontSize="small" />,
    'FastAPI Backend':     <ApiIcon fontSize="small" />,
    'React Frontend':      <FrontendIcon fontSize="small" />,
  }
  return (
    <Box sx={{ color: theme.palette.text.secondary, display: 'flex', alignItems: 'center' }}>
      {map[name] ?? <StorageIcon fontSize="small" />}
    </Box>
  )
}

// ─── Single service card ──────────────────────────────────────────────────────
function ServiceCard({ service }: { service: ServiceInfo }) {
  const theme = useTheme()
  const color = statusColor(service.status, theme)
  const details = service.details as Record<string, unknown> | undefined

  return (
    <Card sx={{
      border: `1px solid ${alpha(color, 0.35)}`,
      position: 'relative', overflow: 'hidden',
      '&::before': {
        content: '""', position: 'absolute', top: 0, left: 0,
        width: 3, height: '100%', bgcolor: color,
      },
    }}>
      <CardContent sx={{ pl: 2.5, pb: '16px !important' }}>
        {/* Header row */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <StatusDot status={service.status} />
          <ServiceIcon name={service.name} />
          <Typography variant="subtitle2" fontWeight={600} sx={{ flex: 1 }}>
            {service.name}
          </Typography>
          <Chip
            label={service.status}
            size="small"
            sx={{
              bgcolor: alpha(color, 0.15), color, fontWeight: 600,
              fontSize: '0.68rem', height: 20,
            }}
          />
        </Box>

        {/* URL / message */}
        {service.url && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5, fontFamily: 'monospace' }}>
            {service.url}
          </Typography>
        )}
        {service.message && service.status !== 'healthy' && (
          <Typography variant="caption" color="error.main" sx={{ display: 'block', mb: 0.5 }}>
            {service.message}
          </Typography>
        )}

        {/* Latency bar */}
        {service.latency_ms !== undefined && (
          <Box sx={{ mt: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.25 }}>
              <Typography variant="caption" color="text.secondary">Latency</Typography>
              <Typography variant="caption" sx={{ fontFamily: 'monospace', color }}>
                {service.latency_ms.toFixed(0)} ms
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={Math.min(100, (service.latency_ms / 5000) * 100)}
              sx={{
                height: 3, borderRadius: 2,
                bgcolor: alpha(color, 0.1),
                '& .MuiLinearProgress-bar': { bgcolor: color },
              }}
            />
          </Box>
        )}

        {/* Spark Master resource details */}
        {service.name === 'Spark Master' && details && (
          <Box sx={{ mt: 1.5, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75 }}>
            <DetailPill label="Cores" value={`${details.cores_used ?? '?'} / ${details.cores_total ?? '?'}`} />
            <DetailPill label="Memory" value={`${mbToStr(details.memory_used_mb as number)} / ${mbToStr(details.memory_total_mb as number)}`} />
            <DetailPill label="Workers" value={String(details.workers ?? '?')} />
            <DetailPill label="Apps" value={String(details.active_apps ?? '?')} />
          </Box>
        )}

        {/* gRPC details */}
        {service.name === 'Data Extract gRPC' && details && (
          <Box sx={{ mt: 1.5, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75 }}>
            {details.server_version != null && <DetailPill label="Version" value={String(details.server_version)} />}
            {details.uptime_seconds != null && (
              <DetailPill label="Uptime" value={fmtSeconds(details.uptime_seconds as number)} />
            )}
          </Box>
        )}
      </CardContent>
    </Card>
  )
}

function DetailPill({ label, value }: { label: string; value: string }) {
  const theme = useTheme()
  return (
    <Box sx={{ bgcolor: alpha(theme.palette.primary.main, 0.07), borderRadius: 1, px: 1, py: 0.4 }}>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ lineHeight: 1.2 }}>{label}</Typography>
      <Typography variant="caption" fontWeight={600} fontFamily="monospace">{value}</Typography>
    </Box>
  )
}

function mbToStr(mb: number) {
  if (!mb) return '?'
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`
}

function fmtSeconds(s: number) {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// ─── Spark test result table ──────────────────────────────────────────────────
function TestResultIcon({ status }: { status: string }) {
  const theme = useTheme()
  switch (status) {
    case 'passed':  return <CheckCircle sx={{ fontSize: 16, color: theme.palette.success.main }} />
    case 'failed':  return <Cancel sx={{ fontSize: 16, color: theme.palette.error.main }} />
    default:        return <Help sx={{ fontSize: 16, color: theme.palette.text.disabled }} />
  }
}

function SparkTestPanel() {
  const theme = useTheme()
  const qc = useQueryClient()

  const { data, isPending, mutate } = useMutation({
    mutationFn: () => servicesApi.runSparkTest().then(r => r.data),
  })

  const overallColor = !data ? theme.palette.text.secondary
    : data.overall === 'passed' ? theme.palette.success.main
    : theme.palette.error.main

  return (
    <Card>
      <CardHeader
        title={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <StorageIcon sx={{ fontSize: 18, color: theme.palette.primary.main }} />
            <Typography variant="subtitle1" fontWeight={600}>Spark Test Suite</Typography>
            {data && (
              <Chip
                label={data.overall.toUpperCase()}
                size="small"
                sx={{
                  bgcolor: alpha(overallColor, 0.15), color: overallColor,
                  fontWeight: 700, fontSize: '0.68rem', height: 20,
                }}
              />
            )}
          </Box>
        }
        action={
          <Button
            variant="contained"
            size="small"
            startIcon={isPending ? <CircularProgress size={14} color="inherit" /> : <PlayArrow />}
            onClick={() => mutate()}
            disabled={isPending}
            sx={{ mr: 1 }}
          >
            {isPending ? 'Running…' : 'Run Tests'}
          </Button>
        }
        sx={{ pb: 0 }}
      />
      <CardContent>
        {!data && !isPending && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
            Click "Run Tests" to validate your Spark cluster
          </Typography>
        )}
        {isPending && (
          <Box sx={{ py: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <CircularProgress size={32} />
            <Typography variant="body2" color="text.secondary">Running Spark test suite…</Typography>
          </Box>
        )}
        {data && (
          <>
            {/* Summary row */}
            <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap' }}>
              {data.spark_version && (
                <DetailPill label="Spark version" value={data.spark_version.split(' ')[0]} />
              )}
              {data.catalog_tables != null && (
                <DetailPill label="Catalog tables" value={String(data.catalog_tables)} />
              )}
              <DetailPill label="Total time" value={`${data.total_ms.toFixed(0)} ms`} />
            </Box>

            {/* Test rows */}
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 28, pl: 0 }} />
                  <TableCell sx={{ fontWeight: 600 }}>Test</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600, width: 90 }}>Duration</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Detail</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.tests.map((t: SparkTestItem, i: number) => (
                  <TableRow key={i} hover>
                    <TableCell sx={{ pl: 0 }}><TestResultIcon status={t.status} /></TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>{t.name}</Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="caption" fontFamily="monospace" color="text.secondary">
                        {t.status === 'skipped' ? '—' : `${t.duration_ms.toFixed(0)} ms`}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="caption"
                        color={t.status === 'failed' ? 'error.main' : 'text.secondary'}
                        sx={{ fontFamily: t.status === 'failed' ? 'monospace' : 'inherit' }}
                      >
                        {t.detail ?? ''}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Overall status banner ────────────────────────────────────────────────────
function OverallBanner({ overall, checkedAt }: { overall: string; checkedAt: string }) {
  const theme = useTheme()
  const color = statusColor(overall, theme)
  const label = overall.charAt(0).toUpperCase() + overall.slice(1)
  const age = formatDistanceToNow(parseApiDate(checkedAt), { addSuffix: true })

  return (
    <Box sx={{
      p: 2, borderRadius: 2, mb: 3,
      bgcolor: alpha(color, 0.1),
      border: `1px solid ${alpha(color, 0.35)}`,
      display: 'flex', alignItems: 'center', gap: 2,
    }}>
      <StatusDot status={overall} size={12} />
      <Box sx={{ flex: 1 }}>
        <Typography variant="h6" fontWeight={700} sx={{ color, lineHeight: 1 }}>
          Platform {label}
        </Typography>
        <Typography variant="caption" color="text.secondary">Last checked {age}</Typography>
      </Box>
    </Box>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Services() {
  const theme = useTheme()
  const qc = useQueryClient()

  const { data: status, isLoading, isFetching } = useQuery({
    queryKey: ['services-status'],
    queryFn: () => servicesApi.status().then(r => r.data),
    refetchInterval: 15_000,
  })

  const sparkServices = status?.services.filter(s =>
    s.name.startsWith('Spark')
  ) ?? []
  const otherServices = status?.services.filter(s =>
    !s.name.startsWith('Spark')
  ) ?? []

  return (
    <Box sx={{ p: 3, maxWidth: 1400, mx: 'auto' }}>
      {/* Page header */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3, gap: 2 }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Services</Typography>
          <Typography variant="body2" color="text.secondary">
            Real-time health and status of all platform services
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Refresh now">
          <IconButton
            onClick={() => qc.invalidateQueries({ queryKey: ['services-status'] })}
            size="small"
            disabled={isFetching}
          >
            {isFetching ? <CircularProgress size={18} /> : <Refresh />}
          </IconButton>
        </Tooltip>
      </Box>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : status ? (
        <>
          <OverallBanner overall={status.overall} checkedAt={status.checked_at} />

          {/* Spark cluster */}
          <Typography variant="overline" color="text.secondary" fontWeight={600} sx={{ mb: 1, display: 'block' }}>
            Spark Cluster
          </Typography>
          <Grid container spacing={2} sx={{ mb: 3 }}>
            {sparkServices.map(svc => (
              <Grid item xs={12} sm={6} md={4} key={svc.name}>
                <ServiceCard service={svc} />
              </Grid>
            ))}
          </Grid>

          {/* Other services */}
          <Typography variant="overline" color="text.secondary" fontWeight={600} sx={{ mb: 1, display: 'block' }}>
            Platform Services
          </Typography>
          <Grid container spacing={2} sx={{ mb: 3 }}>
            {otherServices.map(svc => (
              <Grid item xs={12} sm={6} md={4} key={svc.name}>
                <ServiceCard service={svc} />
              </Grid>
            ))}
          </Grid>

          <Divider sx={{ mb: 3 }} />

          {/* Spark test runner */}
          <SparkTestPanel />
        </>
      ) : null}
    </Box>
  )
}
