import { useEffect, useMemo, useState } from 'react'
import {
  Autocomplete,
  Box, Typography, Button, Table, TableHead, TableRow, TableCell,
  TableBody, TextField, List, ListItem, ListItemButton, ListItemText,
  Chip, Dialog, DialogTitle, DialogContent, DialogActions,
  CircularProgress, IconButton, Tooltip, Divider, InputAdornment,
  TableSortLabel,
  useTheme,
} from '@mui/material'
import { Add, Delete, Edit, Save, Close, Search } from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { dictionariesApi, Dictionary, DictionaryEntry } from '../api/client'
import {
  workspaceSidebarItemButtonSx,
  workspaceSidebarItemTextSx,
  workspaceSidebarSurfaceSx,
} from '../components/workspace/WorkspaceTemplate'

interface EditingEntry {
  key: string
  value: string
  extra: Record<string, string>
}

export default function Dictionaries() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Dictionary | null>(null)
  const [newDictOpen, setNewDictOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newKeyLabel, setNewKeyLabel] = useState('Key')
  const [newValueLabel, setNewValueLabel] = useState('Value')
  const [newExtraColumns, setNewExtraColumns] = useState('')
  const [editingEntry, setEditingEntry] = useState<{ id: number | 'new'; data: EditingEntry } | null>(null)
  const [columnsEditorOpen, setColumnsEditorOpen] = useState(false)
  const [columnsEditorValue, setColumnsEditorValue] = useState('')
  const [extraColumnFilters, setExtraColumnFilters] = useState<Record<string, string>>({})
  const [keyFilter, setKeyFilter] = useState('')
  const [valueFilter, setValueFilter] = useState('')
  const [sortBy, setSortBy] = useState<string>('key')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [leftSearch, setLeftSearch] = useState('')
  const [leftCollapsed, setLeftCollapsed] = useState(false)

  const { data: dicts = [], isLoading } = useQuery({
    queryKey: ['dictionaries'],
    queryFn: dictionariesApi.list,
  })

  const createDictMut = useMutation({
    mutationFn: (data: Partial<Dictionary>) => dictionariesApi.create(data),
    onSuccess: (dict) => {
      qc.invalidateQueries({ queryKey: ['dictionaries'] })
      setSelected(dict)
      setNewDictOpen(false)
      setNewName(''); setNewDesc(''); setNewKeyLabel('Key'); setNewValueLabel('Value'); setNewExtraColumns('')
    },
  })

  const updateDictMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Dictionary> }) =>
      dictionariesApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dictionaries'] }) },
  })

  const deleteDictMut = useMutation({
    mutationFn: (id: number) => dictionariesApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionaries'] })
      setSelected(null)
    },
  })

  const addEntryMut = useMutation({
    mutationFn: ({ dictId, data }: { dictId: number; data: { key: string; value: string; extra?: Record<string, string> } }) =>
      dictionariesApi.addEntry(dictId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionaries'] })
      setEditingEntry(null)
    },
  })

  const updateEntryMut = useMutation({
    mutationFn: ({ dictId, entryId, data }: { dictId: number; entryId: number; data: { key?: string; value?: string; extra?: Record<string, string> } }) =>
      dictionariesApi.updateEntry(dictId, entryId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionaries'] })
      setEditingEntry(null)
    },
  })

  const deleteEntryMut = useMutation({
    mutationFn: ({ dictId, entryId }: { dictId: number; entryId: number }) =>
      dictionariesApi.deleteEntry(dictId, entryId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dictionaries'] }) },
  })

  // Keep selected in sync with fresh data
  const currentDict = selected ? dicts.find(d => d.id === selected.id) ?? selected : null
  const filteredDicts = dicts.filter(d => {
    const q = leftSearch.trim().toLowerCase()
    if (!q) return true
    return d.name.toLowerCase().includes(q) || (d.description ?? '').toLowerCase().includes(q)
  })

  const currentExtraColumns = currentDict?.extra_columns ?? []
  const extraValueOptionsByColumn = useMemo(() => {
    const options: Record<string, string[]> = {}
    if (!currentDict) return options
    for (const col of (currentDict.extra_columns ?? [])) {
      const values = new Set<string>()
      currentDict.entries.forEach(entry => {
        const v = String((entry.extra ?? {})[col] ?? '').trim()
        if (v) values.add(v)
      })
      options[col] = Array.from(values).sort((a, b) => a.localeCompare(b))
    }
    return options
  }, [currentDict])

  useEffect(() => {
    setColumnsEditorValue((currentDict?.extra_columns ?? []).join(', '))
  }, [currentDict?.id, currentDict?.extra_columns])

  useEffect(() => {
    setExtraColumnFilters({})
    setKeyFilter('')
    setValueFilter('')
    setSortBy('key')
    setSortDirection('asc')
  }, [currentDict?.id])

  const filteredEntries = useMemo(() => {
    if (!currentDict) return []

    const keyNeedle = keyFilter.trim().toLowerCase()
    const valueNeedle = valueFilter.trim().toLowerCase()
    const base = currentDict.entries.filter(entry => {
      if (keyNeedle && !entry.key.toLowerCase().includes(keyNeedle)) return false
      if (valueNeedle && !entry.value.toLowerCase().includes(valueNeedle)) return false

      const extra = entry.extra ?? {}
      for (const col of currentExtraColumns) {
        const filterVal = (extraColumnFilters[col] ?? '').trim()
        if (!filterVal) continue
        if (String(extra[col] ?? '') !== filterVal) return false
      }
      return true
    })

    return base.slice().sort((a, b) => {
      const aVal = sortBy === 'key'
        ? a.key
        : sortBy === 'value'
          ? a.value
          : String((a.extra ?? {})[sortBy] ?? '')
      const bVal = sortBy === 'key'
        ? b.key
        : sortBy === 'value'
          ? b.value
          : String((b.extra ?? {})[sortBy] ?? '')

      const cmp = aVal.localeCompare(bVal, undefined, { sensitivity: 'base' })
      return sortDirection === 'asc' ? cmp : -cmp
    })
  }, [currentDict, currentExtraColumns, extraColumnFilters, keyFilter, valueFilter, sortBy, sortDirection])

  function handleSort(column: string) {
    if (sortBy === column) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
      return
    }
    setSortBy(column)
    setSortDirection('asc')
  }

  function saveEntry() {
    if (!currentDict || !editingEntry) return
    const { id, data } = editingEntry
    if (!data.key.trim()) return
    if (id === 'new') {
      addEntryMut.mutate({ dictId: currentDict.id, data: { key: data.key, value: data.value, extra: data.extra } })
    } else {
      updateEntryMut.mutate({ dictId: currentDict.id, entryId: id, data: { key: data.key, value: data.value, extra: data.extra } })
    }
  }

  function parseExtraColumnsCsv(csv: string): string[] {
    const cols: string[] = []
    const seen = new Set<string>()
    csv.split(',').forEach(raw => {
      const col = raw.trim()
      if (!col) return
      const key = col.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      cols.push(col)
    })
    return cols
  }

  function deleteEntry(entry: DictionaryEntry) {
    if (!currentDict) return
    deleteEntryMut.mutate({ dictId: currentDict.id, entryId: entry.id })
  }

  function saveExtraColumns() {
    if (!currentDict) return
    updateDictMut.mutate({ id: currentDict.id, data: { extra_columns: parseExtraColumnsCsv(columnsEditorValue) } })
    setColumnsEditorOpen(false)
  }

  function openNewEntryEditor() {
    setEditingEntry({ id: 'new', data: { key: '', value: '', extra: {} } })
  }

  function openEditEntryEditor(entry: DictionaryEntry) {
    setEditingEntry({ id: entry.id, data: { key: entry.key, value: entry.value, extra: { ...(entry.extra ?? {}) } } })
  }

  useEffect(() => {
    const onToggleLeft = () => setLeftCollapsed(v => !v)
    window.addEventListener('workspace-panel-toggle-left', onToggleLeft)
    return () => {
      window.removeEventListener('workspace-panel-toggle-left', onToggleLeft)
    }
  }, [])

  return (
    <Box sx={{ display: 'flex', height: '100%' }}>
      {/* Left panel */}
      {!leftCollapsed && (
      <Box
        sx={[
          workspaceSidebarSurfaceSx,
          {
            width: 260, flexShrink: 0,
            borderRight: `1px solid ${theme.palette.divider}`,
            display: 'flex', flexDirection: 'column',
          },
        ]}
      >
        <Box sx={{ p: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, letterSpacing: '0.01em' }}>Dictionaries</Typography>
            <Box sx={{ flex: 1 }} />
            <Tooltip title="New dictionary">
              <IconButton size="small" onClick={() => setNewDictOpen(true)}>
                <Add sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Box>
          <TextField
            placeholder="Search dictionaries…"
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
          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={24} /></Box>
          ) : (
            <List dense disablePadding>
              {filteredDicts.map(dict => (
                <ListItem key={dict.id} disablePadding>
                  <ListItemButton
                    selected={currentDict?.id === dict.id}
                    onClick={() => setSelected(dict)}
                    sx={workspaceSidebarItemButtonSx}
                  >
                    <ListItemText
                      primary={<Typography variant="body2" noWrap sx={workspaceSidebarItemTextSx}>{dict.name}</Typography>}
                      secondary={dict.description ? <Typography variant="caption" noWrap sx={{ color: '#8b949e' }}>{dict.description}</Typography> : null}
                    />
                    <Chip label={dict.entries.length} size="small" sx={{ fontSize: '0.65rem', height: 18 }} />
                  </ListItemButton>
                </ListItem>
              ))}
              {filteredDicts.length === 0 && (
                <Box sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>
                  <Typography variant="body2">{leftSearch ? 'No matches' : 'No dictionaries'}</Typography>
                </Box>
              )}
            </List>
          )}
        </Box>
      </Box>
      )}

      {/* Right panel */}
      {currentDict ? (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Header */}
          <Box
            sx={{
              display: 'flex', alignItems: 'center', gap: 1.5,
              px: 2, py: 1.5,
              bgcolor: 'background.paper',
              borderBottom: `1px solid ${theme.palette.divider}`,
              flexShrink: 0,
            }}
          >
            <Box sx={{ flex: 1 }}>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>{currentDict.name}</Typography>
              {currentDict.description && (
                <Typography variant="body2" color="text.secondary">{currentDict.description}</Typography>
              )}
              <Box sx={{ display: 'flex', gap: 1, mt: 0.5, alignItems: 'center' }}>
                <Typography variant="caption" color="text.disabled" sx={{ mr: 0.25 }}>Columns:</Typography>
                <TextField
                  size="small"
                  value={currentDict.key_label}
                  onChange={e => updateDictMut.mutate({ id: currentDict.id, data: { key_label: e.target.value } })}
                  slotProps={{ htmlInput: { style: { fontSize: '0.72rem', padding: '2px 6px', fontFamily: 'monospace' } } }}
                  sx={{ width: 110 }}
                />
                <TextField
                  size="small"
                  value={currentDict.value_label}
                  onChange={e => updateDictMut.mutate({ id: currentDict.id, data: { value_label: e.target.value } })}
                  slotProps={{ htmlInput: { style: { fontSize: '0.72rem', padding: '2px 6px', fontFamily: 'monospace' } } }}
                  sx={{ width: 110 }}
                />
                <Button size="small" variant="outlined" onClick={() => setColumnsEditorOpen(true)}>
                  Extra Columns ({currentExtraColumns.length})
                </Button>
              </Box>
            </Box>
            <Button
              size="small"
              startIcon={<Add />}
              variant="outlined"
              onClick={openNewEntryEditor}
            >
              Add Entry
            </Button>
            <Tooltip title="Delete dictionary">
              <IconButton
                size="small"
                color="error"
                onClick={() => {
                  if (window.confirm(`Delete "${currentDict.name}"?`)) {
                    deleteDictMut.mutate(currentDict.id)
                  }
                }}
              >
                <Delete fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>

          {/* Entries table */}
          <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.25 }}>
              <TextField
                size="small"
                label={`Filter ${currentDict.key_label}`}
                value={keyFilter}
                onChange={e => setKeyFilter(e.target.value)}
                sx={{ minWidth: 180 }}
              />
              <TextField
                size="small"
                label={`Filter ${currentDict.value_label}`}
                value={valueFilter}
                onChange={e => setValueFilter(e.target.value)}
                sx={{ minWidth: 200 }}
              />
              {currentExtraColumns.map(col => (
                <Autocomplete
                  key={`filter-${col}`}
                  size="small"
                  sx={{ minWidth: 180 }}
                  options={extraValueOptionsByColumn[col] ?? []}
                  value={extraColumnFilters[col] ?? ''}
                  onInputChange={(_, value) => setExtraColumnFilters(prev => ({ ...prev, [col]: value }))}
                  renderInput={(params) => (
                    <TextField {...params} label={`Filter ${col}`} placeholder="All" />
                  )}
                />
              ))}
              <Button
                size="small"
                variant="text"
                onClick={() => {
                  setKeyFilter('')
                  setValueFilter('')
                  setExtraColumnFilters({})
                }}
              >
                Clear Filters
              </Button>
            </Box>

            <Table size="small" sx={{ bgcolor: 'background.paper', borderRadius: 1.5, overflow: 'hidden' }}>
              <TableHead>
                <TableRow>
                  <TableCell>
                    <TableSortLabel
                      active={sortBy === 'key'}
                      direction={sortBy === 'key' ? sortDirection : 'asc'}
                      onClick={() => handleSort('key')}
                    >
                      {currentDict.key_label}
                    </TableSortLabel>
                  </TableCell>
                  <TableCell>
                    <TableSortLabel
                      active={sortBy === 'value'}
                      direction={sortBy === 'value' ? sortDirection : 'asc'}
                      onClick={() => handleSort('value')}
                    >
                      {currentDict.value_label}
                    </TableSortLabel>
                  </TableCell>
                  {currentExtraColumns.map(col => (
                    <TableCell key={`col-${col}`}>
                      <TableSortLabel
                        active={sortBy === col}
                        direction={sortBy === col ? sortDirection : 'asc'}
                        onClick={() => handleSort(col)}
                      >
                        {col}
                      </TableSortLabel>
                    </TableCell>
                  ))}
                  <TableCell width={80}>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredEntries.map(entry => {
                  return (
                    <TableRow key={entry.id} hover>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 500 }}>
                          {entry.key}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">{entry.value}</Typography>
                      </TableCell>
                      {currentExtraColumns.map(col => (
                        <TableCell key={`${entry.id}-${col}`}>
                          <Typography variant="body2" color="text.secondary">{(entry.extra ?? {})[col] ?? ''}</Typography>
                        </TableCell>
                      ))}
                      <TableCell>
                        <Box sx={{ display: 'flex', gap: 0.5 }}>
                          <IconButton size="small" onClick={() => openEditEntryEditor(entry)}>
                            <Edit fontSize="small" />
                          </IconButton>
                          <IconButton size="small" color="error" onClick={() => deleteEntry(entry)}>
                            <Delete fontSize="small" />
                          </IconButton>
                        </Box>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {filteredEntries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3 + currentExtraColumns.length} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      {currentDict.entries.length === 0
                        ? 'No entries. Click "Add Entry" to get started.'
                        : 'No entries match current filters.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        </Box>
      ) : (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary' }}>
          <Typography>Select a dictionary to view its entries</Typography>
        </Box>
      )}

      {/* New dictionary dialog */}
      <Dialog open={newDictOpen} onClose={() => setNewDictOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>New Dictionary</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '16px !important' }}>
          <TextField label="Name" value={newName} onChange={e => setNewName(e.target.value)} size="small" fullWidth autoFocus />
          <TextField label="Description" value={newDesc} onChange={e => setNewDesc(e.target.value)} size="small" fullWidth multiline rows={2} />
          <Divider />
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField label="Key Column Label" value={newKeyLabel} onChange={e => setNewKeyLabel(e.target.value)} size="small" fullWidth
              helperText='e.g. "app_id"' />
            <TextField label="Value Column Label" value={newValueLabel} onChange={e => setNewValueLabel(e.target.value)} size="small" fullWidth
              helperText='e.g. "app_name"' />
          </Box>
          <TextField
            label="Extra Columns"
            value={newExtraColumns}
            onChange={e => setNewExtraColumns(e.target.value)}
            size="small"
            fullWidth
            helperText='Optional, comma-separated. Example: "Type, Region"'
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewDictOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!newName.trim() || createDictMut.isPending}
            onClick={() => createDictMut.mutate({
              name: newName,
              description: newDesc,
              key_label: newKeyLabel,
              value_label: newValueLabel,
              extra_columns: parseExtraColumnsCsv(newExtraColumns),
              entries: [],
            })}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {/* Extra columns editor */}
      <Dialog open={columnsEditorOpen} onClose={() => setColumnsEditorOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit Extra Columns</DialogTitle>
        <DialogContent sx={{ pt: '16px !important' }}>
          <TextField
            label="Extra Columns"
            value={columnsEditorValue}
            onChange={e => setColumnsEditorValue(e.target.value)}
            size="small"
            fullWidth
            helperText='Comma-separated, e.g. "Type, Region"'
            autoFocus
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setColumnsEditorOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveExtraColumns}>Save</Button>
        </DialogActions>
      </Dialog>

      {/* Entry editor */}
      <Dialog open={Boolean(editingEntry)} onClose={() => setEditingEntry(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingEntry?.id === 'new' ? 'Add Entry' : 'Edit Entry'}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: '16px !important' }}>
          <TextField
            label={currentDict?.key_label ?? 'Key'}
            value={editingEntry?.data.key ?? ''}
            onChange={e => setEditingEntry(prev => prev ? { ...prev, data: { ...prev.data, key: e.target.value } } : prev)}
            size="small"
            fullWidth
            autoFocus
          />
          <TextField
            label={currentDict?.value_label ?? 'Value'}
            value={editingEntry?.data.value ?? ''}
            onChange={e => setEditingEntry(prev => prev ? { ...prev, data: { ...prev.data, value: e.target.value } } : prev)}
            size="small"
            fullWidth
          />
          {currentExtraColumns.map(col => (
            <Autocomplete
              key={`entry-modal-${col}`}
              size="small"
              freeSolo
              fullWidth
              options={extraValueOptionsByColumn[col] ?? []}
              value={editingEntry?.data.extra[col] ?? ''}
              onInputChange={(_, value) => setEditingEntry(prev => prev ? {
                ...prev,
                data: {
                  ...prev.data,
                  extra: { ...prev.data.extra, [col]: value },
                },
              } : prev)}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={col}
                  helperText={(extraValueOptionsByColumn[col] ?? []).length > 0 ? 'Pick existing or type new' : 'Type a value'}
                />
              )}
            />
          ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditingEntry(null)}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={<Save />}
            disabled={!editingEntry?.data.key?.trim()}
            onClick={saveEntry}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
