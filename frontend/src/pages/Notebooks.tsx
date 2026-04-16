import { useState, useEffect } from 'react'
import {
  Box, Paper, Typography, Button, IconButton, Chip, Divider,
  TextField, Stack, Tooltip, alpha, useTheme, List, ListItem,
  ListItemButton, ListItemText, Dialog, DialogTitle, DialogContent,
  DialogActions, CircularProgress, Alert, ToggleButton, ToggleButtonGroup,
} from '@mui/material'
import {
  Add, Delete, Edit, Save, NoteAlt, AddCircleOutline, DeleteOutline,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import { notebookFilesApi, NotebookFile, NotebookCell } from '../api/client'

const MONO = '"JetBrains Mono", "Fira Code", monospace'

// ─── Notebook Editor ─────────────────────────────────────────────────────────

function NotebookEditor({ cells, onChange }: { cells: NotebookCell[]; onChange: (cells: NotebookCell[]) => void }) {
  const theme = useTheme()

  const update = (idx: number, patch: Partial<NotebookCell>) =>
    onChange(cells.map((c, i) => (i === idx ? { ...c, ...patch } : c)))
  const insert = (idx: number) => {
    const next = [...cells]
    next.splice(idx + 1, 0, { type: 'code', source: '' })
    onChange(next)
  }
  const remove = (idx: number) => onChange(cells.filter((_, i) => i !== idx))

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 1.5 }}>
      {cells.length === 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', pt: 4 }}>
          <Button startIcon={<AddCircleOutline />} onClick={() => onChange([{ type: 'code', source: '' }])} size="small">
            Add first cell
          </Button>
        </Box>
      )}
      {cells.map((cell, idx) => (
        <Box key={idx} sx={{ mb: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5, px: 0.5 }}>
            <ToggleButtonGroup value={cell.type} exclusive size="small" onChange={(_, val) => val && update(idx, { type: val })}>
              <ToggleButton value="code" sx={{ py: 0.25, px: 1, fontSize: '0.65rem' }}>Code</ToggleButton>
              <ToggleButton value="markdown" sx={{ py: 0.25, px: 1, fontSize: '0.65rem' }}>MD</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1, ml: 0.5 }}>
              Cell {idx + 1}
              {idx === cells.length - 1 && cell.type === 'code' && (
                <span style={{ color: theme.palette.warning.main }}> — assign result_df here</span>
              )}
            </Typography>
            <Tooltip title="Insert cell below">
              <IconButton size="small" onClick={() => insert(idx)}><AddCircleOutline sx={{ fontSize: 15 }} /></IconButton>
            </Tooltip>
            <Tooltip title="Remove cell">
              <IconButton size="small" onClick={() => remove(idx)}><DeleteOutline sx={{ fontSize: 15 }} /></IconButton>
            </Tooltip>
          </Box>
          <TextField
            fullWidth multiline minRows={3} maxRows={20} value={cell.source}
            onChange={(e) => update(idx, { source: e.target.value })}
            placeholder={cell.type === 'code' ? '# Python code — spark and source_df are available\nresult_df = source_df.filter(...)' : 'Markdown notes...'}
            InputProps={{
              sx: {
                fontFamily: cell.type === 'code' ? MONO : 'inherit',
                fontSize: '0.8rem',
                bgcolor: alpha(cell.type === 'code' ? theme.palette.primary.main : theme.palette.text.primary, 0.04),
              },
            }}
          />
        </Box>
      ))}
      {cells.length > 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Button size="small" startIcon={<AddCircleOutline />} onClick={() => insert(cells.length - 1)}>
            Add cell
          </Button>
        </Box>
      )}
    </Box>
  )
}

// ─── Notebook Form Dialog ─────────────────────────────────────────────────────

function NotebookFormDialog({
  open, onClose, initial, onSave, saving,
}: {
  open: boolean
  onClose: () => void
  initial?: NotebookFile
  onSave: (data: Omit<NotebookFile, 'id' | 'created_at' | 'updated_at'>) => void
  saving: boolean
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [cells, setCells] = useState<NotebookCell[]>(initial?.cells ?? [{ type: 'code', source: '' }])

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '')
      setDescription(initial?.description ?? '')
      setCells(initial?.cells ?? [{ type: 'code', source: '' }])
    }
  }, [open, initial])

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { height: '85vh' } }}>
      <DialogTitle>{initial?.id ? 'Edit Notebook' : 'New Notebook'}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 1 }}>
        <Stack direction="row" spacing={1}>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required size="small" sx={{ flex: 2 }} />
          <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} size="small" sx={{ flex: 3 }} />
        </Stack>
        <Divider />
        <NotebookEditor cells={cells} onChange={setCells} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => onSave({ name: name.trim(), description: description.trim() || undefined, cells })}
          disabled={!name.trim() || saving}
        >
          {saving ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Notebooks() {
  const theme = useTheme()
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingNb, setEditingNb] = useState<NotebookFile | null>(null)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [inlineEditing, setInlineEditing] = useState(false)
  const [inlineCells, setInlineCells] = useState<NotebookCell[]>([])
  const [inlineDirty, setInlineDirty] = useState(false)

  const { data: notebooks = [], isLoading } = useQuery({
    queryKey: ['notebook-files'],
    queryFn: () => notebookFilesApi.list().then((r) => r.data),
  })

  const selected = notebooks.find((n) => n.id === selectedId) ?? null

  useEffect(() => {
    if (selected) {
      setInlineCells(selected.cells ?? [])
      setInlineDirty(false)
      setInlineEditing(false)
    }
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const createMut = useMutation({
    mutationFn: notebookFilesApi.create,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['notebook-files'] })
      setDialogOpen(false)
      setSelectedId(res.data.id)
      enqueueSnackbar('Notebook created', { variant: 'success' })
    },
    onError: () => enqueueSnackbar('Failed to create notebook', { variant: 'error' }),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof notebookFilesApi.update>[1] }) =>
      notebookFilesApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notebook-files'] })
      setDialogOpen(false)
      setInlineDirty(false)
      enqueueSnackbar('Notebook saved', { variant: 'success' })
    },
    onError: () => enqueueSnackbar('Failed to save notebook', { variant: 'error' }),
  })

  const deleteMut = useMutation({
    mutationFn: notebookFilesApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notebook-files'] })
      setDeleteId(null)
      if (selectedId === deleteId) setSelectedId(null)
      enqueueSnackbar('Notebook deleted', { variant: 'info' })
    },
    onError: () => enqueueSnackbar('Failed to delete notebook', { variant: 'error' }),
  })

  const handleSave = (data: Omit<NotebookFile, 'id' | 'created_at' | 'updated_at'>) => {
    if (editingNb?.id) updateMut.mutate({ id: editingNb.id, data })
    else createMut.mutate(data)
  }

  const saveInline = () => {
    if (!selectedId) return
    updateMut.mutate({ id: selectedId, data: { cells: inlineCells } })
  }

  const panelBg = alpha(theme.palette.background.paper, 0.5)

  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Sidebar */}
      <Paper
        elevation={0}
        sx={{
          width: 240,
          flexShrink: 0,
          borderRight: `1px solid ${theme.palette.divider}`,
          display: 'flex',
          flexDirection: 'column',
          bgcolor: panelBg,
          overflow: 'hidden',
        }}
      >
        <Box sx={{ px: 1.5, py: 1, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', alignItems: 'center', gap: 1 }}>
          <NoteAlt sx={{ fontSize: 16, color: 'warning.main' }} />
          <Typography variant="subtitle2" fontWeight={700} sx={{ flex: 1 }}>Notebooks</Typography>
          <Tooltip title="New notebook">
            <IconButton size="small" onClick={() => { setEditingNb(null); setDialogOpen(true) }}>
              <Add sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {isLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}><CircularProgress size={20} /></Box>
          )}
          {!isLoading && notebooks.length === 0 && (
            <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
              <NoteAlt sx={{ fontSize: 32, opacity: 0.2, mb: 1 }} />
              <Typography variant="body2" color="text.disabled">No notebooks yet</Typography>
              <Button size="small" startIcon={<Add />} sx={{ mt: 1 }} onClick={() => { setEditingNb(null); setDialogOpen(true) }}>
                Create first
              </Button>
            </Box>
          )}
          <List dense disablePadding>
            {notebooks.map((nb) => (
              <ListItem
                key={nb.id}
                disablePadding
                secondaryAction={
                  <Box sx={{ display: 'flex', gap: 0 }}>
                    <Tooltip title="Edit in dialog">
                      <IconButton size="small" onClick={(e) => { e.stopPropagation(); setEditingNb(nb); setDialogOpen(true) }}>
                        <Edit sx={{ fontSize: 13 }} />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton size="small" onClick={(e) => { e.stopPropagation(); setDeleteId(nb.id) }}>
                        <Delete sx={{ fontSize: 13 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                }
              >
                <ListItemButton
                  selected={selectedId === nb.id}
                  onClick={() => setSelectedId(nb.id)}
                  sx={{ pl: 1.5, pr: 8 }}
                >
                  <ListItemText
                    primary={nb.name}
                    secondary={`${(nb.cells ?? []).length} cell${(nb.cells ?? []).length !== 1 ? 's' : ''}`}
                    primaryTypographyProps={{ variant: 'body2', noWrap: true, fontFamily: MONO, fontSize: '0.78rem' }}
                    secondaryTypographyProps={{ variant: 'caption', fontSize: '0.65rem' }}
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Box>
      </Paper>

      {/* Main panel */}
      {selected ? (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Toolbar */}
          <Box sx={{ px: 2, py: 1, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', alignItems: 'center', gap: 1, bgcolor: panelBg }}>
            <NoteAlt sx={{ fontSize: 15, color: 'warning.main' }} />
            <Typography variant="subtitle2" fontWeight={700} sx={{ fontFamily: MONO }}>{selected.name}</Typography>
            {selected.description && (
              <Typography variant="caption" color="text.secondary">— {selected.description}</Typography>
            )}
            <Chip label={`${(selected.cells ?? []).length} cells`} size="small" variant="outlined" sx={{ fontSize: '0.65rem', height: 18 }} />
            {inlineDirty && <Chip label="unsaved" size="small" color="warning" variant="outlined" sx={{ fontSize: '0.65rem', height: 18 }} />}
            <Box sx={{ flex: 1 }} />
            {inlineDirty && (
              <Button size="small" variant="contained" startIcon={updateMut.isPending ? <CircularProgress size={12} color="inherit" /> : <Save />}
                disabled={updateMut.isPending} onClick={saveInline}>
                Save
              </Button>
            )}
            <Button size="small" variant="outlined" startIcon={<Edit />}
              onClick={() => { setEditingNb(selected); setDialogOpen(true) }}>
              Edit Meta
            </Button>
            <Button size="small" variant="outlined" color="error" startIcon={<Delete />}
              onClick={() => setDeleteId(selected.id)}>
              Delete
            </Button>
          </Box>

          {/* Inline cell editor */}
          <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <Alert severity="info" icon={false} sx={{ mx: 2, mt: 1, py: 0.5, fontSize: '0.75rem' }}>
              Use <code style={{ fontFamily: MONO }}>source_df</code> as the input DataFrame and assign <code style={{ fontFamily: MONO }}>result_df</code> in the last cell.
              The <code style={{ fontFamily: MONO }}>spark</code> session is available throughout.
            </Alert>
            <NotebookEditor
              cells={inlineCells}
              onChange={(cells) => { setInlineCells(cells); setInlineDirty(true) }}
            />
          </Box>
        </Box>
      ) : (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'text.disabled', gap: 2 }}>
          <NoteAlt sx={{ fontSize: 56, opacity: 0.2 }} />
          <Typography variant="h6" color="text.disabled">Select a notebook to edit</Typography>
          <Button variant="contained" startIcon={<Add />} onClick={() => { setEditingNb(null); setDialogOpen(true) }}>
            New Notebook
          </Button>
        </Box>
      )}

      {/* Create/Edit dialog */}
      <NotebookFormDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        initial={editingNb ?? undefined}
        onSave={handleSave}
        saving={createMut.isPending || updateMut.isPending}
      />

      {/* Delete dialog */}
      <Dialog open={deleteId !== null} onClose={() => setDeleteId(null)} maxWidth="xs">
        <DialogTitle>Delete notebook?</DialogTitle>
        <DialogContent>
          <Typography>This will permanently delete <strong>{notebooks.find((n) => n.id === deleteId)?.name}</strong>.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteId(null)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={deleteMut.isPending}
            onClick={() => deleteId && deleteMut.mutate(deleteId)}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
