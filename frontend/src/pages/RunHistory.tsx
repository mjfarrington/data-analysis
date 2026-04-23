import { useState, useEffect, useRef } from 'react'
import {
  Box, Typography, Table, TableHead, TableRow, TableCell, TableBody,
  TextField, MenuItem, Button, CircularProgress, Collapse,
  IconButton, Tooltip, alpha, useTheme, Checkbox,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material'
import {
  ExpandMore, ExpandLess, Delete,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { runsApi, pipelinesApi, RunSummary } from '../api/client'
import { format, parseISO } from 'date-fns'
import StatusChip from '../components/StatusChip'
import RunDetailPanel, { formatDuration, formatRunDate as formatDate } from '../components/RunDetailPanel'
import TableToolbar from '../components/TableToolbar'
import SortableTableCell from '../components/SortableTableCell'

// ── Types ─────────────────────────────────────────────────────────────────────

type RunSortField = 'id' | 'pipeline' | 'status' | 'started' | 'duration' | 'extracted'
type SortDir = 'asc' | 'desc'

export default function RunHistory() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [pipelineFilter, setPipelineFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [clearConfirm, setClearConfirm] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleteSelectedConfirm, setDeleteSelectedConfirm] = useState(false)
  const autoExpandedRef = useRef<number | null>(null)
  const [search, setSearch] = useState('')
  const [sortField, setSortField] = useState<RunSortField>('started')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  function handleSort(field: RunSortField) {
    setSortDir(d => field === sortField ? (d === 'asc' ? 'desc' : 'asc') : 'desc')
    setSortField(field)
  }

  const { data: runs = [], isLoading } = useQuery({
    queryKey: ['all-runs'],
    queryFn: runsApi.list,
    refetchInterval: query => {
      const active = ((query.state.data as RunSummary[] | undefined) ?? []).some(
        r => r.status === 'running' || r.status === 'pending'
      )
      return active ? 3000 : 30_000
    },
  })

  // Auto-expand active runs; auto-collapse them once they complete
  useEffect(() => {
    const active = runs.find(r => r.status === 'running' || r.status === 'pending')
    if (active) {
      if (expandedId === null) {
        setExpandedId(active.id)
        autoExpandedRef.current = active.id
      }
    } else if (autoExpandedRef.current !== null) {
      const wasExpanded = runs.find(r => r.id === autoExpandedRef.current)
      if (wasExpanded && wasExpanded.status !== 'running' && wasExpanded.status !== 'pending') {
        setExpandedId(prev => prev === autoExpandedRef.current ? null : prev)
        autoExpandedRef.current = null
      }
    }
  }, [runs])

  const { data: pipelines = [] } = useQuery({
    queryKey: ['pipelines'],
    queryFn: pipelinesApi.list,
  })

  const isDeletable = (run: RunSummary) => run.status !== 'running' && run.status !== 'pending'

  const deleteMut = useMutation({
    mutationFn: (id: number) => runsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['all-runs'] }),
  })

  const deleteSelectedMut = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map(id => runsApi.delete(id))),
    onSuccess: () => {
      setSelectedIds(new Set())
      setDeleteSelectedConfirm(false)
      qc.invalidateQueries({ queryKey: ['all-runs'] })
    },
  })

  const clearMut = useMutation({
    mutationFn: () => runsApi.clearAll(pipelineFilter ? Number(pipelineFilter) : undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['all-runs'] })
      setClearConfirm(false)
    },
  })

  const STATUSES = ['', 'running', 'pending', 'completed', 'failed', 'cancelled']

  const filtered = runs
    .filter(run => {
      const extended = run as RunSummary & { pipeline_id?: number }
      const pl = pipelines.find(p => p.id === extended.pipeline_id)
      const matchStatus = !statusFilter || run.status === statusFilter
      const matchPipeline = !pipelineFilter || String(extended.pipeline_id) === pipelineFilter
      const matchSearch = !search ||
        String(run.id).includes(search) ||
        (pl?.name ?? '').toLowerCase().includes(search.toLowerCase())
      return matchStatus && matchPipeline && matchSearch
    })
    .sort((a, b) => {
      const ea = a as RunSummary & { pipeline_id?: number }
      const eb = b as RunSummary & { pipeline_id?: number }
      const pa = pipelines.find(p => p.id === ea.pipeline_id)
      const pb = pipelines.find(p => p.id === eb.pipeline_id)
      let cmp = 0
      if (sortField === 'id') cmp = a.id - b.id
      else if (sortField === 'pipeline') cmp = (pa?.name ?? '').localeCompare(pb?.name ?? '')
      else if (sortField === 'status') cmp = a.status.localeCompare(b.status)
      else if (sortField === 'started') {
        const da = a.started_at ?? ''; const db2 = b.started_at ?? ''
        cmp = da < db2 ? -1 : da > db2 ? 1 : 0
      } else if (sortField === 'duration') cmp = (a.duration_seconds ?? 0) - (b.duration_seconds ?? 0)
      else if (sortField === 'extracted') cmp = (a.records_extracted ?? 0) - (b.records_extracted ?? 0)
      return sortDir === 'asc' ? cmp : -cmp
    })

  const deletableFiltered = filtered.filter(isDeletable)
  const allDeletableSelected = deletableFiltered.length > 0 && deletableFiltered.every(r => selectedIds.has(r.id))
  const someDeletableSelected = deletableFiltered.some(r => selectedIds.has(r.id))

  const toggleSelectAll = () => {
    if (allDeletableSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        deletableFiltered.forEach(r => next.delete(r.id))
        return next
      })
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev)
        deletableFiltered.forEach(r => next.add(r.id))
        return next
      })
    }
  }

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 3 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>Run History</Typography>
          <Typography variant="body2" color="text.secondary">Monitor all pipeline executions</Typography>
        </Box>
        {selectedIds.size > 0 && (
          <Button
            size="small" color="error" startIcon={<Delete />}
            onClick={() => setDeleteSelectedConfirm(true)}
            sx={{ ml: 1 }}
          >
            Delete Selected ({selectedIds.size})
          </Button>
        )}
        <Tooltip title="Delete all non-active runs">
          <Button
            size="small" color="error" startIcon={<Delete />}
            onClick={() => setClearConfirm(true)}
            sx={{ ml: 1 }}
          >
            Clear History
          </Button>
        </Tooltip>
      </Box>

      <TableToolbar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search by run ID or pipeline…"
        onRefresh={() => qc.invalidateQueries({ queryKey: ['all-runs'] })}
        count={filtered.length}
        total={runs.length}
      >
        <TextField
          select label="Pipeline" value={pipelineFilter}
          onChange={e => setPipelineFilter(e.target.value)}
          size="small" sx={{ width: 180 }}
        >
          <MenuItem value="">All Pipelines</MenuItem>
          {pipelines.map(p => <MenuItem key={p.id} value={String(p.id)}>{p.name}</MenuItem>)}
        </TextField>
        <TextField
          select label="Status" value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          size="small" sx={{ width: 140 }}
        >
          {STATUSES.map(s => <MenuItem key={s} value={s}>{s || 'All'}</MenuItem>)}
        </TextField>
      </TableToolbar>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>
      ) : (
        <Box sx={{ bgcolor: 'background.paper', borderRadius: 2, border: `1px solid ${theme.palette.divider}`, overflow: 'hidden' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell width={40} padding="checkbox">
                  <Checkbox
                    size="small"
                    indeterminate={someDeletableSelected && !allDeletableSelected}
                    checked={allDeletableSelected}
                    onChange={toggleSelectAll}
                    disabled={deletableFiltered.length === 0}
                  />
                </TableCell>
                <TableCell width={40} />
                <SortableTableCell field="id" label="Run ID" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortableTableCell field="pipeline" label="Pipeline" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortableTableCell field="status" label="Status" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortableTableCell field="started" label="Started" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortableTableCell field="duration" label="Duration" current={sortField} dir={sortDir} onSort={handleSort} />
                <SortableTableCell field="extracted" label="Extracted" current={sortField} dir={sortDir} onSort={handleSort} />
                <TableCell>Loaded</TableCell>
                <TableCell>Error</TableCell>
                <TableCell width={48} />
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map(run => {
                const extended = run as RunSummary & { pipeline_id?: number }
                const pipeline = pipelines.find(p => p.id === extended.pipeline_id)
                const expanded = expandedId === run.id
                return [
                  <TableRow key={run.id} hover sx={{ cursor: 'pointer' }}>
                    <TableCell padding="checkbox">
                      {isDeletable(run) && (
                        <Checkbox
                          size="small"
                          checked={selectedIds.has(run.id)}
                          onChange={e => {
                            e.stopPropagation()
                            setSelectedIds(prev => {
                              const next = new Set(prev)
                              e.target.checked ? next.add(run.id) : next.delete(run.id)
                              return next
                            })
                          }}
                          onClick={e => e.stopPropagation()}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <IconButton size="small" onClick={() => setExpandedId(expanded ? null : run.id)}>
                        {expanded ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
                      </IconButton>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>#{run.id}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {pipeline?.name ?? `Pipeline ${extended.pipeline_id}`}
                      </Typography>
                    </TableCell>
                    <TableCell><StatusChip status={run.status} /></TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {formatDate(run.started_at)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {formatDuration(run.duration_seconds)}
                      </Typography>
                    </TableCell>
                    <TableCell>{run.records_extracted?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell>{run.records_loaded?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell sx={{ maxWidth: 180 }}>
                      {run.error_message && (
                        <Tooltip title={run.error_message}>
                          <Typography variant="caption" color="error" noWrap sx={{ display: 'block', maxWidth: 180 }}>
                            {run.error_message}
                          </Typography>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>
                      {run.status !== 'running' && run.status !== 'pending' && (
                        <Tooltip title="Delete run">
                          <IconButton
                            size="small"
                            onClick={e => { e.stopPropagation(); deleteMut.mutate(run.id) }}
                            disabled={deleteMut.isPending}
                          >
                            <Delete sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>,
                  <TableRow key={`${run.id}-detail`}>
                    <TableCell colSpan={11} sx={{ p: 0, border: 0 }}>
                      <Collapse in={expanded} unmountOnExit>
                        <RunDetailPanel runId={run.id} />
                      </Collapse>
                    </TableCell>
                  </TableRow>,
                ]
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No runs found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      )}

      {/* Delete selected confirm */}
      <Dialog open={deleteSelectedConfirm} onClose={() => setDeleteSelectedConfirm(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete Selected Runs</DialogTitle>
        <DialogContent>
          <Typography>
            Delete {selectedIds.size} selected run{selectedIds.size !== 1 ? 's' : ''}? This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteSelectedConfirm(false)}>Cancel</Button>
          <Button
            variant="contained" color="error"
            disabled={deleteSelectedMut.isPending}
            onClick={() => deleteSelectedMut.mutate(Array.from(selectedIds))}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Clear history confirm */}
      <Dialog open={clearConfirm} onClose={() => setClearConfirm(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Clear Run History</DialogTitle>
        <DialogContent>
          <Typography>
            {pipelineFilter
              ? 'Delete all completed, failed, and cancelled runs for the selected pipeline?'
              : 'Delete all completed, failed, and cancelled runs? Active runs will not be affected.'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClearConfirm(false)}>Cancel</Button>
          <Button variant="contained" color="error" disabled={clearMut.isPending} onClick={() => clearMut.mutate()}>
            Clear History
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
