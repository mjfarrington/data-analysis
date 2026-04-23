import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box, Typography, Button, TextField, MenuItem, Chip,
  InputAdornment, IconButton, List, ListItem, ListItemButton,
  Divider, CircularProgress, Tooltip,
  useTheme, alpha,
} from '@mui/material'
import {
  Add, Save, Delete, Search, Code, Description,
  Folder, ExpandMore, ChevronRight, History, CropSquare,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { sqlFilesApi, SqlFile, SqlFileVersion } from '../api/client'
import Editor, { OnMount } from '@monaco-editor/react'

const FILE_TYPES = ['extract', 'transform', 'load', 'utility']
const ROOT_KEY = '__root__'

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

export default function SqlFiles() {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const theme = useTheme()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<SqlFile | null>(null)
  const [editName, setEditName] = useState('')
  const [editType, setEditType] = useState('')
  const [editContent, setEditContent] = useState('')
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [creatingInPath, setCreatingInPath] = useState<string | null>(null)
  const [newName, setNewName] = useState('new-query')
  const [newType, setNewType] = useState('extract')
  const [versionTag, setVersionTag] = useState('DRAFT')
  const [saveMsg, setSaveMsg] = useState('')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['']))
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(320)
  const [leftResizing, setLeftResizing] = useState(false)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)

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
      setSelected(file)
      setSaveMsg('Saved!')
      setTimeout(() => setSaveMsg(''), 2000)
    },
  })

  const createVersionMut = useMutation({
    mutationFn: ({ id, tag, content }: { id: number; tag: string; content?: string }) =>
      sqlFilesApi.createVersion(id, { tag, content }),
    onSuccess: (file) => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      setSelected(file)
      setSaveMsg(`Version ${versionTag} saved`)
      setTimeout(() => setSaveMsg(''), 2000)
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => sqlFilesApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      setSelected(null)
      setEditName('')
      setEditType('')
      setEditContent('')
      setSelectedVersionId(null)
    },
  })

  function openFile(file: SqlFile) {
    setSelected(file)
    setEditName(file.name)
    setEditType(file.file_type)
    setEditContent(file.content)
    setSelectedVersionId(null)
  }

  function handleSave() {
    if (!selected) return
    updateMut.mutate({
      id: selected.id,
      data: { name: editName, file_type: editType, content: editContent },
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

  const versions: SqlFileVersion[] = selected?.versions ? [...selected.versions].reverse() : []
  const activeVersion = versions.find(v => String(v.id) === selectedVersionId) ?? null

  const lines = lineCount(editContent)
  const words = editContent.trim() ? editContent.trim().split(/\s+/).length : 0
  const chars = editContent.length

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
              const selectedFile = selected?.id === file.id
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
                      <Typography variant="caption" color="text.secondary" noWrap>{file.file_type}</Typography>
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
          gap: 1,
          px: 1.25,
          py: 0.5,
          borderBottom: `1px solid ${theme.palette.divider}`,
          bgcolor: alpha(theme.palette.background.paper, 0.9),
          flexShrink: 0,
        }}
      >
        <Button
          size="small"
          variant={leftCollapsed ? 'outlined' : 'text'}
          startIcon={<CropSquare sx={{ fontSize: 13 }} />}
          onClick={() => setLeftCollapsed(v => !v)}
          sx={{ minWidth: 0, px: 1 }}
        >
          {leftCollapsed ? 'Show Files' : 'Hide Files'}
        </Button>
        <Button
          size="small"
          variant={rightCollapsed ? 'outlined' : 'text'}
          startIcon={<CropSquare sx={{ fontSize: 13 }} />}
          onClick={() => setRightCollapsed(v => !v)}
          sx={{ minWidth: 0, px: 1 }}
        >
          {rightCollapsed ? 'Show Versions' : 'Hide Versions'}
        </Button>
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
                      <ListItemButton selected={selected?.id === file.id} onClick={() => openFile(file)} sx={{ py: 0.55, px: 1.25, borderRadius: 1 }}>
                        <Code sx={{ fontSize: 14, mr: 1, color: 'text.secondary' }} />
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                          <Typography variant="body2" noWrap sx={{ fontSize: '0.76rem', fontWeight: 500 }}>{file.name}</Typography>
                          <Typography variant="caption" color="text.secondary" noWrap>{file.file_type}</Typography>
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
                  if (!selected) return
                  createVersionMut.mutate({ id: selected.id, tag: versionTag, content: editContent })
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
                    if (!selected) return
                    if (!window.confirm(`Delete SQL file "${selected.name}"?`)) return
                    deleteMut.mutate(selected.id)
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
                value={editContent}
                onChange={(v) => setEditContent(v ?? '')}
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
                <Chip label={editType} size="small" sx={{ height: 18, fontSize: '0.62rem' }} />
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
                                {new Date(v.created_at).toLocaleString()} · Δ {changedLineCount(editContent, v.content)} rows
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
                          onClick={() => setEditContent(activeVersion.content)}
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
