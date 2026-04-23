import { useEffect, useMemo, useRef, useState } from 'react'
import {
  alpha, Box, Button, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, FormControl, IconButton, InputLabel,
  InputAdornment, List, ListItem, ListItemButton, ListItemText, Menu, MenuItem, Paper, Select,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  TextField, Tooltip, Typography, useTheme,
} from '@mui/material'
import {
  Add, Article, ArrowDownward, ArrowUpward, CheckCircleOutlined, Close,
  Code, DataObject, DeleteOutlined, Download, Edit, ErrorOutlined, History,
  PlayArrow, PlayCircleOutlined, RestartAlt, Save, Search, VisibilityOff,
} from '@mui/icons-material'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import {
  CellOutput, DfPreview, ExportConfig, NotebookCell, NotebookFile, sqlFilesApi,
  transformApi,
} from '../api/client'
import WorkspaceTemplate, {
  workspaceSidebarItemButtonSx,
  workspaceSidebarItemTextSx,
} from '../components/workspace/WorkspaceTemplate'

// ─────────────────────────────────────────────────────────────────────────────
let _cellCounter = 1000
function genId() { return `cell_${_cellCounter++}_${Math.random().toString(36).slice(2, 6)}` }

const DEFAULT_CODE_PREAMBLE = `# Available helpers (auto-injected into every session):
#   spark                – active SparkSession (Spark Connect)
#   F                    – pyspark.sql.functions
#   read_table(name, db) – shortcut for spark.table(...)
#   show(df, n)          – df.show(n, truncate=False)
#   list_tables(db)      – SHOW TABLES
#
# Assign result_df to enable the Export button.
`

const NOTEBOOK_WORKSPACE_TABS_KEY = 'notebook-workspace-open-tabs'
const NOTEBOOK_WORKSPACE_VERSIONS_KEY = 'notebook-workspace-versions'

interface NotebookDraft {
  name: string
  description?: string
  cells: NotebookCell[]
}

interface NotebookWorkspaceTabsState {
  openNotebookIds: number[]
  activeNotebookId: number | null
}

interface NotebookVersionSnapshot {
  id: string
  notebookId: number
  version: string
  tag: string
  name: string
  cells: NotebookCell[]
  createdAt: string
}

function normalizeNotebookCells(cells: any[] | undefined): NotebookCell[] {
  const normalized = (cells ?? []).map((c: any) => ({
    id: c.id ?? genId(),
    type: (c.type ?? 'code') as 'code' | 'markdown',
    content: c.content ?? c.source ?? '',
    language: c.language,
  }))
  return normalized.length > 0 ? normalized : [{ id: genId(), type: 'code', content: DEFAULT_CODE_PREAMBLE }]
}

function cloneCells(cells: NotebookCell[]): NotebookCell[] {
  return cells.map(c => ({ ...c }))
}

function notebookDraftFromFile(nb: NotebookFile): NotebookDraft {
  return {
    name: nb.name,
    description: nb.description,
    cells: normalizeNotebookCells(nb.cells),
  }
}

function notebookCellsEqual(a: NotebookCell[], b: NotebookCell[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].type !== b[i].type ||
      a[i].content !== b[i].content ||
      (a[i].language ?? '') !== (b[i].language ?? '')
    ) {
      return false
    }
  }
  return true
}

function isNotebookDraftDirty(nb: NotebookFile | undefined, draft: NotebookDraft | undefined): boolean {
  if (!nb || !draft) return false
  if (nb.name !== draft.name) return true
  if ((nb.description ?? '') !== (draft.description ?? '')) return true
  return !notebookCellsEqual(normalizeNotebookCells(nb.cells), draft.cells)
}

function changedCellCount(current: NotebookCell[], other: NotebookCell[]): number {
  const max = Math.max(current.length, other.length)
  let changed = 0
  for (let i = 0; i < max; i++) {
    const c = current[i]
    const o = other[i]
    if (!c || !o) {
      changed++
      continue
    }
    if (
      c.type !== o.type ||
      c.content !== o.content ||
      (c.language ?? '') !== (o.language ?? '')
    ) changed++
  }
  return changed
}

function notebookPreview(cells: NotebookCell[]): string {
  const joined = cells
    .map(c => c.content.trim())
    .filter(Boolean)
    .join('\n\n')
  if (!joined) return 'No content'
  return joined.slice(0, 1500)
}

function loadNotebookTabsState(): NotebookWorkspaceTabsState {
  try {
    const raw = localStorage.getItem(NOTEBOOK_WORKSPACE_TABS_KEY)
    if (!raw) return { openNotebookIds: [], activeNotebookId: null }
    const parsed = JSON.parse(raw) as Partial<NotebookWorkspaceTabsState>
    const openNotebookIds = Array.isArray(parsed.openNotebookIds)
      ? parsed.openNotebookIds.map(v => Number(v)).filter(v => Number.isInteger(v) && v > 0)
      : []
    const parsedActiveNotebookId = parsed.activeNotebookId == null ? null : Number(parsed.activeNotebookId)
    return {
      openNotebookIds,
      activeNotebookId: parsedActiveNotebookId != null && Number.isInteger(parsedActiveNotebookId) && parsedActiveNotebookId > 0
        ? parsedActiveNotebookId
        : null,
    }
  } catch {
    return { openNotebookIds: [], activeNotebookId: null }
  }
}

function loadNotebookVersions(): Record<number, NotebookVersionSnapshot[]> {
  try {
    const raw = localStorage.getItem(NOTEBOOK_WORKSPACE_VERSIONS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, NotebookVersionSnapshot[]>
    const next: Record<number, NotebookVersionSnapshot[]> = {}
    for (const [key, value] of Object.entries(parsed)) {
      const id = Number(key)
      if (!Number.isInteger(id) || id <= 0 || !Array.isArray(value)) continue
      next[id] = value.map(v => ({
        ...v,
        notebookId: id,
        cells: cloneCells(v.cells ?? []),
      }))
    }
    return next
  } catch {
    return {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DfTable — renders a DataFrame preview as a table
// ─────────────────────────────────────────────────────────────────────────────
function DfTable({ preview }: { preview: DfPreview }) {
  const theme = useTheme()
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 300, borderColor: theme.palette.divider }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            {preview.columns.map(col => (
              <TableCell key={col} sx={{ fontWeight: 700, fontSize: '0.72rem', py: 0.5, px: 1, bgcolor: 'background.default' }}>{col}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {preview.rows.map((row, ri) => (
            <TableRow key={ri} hover>
              {row.map((val, ci) => (
                <TableCell key={ci} sx={{ fontSize: '0.72rem', py: 0.4, px: 1, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {val ?? <Typography component="span" sx={{ color: 'text.disabled', fontSize: 'inherit' }}>null</Typography>}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CellOutputView
// ─────────────────────────────────────────────────────────────────────────────
function CellOutputView({ out }: { out: CellOutput }) {
  const theme = useTheme()
  const hasText = out.stdout.trim().length > 0
  const hasError = !!out.error
  const hasDf = !!out.df_preview
  if (!hasText && !hasError && !hasDf) return null

  return (
    <Box sx={{ borderTop: `1px solid ${theme.palette.divider}`, p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {hasText && (
        <Typography component="pre" sx={{ fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace', fontSize: '0.78rem', color: 'text.secondary', m: 0, whiteSpace: 'pre-wrap', letterSpacing: '0.01em', lineHeight: 1.65 }}>
          {out.stdout}
        </Typography>
      )}
      {hasError && (
        <Box sx={{ bgcolor: alpha('#f44336', 0.06), borderRadius: 1, p: 1, border: `1px solid ${alpha('#f44336', 0.3)}` }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
            <ErrorOutlined sx={{ fontSize: 14, color: 'error.main' }} />
            <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, color: 'error.main' }}>Error</Typography>
          </Box>
          <Typography component="pre" sx={{ fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace', fontSize: '0.75rem', color: 'error.dark', m: 0, whiteSpace: 'pre-wrap', letterSpacing: '0.01em', lineHeight: 1.65 }}>
            {out.error}
          </Typography>
        </Box>
      )}
      {hasDf && (
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
            <DataObject sx={{ fontSize: 13, color: 'primary.main' }} />
            <Typography sx={{ fontSize: '0.7rem', color: 'text.secondary' }}>
              {out.df_preview!.row_count} rows × {out.df_preview!.columns.length} columns
            </Typography>
          </Box>
          <DfTable preview={out.df_preview!} />
        </Box>
      )}
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CellView
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Language detection for code cells
// ─────────────────────────────────────────────────────────────────────────────
const LANGUAGES: { value: string; label: string }[] = [
  { value: 'python',     label: 'Python'     },
  { value: 'sql',        label: 'SQL'        },
  { value: 'json',       label: 'JSON'       },
  { value: 'yaml',       label: 'YAML'       },
  { value: 'bash',       label: 'Bash'       },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'text',       label: 'Plain text' },
]

function detectLanguage(content: string): string {
  const t = content.trimStart()
  if (!t) return 'python'
  // JSON
  if ((t.startsWith('{') || t.startsWith('[')) && /[{[][^]*[}\]]/.test(t)) return 'json'
  // SQL keywords
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|MERGE|EXPLAIN|TRUNCATE)\b/i.test(t)) return 'sql'
  // YAML
  if (/^[\w-]+:\s+\S/.test(t) || /^---\n/.test(t)) return 'yaml'
  // Bash/shell
  if (/^(#!\/usr\/bin\/env\s+\w+|#!\/bin\/(bash|sh|zsh)|echo |export |source |\$\()/.test(t)) return 'bash'
  // JavaScript/TypeScript heuristic
  if (/^(import |export |const |let |var |function |class |interface |type )\b/.test(t) && !/^#/.test(t)) {
    return /:\s*(string|number|boolean|void|any)\b|<[A-Z]/.test(t) ? 'typescript' : 'javascript'
  }
  return 'python'
}

// ─────────────────────────────────────────────────────────────────────────────
// MarkdownRenderer — renders markdown with GFM + syntax highlighting
// ─────────────────────────────────────────────────────────────────────────────
function MarkdownRenderer({ content }: { content: string }) {
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'
  return (
    <Box
      sx={{
        px: 2.5, py: 1.5,
        '& h1,& h2,& h3,& h4,& h5,& h6': {
          mt: 1.5, mb: 0.75, fontWeight: 700, lineHeight: 1.3,
          color: 'text.primary',
          borderBottom: 1, borderColor: 'divider', pb: 0.5,
        },
        '& h1': { fontSize: '1.5rem' },
        '& h2': { fontSize: '1.25rem' },
        '& h3': { fontSize: '1.1rem' },
        '& h4,& h5,& h6': { fontSize: '1rem' },
        '& p': { mt: 0, mb: 1, lineHeight: 1.7, color: 'text.primary', fontSize: '0.9rem' },
        '& ul,& ol': { pl: 3, mb: 1 },
        '& li': { mb: 0.25, fontSize: '0.9rem', color: 'text.primary', lineHeight: 1.6 },
        '& a': { color: 'primary.main', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } },
        '& blockquote': {
          borderLeft: `3px solid`,
          borderLeftColor: 'primary.main',
          ml: 0, pl: 2, py: 0.25, my: 1,
          color: 'text.secondary',
          bgcolor: isDark ? alpha('#6366f1', 0.06) : alpha('#6366f1', 0.04),
          borderRadius: '0 4px 4px 0',
          '& p': { mb: 0 },
        },
        '& :not(pre) > code': {
          fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
          fontSize: '0.8rem',
          px: 0.6, py: 0.15,
          borderRadius: 0.5,
          bgcolor: isDark ? alpha('#fff', 0.08) : alpha('#000', 0.06),
          color: isDark ? '#e2b96b' : '#c0392b',
        },
        '& pre': { my: 1, borderRadius: 1.5, overflow: 'hidden', '& > div': { m: '0 !important', borderRadius: '6px !important' } },
        '& table': { width: '100%', borderCollapse: 'collapse', mb: 1.5, fontSize: '0.85rem' },
        '& th': { textAlign: 'left', fontWeight: 700, py: 0.75, px: 1.5, bgcolor: isDark ? alpha('#fff', 0.05) : alpha('#000', 0.04), borderBottom: 2, borderColor: 'divider' },
        '& td': { py: 0.6, px: 1.5, borderBottom: 1, borderColor: 'divider' },
        '& tr:last-child td': { borderBottom: 'none' },
        '& hr': { border: 'none', borderTop: 1, borderColor: 'divider', my: 1.5 },
        '& strong': { fontWeight: 700 },
        '& em': { fontStyle: 'italic', color: 'text.secondary' },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...rest }) {
            const match = /language-(\w+)/.exec(className || '')
            const inline = !match
            if (inline) {
              return <code className={className} {...rest}>{children}</code>
            }
            return (
              <SyntaxHighlighter
                style={isDark ? oneDark : oneLight}
                language={match[1]}
                PreTag="div"
                customStyle={{ margin: 0, borderRadius: 6, fontSize: '0.82rem' }}
              >
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            )
          },
        }}
      >
        {content || '*Empty markdown cell — click edit to add content*'}
      </ReactMarkdown>
    </Box>
  )
}

interface CellViewProps {
  cell: NotebookCell
  output: CellOutput | null
  running: boolean
  onUpdate: (p: Partial<NotebookCell>) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onRun: () => void
  onClearOutput: () => void
  canMoveUp: boolean
  canMoveDown: boolean
}

function CellView({ cell, output, running, onUpdate, onDelete, onMoveUp, onMoveDown, onRun, onClearOutput, canMoveUp, canMoveDown }: CellViewProps) {
  const theme = useTheme()
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [mdEditing, setMdEditing] = useState(false)
  const [codeEditing, setCodeEditing] = useState(false)
  const [langAnchor, setLangAnchor] = useState<HTMLElement | null>(null)
  const lineCount = Math.max(3, cell.content.split('\n').length)
  const isError = output?.error != null
  const isOk = output && !isError
  const isMarkdown = cell.type === 'markdown'
  const resolvedLang = cell.language ?? detectLanguage(cell.content)
  const langLabel = LANGUAGES.find(l => l.value === resolvedLang)?.label ?? resolvedLang

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (isMarkdown) { setMdEditing(false); return }
      onRun(); return
    }
    if (e.key === 'Escape' && isMarkdown) { setMdEditing(false); return }
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget
      const s = ta.selectionStart; const end = ta.selectionEnd
      const newVal = ta.value.substring(0, s) + '    ' + ta.value.substring(end)
      onUpdate({ content: newVal })
      requestAnimationFrame(() => { if (textRef.current) { textRef.current.selectionStart = s + 4; textRef.current.selectionEnd = s + 4 } })
    }
  }

  return (
    <Box sx={{ border: `1px solid ${isError ? alpha('#f44336', 0.5) : isOk ? alpha(theme.palette.success.main, 0.4) : theme.palette.divider}`, borderRadius: 1.5, overflow: 'hidden', mb: 1.5 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1.5, py: 0.4, bgcolor: alpha(theme.palette.background.paper, 0.7), borderBottom: `1px solid ${theme.palette.divider}` }}>
        <Chip
          icon={isMarkdown ? <Article sx={{ fontSize: '0.75rem !important' }} /> : <Code sx={{ fontSize: '0.75rem !important' }} />}
          label={isMarkdown ? 'markdown' : 'code'} size="small"
          sx={{ fontSize: '0.62rem', height: 18, cursor: 'pointer' }}
          onClick={() => { onUpdate({ type: isMarkdown ? 'code' : 'markdown' }); setMdEditing(false) }}
        />
        {!isMarkdown && (
          <>
            <Chip
              label={cell.language ? langLabel : `${langLabel} ·auto`}
              size="small"
              variant={cell.language ? 'filled' : 'outlined'}
              onClick={(e) => setLangAnchor(e.currentTarget)}
              sx={{ fontSize: '0.6rem', height: 18, cursor: 'pointer', fontFamily: '"JetBrains Mono", monospace', letterSpacing: 0 }}
            />
            <Menu
              anchorEl={langAnchor}
              open={Boolean(langAnchor)}
              onClose={() => setLangAnchor(null)}
              slotProps={{ paper: { sx: { minWidth: 140 } } }}
            >
              <MenuItem
                dense
                selected={!cell.language}
                onClick={() => { onUpdate({ language: undefined }); setLangAnchor(null) }}
              >
                <Typography sx={{ fontSize: '0.8rem', fontStyle: 'italic', color: 'text.secondary' }}>Auto-detect</Typography>
              </MenuItem>
              <Divider sx={{ my: 0.5 }} />
              {LANGUAGES.map(l => (
                <MenuItem
                  key={l.value} dense
                  selected={cell.language === l.value}
                  onClick={() => { onUpdate({ language: l.value }); setLangAnchor(null) }}
                >
                  <Typography sx={{ fontSize: '0.82rem', fontFamily: '"JetBrains Mono", monospace' }}>{l.label}</Typography>
                </MenuItem>
              ))}
            </Menu>
          </>
        )}
        {output && (
          <Typography sx={{ fontSize: '0.65rem', color: isError ? 'error.main' : 'success.main', ml: 0.5 }}>
            {isError ? 'error' : `${output.execution_time_ms}ms`}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Move up"><span><IconButton size="small" onClick={onMoveUp} disabled={!canMoveUp} sx={{ p: 0.3 }}><ArrowUpward sx={{ fontSize: 13 }} /></IconButton></span></Tooltip>
        <Tooltip title="Move down"><span><IconButton size="small" onClick={onMoveDown} disabled={!canMoveDown} sx={{ p: 0.3 }}><ArrowDownward sx={{ fontSize: 13 }} /></IconButton></span></Tooltip>
        {isMarkdown ? (
          <Tooltip title={mdEditing ? 'Preview (⌘Enter)' : 'Edit'}>
            <IconButton size="small" onClick={() => setMdEditing(v => !v)} sx={{ p: 0.3, color: mdEditing ? 'primary.main' : 'text.secondary' }}>
              {mdEditing ? <Article sx={{ fontSize: 15 }} /> : <Edit sx={{ fontSize: 14 }} />}
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title="Run cell (⌘Enter)">
            <IconButton size="small" color="primary" onClick={onRun} disabled={running} sx={{ p: 0.3 }}>
              {running ? <CircularProgress size={12} /> : <PlayArrow sx={{ fontSize: 15 }} />}
            </IconButton>
          </Tooltip>
        )}
        {output && (
          <Tooltip title="Clear cell output">
            <IconButton size="small" onClick={onClearOutput} sx={{ p: 0.3 }}>
              <VisibilityOff sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Delete cell">
          <IconButton size="small" color="error" onClick={onDelete} sx={{ p: 0.3 }}>
            <DeleteOutlined sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Markdown: preview or editor */}
      {isMarkdown ? (
        mdEditing ? (
          <Box
            ref={textRef}
            component="textarea"
            value={cell.content}
            autoFocus
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate({ content: e.target.value })}
            onKeyDown={handleKeyDown}
            onBlur={() => setMdEditing(false)}
            spellCheck
            rows={Math.max(4, lineCount)}
            sx={{
              width: '100%', resize: 'vertical', border: 'none', outline: 'none',
              bgcolor: theme.palette.mode === 'dark' ? alpha('#1c2230', 0.6) : '#fafbfc',
              color: 'text.primary',
              fontFamily: '"Inter", system-ui, sans-serif',
              fontSize: '0.9rem', lineHeight: 1.75, p: 2, display: 'block', boxSizing: 'border-box',
            }}
          />
        ) : (
          <Box onClick={() => setMdEditing(true)} sx={{ cursor: 'text', minHeight: 40 }}>
            <MarkdownRenderer content={cell.content} />
          </Box>
        )
      ) : (
        /* Code cell — syntax-highlighted view or textarea editor */
        codeEditing ? (
          <Box
            ref={textRef}
            component="textarea"
            value={cell.content}
            autoFocus
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate({ content: e.target.value })}
            onKeyDown={handleKeyDown}
            onBlur={() => setCodeEditing(false)}
            spellCheck={false}
            rows={lineCount}
            sx={{
              width: '100%', resize: 'vertical', border: 'none', outline: 'none',
              bgcolor: theme.palette.mode === 'dark' ? '#0d1117' : '#f6f8fa',
              color: theme.palette.mode === 'dark' ? '#c9d1d9' : '#24292f',
              fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
              fontSize: '0.84rem', lineHeight: 1.75, p: '12px 14px', display: 'block', boxSizing: 'border-box',
              caretColor: theme.palette.mode === 'dark' ? '#58a6ff' : '#0969da',
              letterSpacing: '0.02em',
            }}
          />
        ) : (
          <Box
            onClick={() => setCodeEditing(true)}
            sx={{ cursor: 'text', minHeight: 52, '& > div': { m: '0 !important', borderRadius: '0 !important' } }}
          >
            <SyntaxHighlighter
              style={theme.palette.mode === 'dark' ? oneDark : oneLight}
              language={resolvedLang}
              PreTag="div"
              customStyle={{
                margin: 0, borderRadius: 0,
                fontSize: '0.84rem', lineHeight: 1.75, padding: '12px 14px',
                fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
                minHeight: 52,
                background: theme.palette.mode === 'dark' ? '#0d1117' : '#f6f8fa',
              }}
              codeTagProps={{ style: { fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace', letterSpacing: '0.02em' } }}
            >
              {cell.content || '# click to edit'}
            </SyntaxHighlighter>
          </Box>
        )
      )}

      {/* Output */}
      {output && <CellOutputView out={output} />}
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ExportDialog
// ─────────────────────────────────────────────────────────────────────────────
function ExportDialog({ open, onClose, onExport }: { open: boolean; onClose: () => void; onExport: (cfg: ExportConfig) => void }) {
  const [db, setDb] = useState('data_20260416')
  const [table, setTable] = useState('')
  const [sourceVar, setSourceVar] = useState('result_df')
  const [mode, setMode] = useState<'overwrite' | 'append'>('overwrite')
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: '1rem', fontWeight: 700 }}>Export to Spark Table</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '12px !important' }}>
        <TextField label="Target Database" value={db} onChange={e => setDb(e.target.value)} size="small" fullWidth />
        <TextField label="Target Table" value={table} onChange={e => setTable(e.target.value)} size="small" fullWidth placeholder="e.g. mtm_summary" />
        <TextField label="Source Variable" value={sourceVar} onChange={e => setSourceVar(e.target.value)} size="small" fullWidth helperText="DataFrame variable name in your notebook" />
        <FormControl size="small" fullWidth>
          <InputLabel>Write Mode</InputLabel>
          <Select value={mode} label="Write Mode" onChange={e => setMode(e.target.value as 'overwrite' | 'append')}>
            <MenuItem value="overwrite">Overwrite</MenuItem>
            <MenuItem value="append">Append</MenuItem>
          </Select>
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} size="small">Cancel</Button>
        <Button onClick={() => onExport({ target_db: db.trim(), target_table: table.trim(), source_var: sourceVar, mode })} variant="contained" size="small" disabled={!db.trim() || !table.trim()}>Export</Button>
      </DialogActions>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────
export default function Notebooks() {
  const theme = useTheme()
  const qc = useQueryClient()
  const initialTabsRef = useRef<NotebookWorkspaceTabsState>(loadNotebookTabsState())
  const [search, setSearch] = useState('')
  const [openNotebookIds, setOpenNotebookIds] = useState<number[]>(initialTabsRef.current.openNotebookIds)
  const [activeNotebookId, setActiveNotebookId] = useState<number | null>(initialTabsRef.current.activeNotebookId)
  const [drafts, setDrafts] = useState<Record<number, NotebookDraft>>({})
  const [outputsByNotebook, setOutputsByNotebook] = useState<Record<number, Record<string, CellOutput>>>({})
  const [sessionDirtyByNotebook, setSessionDirtyByNotebook] = useState<Record<number, boolean>>({})
  const [exportStatusByNotebook, setExportStatusByNotebook] = useState<Record<number, string | null>>({})
  const [versionsByNotebook, setVersionsByNotebook] = useState<Record<number, NotebookVersionSnapshot[]>>(loadNotebookVersions)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [versionTag, setVersionTag] = useState('DRAFT')
  const [saving, setSaving] = useState(false)
  const [runningAll, setRunningAll] = useState(false)
  const [runningCell, setRunningCell] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [searchPendingVersionFocus, setSearchPendingVersionFocus] = useState(false)

  const { data: notebooks = [], isLoading } = useQuery({ queryKey: ['notebooks'], queryFn: transformApi.listNotebooks })
  const { data: labelsResp } = useQuery({
    queryKey: ['sql-version-labels'],
    queryFn: () => sqlFilesApi.getVersionLabels(),
  })
  const versionLabels = labelsResp?.labels?.length
    ? labelsResp.labels
    : ['INITIAL', 'DRAFT', 'FINAL', 'DEPRECATED']

  const notebookById = useMemo(() => {
    const map = new Map<number, NotebookFile>()
    notebooks.forEach(nb => map.set(nb.id, nb))
    return map
  }, [notebooks])

  const activeNotebook = activeNotebookId != null ? (notebookById.get(activeNotebookId) ?? null) : null
  const activeDraft = activeNotebookId != null ? drafts[activeNotebookId] : undefined
  const activeOutputs = activeNotebookId != null ? (outputsByNotebook[activeNotebookId] ?? {}) : {}
  const activeExportStatus = activeNotebookId != null ? (exportStatusByNotebook[activeNotebookId] ?? null) : null
  const activeSessionDirty = activeNotebookId != null ? Boolean(sessionDirtyByNotebook[activeNotebookId]) : false
  const activeVersions = activeNotebookId != null ? (versionsByNotebook[activeNotebookId] ?? []) : []
  const activeVersion = activeVersions.find(v => v.id === selectedVersionId) ?? null

  const dirtyById = useMemo(() => {
    const map = new Map<number, boolean>()
    for (const id of openNotebookIds) {
      map.set(id, isNotebookDraftDirty(notebookById.get(id), drafts[id]))
    }
    return map
  }, [openNotebookIds, notebookById, drafts])
  const activeDirty = activeNotebookId != null ? Boolean(dirtyById.get(activeNotebookId)) : false
  const filteredNotebooks = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return notebooks
    return notebooks.filter(nb => {
      const name = nb.name.toLowerCase()
      const desc = (nb.description ?? '').toLowerCase()
      return name.includes(q) || desc.includes(q)
    })
  }, [notebooks, search])

  const createMut = useMutation({
    mutationFn: (data: Partial<NotebookFile>) => transformApi.createNotebook(data),
    onSuccess: (nb) => {
      qc.invalidateQueries({ queryKey: ['notebooks'] })
      openNotebook(nb)
    },
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<NotebookFile> }) => transformApi.updateNotebook(id, data),
    onSuccess: (nb) => {
      qc.invalidateQueries({ queryKey: ['notebooks'] })
      setDrafts(prev => ({ ...prev, [nb.id]: notebookDraftFromFile(nb) }))
      setSessionDirtyByNotebook(prev => ({ ...prev, [nb.id]: false }))
    },
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => transformApi.deleteNotebook(id),
    onSuccess: (_, deletedId) => {
      qc.invalidateQueries({ queryKey: ['notebooks'] })
      setOpenNotebookIds(prev => {
        const idx = prev.indexOf(deletedId)
        const next = prev.filter(id => id !== deletedId)
        if (activeNotebookId === deletedId) {
          const fallback = next[idx] ?? next[idx - 1] ?? null
          setActiveNotebookId(fallback)
        }
        return next
      })
      setDrafts(prev => {
        const next = { ...prev }
        delete next[deletedId]
        return next
      })
      setOutputsByNotebook(prev => {
        const next = { ...prev }
        delete next[deletedId]
        return next
      })
      setSessionDirtyByNotebook(prev => {
        const next = { ...prev }
        delete next[deletedId]
        return next
      })
      setExportStatusByNotebook(prev => {
        const next = { ...prev }
        delete next[deletedId]
        return next
      })
      setVersionsByNotebook(prev => {
        const next = { ...prev }
        delete next[deletedId]
        return next
      })
      setSelectedVersionId(null)
    },
  })

  function openNotebook(nb: NotebookFile) {
    setOpenNotebookIds(prev => (prev.includes(nb.id) ? prev : [...prev, nb.id]))
    setActiveNotebookId(nb.id)
    setDrafts(prev => {
      if (prev[nb.id]) return prev
      return { ...prev, [nb.id]: notebookDraftFromFile(nb) }
    })
    setSelectedVersionId(null)
  }

  function closeNotebook(notebookId: number) {
    const file = notebookById.get(notebookId)
    const draft = drafts[notebookId]
    if (isNotebookDraftDirty(file, draft)) {
      const label = draft?.name ?? file?.name ?? `Notebook ${notebookId}`
      const confirmed = window.confirm(`You have unsaved changes in "${label}". Close anyway?`)
      if (!confirmed) return
    }
    setOpenNotebookIds(prev => {
      const idx = prev.indexOf(notebookId)
      const next = prev.filter(id => id !== notebookId)
      if (activeNotebookId === notebookId) {
        const fallback = next[idx] ?? next[idx - 1] ?? null
        setActiveNotebookId(fallback)
      }
      return next
    })
  }

  function updateActiveDraft(patch: Partial<NotebookDraft>) {
    if (activeNotebookId == null) return
    setDrafts(prev => {
      const existing = prev[activeNotebookId]
      if (!existing) return prev
      return { ...prev, [activeNotebookId]: { ...existing, ...patch } }
    })
  }

  function addCell(type: 'code' | 'markdown' = 'code') {
    if (!activeDraft) return
    updateActiveDraft({
      cells: [...activeDraft.cells, { id: genId(), type, content: type === 'code' ? '' : '## Notes\n' }],
    })
    if (activeNotebookId != null) {
      setSessionDirtyByNotebook(prev => ({ ...prev, [activeNotebookId]: true }))
    }
  }

  function updateCell(id: string, patch: Partial<NotebookCell>) {
    if (!activeDraft || activeNotebookId == null) return
    updateActiveDraft({ cells: activeDraft.cells.map(cell => (cell.id === id ? { ...cell, ...patch } : cell)) })
    setSessionDirtyByNotebook(prev => ({ ...prev, [activeNotebookId]: true }))
  }

  function deleteCell(id: string) {
    if (!activeDraft || activeNotebookId == null) return
    if (activeDraft.cells.length <= 1) return
    updateActiveDraft({ cells: activeDraft.cells.filter(cell => cell.id !== id) })
    setOutputsByNotebook(prev => {
      const notebookOutputs = { ...(prev[activeNotebookId] ?? {}) }
      delete notebookOutputs[id]
      return { ...prev, [activeNotebookId]: notebookOutputs }
    })
    setSessionDirtyByNotebook(prev => ({ ...prev, [activeNotebookId]: true }))
  }

  function moveCell(id: string, dir: -1 | 1) {
    if (!activeDraft || activeNotebookId == null) return
    const cells = activeDraft.cells
    const idx = cells.findIndex(cell => cell.id === id)
    if (idx < 0) return
    const ni = idx + dir
    if (ni < 0 || ni >= cells.length) return
    const arr = [...cells]
    ;[arr[idx], arr[ni]] = [arr[ni], arr[idx]]
    updateActiveDraft({ cells: arr })
    setSessionDirtyByNotebook(prev => ({ ...prev, [activeNotebookId]: true }))
  }

  function createSnapshot() {
    if (!activeDraft || activeNotebookId == null) return
    setVersionsByNotebook(prev => {
      const existing = prev[activeNotebookId] ?? []
      const version = `v${String(existing.length + 1).padStart(3, '0')}`
      const nextVersion: NotebookVersionSnapshot = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        notebookId: activeNotebookId,
        version,
        tag: versionTag,
        name: activeDraft.name,
        cells: cloneCells(activeDraft.cells),
        createdAt: new Date().toISOString(),
      }
      const next = {
        ...prev,
        [activeNotebookId]: [nextVersion, ...existing].slice(0, 50),
      }
      setSelectedVersionId(nextVersion.id)
      return next
    })
  }

  function clearActiveOutputs() {
    if (activeNotebookId == null) return
    setOutputsByNotebook(prev => ({ ...prev, [activeNotebookId]: {} }))
  }

  function clearCellOutput(cellId: string) {
    if (activeNotebookId == null) return
    setOutputsByNotebook(prev => {
      const nextOutputs = { ...(prev[activeNotebookId] ?? {}) }
      delete nextOutputs[cellId]
      return { ...prev, [activeNotebookId]: nextOutputs }
    })
  }

  async function handleSave() {
    if (!activeNotebook || !activeDraft) return
    setSaving(true)
    try {
      await updateMut.mutateAsync({
        id: activeNotebook.id,
        data: {
          name: activeDraft.name,
          description: activeDraft.description,
          cells: activeDraft.cells,
        },
      })
    } finally {
      setSaving(false)
    }
  }

  async function runCells(notebookId: number, targetCells: NotebookCell[], reset = false) {
    try {
      const result = await transformApi.executeNotebook(notebookId, targetCells, reset)
      setOutputsByNotebook(prev => {
        const nextOutputs = { ...(prev[notebookId] ?? {}) }
        for (const out of result.outputs) nextOutputs[out.cell_id] = out
        return { ...prev, [notebookId]: nextOutputs }
      })
      setSessionDirtyByNotebook(prev => ({ ...prev, [notebookId]: false }))
    } catch (err) { console.error('Notebook execution error', err) }
  }

  async function handleRunAll(reset = false) {
    if (!activeNotebookId || !activeDraft) return
    setRunningAll(true)
    setOutputsByNotebook(prev => ({ ...prev, [activeNotebookId]: {} }))
    try {
      await runCells(activeNotebookId, activeDraft.cells, reset)
    } finally {
      setRunningAll(false)
    }
  }

  async function handleRunCell(cellId: string) {
    if (!activeNotebookId || !activeDraft) return
    setRunningCell(cellId)
    try {
      const idx = activeDraft.cells.findIndex(c => c.id === cellId)
      await runCells(activeNotebookId, idx >= 0 ? activeDraft.cells.slice(0, idx + 1) : activeDraft.cells, false)
    } finally { setRunningCell(null) }
  }

  async function handleExport(cfg: ExportConfig) {
    if (!activeNotebookId) return
    setExportOpen(false)
    setExportStatusByNotebook(prev => ({ ...prev, [activeNotebookId]: 'Exporting...' }))
    try {
      const res = await transformApi.exportNotebook(activeNotebookId, cfg)
      setExportStatusByNotebook(prev => ({
        ...prev,
        [activeNotebookId]: `Saved ${res.row_count.toLocaleString()} rows to ${res.table} (${res.duration_s}s)`,
      }))
      qc.invalidateQueries({ queryKey: ['catalog-tables'] })
    } catch (err: unknown) {
      setExportStatusByNotebook(prev => ({
        ...prev,
        [activeNotebookId]: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      }))
    }
  }

  const anyRunning = runningAll || !!runningCell
  const codeCellCount = activeDraft?.cells.filter(c => c.type === 'code').length ?? 0

  useEffect(() => {
    if (!versionLabels.includes(versionTag)) {
      setVersionTag(versionLabels[0] ?? 'DRAFT')
    }
  }, [versionLabels, versionTag])

  useEffect(() => {
    localStorage.setItem(
      NOTEBOOK_WORKSPACE_TABS_KEY,
      JSON.stringify({ openNotebookIds, activeNotebookId }),
    )
  }, [openNotebookIds, activeNotebookId])

  useEffect(() => {
    localStorage.setItem(
      NOTEBOOK_WORKSPACE_VERSIONS_KEY,
      JSON.stringify(versionsByNotebook),
    )
  }, [versionsByNotebook])

  useEffect(() => {
    if (activeNotebookId == null || !activeNotebook) return
    setDrafts(prev => {
      if (prev[activeNotebookId]) return prev
      return { ...prev, [activeNotebookId]: notebookDraftFromFile(activeNotebook) }
    })
  }, [activeNotebookId, activeNotebook])

  useEffect(() => {
    if (notebooks.length === 0) return
    const validIds = new Set(notebooks.map(n => n.id))
    setOpenNotebookIds(prev => {
      const next = prev.filter(id => validIds.has(id))
      const unchanged = next.length === prev.length && next.every((id, idx) => id === prev[idx])
      if (!unchanged) {
        setDrafts(dPrev => {
          const dNext = { ...dPrev }
          prev.filter(id => !validIds.has(id)).forEach(id => { delete dNext[id] })
          return dNext
        })
      }
      return unchanged ? prev : next
    })
    setActiveNotebookId(prev => {
      if (prev != null && validIds.has(prev)) return prev
      const nextOpen = openNotebookIds.filter(id => validIds.has(id))
      const nextActive = nextOpen[0] ?? null
      return prev === nextActive ? prev : nextActive
    })
  }, [notebooks, openNotebookIds])

  useEffect(() => {
    setSelectedVersionId(null)
  }, [activeNotebookId])

  useEffect(() => {
    if (!searchPendingVersionFocus) return
    if (activeVersions.length > 0) {
      setSelectedVersionId(activeVersions[0].id)
    }
    setSearchPendingVersionFocus(false)
  }, [searchPendingVersionFocus, activeVersions])

  return (
    <>
      <WorkspaceTemplate
        storageKey="notebook-workspace-layout"
        showPanelControlsRow={false}
        defaultLayout={{ leftSidebarWidth: 290, leftCollapsed: false, rightCollapsed: false }}
        leftPanelLabel="notebooks panel"
        rightPanelLabel="versions panel"
        rightPanelWidth={320}
        renderLeftPanel={() => (
          <>
            <Box sx={{ p: 1.5, borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Notebook Workspace</Typography>
                <Box sx={{ flex: 1 }} />
                <Tooltip title="New notebook">
                  <IconButton
                    size="small"
                    onClick={() => {
                      createMut.mutate({
                        name: `Notebook ${notebooks.length + 1}`,
                        cells: [{ id: genId(), type: 'code', content: DEFAULT_CODE_PREAMBLE }],
                      })
                    }}
                    disabled={createMut.isPending}
                  >
                    <Add sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              </Box>
              <TextField
                placeholder="Search notebooks…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                size="small"
                fullWidth
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
                <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={22} /></Box>
              ) : (
                <List dense disablePadding sx={{ px: 0.5, py: 0.5 }}>
                  {filteredNotebooks.map(nb => {
                    const draft = drafts[nb.id]
                    const dirty = isNotebookDraftDirty(nb, draft)
                    return (
                      <ListItem key={nb.id} disablePadding>
                        <ListItemButton
                          selected={activeNotebookId === nb.id}
                          onClick={() => openNotebook(nb)}
                          sx={workspaceSidebarItemButtonSx}
                        >
                          <ListItemText
                            primary={
                              <Typography variant="body2" noWrap sx={{ ...workspaceSidebarItemTextSx, fontWeight: dirty ? 700 : 500, color: dirty ? 'warning.main' : 'text.primary' }}>
                                {nb.name}{dirty ? ' *' : ''}
                              </Typography>
                            }
                          />
                        </ListItemButton>
                      </ListItem>
                    )
                  })}
                  {filteredNotebooks.length === 0 && (
                    <Box sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>
                      <Typography variant="body2">No notebooks found</Typography>
                    </Box>
                  )}
                </List>
              )}
            </Box>
          </>
        )}
        renderMainPanel={() => (
          activeNotebook && activeDraft ? (
            <>
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
                {openNotebookIds.map(id => {
                  const notebook = notebookById.get(id)
                  const draft = drafts[id]
                  const label = draft?.name ?? notebook?.name ?? `Notebook ${id}`
                  const isActive = id === activeNotebookId
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
                      <Button size="small" onClick={() => setActiveNotebookId(id)} sx={{ minWidth: 0, px: 0.25, py: 0, textTransform: 'none' }}>
                        <Typography
                          variant="caption"
                          noWrap
                          sx={{ maxWidth: 200, color: isDirty ? 'warning.main' : 'text.primary', fontWeight: isDirty ? 700 : 400 }}
                        >
                          {label}{isDirty ? ' *' : ''}
                        </Typography>
                      </Button>
                      <IconButton size="small" onClick={() => closeNotebook(id)} sx={{ p: 0.2 }}>
                        <Close sx={{ fontSize: 12 }} />
                      </IconButton>
                    </Box>
                  )
                })}
              </Box>

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 2, py: 0.75, bgcolor: 'background.paper', borderBottom: `1px solid ${theme.palette.divider}`, flexShrink: 0, flexWrap: 'wrap' }}>
                <TextField
                  value={activeDraft.name}
                  onChange={e => updateActiveDraft({ name: e.target.value })}
                  size="small"
                  variant="standard"
                  sx={{ '& input': { fontWeight: 700, fontSize: '1rem' }, minWidth: 160 }}
                  placeholder="Notebook title"
                />
                <Box sx={{ flex: 1 }} />
                {!saving && activeDirty && (
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
                <Button size="small" onClick={() => addCell('code')} startIcon={<Code sx={{ fontSize: 13 }} />} variant="outlined" sx={{ fontSize: '0.73rem', py: 0.3 }}>Code</Button>
                <Button size="small" onClick={() => addCell('markdown')} startIcon={<Article sx={{ fontSize: 13 }} />} variant="outlined" sx={{ fontSize: '0.73rem', py: 0.3 }}>Markdown</Button>
                <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />
                <Tooltip title="Run all cells">
                  <span>
                    <Button size="small" color="primary" variant="contained"
                      startIcon={runningAll ? <CircularProgress size={12} color="inherit" /> : <PlayCircleOutlined sx={{ fontSize: 15 }} />}
                      onClick={() => handleRunAll(false)} disabled={anyRunning || codeCellCount === 0} sx={{ fontSize: '0.73rem', py: 0.3 }}>
                      Run All
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title="Reset session and run all">
                  <span>
                    <IconButton size="small" onClick={() => handleRunAll(true)} disabled={anyRunning} sx={{ p: 0.4 }}>
                      <RestartAlt sx={{ fontSize: 17 }} />
                    </IconButton>
                  </span>
                </Tooltip>
                <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />
                <TextField
                  select
                  size="small"
                  variant="standard"
                  value={versionTag}
                  onChange={e => setVersionTag(e.target.value)}
                  sx={{ minWidth: 128 }}
                >
                  {versionLabels.map(label => <MenuItem key={label} value={label}>{label}</MenuItem>)}
                </TextField>
                <Tooltip title="Create notebook snapshot">
                  <IconButton size="small" onClick={() => { createSnapshot(); setSearchPendingVersionFocus(true) }}>
                    <History sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Export result_df to a Spark table">
                  <span>
                    <Button size="small" variant="outlined" color="secondary" startIcon={<Download sx={{ fontSize: 13 }} />} onClick={() => setExportOpen(true)} disabled={anyRunning} sx={{ fontSize: '0.73rem', py: 0.3 }}>Export</Button>
                  </span>
                </Tooltip>
                <Tooltip title="Clear all outputs">
                  <span>
                    <Button
                      size="small"
                      variant="outlined"
                      color="inherit"
                      startIcon={<VisibilityOff sx={{ fontSize: 13 }} />}
                      onClick={clearActiveOutputs}
                      disabled={Object.keys(activeOutputs).length === 0}
                      sx={{ fontSize: '0.73rem', py: 0.3 }}
                    >
                      Clear Outputs
                    </Button>
                  </span>
                </Tooltip>
                <Button size="small" variant="text" startIcon={saving ? <CircularProgress size={12} /> : <Save sx={{ fontSize: 13 }} />} onClick={handleSave} disabled={saving || updateMut.isPending || !activeDirty} sx={{ fontSize: '0.73rem', py: 0.3 }}>Save</Button>
                <Tooltip title="Delete notebook">
                  <span>
                    <IconButton
                      size="small"
                      color="error"
                      disabled={deleteMut.isPending}
                      onClick={() => {
                        if (!window.confirm(`Delete notebook \"${activeNotebook.name}\"?`)) return
                        deleteMut.mutate(activeNotebook.id)
                      }}
                    >
                      <DeleteOutlined sx={{ fontSize: 16 }} />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>

              {(activeExportStatus || activeSessionDirty) && (
                <Box
                  sx={{
                    px: 2,
                    py: 0.4,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    bgcolor: activeExportStatus?.startsWith('Saved')
                      ? alpha(theme.palette.success.main, 0.08)
                      : activeExportStatus?.startsWith('Export failed')
                        ? alpha(theme.palette.error.main, 0.08)
                        : alpha(theme.palette.warning.main, 0.07),
                    borderBottom: `1px solid ${theme.palette.divider}`,
                  }}
                >
                  {activeExportStatus ? (
                    <>
                      {activeExportStatus.startsWith('Saved') && <CheckCircleOutlined sx={{ fontSize: 13, color: 'success.main' }} />}
                      {activeExportStatus.startsWith('Export failed') && <ErrorOutlined sx={{ fontSize: 13, color: 'error.main' }} />}
                      <Typography sx={{ fontSize: '0.73rem', color: activeExportStatus.startsWith('Saved') ? 'success.dark' : 'error.dark', flex: 1 }}>{activeExportStatus}</Typography>
                      <IconButton
                        size="small"
                        sx={{ p: 0.3 }}
                        onClick={() => {
                          if (activeNotebookId == null) return
                          setExportStatusByNotebook(prev => ({ ...prev, [activeNotebookId]: null }))
                        }}
                      >
                        <DeleteOutlined sx={{ fontSize: 12 }} />
                      </IconButton>
                    </>
                  ) : (
                    <Typography sx={{ fontSize: '0.72rem', color: 'warning.dark' }}>Session may be out of date - re-run to refresh</Typography>
                  )}
                </Box>
              )}

              <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
                {activeDraft.cells.map((cell, idx) => (
                  <CellView
                    key={cell.id}
                    cell={cell}
                    output={activeOutputs[cell.id] ?? null}
                    running={runningAll || runningCell === cell.id}
                    onUpdate={patch => updateCell(cell.id, patch)}
                    onDelete={() => deleteCell(cell.id)}
                    onMoveUp={() => moveCell(cell.id, -1)}
                    onMoveDown={() => moveCell(cell.id, 1)}
                    onRun={() => handleRunCell(cell.id)}
                    onClearOutput={() => clearCellOutput(cell.id)}
                    canMoveUp={idx > 0}
                    canMoveDown={idx < activeDraft.cells.length - 1}
                  />
                ))}
                <Button startIcon={<Add />} onClick={() => addCell('code')} sx={{ mt: 0.5 }} variant="outlined" size="small">Add Cell</Button>
              </Box>
            </>
          ) : (
            <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary' }}>
              <Box sx={{ textAlign: 'center' }}>
                <Article sx={{ fontSize: 48, opacity: 0.25, mb: 2 }} />
                <Typography variant="body2">Select a notebook to start editing</Typography>
              </Box>
            </Box>
          )
        )}
        renderRightPanel={() => (
          activeNotebookId == null || !activeDraft ? (
            <Box sx={{ p: 2, color: 'text.secondary' }}>
              <Typography variant="body2">No notebook selected</Typography>
            </Box>
          ) : (
            <>
              <Box sx={{ px: 1.5, py: 1, borderBottom: `1px solid ${theme.palette.divider}` }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Version Timeline</Typography>
                <Typography variant="caption" color="text.secondary">Local snapshots and saved revisions</Typography>
              </Box>
              <Box sx={{ flex: 1, overflowY: 'auto' }}>
                <List dense disablePadding>
                  {activeVersions.map(v => (
                    <ListItem key={v.id} disablePadding>
                      <ListItemButton
                        selected={selectedVersionId === v.id}
                        onClick={() => setSelectedVersionId(v.id)}
                        sx={{ py: 0.75, px: 1.25 }}
                      >
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                            <Typography variant="body2" noWrap sx={{ fontSize: '0.75rem', fontWeight: 600 }}>{v.version}</Typography>
                            <Chip label={v.tag} size="small" sx={{ height: 16, fontSize: '0.56rem', textTransform: 'uppercase' }} />
                          </Box>
                          <Typography variant="caption" color="text.secondary" noWrap>
                            {new Date(v.createdAt).toLocaleString()} - {changedCellCount(activeDraft.cells, v.cells)} changed cells
                          </Typography>
                        </Box>
                      </ListItemButton>
                    </ListItem>
                  ))}
                  {activeVersions.length === 0 && (
                    <Box sx={{ p: 2, textAlign: 'center', color: 'text.secondary' }}>
                      <Typography variant="caption">No snapshots yet</Typography>
                    </Box>
                  )}
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
                        maxHeight: 140,
                        overflow: 'auto',
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: '0.68rem',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {notebookPreview(activeVersion.cells)}
                    </Box>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => {
                        updateActiveDraft({
                          name: activeVersion.name,
                          cells: cloneCells(activeVersion.cells),
                        })
                        if (activeNotebookId != null) {
                          setSessionDirtyByNotebook(prev => ({ ...prev, [activeNotebookId]: true }))
                        }
                      }}
                    >
                      Restore This Version
                    </Button>
                  </Box>
                </>
              )}
            </>
          )
        )}
      />

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} onExport={handleExport} />
    </>
  )
}
