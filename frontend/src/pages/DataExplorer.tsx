import { useState, useMemo, useEffect, useRef } from 'react'
import Editor, { BeforeMount, OnMount } from '@monaco-editor/react'
import {
  Box, Typography, TextField, Button, CircularProgress, Chip,
  InputAdornment, Alert, Tooltip, IconButton, Select, MenuItem,
  Collapse, Divider, FormControl, useTheme, alpha, LinearProgress,
  Table, TableHead, TableRow, TableCell, TableBody, Menu,
} from '@mui/material'
import {
  Search, PlayArrow, TableChart, FolderOpen, ExpandMore, ChevronRight,
  Storage, FilterList, ArrowUpward, ArrowDownward, UnfoldMore,
  KeyboardArrowLeft, KeyboardArrowRight, Description, Visibility,
  Refresh, LinkOff, Link as LinkIcon, DeleteOutlined, Add, Save, Close, FileDownload,
} from '@mui/icons-material'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { dataApi, DataTable, QueryResult, CatalogTable, CatalogDatabaseIntrospection } from '../api/client'
import * as XLSX from 'xlsx'

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

interface QueryErrorInfo {
  message: string
  statusCode?: number
  errorType?: string
  sparkMessage?: string
  sql?: string
  database?: string
  traceback?: string
}

interface SqlConsoleCell {
  id: string
  sql: string
  queryDb: string
  page: number
  pageSize: number
  result: QueryResult | null
  error: QueryErrorInfo | null
  duration: number | null
  running: boolean
}

interface SqlConsole {
  id: string
  name: string
  cells: SqlConsoleCell[]
}

interface DatabaseSchemaCacheEntry {
  loading: boolean
  loaded: boolean
  tables: CatalogDatabaseIntrospection['tables']
  error?: string
}

const DEFAULT_PAGE_SIZE = 100

function createSqlCell(seedSql = ''): SqlConsoleCell {
  return {
    id: `cell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sql: seedSql,
    queryDb: '',
    page: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    result: null,
    error: null,
    duration: null,
    running: false,
  }
}

function createSqlConsole(index: number): SqlConsole {
  return {
    id: `console_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: `Console ${index}`,
    cells: [createSqlCell('SELECT * FROM ...')],
  }
}

const _viewState = {
  leftSearch: '',
  leftCollapsed: false,
  rightCollapsed: false,
  selectedItem: null as SelectedItem | null,
  activeTab: 'query' as ActiveTab,
  previewPage: 0,
  previewPageSize: DEFAULT_PAGE_SIZE,
  consoles: [createSqlConsole(1)] as SqlConsole[],
  activeConsoleId: '' as string,
  activeCellId: '' as string,
  sqlResultsHeightPct: 46,
  schemaCache: {} as Record<string, DatabaseSchemaCacheEntry>,
  schemaResult: null as QueryResult | null,
  schemaError: '',
}

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

function parseQueryError(err: unknown): QueryErrorInfo {
  const fallbackMessage = err instanceof Error ? err.message : String(err)
  const e = err as {
    response?: {
      status?: number
      data?: {
        detail?: unknown
      }
    }
  }
  const statusCode = e?.response?.status
  const detail = e?.response?.data?.detail

  if (detail && typeof detail === 'object') {
    const d = detail as Record<string, unknown>
    return {
      message: String(d.message ?? fallbackMessage),
      statusCode,
      errorType: d.error_type ? String(d.error_type) : undefined,
      sparkMessage: d.spark_message ? String(d.spark_message) : undefined,
      sql: d.sql ? String(d.sql) : undefined,
      database: d.database ? String(d.database) : undefined,
      traceback: d.traceback ? String(d.traceback) : undefined,
    }
  }

  if (typeof detail === 'string' && detail.trim()) {
    return { message: detail, statusCode }
  }

  return { message: fallbackMessage, statusCode }
}

function sanitizeJvmNoise(text?: string): string | undefined {
  if (!text) return text
  const cleaned = text
    .split('\n')
    .filter(line => {
      const s = line.trim()
      return !(
        s.startsWith('at org.')
        || s.startsWith('at java.')
        || s.startsWith('at scala.')
        || s.startsWith('at sun.')
        || (s.startsWith('...') && s.endsWith('more'))
      )
    })
    .join('\n')
    .trim()
  return cleaned || text
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
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <FilterList sx={{ fontSize: 14 }} />
                </InputAdornment>
              ),
            },
            htmlInput: { style: { fontSize: '0.75rem', paddingTop: 3, paddingBottom: 3 } },
          }}
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
  const [cellMenuAnchor, setCellMenuAnchor] = useState<null | HTMLElement>(null)
  const [cellMenuTarget, setCellMenuTarget] = useState<{ consoleId: string; cellId: string } | null>(null)
  const sqlWorkspaceRef = useRef<HTMLDivElement | null>(null)
  const completionDisposableRef = useRef<any>(null)
  const schemaCacheRef = useRef<Record<string, DatabaseSchemaCacheEntry>>(_viewState.schemaCache)
  const activeCellRef = useRef<SqlConsoleCell | null>(null)
  const selectedItemRef = useRef<SelectedItem | null>(_viewState.selectedItem)

  // Left panel state — initialised from module-level store so it survives navigation
  const [leftSearch, setLeftSearch] = useState(() => _viewState.leftSearch)
  const [catalogOpen, setCatalogOpen] = useState(() => _treeState.catalogOpen)
  const [filesOpen, setFilesOpen] = useState(() => _treeState.filesOpen)
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(() => new Set(_treeState.expandedDbs))
  const [expandedDates, setExpandedDates] = useState<Set<string>>(() => new Set(_treeState.expandedDates))
  const [leftCollapsed, setLeftCollapsed] = useState(() => _viewState.leftCollapsed)
  const [rightCollapsed, setRightCollapsed] = useState(() => _viewState.rightCollapsed)

  // Spark connection UI state
  const [sparkBusy, setSparkBusy] = useState(false)
  const [sparkStatus, setSparkStatus] = useState<'connected' | 'disconnected' | null>(null)

  // Selection + tabs
  const [selectedItem, setSelectedItem] = useState<SelectedItem | null>(() => _viewState.selectedItem)
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => _viewState.activeTab)

  // Preview state
  const [previewPage, setPreviewPage] = useState(() => _viewState.previewPage)
  const [previewPageSize, setPreviewPageSize] = useState(() => _viewState.previewPageSize)

  // Query console state
  const [consoles, setConsoles] = useState<SqlConsole[]>(() => _viewState.consoles)
  const [activeConsoleId, setActiveConsoleId] = useState<string>(() => {
    if (_viewState.activeConsoleId) return _viewState.activeConsoleId
    return _viewState.consoles[0]?.id ?? ''
  })
  const [activeCellId, setActiveCellId] = useState<string>(() => {
    if (_viewState.activeCellId) return _viewState.activeCellId
    return _viewState.consoles[0]?.cells[0]?.id ?? ''
  })
  const [sqlResultsHeightPct, setSqlResultsHeightPct] = useState(() => _viewState.sqlResultsHeightPct)
  const [schemaCache, setSchemaCache] = useState<Record<string, DatabaseSchemaCacheEntry>>(() => _viewState.schemaCache)

  const activeConsole = useMemo(
    () => consoles.find(c => c.id === activeConsoleId) ?? consoles[0] ?? null,
    [consoles, activeConsoleId],
  )

  const activeCell = useMemo(
    () => activeConsole?.cells.find(c => c.id === activeCellId) ?? activeConsole?.cells[0] ?? null,
    [activeConsole, activeCellId],
  )

  useEffect(() => {
    activeCellRef.current = activeCell
  }, [activeCell])

  useEffect(() => {
    selectedItemRef.current = selectedItem
  }, [selectedItem])

  useEffect(() => {
    schemaCacheRef.current = schemaCache
  }, [schemaCache])

  useEffect(() => () => {
    completionDisposableRef.current?.dispose?.()
    completionDisposableRef.current = null
  }, [])

  useEffect(() => {
    if (!activeConsole && consoles[0]) {
      setActiveConsoleId(consoles[0].id)
    }
  }, [activeConsole, consoles])

  useEffect(() => {
    if (activeConsole && !activeCell && activeConsole.cells[0]) {
      setActiveCellId(activeConsole.cells[0].id)
    }
  }, [activeConsole, activeCell])

  // Schema state
  const [schemaResult, setSchemaResult] = useState<QueryResult | null>(() => _viewState.schemaResult)
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [schemaError, setSchemaError] = useState(() => _viewState.schemaError)

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
    setActiveTab('query')
  }

  function selectCatalogItem(ct: CatalogTable) {
    const sqlName = ct.is_temporary ? ct.name : `${ct.database}.${ct.name}`
    setSelectedItem({ type: 'catalog', label: ct.name, sqlName, database: ct.database, isTemporary: ct.is_temporary })
    setPreviewPage(0)
    setSchemaResult(null)
    setSchemaError('')
    setActiveTab('query')
    fetchSchema(sqlName, ct.database)
  }

  function handleSqlSplitMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    const onMove = (moveEvent: MouseEvent) => {
      const container = sqlWorkspaceRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const relativeY = moveEvent.clientY - rect.top
      const nextTopPct = Math.max(25, Math.min(75, (relativeY / rect.height) * 100))
      setSqlResultsHeightPct(100 - nextTopPct)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function normalizeSqlIdentifier(value: string): string {
    return value.replace(/`/g, '').trim()
  }

  function resolveTableFromReference(reference: string, database: string): string | null {
    const normalized = normalizeSqlIdentifier(reference)
    const parts = normalized.split('.').filter(Boolean)
    if (parts.length === 0) return null
    if (parts.length === 1) return parts[0]
    if (parts.length === 2) return parts[1]
    if (parts[parts.length - 2] === database) return parts[parts.length - 1]
    return parts[parts.length - 1]
  }

  function parseAliasTableMap(sql: string, database: string): Record<string, string> {
    const aliasMap: Record<string, string> = {}
    const pattern = /\b(?:FROM|JOIN)\s+((?:`?[\w]+`?\.)?`?[\w]+`?)\s+(?:AS\s+)?([A-Za-z_][\w]*)/gi
    for (const match of sql.matchAll(pattern)) {
      const reference = match[1]
      const alias = match[2]
      const tableName = resolveTableFromReference(reference, database)
      if (tableName) aliasMap[alias.toUpperCase()] = tableName
    }
    return aliasMap
  }

  function getEditorDatabase(): string {
    return activeCellRef.current?.queryDb || selectedItemRef.current?.database || 'default'
  }

  async function introspectDatabase(database: string, options?: { force?: boolean }) {
    const existing = schemaCacheRef.current[database]
    if (existing?.loading) return
    if (existing?.loaded && !options?.force) return

    setSchemaCache(prev => ({
      ...prev,
      [database]: {
        loading: true,
        loaded: false,
        tables: prev[database]?.tables ?? [],
        error: undefined,
      },
    }))

    try {
      const result = await dataApi.introspectDatabase(database)
      setSchemaCache(prev => ({
        ...prev,
        [database]: {
          loading: false,
          loaded: true,
          tables: result.tables,
          error: undefined,
        },
      }))
    } catch (err) {
      setSchemaCache(prev => ({
        ...prev,
        [database]: {
          loading: false,
          loaded: false,
          tables: prev[database]?.tables ?? [],
          error: err instanceof Error ? err.message : String(err),
        },
      }))
    }
  }

  const beforeEditorMount: BeforeMount = (monaco) => {
    monaco.editor.defineTheme('sql-workspace-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0d1117',
        'editorGutter.background': '#0d1117',
        'editorLineNumber.foreground': '#6e7681',
        'editorLineNumber.activeForeground': '#c9d1d9',
      },
    })
    monaco.editor.defineTheme('sql-workspace-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#fafafa',
        'editorGutter.background': '#fafafa',
      },
    })

    if (completionDisposableRef.current) return
    completionDisposableRef.current = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.'],
      provideCompletionItems: (model: any, position: any) => {
        const database = getEditorDatabase()
        const schemaEntry = schemaCacheRef.current[database]
        if (!schemaEntry?.loaded || schemaEntry.tables.length === 0) {
          return { suggestions: [] }
        }

        const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
        const word = model.getWordUntilPosition(position)
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        }

        const aliasMatch = linePrefix.match(/([A-Za-z_][\w]*)\.\s*$/)
        if (aliasMatch) {
          const aliasMap = parseAliasTableMap(model.getValue(), database)
          const tableName = aliasMap[aliasMatch[1].toUpperCase()]
          if (!tableName) return { suggestions: [] }
          const table = schemaEntry.tables.find(t => t.name.toUpperCase() === tableName.toUpperCase())
          if (!table) return { suggestions: [] }
          return {
            suggestions: table.columns.map(column => ({
              label: column.name,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: column.name,
              detail: column.type || `Column from ${table.name}`,
              range,
            })),
          }
        }

        const lowerPrefix = word.word.toLowerCase()
        return {
          suggestions: schemaEntry.tables
            .filter(table => !lowerPrefix || table.name.toLowerCase().includes(lowerPrefix))
            .map(table => ({
              label: table.name,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: table.name,
              detail: `${table.columns.length} columns`,
              range,
            })),
        }
      },
    })
  }

  function createEditorMount(consoleId: string, cellId: string): OnMount {
    return (editor, monaco) => {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        runCell(consoleId, cellId)
      })
      editor.onDidFocusEditorText(() => {
        setActiveConsoleId(consoleId)
        setActiveCellId(cellId)
      })
    }
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

  function updateConsoleCell(consoleId: string, cellId: string, patch: Partial<SqlConsoleCell>) {
    setConsoles(prev => prev.map(c => c.id !== consoleId ? c : {
      ...c,
      cells: c.cells.map(cell => cell.id === cellId ? { ...cell, ...patch } : cell),
    }))
  }

  function addConsole() {
    setConsoles(prev => {
      const next = [...prev, createSqlConsole(prev.length + 1)]
      const created = next[next.length - 1]
      setActiveConsoleId(created.id)
      setActiveCellId(created.cells[0].id)
      setActiveTab('query')
      return next
    })
  }

  function closeConsole(consoleId: string) {
    setConsoles(prev => {
      if (prev.length <= 1) return prev
      const filtered = prev.filter(c => c.id !== consoleId)
      const nextActive = filtered[0]
      if (activeConsoleId === consoleId && nextActive) {
        setActiveConsoleId(nextActive.id)
        setActiveCellId(nextActive.cells[0]?.id ?? '')
      }
      return filtered
    })
  }

  function addCellToActiveConsole() {
    if (!activeConsole) return
    const newCell = createSqlCell('SELECT * FROM ...')
    setConsoles(prev => prev.map(c => c.id !== activeConsole.id ? c : { ...c, cells: [...c.cells, newCell] }))
    setActiveCellId(newCell.id)
  }

  function removeCell(consoleId: string, cellId: string) {
    setConsoles(prev => prev.map(c => {
      if (c.id !== consoleId) return c
      if (c.cells.length <= 1) return c
      const nextCells = c.cells.filter(cell => cell.id !== cellId)
      if (activeCellId === cellId) setActiveCellId(nextCells[0]?.id ?? '')
      return { ...c, cells: nextCells }
    }))
  }

  function openCellContextMenu(event: React.MouseEvent<HTMLElement>, consoleId: string, cellId: string) {
    event.preventDefault()
    setActiveConsoleId(consoleId)
    setActiveCellId(cellId)
    setCellMenuAnchor(event.currentTarget)
    setCellMenuTarget({ consoleId, cellId })
  }

  function closeCellContextMenu() {
    setCellMenuAnchor(null)
    setCellMenuTarget(null)
  }

  async function runCell(consoleId: string, cellId: string) {
    const console = consoles.find(c => c.id === consoleId)
    const cell = console?.cells.find(c => c.id === cellId)
    if (!cell || !cell.sql.trim()) return

    updateConsoleCell(consoleId, cellId, {
      running: true,
      error: null,
      result: null,
      page: 0,
      duration: null,
    })
    try {
      const result = await dataApi.query(cell.sql, cell.pageSize, 0, cell.queryDb || undefined)
      updateConsoleCell(consoleId, cellId, {
        result,
        duration: result.duration_ms ?? null,
        running: false,
      })
    } catch (err) {
      const parsed = parseQueryError(err)
      updateConsoleCell(consoleId, cellId, {
        error: {
          ...parsed,
          sparkMessage: sanitizeJvmNoise(parsed.sparkMessage),
          traceback: sanitizeJvmNoise(parsed.traceback),
        },
        running: false,
      })
    }
  }

  async function changeCellPage(consoleId: string, cellId: string, newPage: number) {
    const console = consoles.find(c => c.id === consoleId)
    const cell = console?.cells.find(c => c.id === cellId)
    if (!cell || !cell.sql.trim()) return
    updateConsoleCell(consoleId, cellId, { running: true, page: newPage })
    try {
      const result = await dataApi.query(cell.sql, cell.pageSize, newPage * cell.pageSize, cell.queryDb || undefined)
      updateConsoleCell(consoleId, cellId, {
        result,
        duration: result.duration_ms ?? null,
        running: false,
      })
    } catch (err) {
      const parsed = parseQueryError(err)
      updateConsoleCell(consoleId, cellId, {
        error: {
          ...parsed,
          sparkMessage: sanitizeJvmNoise(parsed.sparkMessage),
          traceback: sanitizeJvmNoise(parsed.traceback),
        },
        running: false,
      })
    }
  }

  function saveActiveConsole() {
    if (!activeConsole) return
    const joined = activeConsole.cells.map((c, i) => `-- Cell ${i + 1}\n${c.sql.trim() || ''}`).join('\n\n')
    const blob = new Blob([joined], { type: 'text/sql;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${activeConsole.name.replace(/\s+/g, '_').toLowerCase() || 'console'}.sql`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
  }

  function exportCellCsv(cell: SqlConsoleCell, delimiter: ',' | '\t') {
    if (!cell.result) return
    const esc = (v: unknown) => {
      const s = String(v ?? '')
      const needsQuote = s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(delimiter)
      const norm = s.replace(/"/g, '""')
      return needsQuote ? `"${norm}"` : norm
    }
    const header = cell.result.columns.map(esc).join(delimiter)
    const rows = (cell.result.rows ?? []).map(r => (r as unknown[]).map(esc).join(delimiter))
    const content = [header, ...rows].join('\n')
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `query_result.${delimiter === '\t' ? 'tsv' : 'csv'}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
  }

  function exportCellXlsx(cell: SqlConsoleCell) {
    if (!cell.result) return
    const rows = (cell.result.rows ?? []).map(r => {
      const obj: Record<string, unknown> = {}
      cell.result!.columns.forEach((c, idx) => { obj[c] = (r as unknown[])[idx] })
      return obj
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'QueryResult')
    XLSX.writeFile(wb, 'query_result.xlsx')
  }

  async function runQuery(sqlStr: string, db?: string, switchTab = true) {
    if (!sqlStr.trim()) return
    if (!activeConsole || !activeCell) return
    updateConsoleCell(activeConsole.id, activeCell.id, { sql: sqlStr, queryDb: db ?? activeCell.queryDb })
    if (switchTab) setActiveTab('query')
    await runCell(activeConsole.id, activeCell.id)
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

  useEffect(() => {
    _viewState.leftSearch = leftSearch
    _viewState.leftCollapsed = leftCollapsed
    _viewState.rightCollapsed = rightCollapsed
    _viewState.selectedItem = selectedItem
    _viewState.activeTab = activeTab
    _viewState.previewPage = previewPage
    _viewState.previewPageSize = previewPageSize
    _viewState.consoles = consoles
    _viewState.activeConsoleId = activeConsoleId
    _viewState.activeCellId = activeCellId
    _viewState.sqlResultsHeightPct = sqlResultsHeightPct
    _viewState.schemaCache = schemaCache
    _viewState.schemaResult = schemaResult
    _viewState.schemaError = schemaError

    try {
      localStorage.setItem('dataExplorer.sqlConsoles', JSON.stringify({
        consoles,
        activeConsoleId,
        activeCellId,
        sqlResultsHeightPct,
      }))
    } catch {
      // ignore localStorage failures
    }
  }, [
    leftSearch,
    leftCollapsed,
    rightCollapsed,
    selectedItem,
    activeTab,
    previewPage,
    previewPageSize,
    consoles,
    activeConsoleId,
    activeCellId,
    sqlResultsHeightPct,
    schemaCache,
    schemaResult,
    schemaError,
  ])

  useEffect(() => {
    try {
      const raw = localStorage.getItem('dataExplorer.sqlConsoles')
      if (!raw) return
      const parsed = JSON.parse(raw) as { consoles?: SqlConsole[]; activeConsoleId?: string; activeCellId?: string }
      if (parsed.consoles && parsed.consoles.length > 0) {
        setConsoles(parsed.consoles)
        setActiveConsoleId(parsed.activeConsoleId || parsed.consoles[0].id)
        setActiveCellId(parsed.activeCellId || parsed.consoles[0].cells[0]?.id || '')
      }
      if (typeof (parsed as { sqlResultsHeightPct?: number }).sqlResultsHeightPct === 'number') {
        setSqlResultsHeightPct((parsed as { sqlResultsHeightPct?: number }).sqlResultsHeightPct || 46)
      }
    } catch {
      // ignore malformed local storage
    }
  }, [])

  useEffect(() => {
    const onToggleLeft = () => setLeftCollapsed(v => !v)
    const onToggleRight = () => setRightCollapsed(v => !v)
    window.addEventListener('workspace-panel-toggle-left', onToggleLeft)
    window.addEventListener('workspace-panel-toggle-right', onToggleRight)
    return () => {
      window.removeEventListener('workspace-panel-toggle-left', onToggleLeft)
      window.removeEventListener('workspace-panel-toggle-right', onToggleRight)
    }
  }, [])

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
      setSchemaCache({})
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
      setSchemaCache({})
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
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

      {/* ── LEFT PANEL ───────────────────────────────────────────────────────── */}
      {!leftCollapsed && (
      <Box sx={{
        width: 280, flexShrink: 0,
        bgcolor: leftBg,
        borderRight: `1px solid ${theme.palette.divider}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <Box sx={{ p: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, letterSpacing: '0.01em' }}>
            Data Explorer
          </Typography>
        </Box>

        {/* Search */}
        <Box sx={{ p: 1, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <TextField
            placeholder="Search tables…"
            value={leftSearch}
            onChange={e => setLeftSearch(e.target.value)}
            size="small"
            fullWidth
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Search sx={{ fontSize: 16 }} />
                  </InputAdornment>
                ),
              },
              htmlInput: { style: { fontSize: '0.78rem', paddingTop: 4, paddingBottom: 4 } },
            }}
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
                    const schemaEntry = schemaCache[db]
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
                          {schemaEntry?.loaded && (
                            <Chip label="schema" size="small" color="success" variant="outlined" sx={{ height: 14, fontSize: '0.56rem', mr: 0.5 }} />
                          )}
                          <Tooltip title={schemaEntry?.loading ? `Introspecting ${db}...` : `Introspect ${db} tables and columns for SQL autocomplete`}>
                            <span>
                              <IconButton
                                size="small"
                                disabled={schemaEntry?.loading}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  introspectDatabase(db, { force: true })
                                }}
                                sx={{ p: 0.25, mr: 0.35 }}
                              >
                                {schemaEntry?.loading ? <CircularProgress size={11} /> : <Visibility sx={{ fontSize: 12 }} />}
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Chip label={totalCount} size="small" sx={{ height: 14, fontSize: '0.6rem' }} />
                        </Box>
                        <Collapse in={dbExpanded}>
                          {schemaEntry?.error && (
                            <Typography sx={{ px: 4, pt: 0.25, pb: 0.5, fontSize: '0.66rem', color: 'error.main' }}>
                              {schemaEntry.error}
                            </Typography>
                          )}
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
      )}

      {/* ── RIGHT PANEL ──────────────────────────────────────────────────────── */}
      {!rightCollapsed && (
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
              const dbPart = selectedItem?.database ?? activeCell?.queryDb
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
                  <Typography variant="body1" sx={{ fontWeight: 500 }}>Select a table or file to preview</Typography>
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
                  <Typography variant="body1" sx={{ fontWeight: 500 }}>Select a Spark catalog table to view its schema</Typography>
                </Box>
              ) : schemaError ? (
                <Alert severity="error" sx={{ m: 2 }}>{schemaError}</Alert>
              ) : schemaLoading || !schemaResult ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}><CircularProgress size={28} /></Box>
              ) : (
                <Box>
                  <Box sx={{ px: 2, py: 1, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="subtitle2" sx={{ fontFamily: 'monospace' }}>{selectedItem.sqlName}</Typography>
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
              {/* Console tabs */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5, borderBottom: `1px solid ${theme.palette.divider}`, bgcolor: 'background.paper', overflowX: 'auto' }}>
                {consoles.map(c => {
                  const active = c.id === (activeConsole?.id ?? '')
                  return (
                    <Box key={c.id} sx={{ display: 'flex', alignItems: 'center', borderRadius: 1, border: `1px solid ${active ? theme.palette.primary.main : theme.palette.divider}`, bgcolor: active ? alpha(theme.palette.primary.main, 0.12) : 'transparent', px: 0.75, py: 0.35 }}>
                      <Typography sx={{ fontSize: '0.75rem', cursor: 'pointer' }} onClick={() => { setActiveConsoleId(c.id); setActiveCellId(c.cells[0]?.id ?? '') }}>
                        {c.name}
                      </Typography>
                      <IconButton size="small" onClick={() => closeConsole(c.id)} sx={{ ml: 0.3, p: 0.2 }}>
                        <Close sx={{ fontSize: 13 }} />
                      </IconButton>
                    </Box>
                  )
                })}
                <Tooltip title="New console">
                  <IconButton size="small" onClick={addConsole}>
                    <Add sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Save active console (.sql)">
                  <span>
                    <IconButton size="small" onClick={saveActiveConsole} disabled={!activeConsole}>
                      <Save sx={{ fontSize: 15 }} />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>

              {/* Cells + results */}
              <Box ref={sqlWorkspaceRef} sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: `minmax(180px, ${100 - sqlResultsHeightPct}%) 6px minmax(160px, ${sqlResultsHeightPct}%)`, overflow: 'hidden' }}>
                <Box sx={{ overflow: 'auto', p: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>
                      SQL Cells
                    </Typography>
                    <Button size="small" variant="outlined" startIcon={<Add sx={{ fontSize: 14 }} />} onClick={addCellToActiveConsole}>
                      Add Cell
                    </Button>
                  </Box>

                  {(activeConsole?.cells ?? []).map((cell, idx) => {
                    const isActiveCell = cell.id === activeCell?.id
                    const cellDatabase = cell.queryDb || selectedItem?.database || 'default'
                    const cellSchemaEntry = schemaCache[cellDatabase]
                    return (
                      <Box
                        key={cell.id}
                        onContextMenu={(event: React.MouseEvent<HTMLElement>) => openCellContextMenu(event, activeConsole!.id, cell.id)}
                        sx={{ border: `1px solid ${isActiveCell ? theme.palette.primary.main : theme.palette.divider}`, borderRadius: 1, overflow: 'hidden', bgcolor: isActiveCell ? alpha(theme.palette.primary.main, 0.04) : 'background.paper' }}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.4, borderBottom: `1px solid ${theme.palette.divider}` }} onClick={() => setActiveCellId(cell.id)}>
                          <Button
                            size="small"
                            color="success"
                            variant="contained"
                            onClick={(event) => {
                              event.stopPropagation()
                              runCell(activeConsole!.id, cell.id)
                            }}
                            disabled={cell.running || !cell.sql.trim()}
                            startIcon={cell.running ? <CircularProgress size={12} color="inherit" /> : <PlayArrow sx={{ fontSize: 14 }} />}
                            sx={{ fontSize: '0.7rem', py: 0.2, minWidth: 68 }}
                          >
                            Run
                          </Button>
                          <Typography sx={{ fontSize: '0.72rem', fontWeight: 700 }}>Cell {idx + 1}</Typography>
                          <FormControl size="small" sx={{ minWidth: 140, ml: 0.5 }}>
                            <Select
                              value={cell.queryDb}
                              displayEmpty
                              onChange={e => updateConsoleCell(activeConsole!.id, cell.id, { queryDb: e.target.value })}
                              sx={{ fontSize: '0.72rem', height: 24 }}
                            >
                              <MenuItem value="" sx={{ fontSize: '0.75rem' }}>(default db)</MenuItem>
                              {databases.map(db => (
                                <MenuItem key={db} value={db} sx={{ fontSize: '0.75rem' }}>{db}</MenuItem>
                              ))}
                            </Select>
                          </FormControl>
                          <Tooltip
                            title={cellSchemaEntry?.loaded
                              ? `Autocomplete ready for ${cellDatabase}`
                              : `Introspect ${cellDatabase} from the left catalog tree to enable column suggestions`}
                          >
                            <Chip
                              label={cellSchemaEntry?.loaded ? 'Autocomplete ready' : 'Needs introspection'}
                              size="small"
                              color={cellSchemaEntry?.loaded ? 'success' : 'default'}
                              variant={cellSchemaEntry?.loaded ? 'filled' : 'outlined'}
                              sx={{ height: 18, fontSize: '0.62rem' }}
                            />
                          </Tooltip>
                          <Box sx={{ flex: 1 }} />
                          {cell.duration != null && !cell.running && (
                            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{fmtMs(cell.duration)}</Typography>
                          )}
                          <IconButton size="small" onClick={() => removeCell(activeConsole!.id, cell.id)}>
                            <DeleteOutlined sx={{ fontSize: 14 }} />
                          </IconButton>
                        </Box>
                        <Box onClick={() => setActiveCellId(cell.id)} sx={{ minHeight: 172, bgcolor: theme.palette.mode === 'dark' ? '#0d1117' : '#fafafa' }}>
                          <Editor
                            path={`data-explorer/${activeConsole!.id}/${cell.id}.sql`}
                            defaultLanguage="sql"
                            value={cell.sql}
                            beforeMount={beforeEditorMount}
                            onMount={createEditorMount(activeConsole!.id, cell.id)}
                            onChange={(value) => updateConsoleCell(activeConsole!.id, cell.id, { sql: value ?? '' })}
                            theme={theme.palette.mode === 'dark' ? 'sql-workspace-dark' : 'sql-workspace-light'}
                            options={{
                              minimap: { enabled: false },
                              fontSize: 13,
                              fontFamily: 'JetBrains Mono, Consolas, Courier New, monospace',
                              lineNumbers: 'on',
                              wordWrap: 'on',
                              automaticLayout: true,
                              scrollBeyondLastLine: false,
                              quickSuggestions: true,
                              suggestOnTriggerCharacters: true,
                              tabSize: 2,
                              padding: { top: 10, bottom: 10 },
                              contextmenu: false,
                            }}
                            height="172px"
                          />
                        </Box>
                      </Box>
                    )
                  })}
                </Box>

                <Box
                  onMouseDown={handleSqlSplitMouseDown}
                  sx={{
                    cursor: 'row-resize',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: 'background.paper',
                    borderTop: `1px solid ${theme.palette.divider}`,
                    borderBottom: `1px solid ${theme.palette.divider}`,
                    '&:hover .sql-split-handle': { bgcolor: 'primary.main', opacity: 0.7 },
                  }}
                >
                  <Box className="sql-split-handle" sx={{ width: 52, height: 3, borderRadius: 999, bgcolor: 'divider', transition: 'all 0.15s' }} />
                </Box>

                <Box sx={{ borderTop: `1px solid ${theme.palette.divider}`, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1, py: 0.6, borderBottom: `1px solid ${theme.palette.divider}`, bgcolor: 'background.paper' }}>
                    <Typography variant="caption" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Results
                    </Typography>
                    <Box sx={{ flex: 1 }} />
                    <Tooltip title="Export CSV (comma)">
                      <span>
                        <Button size="small" variant="outlined" startIcon={<FileDownload sx={{ fontSize: 14 }} />} disabled={!activeCell?.result} onClick={() => activeCell && exportCellCsv(activeCell, ',')}>
                          CSV
                        </Button>
                      </span>
                    </Tooltip>
                    <Tooltip title="Export TSV (tab)">
                      <span>
                        <Button size="small" variant="outlined" disabled={!activeCell?.result} onClick={() => activeCell && exportCellCsv(activeCell, '\t')}>
                          TSV
                        </Button>
                      </span>
                    </Tooltip>
                    <Tooltip title="Export XLSX">
                      <span>
                        <Button size="small" variant="outlined" disabled={!activeCell?.result} onClick={() => activeCell && exportCellXlsx(activeCell)}>
                          XLSX
                        </Button>
                      </span>
                    </Tooltip>
                  </Box>

                  <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    {activeCell?.error && (
                      <Alert severity="error" sx={{ m: 1.2, flexShrink: 0 }}>
                        <Typography sx={{ fontWeight: 700, mb: 0.5 }}>
                          {activeCell.error.statusCode ? `SQL execution failed (${activeCell.error.statusCode})` : 'SQL execution failed'}
                        </Typography>
                        <Typography sx={{ mb: 0.5 }}>{activeCell.error.message}</Typography>
                        {activeCell.error.sparkMessage && (
                          <Box component="pre" sx={{ m: 0, mt: 0.25, p: 1, borderRadius: 1, overflowX: 'auto', bgcolor: 'rgba(0,0,0,0.08)', fontFamily: 'monospace', fontSize: '0.74rem', whiteSpace: 'pre-wrap' }}>
                            {sanitizeJvmNoise(activeCell.error.sparkMessage)}
                          </Box>
                        )}
                      </Alert>
                    )}

                    {activeCell?.running && (
                      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
                        <CircularProgress size={24} />
                      </Box>
                    )}

                    {activeCell?.result && !activeCell.running && (
                      <RichGrid
                        columns={activeCell.result.columns}
                        rows={activeCell.result.rows}
                        loading={false}
                        page={activeCell.page}
                        pageSize={activeCell.pageSize}
                        truncated={activeCell.result.truncated}
                        totalRows={activeCell.result.total_rows}
                        onPageChange={p => changeCellPage(activeConsole!.id, activeCell.id, p)}
                        onPageSizeChange={s => {
                          updateConsoleCell(activeConsole!.id, activeCell.id, { pageSize: s, page: 0 })
                          changeCellPage(activeConsole!.id, activeCell.id, 0)
                        }}
                      />
                    )}

                    {!activeCell?.running && !activeCell?.result && !activeCell?.error && (
                      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'text.secondary', gap: 1 }}>
                        <PlayArrow sx={{ fontSize: 36, opacity: 0.2 }} />
                        <Typography variant="body2">Run a SQL cell to view results</Typography>
                        <Typography variant="caption" color="text.disabled">Ctrl/Cmd + Enter runs the focused cell</Typography>
                      </Box>
                    )}
                  </Box>
                </Box>
              </Box>

              <Menu
                anchorEl={cellMenuAnchor}
                open={Boolean(cellMenuAnchor)}
                onClose={closeCellContextMenu}
              >
                <MenuItem
                  onClick={() => {
                    if (cellMenuTarget) runCell(cellMenuTarget.consoleId, cellMenuTarget.cellId)
                    closeCellContextMenu()
                  }}
                >
                  Run Cell
                </MenuItem>
              </Menu>
            </Box>
          )}

        </Box>
      </Box>
      )}
      </Box>
    </Box>
  )
}
