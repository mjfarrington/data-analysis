import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box, Typography, Button, TextField, MenuItem, Chip,
  InputAdornment, IconButton, List, ListItem, ListItemButton,
  Divider, CircularProgress, Tooltip, Dialog, DialogTitle,
  DialogContent, DialogActions, Menu,
  useTheme, alpha,
} from '@mui/material'
import {
  Add, Save, Delete, Search, Code, Description,
  Folder, ExpandMore, ChevronRight, History, Close, Edit,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { connectionsApi, Connection, sqlFilesApi, SqlFile, SqlFileVersion } from '../api/client'
import Editor, { BeforeMount, OnMount } from '@monaco-editor/react'
import { useThemeStore } from '../store/theme'
import {
  workspaceSidebarSurfaceSx,
  workspaceSidebarItemButtonSx,
  workspaceSidebarItemTextSx,
  workspaceSidebarSectionLabelSx,
} from '../components/workspace/WorkspaceTemplate'

const FILE_TYPES = ['extract', 'transform', 'load', 'utility']
const ROOT_KEY = '__root__'
const SQL_WORKSPACE_LAYOUT_KEY = 'sql-workspace-layout'
const SQL_WORKSPACE_TABS_KEY = 'sql-workspace-open-tabs'

interface SqlWorkspaceLayout {
  leftSidebarWidth: number
  leftCollapsed: boolean
  rightCollapsed: boolean
}

interface SqlDraft {
  name: string
  display_name: string
  file_type: string
  content: string
}

interface SqlWorkspaceTabsState {
  openFileIds: number[]
  activeFileId: number | null
}

type SqlSourceType = 'datawarehouse' | 'jdbc'

interface SqlFileMetadata {
  source_type?: SqlSourceType
  source_connection_id?: number
  notes?: string
}

const SQL_METADATA_PREFIX = '__sql_meta__:'

const DEFAULT_LAYOUT: SqlWorkspaceLayout = {
  leftSidebarWidth: 320,
  leftCollapsed: false,
  rightCollapsed: false,
}

const DEFAULT_TABS_STATE: SqlWorkspaceTabsState = {
  openFileIds: [],
  activeFileId: null,
}

function parseSqlFileMetadata(description?: string): SqlFileMetadata {
  if (!description || !description.startsWith(SQL_METADATA_PREFIX)) return {}
  const raw = description.slice(SQL_METADATA_PREFIX.length).trim()
  try {
    const parsed = JSON.parse(raw) as SqlFileMetadata
    const out: SqlFileMetadata = {}
    if (parsed.source_type === 'datawarehouse' || parsed.source_type === 'jdbc') {
      out.source_type = parsed.source_type
    }
    if (Number.isInteger(parsed.source_connection_id) && Number(parsed.source_connection_id) > 0) {
      out.source_connection_id = Number(parsed.source_connection_id)
    }
    if (typeof parsed.notes === 'string') out.notes = parsed.notes
    return out
  } catch {
    return {}
  }
}

function buildSqlFileMetadataDescription(meta: SqlFileMetadata): string | undefined {
  const payload: SqlFileMetadata = {}
  if (meta.source_type === 'datawarehouse' || meta.source_type === 'jdbc') {
    payload.source_type = meta.source_type
  }
  if (Number.isInteger(meta.source_connection_id) && Number(meta.source_connection_id) > 0) {
    payload.source_connection_id = Number(meta.source_connection_id)
  }
  if (meta.notes?.trim()) payload.notes = meta.notes.trim()
  if (!payload.source_type && !payload.source_connection_id && !payload.notes) return undefined
  return `${SQL_METADATA_PREFIX}${JSON.stringify(payload)}`
}

function loadSqlWorkspaceLayout(): SqlWorkspaceLayout {
  try {
    const raw = localStorage.getItem(SQL_WORKSPACE_LAYOUT_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as Partial<SqlWorkspaceLayout>
    return {
      leftSidebarWidth: Math.max(170, Math.min(560, Number(parsed.leftSidebarWidth ?? DEFAULT_LAYOUT.leftSidebarWidth))),
      leftCollapsed: Boolean(parsed.leftCollapsed),
      rightCollapsed: Boolean(parsed.rightCollapsed),
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

function loadSqlWorkspaceTabsState(): SqlWorkspaceTabsState {
  try {
    const raw = localStorage.getItem(SQL_WORKSPACE_TABS_KEY)
    if (!raw) return DEFAULT_TABS_STATE
    const parsed = JSON.parse(raw) as Partial<SqlWorkspaceTabsState>
    const openFileIds = Array.isArray(parsed.openFileIds)
      ? parsed.openFileIds
          .map(v => Number(v))
          .filter(v => Number.isInteger(v) && v > 0)
      : []
    const parsedActiveFileId = parsed.activeFileId == null ? null : Number(parsed.activeFileId)
    return {
      openFileIds,
      activeFileId: parsedActiveFileId != null && Number.isInteger(parsedActiveFileId) && parsedActiveFileId > 0
        ? parsedActiveFileId
        : null,
    }
  } catch {
    return DEFAULT_TABS_STATE
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

function isDraftDirty(file: SqlFile | undefined, draft: SqlDraft | undefined): boolean {
  if (!file || !draft) return false
  return file.name !== draft.name ||
    (file.display_name ?? '') !== draft.display_name ||
    file.file_type !== draft.file_type ||
    file.content !== draft.content
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
  const initialLayoutRef = useRef<SqlWorkspaceLayout>(loadSqlWorkspaceLayout())
  const initialTabsRef = useRef<SqlWorkspaceTabsState>(loadSqlWorkspaceTabsState())
  const rootRef = useRef<HTMLDivElement | null>(null)
  const theme = useTheme()
  const qc = useQueryClient()
  const sqlMinimap = useThemeStore(s => s.sqlMinimap)
  const [search, setSearch] = useState('')
  const [openFileIds, setOpenFileIds] = useState<number[]>(initialTabsRef.current.openFileIds)
  const [activeFileId, setActiveFileId] = useState<number | null>(initialTabsRef.current.activeFileId)
  const [drafts, setDrafts] = useState<Record<number, SqlDraft>>({})
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [createOpen, setCreateOpen] = useState(false)
  const [createParentPath, setCreateParentPath] = useState('')
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
  const [contextMenu, setContextMenu] = useState<{ mouseX: number; mouseY: number; fileId: number } | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameFileId, setRenameFileId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [metadataDisplayName, setMetadataDisplayName] = useState('')
  const [metadataFilename, setMetadataFilename] = useState('')
  const [metadataFileType, setMetadataFileType] = useState('extract')
  const [metadataSourceType, setMetadataSourceType] = useState<SqlSourceType>('datawarehouse')
  const [metadataConnectionId, setMetadataConnectionId] = useState<number | ''>('')
  const [metadataNotes, setMetadataNotes] = useState('')

  const { data: files = [], isLoading } = useQuery({
    queryKey: ['sql-files'],
    queryFn: () => sqlFilesApi.list(),
  })

  const { data: labelsResp } = useQuery({
    queryKey: ['sql-version-labels'],
    queryFn: () => sqlFilesApi.getVersionLabels(),
  })
  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.list(),
  })
  const versionLabels = labelsResp?.labels?.length
    ? labelsResp.labels
    : ['INITIAL', 'DRAFT', 'FINAL', 'DEPRECATED']

  const createMut = useMutation({
    mutationFn: (data: Partial<SqlFile>) => sqlFilesApi.create(data),
    onSuccess: (file) => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      openFile(file)
      setCreateOpen(false)
      setCreateParentPath('')
      setNewName('new-query')
      setNewType('extract')
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<SqlFile> }) =>
      sqlFilesApi.update(id, data),
    onSuccess: (file, vars) => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      setDrafts(prev => ({
        ...prev,
        [file.id]: {
          name: vars.data.name ?? prev[file.id]?.name ?? file.name,
          display_name: vars.data.display_name ?? prev[file.id]?.display_name ?? (file.display_name ?? ''),
          file_type: vars.data.file_type ?? prev[file.id]?.file_type ?? file.file_type,
          content: vars.data.content ?? prev[file.id]?.content ?? file.content,
        },
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
        [file.id]: { name: file.name, display_name: file.display_name ?? '', file_type: file.file_type, content: file.content },
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
        [file.id]: { name: file.name, display_name: file.display_name ?? '', file_type: file.file_type, content: file.content },
      }
    })
    setSelectedVersionId(null)
  }

  function closeFile(fileId: number) {
    const file = fileById.get(fileId)
    const draft = drafts[fileId]
    if (isDraftDirty(file, draft)) {
      const label = draft?.display_name?.trim() || file?.display_name?.trim() || (draft?.name ?? file?.name ?? `File ${fileId}`).split('/').pop()
      const confirmed = window.confirm(`You have unsaved changes in "${label}". Close anyway?`)
      if (!confirmed) return
    }

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
  const activeMetadata = useMemo(() => parseSqlFileMetadata(activeFile?.description), [activeFile?.description])
  const sourceConnections = useMemo(
    () => connections.filter((c: Connection) => c.conn_type === metadataSourceType),
    [connections, metadataSourceType],
  )
  const activeSourceConnection = useMemo(
    () => connections.find((c: Connection) => c.id === activeMetadata.source_connection_id),
    [connections, activeMetadata.source_connection_id],
  )
  const dirtyById = useMemo(() => {
    const map = new Map<number, boolean>()
    for (const id of openFileIds) {
      map.set(id, isDraftDirty(fileById.get(id), drafts[id]))
    }
    return map
  }, [openFileIds, fileById, drafts])
  const activeDirty = activeFileId != null ? Boolean(dirtyById.get(activeFileId)) : false

  function handleSave() {
    if (!activeFile || !activeDraft) return
    updateMut.mutate({
      id: activeFile.id,
      data: { name: activeDraft.name, display_name: activeDraft.display_name || undefined, file_type: activeDraft.file_type, content: activeDraft.content },
    })
  }

  function openContextMenu(e: React.MouseEvent, file: SqlFile) {
    e.preventDefault()
    setContextMenu({ mouseX: e.clientX + 2, mouseY: e.clientY - 6, fileId: file.id })
  }

  function openRenameDialog(file: SqlFile) {
    setRenameFileId(file.id)
    setRenameValue(file.name)
    setRenameOpen(true)
  }

  function submitRename() {
    if (renameFileId == null) return
    const nextName = renameValue.trim()
    if (!nextName) return
    updateMut.mutate({ id: renameFileId, data: { name: nextName } })
    setRenameOpen(false)
    setRenameFileId(null)
  }

  function openMetadataDialog() {
    if (!activeFile || !activeDraft) return
    const meta = parseSqlFileMetadata(activeFile.description)
    setMetadataDisplayName(activeDraft.display_name)
    setMetadataFilename(activeDraft.name)
    setMetadataFileType(activeDraft.file_type)
    setMetadataSourceType(meta.source_type ?? 'datawarehouse')
    setMetadataConnectionId(meta.source_connection_id ?? '')
    setMetadataNotes(meta.notes ?? '')
    setMetadataOpen(true)
  }

  function submitMetadata() {
    if (!activeFile) return
    const description = buildSqlFileMetadataDescription({
      source_type: metadataSourceType,
      source_connection_id: metadataConnectionId === '' ? undefined : Number(metadataConnectionId),
      notes: metadataNotes,
    })
    const nextName = metadataFilename.trim() || activeFile.name
    const nextDisplayName = metadataDisplayName.trim()
    updateActiveDraft({ file_type: metadataFileType, name: nextName, display_name: nextDisplayName })
    updateMut.mutate({ id: activeFile.id, data: { name: nextName, display_name: nextDisplayName || undefined, description, file_type: metadataFileType } })
    setMetadataOpen(false)
  }

  function openCreateDialog(parentPath: string) {
    setCreateParentPath(parentPath)
    setCreateOpen(true)
    setNewName('new-query')
    setNewType('extract')
    setExpandedFolders(prev => new Set(prev).add(''))
  }

  function submitCreate() {
    const baseName = newName.trim().replace(/\.sql$/i, '')
    if (!baseName) return
    const fileName = `${baseName}.sql`
    const fullName = createParentPath ? `${createParentPath}/${fileName}` : fileName
    createMut.mutate({ name: fullName, file_type: newType, content: `-- ${fullName}\n\nSELECT\n  *\nFROM\n  your_table;\n` })
  }

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
      const next = Math.max(170, Math.min(560, e.clientX - rect.left))
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

  const beforeEditorMount: BeforeMount = (monaco) => {
    monaco.editor.defineTheme('sql-workspace-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0d1117',
        'editorGutter.background': '#0d1117',
        'editorLineNumber.foreground': '#6e7681',
        'editorLineNumber.activeForeground': '#c9d1d9',
      },
    })
    monaco.editor.defineTheme('sql-workspace-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#ffffff',
        'editorGutter.background': '#ffffff',
      },
    })
  }

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
    localStorage.setItem(
      SQL_WORKSPACE_TABS_KEY,
      JSON.stringify({ openFileIds, activeFileId }),
    )
  }, [openFileIds, activeFileId])

  useEffect(() => {
    const onToggleLeft = () => setLeftCollapsed(v => !v)
    const onToggleRight = () => setRightCollapsed(v => !v)
    window.addEventListener('workspace-panel-toggle-left', onToggleLeft)
    window.addEventListener('workspace-panel-toggle-right', onToggleRight)
    return () => {
      window.removeEventListener('workspace-panel-toggle-left', onToggleLeft)
      window.removeEventListener('workspace-panel-toggle-right', onToggleRight)
    }
  }, [])

  useEffect(() => {
    if (activeFileId == null || !activeFile) return
    setDrafts(prev => {
      if (prev[activeFileId]) return prev
      return {
        ...prev,
        [activeFileId]: { name: activeFile.name, display_name: activeFile.display_name ?? '', file_type: activeFile.file_type, content: activeFile.content },
      }
    })
  }, [activeFileId, activeFile])

  useEffect(() => {
    if (files.length === 0) return
    const validIds = new Set(files.map(f => f.id))
    setOpenFileIds(prev => {
      const next = prev.filter(id => validIds.has(id))
      const unchanged = next.length === prev.length && next.every((id, idx) => id === prev[idx])
      if (!unchanged) {
        setDrafts(dPrev => {
          const dNext = { ...dPrev }
          prev.filter(id => !validIds.has(id)).forEach(id => { delete dNext[id] })
          return dNext
        })
        return next
      }
      return prev
    })
    setActiveFileId(prev => {
      if (prev != null && validIds.has(prev)) return prev
      const nextOpen = openFileIds.filter(id => validIds.has(id))
      const nextActive = nextOpen[0] ?? null
      return prev === nextActive ? prev : nextActive
    })
  }, [files, openFileIds])

  const renderFolder = (folder: FolderNode, depth = 0): React.ReactNode => {
    const expanded = expandedFolders.has(folder.path)
    return (
      <Box key={folder.id}>
        {folder.path !== '' && (
          <ListItem disablePadding sx={{ pl: `${depth * 14}px` }}>
            <ListItemButton sx={workspaceSidebarItemButtonSx} onClick={() => toggleFolder(folder.path)}>
              <Box sx={{ width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', mr: 0.5 }}>
                {expanded ? <ExpandMore sx={{ fontSize: 14 }} /> : <ChevronRight sx={{ fontSize: 14 }} />}
              </Box>
              <Folder sx={{ fontSize: 16, mr: 0.75, color: 'warning.main' }} />
              <Typography variant="body2" noWrap sx={{ ...workspaceSidebarItemTextSx, flex: 1 }}>{folder.name}</Typography>
              <Tooltip title="New file in folder">
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation()
                    openCreateDialog(folder.path)
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
            {folder.folders.map(child => renderFolder(child, depth + 1))}
            {folder.files.map(file => {
              const selectedFile = activeFileId === file.id
              return (
                <ListItem key={file.id} disablePadding sx={{ pl: `${(depth + 1) * 14}px` }}>
                  <ListItemButton
                    selected={selectedFile}
                    onClick={() => openFile(file)}
                    onContextMenu={(e) => openContextMenu(e, file)}
                    sx={workspaceSidebarItemButtonSx}
                  >
                    <Code sx={{ fontSize: 14, mr: 1, color: 'text.secondary' }} />
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography variant="body2" noWrap sx={workspaceSidebarItemTextSx}>
                        {file.display_name || file.name.split('/').pop()}
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
    <Box ref={rootRef} sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* Left panel: folder tree */}
      {!leftCollapsed && (
      <Box
        sx={[
          workspaceSidebarSurfaceSx,
          {
            width: leftSidebarWidth, flexShrink: 0,
            minWidth: 0,
            borderRight: `1px solid ${theme.palette.divider}`,
            display: 'flex', flexDirection: 'column',
          },
        ]}
      >
        <Box sx={{ p: 1.5, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, letterSpacing: '0.01em' }}>SQL Workspace</Typography>
            <Box sx={{ flex: 1 }} />
            <Tooltip title="New file at root">
              <IconButton
                size="small"
                onClick={() => openCreateDialog('')}
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
            sx={{ minWidth: 0 }}
            slotProps={{
              input: {
                startAdornment: <InputAdornment position="start"><Search sx={{ fontSize: 16 }} /></InputAdornment>,
              },
              htmlInput: { style: { fontSize: '0.78rem', paddingTop: 4, paddingBottom: 4 } },
            }}
          />
        </Box>

        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={24} /></Box>
          ) : (
            <List dense disablePadding sx={{ px: 0.5, py: 0.5 }}>
              {grouped.map(group => (
                <Box key={group.type} sx={{ mb: 0.5 }}>
                  <Box>
                    <Typography variant="caption" sx={workspaceSidebarSectionLabelSx}>
                      {group.type}
                    </Typography>
                  </Box>
                  {group.tree.folders.map(folder => renderFolder(folder, 0))}
                  {group.tree.files.map(file => (
                    <ListItem key={file.id} disablePadding>
                      <ListItemButton
                        selected={activeFileId === file.id}
                        onClick={() => openFile(file)}
                        onContextMenu={(e) => openContextMenu(e, file)}
                        sx={workspaceSidebarItemButtonSx}
                      >
                        <Code sx={{ fontSize: 14, mr: 1, color: 'text.secondary' }} />
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                          <Typography variant="body2" noWrap sx={workspaceSidebarItemTextSx}>{file.display_name || file.name}</Typography>
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
          onDoubleClick={() => setLeftSidebarWidth(DEFAULT_LAYOUT.leftSidebarWidth)}
          sx={{
            width: 10,
            cursor: 'col-resize',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: leftResizing ? alpha(theme.palette.primary.main, 0.22) : 'transparent',
            transition: 'background-color 120ms ease',
            '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.14) },
            '&::after': {
              content: '""',
              width: 2,
              height: 34,
              borderRadius: 99,
              bgcolor: leftResizing ? 'primary.main' : alpha(theme.palette.text.secondary, 0.35),
            },
          }}
          title="Drag to resize sidebar"
        />
      )}

      {/* Right panel: editor + version controller */}
      {activeFile && activeDraft ? (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
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
              const label = draft?.display_name?.trim() || file?.display_name?.trim() || (draft?.name ?? file?.name ?? `File ${id}`).split('/').pop()
              const isActive = id === activeFileId
              const isDirty = Boolean(dirtyById.get(id))
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
                    <Typography
                      variant="caption"
                      noWrap
                      sx={{
                        maxWidth: 180,
                        color: isDirty ? 'warning.main' : 'text.primary',
                        fontWeight: isDirty ? 700 : 400,
                      }}
                    >
                      {label}{isDirty ? ' *' : ''}
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
            <Typography variant="subtitle2" sx={{ fontWeight: 700, fontFamily: 'monospace' }}>
              {activeDraft.name}
            </Typography>
            {activeMetadata.source_type && (
              <Chip
                size="small"
                label={`Source: ${activeMetadata.source_type.toUpperCase()}${activeSourceConnection ? ` (${activeSourceConnection.name})` : ''}`}
                sx={{ height: 20, fontSize: '0.62rem' }}
              />
            )}
            <Tooltip title="Edit Data Source">
              <IconButton size="small" onClick={openMetadataDialog}>
                <Edit sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
            <Box sx={{ flex: 1 }} />
            {saveMsg && <Typography variant="caption" color="success.main">{saveMsg}</Typography>}
            {!saveMsg && activeDirty && (
              <Chip
                label="unsaved"
                size="small"
                sx={{
                  height: 20,
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  textTransform: 'lowercase',
                  bgcolor: alpha('#f59e0b', 0.18),
                  color: '#d97706',
                  border: `1px solid ${alpha('#f59e0b', 0.45)}`,
                  '& .MuiChip-label': { px: 1 },
                }}
              />
            )}
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
              disabled={updateMut.isPending || !activeDirty}
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
            <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                <Editor
                  height="100%"
                  language="sql"
                  value={activeDraft.content}
                  onChange={(v) => updateActiveDraft({ content: v ?? '' })}
                  beforeMount={beforeEditorMount}
                  onMount={onEditorMount}
                  theme={theme.palette.mode === 'dark' ? 'sql-workspace-dark' : 'sql-workspace-light'}
                  options={{
                    minimap: { enabled: sqlMinimap, scale: 1, maxColumn: 160 },
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
              </Box>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 1.5,
                  py: 0.5,
                  borderTop: `1px solid ${theme.palette.divider}`,
                  bgcolor: 'background.paper',
                  flexShrink: 0,
                  position: 'sticky',
                  bottom: 0,
                  zIndex: 2,
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

      <Menu
        open={Boolean(contextMenu)}
        onClose={() => setContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined}
      >
        <MenuItem
          onClick={() => {
            if (!contextMenu) return
            const file = fileById.get(contextMenu.fileId)
            if (file) openRenameDialog(file)
            setContextMenu(null)
          }}
        >
          Edit name
        </MenuItem>
      </Menu>

      <Dialog open={renameOpen} onClose={() => setRenameOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Edit SQL file name</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="File name"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="folder/my-query.sql"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={submitRename} disabled={updateMut.isPending || !renameValue.trim()}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Create SQL file</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 2 }}>
          <TextField
            label="Folder"
            value={createParentPath || 'root'}
            size="small"
            fullWidth
            slotProps={{ input: { readOnly: true } }}
          />
          <TextField
            autoFocus
            label="Filename"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            size="small"
            fullWidth
            placeholder="new-query"
            slotProps={{
              input: {
                endAdornment: <InputAdornment position="end">.sql</InputAdornment>,
              },
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitCreate()
              }
            }}
          />
          <TextField
            select
            label="Type"
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            size="small"
            fullWidth
          >
            {FILE_TYPES.map(t => <MenuItem key={t} value={t}>{t}</MenuItem>)}
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={submitCreate} disabled={createMut.isPending || !newName.trim()}>
            Create File
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={metadataOpen} onClose={() => setMetadataOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Data Source</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 3 }}>
          <TextField
            label="Name"
            value={metadataDisplayName}
            onChange={(e) => setMetadataDisplayName(e.target.value)}
            size="small"
            fullWidth
            placeholder="Human-readable label shown in sidebar"
          />
          <TextField
            label="Filename"
            value={metadataFilename}
            onChange={(e) => setMetadataFilename(e.target.value)}
            size="small"
            fullWidth
            placeholder="e.g. folder/my-query.sql"
          />
          <TextField
            select
            label="Type"
            value={metadataFileType}
            onChange={(e) => setMetadataFileType(e.target.value)}
            size="small"
            fullWidth
          >
            {FILE_TYPES.map(t => <MenuItem key={t} value={t}>{t}</MenuItem>)}
          </TextField>
          <TextField
            select
            label="Source type"
            value={metadataSourceType}
            onChange={(e) => {
              const next = e.target.value as SqlSourceType
              setMetadataSourceType(next)
              setMetadataConnectionId('')
            }}
            size="small"
            fullWidth
          >
            <MenuItem value="datawarehouse">Datawarehouse</MenuItem>
            <MenuItem value="jdbc">JDBC</MenuItem>
          </TextField>
          <TextField
            select
            label="Linked connection"
            value={metadataConnectionId}
            onChange={(e) => {
              const v = e.target.value
              setMetadataConnectionId(v === '' ? '' : Number(v))
            }}
            size="small"
            fullWidth
          >
            <MenuItem value="">None</MenuItem>
            {sourceConnections.map(conn => (
              <MenuItem key={conn.id} value={conn.id}>{conn.name}</MenuItem>
            ))}
          </TextField>
          <TextField
            label="Notes"
            value={metadataNotes}
            onChange={(e) => setMetadataNotes(e.target.value)}
            size="small"
            fullWidth
            multiline
            minRows={3}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMetadataOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={submitMetadata} disabled={updateMut.isPending}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
