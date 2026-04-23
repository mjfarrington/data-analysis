import { useState } from 'react'
import {
  Box, Typography, Card, CardContent, CardActions, Button,
  CircularProgress, alpha, Tooltip, Collapse, IconButton,
  Divider, Table, TableHead, TableRow, TableCell, TableBody, Alert,
  LinearProgress,
} from '@mui/material'
import {
  Refresh, CheckCircle, Warning, Error as ErrorIcon,
  ExpandMore, ExpandLess, FlashOn, OpenInNew, Science,
} from '@mui/icons-material'
import { useQuery, useMutation } from '@tanstack/react-query'
import { servicesApi, ServiceInfo, SparkTestItem } from '../api/client'
import StatusChip from '../components/StatusChip'

function statusColor(status: string): string {
  switch (status.toLowerCase()) {
    case 'healthy': return '#3fb950'
    case 'degraded': return '#d29922'
    default: return '#f85149'
  }
}

function statusIcon(status: string, size = 20) {
  const sx = { fontSize: size }
  switch (status.toLowerCase()) {
    case 'healthy': return <CheckCircle sx={{ ...sx, color: '#3fb950' }} />
    case 'degraded': return <Warning sx={{ ...sx, color: '#d29922' }} />
    default: return <ErrorIcon sx={{ ...sx, color: '#f85149' }} />
  }
}

function LatencyBar({ ms }: { ms: number }) {
  const pct = Math.min(100, (ms / 500) * 100)
  const color = ms < 100 ? '#3fb950' : ms < 300 ? '#d29922' : '#f85149'
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
      <Box sx={{ flex: 1 }}>
        <LinearProgress
          variant="determinate"
          value={pct}
          sx={{
            height: 4, borderRadius: 2,
            bgcolor: 'action.hover',
            '& .MuiLinearProgress-bar': { bgcolor: color, borderRadius: 2 },
          }}
        />
      </Box>
      <Typography variant="caption" sx={{ color, minWidth: 45, textAlign: 'right', fontFamily: 'monospace' }}>
        {ms.toFixed(0)}ms
      </Typography>
    </Box>
  )
}

function SparkMasterDetails({ details }: { details: Record<string, unknown> }) {
  const coresUsed = Number(details.cores_used ?? 0)
  const coresTotal = Number(details.cores_total ?? 1)
  const memUsed = Number(details.memory_used_mb ?? 0)
  const memTotal = Number(details.memory_total_mb ?? 1)
  const coresPct = coresTotal > 0 ? (coresUsed / coresTotal) * 100 : 0
  const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0
  const pctColor = (p: number) => p > 80 ? '#f85149' : p > 60 ? '#d29922' : '#3fb950'

  return (
    <Box sx={{ mt: 1.5 }}>
      <Divider sx={{ mb: 1.5 }} />
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Cluster Resources
      </Typography>
      <Box sx={{ mt: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
        {[
          { label: 'Workers', value: String(details.workers ?? '\u2014') },
          { label: 'Active Apps', value: String(details.active_apps ?? '\u2014') },
          { label: 'Cores', value: `${coresUsed} / ${coresTotal}` },
          { label: 'Memory', value: `${memUsed} / ${memTotal} MB` },
          { label: 'Version', value: String(details.spark_version ?? '\u2014') },
        ].map(r => (
          <Box key={r.label}>
            <Typography variant="caption" color="text.secondary">{r.label}</Typography>
            <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '0.8rem' }}>{r.value}</Typography>
          </Box>
        ))}
      </Box>
      <Box sx={{ mt: 1.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        <Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.25 }}>
            <Typography variant="caption" color="text.secondary">CPU Utilisation</Typography>
            <Typography variant="caption" sx={{ color: pctColor(coresPct), fontWeight: 700 }}>{coresPct.toFixed(0)}%</Typography>
          </Box>
          <LinearProgress variant="determinate" value={coresPct}
            sx={{ height: 6, borderRadius: 3, bgcolor: 'action.hover', '& .MuiLinearProgress-bar': { bgcolor: pctColor(coresPct) } }} />
        </Box>
        <Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.25 }}>
            <Typography variant="caption" color="text.secondary">Memory Utilisation</Typography>
            <Typography variant="caption" sx={{ color: pctColor(memPct), fontWeight: 700 }}>{memPct.toFixed(0)}%</Typography>
          </Box>
          <LinearProgress variant="determinate" value={memPct}
            sx={{ height: 6, borderRadius: 3, bgcolor: 'action.hover', '& .MuiLinearProgress-bar': { bgcolor: pctColor(memPct) } }} />
        </Box>
      </Box>
    </Box>
  )
}

function ServiceCard({ service }: { service: ServiceInfo }) {
  const [expanded, setExpanded] = useState(false)
  const color = statusColor(service.status)
  const hasDetails = !!service.details && Object.keys(service.details).length > 0

  return (
    <Card sx={{ border: `1px solid ${alpha(color, 0.3)}`, boxShadow: `0 0 16px ${alpha(color, 0.06)}`, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardContent sx={{ flex: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 1 }}>
          {statusIcon(service.status, 22)}
          <Box sx={{ ml: 1.5, flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700 }}>{service.name}</Typography>
            {service.url && (
              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', fontFamily: 'monospace', fontSize: '0.7rem' }}>
                {service.url}
              </Typography>
            )}
          </Box>
          <Box sx={{
            width: 10, height: 10, borderRadius: '50%', flexShrink: 0, mt: 0.5,
            bgcolor: color,
            boxShadow: service.status === 'healthy' ? `0 0 6px ${color}` : 'none',
            animation: service.status !== 'healthy' ? 'pulse 1.5s infinite' : 'none',
            '@keyframes pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.3 } },
          }} />
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
          <StatusChip status={service.status} />
          {service.message && (
            <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1 }}>{service.message}</Typography>
          )}
        </Box>

        {service.latency_ms != null && service.latency_ms > 0 && (
          <LatencyBar ms={service.latency_ms} />
        )}

        {hasDetails && expanded && (
          <SparkMasterDetails details={service.details!} />
        )}
      </CardContent>

      <CardActions sx={{ px: 2, py: 1, borderTop: '1px solid', borderColor: 'divider', gap: 0.5 }}>
        {service.url && (
          <Tooltip title="Open in browser">
            <IconButton size="small" onClick={() => window.open(service.url, '_blank')}>
              <OpenInNew fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {hasDetails && (
          <Button size="small" onClick={() => setExpanded(e => !e)}
            endIcon={expanded ? <ExpandLess /> : <ExpandMore />}
            sx={{ ml: 'auto', fontSize: '0.72rem' }}>
            {expanded ? 'Less' : 'Details'}
          </Button>
        )}
      </CardActions>
    </Card>
  )
}

function SparkTestPanel() {
  const [open, setOpen] = useState(false)
  const testMut = useMutation({ mutationFn: servicesApi.runSparkTest })

  const handleRun = () => {
    setOpen(true)
    testMut.mutate()
  }

  return (
    <Box sx={{ mt: 3, p: 2.5, borderRadius: 2, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: open ? 2 : 0 }}>
        <Science sx={{ color: 'primary.main' }} />
        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Spark Diagnostic Tests</Typography>
          <Typography variant="body2" color="text.secondary">Run a connectivity and compute test suite against the Spark cluster</Typography>
        </Box>
        <Button variant="outlined" size="small"
          startIcon={testMut.isPending ? <CircularProgress size={14} /> : <FlashOn />}
          onClick={handleRun} disabled={testMut.isPending}>
          {testMut.isPending ? 'Running\u2026' : 'Run Tests'}
        </Button>
        {open && <IconButton size="small" onClick={() => setOpen(false)}><ExpandLess /></IconButton>}
      </Box>

      <Collapse in={open}>
        {testMut.isPending && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 2 }}>
            <CircularProgress size={20} />
            <Typography variant="body2" color="text.secondary">Running diagnostic tests\u2026</Typography>
          </Box>
        )}
        {testMut.isError && (
          <Alert severity="error" sx={{ mt: 1 }}>{(testMut.error as Error).message}</Alert>
        )}
        {testMut.data && (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1.5 }}>
              {testMut.data.overall === 'passed'
                ? <CheckCircle sx={{ color: '#3fb950' }} />
                : <ErrorIcon sx={{ color: '#f85149' }} />}
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                  {testMut.data.overall === 'passed' ? 'All tests passed' : 'Some tests failed'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {testMut.data.total_ms.toFixed(0)}ms total
                  {testMut.data.spark_version && ` \u00b7 Spark ${testMut.data.spark_version}`}
                  {testMut.data.catalog_tables != null && ` \u00b7 ${testMut.data.catalog_tables} catalog tables`}
                </Typography>
              </Box>
            </Box>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Test</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Duration</TableCell>
                  <TableCell>Detail</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {testMut.data.tests.map((item: SparkTestItem) => {
                  return (
                    <TableRow key={item.name}>
                      <TableCell sx={{ fontWeight: 500, fontFamily: 'monospace', fontSize: '0.8rem' }}>{item.name}</TableCell>
                      <TableCell>
                        <StatusChip status={item.status} />
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'text.secondary' }}>
                        {item.duration_ms.toFixed(0)}ms
                      </TableCell>
                      <TableCell sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
                        <Typography variant="caption" component="span">{item.detail ?? '\u2014'}</Typography>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </>
        )}
      </Collapse>
    </Box>
  )
}

export default function Services() {
  const { data, isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['services-status-page'],
    queryFn: servicesApi.status,
    refetchInterval: 15_000,
    retry: false,
  })

  const overall = data?.overall ?? 'unknown'
  const overallColor = statusColor(overall)
  const checkedAt = dataUpdatedAt ? new Date(dataUpdatedAt) : null
  const healthyCount = data?.services.filter(s => s.status === 'healthy').length ?? 0
  const totalCount = data?.services.length ?? 0

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 3 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>Services</Typography>
          <Typography variant="body2" color="text.secondary">Infrastructure health \u2014 auto-refreshes every 15 seconds</Typography>
        </Box>
        <Button startIcon={<Refresh />} size="small" onClick={() => refetch()} variant="outlined">Refresh</Button>
      </Box>

      <Box sx={{ mb: 3, p: 2, borderRadius: 2, bgcolor: alpha(overallColor, 0.07), border: `1px solid ${alpha(overallColor, 0.3)}`, display: 'flex', alignItems: 'center', gap: 2 }}>
        {statusIcon(overall, 24)}
        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {overall === 'healthy' ? 'All systems operational' : overall === 'degraded' ? 'Some services degraded' : 'Service disruption detected'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {healthyCount} / {totalCount} healthy{checkedAt && ` \u00b7 Checked ${checkedAt.toLocaleTimeString()}`}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          {data?.services.map(s => (
            <Tooltip key={s.name} title={`${s.name}: ${s.status}`}>
              <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: statusColor(s.status), boxShadow: s.status === 'healthy' ? `0 0 5px ${statusColor(s.status)}` : 'none' }} />
            </Tooltip>
          ))}
        </Box>
      </Box>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 8 }}><CircularProgress /></Box>
      ) : data ? (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', md: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
          {data.services.map(service => (
            <Box key={service.name}>
              <ServiceCard service={service} />
            </Box>
          ))}
        </Box>
      ) : (
        <Alert severity="error">Could not connect to the services endpoint. Ensure the backend is running.</Alert>
      )}

      <SparkTestPanel />
    </Box>
  )
}
