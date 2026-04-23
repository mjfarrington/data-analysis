import { useState } from 'react'
import {
  Box, Typography, Button, Table, TableHead, TableRow, TableCell,
  TableBody, TextField, List, ListItem, ListItemButton, ListItemText,
  Chip, Dialog, DialogTitle, DialogContent, DialogActions,
  CircularProgress, IconButton, Tooltip, Divider, Switch,
  FormControlLabel, Select, MenuItem, FormControl, InputLabel,
  useTheme, alpha,
} from '@mui/material'
import { Add, Delete, Edit, Save, Close, DragIndicator } from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { cataloguesApi, Catalogue, CatalogueColumn, COLUMN_TYPES } from '../api/client'

const TYPE_COLORS: Record<string, string> = {
  string: '#4fc3f7', integer: '#81c784', long: '#a5d6a7',
  float: '#ffb74d', double: '#ffa726', decimal: '#ff8a65',
  date: '#ce93d8', datetime: '#ba68c8', boolean: '#ef9a9a', binary: '#90a4ae',
}

export default function Catalogues() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Catalogue | null>(null)
  const [newCatOpen, setNewCatOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [editingCol, setEditingCol] = useState<{
    id: number | 'new'
    data: { name: string; data_type: string; nullable: boolean; description: string }
  } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<Catalogue | null>(null)

  const { data: catalogues = [], isLoading } = useQuery({
    queryKey: ['catalogues'],
    queryFn: cataloguesApi.list,
  })

  // Keep selected in sync with fresh data
  const freshSelected = selected ? (catalogues.find(c => c.id === selected.id) ?? selected) : null

  const createMut = useMutation({
    mutationFn: (data: { name: string; description?: string }) => cataloguesApi.create(data),
    onSuccess: (cat) => {
      qc.invalidateQueries({ queryKey: ['catalogues'] })
      setSelected(cat)
      setNewCatOpen(false)
      setNewName(''); setNewDesc('')
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: { name?: string; description?: string } }) =>
      cataloguesApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['catalogues'] }),
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => cataloguesApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['catalogues'] })
      setSelected(null)
      setDeleteConfirm(null)
    },
  })

  const addColMut = useMutation({
    mutationFn: ({ catId, data }: {
      catId: number
      data: { name: string; data_type: string; nullable: boolean; description?: string; position: number }
    }) => cataloguesApi.addColumn(catId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['catalogues'] })
      setEditingCol(null)
    },
  })

  const updateColMut = useMutation({
    mutationFn: ({ catId, colId, data }: {
      catId: number; colId: number
      data: Partial<{ name: string; data_type: string; nullable: boolean; description: string }>
    }) => cataloguesApi.updateColumn(catId, colId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['catalogues'] })
      setEditingCol(null)
    },
  })

  const deleteColMut = useMutation({
    mutationFn: ({ catId, colId }: { catId: number; colId: number }) =>
      cataloguesApi.deleteColumn(catId, colId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['catalogues'] }),
  })

  const saveCol = () => {
    if (!freshSelected || !editingCol) return
    const { name, data_type, nullable, description } = editingCol.data
    if (!name.trim()) return
    if (editingCol.id === 'new') {
      addColMut.mutate({
        catId: freshSelected.id,
        data: { name: name.trim(), data_type, nullable, description: description || undefined, position: freshSelected.columns.length },
      })
    } else {
      updateColMut.mutate({
        catId: freshSelected.id, colId: editingCol.id,
        data: { name: name.trim(), data_type, nullable, description: description || undefined },
      })
    }
  }

  const [editingName, setEditingName] = useState<{ id: number; name: string; desc: string } | null>(null)

  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: catalogue list */}
      <Box sx={{
        width: 260, flexShrink: 0, borderRight: '1px solid', borderColor: 'divider',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <Box sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Catalogues</Typography>
          <Tooltip title="New catalogue">
            <IconButton size="small" onClick={() => setNewCatOpen(true)}><Add fontSize="small" /></IconButton>
          </Tooltip>
        </Box>
        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={24} /></Box>
        ) : (
          <List disablePadding sx={{ flex: 1, overflowY: 'auto' }}>
            {catalogues.map(cat => (
              <ListItem key={cat.id} disablePadding>
                <ListItemButton
                  selected={freshSelected?.id === cat.id}
                  onClick={() => setSelected(cat)}
                  sx={{ px: 2, py: 1 }}
                >
                  <ListItemText
                    primary={<Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>{cat.name}</Typography>}
                    secondary={
                      <Typography variant="caption" color="text.secondary">
                        {cat.columns.length} column{cat.columns.length !== 1 ? 's' : ''}
                      </Typography>
                    }
                  />
                </ListItemButton>
              </ListItem>
            ))}
            {catalogues.length === 0 && (
              <Box sx={{ p: 2 }}>
                <Typography variant="caption" color="text.disabled">No catalogues yet.</Typography>
              </Box>
            )}
          </List>
        )}
      </Box>

      {/* Right: detail panel */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!freshSelected ? (
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography color="text.disabled">Select a catalogue to view its schema</Typography>
          </Box>
        ) : (
          <>
            {/* Header */}
            <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 1 }}>
              {editingName?.id === freshSelected.id ? (
                <>
                  <TextField
                    size="small" value={editingName.name} label="Name"
                    onChange={e => setEditingName(n => n ? { ...n, name: e.target.value } : n)}
                    sx={{ width: 200 }}
                  />
                  <TextField
                    size="small" value={editingName.desc} label="Description"
                    onChange={e => setEditingName(n => n ? { ...n, desc: e.target.value } : n)}
                    sx={{ flex: 1 }}
                  />
                  <Tooltip title="Save">
                    <IconButton size="small" color="primary" onClick={() => {
                      updateMut.mutate({ id: freshSelected.id, data: { name: editingName.name, description: editingName.desc } })
                      setEditingName(null)
                    }}><Save fontSize="small" /></IconButton>
                  </Tooltip>
                  <Tooltip title="Cancel">
                    <IconButton size="small" onClick={() => setEditingName(null)}><Close fontSize="small" /></IconButton>
                  </Tooltip>
                </>
              ) : (
                <>
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{freshSelected.name}</Typography>
                    {freshSelected.description && (
                      <Typography variant="caption" color="text.secondary">{freshSelected.description}</Typography>
                    )}
                  </Box>
                  <Tooltip title="Edit name">
                    <IconButton size="small" onClick={() => setEditingName({ id: freshSelected.id, name: freshSelected.name, desc: freshSelected.description ?? '' })}>
                      <Edit fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete catalogue">
                    <IconButton size="small" color="error" onClick={() => setDeleteConfirm(freshSelected)}>
                      <Delete fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </>
              )}
            </Box>

            {/* Columns table */}
            <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
                <Typography variant="caption" color="text.secondary"
                  sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.65rem' }}>
                  Columns ({freshSelected.columns.length})
                </Typography>
                <Button size="small" startIcon={<Add />} variant="outlined"
                  onClick={() => setEditingCol({ id: 'new', data: { name: '', data_type: 'string', nullable: true, description: '' } })}
                  sx={{ fontSize: '0.72rem' }}>
                  Add Column
                </Button>
              </Box>

              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontSize: '0.7rem', fontWeight: 700, width: 32 }} />
                    <TableCell sx={{ fontSize: '0.7rem', fontWeight: 700 }}>Name</TableCell>
                    <TableCell sx={{ fontSize: '0.7rem', fontWeight: 700 }}>Type</TableCell>
                    <TableCell sx={{ fontSize: '0.7rem', fontWeight: 700 }}>Nullable</TableCell>
                    <TableCell sx={{ fontSize: '0.7rem', fontWeight: 700 }}>Description</TableCell>
                    <TableCell sx={{ width: 80 }} />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {[...freshSelected.columns].sort((a, b) => a.position - b.position).map(col => (
                    <TableRow key={col.id} hover>
                      <TableCell sx={{ color: 'text.disabled', cursor: 'grab' }}>
                        <DragIndicator sx={{ fontSize: 16 }} />
                      </TableCell>
                      <TableCell>
                        <Typography sx={{ fontFamily: 'monospace', fontSize: '0.78rem', fontWeight: 600 }}>
                          {col.name}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={col.data_type}
                          size="small"
                          sx={{
                            fontSize: '0.65rem', height: 20,
                            bgcolor: alpha(TYPE_COLORS[col.data_type] ?? '#888', 0.15),
                            color: TYPE_COLORS[col.data_type] ?? 'text.secondary',
                            fontFamily: 'monospace', fontWeight: 600,
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color={col.nullable ? 'text.secondary' : 'warning.main'}>
                          {col.nullable ? 'yes' : 'no'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary">{col.description ?? ''}</Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Tooltip title="Edit">
                          <IconButton size="small" onClick={() => setEditingCol({
                            id: col.id,
                            data: { name: col.name, data_type: col.data_type, nullable: col.nullable, description: col.description ?? '' },
                          })}>
                            <Edit sx={{ fontSize: 14 }} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete">
                          <IconButton size="small" color="error"
                            onClick={() => deleteColMut.mutate({ catId: freshSelected.id, colId: col.id })}>
                            <Delete sx={{ fontSize: 14 }} />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                  {freshSelected.columns.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} align="center" sx={{ py: 4 }}>
                        <Typography variant="caption" color="text.disabled">
                          No columns defined. Click "Add Column" to start.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Box>
          </>
        )}
      </Box>

      {/* New catalogue dialog */}
      <Dialog open={newCatOpen} onClose={() => setNewCatOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>New Catalogue</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2 }}>
          <TextField label="Name" size="small" fullWidth value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && newName.trim() && createMut.mutate({ name: newName.trim(), description: newDesc || undefined })}
          />
          <TextField label="Description (optional)" size="small" fullWidth value={newDesc}
            onChange={e => setNewDesc(e.target.value)} multiline rows={2} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewCatOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={!newName.trim() || createMut.isPending}
            onClick={() => createMut.mutate({ name: newName.trim(), description: newDesc || undefined })}>
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit/Add column dialog */}
      <Dialog open={!!editingCol} onClose={() => setEditingCol(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingCol?.id === 'new' ? 'Add Column' : 'Edit Column'}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2 }}>
          <TextField
            label="Column Name" size="small" fullWidth
            value={editingCol?.data.name ?? ''}
            onChange={e => setEditingCol(c => c ? { ...c, data: { ...c.data, name: e.target.value } } : c)}
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
          />
          <FormControl size="small" fullWidth>
            <InputLabel>Data Type</InputLabel>
            <Select
              label="Data Type"
              value={editingCol?.data.data_type ?? 'string'}
              onChange={e => setEditingCol(c => c ? { ...c, data: { ...c.data, data_type: e.target.value } } : c)}
            >
              {COLUMN_TYPES.map(t => (
                <MenuItem key={t} value={t}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Box sx={{
                      width: 10, height: 10, borderRadius: '50%',
                      bgcolor: TYPE_COLORS[t] ?? '#888', flexShrink: 0,
                    }} />
                    <Typography sx={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{t}</Typography>
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControlLabel
            control={
              <Switch
                checked={editingCol?.data.nullable ?? true}
                onChange={e => setEditingCol(c => c ? { ...c, data: { ...c.data, nullable: e.target.checked } } : c)}
                size="small"
              />
            }
            label={<Typography variant="body2">Nullable</Typography>}
          />
          <TextField
            label="Description (optional)" size="small" fullWidth multiline rows={2}
            value={editingCol?.data.description ?? ''}
            onChange={e => setEditingCol(c => c ? { ...c, data: { ...c.data, description: e.target.value } } : c)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditingCol(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!editingCol?.data.name.trim() || addColMut.isPending || updateColMut.isPending}
            onClick={saveCol}
          >
            {editingCol?.id === 'new' ? 'Add' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete catalogue confirm */}
      <Dialog open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete Catalogue</DialogTitle>
        <DialogContent>
          <Typography>
            Delete <strong>{deleteConfirm?.name}</strong> and all its columns? This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirm(null)}>Cancel</Button>
          <Button variant="contained" color="error"
            disabled={deleteMut.isPending}
            onClick={() => deleteConfirm && deleteMut.mutate(deleteConfirm.id)}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
