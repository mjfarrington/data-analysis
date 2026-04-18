import { useState } from 'react'
import {
  Box, Typography, TextField, Button, Table, TableHead, TableRow,
  TableCell, TableBody, CircularProgress, Chip, InputAdornment,
  Alert, useTheme, alpha, List, ListItem, ListItemButton, ListItemText,
} from '@mui/material'
import { Search, PlayArrow, Storage } from '@mui/icons-material'
import { useQuery, useMutation } from '@tanstack/react-query'
import { dataApi, DataTable, QueryResult } from '../api/client'

function DataGrid({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  const theme = useTheme()
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            {columns.map(col => (
              <TableCell key={col} sx={{ whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                {col}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.slice(0, 100).map((row, ri) => (
            <TableRow key={ri} hover>
              {(row as unknown[]).map((cell, ci) => (
                <TableCell
                  key={ci}
                  sx={{
                    whiteSpace: 'nowrap', maxWidth: 200,
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    fontFamily: 'monospace', fontSize: '0.78rem',
                  }}
                >
                  {cell === null || cell === undefined
                    ? <Typography component="span" sx={{ color: 'text.disabled', fontStyle: 'italic', fontSize: 'inherit' }}>null</Typography>
                    : String(cell)
                  }
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  )
}

export default function DataExplorer() {
  const theme = useTheme()
  const [tableSearch, setTableSearch] = useState('')
  const [selectedTable, setSelectedTable] = useState<DataTable | null>(null)
  const [sql, setSql] = useState('SELECT * FROM ')
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null)
  const [queryError, setQueryError] = useState('')

  const { data: tables = [], isLoading: tablesLoading } = useQuery({
    queryKey: ['data-tables'],
    queryFn: dataApi.listTables,
  })

  const { data: preview, isLoading: previewLoading } = useQuery({
    queryKey: ['table-preview', selectedTable?.name],
    queryFn: () => dataApi.previewTable(selectedTable!.name),
    enabled: !!selectedTable,
  })

  const queryMut = useMutation({
    mutationFn: (sqlStr: string) => dataApi.query(sqlStr),
    onSuccess: (result) => {
      setQueryResult(result)
      setQueryError('')
    },
    onError: (err: Error) => {
      setQueryError(err.message)
      setQueryResult(null)
    },
  })

  const filtered = tables.filter(t =>
    !tableSearch || t.name.toLowerCase().includes(tableSearch.toLowerCase())
  )

  function handleSelectTable(table: DataTable) {
    setSelectedTable(table)
    setSql(`SELECT * FROM ${table.name} LIMIT 100`)
  }

  return (
    <Box sx={{ display: 'flex', height: '100%' }}>
      {/* Left panel: table list */}
      <Box
        sx={{
          width: 260, flexShrink: 0,
          bgcolor: 'background.paper',
          borderRight: `1px solid ${theme.palette.divider}`,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <Box sx={{ p: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <TextField
            placeholder="Search tables…"
            value={tableSearch}
            onChange={e => setTableSearch(e.target.value)}
            size="small"
            fullWidth
            InputProps={{
              startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment>,
            }}
          />
        </Box>

        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {tablesLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={24} /></Box>
          ) : (
            <List dense disablePadding>
              {filtered.map(table => (
                <ListItem key={table.name} disablePadding>
                  <ListItemButton
                    selected={selectedTable?.name === table.name}
                    onClick={() => handleSelectTable(table)}
                    sx={{ px: 2, py: 0.75 }}
                  >
                    <Storage fontSize="small" sx={{ mr: 1.5, color: 'text.secondary', flexShrink: 0, fontSize: 16 }} />
                    <ListItemText
                      primary={table.name}
                      secondary={table.row_count != null ? `${table.row_count.toLocaleString()} rows` : undefined}
                      primaryTypographyProps={{ variant: 'body2', fontFamily: 'monospace', fontSize: '0.8rem', noWrap: true }}
                      secondaryTypographyProps={{ variant: 'caption' }}
                    />
                  </ListItemButton>
                </ListItem>
              ))}
              {filtered.length === 0 && (
                <Box sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>
                  <Typography variant="body2">No tables found</Typography>
                </Box>
              )}
            </List>
          )}
        </Box>
      </Box>

      {/* Right panel: preview + query */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Preview area */}
        <Box
          sx={{
            flex: selectedTable ? '0 0 40%' : 1,
            overflow: 'auto',
            borderBottom: `1px solid ${theme.palette.divider}`,
          }}
        >
          {selectedTable ? (
            <>
              <Box sx={{ px: 2, py: 1, bgcolor: 'background.paper', borderBottom: `1px solid ${theme.palette.divider}` }}>
                <Typography variant="subtitle2" fontWeight={700} fontFamily="monospace">
                  {selectedTable.name}
                </Typography>
                {selectedTable.row_count != null && (
                  <Typography variant="caption" color="text.secondary">
                    {selectedTable.row_count.toLocaleString()} rows
                    {selectedTable.size_bytes != null && ` · ${(selectedTable.size_bytes / 1024).toFixed(1)} KB`}
                  </Typography>
                )}
              </Box>
              {previewLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}><CircularProgress /></Box>
              ) : preview ? (
                <DataGrid columns={preview.columns} rows={preview.rows} />
              ) : null}
            </>
          ) : (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'text.secondary', flexDirection: 'column', gap: 1 }}>
              <Storage sx={{ fontSize: 48, opacity: 0.3 }} />
              <Typography>Select a table to preview its data</Typography>
            </Box>
          )}
        </Box>

        {/* SQL Editor + Query Results */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* SQL toolbar */}
          <Box
            sx={{
              display: 'flex', alignItems: 'center', gap: 1,
              px: 2, py: 1,
              bgcolor: 'background.paper',
              borderBottom: `1px solid ${theme.palette.divider}`,
              flexShrink: 0,
            }}
          >
            <Typography variant="caption" fontWeight={600} color="text.secondary" textTransform="uppercase" letterSpacing="0.08em">
              SQL Query
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button
              size="small"
              startIcon={queryMut.isPending ? <CircularProgress size={14} /> : <PlayArrow />}
              variant="contained"
              onClick={() => queryMut.mutate(sql)}
              disabled={queryMut.isPending || !sql.trim()}
            >
              Run Query
            </Button>
          </Box>

          {/* SQL textarea */}
          <Box
            component="textarea"
            value={sql}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setSql(e.target.value)}
            spellCheck={false}
            rows={5}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                queryMut.mutate(sql)
              }
            }}
            sx={{
              width: '100%',
              resize: 'none',
              border: 'none',
              borderBottom: `1px solid ${theme.palette.divider}`,
              outline: 'none',
              bgcolor: theme.palette.mode === 'dark' ? '#0d1117' : '#f8f9fa',
              color: 'text.primary',
              fontFamily: '"JetBrains Mono", Consolas, monospace',
              fontSize: '0.85rem',
              lineHeight: 1.7,
              p: 2,
              flexShrink: 0,
            }}
          />

          {/* Query results */}
          <Box sx={{ flex: 1, overflowY: 'auto' }}>
            {queryError && (
              <Alert severity="error" sx={{ m: 2 }}>{queryError}</Alert>
            )}
            {queryResult && (
              <>
                <Box sx={{ px: 2, py: 0.75, bgcolor: 'background.paper', borderBottom: `1px solid ${theme.palette.divider}` }}>
                  <Typography variant="caption" color="text.secondary">
                    {queryResult.rows.length} rows · {queryResult.columns.length} columns
                  </Typography>
                </Box>
                <DataGrid columns={queryResult.columns} rows={queryResult.rows} />
              </>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
