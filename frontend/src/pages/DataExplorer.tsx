import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Box, Typography, Card, CardContent, Grid, Button, TextField, CircularProgress,
  Table, TableHead, TableBody, TableRow, TableCell, Chip, alpha, useTheme,
  Tooltip, IconButton, Alert, Paper, Collapse, LinearProgress, Divider,
  List, ListItemButton, ListItemIcon, ListItemText,
  Tab, Tabs, Badge, InputAdornment, Popover, Checkbox,
  Dialog, DialogTitle, DialogContent, DialogActions, DialogContentText,
} from '@mui/material'
import {
  PlayArrow, Refresh, Storage, ExpandMore, Code, TableChart,
  FolderOpen, Folder, TableView, Visibility, DeleteOutline, DeleteSweep, PlaylistRemove,
  OpenInNew, CalendarMonth, CheckBox, CheckBoxOutlineBlank, IndeterminateCheckBox,
  ChevronLeft, ChevronRight, ArrowUpward, UnfoldMore, Close, FilterAlt,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { dataApi, DataTable, CatalogTable, FilePreviewResult } from '../api/client'
import { formatDistanceToNow } from 'date-fns'
import { parseApiDate } from '../utils/dates'
import { useSnackbar } from 'notistack'

const SAMPLE_QUERIES = [
  { label: 'Show Tables', sql: 'SHOW TABLES' },
  { label: 'Count by Status', sql: 'SELECT status, COUNT(*) as count\nFROM your_table\nGROUP BY status\nORDER BY count DESC' },
  { label: 'Recent Records', sql: 'SELECT *\nFROM your_table\nORDER BY created_at DESC\nLIMIT 100' },
  { label: 'By App & Date', sql: "SELECT application_id, date, COUNT(*) as records\nFROM your_table\nGROUP BY application_id, date\nORDER BY date DESC" },
]

function fmtBytes(b: number) {
  if (b > 1e9) return `${(b / 1e9).toFixed(2)} GB`
  if (b > 1e6) return `${(b / 1e6).toFixed(2)} MB`
  return `${(b / 1e3).toFixed(0)} KB`
}

function FileTableCard({ table, selected, onToggle, onDelete }: { table: DataTable; selected: boolean; onToggle: () => void; onDelete: () => void }) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)

  return (
    <Card variant="outlined" sx={{ mb: 0.75, borderColor: selected ? 'primary.main' : 'divider', bgcolor: selected ? alpha(theme.palette.primary.main, 0.04) : undefined }}>
      <CardContent sx={{ pb: '10px !important', pt: 1.25, px: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <IconButton size="small" onClick={onToggle} sx={{ p: 0.25 }}>
            {selected ? <CheckBox sx={{ fontSize: 16, color: 'primary.main' }} /> : <CheckBoxOutlineBlank sx={{ fontSize: 16, color: 'text.disabled' }} />}
          </IconButton>
          <Storage sx={{ color: 'primary.main', fontSize: 18, flexShrink: 0 }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" fontWeight={600} noWrap sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.78rem' }}>
              {table.name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {fmtBytes(table.size_bytes)} · {table.format.toUpperCase()}
              {table.last_modified && ` · ${formatDistanceToNow(parseApiDate(table.last_modified), { addSuffix: true })}`}
            </Typography>
          </Box>
          <Tooltip title="Delete">
            <IconButton size="small" color="error" onClick={onDelete} sx={{ p: 0.25 }}>
              <DeleteOutline sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
          <IconButton size="small" onClick={() => setExpanded((e) => !e)} sx={{ p: 0.25 }}>
            <ExpandMore sx={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: '0.2s', fontSize: 16 }} />
          </IconButton>
        </Box>
        <Collapse in={expanded}>
          <Divider sx={{ my: 1 }} />
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
            {table.partitions.map((p) => (
              <Chip key={p} label={p} size="small" variant="outlined" sx={{ fontSize: '0.68rem' }} />
            ))}
            {table.row_count != null && (
              <Chip label={`${table.row_count.toLocaleString()} rows`} size="small" color="primary" variant="outlined" sx={{ fontSize: '0.68rem' }} />
            )}
          </Box>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: '"JetBrains Mono", monospace', wordBreak: 'break-all', fontSize: '0.68rem' }}>
            {table.path}
          </Typography>
        </Collapse>
      </CardContent>
    </Card>
  )
}

function CatalogTree({
  tables,
  loading,
  onSelect,
  selected,
  onDeleteTable,
  onDeleteDb,
  onClearDb,
  expandedNodes,
  onToggleNode,
}: {
  tables: CatalogTable[]
  loading: boolean
  onSelect: (t: CatalogTable) => void
  selected: CatalogTable | null
  onDeleteTable: (db: string, table: string) => void
  onDeleteDb: (db: string) => void
  onClearDb: (db: string) => void
  expandedNodes: Set<string>
  onToggleNode: (key: string) => void
}) {
  const theme = useTheme()

  const grouped: Record<string, CatalogTable[]> = {}
  for (const t of tables) {
    const db = t.database || 'default'
    if (!grouped[db]) grouped[db] = []
    grouped[db].push(t)
  }

  if (loading) return <LinearProgress sx={{ mx: 1, mt: 1 }} />

  if (!tables.length) {
    return (
      <Box sx={{ p: 1.5 }}>
        <Alert severity="info" sx={{ fontSize: '0.75rem' }}>
          No catalog tables. Run an ETL pipeline with <strong>Spark Table</strong> target to register one.
        </Alert>
      </Box>
    )
  }

  const SectionNode = ({ nodeKey, label, count, icon, children }: { nodeKey: string; label: string; count: number; icon: React.ReactNode; children: React.ReactNode }) => {
    const isOpen = expandedNodes.has(nodeKey)
    return (
      <Box>
        <Box
          onClick={() => onToggleNode(nodeKey)}
          sx={{
            display: 'flex', alignItems: 'center',
            py: 0.375, pl: 2.5, pr: 0.5,
            cursor: 'pointer',
            borderBottom: `1px solid ${theme.palette.divider}`,
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          <ExpandMore sx={{
            fontSize: 13, mr: 0.25, flexShrink: 0, color: 'text.disabled',
            transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.15s',
          }} />
          {icon}
          <Typography variant="caption" sx={{ flex: 1, fontSize: '0.7rem', fontWeight: 600, color: 'text.secondary', ml: 0.5 }}>
            {label}
          </Typography>
          <Chip label={count} size="small" sx={{ fontSize: '0.58rem', height: 13, mr: 0.25, flexShrink: 0 }} />
        </Box>
        <Collapse in={isOpen}>
          {children}
        </Collapse>
      </Box>
    )
  }

  return (
    <Box>
      {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([db, items]) => {
        const isExpanded = expandedNodes.has(`db:${db}`)
        const permanentTables = items.filter((t) => !t.is_temporary)
        const views = items.filter((t) => t.is_temporary)
        return (
          <Box key={db}>
            {/* Database row */}
            <Box
              onClick={() => onToggleNode(`db:${db}`)}
              sx={{
                display: 'flex', alignItems: 'center',
                py: 0.5, px: 0.75,
                cursor: 'pointer',
                bgcolor: alpha(theme.palette.primary.main, 0.04),
                borderBottom: `1px solid ${theme.palette.divider}`,
                '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.08) },
                '&:hover .db-actions': { opacity: 1 },
              }}
            >
              <ExpandMore sx={{
                fontSize: 15, mr: 0.25, flexShrink: 0, color: 'text.secondary',
                transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 0.15s',
              }} />
              {isExpanded
                ? <FolderOpen sx={{ fontSize: 15, color: 'primary.main', mr: 0.5, flexShrink: 0 }} />
                : <Folder sx={{ fontSize: 15, color: 'text.secondary', mr: 0.5, flexShrink: 0 }} />
              }
              <Typography variant="caption" noWrap
                sx={{ flex: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: '0.76rem', fontWeight: 600 }}>
                {db}
              </Typography>
              <Chip label={items.length} size="small" sx={{ fontSize: '0.6rem', height: 14, mr: 0.5, flexShrink: 0 }} />
              <Box className="db-actions" sx={{ display: 'flex', opacity: 0, transition: 'opacity 0.15s', gap: 0.125 }}>
                <Tooltip title="Clear tables (keep database)">
                  <IconButton size="small" color="warning" onClick={(e) => { e.stopPropagation(); onClearDb(db) }} sx={{ p: 0.125 }}>
                    <PlaylistRemove sx={{ fontSize: 13 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Drop database (CASCADE)">
                  <IconButton size="small" color="error" onClick={(e) => { e.stopPropagation(); onDeleteDb(db) }} sx={{ p: 0.125 }}>
                    <DeleteSweep sx={{ fontSize: 13 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>

            <Collapse in={isExpanded}>
              {permanentTables.length > 0 && (
                <SectionNode
                  nodeKey={`sec:${db}:tables`}
                  label="Tables"
                  count={permanentTables.length}
                  icon={<TableView sx={{ fontSize: 12, color: 'primary.main', flexShrink: 0 }} />}
                >
                  {permanentTables.map((t) => (
                    <ListItemButton
                      key={t.name}
                      selected={selected?.name === t.name && selected?.database === t.database}
                      onClick={() => onSelect(t)}
                      sx={{ py: 0.375, pl: 4.5, pr: 0.5, '&:hover .del-btn': { opacity: 1 } }}
                    >
                      <TableView sx={{ fontSize: 13, color: 'primary.main', mr: 0.75, flexShrink: 0 }} />
                      <Typography variant="caption" noWrap
                        sx={{ flex: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: '0.74rem' }}>
                        {t.name}
                      </Typography>
                      <IconButton size="small" className="del-btn" color="error"
                        sx={{ p: 0.125, opacity: 0, transition: 'opacity 0.15s', flexShrink: 0 }}
                        onClick={(e) => { e.stopPropagation(); onDeleteTable(db, t.name) }}>
                        <DeleteOutline sx={{ fontSize: 13 }} />
                      </IconButton>
                    </ListItemButton>
                  ))}
                </SectionNode>
              )}
              {views.length > 0 && (
                <SectionNode
                  nodeKey={`sec:${db}:views`}
                  label="Views"
                  count={views.length}
                  icon={<Visibility sx={{ fontSize: 12, color: 'warning.main', flexShrink: 0 }} />}
                >
                  {views.map((t) => (
                    <ListItemButton
                      key={t.name}
                      selected={selected?.name === t.name && selected?.database === t.database}
                      onClick={() => onSelect(t)}
                      sx={{ py: 0.375, pl: 4.5, pr: 0.5, '&:hover .del-btn': { opacity: 1 } }}
                    >
                      <Visibility sx={{ fontSize: 13, color: 'warning.main', mr: 0.75, flexShrink: 0 }} />
                      <Typography variant="caption" noWrap
                        sx={{ flex: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: '0.74rem' }}>
                        {t.name}
                      </Typography>
                      <IconButton size="small" className="del-btn" color="error"
                        sx={{ p: 0.125, opacity: 0, transition: 'opacity 0.15s', flexShrink: 0 }}
                        onClick={(e) => { e.stopPropagation(); onDeleteTable(db, t.name) }}>
                        <DeleteOutline sx={{ fontSize: 13 }} />
                      </IconButton>
                    </ListItemButton>
                  ))}
                </SectionNode>
              )}
            </Collapse>
          </Box>
        )
      })}
    </Box>
  )
}

// ── Parse a DB name like "markets_20260414" → "Apr 14 2026" for display
function parseDbDate(db: string): string | null {
  const m = db.match(/(\d{4})(\d{2})(\d{2})$/)
  if (!m) return null
  const [, y, mo, d] = m
  try {
    return new Date(`${y}-${mo}-${d}`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return null
  }
}

function LoadExtractedDataDialog({
  open, onClose, initialDb, catalogTables, onLoad,
}: {
  open: boolean
  onClose: () => void
  initialDb: string
  catalogTables: CatalogTable[]
  onLoad: (t: CatalogTable) => void
}) {
  const theme = useTheme()
  const [selectedDb, setSelectedDb] = useState(initialDb)
  const [selectedTable, setSelectedTable] = useState<CatalogTable | null>(null)

  useEffect(() => { setSelectedDb(initialDb); setSelectedTable(null) }, [initialDb, open])

  const grouped: Record<string, CatalogTable[]> = {}
  for (const t of catalogTables) {
    const db = t.database || 'default'
    if (!grouped[db]) grouped[db] = []
    grouped[db].push(t)
  }
  const databases = Object.keys(grouped).sort()
  const tablesInDb = selectedDb ? (grouped[selectedDb] ?? []) : []

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CalendarMonth color="primary" />
          Load Extracted Data
        </Box>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Grid container sx={{ minHeight: 400 }}>
          {/* Left: database list */}
          <Grid item xs={5} sx={{ borderRight: `1px solid ${theme.palette.divider}` }}>
            <Box sx={{ p: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
              <Typography variant="caption" color="text.secondary" fontWeight={600}>
                DATABASES ({databases.length})
              </Typography>
            </Box>
            {databases.length === 0 ? (
              <Box sx={{ p: 2 }}>
                <Alert severity="info" sx={{ fontSize: '0.78rem' }}>No Spark databases found.</Alert>
              </Box>
            ) : (
              <List dense disablePadding>
                {databases.map((db) => {
                  const parsedDate = parseDbDate(db)
                  return (
                    <ListItemButton
                      key={db}
                      selected={selectedDb === db}
                      onClick={() => { setSelectedDb(db); setSelectedTable(null) }}
                      sx={{ py: 1, px: 1.5 }}
                    >
                      <ListItemIcon sx={{ minWidth: 28 }}>
                        <FolderOpen sx={{ fontSize: 16, color: selectedDb === db ? 'primary.main' : 'text.secondary' }} />
                      </ListItemIcon>
                      <ListItemText
                        primary={db}
                        secondary={parsedDate ?? undefined}
                        primaryTypographyProps={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.78rem', fontWeight: selectedDb === db ? 600 : 400 }}
                        secondaryTypographyProps={{ fontSize: '0.68rem' }}
                      />
                      <Chip label={grouped[db].length} size="small" sx={{ fontSize: '0.62rem', height: 16 }} />
                    </ListItemButton>
                  )
                })}
              </List>
            )}
          </Grid>

          {/* Right: tables in selected database */}
          <Grid item xs={7}>
            <Box sx={{ p: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
              <Typography variant="caption" color="text.secondary" fontWeight={600}>
                {selectedDb ? `TABLES IN ${selectedDb}` : 'SELECT A DATABASE'}
              </Typography>
            </Box>
            {!selectedDb ? (
              <Box sx={{ p: 3, textAlign: 'center' }}>
                <FolderOpen sx={{ fontSize: 40, color: 'text.disabled', mb: 1 }} />
                <Typography variant="body2" color="text.secondary">Select a database on the left</Typography>
              </Box>
            ) : tablesInDb.length === 0 ? (
              <Box sx={{ p: 2 }}>
                <Alert severity="info" sx={{ fontSize: '0.78rem' }}>No tables in this database.</Alert>
              </Box>
            ) : (
              <List dense disablePadding>
                {tablesInDb.map((t) => (
                  <ListItemButton
                    key={t.name}
                    selected={selectedTable?.name === t.name}
                    onClick={() => setSelectedTable(t)}
                    sx={{ py: 0.75, px: 2 }}
                  >
                    <ListItemIcon sx={{ minWidth: 28 }}>
                      <TableView sx={{ fontSize: 16, color: t.is_temporary ? 'warning.main' : 'primary.main' }} />
                    </ListItemIcon>
                    <ListItemText
                      primary={t.name}
                      primaryTypographyProps={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.8rem' }}
                    />
                    {t.is_temporary && (
                      <Chip label="temp" size="small" color="warning" variant="outlined" sx={{ fontSize: '0.62rem', height: 16 }} />
                    )}
                  </ListItemButton>
                ))}
              </List>
            )}
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!selectedTable}
          startIcon={<Visibility />}
          onClick={() => selectedTable && onLoad(selectedTable)}
        >
          Load & Preview
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default function DataExplorer() {
  const theme = useTheme()
  const { enqueueSnackbar } = useSnackbar()
  const qc = useQueryClient()
  const [searchParams] = useSearchParams()

  const [sql, setSql] = useState('SELECT 1 AS test')
  const [limit] = useState(500)
  const [resultPage, setResultPage] = useState(0)
  const [lastQuery, setLastQuery] = useState<{ sql: string; database?: string } | null>(null)
  const [browserTab, setBrowserTab] = useState(0)
  const [selectedCatalogTable, setSelectedCatalogTable] = useState<CatalogTable | null>(null)
  const [dbFilter, setDbFilter] = useState<string>('')
  const [activeDb, setActiveDb] = useState<string>('')  // database context for SQL execution
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'table' | 'database' | 'clear-tables'; db: string; table?: string } | null>(null)
  const [loadDialogOpen, setLoadDialogOpen] = useState(false)
  const [loadDialogDb, setLoadDialogDb] = useState<string>('')
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [fileDeleteConfirm, setFileDeleteConfirm] = useState<string[] | null>(null)  // names to delete
  const [olderThanDays, setOlderThanDays] = useState<number>(30)
  const [browserOpen, setBrowserOpen] = useState(() => localStorage.getItem('data_browser_open') !== 'false')
  const [editorOpen, setEditorOpen] = useState(true)
  const [tableFilter, setTableFilter] = useState('')
  const [fileFilter, setFileFilter] = useState('')
  const [expandedCatalogNodes, setExpandedCatalogNodes] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('de_catalog_expanded')
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
    } catch { return new Set() }
  })
  const toggleCatalogNode = useCallback((key: string) => {
    setExpandedCatalogNodes((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      localStorage.setItem('de_catalog_expanded', JSON.stringify([...next]))
      return next
    })
  }, [])
  // Results sort/search/filter
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [rowSearch, setRowSearch] = useState('')
  const [colFilters, setColFilters] = useState<Record<number, string[]>>({})
  const [filterAnchor, setFilterAnchor] = useState<{ el: HTMLElement; col: number } | null>(null)
  const [filterSearch, setFilterSearch] = useState('')
  // Resizable panels
  const [topHeight, setTopHeight] = useState(() => Number(localStorage.getItem('de_top_h') || 240))
  const [catalogWidth, setCatalogWidth] = useState(() => Number(localStorage.getItem('de_cat_w') || 280))

  const toggleBrowser = () => setBrowserOpen((v) => {
    const next = !v
    localStorage.setItem('data_browser_open', String(next))
    return next
  })

  // Horizontal splitter: resize top section height
  const handleSplitterDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = topHeight
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(80, Math.min(startH + ev.clientY - startY, window.innerHeight - 200))
      setTopHeight(next)
      localStorage.setItem('de_top_h', String(next))
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [topHeight])

  // Vertical splitter: resize catalog panel width
  const handleCatalogResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = catalogWidth
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(160, Math.min(startW - (ev.clientX - startX), 480))
      setCatalogWidth(next)
      localStorage.setItem('de_cat_w', String(next))
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [catalogWidth])

  const { data: fileTables, isLoading: fileTablesLoading, refetch: refetchFiles } = useQuery({
    queryKey: ['data-tables'],
    queryFn: () => dataApi.tables().then((r) => r.data),
    refetchInterval: 60_000,
  })

  const { data: catalogTables, isLoading: catalogLoading, refetch: refetchCatalog } = useQuery({
    queryKey: ['catalog-tables'],
    queryFn: () => dataApi.catalog().then((r) => r.data),
    refetchInterval: 30_000,
  })

  const { refetch: refetchDatabases } = useQuery({
    queryKey: ['catalog-databases'],
    queryFn: () => dataApi.databases().then((r) => r.data),
    refetchInterval: 15_000,
  })

  // Pre-select database from URL ?db= param
  useEffect(() => {
    const db = searchParams.get('db')
    if (db) { setDbFilter(db); setActiveDb(db) }
  }, [searchParams])

  const filteredTables = (() => {
    const all = catalogTables ?? []
    if (!tableFilter) return all
    const f = tableFilter.toLowerCase()
    return all.filter((t) => t.name.toLowerCase().includes(f) || (t.database || 'default').toLowerCase().includes(f))
  })()

  const queryMutation = useMutation({
    mutationFn: ({ sql, offset, database }: { sql: string; offset: number; database?: string }) =>
      dataApi.query(sql, limit, offset, database).then((r) => r.data),
  })

  const [resultSource, setResultSource] = useState<'query' | 'file'>('query')
  const [lastFileName, setLastFileName] = useState<string | null>(null)

  const filePreviewMutation = useMutation({
    mutationFn: ({ name, offset }: { name: string; offset: number }) =>
      dataApi.previewFile(name, 200, offset).then((r) => r.data),
  })

  // Unified result regardless of source
  const activeResult = resultSource === 'file'
    ? (filePreviewMutation.data ? { ...filePreviewMutation.data, duration_ms: null as null } : undefined)
    : (queryMutation.data ? { ...queryMutation.data, total_rows: null as null, file_count: null as null, format: null as null } : undefined)
  const activeIsPending = resultSource === 'file' ? filePreviewMutation.isPending : queryMutation.isPending
  const activeIsError   = resultSource === 'file' ? filePreviewMutation.isError   : queryMutation.isError
  const activeError     = resultSource === 'file' ? filePreviewMutation.error     : queryMutation.error

  const dropTableMutation = useMutation({
    mutationFn: ({ db, table }: { db: string; table: string }) =>
      dataApi.dropTable(db, table),
    onSuccess: (_d, { db, table }) => {
      enqueueSnackbar(`Dropped table ${db}.${table}`, { variant: 'success' })
      qc.invalidateQueries({ queryKey: ['catalog-tables'] })
      if (selectedCatalogTable?.database === db && selectedCatalogTable?.name === table) {
        setSelectedCatalogTable(null)
      }
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const dropDatabaseMutation = useMutation({
    mutationFn: (db: string) => dataApi.dropDatabase(db),
    onSuccess: (_d, db) => {
      enqueueSnackbar(`Dropped database ${db}`, { variant: 'success' })
      qc.invalidateQueries({ queryKey: ['catalog-tables'] })
      qc.invalidateQueries({ queryKey: ['catalog-databases'] })
      if (dbFilter === db) setDbFilter('')
      if (activeDb === db) setActiveDb('')
      if (selectedCatalogTable?.database === db) setSelectedCatalogTable(null)
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const clearTablesMutation = useMutation({
    mutationFn: (db: string) => dataApi.clearDatabaseTables(db),
    onSuccess: (res, db) => {
      enqueueSnackbar(`Cleared ${res.data.dropped} table(s) from ${db}`, { variant: 'success' })
      qc.invalidateQueries({ queryKey: ['catalog-tables'] })
      if (selectedCatalogTable?.database === db) setSelectedCatalogTable(null)
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const deleteFileTableMutation = useMutation({
    mutationFn: (name: string) => dataApi.deleteFileTable(name),
    onSuccess: (_d, name) => {
      qc.invalidateQueries({ queryKey: ['data-tables'] })
      setSelectedFiles((prev) => { const n = new Set(prev); n.delete(name); return n })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const handleDeleteFiles = async (names: string[]) => {
    setFileDeleteConfirm(null)
    for (const name of names) {
      await deleteFileTableMutation.mutateAsync(name).catch(() => {})
    }
    enqueueSnackbar(`Deleted ${names.length} file(s)`, { variant: 'success' })
    setSelectedFiles(new Set())
  }

  const handleExecute = () => {
    setResultPage(0)
    setSortCol(null); setSortDir('asc'); setRowSearch(''); setColFilters({})
    setLastQuery({ sql, database: activeDb || undefined })
    setResultSource('query')
    queryMutation.mutate({ sql, offset: 0, database: activeDb || undefined })
  }

  const handlePageChange = (newPage: number) => {
    setResultPage(newPage)
    if (resultSource === 'file' && lastFileName) {
      filePreviewMutation.mutate({ name: lastFileName, offset: newPage * 200 })
    } else if (lastQuery) {
      queryMutation.mutate({ sql: lastQuery.sql, offset: newPage * limit, database: lastQuery.database })
    }
  }

  const handlePreviewTable = (t: CatalogTable) => {
    setSelectedCatalogTable(t)
    const db = t.database || 'default'
    const fullName = `\`${t.name}\``
    setSql(`SELECT *\nFROM ${fullName}\nLIMIT 100`)
    setActiveDb(db)
    setResultPage(0)
    setSortCol(null); setSortDir('asc'); setRowSearch(''); setColFilters({})
    setResultSource('query')
    const previewSql = `SELECT * FROM ${fullName} LIMIT 100`
    setLastQuery({ sql: previewSql, database: db })
    queryMutation.mutate({ sql: previewSql, offset: 0, database: db })
  }

  const handlePreviewFile = (t: DataTable) => {
    setResultPage(0)
    setSortCol(null); setSortDir('asc'); setRowSearch(''); setColFilters({})
    setResultSource('file')
    setLastFileName(t.name)
    filePreviewMutation.mutate({ name: t.name, offset: 0 })
  }

  const handleUseTable = (t: CatalogTable) => {
    const db = t.database || 'default'
    setSql(`SELECT *\nFROM \`${t.name}\`\nLIMIT 100`)
    setActiveDb(db)
  }

  const handleConfirmDelete = () => {
    if (!deleteConfirm) return
    if (deleteConfirm.type === 'table' && deleteConfirm.table) {
      dropTableMutation.mutate({ db: deleteConfirm.db, table: deleteConfirm.table })
    } else if (deleteConfirm.type === 'database') {
      dropDatabaseMutation.mutate(deleteConfirm.db)
    } else if (deleteConfirm.type === 'clear-tables') {
      clearTablesMutation.mutate(deleteConfirm.db)
    }
    setDeleteConfirm(null)
  }

  const refetchAll = () => { refetchFiles(); refetchCatalog(); refetchDatabases() }
  const isLoading = fileTablesLoading || catalogLoading

  // Reset sort/search when query results change (but not on page navigation — page resets handled in execute/preview)
  useEffect(() => {
    // noop: resets are now handled explicitly in handleExecute and handlePreviewTable
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleColSort = (i: number) => {
    if (sortCol === i) {
      if (sortDir === 'asc') setSortDir('desc')
      else { setSortCol(null); setSortDir('asc') }
    } else {
      setSortCol(i); setSortDir('asc')
    }
  }

  const hasColFilters = Object.values(colFilters).some((v) => v.length > 0)

  const openColFilter = (e: React.MouseEvent<HTMLElement>, col: number) => {
    e.stopPropagation()
    setFilterSearch('')
    setFilterAnchor({ el: e.currentTarget, col })
  }

  const filterColValues = useMemo(() => {
    if (filterAnchor === null || !activeResult) return []
    const col = filterAnchor.col
    const seen = new Set<string>()
    const vals: string[] = []
    for (const row of activeResult.rows) {
      const v = row[col] === null ? '(null)' : String(row[col])
      if (!seen.has(v)) { seen.add(v); vals.push(v) }
    }
    return vals.sort((a, b) => a.localeCompare(b))
  }, [filterAnchor, activeResult])

  const visibleFilterValues = useMemo(() =>
    filterSearch ? filterColValues.filter((v) => v.toLowerCase().includes(filterSearch.toLowerCase())) : filterColValues,
    [filterColValues, filterSearch]
  )

  const displayRows = useMemo(() => {
    if (!activeResult) return []
    let rows = activeResult.rows
    if (rowSearch) {
      const q = rowSearch.toLowerCase()
      rows = rows.filter((row) => row.some((cell) => cell !== null && String(cell).toLowerCase().includes(q)))
    }
    const activeColFilters = Object.entries(colFilters).filter(([, v]) => v.length > 0)
    if (activeColFilters.length > 0) {
      rows = rows.filter((row) =>
        activeColFilters.every(([ci, vals]) => {
          const cell = row[Number(ci)]
          const cellStr = cell === null ? '(null)' : String(cell)
          return (vals as string[]).includes(cellStr)
        })
      )
    }
    if (sortCol !== null) {
      rows = [...rows].sort((a, b) => {
        const av = a[sortCol]; const bv = b[sortCol]
        if (av === null && bv === null) return 0
        if (av === null) return 1
        if (bv === null) return -1
        const an = Number(av); const bn = Number(bv)
        if (!isNaN(an) && !isNaN(bn)) return sortDir === 'asc' ? an - bn : bn - an
        return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
      })
    }
    return rows
  }, [activeResult, rowSearch, colFilters, sortCol, sortDir])

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 96px)', overflow: 'hidden' }}>

      {/* ── TOP ROW: SQL editor (left) + Catalog/Files browser (right) ── */}
      <Box sx={{ display: 'flex', flexShrink: 0, height: topHeight, minHeight: 80, overflow: 'hidden', gap: 0 }}>

        {/* SQL editor panel */}
        <Paper variant="outlined" sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', mr: 0, borderRight: 'none', borderRadius: '4px 0 0 4px' }}>
          <Box sx={{
            display: 'flex', alignItems: 'center', gap: 1,
            px: 1.5, py: 0.625,
            borderBottom: editorOpen ? `1px solid ${theme.palette.divider}` : 'none',
            flexShrink: 0,
          }}>
            <Code sx={{ color: 'primary.main', fontSize: 16 }} />
            <Typography variant="subtitle2" fontWeight={600} sx={{ flex: 1, fontSize: '0.83rem' }}>
              SQL
              {activeDb && (
                <Chip label={activeDb} size="small" color="primary" onDelete={() => setActiveDb('')}
                  sx={{ ml: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: '0.68rem', height: 18, verticalAlign: 'middle' }} />
              )}
            </Typography>
            <Button variant="contained" size="small"
              startIcon={queryMutation.isPending ? <CircularProgress size={13} color="inherit" /> : <PlayArrow sx={{ fontSize: 16 }} />}
              onClick={handleExecute}
              disabled={queryMutation.isPending || !sql.trim()}
            >Run</Button>
            <Tooltip title="Refresh all">
              <IconButton size="small" onClick={refetchAll} disabled={isLoading}>
                <Refresh sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title={editorOpen ? 'Collapse editor' : 'Expand editor'}>
              <IconButton size="small" onClick={() => setEditorOpen((v) => !v)}>
                <ExpandMore sx={{ transform: editorOpen ? 'rotate(180deg)' : 'none', transition: '0.2s', fontSize: 17 }} />
              </IconButton>
            </Tooltip>
          </Box>
          <Collapse in={editorOpen} sx={{ flex: 1, overflow: 'auto' }}>
            <Box sx={{ p: 1, pt: 0.75 }}>
              <Box sx={{ display: 'flex', gap: 0.5, mb: 0.75, flexWrap: 'wrap' }}>
                {SAMPLE_QUERIES.map((q) => (
                  <Chip key={q.label} label={q.label} size="small" variant="outlined"
                    onClick={() => setSql(q.sql)}
                    sx={{ cursor: 'pointer', fontSize: '0.68rem', height: 20 }}
                  />
                ))}
              </Box>
              <TextField
                multiline minRows={3} value={sql}
                onChange={(e) => setSql(e.target.value)}
                fullWidth
                placeholder="SELECT * FROM your_table LIMIT 100"
                inputProps={{ style: { fontFamily: '"JetBrains Mono", monospace', fontSize: '0.83rem' } }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleExecute() }
                }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.375, display: 'block' }}>
                Ctrl/⌘+Enter to run · SELECT, SHOW, DESCRIBE only
                {activeDb && <> · db: <strong style={{ fontFamily: 'monospace' }}>{activeDb}</strong></>}
              </Typography>
              {activeIsError && (
                <Alert severity="error" sx={{ mt: 0.75, py: 0.375, fontSize: '0.78rem' }}>{(activeError as Error).message}</Alert>
              )}
            </Box>
          </Collapse>
        </Paper>

        {/* Vertical drag handle between SQL and browser */}
        <Box
          onMouseDown={handleCatalogResizeDown}
          sx={{
            width: 5, flexShrink: 0, cursor: 'col-resize', zIndex: 10,
            bgcolor: 'divider',
            '&:hover': { bgcolor: 'primary.main' },
            transition: 'background-color 0.15s',
          }}
        />

        {/* Catalog / file browser */}
        <Paper
          variant="outlined"
          sx={{
            width: browserOpen ? catalogWidth : 40,
            flexShrink: 0,
            transition: browserOpen ? 'none' : 'width 0.2s ease',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderLeft: 'none',
            borderRadius: '0 4px 4px 0',
          }}
        >
          {/* Panel header */}
          <Box sx={{
            display: 'flex', alignItems: 'center',
            borderBottom: `1px solid ${theme.palette.divider}`,
            flexShrink: 0, minHeight: 36, px: 0.5,
          }}>
            <Tooltip title={browserOpen ? 'Collapse browser' : 'Expand browser'} placement={browserOpen ? 'bottom' : 'left'}>
              <IconButton size="small" onClick={toggleBrowser} sx={{ flexShrink: 0 }}>
                {browserOpen ? <ChevronRight sx={{ fontSize: 17 }} /> : <ChevronLeft sx={{ fontSize: 17 }} />}
              </IconButton>
            </Tooltip>
            {browserOpen ? (
              <Tabs value={browserTab} onChange={(_, v) => setBrowserTab(v)}
                sx={{ flex: 1, minHeight: 32 }}
                TabIndicatorProps={{ style: { height: 2 } }}
              >
                <Tab label={
                  <Typography variant="caption" fontWeight={600} sx={{ fontSize: '0.72rem' }}>Catalog</Typography>
                } sx={{ minHeight: 32, py: 0, px: 1 }} />
                <Tab label={
                  <Badge badgeContent={fileTables?.length ?? 0} color="default" max={99}
                    sx={{ '& .MuiBadge-badge': { fontSize: '0.58rem', height: 15, minWidth: 15 } }}>
                    <Typography variant="caption" fontWeight={600} sx={{ fontSize: '0.72rem' }}>Files</Typography>
                  </Badge>
                } sx={{ minHeight: 32, py: 0, px: 1 }} />
              </Tabs>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 0.5, gap: 0.25 }}>
                <Tooltip title="Catalog" placement="left">
                  <IconButton size="small" onClick={() => { setBrowserTab(0); toggleBrowser() }}
                    sx={{ color: browserTab === 0 ? 'primary.main' : 'text.secondary', p: 0.5 }}>
                    <TableView sx={{ fontSize: 17 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Files" placement="left">
                  <IconButton size="small" onClick={() => { setBrowserTab(1); toggleBrowser() }}
                    sx={{ color: browserTab === 1 ? 'primary.main' : 'text.secondary', p: 0.5 }}>
                    <Badge badgeContent={fileTables?.length ?? 0} color="default" max={99}
                      sx={{ '& .MuiBadge-badge': { fontSize: '0.55rem', height: 14, minWidth: 14 } }}>
                      <Storage sx={{ fontSize: 17 }} />
                    </Badge>
                  </IconButton>
                </Tooltip>
              </Box>
            )}
          </Box>

          {/* Panel content */}
          {browserOpen && (
            <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

              {/* ── Catalog tab ── */}
              {browserTab === 0 && (
                <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                  <Box sx={{ px: 0.75, py: 0.625, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', gap: 0.5, alignItems: 'center', flexShrink: 0 }}>
                    <TextField
                      size="small" placeholder="Filter…" fullWidth value={tableFilter}
                      onChange={(e) => setTableFilter(e.target.value)}
                      inputProps={{ style: { fontSize: '0.75rem', paddingTop: 4, paddingBottom: 4 } }}
                      sx={{ '& .MuiInputBase-root': { fontSize: '0.75rem' } }}
                    />
                    <Tooltip title="Load Extracted Data">
                      <IconButton size="small" color="primary"
                        onClick={() => { setLoadDialogDb(activeDb); setLoadDialogOpen(true) }}>
                        <OpenInNew sx={{ fontSize: 15 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                  <Box sx={{ flex: 1, overflow: 'auto' }}>
                    <CatalogTree
                      tables={filteredTables}
                      loading={catalogLoading}
                      selected={selectedCatalogTable}
                      onSelect={(t) => { setSelectedCatalogTable(t); handleUseTable(t) }}
                      onDeleteTable={(db, table) => setDeleteConfirm({ type: 'table', db, table })}
                      onDeleteDb={(db) => setDeleteConfirm({ type: 'database', db })}
                      onClearDb={(db) => setDeleteConfirm({ type: 'clear-tables', db })}
                      expandedNodes={expandedCatalogNodes}
                      onToggleNode={toggleCatalogNode}
                    />
                  </Box>
                  {selectedCatalogTable && (
                    <Box sx={{ px: 0.75, py: 0.625, borderTop: `1px solid ${theme.palette.divider}`, display: 'flex', gap: 0.5, flexShrink: 0 }}>
                      <Button size="small" variant="outlined" fullWidth startIcon={<TableChart sx={{ fontSize: 13 }} />}
                        sx={{ fontSize: '0.72rem', py: 0.375 }}
                        onClick={() => {
                          const db = selectedCatalogTable.database || 'default'
                          const name = selectedCatalogTable.name
                          setSql(`DESCRIBE \`${name}\``)
                          setActiveDb(db)
                          queryMutation.mutate({ sql: `DESCRIBE \`${name}\``, offset: 0, database: db })
                        }}>
                        Describe
                      </Button>
                      <Button size="small" variant="contained" fullWidth startIcon={<Visibility sx={{ fontSize: 13 }} />}
                        sx={{ fontSize: '0.72rem', py: 0.375 }}
                        onClick={() => handlePreviewTable(selectedCatalogTable)}>
                        Preview
                      </Button>
                    </Box>
                  )}
                </Box>
              )}

              {/* ── File store tab ── */}
              {browserTab === 1 && (() => {
                const files = (fileTables ?? []).filter((t) =>
                  !fileFilter || t.name.toLowerCase().includes(fileFilter.toLowerCase())
                )
                const cutoff = new Date(Date.now() - olderThanDays * 86400_000)
                const oldFiles = files.filter((t) => t.last_modified && parseApiDate(t.last_modified) < cutoff)
                const allSelected = files.length > 0 && files.every((t) => selectedFiles.has(t.name))
                const someSelected = files.some((t) => selectedFiles.has(t.name))
                const selectedNames = [...selectedFiles]
                const totalSize = files.reduce((s, t) => s + t.size_bytes, 0)
                const selectedSize = files.filter((t) => selectedFiles.has(t.name)).reduce((s, t) => s + t.size_bytes, 0)
                return (
                  <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <Box sx={{ px: 0.75, py: 0.5, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
                      <TextField
                        size="small" placeholder="Filter…" value={fileFilter}
                        onChange={(e) => setFileFilter(e.target.value)}
                        sx={{ flex: 1, '& .MuiInputBase-root': { fontSize: '0.75rem' } }}
                        inputProps={{ style: { fontSize: '0.75rem', paddingTop: 4, paddingBottom: 4 } }}
                      />
                    </Box>
                    <Box sx={{ px: 0.75, py: 0.5, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
                      <IconButton size="small" sx={{ p: 0.25 }} onClick={() => {
                        if (allSelected) setSelectedFiles(new Set())
                        else setSelectedFiles(new Set(files.map((t) => t.name)))
                      }}>
                        {allSelected ? <CheckBox sx={{ fontSize: 15, color: 'primary.main' }} />
                          : someSelected ? <IndeterminateCheckBox sx={{ fontSize: 15, color: 'primary.main' }} />
                          : <CheckBoxOutlineBlank sx={{ fontSize: 15, color: 'text.disabled' }} />}
                      </IconButton>
                      <Typography variant="caption" color="text.secondary" sx={{ flex: 1, fontSize: '0.7rem' }}>
                        {files.length} file{files.length !== 1 ? 's' : ''} · {fmtBytes(totalSize)}
                        {someSelected && ` · ${selectedNames.length} sel (${fmtBytes(selectedSize)})`}
                      </Typography>
                      {someSelected && (
                        <Button size="small" color="error" variant="outlined"
                          sx={{ fontSize: '0.68rem', py: 0.25, px: 0.75, minWidth: 0 }}
                          onClick={() => setFileDeleteConfirm(selectedNames)}>
                          Del {selectedNames.length}
                        </Button>
                      )}
                    </Box>
                    <Box sx={{ flex: 1, overflow: 'auto' }}>
                      {fileTablesLoading ? <LinearProgress sx={{ mx: 1, mt: 1 }} /> : files.length === 0 ? (
                        <Box sx={{ p: 1.5 }}>
                          <Alert severity="info" sx={{ fontSize: '0.75rem' }}>No stored files yet.</Alert>
                        </Box>
                      ) : (
                        files.map((t) => (
                          <Box key={t.name} sx={{
                            display: 'flex', alignItems: 'center',
                            px: 0.75, py: 0.375,
                            '&:hover': { bgcolor: 'action.hover' },
                            '&:hover .file-actions': { opacity: 1 },
                            borderBottom: `1px solid ${theme.palette.divider}`,
                          }}>
                            <IconButton size="small" sx={{ p: 0.125, mr: 0.5, flexShrink: 0 }}
                              onClick={() => setSelectedFiles((prev) => { const n = new Set(prev); n.has(t.name) ? n.delete(t.name) : n.add(t.name); return n })}>
                              {selectedFiles.has(t.name)
                                ? <CheckBox sx={{ fontSize: 14, color: 'primary.main' }} />
                                : <CheckBoxOutlineBlank sx={{ fontSize: 14, color: 'text.disabled' }} />}
                            </IconButton>
                            <Storage sx={{ fontSize: 13, color: 'text.secondary', mr: 0.5, flexShrink: 0 }} />
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <Typography variant="caption" noWrap sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.73rem', display: 'block', fontWeight: 500 }}>
                                {t.name}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.63rem' }}>
                                {fmtBytes(t.size_bytes)} · {t.format.toUpperCase()}
                                {t.last_modified && ` · ${formatDistanceToNow(parseApiDate(t.last_modified), { addSuffix: true })}`}
                              </Typography>
                            </Box>
                            <IconButton size="small" className="file-actions" color="primary"
                              sx={{ p: 0.125, opacity: 0, transition: 'opacity 0.15s', flexShrink: 0 }}
                              onClick={() => handlePreviewFile(t)}>
                              <Visibility sx={{ fontSize: 13 }} />
                            </IconButton>
                            <IconButton size="small" className="file-actions" color="error"
                              sx={{ p: 0.125, opacity: 0, transition: 'opacity 0.15s', flexShrink: 0 }}
                              onClick={() => setFileDeleteConfirm([t.name])}>
                              <DeleteOutline sx={{ fontSize: 13 }} />
                            </IconButton>
                          </Box>
                        ))
                      )}
                    </Box>
                    {oldFiles.length > 0 && (
                      <Box sx={{ px: 0.75, py: 0.5, borderTop: `1px solid ${theme.palette.divider}`, display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0, flexWrap: 'wrap' }}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.68rem' }}>
                          {oldFiles.length} older than
                        </Typography>
                        <TextField size="small" type="number" value={olderThanDays}
                          onChange={(e) => setOlderThanDays(Math.max(1, Number(e.target.value)))}
                          inputProps={{ min: 1, style: { width: 32, padding: '2px 4px', fontSize: '0.72rem' } }}
                          sx={{ '& .MuiInputBase-root': { fontSize: '0.72rem' } }}
                        />
                        <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.68rem' }}>d</Typography>
                        <Button size="small" color="warning" variant="outlined"
                          startIcon={<DeleteSweep sx={{ fontSize: 13 }} />}
                          sx={{ fontSize: '0.68rem', py: 0.25, px: 0.75 }}
                          onClick={() => setFileDeleteConfirm(oldFiles.map((t) => t.name))}>
                          Delete old
                        </Button>
                      </Box>
                    )}
                  </Box>
                )
              })()}
            </Box>
          )}
        </Paper>
      </Box>

      {/* ── Horizontal drag handle — resize top/results split ── */}
      <Box
        onMouseDown={handleSplitterDown}
        sx={{
          height: 5, flexShrink: 0, cursor: 'row-resize', zIndex: 10,
          bgcolor: 'divider',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          '&:hover': { bgcolor: 'primary.main' },
          transition: 'background-color 0.15s',
        }}
      />

      {/* ── RESULTS — truly full width ── */}
      <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {activeIsPending ? (
          <Paper variant="outlined" sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CircularProgress size={28} />
          </Paper>
        ) : activeResult ? (
          <Paper variant="outlined" sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Box sx={{
              display: 'flex', alignItems: 'center', gap: 1,
              px: 1.5, py: 0.5,
              borderBottom: `1px solid ${theme.palette.divider}`,
              flexShrink: 0,
            }}>
              <TableChart sx={{ fontSize: 15, color: 'primary.main' }} />
              <Typography variant="subtitle2" fontWeight={600} sx={{ fontSize: '0.83rem' }}>Results</Typography>
              <Typography variant="caption" color="text.secondary">
                {(() => {
                  const pageSize = resultSource === 'file' ? 200 : limit
                  const base = resultPage * pageSize
                  const filtered = displayRows.length !== activeResult.row_count
                  const showing = `${(base + 1).toLocaleString()}–${(base + activeResult.row_count).toLocaleString()}`
                  const suffix = resultSource === 'file'
                    ? `pandas · ${(activeResult as FilePreviewResult).file_count} file(s)`
                    : `${(activeResult as { duration_ms: number }).duration_ms.toFixed(0)}ms`
                  return filtered
                    ? `${displayRows.length} / ${activeResult.row_count.toLocaleString()} filtered · ${suffix}`
                    : `rows ${showing} · ${suffix}`
                })()}
              </Typography>
              {hasColFilters && (
                <Tooltip title="Clear column filters">
                  <IconButton size="small" color="warning" sx={{ p: 0.375 }} onClick={() => setColFilters({})}>
                    <Close sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
              )}
              <Box sx={{ flex: 1 }} />
              <Tooltip title="Previous page">
                <span>
                  <IconButton size="small" disabled={resultPage === 0 || activeIsPending} onClick={() => handlePageChange(resultPage - 1)} sx={{ p: 0.375 }}>
                    <ChevronLeft sx={{ fontSize: 16 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Typography variant="caption" sx={{ fontSize: '0.72rem', minWidth: 52, textAlign: 'center' }}>
                Page {resultPage + 1}
              </Typography>
              <Tooltip title="Next page">
                <span>
                  <IconButton size="small" disabled={!activeResult.truncated || activeIsPending} onClick={() => handlePageChange(resultPage + 1)} sx={{ p: 0.375 }}>
                    <ChevronRight sx={{ fontSize: 16 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <TextField
                size="small"
                placeholder="filter rows…"
                value={rowSearch}
                onChange={(e) => setRowSearch(e.target.value)}
                sx={{ width: 180, '& .MuiInputBase-root': { fontSize: '0.75rem' } }}
                inputProps={{ style: { paddingTop: 4, paddingBottom: 4 } }}
                InputProps={{
                  endAdornment: rowSearch ? (
                    <InputAdornment position="end">
                      <IconButton size="small" onClick={() => setRowSearch('')} sx={{ p: 0.125 }}>
                        <Close sx={{ fontSize: 14 }} />
                      </IconButton>
                    </InputAdornment>
                  ) : undefined,
                }}
              />
            </Box>
            <Box sx={{ flex: 1, overflow: 'auto' }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ whiteSpace: 'nowrap', fontSize: '0.7rem', fontWeight: 600, color: 'text.disabled', width: 44, minWidth: 44, py: 0.625 }}>#</TableCell>
                    {activeResult.columns.map((col, i) => {
                      const active = sortCol === i
                      const filtered = !!colFilters[i]
                      return (
                        <TableCell key={col}
                          sx={{
                            whiteSpace: 'nowrap', fontFamily: '"JetBrains Mono", monospace',
                            fontSize: '0.72rem', fontWeight: 600, py: 0.625, px: 0.75,
                            userSelect: 'none',
                            bgcolor: filtered ? alpha(theme.palette.warning.main, 0.07) : undefined,
                            '&:hover .sort-icon-idle': { opacity: 0.4 },
                          }}
                        >
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                            <Box onClick={() => handleColSort(i)} sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flex: 1, cursor: 'pointer', '&:hover': { color: 'primary.main' } }}>
                              {col}
                              {active
                                ? <ArrowUpward sx={{ fontSize: 12, color: 'primary.main', transform: sortDir === 'desc' ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                                : <UnfoldMore className="sort-icon-idle" sx={{ fontSize: 12, color: 'text.disabled', opacity: 0, transition: 'opacity 0.15s' }} />
                              }
                            </Box>
                            <IconButton size="small" sx={{ p: 0.125, ml: 0.25, opacity: filtered ? 1 : 0.3, '&:hover': { opacity: 1 } }}
                              onClick={(e) => openColFilter(e, i)}
                            >
                              <FilterAlt sx={{ fontSize: 12, color: filtered ? 'warning.main' : 'text.secondary' }} />
                            </IconButton>
                          </Box>
                        </TableCell>
                      )
                    })}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {displayRows.map((row, i) => (
                    <TableRow key={i} sx={{ '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.04) } }}>
                      <TableCell sx={{ fontSize: '0.68rem', color: 'text.disabled', userSelect: 'none', width: 44, minWidth: 44, py: 0.375 }}>{resultPage * limit + i + 1}</TableCell>
                      {row.map((cell, j) => (
                        <TableCell key={j} sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.75rem', whiteSpace: 'nowrap', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', py: 0.375 }}>
                          {cell === null ? <span style={{ color: theme.palette.text.disabled }}>(null)</span> : String(cell)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
            {filterAnchor !== null && (() => {
              const col = filterAnchor.col
              const selected = colFilters[col] || []
              const allVisible = visibleFilterValues.length > 0 && visibleFilterValues.every((v) => selected.includes(v))
              const someVisible = visibleFilterValues.some((v) => selected.includes(v))
              const toggleVal = (v: string) => setColFilters((prev) => {
                const cur = prev[col] || []
                const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
                if (next.length === 0) { const n = { ...prev }; delete n[col]; return n }
                return { ...prev, [col]: next }
              })
              const toggleAll = () => {
                if (allVisible) {
                  setColFilters((prev) => {
                    const cur = prev[col] || []
                    const remaining = cur.filter((v) => !visibleFilterValues.includes(v))
                    if (remaining.length === 0) { const n = { ...prev }; delete n[col]; return n }
                    return { ...prev, [col]: remaining }
                  })
                } else {
                  setColFilters((prev) => {
                    const cur = prev[col] || []
                    const merged = Array.from(new Set([...cur, ...visibleFilterValues]))
                    return { ...prev, [col]: merged }
                  })
                }
              }
              return (
                <Popover
                  key="col-filter-popover"
                  open
                  anchorEl={filterAnchor.el}
                  onClose={() => setFilterAnchor(null)}
                  anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                  transformOrigin={{ vertical: 'top', horizontal: 'left' }}
                  PaperProps={{ sx: { width: 240, display: 'flex', flexDirection: 'column', maxHeight: 320 } }}
                >
                  <Box sx={{ p: 1, borderBottom: `1px solid ${theme.palette.divider}`, flexShrink: 0 }}>
                    <TextField
                      size="small" autoFocus fullWidth
                      placeholder="Search values…"
                      value={filterSearch}
                      onChange={(e) => setFilterSearch(e.target.value)}
                      sx={{ '& .MuiInputBase-root': { fontSize: '0.75rem' } }}
                      inputProps={{ style: { paddingTop: 5, paddingBottom: 5 } }}
                      InputProps={filterSearch ? {
                        endAdornment: (
                          <InputAdornment position="end">
                            <IconButton size="small" onClick={() => setFilterSearch('')} sx={{ p: 0.25 }}>
                              <Close sx={{ fontSize: 13 }} />
                            </IconButton>
                          </InputAdornment>
                        ),
                      } : undefined}
                    />
                  </Box>
                  {filterColValues.length > 1 && (
                    <Box sx={{ px: 0.75, py: 0.5, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                      <Checkbox size="small"
                        indeterminate={someVisible && !allVisible}
                        checked={allVisible}
                        onChange={toggleAll}
                        sx={{ p: 0.25 }}
                      />
                      <Typography variant="caption" sx={{ flex: 1, fontSize: '0.72rem', color: 'text.secondary' }}>
                        {selected.length > 0 ? `${selected.length} of ${filterColValues.length} selected` : 'Select all'}
                      </Typography>
                      {selected.length > 0 && (
                        <Tooltip title="Clear filter">
                          <IconButton size="small" sx={{ p: 0.25 }}
                            onClick={() => setColFilters((prev) => { const n = { ...prev }; delete n[col]; return n })}>
                            <Close sx={{ fontSize: 13 }} />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Box>
                  )}
                  <Box sx={{ overflow: 'auto', flex: 1 }}>
                    {visibleFilterValues.map((v) => (
                      <Box key={v} onClick={() => toggleVal(v)}
                        sx={{ display: 'flex', alignItems: 'center', px: 0.5, cursor: 'pointer', '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.06) } }}>
                        <Checkbox size="small" checked={selected.includes(v)} onChange={() => toggleVal(v)}
                          onClick={(e) => e.stopPropagation()} sx={{ p: 0.25 }} />
                        <Typography variant="caption"
                          sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.72rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {v}
                        </Typography>
                      </Box>
                    ))}
                    {visibleFilterValues.length === 0 && (
                      <Typography variant="caption" sx={{ display: 'block', p: 1.5, color: 'text.disabled', textAlign: 'center' }}>No matches</Typography>
                    )}
                  </Box>
                </Popover>
              )
            })()}
          </Paper>
        ) : (
          <Paper variant="outlined" sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 1 }}>
            <TableChart sx={{ fontSize: 40, color: 'text.disabled' }} />
            <Typography variant="body2" color="text.secondary">Execute a query to see results</Typography>
          </Paper>
        )}
      </Box>

      {/* ── Delete confirmation dialog ── */}
      <Dialog open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ color: 'error.main' }}>
          {deleteConfirm?.type === 'database' ? 'Drop Database' : deleteConfirm?.type === 'clear-tables' ? 'Clear All Tables' : 'Drop Table'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {deleteConfirm?.type === 'database'
              ? <>Drop database <strong style={{ fontFamily: 'monospace' }}>{deleteConfirm.db}</strong> and <strong>all its tables</strong>? This cannot be undone.</>
              : deleteConfirm?.type === 'clear-tables'
              ? <>Drop all tables in <strong style={{ fontFamily: 'monospace' }}>{deleteConfirm?.db}</strong>? The database will be kept but all tables will be permanently removed.</>
              : <>Drop table <strong style={{ fontFamily: 'monospace' }}>{deleteConfirm?.db}.{deleteConfirm?.table}</strong>? This cannot be undone.</>
            }
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirm(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleConfirmDelete}
            disabled={dropTableMutation.isPending || dropDatabaseMutation.isPending || clearTablesMutation.isPending}>
            {dropTableMutation.isPending || dropDatabaseMutation.isPending || clearTablesMutation.isPending
              ? <CircularProgress size={16} color="inherit" /> : 'Drop'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── File delete confirmation dialog ── */}
      <Dialog open={!!fileDeleteConfirm} onClose={() => setFileDeleteConfirm(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ color: 'error.main' }}>Delete File{(fileDeleteConfirm?.length ?? 0) > 1 ? 's' : ''}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Permanently delete <strong>{fileDeleteConfirm?.length}</strong> file store entr{(fileDeleteConfirm?.length ?? 0) === 1 ? 'y' : 'ies'} from disk? This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFileDeleteConfirm(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => fileDeleteConfirm && handleDeleteFiles(fileDeleteConfirm)}>Delete</Button>
        </DialogActions>
      </Dialog>

      {/* ── Load Extracted Data dialog ── */}
      <LoadExtractedDataDialog
        open={loadDialogOpen}
        onClose={() => setLoadDialogOpen(false)}
        initialDb={loadDialogDb}
        catalogTables={catalogTables ?? []}
        onLoad={(t) => {
          setLoadDialogOpen(false)
          setBrowserTab(0)
          setDbFilter(t.database || 'default')
          handlePreviewTable(t)
        }}
      />
    </Box>
  )
}
