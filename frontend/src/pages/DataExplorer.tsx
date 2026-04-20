import { useState, useMemo, useEffect, useRef } from 'react'
import {
  Box, Typography, TextField, Button, CircularProgress, Chip,
  InputAdornment, Alert, Tooltip, IconButton, Select, MenuItem,
  Collapse, Divider, FormControl, useTheme, alpha, LinearProgress,
  Table, TableHead, TableRow, TableCell, TableBody,
} from '@mui/material'
import {
  Search, PlayArrow, TableChart, FolderOpen, ExpandMore, ChevronRight,
  Storage, FilterList, ArrowUpward, ArrowDownward, UnfoldMore,
  KeyboardArrowLeft, KeyboardArrowRight, Description, Visibility,
  Refresh, LinkOff, Link as LinkIcon, DeleteOutlined,
} from '@mui/icons-material'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { dataApi, DataTable, QueryResult, CatalogTable } from '../api/client'

// ── Module-level tree state — survives React Router navigations ───────────────
const _treeState = {
  catalogOpen: true,
  filesOpen: false,
  expandedDbs: new Set<string>(),
  expandedDates: new Set<string>(),
}

// ── Types ────────────────────────────────────────────────────────────────────

interface SelectedItem {
  type: 'file' | 'catalog'
  label: string
  path?: string       // for file: date/job/app_id
  sqlName?: string    // for catalog: db.table or temp view name
  database?: string   // for catalog USE context
  isTemporary?: boolean
}

type ActiveTab = 'preview' | 'schema' | 'query'

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b < 1_024) return `${b} B`
  if (b < 1_048_576) return `${(b / 1_024).toFixed(1)} KB`
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`
  return `${(b / 1_073_741_824).toFixed(2)} GB`
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
}

const PAGE_SIZES = [50, 100, 200, 500]

// ── RichGrid ─────────────────────────────────────────────────────────────────

interface RichGridProps {
  columns: string[]
  rows: unknown[][]
  loading?: boolean
  page: number
  pageSize: number
  totalRows?: number
  truncated?: boolean
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
}

function RichGrid({
  columns, rows, loading, page, pageSize, totalRows, truncated,
  onPageChange, onPageSizeChange,
}: RichGridProps) {
  const theme = useTheme()
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [rowFilter, setRowFilter] = useState('')

  useEffect(() => {
    setSortCol(null)
    setSortDir('asc')
    setRowFilter('')
  }, [columns.join('|')])

  const filteredRows = useMemo(() => {
    if (!rowFilter) return rows
    const lower = rowFilter.toLowerCase()
    return rows.filter(row =>
      (row as unknown[]).some(
        cell => cell !== null && cell !== undefined && String(cell).toLowerCase().includes(lower),
      ),
    )
  }, [rows, rowFilter])

  const sortedRows = useMemo(() => {
    if (sortCol === null) return filteredRows
    return [...filteredRows].sort((a, b) => {
      const va = (a as unknown[])[sortCol]
      const vb = (b as unknown[])[sortCol]
      if (va === null || va === undefined) return 1
      if (vb === null || vb === undefined) return -1
      const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true })
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [filteredRows, sortCol, sortDir])

  function handleSort(i: number) {
    if (sortCol === i) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortCol(i); setSortDir('asc') }
  }

  const knownTotal = totalRows ?? (truncated ? (page + 2) * pageSize : page * pageSize + rows.length)
  const pageCount = Math.max(1, Math.ceil(knownTotal / pageSize))
  const hasNext = !!(truncated || page + 1 < pageCount)

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', minHeight: 80 }}>
        <CircularProgress size={28} />
      </Box>
    )
  }

  if (columns.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', minHeight: 80, color: 'text.secondary' }}>
        <Typography variant="body2">No data</Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Grid toolbar */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.5, flexShrink: 0,
        borderBottom: `1px solid ${theme.palette.divider}`, bgcolor: 'background.paper',
      }}>
        <TextField
          placeholder="Filter rows…"
          value={rowFilter}
          onChange={e => setRowFilter(e.target.value)}
          size="small"
          sx={{ width: 190 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <FilterList sx={{ fontSize: 14 }} />
              </InputAdornment>
            ),
          }}
          inputProps={{ style: { fontSize: '0.75rem', paddingTop: 3, paddingBottom: 3 } }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {rowFilter && filteredRows.length !== rows.length
            ? `${sortedRows.length} / ${rows.length} rows (page) · `
            : `${rows.length} rows · `}
          {columns.length} cols
          {totalRows !== undefined && ` · ${totalRows.toLocaleString()} total`}
        </Typography>
        <Select
          value={pageSize}
          onChange={e => { onPageSizeChange(Number(e.target.value)); onPageChange(0) }}
          size="small"
          sx={{ fontSize: '0.75rem', height: 26, '.MuiSelect-select': { py: 0.25, pr: '24px !important' } }}
        >
          {PAGE_SIZES.map(s => (
            <MenuItem key={s} value={s} sx={{ fontSize: '0.78rem' }}>{s} / page</MenuItem>
          ))}
        </Select>
        <IconButton size="small" disabled={page === 0} onClick={() => onPageChange(page - 1)} sx={{ p: 0.25 }}>
          <KeyboardArrowLeft sx={{ fontSize: 18 }} />
        </IconButton>
        <Typography variant="caption" sx={{ fontFamily: 'monospace', minWidth: 56, textAlign: 'center' }}>
          {page + 1}{pageCount > 1 ? ` / ${pageCount}` : ''}
        </Typography>
        <IconButton size="small" disabled={!hasNext} onClick={() => onPageChange(page + 1)} sx={{ p: 0.25 }}>
          <KeyboardArrowRight sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>

      {/* Table */}
      <Box sx={{ flex: 1, overflow: 'auto' }}>
        <Table size="small" stickyHeader sx={{ minWidth: 400 }}>
          <TableHead>
            <TableRow>
              {columns.map((col, i) => (
                <TableCell
                  key={col + i}
                  onClick={() => handleSort(i)}
                  sx={{
                    cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
                    bgcolor: theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100',
                    py: 0.75, px: 1.5,
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Typography sx={{ fontFamily: 'monospace', fontSize: '0.7rem', fontWeight: 700 }}>
                      {col}
                    </Typography>
                    {sortCol === i
                      ? sortDir === 'asc'
                        ? <ArrowUpward sx={{ fontSize: 12 }} />
                        : <ArrowDownward sx={{ fontSize: 12 }} />
                      : <UnfoldMore sx={{ fontSize: 12, opacity: 0.3 }} />}
                  </Box>
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {sortedRows.map((row, ri) => (
              <TableRow key={ri} hover>
                {(row as unknown[]).map((cell, ci) => (
                  <TableCell
                    key={ci}
                    sx={{ whiteSpace: 'nowrap', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', py: 0.5, px: 1.5, fontFamily: 'monospace', fontSize: '0.75rem' }}
                  >
                    {cell === null || cell === undefined
                      ? <Box component="span" sx={{ color: 'text.disabled', fontStyle: 'italic', fontSize: '0.72rem' }}>null</Box>
                      : typeof cell === 'boolean'
                        ? <Chip label={String(cell)} size="small" color={cell ? 'success' : 'default'} sx={{ height: 16, fontSize: '0.65rem' }} />
                        : String(cell).length > 100
                          ? (
                            <Tooltip title={String(cell)} placement="top-start">
                              <span>{String(cell).slice(0, 100)}…</span>
                            </Tooltip>
                          )
                          : <span>{String(cell)}</span>
                    }
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {sortedRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={columns.length || 1} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  {rowFilter ? 'No matching rows' : 'No data'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Box>
    </Box>
  )
}


// ── DataExplorer ──────────────────────────────────────────────────────────────

export default function DataExplorer() {
  const theme = useTheme()
  const queryClient = useQueryClient()

  // Left panel state — initialised from module-level store so it survives navigation
  const [leftSearch, setLeftSearch] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(() => _treeState.catalogOpen)
  const [filesOpen, setFilesOpen] = useState(() => _treeState.filesOpen)
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(() => new Set(_treeState.expandedDbs))
  const [expandedDates, setExpandedDates] = useState<Set<string>>(() => new Set(_treeState.expandedDates))

  // Spark connection UI state
  const [sparkBusy, setSparkBusy] = useState(false)
  const [sparkStatus, setSparkStatus] = useState<'connected' | 'disconnected' | null>(null)

  // Selection + tabs
  const [selectedItem, setSelectedItem] = useState<SelectedItem | null>(null)
  const [activeTab, setActiveTab] = useState<ActiveTab>('preview')

  // Preview state
  const [previewPage, setPreviewPage] = useState(0)
  const [previewPageSize, setPreviewPageSize] = useState(100)

  // Query tab state
  const [sql, setSql] = useState('')
  const [queryDb, setQueryDb] = useState('')
  const [queryPage, setQueryPage] = useState(0)
  const [queryPageSize, setQueryPageSize] = useState(100)
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null)
  const [queryError, setQueryError] = useState('')
  const [queryDuration, setQueryDuration] = useState<number | null>(null)
  const [queryRunning, setQueryRunning] = useState(false)

  // Schema state
  const [schemaResult, setSchemaResult] = useState<QueryResult | null>(null)
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [schemaError, setSchemaError] = useState('')

  // ── Remote data ─────────────────────────────────────────────────────────────

  const { data: fileTables = [], isLoading: filesLoading } = useQuery({
    queryKey: ['data-tables'],
    queryFn: dataApi.listTables,
    staleTime: 60_000,
  })

  const { data: catalogTables = [], isLoading: catalogLoading } = useQuery({
    queryKey: ['catalog-tables'],
    queryFn: dataApi.listCatalogTables,
    staleTime: 60_000,
    enabled: catalogOpen,
  })

  const { data: databases = [] } = useQuery({
    queryKey: ['catalog-databases'],
    queryFn: dataApi.listDatabases,
    staleTime: 60_000,
  })

  // Preview query — server-side pagination via offset
  const previewOffset = previewPage * previewPageSize
  const { data: previewResult, isLoading: previewLoading, isError: previewIsError } = useQuery({
    queryKey: ['data-preview', selectedItem?.path, selectedItem?.sqlName, previewPage, previewPageSize],
    queryFn: async (): Promise<QueryResult> => {
      if (!selectedItem) throw new Error('No item selected')
      if (selectedItem.type === 'file' && selectedItem.path) {
        return dataApi.previewTable(selectedItem.path, previewPageSize, previewOffset)
      }
      if (selectedItem.type === 'catalog' && selectedItem.sqlName) {
        return dataApi.query(
          `SELECT * FROM ${selectedItem.sqlName}`,
          previewPageSize,
          previewOffset,
          selectedItem.database,
        )
      }
      throw new Error('Cannot preview item')
    },
    enabled: !!selectedItem && activeTab === 'preview',
  })

  // ── File tree structure ──────────────────────────────────────────────────────

  const fileTree = useMemo(() => {
    const tree: Record<string, Record<string, DataTable[]>> = {}
    for (const t of fileTables) {
      const parts = t.name.split('/')
      const date = parts[0] || 'unknown'
      const job = parts[1] || 'root'
      if (!tree[date]) tree[date] = {}
      if (!tree[date][job]) tree[date][job] = []
      tree[date][job].push(t)
    }
    return tree
  }, [fileTables])

  const filteredFileTree = useMemo(() => {
    if (!leftSearch) return fileTree
    const lower = leftSearch.toLowerCase()
    const result: Record<string, Record<string, DataTable[]>> = {}
    for (const [date, jobs] of Object.entries(fileTree)) {
      for (const [job, tables] of Object.entries(jobs)) {
        const matched = tables.filter(
          t => t.name.toLowerCase().includes(lower) || job.toLowerCase().includes(lower) || date.includes(lower),
        )
        if (matched.length > 0) {
          if (!result[date]) result[date] = {}
          result[date][job] = matched
        }
      }
    }
    return result
  }, [fileTree, leftSearch])

  // ── Catalog tree structure ───────────────────────────────────────────────────

  const catalogTree = useMemo(() => {
    const tree: Record<string, { tables: CatalogTable[]; tempViews: CatalogTable[] }> = {}
    for (const t of catalogTables) {
      if (!tree[t.database]) tree[t.database] = { tables: [], tempViews: [] }
      if (t.is_temporary) tree[t.database].tempViews.push(t)
      else tree[t.database].tables.push(t)
    }
    return tree
  }, [catalogTables])

  const filteredCatalogTree = useMemo(() => {
    if (!leftSearch) return catalogTree
    const lower = leftSearch.toLowerCase()
    const result: Record<string, { tables: CatalogTable[]; tempViews: CatalogTable[] }> = {}
    for (const [db, { tables, tempViews }] of Object.entries(catalogTree)) {
      const ft = tables.filter(t => t.name.toLowerCase().includes(lower) || db.toLowerCase().includes(lower))
      const fv = tempViews.filter(t => t.name.toLowerCase().includes(lower) || db.toLowerCase().includes(lower))
      if (ft.length > 0 || fv.length > 0) result[db] = { tables: ft, tempViews: fv }
    }
    return result
  }, [catalogTree, leftSearch])

  // ── Item selection ───────────────────────────────────────────────────────────

  function selectFileItem(table: DataTable) {
    setSelectedItem({ type: 'file', label: table.name, path: table.name })
    setPreviewPage(0)
    setActiveTab('preview')
  }

  function selectCatalogItem(ct: CatalogTable) {
    const sqlName = ct.is_temporary ? ct.name : `${ct.database}.${ct.name}`
    setSelectedItem({ type: 'catalog', label: ct.name, sqlName, database: ct.database, isTemporary: ct.is_temporary })
    setPreviewPage(0)
    setSchemaResult(null)
    setSchemaError('')
    setActiveTab('preview')
    fetchSchema(sqlName, ct.database)
  }

  // ── Schema fetch ─────────────────────────────────────────────────────────────

  async function fetchSchema(sqlName: string, database?: string) {
    setSchemaLoading(true)
    setSchemaResult(null)
    setSchemaError('')
    try {
      const result = await dataApi.query(`DESCRIBE ${sqlName}`, 500, 0, database)
      setSchemaResult(result)
    } catch (err) {
      setSchemaError(err instanceof Error ? err.message : String(err))
    } finally {
      setSchemaLoading(false)
    }
  }

  // ── Run SQL query ────────────────────────────────────────────────────────────

  async function runQuery(sqlStr: string, db?: string, switchTab = true) {
    if (!sqlStr.trim()) return
    setSql(sqlStr)
    if (db !== undefined) setQueryDb(db)
    if (switchTab) setActiveTab('query')
    setQueryRunning(true)
    setQueryError('')
    setQueryResult(null)
    setQueryPage(0)
    setQueryDuration(null)
    try {
      const result = await dataApi.query(sqlStr, queryPageSize, 0, (db ?? queryDb) || undefined)
      setQueryResult(result)
      setQueryDuration(result.duration_ms ?? null)
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : String(err))
    } finally {
      setQueryRunning(false)
    }
  }

  async function runCurrentQuery() {
    if (!sql.trim()) return
    setQueryRunning(true)
    setQueryError('')
    setQueryResult(null)
    setQueryPage(0)
    setQueryDuration(null)
    try {
      const result = await dataApi.query(sql, queryPageSize, 0, queryDb || undefined)
      setQueryResult(result)
      setQueryDuration(result.duration_ms ?? null)
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : String(err))
    } finally {
      setQueryRunning(false)
    }
  }

  async function changeQueryPage(newPage: number) {
    if (!sql.trim()) return
    setQueryPage(newPage)
    setQueryRunning(true)
    try {
      const result = await dataApi.query(sql, queryPageSize, newPage * queryPageSize, queryDb || undefined)
      setQueryResult(result)
      setQueryDuration(result.duration_ms ?? null)
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : String(err))
    } finally {
      setQueryRunning(false)
    }
  }

  // ── Persist tree state to module-level store on every change ─────────────────

  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return }
    _treeState.catalogOpen = catalogOpen
    _treeState.filesOpen = filesOpen
    _treeState.expandedDbs = new Set(expandedDbs)
    _treeState.expandedDates = new Set(expandedDates)
  }, [catalogOpen, filesOpen, expandedDbs, expandedDates])

  // ── Tree toggles ─────────────────────────────────────────────────────────────

  function toggleDb(db: string) {
    setExpandedDbs(prev => { const n = new Set(prev); n.has(db) ? n.delete(db) : n.add(db); return n })
  }
  function toggleDate(date: string) {
    setExpandedDates(prev => { const n = new Set(prev); n.has(date) ? n.delete(date) : n.add(date); return n })
  }

  // ── Spark catalog actions ─────────────────────────────────────────────────────

  async function handleSparkRefresh() {
    queryClient.invalidateQueries({ queryKey: ['catalog-tables'] })
    queryClient.invalidateQueries({ queryKey: ['catalog-databases'] })
  }

  async function handleSparkReconnect() {
    setSparkBusy(true)
    try {
      await dataApi.sparkReconnect()
      setSparkStatus('connected')
      handleSparkRefresh()
    } catch {
      setSparkStatus('disconnected')
    } finally {
      setSparkBusy(false)
    }
  }

  async function handleSparkDisconnect() {
    setSparkBusy(true)
    try {
      await dataApi.sparkDisconnect()
      setSparkStatus('disconnected')
      queryClient.setQueryData(['catalog-tables'], [])
      queryClient.setQueryData(['catalog-databases'], [])
    } finally {
      setSparkBusy(false)
    }
  }

  async function handleDropView(viewName: string, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await dataApi.dropTempView(viewName)
      queryClient.invalidateQueries({ queryKey: ['catalog-tables'] })
      if (selectedItem?.sqlName === viewName) setSelectedItem(null)
    } catch (err) {
      console.error('Failed to drop view', viewName, err)
    }
  }

  async function handleDropAllViews(e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await dataApi.dropAllTempViews()
      queryClient.invalidateQueries({ queryKey: ['catalog-tables'] })
      if (selectedItem?.isTemporary) setSelectedItem(null)
    } catch (err) {
      console.error('Failed to drop all views', err)
    }
  }

  // ── Style helpers ─────────────────────────────────────────────────────────────

  const leftBg = theme.palette.mode === 'dark' ? '#0d1117' : '#f5f5f5'
  const hoverBg = theme.palette.mode === 'dark' ? alpha('#fff', 0.06) : alpha('#000', 0.05)
  const selectedBg = alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.1)

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* ── LEFT PANEL ───────────────────────────────────────────────────────── */}
      <Box sx={{
        width: 280, flexShrink: 0,
        bgcolor: leftBg,
        borderRight: `1px solid ${theme.palette.divider}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Search */}
        <Box sx={{ p: 1, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <TextField
            placeholder="Search tables…"
            value={leftSearch}
            onChange={e => setLeftSearch(e.target.value)}
            size="small"
            fullWidth
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <Search sx={{ fontSize: 16 }} />
                </InputAdornment>
              ),
            }}
            inputProps={{ style: { fontSize: '0.78rem', paddingTop: 4, paddingBottom: 4 } }}
          />
        </Box>

        <Box sx={{ flex: 1, overflowY: 'auto' }}>

          {/* FILE STORE */}
          <Box>
            <Box
              onClick={() => setFilesOpen(o => !o)}
              sx={{ display: 'flex', alignItems: 'center', px: 1.5, py: 0.75, cursor: 'pointer', userSelect: 'none', '&:hover': { bgcolor: hoverBg } }}
            >
              <ExpandMore sx={{ fontSize: 16, mr: 0.5, transition: 'transform 0.2s', transform: filesOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
              <FolderOpen sx={{ fontSize: 15, mr: 0.75, color: theme.palette.warning.main }} />
              <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', flex: 1, color: 'text.secondary' }}>
                File Store
              </Typography>
              {filesLoading
                ? <CircularProgress size={10} />
                : <Chip label={fileTables.length} size="small" sx={{ height: 16, fontSize: '0.65rem' }} />}
            </Box>

            <Collapse in={filesOpen}>
              {Object.keys(filteredFileTree).length === 0 && !filesLoading ? (
                <Typography variant="caption" sx={{ display: 'block', px: 3.5, py: 1, color: 'text.disabled' }}>
                  {leftSearch ? 'No matches' : 'No files found'}
                </Typography>
              ) : (
                Object.entries(filteredFileTree)
                  .sort(([a], [b]) => b.localeCompare(a))
                  .map(([date, jobs]) => (
                    <Box key={date}>
                      <Box
                        onClick={() => toggleDate(date)}
                        sx={{ display: 'flex', alignItems: 'center', pl: 2.5, pr: 1.5, py: 0.4, cursor: 'pointer', '&:hover': { bgcolor: hoverBg } }}
                      >
                        {expandedDates.has(date)
                          ? <ExpandMore sx={{ fontSize: 13, mr: 0.5 }} />
                          : <ChevronRight sx={{ fontSize: 13, mr: 0.5 }} />}
                        <Typography sx={{ fontSize: '0.74rem', fontFamily: 'monospace', flex: 1, color: 'text.secondary' }}>
                          {date}
                        </Typography>
                        <Chip
                          label={Object.values(jobs).reduce((s, t) => s + t.length, 0)}
                          size="small"
                          sx={{ height: 14, fontSize: '0.6rem' }}
                        />
                      </Box>
                      <Collapse in={expandedDates.has(date)}>
                        {Object.entries(jobs).map(([, tables]) =>
                          tables.map(table => {
                            const parts = table.name.split('/')
                            const appId = parts[2] ?? parts[1] ?? table.name
                            const job = parts[1] ?? ''
                            const isSelected = selectedItem?.path === table.name
                            return (
                              <Box
                                key={table.name}
                                onClick={() => selectFileItem(table)}
                                sx={{
                                  display: 'flex', alignItems: 'center', pl: 4.5, pr: 1.5, py: 0.35,
                                  cursor: 'pointer',
                                  bgcolor: isSelected ? selectedBg : 'transparent',
                                  '&:hover': { bgcolor: isSelected ? selectedBg : hoverBg },
                                  borderLeft: isSelected ? `2px solid ${theme.palette.primary.main}` : '2px solid transparent',
                                }}
                              >
                                <Storage sx={{ fontSize: 12, mr: 0.75, color: theme.palette.info.main, flexShrink: 0 }} />
                                <Tooltip title={table.name} placement="right">
                                  <Box sx={{ flex: 1, overflow: 'hidden' }}>
                                    <Typography sx={{ fontSize: '0.72rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.3 }}>
                                      {appId}
                                    </Typography>
                                    {job && (
                                      <Typography sx={{ fontSize: '0.64rem', color: 'text.disabled', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.2 }}>
                                        {job}
                                      </Typography>
                                    )}
                                  </Box>
                                </Tooltip>
                                <Typography sx={{ fontSize: '0.64rem', color: 'text.disabled', ml: 0.5, flexShrink: 0 }}>
                                  {table.size_bytes != null ? fmtBytes(table.size_bytes) : ''}
                                </Typography>
                              </Box>
                            )
                          }),
                        )}
                      </Collapse>
                    </Box>
                  ))
              )}
            </Collapse>
          </Box>

          <Divider />

          {/* SPARK CATALOG */}
          <Box>
            <Box
              sx={{ display: 'flex', alignItems: 'center', px: 1.5, py: 0.75, userSelect: 'none' }}
            >
              <Box
                onClick={() => setCatalogOpen(o => !o)}
                sx={{ display: 'flex', alignItems: 'center', flex: 1, cursor: 'pointer', '&:hover': { opacity: 0.8 } }}
              >
                <ExpandMore sx={{ fontSize: 16, mr: 0.5, transition: 'transform 0.2s', transform: catalogOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
                <TableChart sx={{ fontSize: 15, mr: 0.75, color: sparkStatus === 'disconnected' ? 'text.disabled' : theme.palette.primary.main }} />
                <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', flex: 1, color: 'text.secondary' }}>
                  Spark Catalog
                </Typography>
              </Box>
              {sparkBusy
                ? <CircularProgress size={10} sx={{ mr: 0.5 }} />
                : catalogLoading
                  ? <CircularProgress size={10} sx={{ mr: 0.5 }} />
                  : <Chip
                      label={catalogTables.length}
                      size="small"
                      sx={{ height: 16, fontSize: '0.65rem', mr: 0.5 }}
                    />}
              <Tooltip title="Refresh catalog">
                <span>
                  <IconButton size="small" disabled={sparkBusy} onClick={handleSparkRefresh} sx={{ p: 0.25 }}>
                    <Refresh sx={{ fontSize: 13 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={sparkStatus === 'disconnected' ? 'Connect to Spark' : 'Reconnect to Spark'}>
                <span>
                  <IconButton size="small" disabled={sparkBusy} onClick={handleSparkReconnect} sx={{ p: 0.25 }}>
                    <LinkIcon sx={{ fontSize: 13 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Disconnect from Spark">
                <span>
                  <IconButton size="small" disabled={sparkBusy || sparkStatus === 'disconnected'} onClick={handleSparkDisconnect} sx={{ p: 0.25 }}>
                    <LinkOff sx={{ fontSize: 13 }} />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>

            <Collapse in={catalogOpen}>
              {catalogLoading ? (
                <Box sx={{ px: 3, py: 1 }}><LinearProgress sx={{ height: 2 }} /></Box>
              ) : Object.keys(filteredCatalogTree).length === 0 ? (
                <Typography variant="caption" sx={{ display: 'block', px: 3.5, py: 1, color: 'text.disabled' }}>
                  {leftSearch ? 'No matches' : 'No catalog tables found'}
                </Typography>
              ) : (
                Object.entries(filteredCatalogTree)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([db, { tables, tempViews }]) => {
                    const dbExpanded = expandedDbs.has(db)
                    const totalCount = tables.length + tempViews.length
                    return (
                      <Box key={db}>
                        <Box
                          onClick={() => toggleDb(db)}
                          sx={{ display: 'flex', alignItems: 'center', pl: 2.5, pr: 1.5, py: 0.4, cursor: 'pointer', '&:hover': { bgcolor: hoverBg } }}
                        >
                          {dbExpanded
                            ? <ExpandMore sx={{ fontSize: 13, mr: 0.5 }} />
                            : <ChevronRight sx={{ fontSize: 13, mr: 0.5 }} />}
                          <Typography sx={{ fontSize: '0.74rem', fontFamily: 'monospace', flex: 1, color: 'text.secondary' }}>
                            {db}
                          </Typography>
                          <Chip label={totalCount} size="small" sx={{ height: 14, fontSize: '0.6rem' }} />
                        </Box>
                        <Collapse in={dbExpanded}>
                          {tables.length > 0 && (
                            <>
                              <Typography sx={{ fontSize: '0.63rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', px: 4, pt: 0.5, pb: 0.25, color: 'text.disabled' }}>
                                Tables ({tables.length})
                              </Typography>
                              {tables.map(ct => {
                                const isSelected = selectedItem?.sqlName === `${ct.database}.${ct.name}`
                                return (
                                  <Box
                                    key={ct.name}
                                    onClick={() => selectCatalogItem(ct)}
                                    sx={{
                                      display: 'flex', alignItems: 'center', pl: 4.5, pr: 1.5, py: 0.35,
                                      cursor: 'pointer',
                                      bgcolor: isSelected ? selectedBg : 'transparent',
                                      '&:hover': { bgcolor: isSelected ? selectedBg : hoverBg },
                                      borderLeft: isSelected ? `2px solid ${theme.palette.primary.main}` : '2px solid transparent',
                                    }}
                                  >
                                    <TableChart sx={{ fontSize: 12, mr: 0.75, color: theme.palette.primary.main, flexShrink: 0 }} />
                                    <Typography sx={{ fontSize: '0.72rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {ct.name}
                                    </Typography>
                                  </Box>
                                )
                              })}
                            </>
                          )}
                          {tempViews.length > 0 && (
                            <>
                              <Box sx={{ display: 'flex', alignItems: 'center', px: 4, pt: 0.5, pb: 0.25 }}>
                                <Typography sx={{ fontSize: '0.63rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'text.disabled', flex: 1 }}>
                                  Temp Views ({tempViews.length})
                                </Typography>
                                <Tooltip title="Drop all temp views" placement="right">
                                  <IconButton size="small" onClick={handleDropAllViews} sx={{ p: 0.25, color: 'error.main', opacity: 0.6, '&:hover': { opacity: 1 } }}>
                                    <DeleteOutlined sx={{ fontSize: 12 }} />
                                  </IconButton>
                                </Tooltip>
                              </Box>
                              {tempViews.map(ct => {
                                const isSelected = selectedItem?.sqlName === ct.name
                                return (
                                  <Box
                                    key={ct.name}
                                    onClick={() => selectCatalogItem(ct)}
                                    sx={{
                                      display: 'flex', alignItems: 'center', pl: 4.5, pr: 0.5, py: 0.35,
                                      cursor: 'pointer',
                                      bgcolor: isSelected ? selectedBg : 'transparent',
                                      '&:hover': { bgcolor: isSelected ? selectedBg : hoverBg },
                                      '&:hover .view-delete-btn': { opacity: 1 },
                                      borderLeft: isSelected ? `2px solid ${theme.palette.secondary.main}` : '2px solid transparent',
                                    }}
                                  >
                                    <Visibility sx={{ fontSize: 12, mr: 0.75, color: theme.palette.secondary.main, flexShrink: 0 }} />
                                    <Typography sx={{ fontSize: '0.72rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {ct.name}
                                    </Typography>
                                    <Tooltip title={`DROP VIEW ${ct.name}`} placement="right">
                                      <IconButton
                                        className="view-delete-btn"
                                        size="small"
                                        onClick={e => handleDropView(ct.name, e)}
                                        sx={{ p: 0.25, opacity: 0, transition: 'opacity 0.15s', color: 'error.main', flexShrink: 0 }}
                                      >
                                        <DeleteOutlined sx={{ fontSize: 13 }} />
                                      </IconButton>
                                    </Tooltip>
                                  </Box>
                                )
                              })}
                            </>
                          )}
                        </Collapse>
                      </Box>
                    )
                  })
              )}
            </Collapse>
          </Box>

        </Box>
      </Box>

      {/* ── RIGHT PANEL ──────────────────────────────────────────────────────── */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Shortcut toolbar */}
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 0.75, px: 1.5, py: 0.75, flexShrink: 0,
          bgcolor: 'background.paper', borderBottom: `1px solid ${theme.palette.divider}`,
          flexWrap: 'wrap',
        }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', mr: 0.25 }}>
            Quick:
          </Typography>
          <Chip
            label="SHOW DATABASES"
            size="small"
            clickable
            onClick={() => runQuery('SHOW DATABASES')}
            sx={{ fontFamily: 'monospace', fontSize: '0.67rem', height: 22 }}
          />
          <Chip
            label="SHOW TABLES"
            size="small"
            clickable
            onClick={() => {
              const dbPart = selectedItem?.database ?? queryDb
              runQuery(dbPart ? `SHOW TABLES IN ${dbPart}` : 'SHOW TABLES')
            }}
            sx={{ fontFamily: 'monospace', fontSize: '0.67rem', height: 22 }}
          />
          {selectedItem?.sqlName && (
            <>
              <Chip
                label={`DESCRIBE ${selectedItem.label}`}
                size="small"
                clickable
                color="primary"
                variant="outlined"
                onClick={() => runQuery(`DESCRIBE ${selectedItem!.sqlName}`, selectedItem!.database)}
                sx={{ fontFamily: 'monospace', fontSize: '0.67rem', height: 22 }}
              />
              <Chip
                label={`COUNT(*) FROM ${selectedItem.label}`}
                size="small"
                clickable
                color="primary"
                variant="outlined"
                onClick={() => runQuery(`SELECT COUNT(*) AS total_rows FROM ${selectedItem!.sqlName}`, selectedItem!.database)}
                sx={{ fontFamily: 'monospace', fontSize: '0.67rem', height: 22 }}
              />
              <Chip
                label={`SELECT * FROM ${selectedItem.label}`}
                size="small"
                clickable
                color="primary"
                variant="outlined"
                onClick={() => runQuery(`SELECT * FROM ${selectedItem!.sqlName}`, selectedItem!.database)}
                sx={{ fontFamily: 'monospace', fontSize: '0.67rem', height: 22 }}
              />
            </>
          )}
        </Box>

        {/* Tab strip */}
        <Box sx={{
          display: 'flex', alignItems: 'center', px: 1, flexShrink: 0,
          borderBottom: `1px solid ${theme.palette.divider}`, bgcolor: 'background.paper',
        }}>
          {(['preview', 'schema', 'query'] as ActiveTab[]).map(tab => (
            <Box
              key={tab}
              onClick={() => setActiveTab(tab)}
              sx={{
                px: 2, py: 0.875, cursor: 'pointer', fontSize: '0.8rem',
                fontWeight: activeTab === tab ? 700 : 400,
                color: activeTab === tab ? 'primary.main' : 'text.secondary',
                borderBottom: activeTab === tab ? `2px solid ${theme.palette.primary.main}` : '2px solid transparent',
                '&:hover': { color: 'text.primary' },
                transition: 'color 0.15s, border-color 0.15s',
              }}
            >
              {tab === 'preview' ? 'Data Preview' : tab === 'schema' ? 'Schema' : 'SQL Query'}
            </Box>
          ))}
          {selectedItem && (
            <Typography variant="caption" color="text.secondary" sx={{ ml: 1.5, fontFamily: 'monospace', opacity: 0.7 }}>
              {selectedItem.type === 'catalog' ? (selectedItem.sqlName ?? selectedItem.label) : selectedItem.label}
            </Typography>
          )}
        </Box>

        {/* Tab content */}
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

          {/* DATA PREVIEW TAB */}
          {activeTab === 'preview' && (
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {!selectedItem ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 1.5, color: 'text.secondary' }}>
                  <TableChart sx={{ fontSize: 52, opacity: 0.2 }} />
                  <Typography variant="body1" fontWeight={500}>Select a table or file to preview</Typography>
                  <Typography variant="body2" color="text.disabled">Browse the File Store or Spark Catalog on the left</Typography>
                </Box>
              ) : previewIsError ? (
                <Alert severity="error" sx={{ m: 2 }}>Failed to load preview for {selectedItem.label}</Alert>
              ) : (
                <RichGrid
                  columns={previewResult?.columns ?? []}
                  rows={previewResult?.rows ?? []}
                  loading={previewLoading}
                  page={previewPage}
                  pageSize={previewPageSize}
                  totalRows={previewResult?.total_rows}
                  truncated={previewResult?.truncated}
                  onPageChange={setPreviewPage}
                  onPageSizeChange={s => { setPreviewPageSize(s); setPreviewPage(0) }}
                />
              )}
            </Box>
          )}

          {/* SCHEMA TAB */}
          {activeTab === 'schema' && (
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {!selectedItem?.sqlName ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 1.5, color: 'text.secondary' }}>
                  <Description sx={{ fontSize: 52, opacity: 0.2 }} />
                  <Typography variant="body1" fontWeight={500}>Select a Spark catalog table to view its schema</Typography>
                </Box>
              ) : schemaError ? (
                <Alert severity="error" sx={{ m: 2 }}>{schemaError}</Alert>
              ) : schemaLoading || !schemaResult ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}><CircularProgress size={28} /></Box>
              ) : (
                <Box>
                  <Box sx={{ px: 2, py: 1, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="subtitle2" fontFamily="monospace">{selectedItem.sqlName}</Typography>
                    <Button
                      size="small"
                      variant="outlined"
                      sx={{ ml: 'auto', fontSize: '0.72rem', py: 0.25 }}
                      onClick={() => selectedItem.sqlName && fetchSchema(selectedItem.sqlName, selectedItem.database)}
                    >
                      Refresh
                    </Button>
                  </Box>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        {schemaResult.columns.map((col, i) => (
                          <TableCell key={i} sx={{ fontFamily: 'monospace', fontSize: '0.72rem', fontWeight: 700, bgcolor: theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100', py: 0.75 }}>
                            {col}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {schemaResult.rows.map((row, ri) => (
                        <TableRow key={ri} hover>
                          {(row as unknown[]).map((cell, ci) => (
                            <TableCell key={ci} sx={{ fontFamily: 'monospace', fontSize: '0.78rem', py: 0.5 }}>
                              {cell === null || cell === undefined ? '—' : String(cell)}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              )}
            </Box>
          )}

          {/* SQL QUERY TAB */}
          {activeTab === 'query' && (
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {/* Editor panel */}
              <Box sx={{ flexShrink: 0, borderBottom: `1px solid ${theme.palette.divider}` }}>
                {/* Editor toolbar */}
                <Box sx={{
                  display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.75,
                  bgcolor: 'background.paper', borderBottom: `1px solid ${theme.palette.divider}`,
                }}>
                  <FormControl size="small" sx={{ minWidth: 150 }}>
                    <Select
                      value={queryDb}
                      onChange={e => setQueryDb(e.target.value)}
                      displayEmpty
                      sx={{ fontSize: '0.78rem', height: 28 }}
                    >
                      <MenuItem value="" sx={{ fontSize: '0.78rem', color: 'text.secondary' }}>(default db)</MenuItem>
                      {databases.map(db => (
                        <MenuItem key={db} value={db} sx={{ fontSize: '0.78rem' }}>{db}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Box sx={{ flex: 1 }} />
                  {queryDuration !== null && !queryRunning && (
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                      {fmtMs(queryDuration)}
                    </Typography>
                  )}
                  {queryResult && !queryRunning && (
                    <Typography variant="caption" color="text.secondary">
                      {queryResult.rows.length} rows · {queryResult.columns.length} cols
                      {queryResult.truncated && ' (truncated)'}
                    </Typography>
                  )}
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={queryRunning ? <CircularProgress size={13} color="inherit" /> : <PlayArrow sx={{ fontSize: 16 }} />}
                    onClick={runCurrentQuery}
                    disabled={queryRunning || !sql.trim()}
                    sx={{ fontSize: '0.78rem', py: 0.35 }}
                  >
                    Run
                  </Button>
                </Box>
                {/* SQL textarea */}
                <Box
                  component="textarea"
                  value={sql}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setSql(e.target.value)}
                  spellCheck={false}
                  rows={6}
                  placeholder="SELECT * FROM ..."
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      runCurrentQuery()
                    }
                  }}
                  sx={{
                    display: 'block', width: '100%', resize: 'vertical',
                    border: 'none', outline: 'none',
                    bgcolor: theme.palette.mode === 'dark' ? '#0d1117' : '#fafafa',
                    color: 'text.primary',
                    fontFamily: '"JetBrains Mono", Consolas, "Courier New", monospace',
                    fontSize: '0.85rem', lineHeight: 1.7, p: 1.5,
                    boxSizing: 'border-box',
                  }}
                />
              </Box>

              {/* Results */}
              <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {queryError && (
                  <Alert severity="error" sx={{ m: 1.5, flexShrink: 0 }}>{queryError}</Alert>
                )}
                {queryRunning && (
                  <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
                    <CircularProgress size={28} />
                  </Box>
                )}
                {queryResult && !queryRunning && (
                  <RichGrid
                    columns={queryResult.columns}
                    rows={queryResult.rows}
                    loading={false}
                    page={queryPage}
                    pageSize={queryPageSize}
                    truncated={queryResult.truncated}
                    totalRows={queryResult.total_rows}
                    onPageChange={changeQueryPage}
                    onPageSizeChange={s => { setQueryPageSize(s); setQueryPage(0) }}
                  />
                )}
                {!queryRunning && !queryResult && !queryError && (
                  <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'text.secondary', gap: 1 }}>
                    <PlayArrow sx={{ fontSize: 40, opacity: 0.2 }} />
                    <Typography variant="body2">Run a query to see results</Typography>
                    <Typography variant="caption" color="text.disabled">⌘+Enter to run</Typography>
                  </Box>
                )}
              </Box>
            </Box>
          )}

        </Box>
      </Box>
    </Box>
  )
}
