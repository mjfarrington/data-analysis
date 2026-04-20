import { useState } from 'react'
import {
  Box, Typography, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Paper, Chip, CircularProgress, Alert,
  IconButton, Tooltip, LinearProgress, Dialog, DialogTitle,
  DialogContent, DialogActions, Button, TextField, InputAdornment,
} from '@mui/material'
import {
  FolderOpen, Visibility, Refresh, Search, ArrowBack,
  TableChart as TableChartIcon,
} from '@mui/icons-material'
import { useQuery } from '@tanstack/react-query'
import { dataApi, BrowserDir, QueryResult } from '../api/client'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview dialog
// ─────────────────────────────────────────────────────────────────────────────

function PreviewDialog({
  dir,
  onClose,
}: {
  dir: BrowserDir
  onClose: () => void
}) {
  const [limit, setLimit] = useState(200)
  const [offset, setOffset] = useState(0)

  const { data, isLoading, isError, error, refetch } = useQuery<QueryResult>({
    queryKey: ['data-browser-preview', dir.path, limit, offset],
    queryFn: () => dataApi.previewTable(dir.path, limit, offset),
  })

  return (
    <Dialog open onClose={onClose} maxWidth="xl" fullWidth PaperProps={{ sx: { height: '85vh' } }}>
      <DialogTitle sx={{ pb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <TableChartIcon color="primary" />
        <Box sx={{ flex: 1 }}>
          <Typography fontWeight={700}>{dir.name}</Typography>
          <Typography variant="caption" color="text.secondary">
            {dir.file_count} {dir.format} file{dir.file_count !== 1 ? 's' : ''} · {fmtBytes(dir.size_bytes)}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <TextField
            label="Limit"
            type="number"
            size="small"
            value={limit}
            onChange={e => { setLimit(parseInt(e.target.value) || 200); setOffset(0) }}
            sx={{ width: 90 }}
          />
          <Tooltip title="Refresh">
            <IconButton size="small" onClick={() => refetch()}><Refresh /></IconButton>
          </Tooltip>
        </Box>
      </DialogTitle>

      <DialogContent sx={{ p: 0, display: 'flex', flexDirection: 'column' }}>
        {isLoading && <LinearProgress />}
        {isError && <Alert severity="error" sx={{ m: 2 }}>{String(error)}</Alert>}

        {data && (
          <>
            <Box sx={{ px: 2, py: 0.75, bgcolor: 'action.hover', borderBottom: '1px solid', borderColor: 'divider', display: 'flex', gap: 2 }}>
              <Typography variant="caption" color="text.secondary">
                Showing {offset + 1}–{Math.min(offset + data.rows.length, offset + limit)} of {(data as unknown as { total_rows?: number }).total_rows?.toLocaleString() ?? '?'} rows
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {data.columns.length} columns
              </Typography>
            </Box>
            <TableContainer sx={{ flex: 1, overflow: 'auto' }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    {data.columns.map(c => (
                      <TableCell key={c} sx={{ fontWeight: 700, fontSize: '0.72rem', whiteSpace: 'nowrap', bgcolor: 'background.paper' }}>{c}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.rows.map((row, ri) => (
                    <TableRow key={ri} hover>
                      {(row as unknown[]).map((cell, ci) => (
                        <TableCell
                          key={ci}
                          sx={{
                            fontSize: '0.72rem',
                            fontFamily: typeof cell === 'number' ? 'monospace' : undefined,
                            whiteSpace: 'nowrap',
                            maxWidth: 220,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {cell === null || cell === undefined
                            ? <Typography component="span" color="text.disabled" fontSize="0.68rem">null</Typography>
                            : String(cell)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            {/* Pagination */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1, borderTop: '1px solid', borderColor: 'divider' }}>
              <Button size="small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
                Previous
              </Button>
              <Button
                size="small"
                disabled={data.rows.length < limit}
                onClick={() => setOffset(offset + limit)}
              >
                Next
              </Button>
              <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                Page {Math.floor(offset / limit) + 1}
              </Typography>
            </Box>
          </>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function DataBrowser() {
  const [search, setSearch] = useState('')
  const [previewDir, setPreviewDir] = useState<BrowserDir | null>(null)

  const { data: dirs = [], isLoading, refetch } = useQuery({
    queryKey: ['data-browser'],
    queryFn: dataApi.listBrowser,
    refetchInterval: 30_000,
  })

  const filtered = dirs.filter(d =>
    !search || d.name.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <FolderOpen color="primary" />
          <Typography variant="h5" fontWeight={700}>Data Browser</Typography>
          <Chip label={dirs.length} size="small" />
        </Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <TextField
            size="small"
            placeholder="Search directories…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start"><Search sx={{ fontSize: 18 }} /></InputAdornment> }}
            sx={{ width: 220 }}
          />
          <Tooltip title="Refresh">
            <IconButton onClick={() => refetch()}><Refresh /></IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Parquet and CSV files extracted to <code>data/pipeline/parquet/</code>.
      </Typography>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
          <CircularProgress />
        </Box>
      ) : filtered.length === 0 ? (
        <Paper sx={{ p: 6, textAlign: 'center' }}>
          <FolderOpen sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
          <Typography color="text.secondary">
            {search ? 'No matching directories.' : 'No extracted data yet. Run an extraction to see files here.'}
          </Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Directory</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Format</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="right">Files</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="right">Size</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Last Modified</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map(dir => (
                <TableRow key={dir.path} hover>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <FolderOpen sx={{ fontSize: 16, color: 'text.secondary' }} />
                      <Typography variant="body2" fontWeight={600} fontFamily="monospace" fontSize="0.78rem">
                        {dir.name}
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={dir.format.toUpperCase()}
                      size="small"
                      color={dir.format === 'parquet' ? 'primary' : 'default'}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" fontFamily="monospace" fontSize="0.78rem">{dir.file_count}</Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" fontFamily="monospace" fontSize="0.78rem">{fmtBytes(dir.size_bytes)}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" fontSize="0.78rem" color="text.secondary">{fmtDate(dir.last_modified)}</Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Preview data">
                      <IconButton size="small" onClick={() => setPreviewDir(dir)}>
                        <Visibility sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {previewDir && (
        <PreviewDialog dir={previewDir} onClose={() => setPreviewDir(null)} />
      )}
    </Box>
  )
}
