import { useState } from 'react'
import {
  Box, Typography, Button, TextField, MenuItem, FormControlLabel,
  Grid, Chip, Alert, Collapse,
  ToggleButton, ToggleButtonGroup, Radio, RadioGroup, FormControl,
  Autocomplete, Dialog, DialogTitle, DialogContent, DialogActions, IconButton,
} from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import {
  Storage, Code, ExpandMore, ExpandLess, Tune, LibraryBooks, Settings, Close, Dataset,
} from '@mui/icons-material'
import { ExtractConfig, Connection, SourceType, dictionariesApi, Dictionary, DwApplication } from '../api/client'
import DateField from './DateField'

const MONO = '"JetBrains Mono", "Fira Code", monospace'

// Shared font scale — keep these in sync with PipelineStudio.tsx
const FS_LABEL  = '0.75rem'  // section labels, helper annotations  (= MUI caption)
const FS_CHIP   = '0.72rem'  // chip labels, autocomplete tags
const FS_BTN    = '0.75rem'  // small utility buttons
const FS_TB     = '0.78rem'  // toggle-button text
const FS_CODE   = '0.8rem'   // mono code / SQL inputs

const DATE_VAR_FORMATS = ['YYYYMMDD', 'YYYY-MM-DD', 'YYYYMM', 'YYYY/MM/DD', 'DD/MM/YYYY', 'MM/DD/YYYY']
const DATE_RANGE_MODES = [
  { value: 'single', label: 'Single business date' },
  { value: 'current_month', label: 'Current month' },
  { value: 'previous_month', label: 'Previous month' },
  { value: 'custom', label: 'Custom date range' },
]

const SOURCE_LABELS: Record<SourceType, string> = {
  jdbc: 'Database',
  datawarehouse: 'Data Warehouse',
  grpc: 'gRPC',
}

const SOURCE_ICONS: Record<SourceType, React.ReactNode> = {
  jdbc: <Storage sx={{ fontSize: 15 }} />,
  datawarehouse: <Dataset sx={{ fontSize: 15 }} />,
  grpc: <Code sx={{ fontSize: 15 }} />,
}

interface SqlFile { id: number; name: string }

interface Props {
  config: ExtractConfig
  onChange: (key: keyof ExtractConfig, val: unknown) => void
  sqlFiles?: SqlFile[]
  connections?: Connection[]
  onPreview?: () => void
}

// ─── AppIdChips ───────────────────────────────────────────────────────────────

// ─── DwAppChips ───────────────────────────────────────────────────────────────
// Autocomplete-backed chip field for DW applications.
// Shows dictionary matches as you type; free-text entry also supported.
// ⚙ button opens the mapping config modal.

function DwAppChips({
  value, onChange,
  dictId, nameField,
  onDictChange, onNameFieldChange,
}: {
  value: DwApplication[]
  onChange: (apps: DwApplication[]) => void
  dictId: number | ''
  nameField: 'key' | 'value'
  onDictChange: (id: number | '') => void
  onNameFieldChange: (f: 'key' | 'value') => void
}) {
  const [modalOpen, setModalOpen] = useState(false)

  const { data: dicts = [] } = useQuery<Dictionary[]>({
    queryKey: ['dictionaries'],
    queryFn: () => dictionariesApi.list().then((r) => r.data),
  })

  const dict = dicts.find((d) => d.id === dictId) ?? null
  // nameField='value' (default): key→$app_id, value→$app_name
  const getName = (e: { key: string; value: string }) => nameField === 'key' ? e.key : e.value
  const getId   = (e: { key: string; value: string }) => nameField === 'key' ? e.value : e.key

  const currentIds = new Set(value.map((a) => a.id))
  const options: DwApplication[] = (dict?.entries ?? [])
    .filter((e) => !currentIds.has(getId(e)))
    .map((e) => ({ name: getName(e), id: getId(e) }))

  return (
    <>
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-start' }}>
        <Autocomplete<DwApplication, true, false, true>
          multiple
          freeSolo
          size="small"
          options={options}
          value={value}
          sx={{ flex: 1 }}
          getOptionLabel={(opt) =>
            typeof opt === 'string' ? opt : (opt.name ? `${opt.name} (${opt.id})` : opt.id)
          }
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          filterOptions={(opts, state) => {
            const q = state.inputValue.toLowerCase()
            if (!q) return opts
            return opts.filter((o) =>
              o.id.toLowerCase().includes(q) || o.name.toLowerCase().includes(q)
            )
          }}
          onChange={(_, newValue) => {
            const apps: DwApplication[] = newValue.map((v) =>
              typeof v === 'string' ? { name: '', id: v.trim() } : v
            ).filter((a) => a.id)
            // deduplicate by id
            const seen = new Set<string>()
            onChange(apps.filter((a) => seen.has(a.id) ? false : (seen.add(a.id), true)))
          }}
          renderTags={(tags, getTagProps) =>
            tags.map((tag, i) => {
              const app = typeof tag === 'string' ? { name: '', id: tag } : tag
              return (
                <Chip
                  {...getTagProps({ index: i })}
                  key={app.id}
                  label={
                    app.name
                      ? <><span>{app.name}</span><span style={{ opacity: 0.45, marginLeft: 5, fontFamily: MONO, fontSize: FS_CHIP }}>{app.id}</span></>
                      : app.id
                  }
                  size="small"
                  sx={{ fontFamily: MONO, fontSize: FS_CHIP, height: 22 }}
                />
              )
            })
          }
          renderOption={(props, opt) => (
            <Box component="li" {...props}>
              <Box sx={{ flex: 1 }}>{opt.name}</Box>
              <Typography variant="caption" color="text.disabled" sx={{ fontFamily: MONO, ml: 1 }}>{opt.id}</Typography>
            </Box>
          )}
          renderInput={(params) => (
            <TextField
              {...params}
              size="small"
              placeholder={value.length === 0 ? 'Search or type an ID…' : 'Add another…'}
            />
          )}
        />
        <IconButton
          size="small"
          onClick={() => setModalOpen(true)}
          sx={{ mt: 0.25, color: 'text.secondary', flexShrink: 0 }}
          title="Configure mapping"
        >
          <Settings sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      <DwMappingModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        currentApps={value}
        onAdd={(apps) => onChange([...value, ...apps.filter((a) => !currentIds.has(a.id))])}
        onRemove={(id) => onChange(value.filter((a) => a.id !== id))}
        dictId={dictId}
        nameField={nameField}
        onDictChange={onDictChange}
        onNameFieldChange={onNameFieldChange}
      />
    </>
  )
}

// ─── DwMappingModal ────────────────────────────────────────────────────────────
// Dialog containing the dictionary picker + search + manual entry for DW apps.

function DwMappingModal({
  open, onClose,
  currentApps, onAdd, onRemove,
  dictId, nameField,
  onDictChange, onNameFieldChange,
}: {
  open: boolean
  onClose: () => void
  currentApps: DwApplication[]
  onAdd: (apps: DwApplication[]) => void
  onRemove: (id: string) => void
  dictId: number | ''
  nameField: 'key' | 'value'
  onDictChange: (id: number | '') => void
  onNameFieldChange: (f: 'key' | 'value') => void
}) {
  const [selected, setSelected] = useState<{ key: string; value: string }[]>([])
  const [showManual, setShowManual] = useState(false)
  const [manualName, setManualName] = useState('')
  const [manualId, setManualId] = useState('')

  const { data: dicts = [] } = useQuery<Dictionary[]>({
    queryKey: ['dictionaries'],
    queryFn: () => dictionariesApi.list().then((r) => r.data),
  })

  const dict = dicts.find((d) => d.id === dictId) ?? null
  const getName = (e: { key: string; value: string }) => nameField === 'key' ? e.key : e.value
  const getId   = (e: { key: string; value: string }) => nameField === 'key' ? e.value : e.key
  const currentIds = currentApps.map((a) => a.id)
  const options = (dict?.entries ?? []).filter((e) => !currentIds.includes(getId(e)))

  const addManual = () => {
    const name = manualName.trim()
    const id = manualId.trim()
    if (!name || !id || currentIds.includes(id)) return
    onAdd([{ name, id }])
    setManualName('')
    setManualId('')
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
        <Settings fontSize="small" />
        Configure Application Mapping
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={onClose}><Close fontSize="small" /></IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ pt: '16px !important' }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>

          {/* Current apps */}
          {currentApps.length > 0 && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {currentApps.map((app) => (
                <Chip
                  key={app.id}
                  label={<><span>{app.name}</span><span style={{ opacity: 0.45, marginLeft: 5, fontFamily: MONO, fontSize: FS_CHIP }}>{app.id}</span></>}
                  size="small"
                  onDelete={() => onRemove(app.id)}
                  sx={{ height: 22, fontSize: FS_CHIP }}
                />
              ))}
            </Box>
          )}

          {/* Dictionary + Name column */}
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <TextField
              select size="small" label="Dictionary"
              value={dictId}
              sx={{ flex: '1 1 130px', minWidth: 130 }}
              onChange={(e) => {
                onDictChange(e.target.value ? parseInt(String(e.target.value)) : '')
                setSelected([])
              }}
            >
              <MenuItem value="">— select —</MenuItem>
              {dicts.map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
            </TextField>
            {dict && (() => {
              const sample = dict.entries[0]
              const sampleId  = sample ? (nameField === 'value' ? sample.key   : sample.value) : null
              const sampleName = sample ? (nameField === 'value' ? sample.value : sample.key)   : null
              return (
                <TextField
                  select size="small" label="Column mapping"
                  value={nameField}
                  sx={{ flex: '1 1 230px', minWidth: 230 }}
                  helperText={sample ? `$app_id = "${sampleId}" · $app_name = "${sampleName}"` : 'Select a dictionary first'}
                  onChange={(e) => { onNameFieldChange(e.target.value as 'key' | 'value'); setSelected([]) }}
                >
                  <MenuItem value="value">{dict.key_label} → $app_id · {dict.value_label} → $app_name</MenuItem>
                  <MenuItem value="key">{dict.value_label} → $app_id · {dict.key_label} → $app_name</MenuItem>
                </TextField>
              )
            })()}
          </Box>

          {/* Search & pick */}
          {dict ? (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Autocomplete
                  multiple size="small"
                  options={options}
                  getOptionLabel={getName}
                  filterOptions={(opts, state) => {
                    const q = state.inputValue.toLowerCase()
                    if (!q) return opts
                    return opts.filter((o) =>
                      o.key.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
                    )
                  }}
                  value={selected}
                  onChange={(_, v) => setSelected(v)}
                  isOptionEqualToValue={(a, b) => a.key === b.key && a.value === b.value}
                  renderInput={(params) => (
                    <TextField {...params} size="small" placeholder="Search & select entries…" />
                  )}
                  renderOption={(props, o) => (
                    <Box component="li" {...props}>
                      <Box sx={{ flex: 1 }}>{getName(o)}</Box>
                      <Typography variant="caption" color="text.disabled" sx={{ fontFamily: MONO, ml: 1 }}>{getId(o)}</Typography>
                    </Box>
                  )}
                  renderTags={(tags, getTagProps) =>
                    tags.map((tag, i) => (
                      <Chip {...getTagProps({ index: i })} key={`${tag.key}${tag.value}`} label={getName(tag)}
                        size="small" sx={{ height: 20, fontSize: FS_CHIP }} />
                    ))
                  }
                />
              </Box>
              <Button
                size="small" variant="contained" disableElevation
                disabled={selected.length === 0}
                sx={{ flexShrink: 0, alignSelf: 'flex-start', mt: 0.125 }}
                onClick={() => { onAdd(selected.map((s) => ({ name: getName(s), id: getId(s) }))); setSelected([]) }}
              >
                Add{selected.length > 0 ? ` ${selected.length}` : ''}
              </Button>
            </Box>
          ) : (
            /* No dict — show manual entry as primary */
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
              <TextField size="small" placeholder="App name" value={manualName} sx={{ flex: 1, minWidth: 0 }}
                onChange={(e) => setManualName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addManual() }} />
              <TextField size="small" placeholder="APP001" value={manualId} sx={{ flex: 1, minWidth: 0 }}
                inputProps={{ style: { fontFamily: MONO } }}
                onChange={(e) => setManualId(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addManual() }} />
              <Button size="small" variant="outlined" sx={{ flexShrink: 0 }}
                disabled={!manualName.trim() || !manualId.trim()} onClick={addManual}>Add</Button>
            </Box>
          )}

          {/* Manual entry toggle (when dict selected) */}
          {dict && (
            <Box>
              <Button size="small" variant="text"
                onClick={() => setShowManual((v) => !v)}
                sx={{ color: 'text.disabled', fontSize: FS_BTN, textTransform: 'none', px: 0, minWidth: 0 }}>
                {showManual ? '− cancel' : '+ add manually'}
              </Button>
              <Collapse in={showManual}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mt: 0.75 }}>
                  <TextField size="small" placeholder="App name" value={manualName} sx={{ flex: 1, minWidth: 0 }}
                    onChange={(e) => setManualName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addManual() }} />
                  <TextField size="small" placeholder="APP001" value={manualId} sx={{ flex: 1, minWidth: 0 }}
                    inputProps={{ style: { fontFamily: MONO } }}
                    onChange={(e) => setManualId(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addManual() }} />
                  <Button size="small" variant="outlined" sx={{ flexShrink: 0 }}
                    disabled={!manualName.trim() || !manualId.trim()} onClick={addManual}>Add</Button>
                </Box>
              </Collapse>
            </Box>
          )}

        </Box>
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── DictAppPicker ────────────────────────────────────────────────────────────
// Let the user pick entries from a dictionary and add their values as app IDs.

function DictAppPicker({ currentIds, onAdd }: {
  currentIds: string[]
  onAdd: (ids: string[]) => void
}) {
  const [dictId, setDictId] = useState<number | ''>('')
  const [selected, setSelected] = useState<{ key: string; value: string }[]>([])
  const [useValue, setUseValue] = useState(true) // true = use value (ID), false = use key (name)

  const { data: dicts = [] } = useQuery<Dictionary[]>({
    queryKey: ['dictionaries'],
    queryFn: () => dictionariesApi.list().then((r) => r.data),
  })

  const dict = dicts.find((d) => d.id === dictId) ?? null
  const pick = (e: { key: string; value: string }) => useValue ? e.value : e.key
  // Options = entries not already in the chip list
  const options = (dict?.entries ?? []).filter((e) => !currentIds.includes(pick(e)))

  if (dicts.length === 0) return null

  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap', mt: 0.75 }}>
      <LibraryBooks sx={{ fontSize: 15, color: 'text.disabled', mt: 1 }} />
      <TextField
        select
        size="small"
        label="Dictionary"
        value={dictId}
        onChange={(e) => { setDictId(e.target.value ? parseInt(String(e.target.value)) : ''); setSelected([]) }}
        sx={{ minWidth: 170 }}
      >
        <MenuItem value="">— Select —</MenuItem>
        {dicts.map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
      </TextField>

      {dict && (
        <>
          <TextField
            select size="small" label="Use field"
            value={useValue ? 'value' : 'key'}
            onChange={(e) => { setUseValue(e.target.value === 'value'); setSelected([]) }}
            sx={{ minWidth: 130 }}
            helperText={useValue ? dict.value_label : dict.key_label}
          >
            <MenuItem value="value">{dict.value_label}</MenuItem>
            <MenuItem value="key">{dict.key_label}</MenuItem>
          </TextField>

          <Autocomplete
            multiple
            size="small"
            options={options}
            getOptionLabel={(o) => useValue ? o.key : o.value}
            filterOptions={(opts, state) => {
              const q = state.inputValue.toLowerCase()
              if (!q) return opts
              return opts.filter((o) =>
                o.key.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
              )
            }}
            value={selected}
            onChange={(_, v) => setSelected(v)}
            renderInput={(params) => (
              <TextField {...params} label={`Pick ${useValue ? dict.key_label : dict.value_label}`} placeholder="Search…" sx={{ minWidth: 240 }} />
            )}
            renderOption={(props, o) => (
              <Box component="li" {...props}>
                <Box sx={{ flex: 1 }}>{useValue ? o.key : o.value}</Box>
                <Typography variant="caption" color="text.disabled" sx={{ fontFamily: MONO, ml: 1 }}>{useValue ? o.value : o.key}</Typography>
              </Box>
            )}
            renderTags={(tags, getTagProps) =>
              tags.map((tag, i) => (
                <Chip {...getTagProps({ index: i })} key={`${tag.key}:${tag.value}`}
                  label={
                    <><span>{useValue ? tag.key : tag.value}</span><span style={{ opacity: 0.55, marginLeft: 4, fontFamily: MONO }}>{useValue ? tag.value : tag.key}</span></>
                  }
                  size="small" sx={{ height: 22, fontSize: FS_CHIP }} />
              ))
            }
          />
          <Button
            size="small" variant="outlined"
            disabled={selected.length === 0}
            onClick={() => {
              onAdd(selected.map(pick))
              setSelected([])
            }}
          >
            Add
          </Button>
        </>
      )}
    </Box>
  )
}

// ─── DictImportModal ─────────────────────────────────────────────────────────
// Dialog wrapper around DictAppPicker — used by JDBC and gRPC tabs.

function DictImportModal({ open, onClose, currentIds, onAdd }: {
  open: boolean
  onClose: () => void
  currentIds: string[]
  onAdd: (ids: string[]) => void
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
        <LibraryBooks fontSize="small" />
        Import from Dictionary
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={onClose}><Close fontSize="small" /></IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ pt: '16px !important' }}>
        <DictAppPicker currentIds={currentIds} onAdd={onAdd} />
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── AppIdChips ───────────────────────────────────────────────────────────────

function AppIdChips({ value, onChange, placeholder, onImportClick }: {
  value: string[]
  onChange: (ids: string[]) => void
  placeholder?: string
  onImportClick?: () => void
}) {
  const [input, setInput] = useState('')

  const commit = (raw: string) => {
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
    onChange([...new Set([...value, ...ids])])
    setInput('')
  }

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center', minHeight: 36,
      border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 0.5, cursor: 'text' }}
      onClick={(e) => (e.currentTarget.querySelector('input') as HTMLElement | null)?.focus()}
    >
      {value.map((id) => (
        <Chip key={id} label={id} size="small" onDelete={() => onChange(value.filter((v) => v !== id))}
          sx={{ fontFamily: MONO, fontSize: FS_CHIP, height: 22 }} />
      ))}
      <Box
        component="input"
        placeholder={value.length === 0 ? (placeholder ?? 'Type an ID and press Enter') : 'Add another…'}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ',') && input.trim()) { e.preventDefault(); commit(input) }
          if (e.key === 'Backspace' && !input && value.length) onChange(value.slice(0, -1))
        }}
        onBlur={() => { if (input.trim()) commit(input) }}
        sx={{
          border: 'none', outline: 'none', background: 'transparent', fontSize: FS_CODE,
          color: 'text.primary', minWidth: 140, flex: 1, py: 0.25, px: 0.5,
          fontFamily: MONO,
          '&::placeholder': { color: 'text.disabled', fontFamily: 'inherit' },
        }}
      />
      {onImportClick && (
        <IconButton
          size="small"
          onClick={(e) => { e.stopPropagation(); onImportClick() }}
          sx={{ ml: 'auto', color: 'text.secondary', flexShrink: 0 }}
          title="Import from dictionary"
        >
          <Settings sx={{ fontSize: 16 }} />
        </IconButton>
      )}
    </Box>
  )
}

// ─── AppIdChipsWithImport ─────────────────────────────────────────────────────
// AppIdChips with a built-in dict-import Settings button + modal.

function AppIdChipsWithImport({ value, onChange, placeholder }: {
  value: string[]
  onChange: (ids: string[]) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <AppIdChips
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        onImportClick={() => setOpen(true)}
      />
      <DictImportModal
        open={open}
        onClose={() => setOpen(false)}
        currentIds={value}
        onAdd={(ids) => onChange([...new Set([...value, ...ids])])}
      />
    </>
  )
}

// ─── MoreOptions ──────────────────────────────────────────────────────────────

function MoreOptions({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Box sx={{ mt: 1.5 }}>
      <Button size="small" variant="text" color="inherit"
        startIcon={open ? <ExpandLess sx={{ fontSize: 15 }} /> : <ExpandMore sx={{ fontSize: 15 }} />}
        endIcon={<Tune sx={{ fontSize: 15 }} />}
        onClick={() => setOpen((v) => !v)}
        sx={{ color: 'text.secondary', fontSize: FS_BTN, px: 0, textTransform: 'none' }}>
        {open ? 'Fewer options' : 'More options'}
      </Button>
      <Collapse in={open}>
        <Box sx={{ mt: 1.5, pl: 0 }}>
          {children}
        </Box>
      </Collapse>
    </Box>
  )
}

// ─── ExtractConfigWizard ──────────────────────────────────────────────────────

export default function ExtractConfigWizard({ config, onChange, sqlFiles = [], connections = [], onPreview }: Props) {
  const source = (config.source_type ?? 'datawarehouse') as SourceType

  // Date mode: 'platform' = use platform business date (default), 'custom' = show date pickers
  const hasCustomDates = !!(config.date_from || config.date_to)
  const [dateMode, setDateMode] = useState<'platform' | 'custom'>(hasCustomDates ? 'custom' : 'platform')

  const jdbcConnections = connections.filter((c) => c.conn_type === 'jdbc')
  const selectedConn = jdbcConnections.find((c) => c.id === config.jdbc_connection_id)

  const dwConnections = connections.filter((c) => c.conn_type === 'datawarehouse')
  const selectedDwConn = dwConnections.find((c) => c.id === config.dw_connection_id)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>

      {/* ── Source type ── */}
      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.75, display: 'block', fontWeight: 500 }}>
          Source type
        </Typography>
        <ToggleButtonGroup
          value={source}
          exclusive
          size="small"
          onChange={(_, v) => {
            if (!v) return
            onChange('source_type', v)
          }}
        >
          {(['datawarehouse', 'jdbc', 'grpc'] as SourceType[]).map((s) => (
            <ToggleButton key={s} value={s} sx={{ fontSize: FS_TB, px: 1.5, gap: 0.5 }}>
              {SOURCE_ICONS[s]}
              {SOURCE_LABELS[s]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      {/* ── Job name (output directory label) ── */}
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-end' }}>
        <TextField
          label="Job name"
          value={config.job_name ?? ''}
          size="small"
          sx={{ flex: '0 1 260px' }}
          placeholder="Auto-derived from pipeline name"
          helperText={
            config.job_name?.trim()
              ? `Output path: <date>/${config.job_name.trim()}/<app_id>/`
              : 'Leave blank to auto-derive from pipeline name'
          }
          InputProps={{ sx: { fontFamily: MONO, fontSize: FS_CODE } }}
          onChange={(e) => onChange('job_name', e.target.value || undefined)}
        />
      </Box>

      {/* ══════════ JDBC ══════════ */}
      {source === 'jdbc' && (
        <>
          {/* Connection + SQL side by side */}
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <Box sx={{ flex: '1 1 220px', minWidth: 0 }}>
              {jdbcConnections.length > 0 ? (
                <TextField
                  select label="Connection"
                  value={config.jdbc_connection_id ?? ''}
                  fullWidth size="small"
                  helperText={selectedConn?.description ?? 'Select a saved database connection'}
                  onChange={(e) => {
                    const id = e.target.value ? parseInt(String(e.target.value)) : undefined
                    onChange('jdbc_connection_id', id)
                    if (id) onChange('jdbc_url', undefined)
                  }}
                >
                  <MenuItem value="">— Select a connection —</MenuItem>
                  {jdbcConnections.map((c) => (
                    <MenuItem key={c.id} value={c.id}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Storage sx={{ fontSize: 14, color: 'text.secondary' }} />
                        {c.name}
                      </Box>
                    </MenuItem>
                  ))}
                </TextField>
              ) : (
                <Alert severity="info" icon={false} sx={{ py: 0.5, fontSize: FS_LABEL }}>
                  No database connections saved yet.{' '}
                  <strong>Go to Connections to add one</strong>, or enter a URL in "More options" below.
                </Alert>
              )}
            </Box>
            <Box sx={{ flex: '1 1 220px', minWidth: 0 }}>
              <TextField
                select label="SQL query"
                value={config.jdbc_sql_file_id ?? ''}
                fullWidth size="small"
                helperText={sqlFiles.length === 0 ? 'No extract SQL files found — create one in SQL Files' : 'Saved SQL query to run'}
                onChange={(e) => {
                  const id = e.target.value ? parseInt(String(e.target.value)) : undefined
                  onChange('jdbc_sql_file_id', id)
                  if (id) { onChange('jdbc_sql', undefined); onChange('jdbc_table', undefined) }
                }}
              >
                <MenuItem value="">— Select a SQL file —</MenuItem>
                {sqlFiles.map((f) => <MenuItem key={f.id} value={f.id}>{f.name}</MenuItem>)}
              </TextField>
            </Box>
          </Box>

          {/* Applications */}
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block', fontWeight: 500 }}>
              Applications{' '}
              <Typography component="span" variant="caption" color="text.disabled">— optional · injects $app_name / $app_id</Typography>
            </Typography>
            <DwAppChips
              value={config.apps ?? []}
              onChange={(apps) => onChange('apps', apps)}
              dictId={config.dw_dict_id ?? ''}
              nameField={(config.dw_dict_name_field as 'key' | 'value') ?? 'value'}
              onDictChange={(id) => onChange('dw_dict_id', id || undefined)}
              onNameFieldChange={(f) => onChange('dw_dict_name_field', f)}
            />
          </Box>

          {/* Business date */}
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <Box sx={{ flex: '1 1 180px', minWidth: 0 }}>
              <TextField
                select label="Business date" value={dateMode} fullWidth size="small"
                helperText={dateMode === 'platform' ? 'Uses system execution date' : 'Override with specific range'}
                onChange={(e) => {
                  const v = e.target.value as 'platform' | 'custom'
                  setDateMode(v)
                  if (v === 'platform') { onChange('date_from', undefined); onChange('date_to', undefined) }
                }}
              >
                <MenuItem value="platform">Use execution date</MenuItem>
                <MenuItem value="custom">Custom range</MenuItem>
              </TextField>
            </Box>
            {dateMode === 'custom' && (
              <>
                <Box sx={{ flex: '1 1 130px', minWidth: 0 }}>
                  <DateField label="From" value={config.date_from ?? ''} fullWidth onChange={(v) => onChange('date_from', v)} />
                </Box>
                <Box sx={{ flex: '1 1 130px', minWidth: 0 }}>
                  <DateField label="To" value={config.date_to ?? ''} fullWidth onChange={(v) => onChange('date_to', v)} />
                </Box>
              </>
            )}
          </Box>

          {/* More options */}
          <MoreOptions>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  select label="Date format in SQL"
                  value={config.jdbc_date_var_format ?? 'YYYYMMDD'}
                  fullWidth size="small"
                  helperText="How $business_date is formatted when injected into the query"
                  onChange={(e) => onChange('jdbc_date_var_format', e.target.value)}
                >
                  {DATE_VAR_FORMATS.map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
                </TextField>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  select label="Date range mode"
                  value={config.jdbc_date_range_mode ?? 'single'}
                  fullWidth size="small"
                  helperText="Controls $business_date_range variable"
                  onChange={(e) => onChange('jdbc_date_range_mode', e.target.value)}
                >
                  {DATE_RANGE_MODES.map((m) => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
                </TextField>
              </Grid>
              {config.jdbc_date_range_mode === 'custom' && (
                <>
                  <Grid item xs={12} sm={6}>
                    <DateField label="Range start" value={config.jdbc_date_range_from ?? ''} fullWidth onChange={(v) => onChange('jdbc_date_range_from', v)} />
                  </Grid>
                  <Grid item xs={12} sm={6}>
                    <DateField label="Range end" value={config.jdbc_date_range_to ?? ''} fullWidth onChange={(v) => onChange('jdbc_date_range_to', v)} />
                  </Grid>
                </>
              )}
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Date column (optional)"
                  value={config.jdbc_date_column ?? ''}
                  fullWidth size="small"
                  placeholder="business_date"
                  helperText="Column used for date-based row filtering (adds WHERE clause)"
                  onChange={(e) => onChange('jdbc_date_column', e.target.value)}
                />
              </Grid>
              <Grid item xs={12}>
                <TextField
                  label="Write SQL directly"
                  value={config.jdbc_sql ?? ''}
                  fullWidth size="small"
                  multiline rows={4}
                  placeholder={'SELECT *\nFROM transactions\nWHERE date = $business_date'}
                  helperText="Use this instead of a SQL file (overrides file selection above)"
                  InputProps={{ sx: { fontFamily: MONO, fontSize: FS_CODE } }}
                  onChange={(e) => {
                    onChange('jdbc_sql', e.target.value)
                    if (e.target.value) onChange('jdbc_sql_file_id', undefined)
                  }}
                />
              </Grid>
              <Grid item xs={12}>
                <TextField
                  label="Custom connection URL"
                  value={config.jdbc_url ?? ''}
                  fullWidth size="small"
                  placeholder="postgresql://user:password@host:5432/database"
                  helperText="Overrides the connection selected above — use for one-off connections"
                  InputProps={{ sx: { fontFamily: MONO, fontSize: FS_CODE } }}
                  onChange={(e) => {
                    onChange('jdbc_url', e.target.value)
                    if (e.target.value) onChange('jdbc_connection_id', undefined)
                  }}
                />
              </Grid>
              <Grid item xs={6}>
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block', fontWeight: 500 }}>Output format</Typography>
                  <ToggleButtonGroup value={config.output_format ?? 'parquet'} exclusive size="small"
                    onChange={(_, v) => { if (v) onChange('output_format', v) }}>
                    <ToggleButton value="parquet" sx={{ fontSize: FS_TB, px: 1.5 }}>Parquet</ToggleButton>
                    <ToggleButton value="csv" sx={{ fontSize: FS_TB, px: 1.5 }}>CSV</ToggleButton>
                  </ToggleButtonGroup>
                </Box>
              </Grid>
              <Grid item xs={6}>
                <TextField
                  label="Max rows per output file"
                  type="number"
                  value={config.rows_per_segment ?? 100000}
                  fullWidth size="small"
                  InputProps={{ inputProps: { min: 1000 } }}
                  onChange={(e) => onChange('rows_per_segment', parseInt(e.target.value))}
                />
              </Grid>
            </Grid>
          </MoreOptions>
          {onPreview && (
            <Box>
              <Button size="small" variant="outlined" onClick={onPreview}
                disabled={!config.jdbc_sql_file_id && !config.jdbc_sql?.trim() && !config.jdbc_table?.trim()}>
                Preview SQL with variables
              </Button>
            </Box>
          )}
        </>
      )}

      {/* ══════════ DataWarehouse ══════════ */}
      {source === 'datawarehouse' && (
        <>
          {/* Connection + SQL side by side */}
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <Box sx={{ flex: '1 1 220px', minWidth: 0 }}>
              {dwConnections.length > 0 ? (
                <TextField
                  select label="Connection"
                  value={config.dw_connection_id ?? ''}
                  fullWidth size="small"
                  helperText={selectedDwConn?.description ?? 'DataWarehouse connection'}
                  onChange={(e) => {
                    const id = e.target.value ? parseInt(String(e.target.value)) : undefined
                    onChange('dw_connection_id', id)
                  }}
                >
                  <MenuItem value="">— Select a connection —</MenuItem>
                  {dwConnections.map((c) => (
                    <MenuItem key={c.id} value={c.id}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Dataset sx={{ fontSize: 14, color: 'text.secondary' }} />
                        {c.name}
                      </Box>
                    </MenuItem>
                  ))}
                </TextField>
              ) : (
                <Alert severity="info" icon={false} sx={{ py: 0.5, fontSize: FS_LABEL }}>
                  No DataWarehouse connections saved yet.{' '}
                  <strong>Go to Settings → Connections to add one.</strong>
                </Alert>
              )}
            </Box>
            <Box sx={{ flex: '1 1 220px', minWidth: 0 }}>
              <TextField
                select label="SQL query"
                value={config.jdbc_sql_file_id ?? ''}
                fullWidth size="small"
                helperText={sqlFiles.length === 0 ? 'No extract SQL files — create one in SQL Files' : 'Saved SQL query to run'}
                onChange={(e) => {
                  const id = e.target.value ? parseInt(String(e.target.value)) : undefined
                  onChange('jdbc_sql_file_id', id)
                  if (id) onChange('jdbc_sql', undefined)
                }}
              >
                <MenuItem value="">— Select a SQL file —</MenuItem>
                {sqlFiles.map((f) => <MenuItem key={f.id} value={f.id}>{f.name}</MenuItem>)}
              </TextField>
            </Box>
          </Box>

          {/* Applications */}
          <Box>
            <Typography variant="caption" color="text.secondary" fontWeight={500} sx={{ display: 'block', mb: 0.5 }}>
              Applications{' '}
              <Typography component="span" variant="caption" color="text.disabled">— optional · injects $app_name / $app_id</Typography>
            </Typography>
            <DwAppChips
              value={config.apps ?? []}
              onChange={(apps) => onChange('apps', apps)}
              dictId={config.dw_dict_id ?? ''}
              nameField={(config.dw_dict_name_field as 'key' | 'value') ?? 'value'}
              onDictChange={(id) => onChange('dw_dict_id', id || undefined)}
              onNameFieldChange={(f) => onChange('dw_dict_name_field', f)}
            />
          </Box>

          {/* Business date + Preview inline */}
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <Box sx={{ flex: '1 1 180px', minWidth: 0 }}>
              <TextField
                select label="Business date" value={dateMode} fullWidth size="small"
                helperText={dateMode === 'platform' ? 'Uses system execution date' : 'Override with specific range'}
                onChange={(e) => {
                  const v = e.target.value as 'platform' | 'custom'
                  setDateMode(v)
                  if (v === 'platform') { onChange('date_from', undefined); onChange('date_to', undefined) }
                }}
              >
                <MenuItem value="platform">Use execution date</MenuItem>
                <MenuItem value="custom">Custom range</MenuItem>
              </TextField>
            </Box>
            {dateMode === 'custom' && (
              <>
                <Box sx={{ flex: '1 1 130px', minWidth: 0 }}>
                  <DateField label="From" value={config.date_from ?? ''} fullWidth onChange={(v) => onChange('date_from', v)} />
                </Box>
                <Box sx={{ flex: '1 1 130px', minWidth: 0 }}>
                  <DateField label="To" value={config.date_to ?? ''} fullWidth onChange={(v) => onChange('date_to', v)} />
                </Box>
              </>
            )}
          </Box>

          {/* More options */}
          <MoreOptions>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  select label="Date format in SQL"
                  value={config.jdbc_date_var_format ?? 'YYYYMMDD'}
                  fullWidth size="small"
                  helperText="How $business_date is formatted when injected into the query"
                  onChange={(e) => onChange('jdbc_date_var_format', e.target.value)}
                >
                  {DATE_VAR_FORMATS.map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
                </TextField>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  select label="Date range mode"
                  value={config.jdbc_date_range_mode ?? 'single'}
                  fullWidth size="small"
                  helperText="Controls $business_date_range variable"
                  onChange={(e) => onChange('jdbc_date_range_mode', e.target.value)}
                >
                  {DATE_RANGE_MODES.map((m) => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
                </TextField>
              </Grid>
              {config.jdbc_date_range_mode === 'custom' && (
                <>
                  <Grid item xs={12} sm={6}>
                    <DateField label="Range start" value={config.jdbc_date_range_from ?? ''} fullWidth onChange={(v) => onChange('jdbc_date_range_from', v)} />
                  </Grid>
                  <Grid item xs={12} sm={6}>
                    <DateField label="Range end" value={config.jdbc_date_range_to ?? ''} fullWidth onChange={(v) => onChange('jdbc_date_range_to', v)} />
                  </Grid>
                </>
              )}
              <Grid item xs={12}>
                <TextField
                  label="Write SQL directly"
                  value={config.jdbc_sql ?? ''}
                  fullWidth size="small"
                  multiline rows={4}
                  placeholder={'SELECT *\nFROM transactions\nWHERE date = $business_date'}
                  helperText="Use this instead of a SQL file (overrides file selection above)"
                  InputProps={{ sx: { fontFamily: MONO, fontSize: FS_CODE } }}
                  onChange={(e) => {
                    onChange('jdbc_sql', e.target.value)
                    if (e.target.value) onChange('jdbc_sql_file_id', undefined)
                  }}
                />
              </Grid>
              <Grid item xs={6}>
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block', fontWeight: 500 }}>Output format</Typography>
                  <ToggleButtonGroup value={config.output_format ?? 'parquet'} exclusive size="small"
                    onChange={(_, v) => { if (v) onChange('output_format', v) }}>
                    <ToggleButton value="parquet" sx={{ fontSize: FS_TB, px: 1.5 }}>Parquet</ToggleButton>
                    <ToggleButton value="csv" sx={{ fontSize: FS_TB, px: 1.5 }}>CSV</ToggleButton>
                  </ToggleButtonGroup>
                </Box>
              </Grid>
              <Grid item xs={6}>
                <TextField
                  label="Max rows per output file"
                  type="number"
                  value={config.rows_per_segment ?? 100000}
                  fullWidth size="small"
                  InputProps={{ inputProps: { min: 1000 } }}
                  onChange={(e) => onChange('rows_per_segment', parseInt(e.target.value))}
                />
              </Grid>
            </Grid>
          </MoreOptions>
          {onPreview && (
            <Box>
              <Button size="small" variant="outlined" onClick={onPreview}
                disabled={!config.jdbc_sql_file_id && !config.jdbc_sql?.trim()}>
                Preview SQL
              </Button>
            </Box>
          )}
        </>
      )}

      {/* ══════════ gRPC ══════════ */}
      {source === 'grpc' && (
        <>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block', fontWeight: 500 }}>
              Applications
              <Typography component="span" variant="caption" color="text.disabled"> — runs once per app · $app_id / $app_name</Typography>
            </Typography>
            <DwAppChips
              value={config.apps ?? []}
              onChange={(apps) => onChange('apps', apps)}
              dictId={config.dw_dict_id ?? ''}
              nameField={(config.dw_dict_name_field as 'key' | 'value') ?? 'value'}
              onDictChange={(id) => onChange('dw_dict_id', id || undefined)}
              onNameFieldChange={(f) => onChange('dw_dict_name_field', f)}
            />
          </Box>

          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block', fontWeight: 500 }}>Business date</Typography>
            <FormControl>
              <RadioGroup value={dateMode} onChange={(e) => {
                const v = e.target.value as 'platform' | 'custom'
                setDateMode(v)
                if (v === 'platform') { onChange('date_from', undefined); onChange('date_to', undefined) }
              }}>
                <FormControlLabel value="platform" control={<Radio size="small" />}
                  label={<Typography variant="body2">Use Execution Date <Typography component="span" variant="caption" color="text.secondary">(recommended)</Typography></Typography>} />
                <FormControlLabel value="custom" control={<Radio size="small" />}
                  label={<Typography variant="body2">Custom date range</Typography>} />
              </RadioGroup>
            </FormControl>
            <Collapse in={dateMode === 'custom'}>
              <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                <DateField label="From" value={config.date_from ?? ''} fullWidth onChange={(v) => onChange('date_from', v)} />
                <DateField label="To" value={config.date_to ?? ''} fullWidth onChange={(v) => onChange('date_to', v)} />
              </Box>
            </Collapse>
          </Box>

          <MoreOptions>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Batch size"
                  type="number"
                  value={config.page_size ?? 10000}
                  fullWidth size="small"
                  helperText="Records per API request (default 10,000 is usually fine)"
                  InputProps={{ inputProps: { min: 100, max: 100000 } }}
                  onChange={(e) => onChange('page_size', parseInt(e.target.value))}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Max rows per output file"
                  type="number"
                  value={config.rows_per_segment ?? 100000}
                  fullWidth size="small"
                  InputProps={{ inputProps: { min: 1000 } }}
                  onChange={(e) => onChange('rows_per_segment', parseInt(e.target.value))}
                />
              </Grid>
              <Grid item xs={12}>
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block', fontWeight: 500 }}>Output format</Typography>
                  <ToggleButtonGroup value={config.output_format ?? 'parquet'} exclusive size="small"
                    onChange={(_, v) => { if (v) onChange('output_format', v) }}>
                    <ToggleButton value="parquet" sx={{ fontSize: FS_TB, px: 1.5 }}>Parquet</ToggleButton>
                    <ToggleButton value="csv" sx={{ fontSize: FS_TB, px: 1.5 }}>CSV</ToggleButton>
                  </ToggleButtonGroup>
                </Box>
              </Grid>
            </Grid>
          </MoreOptions>
        </>
      )}
    </Box>
  )
}

