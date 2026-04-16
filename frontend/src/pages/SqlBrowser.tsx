import { useState, useCallback } from 'react'
import {
  Box, Typography, Stack, Tabs, Tab, List, ListItemButton, ListItemText,
  Chip, IconButton, Button, Tooltip, Divider, TextField, Select,
  MenuItem, Dialog, DialogTitle, DialogContent, DialogActions,
  FormControl, InputLabel, Paper, alpha, useTheme, CircularProgress,
} from '@mui/material'
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  Save as SaveIcon,
  Close as CloseIcon,
  History as HistoryIcon,
  BookmarkAdd as SnapshotIcon,
  Code as SqlIcon,
  Storage as ExtractIcon,
  Transform as TransformIcon,
  Check as CheckIcon,
  AutoFixHigh as FormatIcon,
} from '@mui/icons-material'
import { format as sqlFormat } from 'sql-formatter'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import { formatDistanceToNow } from 'date-fns'
import { parseApiDate } from '../utils/dates'
import {
  sqlFilesApi, SqlFile, SqlFileType, SqlFileVersion, SQL_VERSION_TAGS,
} from '../api/client'

// ─────────────────────────────────────────────────────────────────────────────
// SQL formatter — lightweight keyword-based formatter
// ─────────────────────────────────────────────────────────────────────────────

const CLAUSE_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
  'FULL OUTER JOIN', 'CROSS JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING',
  'LIMIT', 'OFFSET', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE',
  'WITH', 'AS',
]

const INLINE_KEYWORDS = [
  'AND', 'OR', 'NOT', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL',
  'BETWEEN', 'LIKE', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'DISTINCT', 'ASC', 'DESC',
  'CAST', 'COALESCE', 'NULLIF', 'OVER', 'PARTITION BY',
]

function formatSql(raw: string): string {
  if (!raw?.trim()) return raw

  // Step 1: normalise whitespace
  let sql = raw.replace(/\r\n/g, '\n').trim()

  // Step 2: uppercase all SQL keywords in the text
  const allKw = [...CLAUSE_KEYWORDS, ...INLINE_KEYWORDS]
    .sort((a, b) => b.length - a.length) // longest first to avoid partial matches
  for (const kw of allKw) {
    const re = new RegExp(`\\b${kw.replace(/ /g, '\\s+')}\\b`, 'gi')
    sql = sql.replace(re, kw)
  }

  // Step 3: split into lines at clause boundaries
  const clauseRe = new RegExp(
    `\\b(${[
      'SELECT', 'FROM', 'WHERE', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
      'FULL OUTER JOIN', 'CROSS JOIN', 'JOIN', 'ON', 'GROUP BY', 'ORDER BY',
      'HAVING', 'LIMIT', 'OFFSET', 'UNION ALL', 'UNION', 'WITH',
    ].join('|')})\\b`,
    'g',
  )
  sql = sql.replace(clauseRe, '\n$1')

  // Step 4: split SELECT list items onto their own indented lines
  const lines = sql.split('\n').map((l) => l.trim()).filter(Boolean)
  const formatted: string[] = []
  for (const line of lines) {
    if (line.startsWith('SELECT')) {
      const after = line.slice(6).trim()
      if (after) {
        formatted.push('SELECT')
        // Split on commas not inside parentheses
        const cols = splitTopLevelCommas(after)
        cols.forEach((col, i) => {
          formatted.push(`    ${col.trim()}${i < cols.length - 1 ? ',' : ''}`)
        })
      } else {
        formatted.push('SELECT')
      }
    } else if (line.startsWith('FROM') || line.startsWith('WHERE') ||
               line.endsWith('JOIN') || line.startsWith('ON ') ||
               line.startsWith('GROUP BY') || line.startsWith('ORDER BY') ||
               line.startsWith('HAVING') || line.startsWith('LIMIT') ||
               line.startsWith('OFFSET') || line.startsWith('UNION') ||
               line.startsWith('WITH')) {
      formatted.push(line)
    } else {
      formatted.push('    ' + line)
    }
  }

  return formatted.join('\n')
}

function splitTopLevelCommas(str: string): string[] {
  const parts: string[] = []
  let depth = 0
  let buf = ''
  for (const ch of str) {
    if (ch === '(') { depth++; buf += ch }
    else if (ch === ')') { depth--; buf += ch }
    else if (ch === ',' && depth === 0) { parts.push(buf); buf = '' }
    else { buf += ch }
  }
  if (buf.trim()) parts.push(buf)
  return parts
}

// ─────────────────────────────────────────────────────────────────────────────
// Tag chip colours
// ─────────────────────────────────────────────────────────────────────────────

function tagColor(tag: string): 'default' | 'warning' | 'success' | 'error' | 'info' {
  switch (tag?.toUpperCase()) {
    case 'FINAL':       return 'success'
    case 'REVIEW':      return 'info'
    case 'DEPRECATED':  return 'error'
    case 'DRAFT':
    default:            return 'warning'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Create / Edit file dialog
// ─────────────────────────────────────────────────────────────────────────────

interface FileDialogProps {
  open: boolean
  initial?: SqlFile | null
  defaultType: SqlFileType
  onClose: () => void
  onSaved: (f: SqlFile) => void
}

function FileDialog({ open, initial, defaultType, onClose, onSaved }: FileDialogProps) {
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [fileType, setFileType] = useState<SqlFileType>(initial?.file_type ?? defaultType)
  const [content, setContent] = useState(initial?.content ?? '')

  // Reset when dialog opens with new data
  const reset = useCallback(() => {
    setName(initial?.name ?? '')
    setDescription(initial?.description ?? '')
    setFileType(initial?.file_type ?? defaultType)
    setContent(initial?.content ?? '')
  }, [initial, defaultType])

  const createMut = useMutation({
    mutationFn: () => sqlFilesApi.create({ name, description, file_type: fileType, content }).then(r => r.data),
    onSuccess: (f) => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      enqueueSnackbar(`Created "${f.name}"`, { variant: 'success' })
      onSaved(f)
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const updateMut = useMutation({
    mutationFn: () => sqlFilesApi.update(initial!.id, { name, description, file_type: fileType, content }).then(r => r.data),
    onSuccess: (f) => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      enqueueSnackbar(`Saved "${f.name}"`, { variant: 'success' })
      onSaved(f)
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const busy = createMut.isPending || updateMut.isPending
  const valid = name.trim().length > 0 && content.trim().length > 0

  const handleFormat = () => {
    const formatted = formatSql(content)
    setContent(formatted)
  }

  return (
    <Dialog
      open={open}
      onClose={() => { reset(); onClose() }}
      fullWidth
      maxWidth="md"
      PaperProps={{ sx: { height: '80vh', display: 'flex', flexDirection: 'column' } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <span>{initial ? `Edit — ${initial.name}` : 'New SQL File'}</span>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Format / prettify SQL">
          <span>
            <Button
              size="small"
              startIcon={<FormatIcon />}
              onClick={handleFormat}
              disabled={!content.trim()}
              sx={{ mr: 1 }}
            >
              Format
            </Button>
          </span>
        </Tooltip>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2, flex: 1, overflow: 'hidden' }}>
        <Stack direction="row" spacing={2}>
          <TextField
            label="Name"
            value={name}
            onChange={e => setName(e.target.value)}
            fullWidth
            size="small"
            required
          />
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>Type</InputLabel>
            <Select
              label="Type"
              value={fileType}
              onChange={e => setFileType(e.target.value as SqlFileType)}
            >
              <MenuItem value="extract">Extract</MenuItem>
              <MenuItem value="transform">Transform</MenuItem>
            </Select>
          </FormControl>
        </Stack>
        <TextField
          label="Description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          size="small"
          fullWidth
        />
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {fileType === 'extract' && (
            <Typography
              variant="caption"
              sx={{ mb: 0.5, color: 'text.secondary', fontStyle: 'italic' }}
            >
              Extract SQL runs against an external data warehouse — use fully qualified
              table names and avoid references to local catalog objects.
            </Typography>
          )}
          <TextField
            label="SQL"
            value={content}
            onChange={e => setContent(e.target.value)}
            multiline
            fullWidth
            required
            sx={{
              flex: 1,
              '& .MuiInputBase-root': {
                fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
                fontSize: 13,
                height: '100%',
                alignItems: 'flex-start',
              },
              '& .MuiInputBase-input': { height: '100% !important', overflow: 'auto !important' },
            }}
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { reset(); onClose() }} startIcon={<CloseIcon />}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!valid || busy}
          startIcon={busy ? <CircularProgress size={16} /> : <SaveIcon />}
          onClick={() => initial ? updateMut.mutate() : createMut.mutate()}
        >
          {initial ? 'Save' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot (create version) dialog
// ─────────────────────────────────────────────────────────────────────────────

interface SnapshotDialogProps {
  open: boolean
  file: SqlFile | null
  onClose: () => void
}

function SnapshotDialog({ open, file, onClose }: SnapshotDialogProps) {
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()
  const [tag, setTag] = useState('DRAFT')

  const mut = useMutation({
    mutationFn: () => sqlFilesApi.createVersion(file!.id, tag).then(r => r.data),
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      enqueueSnackbar(`Snapshot ${v.version} (${v.tag}) created`, { variant: 'success' })
      onClose()
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Create Version Snapshot</DialogTitle>
      <DialogContent sx={{ pt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Snapshots the current content of <strong>{file?.name}</strong>.
          The version number is auto-incremented.
        </Typography>
        <FormControl size="small" fullWidth>
          <InputLabel>Tag</InputLabel>
          <Select label="Tag" value={tag} onChange={e => setTag(e.target.value)}>
            {SQL_VERSION_TAGS.map(t => (
              <MenuItem key={t} value={t}>{t}</MenuItem>
            ))}
          </Select>
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} startIcon={<CloseIcon />}>Cancel</Button>
        <Button
          variant="contained"
          disabled={mut.isPending}
          startIcon={mut.isPending ? <CircularProgress size={16} /> : <SnapshotIcon />}
          onClick={() => mut.mutate()}
        >
          Snapshot
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Version history panel
// ─────────────────────────────────────────────────────────────────────────────

interface VersionPanelProps {
  file: SqlFile
  previewVersion: SqlFileVersion | null
  onPreview: (v: SqlFileVersion | null) => void
}

function VersionPanel({ file, previewVersion, onPreview }: VersionPanelProps) {
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()

  const tagMut = useMutation({
    mutationFn: ({ vid, tag }: { vid: number; tag: string }) =>
      sqlFilesApi.updateVersionTag(file.id, vid, tag).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      enqueueSnackbar('Tag updated', { variant: 'success' })
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  const versions = [...(file.versions ?? [])].reverse() // newest first

  if (versions.length === 0) {
    return (
      <Box sx={{ p: 2, color: 'text.secondary' }}>
        <Typography variant="caption">No versions yet. Use "Snapshot" to save one.</Typography>
      </Box>
    )
  }

  return (
    <List dense disablePadding>
      {versions.map((v) => {
        const active = previewVersion?.id === v.id
        return (
          <Box key={v.id}>
            <ListItemButton
              selected={active}
              onClick={() => onPreview(active ? null : v)}
              sx={{ py: 0.75, px: 1.5 }}
            >
              <ListItemText
                primary={
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="body2" fontWeight={600} sx={{ fontFamily: 'monospace' }}>
                      {v.version}
                    </Typography>
                    <Chip
                      label={v.tag}
                      size="small"
                      color={tagColor(v.tag)}
                      sx={{ height: 18, fontSize: 10 }}
                    />
                    {active && <CheckIcon sx={{ fontSize: 14, color: 'primary.main' }} />}
                  </Stack>
                }
                secondary={formatDistanceToNow(parseApiDate(v.created_at), { addSuffix: true })}
                secondaryTypographyProps={{ variant: 'caption' }}
              />
            </ListItemButton>
            {/* Inline tag editor */}
            <Box sx={{ px: 1.5, pb: 0.5 }}>
              <Select
                size="small"
                value={v.tag}
                onChange={e => tagMut.mutate({ vid: v.id, tag: e.target.value })}
                sx={{ fontSize: 11, height: 24, minWidth: 110 }}
              >
                {SQL_VERSION_TAGS.map(t => (
                  <MenuItem key={t} value={t} sx={{ fontSize: 12 }}>{t}</MenuItem>
                ))}
              </Select>
            </Box>
            <Divider />
          </Box>
        )
      })}
    </List>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL viewer — always shows sql-formatter output, read-only with highlighting
// ─────────────────────────────────────────────────────────────────────────────

// Keywords that get primary colour in the viewer
const KW_RE = /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|FULL|OUTER|CROSS|ON|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|UNION ALL|UNION|INTERSECT|EXCEPT|WITH|AND|OR|NOT|IN|IS|NULL|BETWEEN|LIKE|ILIKE|EXISTS|CASE|WHEN|THEN|ELSE|END|COUNT|SUM|AVG|MAX|MIN|DISTINCT|ASC|DESC|CAST|AS|SET|UPDATE|DELETE|INSERT|VALUES|CREATE|TABLE|COALESCE|NULLIF|OVER|PARTITION BY|ROWS|RANGE|UNBOUNDED|PRECEDING|FOLLOWING|CURRENT ROW)\b/g

function highlightLine(
  line: string,
  primaryColor: string,
  commentColor: string,
  stringColor: string,
): React.ReactNode {
  if (line.trimStart().startsWith('--')) {
    return <span style={{ color: commentColor, fontStyle: 'italic' }}>{line}</span>
  }

  // Highlight string literals first
  const STRING_RE = /('(?:[^'\\]|\\.)*')/g
  const segments: Array<{ text: string; isString: boolean }> = []
  let last = 0
  let sm: RegExpExecArray | null
  STRING_RE.lastIndex = 0
  while ((sm = STRING_RE.exec(line)) !== null) {
    if (sm.index > last) segments.push({ text: line.slice(last, sm.index), isString: false })
    segments.push({ text: sm[1], isString: true })
    last = sm.index + sm[1].length
  }
  if (last < line.length) segments.push({ text: line.slice(last), isString: false })

  return (
    <>
      {segments.map((seg, si) => {
        if (seg.isString) {
          return <span key={si} style={{ color: stringColor }}>{seg.text}</span>
        }
        // Keyword highlight within non-string segments
        const kwParts: React.ReactNode[] = []
        let kl = 0
        let km: RegExpExecArray | null
        KW_RE.lastIndex = 0
        while ((km = KW_RE.exec(seg.text)) !== null) {
          if (km.index > kl) kwParts.push(seg.text.slice(kl, km.index))
          kwParts.push(
            <span key={km.index} style={{ color: primaryColor, fontWeight: 700 }}>
              {km[0]}
            </span>,
          )
          kl = km.index + km[0].length
        }
        if (kl < seg.text.length) kwParts.push(seg.text.slice(kl))
        return <span key={si}>{kwParts}</span>
      })}
    </>
  )
}

function SqlViewer({ sql }: { sql: string }) {
  const theme = useTheme()
  const formatted = formatSql(sql)
  const lines = formatted.split('\n')
  const primaryColor = theme.palette.mode === 'dark'
    ? theme.palette.primary.light
    : theme.palette.primary.dark
  const commentColor = theme.palette.text.disabled
  const stringColor = theme.palette.mode === 'dark' ? '#98c379' : '#50a14f' // green

  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 2,
        flex: 1,
        overflow: 'auto',
        fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
        fontSize: 13,
        lineHeight: 1.75,
        background: 'transparent',
        whiteSpace: 'pre',
      }}
    >
      {lines.map((line, idx) => (
        <div key={idx}>
          {highlightLine(line, primaryColor, commentColor, stringColor)}
        </div>
      ))}
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function SqlBrowser() {
  const theme = useTheme()
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()

  const [tabIdx, setTabIdx] = useState(0)
  const activeType: SqlFileType = tabIdx === 0 ? 'extract' : 'transform'

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [previewVersion, setPreviewVersion] = useState<SqlFileVersion | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<SqlFile | null>(null)
  const [snapshotOpen, setSnapshotOpen] = useState(false)

  // Fetch all files (both types)
  const { data: allFiles = [], isLoading } = useQuery({
    queryKey: ['sql-files'],
    queryFn: () => sqlFilesApi.list().then(r => r.data),
  })

  const files = allFiles.filter(f => f.file_type === activeType)
  const selected = allFiles.find(f => f.id === selectedId) ?? null

  // When switching tabs, reset selection
  const handleTabChange = (_: unknown, v: number) => {
    setTabIdx(v)
    setSelectedId(null)
    setPreviewVersion(null)
  }

  const handleSelect = (id: number) => {
    setSelectedId(id)
    setPreviewVersion(null)
  }

  const deleteMut = useMutation({
    mutationFn: (id: number) => sqlFilesApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sql-files'] })
      enqueueSnackbar('Deleted', { variant: 'success' })
      setSelectedId(null)
    },
    onError: (e: Error) => enqueueSnackbar(e.message, { variant: 'error' }),
  })

  // SQL to display: version preview or live content
  const displaySql = previewVersion?.content ?? selected?.content ?? ''
  const viewingVersion = previewVersion != null

  const sidebarBg = alpha(theme.palette.background.paper, 0.6)
  const panelBorder = theme.palette.divider

  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* ── Left: file list ── */}
      <Box
        sx={{
          width: 260,
          flexShrink: 0,
          borderRight: `1px solid ${panelBorder}`,
          display: 'flex',
          flexDirection: 'column',
          background: sidebarBg,
        }}
      >
        {/* Type tabs */}
        <Tabs
          value={tabIdx}
          onChange={handleTabChange}
          variant="fullWidth"
          sx={{ borderBottom: `1px solid ${panelBorder}`, minHeight: 42 }}
          TabIndicatorProps={{ sx: { height: 3 } }}
        >
          <Tab
            label="Extract"
            icon={<ExtractIcon sx={{ fontSize: 16 }} />}
            iconPosition="start"
            sx={{ minHeight: 42, fontSize: 12 }}
          />
          <Tab
            label="Transform"
            icon={<TransformIcon sx={{ fontSize: 16 }} />}
            iconPosition="start"
            sx={{ minHeight: 42, fontSize: 12 }}
          />
        </Tabs>

        {/* New file button */}
        <Box sx={{ px: 1.5, py: 1 }}>
          <Button
            fullWidth
            size="small"
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() => { setEditTarget(null); setDialogOpen(true) }}
          >
            New {activeType === 'extract' ? 'Extract' : 'Transform'} SQL
          </Button>
        </Box>

        {/* File list */}
        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', pt: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          <List dense sx={{ flex: 1, overflow: 'auto', py: 0 }}>
            {files.length === 0 && (
              <Box sx={{ p: 2, color: 'text.secondary' }}>
                <Typography variant="caption">No {activeType} SQL files yet.</Typography>
              </Box>
            )}
            {files.map((f) => {
              const latestVersion = f.versions?.length
                ? f.versions[f.versions.length - 1]
                : null
              return (
                <Box key={f.id}>
                  <ListItemButton
                    selected={f.id === selectedId}
                    onClick={() => handleSelect(f.id)}
                    sx={{ py: 0.75, px: 1.5 }}
                  >
                    <SqlIcon sx={{ fontSize: 16, mr: 1, color: 'text.secondary', flexShrink: 0 }} />
                    <ListItemText
                      primary={f.name}
                      secondary={
                        latestVersion
                          ? `${latestVersion.version} · ${latestVersion.tag}`
                          : 'No versions'
                      }
                      primaryTypographyProps={{ variant: 'body2', noWrap: true, fontWeight: f.id === selectedId ? 600 : 400 }}
                      secondaryTypographyProps={{ variant: 'caption' }}
                    />
                    {latestVersion && (
                      <Chip
                        label={latestVersion.tag}
                        size="small"
                        color={tagColor(latestVersion.tag)}
                        sx={{ height: 16, fontSize: 10, ml: 0.5 }}
                      />
                    )}
                  </ListItemButton>
                  <Divider />
                </Box>
              )
            })}
          </List>
        )}
      </Box>

      {/* ── Centre: SQL viewer ── */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {!selected ? (
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'text.secondary',
            }}
          >
            <Stack alignItems="center" spacing={1}>
              <SqlIcon sx={{ fontSize: 48, opacity: 0.3 }} />
              <Typography variant="body2">Select a SQL file to view</Typography>
            </Stack>
          </Box>
        ) : (
          <>
            {/* Header bar */}
            <Box
              sx={{
                px: 2,
                py: 1,
                borderBottom: `1px solid ${panelBorder}`,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                flexShrink: 0,
              }}
            >
              <SqlIcon sx={{ color: 'text.secondary', fontSize: 18 }} />
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                {selected.name}
              </Typography>
              <Chip
                label={selected.file_type === 'extract' ? 'Extract' : 'Transform'}
                size="small"
                variant="outlined"
                sx={{ height: 20, fontSize: 10 }}
              />
              {viewingVersion && (
                <Chip
                  label={`Viewing ${previewVersion!.version}`}
                  size="small"
                  color="info"
                  sx={{ height: 20, fontSize: 10 }}
                  onDelete={() => setPreviewVersion(null)}
                />
              )}

              <Box sx={{ flex: 1 }} />

              {/* Actions */}
              <Tooltip title="Snapshot current content as a new version">
                <span>
                  <IconButton
                    size="small"
                    onClick={() => setSnapshotOpen(true)}
                    disabled={viewingVersion}
                  >
                    <SnapshotIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Edit">
                <IconButton
                  size="small"
                  onClick={() => { setEditTarget(selected); setDialogOpen(true) }}
                  disabled={viewingVersion}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Delete">
                <IconButton
                  size="small"
                  color="error"
                  onClick={() => deleteMut.mutate(selected.id)}
                  disabled={deleteMut.isPending}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>

            {/* Description */}
            {selected.description && (
              <Box sx={{ px: 2, py: 0.75, borderBottom: `1px solid ${panelBorder}` }}>
                <Typography variant="caption" color="text.secondary">
                  {selected.description}
                </Typography>
              </Box>
            )}

            {/* Version banner */}
            {viewingVersion && (
              <Paper
                elevation={0}
                sx={{
                  mx: 2,
                  mt: 1,
                  px: 2,
                  py: 0.75,
                  background: alpha(theme.palette.info.main, 0.12),
                  border: `1px solid ${alpha(theme.palette.info.main, 0.3)}`,
                  borderRadius: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  flexShrink: 0,
                }}
              >
                <HistoryIcon sx={{ fontSize: 16, color: 'info.main' }} />
                <Typography variant="caption">
                  Viewing snapshot <strong>{previewVersion!.version}</strong>
                  {' '}tagged <strong>{previewVersion!.tag}</strong>
                  {' '}— saved {formatDistanceToNow(parseApiDate(previewVersion!.created_at), { addSuffix: true })}
                </Typography>
                <Box sx={{ flex: 1 }} />
                <Tooltip title="Back to current">
                  <IconButton size="small" onClick={() => setPreviewVersion(null)}>
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
              </Paper>
            )}

            {/* SQL viewer */}
            <Box
              sx={{
                flex: 1,
                overflow: 'auto',
                background: alpha(theme.palette.background.default, 0.5),
                m: 2,
                mt: 1,
                borderRadius: 1,
                border: `1px solid ${panelBorder}`,
              }}
            >
              {/* Line numbers + content */}
              <Box sx={{ display: 'flex', height: '100%' }}>
                {/* Gutter */}
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    px: 1.5,
                    py: 2,
                    fontFamily: 'monospace',
                    fontSize: 13,
                    lineHeight: 1.7,
                    color: 'text.disabled',
                    textAlign: 'right',
                    userSelect: 'none',
                    borderRight: `1px solid ${panelBorder}`,
                    minWidth: 40,
                    background: theme.palette.background.paper,
                    flexShrink: 0,
                  }}
                >
                  {formatSql(displaySql).split('\n').map((_, i) => (
                    <div key={i}>{i + 1}</div>
                  ))}
                </Box>
                <SqlViewer sql={displaySql} />
              </Box>
            </Box>

            {/* Metadata footer */}
            <Box
              sx={{
                px: 2,
                py: 0.5,
                borderTop: `1px solid ${panelBorder}`,
                display: 'flex',
                gap: 2,
                flexShrink: 0,
              }}
            >
              <Typography variant="caption" color="text.secondary">
                Created {formatDistanceToNow(parseApiDate(selected.created_at), { addSuffix: true })}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Updated {formatDistanceToNow(parseApiDate(selected.updated_at), { addSuffix: true })}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {formatSql(displaySql).split('\n').length} lines
              </Typography>
            </Box>
          </>
        )}
      </Box>

      {/* ── Right: version history ── */}
      <Box
        sx={{
          width: 260,
          flexShrink: 0,
          borderLeft: `1px solid ${panelBorder}`,
          display: 'flex',
          flexDirection: 'column',
          background: sidebarBg,
        }}
      >
        <Box
          sx={{
            px: 2,
            py: 1,
            borderBottom: `1px solid ${panelBorder}`,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
          }}
        >
          <HistoryIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          <Typography variant="caption" fontWeight={600}>
            Version History
          </Typography>
          {selected && (
            <Chip
              label={`${selected.versions?.length ?? 0}`}
              size="small"
              sx={{ ml: 'auto', height: 18, fontSize: 10 }}
            />
          )}
        </Box>

        <Box sx={{ flex: 1, overflow: 'auto' }}>
          {!selected ? (
            <Box sx={{ p: 2, color: 'text.secondary' }}>
              <Typography variant="caption">Select a file to see its versions.</Typography>
            </Box>
          ) : (
            <VersionPanel
              file={selected}
              previewVersion={previewVersion}
              onPreview={setPreviewVersion}
            />
          )}
        </Box>
      </Box>

      {/* Dialogs */}
      <FileDialog
        open={dialogOpen}
        initial={editTarget}
        defaultType={activeType}
        onClose={() => setDialogOpen(false)}
        onSaved={(f) => {
          setDialogOpen(false)
          setSelectedId(f.id)
        }}
      />
      <SnapshotDialog
        open={snapshotOpen}
        file={selected}
        onClose={() => setSnapshotOpen(false)}
      />
    </Box>
  )
}
