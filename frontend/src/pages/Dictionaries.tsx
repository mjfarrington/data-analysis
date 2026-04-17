import { useState } from 'react'
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  Divider, Grid, IconButton, List, ListItemButton, ListItemText,
  Paper, Stack, TextField, Tooltip, Typography,
} from '@mui/material'
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  MenuBook as DictIcon,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import {
  dictionariesApi,
  Dictionary,
  DictionaryCreate,
  DictionaryEntry,
  DictionaryEntryCreate,
} from '../api/client'

// ─── Dictionary dialog ────────────────────────────────────────────────────────

interface DictDialogProps {
  open: boolean
  initial?: Dictionary
  onClose: () => void
  onSave: (data: DictionaryCreate) => void
}

function DictDialog({ open, initial, onClose, onSave }: DictDialogProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [keyLabel, setKeyLabel] = useState(initial?.key_label ?? 'Key')
  const [valueLabel, setValueLabel] = useState(initial?.value_label ?? 'Value')

  // reset when dialog opens
  const handleEnter = () => {
    setName(initial?.name ?? '')
    setDescription(initial?.description ?? '')
    setKeyLabel(initial?.key_label ?? 'Key')
    setValueLabel(initial?.value_label ?? 'Value')
  }

  const valid = name.trim().length > 0 && keyLabel.trim().length > 0 && valueLabel.trim().length > 0

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth TransitionProps={{ onEnter: handleEnter }}>
      <DialogTitle>{initial ? 'Edit Dictionary' : 'New Dictionary'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} fullWidth size="small" required />
          <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth size="small" multiline rows={2} />
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <TextField
                label="Key label"
                value={keyLabel}
                onChange={(e) => setKeyLabel(e.target.value)}
                fullWidth size="small" required
                helperText="e.g. Application Name"
              />
            </Grid>
            <Grid item xs={6}>
              <TextField
                label="Value label"
                value={valueLabel}
                onChange={(e) => setValueLabel(e.target.value)}
                fullWidth size="small" required
                helperText="e.g. Application ID"
              />
            </Grid>
          </Grid>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!valid}
          onClick={() => onSave({ name: name.trim(), description: description.trim() || undefined, key_label: keyLabel.trim(), value_label: valueLabel.trim() })}>
          {initial ? 'Save' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Entry dialog ─────────────────────────────────────────────────────────────

interface EntryDialogProps {
  open: boolean
  keyLabel: string
  valueLabel: string
  initial?: DictionaryEntry
  onClose: () => void
  onSave: (data: DictionaryEntryCreate) => void
}

function EntryDialog({ open, keyLabel, valueLabel, initial, onClose, onSave }: EntryDialogProps) {
  const [key, setKey] = useState(initial?.key ?? '')
  const [value, setValue] = useState(initial?.value ?? '')

  const handleEnter = () => {
    setKey(initial?.key ?? '')
    setValue(initial?.value ?? '')
  }

  const valid = key.trim().length > 0 && value.trim().length > 0

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth TransitionProps={{ onEnter: handleEnter }}>
      <DialogTitle>{initial ? 'Edit Entry' : 'Add Entry'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label={keyLabel} value={key} onChange={(e) => setKey(e.target.value)} fullWidth size="small" required autoFocus />
          <TextField label={valueLabel} value={value} onChange={(e) => setValue(e.target.value)} fullWidth size="small" required />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!valid}
          onClick={() => onSave({ key: key.trim(), value: value.trim() })}>
          {initial ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Dictionaries() {
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [dictDialog, setDictDialog] = useState<{ open: boolean; edit?: Dictionary }>({ open: false })
  const [entryDialog, setEntryDialog] = useState<{ open: boolean; edit?: DictionaryEntry }>({ open: false })
  const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; type: 'dict' | 'entry'; id: number; dictId?: number }>({ open: false, type: 'dict', id: 0 })

  const { data: dicts = [] } = useQuery({
    queryKey: ['dictionaries'],
    queryFn: () => dictionariesApi.list().then((r) => r.data),
  })

  const selected = dicts.find((d) => d.id === selectedId) ?? null

  // ── Mutations ─────────────────────────────────────────────────────────────

  const createDict = useMutation({
    mutationFn: (data: Parameters<typeof dictionariesApi.create>[0]) => dictionariesApi.create(data),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['dictionaries'] })
      setDictDialog({ open: false })
      setSelectedId(res.data.id)
      enqueueSnackbar('Dictionary created', { variant: 'success' })
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.detail ?? 'Failed to create', { variant: 'error' }),
  })

  const updateDict = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof dictionariesApi.update>[1] }) =>
      dictionariesApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionaries'] })
      setDictDialog({ open: false })
      enqueueSnackbar('Dictionary updated', { variant: 'success' })
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.detail ?? 'Failed to update', { variant: 'error' }),
  })

  const deleteDict = useMutation({
    mutationFn: (id: number) => dictionariesApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionaries'] })
      setSelectedId(null)
      setConfirmDelete({ open: false, type: 'dict', id: 0 })
      enqueueSnackbar('Dictionary deleted', { variant: 'success' })
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.detail ?? 'Failed to delete', { variant: 'error' }),
  })

  const createEntry = useMutation({
    mutationFn: ({ dictId, data }: { dictId: number; data: DictionaryEntryCreate }) =>
      dictionariesApi.createEntry(dictId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionaries'] })
      setEntryDialog({ open: false })
      enqueueSnackbar('Entry added', { variant: 'success' })
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.detail ?? 'Failed to add entry', { variant: 'error' }),
  })

  const updateEntry = useMutation({
    mutationFn: ({ dictId, entryId, data }: { dictId: number; entryId: number; data: DictionaryEntryCreate }) =>
      dictionariesApi.updateEntry(dictId, entryId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionaries'] })
      setEntryDialog({ open: false })
      enqueueSnackbar('Entry updated', { variant: 'success' })
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.detail ?? 'Failed to update entry', { variant: 'error' }),
  })

  const deleteEntry = useMutation({
    mutationFn: ({ dictId, entryId }: { dictId: number; entryId: number }) =>
      dictionariesApi.deleteEntry(dictId, entryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionaries'] })
      setConfirmDelete({ open: false, type: 'dict', id: 0 })
      enqueueSnackbar('Entry deleted', { variant: 'success' })
    },
    onError: (e: any) => enqueueSnackbar(e.response?.data?.detail ?? 'Failed to delete entry', { variant: 'error' }),
  })

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Box sx={{ display: 'flex', gap: 2, height: '100%' }}>

      {/* Left — dictionary list */}
      <Paper variant="outlined" sx={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ p: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle2" fontWeight={600}>Dictionaries</Typography>
          <Tooltip title="New dictionary">
            <IconButton size="small" onClick={() => setDictDialog({ open: true })}>
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        <Divider />
        {dicts.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">No dictionaries yet.</Typography>
            <Button size="small" startIcon={<AddIcon />} sx={{ mt: 1 }} onClick={() => setDictDialog({ open: true })}>
              Create one
            </Button>
          </Box>
        ) : (
          <List dense sx={{ flex: 1, overflow: 'auto' }}>
            {dicts.map((d) => (
              <ListItemButton
                key={d.id}
                selected={d.id === selectedId}
                onClick={() => setSelectedId(d.id)}
                sx={{ borderRadius: 1, mx: 0.5 }}
              >
                <DictIcon sx={{ fontSize: 16, mr: 1, color: 'text.secondary' }} />
                <ListItemText
                  primary={d.name}
                  secondary={`${d.entries.length} entr${d.entries.length === 1 ? 'y' : 'ies'}`}
                  primaryTypographyProps={{ variant: 'body2', fontWeight: d.id === selectedId ? 600 : 400 }}
                  secondaryTypographyProps={{ variant: 'caption' }}
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </Paper>

      {/* Right — selected dictionary detail */}
      {selected ? (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>

          {/* Header */}
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Grid container alignItems="center" spacing={1}>
              <Grid item xs>
                <Typography variant="h6" fontWeight={600}>{selected.name}</Typography>
                {selected.description && (
                  <Typography variant="body2" color="text.secondary">{selected.description}</Typography>
                )}
              </Grid>
              <Grid item>
                <Stack direction="row" spacing={1}>
                  <Button size="small" startIcon={<EditIcon />} variant="outlined"
                    onClick={() => setDictDialog({ open: true, edit: selected })}>
                    Edit
                  </Button>
                  <Button size="small" startIcon={<DeleteIcon />} variant="outlined" color="error"
                    onClick={() => setConfirmDelete({ open: true, type: 'dict', id: selected.id })}>
                    Delete
                  </Button>
                </Stack>
              </Grid>
            </Grid>
          </Paper>

          {/* Entries table */}
          <Paper variant="outlined" sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Box sx={{ p: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="subtitle2" fontWeight={600}>
                Entries
                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                  {selected.key_label} → {selected.value_label}
                </Typography>
              </Typography>
              <Button size="small" startIcon={<AddIcon />} variant="outlined"
                onClick={() => setEntryDialog({ open: true })}>
                Add Entry
              </Button>
            </Box>
            <Divider />

            {/* Column headers */}
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', px: 2, py: 0.75, bgcolor: 'action.hover' }}>
              <Typography variant="caption" fontWeight={600} color="text.secondary">{selected.key_label}</Typography>
              <Typography variant="caption" fontWeight={600} color="text.secondary">{selected.value_label}</Typography>
              <Box sx={{ width: 64 }} />
            </Box>
            <Divider />

            <Box sx={{ flex: 1, overflow: 'auto' }}>
              {selected.entries.length === 0 ? (
                <Box sx={{ p: 3, textAlign: 'center' }}>
                  <Typography variant="body2" color="text.secondary">No entries. Add some to get started.</Typography>
                </Box>
              ) : (
                selected.entries.map((entry) => (
                  <Box
                    key={entry.id}
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr auto',
                      px: 2,
                      py: 0.75,
                      alignItems: 'center',
                      '&:hover': { bgcolor: 'action.hover' },
                      '&:not(:last-child)': { borderBottom: '1px solid', borderColor: 'divider' },
                    }}
                  >
                    <Typography variant="body2">{entry.key}</Typography>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{entry.value}</Typography>
                    <Stack direction="row" spacing={0.5}>
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => setEntryDialog({ open: true, edit: entry })}>
                          <EditIcon sx={{ fontSize: 15 }} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton size="small" color="error"
                          onClick={() => setConfirmDelete({ open: true, type: 'entry', id: entry.id, dictId: selected.id })}>
                          <DeleteIcon sx={{ fontSize: 15 }} />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Box>
                ))
              )}
            </Box>
          </Paper>
        </Box>
      ) : (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            {dicts.length === 0 ? 'Create a dictionary to get started.' : 'Select a dictionary from the list.'}
          </Typography>
        </Box>
      )}

      {/* Dictionary create/edit dialog */}
      <DictDialog
        open={dictDialog.open}
        initial={dictDialog.edit}
        onClose={() => setDictDialog({ open: false })}
        onSave={(data) => {
          if (dictDialog.edit) {
            updateDict.mutate({ id: dictDialog.edit.id, data })
          } else {
            createDict.mutate(data)
          }
        }}
      />

      {/* Entry add/edit dialog */}
      {selected && (
        <EntryDialog
          open={entryDialog.open}
          keyLabel={selected.key_label}
          valueLabel={selected.value_label}
          initial={entryDialog.edit}
          onClose={() => setEntryDialog({ open: false })}
          onSave={(data) => {
            if (entryDialog.edit) {
              updateEntry.mutate({ dictId: selected.id, entryId: entryDialog.edit.id, data })
            } else {
              createEntry.mutate({ dictId: selected.id, data })
            }
          }}
        />
      )}

      {/* Confirm delete dialog */}
      <Dialog open={confirmDelete.open} onClose={() => setConfirmDelete({ ...confirmDelete, open: false })} maxWidth="xs" fullWidth>
        <DialogTitle>Confirm delete</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {confirmDelete.type === 'dict'
              ? 'Delete this dictionary and all its entries? This cannot be undone.'
              : 'Delete this entry?'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete({ ...confirmDelete, open: false })}>Cancel</Button>
          <Button variant="contained" color="error" onClick={() => {
            if (confirmDelete.type === 'dict') {
              deleteDict.mutate(confirmDelete.id)
            } else if (confirmDelete.dictId != null) {
              deleteEntry.mutate({ dictId: confirmDelete.dictId, entryId: confirmDelete.id })
            }
          }}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
