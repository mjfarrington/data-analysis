import { useState } from 'react'
import {
  Box, Typography, Button, TextField, List, ListItem, ListItemButton,
  ListItemText, Divider, Chip, CircularProgress, IconButton, Tooltip,
  alpha, useTheme,
} from '@mui/material'
import {
  Add, Delete, ArrowUpward, ArrowDownward, PlayArrow, Code, Article,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { transformApi, NotebookFile, NotebookCell } from '../api/client'

let cellIdCounter = 1000

function generateId() {
  return `cell_${cellIdCounter++}_${Math.random().toString(36).slice(2, 7)}`
}

function NotebookCellView({
  cell,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: {
  cell: NotebookCell
  onUpdate: (patch: Partial<NotebookCell>) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  canMoveUp: boolean
  canMoveDown: boolean
}) {
  const theme = useTheme()
  const [output, setOutput] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  async function handleRun() {
    if (cell.type !== 'code') return
    setRunning(true)
    setOutput(null)
    // Simulate execution (no real kernel here)
    await new Promise(r => setTimeout(r, 800))
    setOutput(`[Executed at ${new Date().toLocaleTimeString()}]\n(No kernel attached — output placeholder)`)
    setRunning(false)
  }

  return (
    <Box
      sx={{
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 1.5,
        overflow: 'hidden',
        mb: 1.5,
      }}
    >
      {/* Cell header */}
      <Box
        sx={{
          display: 'flex', alignItems: 'center', gap: 1,
          px: 1.5, py: 0.5,
          bgcolor: alpha(theme.palette.background.paper, 0.7),
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Chip
          icon={cell.type === 'code' ? <Code sx={{ fontSize: '0.8rem !important' }} /> : <Article sx={{ fontSize: '0.8rem !important' }} />}
          label={cell.type}
          size="small"
          sx={{ fontSize: '0.65rem', height: 20 }}
          onClick={() => onUpdate({ type: cell.type === 'code' ? 'markdown' : 'code' })}
        />
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Move up"><span><IconButton size="small" onClick={onMoveUp} disabled={!canMoveUp}><ArrowUpward sx={{ fontSize: 14 }} /></IconButton></span></Tooltip>
        <Tooltip title="Move down"><span><IconButton size="small" onClick={onMoveDown} disabled={!canMoveDown}><ArrowDownward sx={{ fontSize: 14 }} /></IconButton></span></Tooltip>
        {cell.type === 'code' && (
          <Tooltip title="Run cell">
            <IconButton size="small" color="primary" onClick={handleRun} disabled={running}>
              {running ? <CircularProgress size={14} /> : <PlayArrow sx={{ fontSize: 16 }} />}
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Delete cell">
          <IconButton size="small" color="error" onClick={onDelete}>
            <Delete sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Content */}
      <Box
        component="textarea"
        value={cell.content}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate({ content: e.target.value })}
        spellCheck={false}
        rows={Math.max(3, cell.content.split('\n').length)}
        sx={{
          width: '100%',
          resize: 'vertical',
          border: 'none',
          outline: 'none',
          bgcolor: theme.palette.mode === 'dark'
            ? cell.type === 'code' ? '#0d1117' : alpha('#1c2230', 0.6)
            : cell.type === 'code' ? '#f8f9fa' : '#fafbfc',
          color: 'text.primary',
          fontFamily: cell.type === 'code'
            ? '"JetBrains Mono", Consolas, monospace'
            : '"Inter", sans-serif',
          fontSize: cell.type === 'code' ? '0.85rem' : '0.9rem',
          lineHeight: 1.7,
          p: 1.5,
          display: 'block',
          boxSizing: 'border-box',
        }}
      />

      {/* Output */}
      {output && (
        <Box
          sx={{
            borderTop: `1px solid ${theme.palette.divider}`,
            bgcolor: alpha(theme.palette.success.main, 0.04),
            p: 1.5,
          }}
        >
          <Typography
            component="pre"
            sx={{
              fontFamily: 'Consolas, monospace',
              fontSize: '0.8rem',
              color: 'text.secondary',
              m: 0, whiteSpace: 'pre-wrap',
            }}
          >
            {output}
          </Typography>
        </Box>
      )}
    </Box>
  )
}

export default function Notebooks() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [selected, setSelected] = useState<NotebookFile | null>(null)
  const [cells, setCells] = useState<NotebookCell[]>([])
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)

  const { data: notebooks = [], isLoading } = useQuery({
    queryKey: ['notebooks'],
    queryFn: transformApi.listNotebooks,
  })

  const createMut = useMutation({
    mutationFn: (data: Partial<NotebookFile>) => transformApi.createNotebook(data),
    onSuccess: (nb) => {
      qc.invalidateQueries({ queryKey: ['notebooks'] })
      openNotebook(nb)
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<NotebookFile> }) =>
      transformApi.updateNotebook(id, data),
    onSuccess: (nb) => {
      qc.invalidateQueries({ queryKey: ['notebooks'] })
      setSelected(nb)
    },
  })

  function openNotebook(nb: NotebookFile) {
    setSelected(nb)
    setTitle(nb.name)
    setCells(nb.cells.length > 0 ? nb.cells : [{ id: generateId(), type: 'code', content: '' }])
  }

  function addCell(type: 'code' | 'markdown' = 'code') {
    setCells(c => [...c, { id: generateId(), type, content: '' }])
  }

  function updateCell(id: string, patch: Partial<NotebookCell>) {
    setCells(c => c.map(cell => cell.id === id ? { ...cell, ...patch } : cell))
  }

  function deleteCell(id: string) {
    setCells(c => c.length > 1 ? c.filter(cell => cell.id !== id) : c)
  }

  function moveCell(id: string, dir: -1 | 1) {
    setCells(c => {
      const idx = c.findIndex(cell => cell.id === id)
      if (idx < 0) return c
      const newIdx = idx + dir
      if (newIdx < 0 || newIdx >= c.length) return c
      const arr = [...c]
      ;[arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]]
      return arr
    })
  }

  async function handleSave() {
    if (!selected) return
    setSaving(true)
    try {
      await updateMut.mutateAsync({ id: selected.id, data: { name: title, cells } })
    } finally {
      setSaving(false)
    }
  }

  function createNewNotebook() {
    createMut.mutate({
      name: `Notebook ${notebooks.length + 1}`,
      cells: [{ id: generateId(), type: 'code', content: '# New notebook\n' }],
    })
  }

  return (
    <Box sx={{ display: 'flex', height: '100%' }}>
      {/* Left panel */}
      <Box
        sx={{
          width: 240, flexShrink: 0,
          bgcolor: 'background.paper',
          borderRight: `1px solid ${theme.palette.divider}`,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <Box sx={{ p: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Typography variant="subtitle2" fontWeight={700}>Notebooks</Typography>
        </Box>

        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={24} /></Box>
          ) : (
            <List dense disablePadding>
              {notebooks.map(nb => (
                <ListItem key={nb.id} disablePadding>
                  <ListItemButton
                    selected={selected?.id === nb.id}
                    onClick={() => openNotebook(nb)}
                    sx={{ px: 2, py: 1 }}
                  >
                    <ListItemText
                      primary={nb.name}
                      secondary={`${nb.cells.length} cells`}
                      primaryTypographyProps={{ variant: 'body2', fontWeight: 500, noWrap: true }}
                      secondaryTypographyProps={{ variant: 'caption' }}
                    />
                  </ListItemButton>
                </ListItem>
              ))}
              {notebooks.length === 0 && (
                <Box sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>
                  <Typography variant="body2">No notebooks yet</Typography>
                </Box>
              )}
            </List>
          )}
        </Box>

        <Box sx={{ p: 1.5, borderTop: `1px solid ${theme.palette.divider}` }}>
          <Button startIcon={<Add />} fullWidth size="small" onClick={createNewNotebook} disabled={createMut.isPending}>
            New Notebook
          </Button>
        </Box>
      </Box>

      {/* Right panel: notebook editor */}
      {selected ? (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Header */}
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
              value={title}
              onChange={e => setTitle(e.target.value)}
              size="small"
              variant="standard"
              sx={{ '& input': { fontWeight: 700, fontSize: '1.1rem' } }}
              placeholder="Notebook title"
            />
            <Box sx={{ flex: 1 }} />
            <Button size="small" onClick={() => addCell('code')} startIcon={<Add />} variant="outlined">
              Code
            </Button>
            <Button size="small" onClick={() => addCell('markdown')} startIcon={<Add />} variant="outlined">
              Markdown
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={handleSave}
              disabled={saving || updateMut.isPending}
            >
              {saving ? <CircularProgress size={16} /> : 'Save'}
            </Button>
          </Box>

          {/* Cells */}
          <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
            {cells.map((cell, idx) => (
              <NotebookCellView
                key={cell.id}
                cell={cell}
                onUpdate={patch => updateCell(cell.id, patch)}
                onDelete={() => deleteCell(cell.id)}
                onMoveUp={() => moveCell(cell.id, -1)}
                onMoveDown={() => moveCell(cell.id, 1)}
                canMoveUp={idx > 0}
                canMoveDown={idx < cells.length - 1}
              />
            ))}
            <Button startIcon={<Add />} onClick={() => addCell('code')} sx={{ mt: 1 }} variant="outlined" size="small">
              Add Cell
            </Button>
          </Box>
        </Box>
      ) : (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary' }}>
          <Box sx={{ textAlign: 'center' }}>
            <Article sx={{ fontSize: 48, opacity: 0.3, mb: 2 }} />
            <Typography>Select or create a notebook</Typography>
          </Box>
        </Box>
      )}
    </Box>
  )
}
