import { useRef, useState } from 'react'
import {
  alpha, Box, Button, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, FormControl, IconButton, InputLabel,
  List, ListItem, ListItemButton, ListItemText, Menu, MenuItem, Paper, Select,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  TextField, Tooltip, Typography, useTheme,
} from '@mui/material'
import {
  Add, Article, ArrowDownward, ArrowUpward, CheckCircleOutlined, Code,
  DataObject, DeleteOutlined, Download, Edit, ErrorOutlined, PlayArrow,
  PlayCircleOutlined, RestartAlt, Save,
} from '@mui/icons-material'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import {
  CellOutput, DfPreview, ExportConfig, NotebookCell, NotebookFile, transformApi,
} from '../api/client'

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
  canMoveUp: boolean
  canMoveDown: boolean
}

function CellView({ cell, output, running, onUpdate, onDelete, onMoveUp, onMoveDown, onRun, canMoveUp, canMoveDown }: CellViewProps) {
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
  const [selected, setSelected] = useState<NotebookFile | null>(null)
  const [cells, setCells] = useState<NotebookCell[]>([])
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [runningAll, setRunningAll] = useState(false)
  const [runningCell, setRunningCell] = useState<string | null>(null)
  const [outputs, setOutputs] = useState<Record<string, CellOutput>>({})
  const [exportOpen, setExportOpen] = useState(false)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [sessionDirty, setSessionDirty] = useState(false)

  const { data: notebooks = [], isLoading } = useQuery({ queryKey: ['notebooks'], queryFn: transformApi.listNotebooks })

  const createMut = useMutation({
    mutationFn: (data: Partial<NotebookFile>) => transformApi.createNotebook(data),
    onSuccess: (nb) => { qc.invalidateQueries({ queryKey: ['notebooks'] }); openNotebook(nb) },
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<NotebookFile> }) => transformApi.updateNotebook(id, data),
    onSuccess: (nb) => { qc.invalidateQueries({ queryKey: ['notebooks'] }); setSelected(nb) },
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => transformApi.deleteNotebook(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['notebooks'] }); setSelected(null); setCells([]); setOutputs({}) },
  })

  function openNotebook(nb: NotebookFile) {
    setSelected(nb); setTitle(nb.name)
    // Normalise cells from API: backend may return {source, type} without id
    const normalized = nb.cells.map((c: any) => ({
      id: c.id ?? genId(),
      type: (c.type ?? 'code') as 'code' | 'markdown',
      content: c.content ?? c.source ?? '',
    }))
    setCells(normalized.length > 0 ? normalized : [{ id: genId(), type: 'code', content: DEFAULT_CODE_PREAMBLE }])
    setOutputs({}); setSessionDirty(false); setExportStatus(null)
  }

  function addCell(type: 'code' | 'markdown' = 'code') {
    setCells(c => [...c, { id: genId(), type, content: type === 'code' ? '' : '## Notes\n' }])
  }
  function updateCell(id: string, patch: Partial<NotebookCell>) {
    setCells(c => c.map(cell => cell.id === id ? { ...cell, ...patch } : cell)); setSessionDirty(true)
  }
  function deleteCell(id: string) {
    if (cells.length <= 1) return
    setCells(c => c.filter(cell => cell.id !== id))
    setOutputs(o => { const n = { ...o }; delete n[id]; return n })
  }
  function moveCell(id: string, dir: -1 | 1) {
    setCells(c => {
      const idx = c.findIndex(cell => cell.id === id); if (idx < 0) return c
      const ni = idx + dir; if (ni < 0 || ni >= c.length) return c
      const arr = [...c]; [arr[idx], arr[ni]] = [arr[ni], arr[idx]]; return arr
    })
  }

  async function handleSave() {
    if (!selected) return; setSaving(true)
    try { await updateMut.mutateAsync({ id: selected.id, data: { name: title, cells } }) } finally { setSaving(false) }
  }

  async function runCells(targetCells: NotebookCell[], reset = false) {
    if (!selected) return
    try {
      const result = await transformApi.executeNotebook(selected.id, targetCells, reset)
      setOutputs(o => {
        const next = { ...o }
        for (const out of result.outputs) next[out.cell_id] = out
        return next
      })
      setSessionDirty(false)
    } catch (err) { console.error('Notebook execution error', err) }
  }

  async function handleRunAll(reset = false) {
    setRunningAll(true); setOutputs({})
    try { await runCells(cells, reset) } finally { setRunningAll(false) }
  }

  async function handleRunCell(cellId: string) {
    setRunningCell(cellId)
    try {
      const idx = cells.findIndex(c => c.id === cellId)
      await runCells(idx >= 0 ? cells.slice(0, idx + 1) : cells, false)
    } finally { setRunningCell(null) }
  }

  async function handleExport(cfg: ExportConfig) {
    if (!selected) return
    setExportOpen(false); setExportStatus('Exporting…')
    try {
      const res = await transformApi.exportNotebook(selected.id, cfg)
      setExportStatus(`✓ Exported ${res.row_count.toLocaleString()} rows → ${res.table} (${res.duration_s}s)`)
      qc.invalidateQueries({ queryKey: ['catalog-tables'] })
    } catch (err: unknown) {
      setExportStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const anyRunning = runningAll || !!runningCell
  const codeCellCount = cells.filter(c => c.type === 'code').length

  return (
    <Box sx={{ display: 'flex', height: '100%' }}>
      {/* ── Sidebar ── */}
      <Box sx={{ width: 220, flexShrink: 0, bgcolor: 'background.paper', borderRight: `1px solid ${theme.palette.divider}`, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ p: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Typography variant="subtitle2" fontWeight={700}>Notebooks</Typography>
        </Box>
        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {isLoading
            ? <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}><CircularProgress size={22} /></Box>
            : (
              <List dense disablePadding>
                {notebooks.map(nb => (
                  <ListItem key={nb.id} disablePadding
                    secondaryAction={
                      <Tooltip title="Delete">
                        <IconButton size="small" edge="end" sx={{ mr: 0.5, opacity: 0.35, '&:hover': { opacity: 1 } }} onClick={e => { e.stopPropagation(); deleteMut.mutate(nb.id) }}>
                          <DeleteOutlined sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                    }
                  >
                    <ListItemButton selected={selected?.id === nb.id} onClick={() => openNotebook(nb)} sx={{ px: 2, py: 0.75, pr: 4 }}>
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
          <Button startIcon={<Add />} fullWidth size="small" onClick={() => createMut.mutate({ name: `Notebook ${notebooks.length + 1}`, cells: [{ id: genId(), type: 'code', content: DEFAULT_CODE_PREAMBLE }] })} disabled={createMut.isPending}>
            New Notebook
          </Button>
        </Box>
      </Box>

      {/* ── Editor ── */}
      {selected ? (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Toolbar */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 2, py: 0.75, bgcolor: 'background.paper', borderBottom: `1px solid ${theme.palette.divider}`, flexShrink: 0, flexWrap: 'wrap' }}>
            <TextField value={title} onChange={e => setTitle(e.target.value)} size="small" variant="standard" sx={{ '& input': { fontWeight: 700, fontSize: '1rem' }, minWidth: 160 }} placeholder="Notebook title" />
            <Box sx={{ flex: 1 }} />
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
            <Tooltip title="Export result_df to a Spark table">
              <span>
                <Button size="small" variant="outlined" color="secondary" startIcon={<Download sx={{ fontSize: 13 }} />} onClick={() => setExportOpen(true)} disabled={anyRunning} sx={{ fontSize: '0.73rem', py: 0.3 }}>Export</Button>
              </span>
            </Tooltip>
            <Button size="small" variant="text" startIcon={saving ? <CircularProgress size={12} /> : <Save sx={{ fontSize: 13 }} />} onClick={handleSave} disabled={saving || updateMut.isPending} sx={{ fontSize: '0.73rem', py: 0.3 }}>Save</Button>
          </Box>

          {/* Status bar */}
          {(exportStatus || sessionDirty) && (
            <Box sx={{ px: 2, py: 0.4, display: 'flex', alignItems: 'center', gap: 1, bgcolor: exportStatus?.startsWith('✓') ? alpha(theme.palette.success.main, 0.08) : exportStatus?.startsWith('Export failed') ? alpha(theme.palette.error.main, 0.08) : alpha(theme.palette.warning.main, 0.07), borderBottom: `1px solid ${theme.palette.divider}` }}>
              {exportStatus
                ? <>
                    {exportStatus.startsWith('✓') && <CheckCircleOutlined sx={{ fontSize: 13, color: 'success.main' }} />}
                    {exportStatus.startsWith('Export failed') && <ErrorOutlined sx={{ fontSize: 13, color: 'error.main' }} />}
                    <Typography sx={{ fontSize: '0.73rem', color: exportStatus.startsWith('✓') ? 'success.dark' : 'error.dark', flex: 1 }}>{exportStatus}</Typography>
                    <IconButton size="small" sx={{ p: 0.3 }} onClick={() => setExportStatus(null)}><DeleteOutlined sx={{ fontSize: 12 }} /></IconButton>
                  </>
                : <Typography sx={{ fontSize: '0.72rem', color: 'warning.dark' }}>Session may be out of date — re-run to refresh</Typography>
              }
            </Box>
          )}

          {/* Cells */}
          <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
            {cells.map((cell, idx) => (
              <CellView key={cell.id} cell={cell} output={outputs[cell.id] ?? null} running={runningAll || runningCell === cell.id}
                onUpdate={patch => updateCell(cell.id, patch)} onDelete={() => deleteCell(cell.id)}
                onMoveUp={() => moveCell(cell.id, -1)} onMoveDown={() => moveCell(cell.id, 1)} onRun={() => handleRunCell(cell.id)}
                canMoveUp={idx > 0} canMoveDown={idx < cells.length - 1} />
            ))}
            <Button startIcon={<Add />} onClick={() => addCell('code')} sx={{ mt: 0.5 }} variant="outlined" size="small">Add Cell</Button>
          </Box>
        </Box>
      ) : (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary' }}>
          <Box sx={{ textAlign: 'center' }}>
            <Article sx={{ fontSize: 48, opacity: 0.25, mb: 2 }} />
            <Typography variant="body2">Select a notebook or create a new one</Typography>
          </Box>
        </Box>
      )}

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} onExport={handleExport} />
    </Box>
  )
}
