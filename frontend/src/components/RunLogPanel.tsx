import { useState, useEffect, useRef, useMemo } from 'react'
import {
  Box, Typography, TextField, InputAdornment, IconButton, Chip,
  Tooltip, alpha, useTheme, MenuItem,
} from '@mui/material'
import {
  Search, Close, ArrowDownward, FilterList, ContentCopy, Done,
} from '@mui/icons-material'
import { RunLog } from '../api/client'
import { format, parseISO } from 'date-fns'

// ── Constants ─────────────────────────────────────────────────────────────────

const LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']

const LEVEL_COLOR: Record<string, string> = {
  DEBUG:    '#6e7681',
  INFO:     '#58a6ff',
  WARNING:  '#e3b341',
  ERROR:    '#f85149',
  CRITICAL: '#ff6e6e',
}

const LEVEL_BG: Record<string, string> = {
  DEBUG:    'transparent',
  INFO:     'transparent',
  WARNING:  alpha('#e3b341', 0.06),
  ERROR:    alpha('#f85149', 0.08),
  CRITICAL: alpha('#ff6e6e', 0.12),
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTimestamp(ts?: string): string {
  if (!ts) return ''
  try { return format(parseISO(ts.endsWith('Z') ? ts : ts + 'Z'), 'HH:mm:ss.SSS') } catch { return ts }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  logs: RunLog[]
  /** Whether the run is live (auto-scrolls to bottom) */
  live?: boolean
  /** Initial panel height in px */
  defaultHeight?: number
  /** Dynamically size the panel to fill from its top position to the viewport bottom */
  fillToBottom?: boolean
  /** Padding from viewport bottom (px) when fillToBottom is true */
  bottomPadding?: number
}

export default function RunLogPanel({ logs, live = false, defaultHeight = 220, fillToBottom = false, bottomPadding = 16 }: Props) {
  const theme = useTheme()
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const [levelFilter, setLevelFilter] = useState<Set<string>>(new Set())
  const [stepFilter, setStepFilter] = useState('')
  const [autoScroll, setAutoScroll] = useState(live)
  const [copied, setCopied] = useState(false)
  const [height, setHeight] = useState(defaultHeight)

  // When fillToBottom is requested, measure the panel's top and fill to viewport bottom
  useEffect(() => {
    if (!fillToBottom) return
    function updateHeight() {
      const el = panelRef.current
      if (!el) return
      const top = el.getBoundingClientRect().top
      setHeight(Math.max(120, window.innerHeight - top - bottomPadding))
    }
    updateHeight()
    window.addEventListener('resize', updateHeight)
    // Also run once more after a short delay to handle Collapse animation
    const t = setTimeout(updateHeight, 150)
    return () => { window.removeEventListener('resize', updateHeight); clearTimeout(t) }
  }, [fillToBottom, bottomPadding])

  // Unique steps for filter
  const steps = useMemo(() => {
    const s = new Set<string>()
    for (const l of logs) if (l.step) s.add(l.step)
    return [...s].sort()
  }, [logs])

  // Filtered rows
  const filtered = useMemo(() => logs.filter(l => {
    if (levelFilter.size > 0 && !levelFilter.has((l.level ?? '').toUpperCase())) return false
    if (stepFilter && l.step !== stepFilter) return false
    if (search) {
      const q = search.toLowerCase()
      if (!l.message?.toLowerCase().includes(q) &&
          !l.step?.toLowerCase().includes(q)) return false
    }
    return true
  }), [logs, levelFilter, stepFilter, search])

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [filtered, autoScroll])

  // Detect user scroll away from bottom → pause auto-scroll
  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (autoScroll && !atBottom) setAutoScroll(false)
    if (!autoScroll && atBottom && live) setAutoScroll(true)
  }

  // Resize handle drag (handle is at the BOTTOM, drag down = taller)
  function onDragStart(e: React.MouseEvent) {
    const startY = e.clientY
    const startH = height
    e.preventDefault()
    function onMove(ev: MouseEvent) {
      const delta = ev.clientY - startY
      setHeight(Math.max(80, Math.min(700, startH + delta)))
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function toggleLevel(lvl: string) {
    setLevelFilter(prev => {
      const next = new Set(prev)
      if (next.has(lvl)) next.delete(lvl)
      else next.add(lvl)
      return next
    })
  }

  function copyAll() {
    const text = filtered.map(l =>
      `${fmtTimestamp(l.timestamp)} [${l.level}]${l.step ? ' [' + l.step + ']' : ''} ${l.message}`
    ).join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const isDark = theme.palette.mode === 'dark'
  const panelBg = isDark ? '#0d1117' : '#f6f8fa'
  const borderColor = isDark ? '#30363d' : '#d0d7de'

  return (
    <Box ref={panelRef} sx={{ display: 'flex', flexDirection: 'column', borderTop: `1px solid ${borderColor}` }}>
      {/* ── Toolbar ── */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.5,
        bgcolor: isDark ? '#161b22' : '#f0f3f6',
        borderBottom: `1px solid ${borderColor}`,
        flexShrink: 0, flexWrap: 'wrap',
      }}>
        <Typography variant="caption" color="text.secondary"
          sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', mr: 0.5 }}
        >
          Logs
        </Typography>
        <Typography variant="caption" color="text.disabled" sx={{ mr: 1 }}>
          {filtered.length}/{logs.length}
        </Typography>

        {/* Level filter chips */}
        <Box sx={{ display: 'flex', gap: 0.4 }}>
          {LOG_LEVELS.map(lvl => {
            const active = levelFilter.has(lvl)
            const c = LEVEL_COLOR[lvl]
            return (
              <Chip key={lvl} label={lvl} size="small"
                onClick={() => toggleLevel(lvl)}
                variant={active ? 'filled' : 'outlined'}
                sx={{
                  height: 18, fontSize: '0.6rem', fontWeight: 700,
                  cursor: 'pointer',
                  bgcolor: active ? alpha(c, 0.2) : 'transparent',
                  color: active ? c : 'text.disabled',
                  borderColor: active ? alpha(c, 0.5) : alpha(borderColor, 0.8),
                  '&:hover': { bgcolor: alpha(c, 0.15) },
                  '.MuiChip-label': { px: 0.75 },
                }}
              />
            )
          })}
        </Box>

        {/* Step filter */}
        {steps.length > 0 && (
          <TextField select size="small" value={stepFilter} onChange={e => setStepFilter(e.target.value)}
            sx={{
              minWidth: 100, maxWidth: 160,
              '& .MuiInputBase-root': { height: 22, fontSize: '0.72rem' },
              '& .MuiOutlinedInput-notchedOutline': { borderColor },
            }}>
            <MenuItem value="">All steps</MenuItem>
            {steps.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
          </TextField>
        )}

        {/* Search */}
        <TextField
          size="small"
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: <InputAdornment position="start"><Search sx={{ fontSize: 13, color: 'text.disabled' }} /></InputAdornment>,
              endAdornment: search ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setSearch('')} sx={{ p: 0.2 }}>
                    <Close sx={{ fontSize: 12 }} />
                  </IconButton>
                </InputAdornment>
              ) : null,
            },
          }}
          sx={{
            flex: 1, minWidth: 120, maxWidth: 240,
            '& .MuiInputBase-root': { height: 22, fontSize: '0.72rem' },
            '& .MuiOutlinedInput-notchedOutline': { borderColor },
          }}
        />

        <Box sx={{ flex: 1 }} />

        {/* Copy all */}
        <Tooltip title={copied ? 'Copied!' : 'Copy visible logs'}>
          <IconButton size="small" onClick={copyAll} sx={{ p: 0.4 }}>
            {copied ? <Done sx={{ fontSize: 13, color: '#3fb950' }} /> : <ContentCopy sx={{ fontSize: 13 }} />}
          </IconButton>
        </Tooltip>

        {/* Jump to bottom */}
        {live && (
          <Tooltip title={autoScroll ? 'Auto-scroll on' : 'Jump to bottom'}>
            <IconButton size="small" onClick={() => {
              setAutoScroll(true)
              if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
            }} sx={{ p: 0.4, color: autoScroll ? '#58a6ff' : 'text.disabled' }}>
              <ArrowDownward sx={{ fontSize: 13 }} />
            </IconButton>
          </Tooltip>
        )}

        {/* Active filter indicator */}
        {(levelFilter.size > 0 || stepFilter || search) && (
          <Tooltip title="Clear all filters">
            <IconButton size="small" onClick={() => { setLevelFilter(new Set()); setStepFilter(''); setSearch('') }} sx={{ p: 0.4 }}>
              <FilterList sx={{ fontSize: 13, color: '#e3b341' }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {/* ── Log rows ── */}
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        sx={{
          height, overflowY: 'auto', bgcolor: panelBg,
          fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
          fontSize: '0.73rem', lineHeight: 1.55,
        }}
      >
        {filtered.length === 0 ? (
          <Box sx={{ p: 2, color: 'text.disabled', textAlign: 'center' }}>
            {logs.length === 0 ? 'No logs yet' : 'No logs match the current filters'}
          </Box>
        ) : filtered.map((log, i) => {
          const lvl = (log.level ?? 'INFO').toUpperCase()
          const color = LEVEL_COLOR[lvl] ?? '#6e7681'
          const bg = LEVEL_BG[lvl] ?? 'transparent'
          return (
            <Box key={i} sx={{
              display: 'grid',
              gridTemplateColumns: '76px 52px auto 1fr',
              gap: '0 8px',
              px: 1.5, py: '1px',
              bgcolor: bg,
              '&:hover': { bgcolor: isDark ? alpha('#ffffff', 0.04) : alpha('#000000', 0.03) },
              borderBottom: `1px solid ${alpha(borderColor, 0.35)}`,
            }}>
              {/* Timestamp */}
              <Typography component="span" noWrap
                sx={{ color: 'text.disabled', fontSize: 'inherit', fontFamily: 'inherit', lineHeight: 'inherit' }}>
                {fmtTimestamp(log.timestamp)}
              </Typography>
              {/* Level */}
              <Typography component="span"
                sx={{ color, fontWeight: 700, fontSize: 'inherit', fontFamily: 'inherit', lineHeight: 'inherit' }}>
                {lvl}
              </Typography>
              {/* Step */}
              <Typography component="span" noWrap
                sx={{ color: alpha(color, 0.7), fontSize: 'inherit', fontFamily: 'inherit', lineHeight: 'inherit', maxWidth: 120 }}>
                {log.step || ''}
              </Typography>
              {/* Message */}
              <Typography component="span"
                sx={{ color: lvl === 'ERROR' || lvl === 'CRITICAL' ? '#f85149' : 'text.primary',
                  fontSize: 'inherit', fontFamily: 'inherit', lineHeight: 'inherit',
                  wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                {log.message}
              </Typography>
            </Box>
          )
        })}
      </Box>
      {/* ── Resize handle (at bottom — drag down to expand) ── */}
      <Box
        onMouseDown={onDragStart}
        sx={{
          height: 5, cursor: 'ns-resize', flexShrink: 0,
          bgcolor: isDark ? '#21262d' : '#e8ecf0',
          borderTop: `1px solid ${borderColor}`,
          '&:hover': { bgcolor: alpha('#58a6ff', 0.35) },
          transition: 'background 0.15s',
        }}
      />    </Box>
  )
}
