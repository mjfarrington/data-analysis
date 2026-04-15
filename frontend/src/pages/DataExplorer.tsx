import { useState, useEffect } from 'react'
import {
  Box, Typography, Card, CardContent, Grid, Button, TextField, CircularProgress,
  Table, TableHead, TableBody, TableRow, TableCell, Chip, alpha, useTheme,
  Tooltip, IconButton, Alert, Paper, Collapse, LinearProgress, Divider,
  List, ListItemButton, ListItemIcon, ListItemText, ListSubheader,
  Tab, Tabs, Badge, Select, MenuItem, FormControl, InputLabel,
  Dialog, DialogTitle, DialogContent, DialogActions, DialogContentText,
} from '@mui/material'
import {
  PlayArrow, Refresh, Storage, ExpandMore, Code, TableChart,
  FolderOpen, TableView, Visibility, DeleteOutline, DeleteSweep,
  OpenInNew, FilterList, CalendarMonth,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { dataApi, DataTable, CatalogTable } from '../api/client'
import { formatDistanceToNow } from 'date-fns'
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

function FileTableCard({ table, onPreview }: { table: DataTable; onPreview: (name: string) => void }) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)

  return (
    <Card variant="outlined" sx={{ mb: 1 }}>
      <CardContent sx={{ pb: '12px !important', pt: 1.5, px: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Storage sx={{ color: 'primary.main', fontSize: 18, flexShrink: 0 }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" fontWeight={600} noWrap sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.78rem' }}>
              {table.name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {fmtBytes(table.size_bytes)} · {table.format.toUpperCase()}
              {table.last_modified && ` · ${formatDistanceToNow(new Date(table.last_modified), { addSuffix: true })}`}
            </Typography>
          </Box>
          <IconButton size="small" onClick={() => setExpanded((e) => !e)}>
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

function CatalogTableList({
  tables,
  onSelect,
  selected,
  onDeleteTable,
  onDeleteDb,
}: {
  tables: CatalogTable[]
  onSelect: (t: CatalogTable) => void
  selected: CatalogTable | null
  onDeleteTable: (db: string, table: string) => void
  onDeleteDb: (db: string) => void
}) {
  const theme = useTheme()
  const grouped: Record<string, CatalogTable[]> = {}
  for (const t of tables) {
    const db = t.database || 'default'
    if (!grouped[db]) grouped[db] = []
    grouped[db].push(t)
  }

  if (!tables.length) {
    return (
      <Alert severity="info" sx={{ fontSize: '0.78rem' }}>
        No catalog tables yet. Run an ETL pipeline with <strong>Spark Table</strong> target to register one.
      </Alert>
    )
  }

  return (
    <Box sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: 1, overflow: 'hidden' }}>
      {Object.entries(grouped).map(([db, rows]) => (
        <List key={db} dense disablePadding
          subheader={
            <ListSubheader sx={{ lineHeight: '28px', fontSize: '0.7rem', bgcolor: alpha(theme.palette.primary.main, 0.05), display: 'flex', alignItems: 'center' }}>
              <FolderOpen sx={{ fontSize: 13, mr: 0.5, verticalAlign: 'middle' }} />
              <span style={{ flex: 1 }}>{db}</span>
              <Chip label={`${rows.length}`} size="small" sx={{ fontSize: '0.62rem', height: 16, mr: 0.5 }} />
              <Tooltip title={`Drop database "${db}" (CASCADE)`}>
                <IconButton size="small" color="error" onClick={(e) => { e.stopPropagation(); onDeleteDb(db) }}
                  sx={{ p: 0.25, ml: 0.5 }}>
                  <DeleteSweep sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </ListSubheader>
          }
        >
          {rows.map((t) => (
            <ListItemButton
              key={t.name}
              selected={selected?.name === t.name && selected?.database === t.database}
              onClick={() => onSelect(t)}
              sx={{ py: 0.5, pl: 2, pr: 1, '&:hover .del-btn': { opacity: 1 } }}
            >
              <ListItemIcon sx={{ minWidth: 28 }}>
                <TableView sx={{ fontSize: 16, color: t.is_temporary ? 'warning.main' : 'primary.main' }} />
              </ListItemIcon>
              <ListItemText
                primary={t.name}
                primaryTypographyProps={{ variant: 'body2', fontFamily: '"JetBrains Mono", monospace', fontSize: '0.78rem', noWrap: true }}
              />
              {t.is_temporary && <Chip label="temp" size="small" color="warning" variant="outlined" sx={{ fontSize: '0.62rem', height: 16, mr: 0.5 }} />}
              <Tooltip title={`Drop table "${t.name}"`}>
                <IconButton size="small" color="error" className="del-btn"
                  sx={{ p: 0.25, opacity: 0, transition: 'opacity 0.15s' }}
                  onClick={(e) => { e.stopPropagation(); onDeleteTable(db, t.name) }}>
                  <DeleteOutline sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </ListItemButton>
          ))}
        </List>
      ))}
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
  const [limit, setLimit] = useState(1000)
  const [browserTab, setBrowserTab] = useState(0)
  const [selectedCatalogTable, setSelectedCatalogTable] = useState<CatalogTable | null>(null)
  const [dbFilter, setDbFilter] = useState<string>('')
  const [activeDb, setActiveDb] = useState<string>('')  // database context for SQL execution
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'table' | 'database'; db: string; table?: string } | null>(null)
  const [loadDialogOpen, setLoadDialogOpen] = useState(false)
  const [loadDialogDb, setLoadDialogDb] = useState<string>('')

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

  // Pre-select database from URL ?db= param
  useEffect(() => {
    const db = searchParams.get('db')
    if (db) { setDbFilter(db); setActiveDb(db) }
  }, [searchParams])

  const uniqueDbs = [...new Set((catalogTables ?? []).map((t) => t.database || 'default'))].sort()
  const filteredTables = dbFilter
    ? (catalogTables ?? []).filter((t) => (t.database || 'default') === dbFilter)
    : (catalogTables ?? [])

  const queryMutation = useMutation({
    mutationFn: ({ sql, limit, database }: { sql: string; limit: number; database?: string }) =>
      dataApi.query(sql, limit, database).then((r) => r.data),
  })

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
      if (dbFilter === db) setDbFilter('')
      if (activeDb === db) setActiveDb('')
      if (selectedCatalogTable?.database === db) setSelectedCatalogTable(null)
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const handleExecute = () => queryMutation.mutate({ sql, limit, database: activeDb || undefined })

  const handlePreviewTable = (t: CatalogTable) => {
    setSelectedCatalogTable(t)
    const db = t.database || 'default'
    const fullName = `\`${t.name}\``
    setSql(`SELECT *\nFROM ${fullName}\nLIMIT 100`)
    setActiveDb(db)
    queryMutation.mutate({ sql: `SELECT * FROM ${fullName} LIMIT 100`, limit, database: db })
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
    }
    setDeleteConfirm(null)
  }

  const refetchAll = () => { refetchFiles(); refetchCatalog() }
  const isLoading = fileTablesLoading || catalogLoading

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>Data Explorer</Typography>
          <Typography variant="caption" color="text.secondary">Browse catalog tables and query Spark DataFrames</Typography>
        </Box>
        <Tooltip title="Refresh all">
          <IconButton onClick={refetchAll} disabled={isLoading}>
            <Refresh />
          </IconButton>
        </Tooltip>
      </Box>

      <Grid container spacing={2}>
        {/* ── Left panel: table browser ── */}
        <Grid item xs={12} md={4}>
          <Card variant="outlined" sx={{ height: '100%' }}>
            <CardContent sx={{ pb: 1 }}>
              <Tabs value={browserTab} onChange={(_, v) => setBrowserTab(v)} sx={{ mb: 1.5, minHeight: 32 }}
                TabIndicatorProps={{ style: { height: 2 } }}
              >
                <Tab label={
                  <Badge badgeContent={catalogTables?.length ?? 0} color="primary" max={99}
                    sx={{ '& .MuiBadge-badge': { fontSize: '0.6rem', height: 16, minWidth: 16 } }}>
                    <Typography variant="caption" fontWeight={600}>Catalog Tables</Typography>
                  </Badge>
                } sx={{ minHeight: 32, py: 0.5, px: 1.5 }} />
                <Tab label={
                  <Badge badgeContent={fileTables?.length ?? 0} color="default" max={99}
                    sx={{ '& .MuiBadge-badge': { fontSize: '0.6rem', height: 16, minWidth: 16 } }}>
                    <Typography variant="caption" fontWeight={600}>File Store</Typography>
                  </Badge>
                } sx={{ minHeight: 32, py: 0.5, px: 1.5 }} />
              </Tabs>

              {/* Catalog tab */}
              {browserTab === 0 && (
                <>
                  {/* Database selector — always visible */}
                  <Box sx={{ display: 'flex', gap: 1, mb: 1.5, alignItems: 'center' }}>
                    <FilterList sx={{ fontSize: 16, color: 'text.secondary', flexShrink: 0 }} />
                    <FormControl size="small" fullWidth>
                      <InputLabel sx={{ fontSize: '0.78rem' }}>Database</InputLabel>
                      <Select
                        value={dbFilter}
                        label="Database"
                        onChange={(e) => {
                          const db = e.target.value
                          setDbFilter(db)
                          setActiveDb(db)
                        }}
                        sx={{ fontSize: '0.78rem', fontFamily: '"JetBrains Mono", monospace' }}
                      >
                        <MenuItem value="" sx={{ fontSize: '0.78rem' }}>
                          <em>All databases ({catalogTables?.length ?? 0} tables)</em>
                        </MenuItem>
                        {uniqueDbs.map((db) => (
                          <MenuItem key={db} value={db} sx={{ fontSize: '0.78rem', fontFamily: '"JetBrains Mono", monospace' }}>
                            {db}
                            <Chip label={(catalogTables ?? []).filter((t) => (t.database || 'default') === db).length}
                              size="small" sx={{ ml: 1, fontSize: '0.62rem', height: 16 }} />
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <Tooltip title="Load Extracted Data">
                      <IconButton size="small" color="primary" onClick={() => { setLoadDialogDb(dbFilter); setLoadDialogOpen(true) }}>
                        <OpenInNew sx={{ fontSize: 18 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>

                  {catalogLoading ? <LinearProgress /> : (
                    <CatalogTableList
                      tables={filteredTables}
                      selected={selectedCatalogTable}
                      onSelect={(t) => { setSelectedCatalogTable(t); handleUseTable(t) }}
                      onDeleteTable={(db, table) => setDeleteConfirm({ type: 'table', db, table })}
                      onDeleteDb={(db) => setDeleteConfirm({ type: 'database', db })}
                    />
                  )}
                  {selectedCatalogTable && (
                    <Box sx={{ mt: 1.5, display: 'flex', gap: 1 }}>
                      <Button
                        size="small" variant="outlined" fullWidth startIcon={<TableChart />}
                        onClick={() => {
                          const db = selectedCatalogTable.database || 'default'
                          const name = selectedCatalogTable.name
                          setSql(`DESCRIBE \`${name}\``)
                          setActiveDb(db)
                          queryMutation.mutate({ sql: `DESCRIBE \`${name}\``, limit: 200, database: db })
                        }}
                      >
                        Describe
                      </Button>
                      <Button
                        size="small" variant="contained" fullWidth startIcon={<Visibility />}
                        onClick={() => handlePreviewTable(selectedCatalogTable)}
                      >
                        Preview
                      </Button>
                    </Box>
                  )}
                </>
              )}

              {/* File store tab */}
              {browserTab === 1 && (
                <>
                  {fileTablesLoading ? <LinearProgress /> : !fileTables?.length ? (
                    <Alert severity="info" sx={{ fontSize: '0.78rem' }}>No stored data yet. Run an ETL pipeline to populate.</Alert>
                  ) : (
                    <Box>
                      {fileTables.map((t) => (
                        <FileTableCard key={t.name} table={t} onPreview={() => {}} />
                      ))}
                    </Box>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* ── Right panel: SQL editor + results ── */}
        <Grid item xs={12} md={8}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5, gap: 1 }}>
                <Code sx={{ color: 'primary.main' }} />
                <Typography variant="subtitle2" fontWeight={600} sx={{ flex: 1 }}>
                  SQL Query
                  {activeDb && (
                    <Chip
                      label={activeDb}
                      size="small"
                      color="primary"
                      onDelete={() => setActiveDb('')}
                      sx={{ ml: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: '0.7rem', height: 20, verticalAlign: 'middle' }}
                    />
                  )}
                </Typography>
                <TextField
                  label="Limit" type="number" size="small" value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                  sx={{ width: 100 }}
                  inputProps={{ min: 1, max: 10000 }}
                />
                <Button
                  variant="contained"
                  startIcon={queryMutation.isPending ? <CircularProgress size={14} color="inherit" /> : <PlayArrow />}
                  onClick={handleExecute}
                  disabled={queryMutation.isPending || !sql.trim()}
                >
                  Execute
                </Button>
              </Box>

              {/* Sample queries */}
              <Box sx={{ display: 'flex', gap: 0.75, mb: 1.5, flexWrap: 'wrap' }}>
                {SAMPLE_QUERIES.map((q) => (
                  <Chip
                    key={q.label}
                    label={q.label}
                    size="small"
                    variant="outlined"
                    onClick={() => setSql(q.sql)}
                    sx={{ cursor: 'pointer', fontSize: '0.7rem' }}
                  />
                ))}
              </Box>

              <TextField
                multiline
                rows={6}
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                fullWidth
                placeholder="SELECT * FROM your_table LIMIT 100"
                inputProps={{ style: { fontFamily: '"JetBrains Mono", monospace', fontSize: '0.85rem' } }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    handleExecute()
                  }
                }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                Ctrl/Cmd+Enter to execute · Only SELECT, SHOW, DESCRIBE allowed
                {activeDb && <> · context: <strong style={{ fontFamily: 'monospace' }}>{activeDb}</strong></>}
              </Typography>

              {queryMutation.isError && (
                <Alert severity="error" sx={{ mt: 1 }}>{(queryMutation.error as Error).message}</Alert>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* ── Full-width results ── */}
      {queryMutation.data && (
        <Box sx={{ mt: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 1, gap: 1 }}>
            <Typography variant="subtitle2" fontWeight={600}>Results</Typography>
            <Typography variant="caption" color="text.secondary">
              {queryMutation.data.row_count.toLocaleString()} rows · {queryMutation.data.duration_ms.toFixed(0)}ms
            </Typography>
            {queryMutation.data.truncated && (
              <Chip label="Truncated" size="small" color="warning" />
            )}
          </Box>
          <Paper variant="outlined" sx={{ overflow: 'auto', maxHeight: 500 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ whiteSpace: 'nowrap', fontSize: '0.75rem', fontWeight: 600, color: 'text.disabled', width: 60, minWidth: 60 }}>
                    #
                  </TableCell>
                  {queryMutation.data.columns.map((col) => (
                    <TableCell key={col} sx={{ whiteSpace: 'nowrap', fontFamily: '"JetBrains Mono", monospace', fontSize: '0.75rem', fontWeight: 600 }}>
                      {col}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {queryMutation.data.rows.map((row, i) => (
                  <TableRow key={i} sx={{ '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.04) } }}>
                    <TableCell sx={{ fontSize: '0.72rem', color: 'text.disabled', userSelect: 'none', width: 60, minWidth: 60 }}>
                      {i + 1}
                    </TableCell>
                    {row.map((cell, j) => (
                      <TableCell key={j} sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.78rem', whiteSpace: 'nowrap', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {cell === null ? <span style={{ color: theme.palette.text.disabled }}>(null)</span> : String(cell)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Box>
      )}

      {/* ── Delete confirmation dialog ── */}
      <Dialog open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ color: 'error.main' }}>
          {deleteConfirm?.type === 'database' ? 'Drop Database' : 'Drop Table'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {deleteConfirm?.type === 'database'
              ? <>Drop database <strong style={{ fontFamily: 'monospace' }}>{deleteConfirm.db}</strong> and <strong>all its tables</strong>? This cannot be undone.</>
              : <>Drop table <strong style={{ fontFamily: 'monospace' }}>{deleteConfirm?.db}.{deleteConfirm?.table}</strong>? This cannot be undone.</>
            }
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirm(null)}>Cancel</Button>
          <Button color="error" variant="contained"
            onClick={handleConfirmDelete}
            disabled={dropTableMutation.isPending || dropDatabaseMutation.isPending}
          >
            {dropTableMutation.isPending || dropDatabaseMutation.isPending ? <CircularProgress size={16} color="inherit" /> : 'Drop'}
          </Button>
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
