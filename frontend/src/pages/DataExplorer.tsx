import { useState } from 'react'
import {
  Box, Typography, Card, CardContent, Grid, Button, TextField, CircularProgress,
  Table, TableHead, TableBody, TableRow, TableCell, Chip, alpha, useTheme,
  Tooltip, IconButton, Alert, Paper, Collapse, LinearProgress, Divider,
  List, ListItemButton, ListItemIcon, ListItemText, ListSubheader,
  Tab, Tabs, Badge,
} from '@mui/material'
import {
  PlayArrow, Refresh, Storage, ExpandMore, Code, TableChart,
  FolderOpen, TableView, Visibility,
} from '@mui/icons-material'
import { useQuery, useMutation } from '@tanstack/react-query'
import { dataApi, DataTable, CatalogTable } from '../api/client'
import { formatDistanceToNow } from 'date-fns'

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
}: {
  tables: CatalogTable[]
  onSelect: (t: CatalogTable) => void
  selected: CatalogTable | null
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
            <ListSubheader sx={{ lineHeight: '28px', fontSize: '0.7rem', bgcolor: alpha(theme.palette.primary.main, 0.05) }}>
              <FolderOpen sx={{ fontSize: 13, mr: 0.5, verticalAlign: 'middle' }} />
              {db}
            </ListSubheader>
          }
        >
          {rows.map((t) => (
            <ListItemButton
              key={t.name}
              selected={selected?.name === t.name && selected?.database === t.database}
              onClick={() => onSelect(t)}
              sx={{ py: 0.5, pl: 2 }}
            >
              <ListItemIcon sx={{ minWidth: 28 }}>
                <TableView sx={{ fontSize: 16, color: t.is_temporary ? 'warning.main' : 'primary.main' }} />
              </ListItemIcon>
              <ListItemText
                primary={t.name}
                primaryTypographyProps={{ variant: 'body2', fontFamily: '"JetBrains Mono", monospace', fontSize: '0.78rem', noWrap: true }}
              />
              {t.is_temporary && <Chip label="temp" size="small" color="warning" variant="outlined" sx={{ fontSize: '0.62rem', height: 16 }} />}
            </ListItemButton>
          ))}
        </List>
      ))}
    </Box>
  )
}

export default function DataExplorer() {
  const theme = useTheme()
  const [sql, setSql] = useState('SELECT 1 AS test')
  const [limit, setLimit] = useState(1000)
  const [browserTab, setBrowserTab] = useState(0)
  const [selectedCatalogTable, setSelectedCatalogTable] = useState<CatalogTable | null>(null)

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

  const queryMutation = useMutation({
    mutationFn: ({ sql, limit }: { sql: string; limit: number }) =>
      dataApi.query(sql, limit).then((r) => r.data),
  })

  const handleExecute = () => queryMutation.mutate({ sql, limit })

  const handlePreviewTable = (t: CatalogTable) => {
    setSelectedCatalogTable(t)
    const fullName = t.database ? `${t.database}.${t.name}` : t.name
    setSql(`SELECT *\nFROM ${fullName}\nLIMIT 100`)
    queryMutation.mutate({ sql: `SELECT * FROM ${fullName} LIMIT 100`, limit })
  }

  const handleUseTable = (t: CatalogTable) => {
    const fullName = t.database ? `${t.database}.${t.name}` : t.name
    setSql(`SELECT *\nFROM ${fullName}\nLIMIT 100`)
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
                  {catalogLoading ? <LinearProgress /> : (
                    <CatalogTableList
                      tables={catalogTables ?? []}
                      selected={selectedCatalogTable}
                      onSelect={(t) => {
                        setSelectedCatalogTable(t)
                        handleUseTable(t)
                      }}
                    />
                  )}
                  {selectedCatalogTable && (
                    <Box sx={{ mt: 1.5, display: 'flex', gap: 1 }}>
                      <Button
                        size="small" variant="outlined" fullWidth startIcon={<TableChart />}
                        onClick={() => {
                          const fullName = selectedCatalogTable.database
                            ? `${selectedCatalogTable.database}.${selectedCatalogTable.name}`
                            : selectedCatalogTable.name
                          setSql(`DESCRIBE ${fullName}`)
                          queryMutation.mutate({ sql: `DESCRIBE ${fullName}`, limit: 200 })
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
                <Typography variant="subtitle2" fontWeight={600} sx={{ flex: 1 }}>SQL Query</Typography>
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
    </Box>
  )
}
