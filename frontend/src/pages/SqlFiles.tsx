import { useState, useRef } from 'react'
import {
  Box, Typography, Button, TextField, MenuItem, Chip,
  InputAdornment, IconButton, List, ListItem, ListItemButton,
  ListItemText, Divider, CircularProgress, Alert, Tooltip,
  useTheme, alpha,
} from '@mui/material'
import {
  Add, Save, Delete, Search, Code, Description,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { sqlFilesApi, SqlFile } from '../api/client'

const FILE_TYPES = ['extract', 'transform', 'load', 'utility']

function syntaxHighlightSQL(sql: string): string {
  // Simple keyword highlighting as title-case hint (we render as plain textarea)
  return sql
}

export default function SqlFiles() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<SqlFile | null>(null)
  const [editName, setEditName] = useState('')
  const [editType, setEditType] = useState('')
  const [editContent, setEditContent] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState('extract')
  const [saveMsg, setSaveMsg] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { data: files = [], isLoading } = useQuery({
    queryKey: ['sql-files'],
    queryFn: () => sqlFilesApi.list(),
  })

  const createMut = useMutation({
    mutationFn: (data: Partial<SqlFile>) => sqlFilesApi.create(data),
    onSuccess: (file) => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      openFile(file)
      setNewOpen(false)
      setNewName('')
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<SqlFile> }) =>
      sqlFilesApi.update(id, data),
    onSuccess: (file) => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      setSelected(file)
      setSaveMsg('Saved!')
      setTimeout(() => setSaveMsg(''), 2000)
    },
  })

  function openFile(file: SqlFile) {
    setSelected(file)
    setEditName(file.name)
    setEditType(file.file_type)
    setEditContent(file.content)
  }

  function handleSave() {
    if (!selected) return
    updateMut.mutate({
      id: selected.id,
      data: { name: editName, file_type: editType, content: editContent },
    })
  }

  function handleCreate() {
    if (!newName.trim()) return
    createMut.mutate({ name: newName, file_type: newType, content: `-- ${newName}\n\n` })
  }

  const filtered = files.filter(f =>
    !search || f.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <Box sx={{ display: 'flex', height: '100%' }}>
      {/* Left panel: file list */}
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
            placeholder="Search files…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            size="small"
            fullWidth
            InputProps={{
              startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment>,
            }}
          />
        </Box>

        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={24} /></Box>
          ) : (
            <List dense disablePadding>
              {filtered.map(file => (
                <ListItem key={file.id} disablePadding>
                  <ListItemButton
                    selected={selected?.id === file.id}
                    onClick={() => openFile(file)}
                    sx={{ px: 2, py: 1 }}
                  >
                    <Code fontSize="small" sx={{ mr: 1.5, color: 'text.secondary', flexShrink: 0 }} />
                    <ListItemText
                      primary={file.name}
                      secondary={file.file_type}
                      primaryTypographyProps={{ variant: 'body2', fontWeight: 500, noWrap: true }}
                      secondaryTypographyProps={{ variant: 'caption' }}
                    />
                    <Chip
                      label={file.file_type}
                      size="small"
                      sx={{ fontSize: '0.6rem', height: 18, ml: 1 }}
                    />
                  </ListItemButton>
                </ListItem>
              ))}
              {filtered.length === 0 && (
                <Box sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>
                  <Typography variant="body2">No SQL files</Typography>
                </Box>
              )}
            </List>
          )}
        </Box>

        <Box sx={{ p: 1.5, borderTop: `1px solid ${theme.palette.divider}` }}>
          {newOpen ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <TextField
                label="File name"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                size="small"
                fullWidth
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
              />
              <TextField
                select label="Type" value={newType}
                onChange={e => setNewType(e.target.value)}
                size="small" fullWidth
              >
                {FILE_TYPES.map(t => <MenuItem key={t} value={t}>{t}</MenuItem>)}
              </TextField>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button size="small" variant="contained" onClick={handleCreate} disabled={createMut.isPending} sx={{ flex: 1 }}>
                  Create
                </Button>
                <Button size="small" onClick={() => setNewOpen(false)}>Cancel</Button>
              </Box>
            </Box>
          ) : (
            <Button startIcon={<Add />} fullWidth size="small" onClick={() => setNewOpen(true)}>
              New File
            </Button>
          )}
        </Box>
      </Box>

      {/* Right panel: editor */}
      {selected ? (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Toolbar */}
          <Box
            sx={{
              display: 'flex', alignItems: 'center', gap: 1.5,
              px: 2, py: 1,
              bgcolor: 'background.paper',
              borderBottom: `1px solid ${theme.palette.divider}`,
              flexShrink: 0,
            }}
          >
            <TextField
              value={editName}
              onChange={e => setEditName(e.target.value)}
              size="small"
              variant="standard"
              sx={{ '& input': { fontWeight: 600 } }}
              placeholder="File name"
            />
            <TextField
              select value={editType}
              onChange={e => setEditType(e.target.value)}
              size="small"
              variant="standard"
              sx={{ minWidth: 110 }}
            >
              {FILE_TYPES.map(t => <MenuItem key={t} value={t}>{t}</MenuItem>)}
            </TextField>
            <Box sx={{ flex: 1 }} />
            {saveMsg && <Typography variant="caption" color="success.main">{saveMsg}</Typography>}
            {updateMut.isPending && <CircularProgress size={16} />}
            <Button
              size="small"
              startIcon={<Save />}
              variant="contained"
              onClick={handleSave}
              disabled={updateMut.isPending}
            >
              Save
            </Button>
          </Box>

          {/* SQL Editor textarea */}
          <Box
            component="textarea"
            ref={textareaRef}
            value={editContent}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditContent(e.target.value)}
            spellCheck={false}
            sx={{
              flex: 1,
              width: '100%',
              resize: 'none',
              border: 'none',
              outline: 'none',
              bgcolor: theme.palette.mode === 'dark' ? '#0d1117' : '#f8f9fa',
              color: theme.palette.mode === 'dark' ? '#e6edf3' : '#1f2329',
              fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
              fontSize: '0.85rem',
              lineHeight: 1.7,
              p: 2,
              tabSize: 2,
            }}
          />
        </Box>
      ) : (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary' }}>
          <Box sx={{ textAlign: 'center' }}>
            <Description sx={{ fontSize: 48, opacity: 0.3, mb: 2 }} />
            <Typography>Select a SQL file to edit</Typography>
          </Box>
        </Box>
      )}
    </Box>
  )
}
