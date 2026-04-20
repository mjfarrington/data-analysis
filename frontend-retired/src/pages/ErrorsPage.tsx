import { useState } from 'react'
import {
  Box, Typography, Card, CardContent, Table, TableHead, TableBody, TableRow, TableCell,
  Chip, IconButton, Button, Tooltip, Dialog, DialogTitle, DialogContent,
  DialogActions, TextField, MenuItem, Alert, CircularProgress, alpha,
  useTheme, LinearProgress, Divider,
} from '@mui/material'
import { Refresh, CheckCircle, FilterList, ExpandMore, ExpandLess } from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import { dataApi, ErrorRecord } from '../api/client'
import { format, formatDistanceToNow } from 'date-fns'
import { parseApiDate } from '../utils/dates'

const LEVEL_COLOR: Record<string, 'error' | 'warning' | 'info' | 'default'> = {
  ERROR: 'error', CRITICAL: 'error', WARN: 'warning', WARNING: 'warning',
  INFO: 'info', DEBUG: 'default',
}

function TracebackDialog({ error, onClose }: { error: ErrorRecord; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <Chip label={error.level} color={LEVEL_COLOR[error.level] || 'default'} size="small" />
        <Typography variant="subtitle1" fontWeight={600}>{error.service}</Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 2 }}>{error.message}</Typography>
        {error.context && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>Context</Typography>
            <Box component="pre" sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.75rem', p: 1.5, borderRadius: 1, bgcolor: 'background.default', overflow: 'auto', m: 0 }}>
              {JSON.stringify(error.context, null, 2)}
            </Box>
          </Box>
        )}
        {error.traceback && (
          <Box>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>Traceback</Typography>
            <Box component="pre" sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.73rem', p: 1.5, borderRadius: 1, bgcolor: '#0a0e1a', color: '#ef4444', overflow: 'auto', m: 0, maxHeight: 400 }}>
              {error.traceback}
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

export default function ErrorsPage() {
  const theme = useTheme()
  const { enqueueSnackbar } = useSnackbar()
  const qc = useQueryClient()
  const [serviceFilter, setServiceFilter] = useState('')
  const [resolvedFilter, setResolvedFilter] = useState<'all' | 'unresolved' | 'resolved'>('unresolved')
  const [selected, setSelected] = useState<ErrorRecord | null>(null)

  const params = {
    service: serviceFilter || undefined,
    resolved: resolvedFilter === 'all' ? undefined : resolvedFilter === 'resolved',
    limit: 200,
  }

  const { data: errors, isLoading, refetch } = useQuery({
    queryKey: ['errors', params],
    queryFn: () => dataApi.errors(params).then((r) => r.data),
    refetchInterval: 15_000,
  })

  const resolveMutation = useMutation({
    mutationFn: (id: number) => dataApi.resolveError(id).then((r) => r.data),
    onSuccess: () => {
      enqueueSnackbar('Error resolved', { variant: 'success' })
      qc.invalidateQueries({ queryKey: ['errors'] })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const services = [...new Set(errors?.map((e) => e.service) ?? [])]

  const grouped = (() => {
    if (!errors) return {}
    return errors.reduce((acc, e) => {
      if (!acc[e.service]) acc[e.service] = []
      acc[e.service].push(e)
      return acc
    }, {} as Record<string, ErrorRecord[]>)
  })()

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3, gap: 1 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>Error Log</Typography>
          <Typography variant="caption" color="text.secondary">Service errors, ETL failures, and system alerts</Typography>
        </Box>
        <IconButton onClick={() => refetch()}><Refresh /></IconButton>
      </Box>

      {/* Filters */}
      <Card sx={{ mb: 2 }}>
        <CardContent sx={{ py: '12px !important', display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <FilterList sx={{ color: 'text.secondary' }} />
          <TextField
            select label="Service" value={serviceFilter} size="small" sx={{ minWidth: 160 }}
            onChange={(e) => setServiceFilter(e.target.value)}
          >
            <MenuItem value="">All services</MenuItem>
            {services.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
          </TextField>
          <TextField
            select label="Status" value={resolvedFilter} size="small" sx={{ minWidth: 140 }}
            onChange={(e) => setResolvedFilter(e.target.value as typeof resolvedFilter)}
          >
            <MenuItem value="unresolved">Unresolved</MenuItem>
            <MenuItem value="resolved">Resolved</MenuItem>
            <MenuItem value="all">All</MenuItem>
          </TextField>
          <Box sx={{ display: 'flex', gap: 1, ml: 'auto' }}>
            {errors && (
              <Chip
                label={`${errors.length} error${errors.length !== 1 ? 's' : ''}`}
                color={errors.length > 0 ? 'error' : 'success'}
                size="small"
              />
            )}
          </Box>
        </CardContent>
      </Card>

      {isLoading ? (
        <LinearProgress />
      ) : !errors?.length ? (
        <Card>
          <CardContent sx={{ textAlign: 'center', py: 8 }}>
            <CheckCircle sx={{ fontSize: 48, color: 'success.main', mb: 1 }} />
            <Typography variant="h6" color="text.secondary">No errors found</Typography>
            <Typography variant="body2" color="text.secondary">System is running cleanly.</Typography>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Service</TableCell>
                <TableCell>Level</TableCell>
                <TableCell>Message</TableCell>
                <TableCell>Time</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {errors.map((e) => (
                <TableRow
                  key={e.id}
                  sx={{
                    cursor: 'pointer',
                    opacity: e.resolved ? 0.5 : 1,
                    '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.04) },
                  }}
                  onClick={() => setSelected(e)}
                >
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'text.secondary' }}>#{e.id}</TableCell>
                  <TableCell>
                    <Chip label={e.service} size="small" variant="outlined" sx={{ fontSize: '0.72rem', fontFamily: 'monospace' }} />
                  </TableCell>
                  <TableCell>
                    <Chip label={e.level} size="small" color={LEVEL_COLOR[e.level] || 'default'} variant="filled" sx={{ fontSize: '0.7rem', fontWeight: 700 }} />
                  </TableCell>
                  <TableCell sx={{ maxWidth: 400 }}>
                    <Typography variant="body2" noWrap>{e.message}</Typography>
                    {e.traceback && (
                      <Typography variant="caption" color="text.secondary">Has traceback</Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Tooltip title={format(parseApiDate(e.timestamp), 'PPpp')}>
                      <Typography variant="caption" color="text.secondary">
                        {formatDistanceToNow(parseApiDate(e.timestamp), { addSuffix: true })}
                      </Typography>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    {e.resolved
                      ? <Chip label="Resolved" size="small" color="success" variant="outlined" />
                      : <Chip label="Open" size="small" color="error" variant="outlined" />
                    }
                  </TableCell>
                  <TableCell onClick={(ev) => ev.stopPropagation()}>
                    {!e.resolved && (
                      <Tooltip title="Mark resolved">
                        <IconButton size="small" color="success" onClick={() => resolveMutation.mutate(e.id)}>
                          <CheckCircle fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {selected && <TracebackDialog error={selected} onClose={() => setSelected(null)} />}
    </Box>
  )
}
