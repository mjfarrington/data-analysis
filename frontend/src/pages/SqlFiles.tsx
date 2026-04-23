import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box, Typography, Button, TextField, MenuItem, Chip,
  InputAdornment, IconButton, List, ListItem, ListItemButton,
  Divider, CircularProgress, Tooltip,
  useTheme, alpha,
} from '@mui/material'
import {
  Add, Save, Delete, Search, Code, Description,
  Folder, ExpandMore, ChevronRight, History, Close,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { sqlFilesApi, SqlFile, SqlFileVersion } from '../api/client'
import Editor, { OnMount } from '@monaco-editor/react'

const FILE_TYPES = ['extract', 'transform', 'load', 'utility']
const ROOT_KEY = '__root__'
const SQL_WORKSPACE_LAYOUT_KEY = 'sql-workspace-layout'

interface SqlWorkspaceLayout {
  leftSidebarWidth: number
  leftCollapsed: boolean
  rightCollapsed: boolean
}

interface SqlDraft {
  name: string
  file_type: string
  content: string
}

const DEFAULT_LAYOUT: SqlWorkspaceLayout = {
  leftSidebarWidth: 320,
  leftCollapsed: false,
  rightCollapsed: false,
}

function loadSqlWorkspaceLayout(): SqlWorkspaceLayout {
  try {
    const raw = localStorage.getItem(SQL_WORKSPACE_LAYOUT_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as Partial<SqlWorkspaceLayout>
    return {
      leftSidebarWidth: Math.max(240, Math.min(560, Number(parsed.leftSidebarWidth ?? DEFAULT_LAYOUT.leftSidebarWidth))),
      leftCollapsed: Boolean(parsed.leftCollapsed),
      rightCollapsed: Boolean(parsed.rightCollapsed),
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

interface FolderNode {
  id: string
  name: string
  path: string
  folders: FolderNode[]
  files: SqlFile[]
}

interface TypeGroup {
  type: string
  tree: FolderNode
}

function lineCount(content: string): number {
  if (!content) return 0
  return content.split(/\r?\n/).length
}

function changedLineCount(current: string, other: string): number {
  const a = current.split(/\r?\n/)
  const b = other.split(/\r?\n/)
  const max = Math.max(a.length, b.length)
  let changed = 0
  for (let i = 0; i < max; i++) {
    if ((a[i] ?? '') !== (b[i] ?? '')) changed++
  }
  return changed
}

function buildTree(files: SqlFile[], search: string): FolderNode {
  const root: FolderNode = { id: ROOT_KEY, name: 'root', path: '', folders: [], files: [] }
  const folderMap = new Map<string, FolderNode>()
  folderMap.set('', root)

  const ensureFolder = (path: string): FolderNode => {
    if (folderMap.has(path)) return folderMap.get(path)!
    const parts = path.split('/').filter(Boolean)
    const parentPath = parts.slice(0, -1).join('/')
    const name = parts[parts.length - 1]
    const parent = ensureFolder(parentPath)
    const node: FolderNode = {
      id: `folder:${path}`,
      name,
      path,
      folders: [],
      files: [],
    }
    parent.folders.push(node)
    folderMap.set(path, node)
    return node
  }

  const q = search.trim().toLowerCase()
  const matched = files
    .filter(f => !q || f.name.toLowerCase().includes(q) || f.file_type.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const file of matched) {
    const parts = file.name.split('/').filter(Boolean)
    const folderPath = parts.slice(0, -1).join('/')
    const folder = ensureFolder(folderPath)
    folder.files.push(file)
  }

  const sortFolders = (node: FolderNode) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name))
    node.files.sort((a, b) => a.name.localeCompare(b.name))
    node.folders.forEach(sortFolders)
  }
  sortFolders(root)
  return root
}

function buildTypeGroups(files: SqlFile[], search: string): TypeGroup[] {
  return FILE_TYPES
    .map(type => ({
      type,
      tree: buildTree(files.filter(f => f.file_type === type), search),
    }))
    .filter(group => group.tree.folders.length > 0 || group.tree.files.length > 0)
}

function PanelSideIcon({ side, active }: { side: 'left' | 'right'; active: boolean }) {
  return (
    <Box
      sx={{
        width: 14,
        height: 14,
        border: '1.5px solid currentColor',
        borderRadius: '2px',
        position: 'relative',
        overflow: 'hidden',
        opacity: active ? 1 : 0.65,
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          width: '38%',
          [side]: 0,
          bgcolor: 'currentColor',
          opacity: active ? 0.85 : 0.2,
        }}
      />
    </Box>
  )
}

export default function SqlFiles() {
  const initialLayoutRef = useRef<SqlWorkspaceLayout>(loadSqlWorkspaceLayout())
  const rootRef = useRef<HTMLDivElement | null>(null)
  const theme = useTheme()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [openFileIds, setOpenFileIds] = useState<number[]>([])
  const [activeFileId, setActiveFileId] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Record<number, SqlDraft>>({})
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [creatingInPath, setCreatingInPath] = useState<string | null>(null)
  const [newName, setNewName] = useState('new-query')
  const [newType, setNewType] = useState('extract')
  const [versionTag, setVersionTag] = useState('DRAFT')
  const [saveMsg, setSaveMsg] = useState('')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['']))
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(initialLayoutRef.current.leftSidebarWidth)
  const [leftResizing, setLeftResizing] = useState(false)
  const [leftCollapsed, setLeftCollapsed] = useState(initialLayoutRef.current.leftCollapsed)
  const [rightCollapsed, setRightCollapsed] = useState(initialLayoutRef.current.rightCollapsed)

  const { data: files = [], isLoading } = useQuery({
    queryKey: ['sql-files'],
    queryFn: () => sqlFilesApi.list(),
  })

  const { data: labelsResp } = useQuery({
    queryKey: ['sql-version-labels'],
    queryFn: () => sqlFilesApi.getVersionLabels(),
  })
  const versionLabels = labelsResp?.labels?.length
    ? labelsResp.labels
    : ['INITIAL', 'DRAFT', 'FINAL', 'DEPRECATED']

  const createMut = useMutation({
    mutationFn: (data: Partial<SqlFile>) => sqlFilesApi.create(data),
    onSuccess: (file) => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      openFile(file)
      setCreatingInPath(null)
      setNewName('')
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<SqlFile> }) =>
      sqlFilesApi.update(id, data),
    onSuccess: (file) => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      setDrafts(prev => ({
        ...prev,
        [file.id]: { name: file.name, file_type: file.file_type, content: file.content },
      }))
      setSaveMsg('Saved!')
      setTimeout(() => setSaveMsg(''), 2000)
    },
  })

  const createVersionMut = useMutation({
    mutationFn: ({ id, tag, content }: { id: number; tag: string; content?: string }) =>
      sqlFilesApi.createVersion(id, { tag, content }),
    onSuccess: (file) => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      setDrafts(prev => ({
        ...prev,
        [file.id]: { name: file.name, file_type: file.file_type, content: file.content },
      }))
      setSaveMsg(`Version ${versionTag} saved`)
      setTimeout(() => setSaveMsg(''), 2000)
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => sqlFilesApi.delete(id),
    onSuccess: (_, deletedId) => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      setOpenFileIds(prev => {
        const idx = prev.indexOf(deletedId)
        const next = prev.filter(id => id !== deletedId)
        if (activeFileId === deletedId) {
          const fallback = next[idx] ?? next[idx - 1] ?? null
          setActiveFileId(fallback)
        }
        return next
      })
      setDrafts(prev => {
        const next = { ...prev }
        delete next[deletedId]
        return next
      })
      setSelectedVersionId(null)
    },
  })

  function openFile(file: SqlFile) {
    setOpenFileIds(prev => (prev.includes(file.id) ? prev : [...prev, file.id]))
    setActiveFileId(file.id)
    setDrafts(prev => {
      if (prev[file.id]) return prev
      return {
        ...prev,
        [file.id]: { name: file.name, file_type: file.file_type, content: file.content },
      }
    })
    setSelectedVersionId(null)
  }

  function closeFile(fileId: number) {
    setOpenFileIds(prev => {
      const idx = prev.indexOf(fileId)
      const next = prev.filter(id => id !== fileId)
      if (activeFileId === fileId) {
        const fallback = next[idx] ?? next[idx - 1] ?? null
        setActiveFileId(fallback)
      }
      return next
    })
    setDrafts(prev => {
      const next = { ...prev }
      delete next[fileId]
      return next
    })
  }

  function updateActiveDraft(patch: Partial<SqlDraft>) {
    if (activeFileId == null) return
    setDrafts(prev => {
      const existing = prev[activeFileId]
      if (!existing) return prev
      return { ...prev, [activeFileId]: { ...existing, ...patch } }
    })
  }

  const fileById = useMemo(() => {
    const map = new Map<number, SqlFile>()
    files.forEach(f => map.set(f.id, f))
    return map
  }, [files])

  const activeFile = activeFileId != null ? (fileById.get(activeFileId) ?? null) : null
  const activeDraft = activeFileId != null ? drafts[activeFileId] : undefined

  function handleSave() {
    if (!activeFile || !activeDraft) return
    updateMut.mutate({
      id: activeFile.id,
      data: { name: activeDraft.name, file_type: activeDraft.file_type, content: activeDraft.content },
    })
  }

  function handleCreateInline(parentPath: string) {
    const baseName = newName.trim().replace(/\.sql$/i, '')
    if (!baseName) return
    const fileName = `${baseName}.sql`
    const fullName = parentPath ? `${parentPath}/${fileName}` : fileName
    createMut.mutate({ name: fullName, file_type: newType, content: `-- ${fullName}\n\nSELECT\n  *\nFROM\n  your_table;\n` })
  }

  const renderCreateComposer = (parentPath: string, leftPadding: string | number = 0): React.ReactNode => (
    <Box
      sx={{
        pl: leftPadding,
        pr: 1.25,
        pb: 1,
      }}
    >
      <Box
        sx={{
          p: 1,
          borderRadius: 1.5,
          border: `1px solid ${alpha(theme.palette.primary.main, 0.22)}`,
          bgcolor: alpha(theme.palette.primary.main, 0.05),
          display: 'flex',
          flexDirection: 'column',
          gap: 0.8,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Chip label={parentPath || 'root'} size="small" sx={{ height: 18, fontSize: '0.6rem', textTransform: 'uppercase' }} />
          <Typography variant="caption" color="text.secondary">Create SQL file</Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
          <TextField
            size="small"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="new-query"
            autoFocus
            sx={{ flex: 1 }}
            slotProps={{
              input: {
                endAdornment: <InputAdornment position="end">.sql</InputAdornment>,
              },
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleCreateInline(parentPath)
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setCreatingInPath(null)
              }
            }}
          />
          <TextField select size="small" value={newType} onChange={e => setNewType(e.target.value)} sx={{ width: 128 }}>
            {FILE_TYPES.map(t => <MenuItem key={t} value={t}>{t}</MenuItem>)}
          </TextField>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.75 }}>
          <Button size="small" onClick={() => setCreatingInPath(null)}>Cancel</Button>
          <Button size="small" variant="contained" onClick={() => handleCreateInline(parentPath)} disabled={createMut.isPending}>
            Create File
          </Button>
        </Box>
      </Box>
    </Box>
  )

  const grouped = useMemo(() => buildTypeGroups(files, search), [files, search])

  const versions: SqlFileVersion[] = activeFile?.versions ? [...activeFile.versions].reverse() : []
  const activeVersion = versions.find(v => String(v.id) === selectedVersionId) ?? null

  const content = activeDraft?.content ?? ''
  const lines = lineCount(content)
  const words = content.trim() ? content.trim().split(/\s+/).length : 0
  const chars = content.length

  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  useEffect(() => {
    if (!leftResizing) return

    const onMouseMove = (e: MouseEvent) => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const next = Math.max(240, Math.min(560, e.clientX - rect.left))
      setLeftSidebarWidth(next)
    }

    const onMouseUp = () => {
      setLeftResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [leftResizing])

  const onEditorMount: OnMount = (editor, monaco) => {
    editor.onDidChangeCursorPosition((e: any) => {
      setCursor({ line: e.position.lineNumber, column: e.position.column })
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleSave()
    })
  }

  useEffect(() => {
    if (!versionLabels.includes(versionTag)) {
      setVersionTag(versionLabels[0] ?? 'DRAFT')
    }
  }, [versionLabels, versionTag])

  useEffect(() => {
    localStorage.setItem(
      SQL_WORKSPACE_LAYOUT_KEY,
      JSON.stringify({ leftSidebarWidth, leftCollapsed, rightCollapsed }),
    )
  }, [leftSidebarWidth, leftCollapsed, rightCollapsed])

  useEffect(() => {
    if (activeFileId == null || !activeFile) return
    setDrafts(prev => {
      if (prev[activeFileId]) return prev
      return {
        ...prev,
        [activeFileId]: { name: activeFile.name, file_type: activeFile.file_type, content: activeFile.content },
      }
    })
  }, [activeFileId, activeFile])

  const renderFolder = (folder: FolderNode, depth = 0): React.ReactNode => {
    const expanded = expandedFolders.has(folder.path)
    return (
      <Box key={folder.id}>
        {folder.path !== '' && (
          <ListItem disablePadding sx={{ pl: `${depth * 14}px` }}>
            <ListItemButton sx={{ py: 0.5, px: 1 }} onClick={() => toggleFolder(folder.path)}>
              <Box sx={{ width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', mr: 0.5 }}>
                {expanded ? <ExpandMore sx={{ fontSize: 14 }} /> : <ChevronRight sx={{ fontSize: 14 }} />}
              </Box>
              <Folder sx={{ fontSize: 16, mr: 0.75, color: 'warning.main' }} />
              <Typography variant="body2" noWrap sx={{ flex: 1, fontSize: '0.78rem' }}>{folder.name}</Typography>
              <Tooltip title="New file in folder">
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation()
                    setCreatingInPath(folder.path)
                    setNewName('new-query')
                    setNewType('extract')
                  }}
                >
                  <Add sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </ListItemButton>
          </ListItem>
        )}

        {expanded && (
          <>
            {creatingInPath === folder.path && (
              renderCreateComposer(folder.path, `${(depth + 1) * 14 + 12}px`)
            )}

            {folder.folders.map(child => renderFolder(child, depth + 1))}
            {folder.files.map(file => {
              const selectedFile = activeFileId === file.id
              return (
                <ListItem key={file.id} disablePadding sx={{ pl: `${(depth + 1) * 14}px` }}>
                  <ListItemButton
                    selected={selectedFile}
                    onClick={() => openFile(file)}
                    sx={{ py: 0.55, px: 1.25, borderRadius: 1 }}
                  >
                    <Code sx={{ fontSize: 14, mr: 1, color: 'text.secondary' }} />
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" noWrap sx={{ fontSize: '0.76rem', fontWeight: 500 }}>
                        {file.name.split('/').pop()}
                      </Typography>
                    </Box>
                  </ListItemButton>
                </ListItem>
              )
            })}
          </>
        )}
      </Box>
    )
  }

  return (
    <Box ref={rootRef} sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Dedicated panel controls row (VS Code-like separation) */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1.25,
          py: 0.5,
          borderBottom: `1px solid ${theme.palette.divider}`,
          bgcolor: alpha(theme.palette.background.paper, 0.9),
          flexShrink: 0,
        }}
      >
        <Box sx={{ flex: 1 }} />
        <Tooltip title={leftCollapsed ? 'Show files panel' : 'Hide files panel'}>
          <IconButton
            size="small"
            onClick={() => setLeftCollapsed(v => !v)}
            sx={{
              color: leftCollapsed ? 'text.secondary' : 'primary.main',
              border: '1px solid',
              borderColor: leftCollapsed ? 'divider' : alpha(theme.palette.primary.main, 0.35),
              borderRadius: 1,
            }}
          >
            <PanelSideIcon side="left" active={!leftCollapsed} />
          </IconButton>
        </Tooltip>
        <Tooltip title={rightCollapsed ? 'Show versions panel' : 'Hide versions panel'}>
          <IconButton
            size="small"
            onClick={() => setRightCollapsed(v => !v)}
            sx={{
              color: rightCollapsed ? 'text.secondary' : 'primary.main',
              border: '1px solid',
              borderColor: rightCollapsed ? 'divider' : alpha(theme.palette.primary.main, 0.35),
              borderRadius: 1,
            }}
          >
            <PanelSideIcon side="right" active={!rightCollapsed} />
          </IconButton>
        </Tooltip>
      </Box>

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* Left panel: folder tree */}
      {!leftCollapsed && (
      <Box
        sx={{
          width: leftSidebarWidth, flexShrink: 0,
          bgcolor: 'background.paper',
          borderRight: `1px solid ${theme.palette.divider}`,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <Box sx={{ p: 1.5, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, letterSpacing: '0.01em' }}>SQL Workspace</Typography>
            <Box sx={{ flex: 1 }} />
            <Tooltip title="New file at root">
              <IconButton
                size="small"
                onClick={() => {
                  setCreatingInPath('')
                  setExpandedFolders(prev => new Set(prev).add(''))
                  setNewName('new-query')
                  setNewType('extract')
                }}
              >
                <Add sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Box>
          <TextField
            placeholder="Search files…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            size="small"
            fullWidth
            slotProps={{
              input: {
                startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment>,
              },
            }}
          />
        </Box>

        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={24} /></Box>
          ) : (
            <List dense disablePadding sx={{ px: 0.5, py: 0.5 }}>
              {creatingInPath === '' && (
                renderCreateComposer('', '4px')
              )}
              {grouped.map(group => (
                <Box key={group.type} sx={{ mb: 0.5 }}>
                  <Box sx={{ px: 1.25, py: 0.5 }}>
                    <Typography
                      variant="caption"
                      sx={{
                        fontSize: '0.62rem',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: 'text.secondary',
                        fontWeight: 700,
                      }}
                    >
                      {group.type}
                    </Typography>
                  </Box>
                  {group.tree.folders.map(folder => renderFolder(folder, 0))}
                  {group.tree.files.map(file => (
                    <ListItem key={file.id} disablePadding>
                      <ListItemButton selected={activeFileId === file.id} onClick={() => openFile(file)} sx={{ py: 0.55, px: 1.25, borderRadius: 1 }}>
                        <Code sx={{ fontSize: 14, mr: 1, color: 'text.secondary' }} />
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                          <Typography variant="body2" noWrap sx={{ fontSize: '0.76rem', fontWeight: 500 }}>{file.name}</Typography>
                        </Box>
                      </ListItemButton>
                    </ListItem>
                  ))}
                </Box>
              ))}
              {grouped.length === 0 && (
                <Box sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>
                  <Typography variant="body2">No SQL files</Typography>
                </Box>
              )}
            </List>
          )}
        </Box>
      </Box>
      )}

      {/* Splitter: resize left sidebar */}
      {!leftCollapsed && (
        <Box
          onMouseDown={() => setLeftResizing(true)}
          sx={{
            width: 6,
            cursor: 'col-resize',
            flexShrink: 0,
            bgcolor: leftResizing ? alpha(theme.palette.primary.main, 0.18) : 'transparent',
            transition: 'background-color 120ms ease',
            '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.12) },
          }}
        />
      )}

      {/* Right panel: editor + version controller */}
      {activeFile && activeDraft ? (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Open file tabs */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              px: 1,
              py: 0.5,
              borderBottom: `1px solid ${theme.palette.divider}`,
              bgcolor: alpha(theme.palette.background.paper, 0.65),
              overflowX: 'auto',
              flexShrink: 0,
            }}
          >
            {openFileIds.map(id => {
              const file = fileById.get(id)
              const draft = drafts[id]
              const label = draft?.name ?? file?.name ?? `File ${id}`
              const isActive = id === activeFileId
              return (
                <Box
                  key={id}
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                    border: '1px solid',
                    borderColor: isActive ? 'primary.main' : 'divider',
                    bgcolor: isActive ? alpha(theme.palette.primary.main, 0.1) : 'background.paper',
                    borderRadius: 1,
                    px: 0.75,
                    py: 0.35,
                    minWidth: 0,
                  }}
                >
                  <Button
                    size="small"
                    onClick={() => setActiveFileId(id)}
                    sx={{ minWidth: 0, px: 0.25, py: 0, textTransform: 'none' }}
                  >
                    <Typography variant="caption" noWrap sx={{ maxWidth: 180, color: 'text.primary' }}>
                      {label.split('/').pop()}
                    </Typography>
                  </Button>
                  <IconButton size="small" onClick={() => closeFile(id)} sx={{ p: 0.2 }}>
                    <Close sx={{ fontSize: 12 }} />
                  </IconButton>
                </Box>
              )
            })}
          </Box>

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
              value={activeDraft.name}
              onChange={e => updateActiveDraft({ name: e.target.value })}
              size="small"
              variant="standard"
              sx={{ '& input': { fontWeight: 600 } }}
              placeholder="File name"
            />
            <TextField
              select value={activeDraft.file_type}
              onChange={e => updateActiveDraft({ file_type: e.target.value })}
              size="small"
              variant="standard"
              sx={{ minWidth: 110 }}
            >
              {FILE_TYPES.map(t => <MenuItem key={t} value={t}>{t}</MenuItem>)}
            </TextField>
            <Box sx={{ flex: 1 }} />
            {saveMsg && <Typography variant="caption" color="success.main">{saveMsg}</Typography>}
            {updateMut.isPending && <CircularProgress size={16} />}
            <TextField
              select
              size="small"
              variant="standard"
              value={versionTag}
              onChange={e => setVersionTag(e.target.value)}
              sx={{ minWidth: 130 }}
            >
              {versionLabels.map(label => <MenuItem key={label} value={label}>{label}</MenuItem>)}
            </TextField>
            <Tooltip title="Create snapshot">
              <IconButton
                size="small"
                onClick={() => {
                  createVersionMut.mutate({ id: activeFile.id, tag: versionTag, content: activeDraft.content })
                }}
                disabled={createVersionMut.isPending}
              >
                <History sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
            <Button
              size="small"
              startIcon={<Save />}
              variant="contained"
              onClick={handleSave}
              disabled={updateMut.isPending}
            >
              Save
            </Button>
            <Tooltip title="Delete file">
              <span>
                <IconButton
                  size="small"
                  color="error"
                  disabled={deleteMut.isPending}
                  onClick={() => {
                    if (!window.confirm(`Delete SQL file "${activeFile.name}"?`)) return
                    deleteMut.mutate(activeFile.id)
                  }}
                >
                  <Delete sx={{ fontSize: 16 }} />
                </IconButton>
              </span>
            </Tooltip>
          </Box>

          <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <Editor
                height="100%"
                language="sql"
                value={activeDraft.content}
                onChange={(v) => updateActiveDraft({ content: v ?? '' })}
                onMount={onEditorMount}
                theme={theme.palette.mode === 'dark' ? 'vs-dark' : 'vs'}
                options={{
                  minimap: { enabled: true, scale: 1, maxColumn: 160 },
                  fontFamily: 'JetBrains Mono, Fira Code, ui-monospace, monospace',
                  fontLigatures: true,
                  fontSize: 13,
                  lineHeight: 21,
                  wordWrap: 'off',
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  cursorBlinking: 'smooth',
                  renderLineHighlight: 'gutter',
                  bracketPairColorization: { enabled: true },
                  suggest: { showKeywords: true },
                  quickSuggestions: true,
                  tabSize: 2,
                  insertSpaces: true,
                  padding: { top: 10, bottom: 10 },
                }}
              />
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 1.5,
                  py: 0.5,
                  borderTop: `1px solid ${theme.palette.divider}`,
                  bgcolor: 'background.paper',
                }}
              >
                <Chip label={activeDraft.file_type} size="small" sx={{ height: 18, fontSize: '0.62rem' }} />
                <Typography variant="caption" color="text.secondary">Rows: {lines}</Typography>
                <Typography variant="caption" color="text.secondary">Words: {words}</Typography>
                <Typography variant="caption" color="text.secondary">Chars: {chars}</Typography>
                <Box sx={{ flex: 1 }} />
                <Typography variant="caption" color="text.secondary">Ln {cursor.line}, Col {cursor.column}</Typography>
              </Box>
            </Box>

            {/* Version controller */}
            <Box
              sx={{
                width: rightCollapsed ? 0 : 300,
                flexShrink: 0,
                borderLeft: rightCollapsed ? 'none' : `1px solid ${theme.palette.divider}`,
                bgcolor: 'background.paper',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                transition: 'width 180ms ease',
                overflow: 'hidden',
              }}
            >
              {!rightCollapsed && (
                <>
                  <Box sx={{ px: 1.5, py: 1, borderBottom: `1px solid ${theme.palette.divider}` }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Version Timeline</Typography>
                    <Typography variant="caption" color="text.secondary">Local snapshots and saved revisions</Typography>
                  </Box>
                  <Box sx={{ flex: 1, overflowY: 'auto' }}>
                    <List dense disablePadding>
                      {versions.map(v => (
                        <ListItem key={v.id} disablePadding>
                          <ListItemButton selected={selectedVersionId === String(v.id)} onClick={() => setSelectedVersionId(String(v.id))} sx={{ py: 0.75, px: 1.25 }}>
                            <Box sx={{ minWidth: 0, flex: 1 }}>
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                                <Typography variant="body2" noWrap sx={{ fontSize: '0.75rem', fontWeight: 600 }}>{v.version}</Typography>
                                <Chip label={v.tag} size="small" sx={{ height: 16, fontSize: '0.56rem', textTransform: 'uppercase' }} />
                              </Box>
                              <Typography variant="caption" color="text.secondary" noWrap>
                                {new Date(v.created_at).toLocaleString()} · Δ {changedLineCount(activeDraft.content, v.content)} rows
                              </Typography>
                            </Box>
                          </ListItemButton>
                        </ListItem>
                      ))}
                    </List>
                  </Box>
                  {activeVersion && (
                    <>
                      <Divider />
                      <Box sx={{ p: 1.25, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                        <Typography variant="caption" color="text.secondary">Preview</Typography>
                        <Box
                          sx={{
                            border: `1px solid ${theme.palette.divider}`,
                            borderRadius: 1,
                            bgcolor: alpha(theme.palette.background.default, 0.6),
                            p: 1,
                            maxHeight: 120,
                            overflow: 'auto',
                            fontFamily: 'JetBrains Mono, monospace',
                            fontSize: '0.68rem',
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {activeVersion.content.slice(0, 1600)}
                        </Box>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => updateActiveDraft({ content: activeVersion.content })}
                        >
                          Restore This Version
                        </Button>
                      </Box>
                    </>
                  )}
                </>
              )}
            </Box>
          </Box>
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
    </Box>
  )
}
