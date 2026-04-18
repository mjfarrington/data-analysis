import { useState } from 'react'
import {
  Box, Typography, Button, Table, TableHead, TableRow, TableCell,
  TableBody, TextField, List, ListItem, ListItemButton, ListItemText,
  Chip, Dialog, DialogTitle, DialogContent, DialogActions,
  CircularProgress, IconButton, Tooltip, Alert, Divider,
  useTheme, alpha,
} from '@mui/material'
import { Add, Delete, Edit, Save, Close } from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { dictionariesApi, Dictionary, DictionaryEntry } from '../api/client'

interface EditingEntry {
  key: string
  value: string
}

export default function Dictionaries() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Dictionary | null>(null)
  const [newDictOpen, setNewDictOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [editingEntry, setEditingEntry] = useState<{ id: number | 'new'; data: EditingEntry } | null>(null)

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
      setNewName('')
      setNewDesc('')
    },
  })

  const updateDictMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Dictionary> }) =>
      dictionariesApi.update(id, data),
    onSuccess: (dict) => {
      qc.invalidateQueries({ queryKey: ['dictionaries'] })
      setSelected(dict)
      setEditingEntry(null)
    },
  })

  const deleteDictMut = useMutation({
    mutationFn: (id: number) => dictionariesApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionaries'] })
      setSelected(null)
    },
  })

  // Keep selected in sync with fresh data
  const currentDict = selected ? dicts.find(d => d.id === selected.id) ?? selected : null

  function saveEntry() {
    if (!currentDict || !editingEntry) return
    const { id, data } = editingEntry
    if (!data.key.trim()) return

    let entries: DictionaryEntry[]
    if (id === 'new') {
      entries = [...currentDict.entries, { id: Date.now(), key: data.key, value: data.value }]
    } else {
      entries = currentDict.entries.map(e =>
        e.id === id ? { ...e, key: data.key, value: data.value } : e
      )
    }
    updateDictMut.mutate({ id: currentDict.id, data: { entries } })
  }

  function deleteEntry(entryId: number) {
    if (!currentDict) return
    updateDictMut.mutate({
      id: currentDict.id,
      data: { entries: currentDict.entries.filter(e => e.id !== entryId) },
    })
  }

  return (
    <Box sx={{ display: 'flex', height: '100%' }}>
      {/* Left panel */}
      <Box
        sx={{
          width: 260, flexShrink: 0,
          bgcolor: 'background.paper',
          borderRight: `1px solid ${theme.palette.divider}`,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <Box sx={{ p: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Typography variant="subtitle2" fontWeight={700}>Dictionaries</Typography>
        </Box>

        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={24} /></Box>
          ) : (
            <List dense disablePadding>
              {dicts.map(dict => (
                <ListItem key={dict.id} disablePadding>
                  <ListItemButton
                    selected={currentDict?.id === dict.id}
                    onClick={() => setSelected(dict)}
                    sx={{ px: 2, py: 1 }}
                  >
                    <ListItemText
                      primary={dict.name}
                      secondary={dict.description}
                      primaryTypographyProps={{ variant: 'body2', fontWeight: 500, noWrap: true }}
                      secondaryTypographyProps={{ variant: 'caption', noWrap: true }}
                    />
                    <Chip label={dict.entries.length} size="small" sx={{ fontSize: '0.65rem', height: 18 }} />
                  </ListItemButton>
                </ListItem>
              ))}
              {dicts.length === 0 && (
                <Box sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>
                  <Typography variant="body2">No dictionaries</Typography>
                </Box>
              )}
            </List>
          )}
        </Box>

        <Box sx={{ p: 1.5, borderTop: `1px solid ${theme.palette.divider}` }}>
          <Button startIcon={<Add />} fullWidth size="small" onClick={() => setNewDictOpen(true)}>
            New Dictionary
          </Button>
        </Box>
      </Box>

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
              <Typography variant="h6" fontWeight={700}>{currentDict.name}</Typography>
              {currentDict.description && (
                <Typography variant="body2" color="text.secondary">{currentDict.description}</Typography>
              )}
            </Box>
            <Button
              size="small"
              startIcon={<Add />}
              variant="outlined"
              onClick={() => setEditingEntry({ id: 'new', data: { key: '', value: '' } })}
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
            <Table size="small" sx={{ bgcolor: 'background.paper', borderRadius: 1.5, overflow: 'hidden' }}>
              <TableHead>
                <TableRow>
                  <TableCell>Key</TableCell>
                  <TableCell>Value</TableCell>
                  <TableCell width={80}>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {currentDict.entries.map(entry => {
                  const isEditing = editingEntry?.id === entry.id
                  return (
                    <TableRow key={entry.id} hover>
                      <TableCell>
                        {isEditing ? (
                          <TextField
                            value={editingEntry.data.key}
                            onChange={e => setEditingEntry(prev => prev ? { ...prev, data: { ...prev.data, key: e.target.value } } : prev)}
                            size="small"
                            autoFocus
                          />
                        ) : (
                          <Typography variant="body2" fontFamily="monospace" fontWeight={500}>
                            {entry.key}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <TextField
                            value={editingEntry.data.value}
                            onChange={e => setEditingEntry(prev => prev ? { ...prev, data: { ...prev.data, value: e.target.value } } : prev)}
                            size="small"
                            fullWidth
                          />
                        ) : (
                          <Typography variant="body2" color="text.secondary">{entry.value}</Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Box sx={{ display: 'flex', gap: 0.5 }}>
                            <IconButton size="small" color="primary" onClick={saveEntry}>
                              <Save fontSize="small" />
                            </IconButton>
                            <IconButton size="small" onClick={() => setEditingEntry(null)}>
                              <Close fontSize="small" />
                            </IconButton>
                          </Box>
                        ) : (
                          <Box sx={{ display: 'flex', gap: 0.5 }}>
                            <IconButton size="small" onClick={() => setEditingEntry({ id: entry.id, data: { key: entry.key, value: entry.value } })}>
                              <Edit fontSize="small" />
                            </IconButton>
                            <IconButton size="small" color="error" onClick={() => deleteEntry(entry.id)}>
                              <Delete fontSize="small" />
                            </IconButton>
                          </Box>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
                {/* New entry row */}
                {editingEntry?.id === 'new' && (
                  <TableRow>
                    <TableCell>
                      <TextField
                        value={editingEntry.data.key}
                        onChange={e => setEditingEntry(prev => prev ? { ...prev, data: { ...prev.data, key: e.target.value } } : prev)}
                        size="small"
                        placeholder="key"
                        autoFocus
                      />
                    </TableCell>
                    <TableCell>
                      <TextField
                        value={editingEntry.data.value}
                        onChange={e => setEditingEntry(prev => prev ? { ...prev, data: { ...prev.data, value: e.target.value } } : prev)}
                        size="small"
                        placeholder="value"
                        fullWidth
                      />
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', gap: 0.5 }}>
                        <IconButton size="small" color="primary" onClick={saveEntry}>
                          <Save fontSize="small" />
                        </IconButton>
                        <IconButton size="small" onClick={() => setEditingEntry(null)}>
                          <Close fontSize="small" />
                        </IconButton>
                      </Box>
                    </TableCell>
                  </TableRow>
                )}
                {currentDict.entries.length === 0 && editingEntry?.id !== 'new' && (
                  <TableRow>
                    <TableCell colSpan={3} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      No entries. Click "Add Entry" to get started.
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
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewDictOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!newName.trim() || createDictMut.isPending}
            onClick={() => createDictMut.mutate({ name: newName, description: newDesc, entries: [] })}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
