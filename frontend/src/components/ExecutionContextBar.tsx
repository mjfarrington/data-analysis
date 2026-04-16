/**
 * ExecutionContextBar — shared compact status bar shown on ETL pages.
 *
 * Read-only bar with a single "Edit" button that opens a dialog.
 * Never wraps; chip labels are truncated if needed.
 */
import { useState } from 'react'
import {
  Alert, Box, Button, CircularProgress, Chip, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, FormControlLabel, Grid, Paper,
  Switch, TextField, Tooltip, Typography, alpha, useTheme,
} from '@mui/material'
import { CalendarToday, Edit, Tag } from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import { pipelinesApi, ExecutionContext } from '../api/client'
import DateField from './DateField'

export default function ExecutionContextBar() {
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()
  const theme = useTheme()

  const [editOpen, setEditOpen] = useState(false)
  const [date, setDate] = useState('')
  const [prefix, setPrefix] = useState('')
  const [dbName, setDbName] = useState('')
  const [useFixed, setUseFixed] = useState(false)

  const { data: ctx, isLoading } = useQuery<ExecutionContext>({
    queryKey: ['execution-context'],
    queryFn: () => pipelinesApi.getContext().then((r) => r.data),
    refetchInterval: 60_000,
  })

  const mut = useMutation({
    mutationFn: (d: { business_date?: string | null; namespace_prefix?: string; db_name?: string | null }) =>
      pipelinesApi.updateContext(d).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['execution-context'] })
      setEditOpen(false)
      enqueueSnackbar('Execution context updated', { variant: 'success' })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const handleOpen = () => {
    setDate(ctx?.business_date ?? '')
    setPrefix(ctx?.namespace_prefix ?? '')
    setDbName(ctx?.db_name ?? '')
    setUseFixed(!!ctx?.db_name)
    setEditOpen(true)
  }

  const handleSave = () => {
    mut.mutate({
      business_date: date || null,
      namespace_prefix: useFixed ? '' : prefix,
      db_name: useFixed ? (dbName || null) : null,
    })
  }

  const handleClear = () => {
    mut.mutate({ business_date: null, namespace_prefix: '', db_name: null })
  }

  // Live preview inside the dialog
  const preview = useFixed
    ? (dbName.trim() || null)
    : (date ? `${prefix.trim()}${date.replace(/-/g, '')}` : null)

  if (isLoading) return null

  const hasContext = !!(ctx?.business_date || ctx?.db_name)

  return (
    <>
      {/* ── Compact read-only bar ── */}
      <Paper
        variant="outlined"
        sx={{
          mb: 2,
          px: 2,
          height: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          overflow: 'hidden',
          bgcolor: alpha(theme.palette.primary.main, 0.04),
          borderColor: alpha(theme.palette.primary.main, 0.2),
        }}
      >
        {/* Section label */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexShrink: 0, mr: 1.5 }}>
          <CalendarToday sx={{ fontSize: 14, color: 'primary.main' }} />
          <Typography variant="caption" fontWeight={700} color="primary.main" noWrap>
            Execution Context
          </Typography>
        </Box>

        <Divider orientation="vertical" flexItem sx={{ mr: 1.5 }} />

        {/* Business date */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexShrink: 0, mr: 1.5 }}>
          <Typography variant="caption" color="text.secondary" noWrap>Date</Typography>
          <Chip
            size="small"
            label={ctx?.business_date ?? 'not set'}
            color={ctx?.business_date ? 'primary' : 'default'}
            variant={ctx?.business_date ? 'filled' : 'outlined'}
            sx={{ fontSize: '0.72rem', height: 22, fontWeight: 600, maxWidth: 120 }}
          />
        </Box>

        {/* Active database */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexShrink: 0, mr: 1.5 }}>
          <Typography variant="caption" color="text.secondary" noWrap>Active DB</Typography>
          {ctx?.namespace ? (
            <>
              <Chip
                size="small"
                label={ctx.namespace}
                color="success"
                variant="filled"
                sx={{ fontSize: '0.72rem', height: 22, fontFamily: 'monospace', fontWeight: 600, maxWidth: 200 }}
              />
              <Tooltip title={ctx.db_name ? 'Fixed database name' : 'Derived from prefix + date'}>
                <Chip
                  size="small"
                  label={ctx.db_name ? 'fixed' : 'derived'}
                  variant="outlined"
                  color={ctx.db_name ? 'success' : 'default'}
                  sx={{ fontSize: '0.62rem', height: 18, flexShrink: 0 }}
                />
              </Tooltip>
            </>
          ) : (
            <Chip
              size="small"
              label="not set"
              variant="outlined"
              color="warning"
              sx={{ fontSize: '0.72rem', height: 22 }}
            />
          )}
        </Box>

        {/* Spacer + actions */}
        <Box sx={{ ml: 'auto', display: 'flex', gap: 0.75, flexShrink: 0 }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<Edit sx={{ fontSize: '14px !important' }} />}
            onClick={handleOpen}
            sx={{ py: 0.25, fontSize: '0.75rem' }}
          >
            Edit
          </Button>
          {hasContext && (
            <Button
              size="small"
              color="warning"
              onClick={handleClear}
              disabled={mut.isPending}
              sx={{ py: 0.25, fontSize: '0.75rem' }}
            >
              {mut.isPending ? <CircularProgress size={12} color="inherit" /> : 'Clear'}
            </Button>
          )}
        </Box>
      </Paper>

      {/* ── Edit dialog ── */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ pb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CalendarToday fontSize="small" color="primary" />
            Execution Context
          </Box>
        </DialogTitle>

        <DialogContent dividers>
          <Grid container spacing={2.5}>

            {/* Business date */}
            <Grid item xs={12}>
              <DateField
                label="Business Date"
                value={date}
                fullWidth
                helperText="The date all pipelines will operate on"
                onChange={setDate}
              />
            </Grid>

            <Grid item xs={12}>
              <Divider>
                <Typography variant="caption" color="text.secondary">Spark Database</Typography>
              </Divider>
            </Grid>

            {/* Fixed vs derived toggle */}
            <Grid item xs={12}>
              <FormControlLabel
                control={
                  <Switch
                    checked={useFixed}
                    onChange={(e) => setUseFixed(e.target.checked)}
                    size="small"
                  />
                }
                label={
                  <Box>
                    <Typography variant="body2" fontWeight={500}>Use a fixed database name</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {useFixed
                        ? 'Name is set directly — date and prefix are ignored'
                        : 'Name is derived from prefix + business date'}
                    </Typography>
                  </Box>
                }
              />
            </Grid>

            {useFixed ? (
              <Grid item xs={12}>
                <TextField
                  label="Database name"
                  value={dbName}
                  fullWidth
                  size="small"
                  placeholder="e.g. markets_20260416"
                  helperText="Exact Spark database name — used as-is"
                  inputProps={{ style: { fontFamily: 'monospace' } }}
                  onChange={(e) => setDbName(e.target.value)}
                  autoFocus
                />
              </Grid>
            ) : (
              <Grid item xs={12}>
                <TextField
                  label="Namespace prefix"
                  value={prefix}
                  fullWidth
                  size="small"
                  placeholder="e.g. markets_"
                  helperText={date
                    ? `Derived name: ${prefix.trim()}${date.replace(/-/g, '')}`
                    : 'Leave blank for no prefix — set a date above to preview'}
                  inputProps={{ style: { fontFamily: 'monospace' } }}
                  onChange={(e) => setPrefix(e.target.value)}
                />
              </Grid>
            )}

            {/* Preview */}
            <Grid item xs={12}>
              {preview ? (
                <Alert severity="success" icon={<Tag fontSize="small" />} sx={{ py: 0.5 }}>
                  <Typography variant="caption" display="block" gutterBottom>Active database will be</Typography>
                  <Typography variant="body2" fontWeight={700} sx={{ fontFamily: 'monospace', fontSize: '0.9rem' }}>
                    {preview}
                  </Typography>
                </Alert>
              ) : (
                <Alert severity="info" sx={{ py: 0.5 }}>
                  <Typography variant="caption">
                    {useFixed ? 'Enter a database name above' : 'Set a business date to preview the resolved name'}
                  </Typography>
                </Alert>
              )}
            </Grid>

          </Grid>
        </DialogContent>

        <DialogActions>
          <Button onClick={() => setEditOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={mut.isPending}
            startIcon={mut.isPending ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
