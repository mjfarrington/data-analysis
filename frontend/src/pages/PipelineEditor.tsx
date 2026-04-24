import { useCallback, useState, useMemo, useEffect, useRef, createContext, useContext } from 'react'
import RunDetailPanel, { formatDuration, formatRunDate } from '../components/RunDetailPanel'
import { useParams, useNavigate } from 'react-router-dom'
import ReactFlow, {
  Background, MiniMap,
  addEdge, useNodesState, useEdgesState,
  Connection as RFConnection, Edge, Node, NodeTypes,
  ConnectionLineType,
  Handle, Position, MarkerType, Panel,
  ReactFlowInstance, Viewport, useReactFlow, useStore,
} from 'reactflow'
// @ts-ignore side-effect stylesheet import provided by reactflow at build time
import 'reactflow/dist/style.css'
import {
  Autocomplete, Box, Typography, Button, IconButton, Tooltip,
  TextField, Select, MenuItem, FormControl, InputLabel,
  Divider, Chip, CircularProgress, alpha, useTheme,
  Tab, Tabs, Switch, FormControlLabel,
  List, ListItemButton, ListItemText, ListItemSecondaryAction,
  Dialog, DialogTitle, DialogContent, DialogActions,
  ToggleButton, ToggleButtonGroup, Alert, Collapse,
  Paper, InputAdornment, Table, TableHead, TableRow,
  TableCell, TableBody, TableContainer,
  Menu,
} from '@mui/material'
import {
  ArrowBack, PlayArrow, Save, Add, Delete, Edit, Close,
  Storage as StorageIcon, FilterList, JoinFull, Sort, Search,
  Code, Functions, FolderOpen, TableChart, Power as PowerIcon,
  ExpandMore, ExpandLess, Cloud, AccountTree, ContentCopy,
  EditNote, Info, Dataset as DatasetIcon, Visibility,
  Loop as LoopIcon, CheckBox, CheckBoxOutlineBlank,
  ZoomIn, ZoomOut, CenterFocusStrong, LibraryBooks,
  CloudDownload as S3Icon, FirstPage, LastPage,
} from '@mui/icons-material'
import { Checkbox, ListItemIcon } from '@mui/material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  pipelinesApi, connectionsApi, sqlFilesApi, dictionariesApi, transformApi, contextApi,
  Pipeline, Connection, SqlFile, Dictionary, PreviewResult, NotebookFile, RunSummary,
} from '../api/client'
import { useThemeStore, LineRenderStyle } from '../store/theme'
import StatusChip from '../components/StatusChip'

const DEFAULT_PIPELINE_CATEGORY = 'Unknown'
const DEFAULT_PIPELINE_STATUS: Pipeline['status'] = 'draft'

const EDGE_TYPE_BY_STYLE: Record<LineRenderStyle, Edge['type']> = {
  curved: 'default',
  angled: 'step',
  straight: 'straight',
  smooth: 'smoothstep',
}

const CONNECTION_LINE_TYPE_BY_STYLE: Record<LineRenderStyle, ConnectionLineType> = {
  curved: ConnectionLineType.Bezier,
  angled: ConnectionLineType.Step,
  straight: ConnectionLineType.Straight,
  smooth: ConnectionLineType.SmoothStep,
}

function normalizePipelineCategory(category?: string): string {
  const value = (category ?? '').trim()
  return value || DEFAULT_PIPELINE_CATEGORY
}

function buildPipelineCategoryOptions(categories: string[]): string[] {
  return Array.from(new Set(categories.map(normalizePipelineCategory))).sort((a, b) => {
    if (a === DEFAULT_PIPELINE_CATEGORY) return -1
    if (b === DEFAULT_PIPELINE_CATEGORY) return 1
    return a.localeCompare(b)
  })
}

function deriveSparkDatabaseName(businessDate?: string): string {
  const compact = (businessDate ?? '{business_date}').replace(/-/g, '')
  return `data_${compact}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Node catalog
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACT_COLOR = '#58a6ff'
const TRANSFORM_COLOR = '#e3b341'
const LOAD_COLOR = '#3fb950'
const ORCHESTRATION_COLOR = '#8b5cf6'

interface CatalogItem {
  type: string
  label: string
  color: string
  category: 'source' | 'transform' | 'load'
  icon: React.ReactNode
  dualHandle?: boolean   // has both target (left) and source (right) handles
}

const CATALOG: CatalogItem[] = [
  { type: 'iterator',         label: 'Iterator',           color: ORCHESTRATION_COLOR,    category: 'source',    icon: <LoopIcon fontSize="inherit" /> },
  { type: 'dw_extract',       label: 'Datawarehouse',     color: EXTRACT_COLOR,    category: 'source',    icon: <StorageIcon fontSize="inherit" /> , dualHandle: true },
  { type: 'jdbc_extract',     label: 'JDBC Extract',       color: EXTRACT_COLOR,    category: 'source',    icon: <DatasetIcon fontSize="inherit" />, dualHandle: true },
  { type: 's3_extract',       label: 'S3 Extract',         color: EXTRACT_COLOR,    category: 'source',    icon: <S3Icon fontSize="inherit" /> , dualHandle: true },
  { type: 'filter',        label: 'Filter Rows',        color: TRANSFORM_COLOR,  category: 'transform', icon: <FilterList fontSize="inherit" /> },
  { type: 'join',          label: 'Join',               color: TRANSFORM_COLOR,  category: 'transform', icon: <JoinFull fontSize="inherit" /> },
  { type: 'sort',          label: 'Sort',               color: TRANSFORM_COLOR,  category: 'transform', icon: <Sort fontSize="inherit" /> },
  { type: 'lookup',        label: 'Dict Lookup',        color: TRANSFORM_COLOR,  category: 'transform', icon: <Search fontSize="inherit" /> },
  { type: 'sql_transform', label: 'SQL Transform',      color: TRANSFORM_COLOR,  category: 'transform', icon: <Code fontSize="inherit" /> },
  { type: 'notebook_transform', label: 'Notebook',      color: TRANSFORM_COLOR,  category: 'transform', icon: <LibraryBooks fontSize="inherit" /> },
  { type: 'aggregate',     label: 'Aggregate',          color: TRANSFORM_COLOR,  category: 'transform', icon: <Functions fontSize="inherit" /> },
  { type: 'load_parquet',  label: 'Parquet File',       color: LOAD_COLOR,       category: 'load',      icon: <FolderOpen fontSize="inherit" /> , dualHandle: true },
  { type: 'load_sql',      label: 'SQL/Spark Table',    color: LOAD_COLOR,       category: 'load',      icon: <TableChart fontSize="inherit" /> },
  { type: 'load_s3',      label: 'S3 Bucket',    color: LOAD_COLOR,       category: 'load',      icon: <TableChart fontSize="inherit" /> },
]

const CATALOG_MAP: Record<string, CatalogItem> = Object.fromEntries(CATALOG.map(c => [c.type, c]))

interface TemplateItem {
  id: string
  label: string
  description: string
  color: string
}

const PIPELINE_TEMPLATES: TemplateItem[] = [
  {
    id: 'iterator-jdbc-aggregate-spark',
    label: 'Interator ETL',
    description: '',
    color: '#0ea5a6',
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Default configs per node type
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defaultConfig(type: string): Record<string, any> {
  switch (type) {
    case 'dw_extract':
      return {
        connection_id: null,
        sql_file_id: null,
        date_format: 'YYYY-MM-DD',
        date_range_mode: 'current_month',
        date_from: '',
        date_to: '',
        output_format: 'parquet',
        sample_data: false,
        sample_row_limit: 1000,
        apps: [],
      }
    case 'iterator':
      return {
        dictionary_id: null,
        selected_keys: [],   // empty = all entries; non-empty = only these keys
        entry_filters: [],   // [{ column, value }] matched against dictionary entry extra columns
        key_param: 'app_id',
        value_param: 'app_name',
      }
    case 'jdbc_extract':
      return {
        connection_id: null,
        sql: '',
        sql_file_id: null,
        params: [],   // [{key, value}] static params shared across all runs
        limit: null,
        chunk_size: 50000,
        output_subdir: '',
        date_format: 'YYYY-MM-DD',
      }
    case 's3_extract':
      return {
        connection_id: null,
        prefix: '',
        pattern: '*',
        format: 'auto',
        write_mode: 'overwrite',
        target_db: 'default',
        target_table: '',
        transform_sql: '',
        csv_sep: ',',
      }
    case 'filter':
      return { conditions: [{ column: '', operator: '=', value: '' }], logic: 'AND' }
    case 'join':
      return { join_type: 'inner', keys: [{ left: '', right: '' }] }
    case 'sort':
      return { columns: [{ column: '', direction: 'asc' }] }
    case 'lookup':
      return { dict_id: null, match_column: '', output_column: '', default_value: '' }
    case 'sql_transform':
      return { sql_file_id: null }
    case 'notebook_transform':
      return { notebook_file_id: null }
    case 'aggregate':
      return { group_by: [], aggregations: [{ column: '', function: 'sum', alias: '' }] }
    case 'load_parquet':
      return { output_dir: '', path_template: '', partition_by: ['date'], mode: 'overwrite' }
    case 'load_sql':
      return { namespace_db: '', database: '', table_name: '', mode: 'overwrite' }
    default:
      return {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Node summary lines (shown in the canvas card)
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodeSummary(type: string, config: Record<string, any>, meta?: { connName?: string; sqlName?: string; dictName?: string; notebookName?: string }): string[] {
  switch (type) {
    case 'iterator': {
      const filters = (config.entry_filters ?? []).filter((f: { column?: string; value?: string }) => f?.column && f?.value)
      return [
        meta?.dictName ?? (config.dictionary_id ? `Dict #${config.dictionary_id}` : '— No dictionary'),
        `$${config.key_param ?? 'app_id'} / $${config.value_param ?? 'app_name'}`,
        filters.length > 0 ? `Filters: ${filters.length}` : 'Filters: none',
      ]
    }
    case 'dw_extract':
      return [
        meta?.connName ? `🔌 ${meta.connName}` : '🔌 No connection',
        meta?.sqlName  ? `📄 ${meta.sqlName}`   : '📄 No SQL file',
        `📅 ${config.date_range_mode?.replace('_', ' ') ?? '—'}`,
        config.sample_data ? `🔬 Sample: ${config.sample_row_limit} rows` : `→ ${config.output_format ?? 'parquet'}`,
      ]
    case 'jdbc_extract':
      return [
        meta?.connName ? `🔌 ${meta.connName}` : '🔌 No connection',
        config.sql || config.sql_file_id ? '📝 SQL configured' : '📝 No SQL',
        Number(config.limit) > 0 ? `🔢 Limit ${Number(config.limit).toLocaleString()} rows` : '🔢 No row limit',
        `📦 ${config.chunk_size?.toLocaleString() ?? '50,000'} rows/chunk`,
      ]
    case 's3_extract':
      return [
        meta?.connName ? `☁ ${meta.connName}` : '☁ No connection',
        config.prefix ? `📁 ${config.prefix}` : '📁 No prefix',
        `🔍 ${config.pattern ?? '*'} → ${config.target_db ?? 'default'}.${config.target_table || '?'}`,
      ]
    case 'filter':
      return [`${config.conditions?.length ?? 0} condition(s)`, config.logic]
    case 'join':
      return [config.join_type, `${config.keys?.length ?? 0} key(s)`]
    case 'sort':
      return [`${config.columns?.length ?? 0} column(s)`]
    case 'lookup':
      return [config.match_column || '—', config.output_column || '—']
    case 'sql_transform':
      return [meta?.sqlName ?? 'No SQL file']
    case 'notebook_transform':
      return [meta?.notebookName ?? 'No notebook']
    case 'aggregate':
      return [
        `${config.aggregations?.length ?? 0} aggregation(s)`,
        (config.group_by ?? []).includes('app_id') ? 'Grouped by app_id' : 'No app_id grouping',
      ]
    case 'load_parquet':
      return [config.path_template || config.output_dir || 'Default dir', config.mode]
    case 'load_sql':
      return [config.table_name || 'No table', config.mode]
    default:
      return []
  }
}

type IteratorEntryFilter = { column: string; value: string }

function getIteratorActiveEntries(
  dict: Dictionary | undefined,
  selectedKeys: string[],
  entryFilters: IteratorEntryFilter[],
): Array<{ id: number; key: string; value: string; extra?: Record<string, string> }> {
  if (!dict) return []
  return dict.entries.filter((entry) => {
    const selected = selectedKeys.length === 0 || selectedKeys.includes(entry.key)
    if (!selected) return false
    if (entryFilters.length === 0) return true
    const extra = entry.extra ?? {}
    return entryFilters.every((filter) => String(extra[filter.column] ?? '') === filter.value)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Full canvas serialisation — all nodes with their configs + edges
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function canvasToJson(nodes: Node<PipelineNodeData>[], edges: Edge[]): Record<string, any> {
  return {
    nodes: nodes.map(n => ({
      id: n.id,
      type: n.data.nodeType,
      label: n.data.label,
      position: n.position,
      config: n.data.config ?? {},
    })),
    edges: edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
    })),
  }
}

/** Config-only (no layout positions) — for the schema viewer */
function canvasToConfig(nodes: Node<PipelineNodeData>[], edges: Edge[]): Record<string, any> {
  return {
    nodes: nodes.map(n => ({
      id: n.id,
      type: n.data.nodeType,
      label: n.data.label,
      config: n.data.config ?? {},
    })),
    edges: edges.map(e => ({
      source: e.source,
      target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
    })),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonToCanvas(json: Record<string, any>): { nodes: Node<PipelineNodeData>[]; edges: Edge[] } {
  const nodes: Node<PipelineNodeData>[] = (json.nodes ?? []).map((n: any) => ({
    id: n.id,
    type: 'pipeline',
    position: n.position ?? { x: 0, y: 0 },
    data: {
      nodeType: n.type ?? n.data?.nodeType,
      label: n.label ?? n.data?.label ?? n.type,
      config: n.config ?? n.data?.config ?? {},
    },
  }))
  const edges: Edge[] = (json.edges ?? []).map((e: any) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
    ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
  }))
  return { nodes, edges }
}

// ─────────────────────────────────────────────────────────────────────────────
// Context so PipelineNode can look up dictionary entries without prop-drilling
// ─────────────────────────────────────────────────────────────────────────────

const DictionariesContext = createContext<Dictionary[]>([])
const ConnectionsContext  = createContext<Connection[]>([])
const NotebooksContext    = createContext<NotebookFile[]>([])

// ─────────────────────────────────────────────────────────────────────────────
// PipelineNodeData interface
// ─────────────────────────────────────────────────────────────────────────────

interface PipelineNodeData {
  nodeType: string
  label: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>
  // denormalised display labels (kept in sync on save)
  connectionName?: string
  sqlFileName?: string
  dictName?: string
  notebookName?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom ReactFlow node
// ─────────────────────────────────────────────────────────────────────────────

function PipelineNode({ id, data, selected }: { id: string; data: PipelineNodeData; selected: boolean }) {
  const theme = useTheme()
  const { setNodes, setEdges } = useReactFlow()
  const dictionaries = useContext(DictionariesContext)
  const connections   = useContext(ConnectionsContext)
  const notebooks     = useContext(NotebooksContext)
  const cat = CATALOG_MAP[data.nodeType] ?? { color: '#666', label: data.nodeType, icon: <AccountTree fontSize="inherit" /> }
  const isSource = cat.category === 'source'
  const isSink   = cat.category === 'load'
  const hasDualHandle = cat.dualHandle === true
  const liveDictName     = dictionaries.find(d => d.id === Number(data.config?.dictionary_id))?.name
  const liveConnName     = connections.find(c => c.id === Number(data.config?.connection_id))?.name
  const liveNotebookName = notebooks.find(n => n.id === Number(data.config?.notebook_file_id))?.name
  const lines = nodeSummary(data.nodeType, data.config, {
    connName:     liveConnName ?? data.connectionName,
    sqlName:      data.sqlFileName,
    dictName:     liveDictName,
    notebookName: liveNotebookName ?? data.notebookName,
  })

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    setNodes(nds => nds.filter(n => n.id !== id))
    setEdges(eds => eds.filter(e => e.source !== id && e.target !== id))
  }

  return (
    <Box
      sx={{
        minWidth: 150, maxWidth: 170,
        borderRadius: 1.5,
        border: `2px solid`,
        borderColor: selected ? cat.color : alpha(cat.color, 0.45),
        bgcolor: 'background.paper',
        overflow: 'visible',
        boxShadow: selected ? `0 0 16px ${alpha(cat.color, 0.4)}` : `0 1px 4px rgba(0,0,0,0.3)`,
        transition: 'all 0.15s',
        position: 'relative',
      }}
    >


      {/* Target handle: transform nodes always, source nodes with dualHandle */}
      {(!isSource || hasDualHandle) && (
        <Handle
          type="target"
          position={Position.Left}
          style={{ background: cat.color, width: 10, height: 10, border: '2px solid #fff' }}
        />
      )}

      {/* Header */}
      <Box
        sx={{
          bgcolor: alpha(cat.color, 0.18),
          px: 1.25, py: 0.6,
          display: 'flex', alignItems: 'center', gap: 0.75,
          borderBottom: `1px solid ${alpha(cat.color, 0.25)}`,
          borderRadius: '6px 6px 0 0',
          overflow: 'hidden',
        }}
      >
        <Box sx={{ color: cat.color, fontSize: 14, display: 'flex', lineHeight: 1 }}>{cat.icon}</Box>
        <Typography
          sx={{ color: cat.color, fontSize: '0.6rem', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.07em', flex: 1 }}
        >
          {cat.label}
        </Typography>
        {selected && (
          <IconButton
            onClick={handleDelete}
            size="small"
            sx={{ p: 0.1, color: alpha(cat.color, 0.7), '&:hover': { color: 'error.main', bgcolor: 'transparent' } }}
          >
            <Delete sx={{ fontSize: 13 }} />
          </IconButton>
        )}
      </Box>

      {/* Body */}
      <Box sx={{ px: 1.25, py: 0.9 }}>
        <Typography
          sx={{ fontSize: '0.76rem', fontWeight: 600, mb: 0.6,
            color: theme.palette.text.primary, lineHeight: 1.3 }}
          noWrap
        >
          {data.label}
        </Typography>
        {lines.map((line, i) => (
          <Typography key={i} noWrap sx={{ fontSize: '0.64rem', color: 'text.secondary', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
            {line}
          </Typography>
        ))}
        {/* Iterator entry key chips */}
        {data.nodeType === 'iterator' && (() => {
          const dict = dictionaries.find(d => d.id === Number(data.config.dictionary_id))
          const selKeys: string[] = data.config.selected_keys ?? []
          const entryFilters: IteratorEntryFilter[] = (data.config.entry_filters ?? [])
            .filter((f: { column?: string; value?: string }) => f?.column && f?.value)
          const keys = getIteratorActiveEntries(dict, selKeys, entryFilters).map(e => e.key)
          if (keys.length === 0) return null
          const visible = keys.slice(0, 3)
          const overflow = keys.length - 3
          return (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.4, mt: 0.5 }}>
              {visible.map(k => (
                <Chip key={k} label={k} size="small"
                  sx={{ fontSize: '0.58rem', height: 16, fontFamily: 'monospace',
                    bgcolor: alpha(cat.color, 0.15), color: cat.color, border: 'none' }} />
              ))}
              {overflow > 0 && (
                <Chip label={`+${overflow}`} size="small"
                  sx={{ fontSize: '0.58rem', height: 16,
                    bgcolor: 'action.hover', color: 'text.secondary', border: 'none' }} />
              )}
            </Box>
          )
        })()}
      </Box>

      {!isSink && (
        <Handle
          type="source"
          position={Position.Right}
          style={{ background: cat.color, width: 10, height: 10, border: '2px solid #fff' }}
        />
      )}
    </Box>
  )
}

const nodeTypes: NodeTypes = { pipeline: PipelineNode }

// ─────────────────────────────────────────────────────────────────────────────
// Custom zoom controls (dark-mode aware)
// ─────────────────────────────────────────────────────────────────────────────

const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

function ZoomControls() {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow()
  const theme = useTheme()
  const zoom = useStore(s => s.transform[2])
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null)
  const pct = Math.round(zoom * 100)

  const btnSx = {
    bgcolor: theme.palette.background.paper,
    color: theme.palette.text.primary,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 1,
    '&:hover': { bgcolor: theme.palette.action.hover, borderColor: theme.palette.primary.main },
  }

  return (
    <Panel position="bottom-left" style={{ margin: '10px' }}>
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
        <Tooltip title="Zoom out">
          <IconButton size="small" onClick={() => zoomOut({ duration: 200 })} sx={btnSx}>
            <ZoomOut sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Select zoom level">
          <Button
            size="small"
            onClick={e => setMenuAnchor(e.currentTarget)}
            sx={{ ...btnSx, fontSize: '0.72rem', px: 1, minWidth: 52, fontFamily: 'monospace', lineHeight: 1 }}
          >
            {pct}%
          </Button>
        </Tooltip>
        <Tooltip title="Zoom in">
          <IconButton size="small" onClick={() => zoomIn({ duration: 200 })} sx={btnSx}>
            <ZoomIn sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Fit view">
          <IconButton size="small" onClick={() => fitView({ duration: 300, padding: 0.1 })} sx={btnSx}>
            <CenterFocusStrong sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
        {ZOOM_LEVELS.map(z => (
          <MenuItem
            key={z}
            selected={Math.abs(zoom - z) < 0.01}
            dense
            onClick={() => { zoomTo(z, { duration: 200 }); setMenuAnchor(null) }}
          >
            <Typography sx={{ fontSize: '0.8rem', fontFamily: 'monospace', minWidth: 48 }}>{Math.round(z * 100)}%</Typography>
          </MenuItem>
        ))}
      </Menu>
    </Panel>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// JDBC Extract form
// ─────────────────────────────────────────────────────────────────────────────

const BUILTIN_PARAMS = [
  { key: 'business_date',      label: '$business_date',      hint: 'Current business date (YYYYMMDD)' },
  { key: 'business_date_from', label: '$business_date_from', hint: 'Range start' },
  { key: 'business_date_to',   label: '$business_date_to',   hint: 'Range end' },
  { key: 'app_id',             label: '$app_id',             hint: 'Application ID' },
  { key: 'app_name',           label: '$app_name',           hint: 'Application name' },
]

// Global params automatically resolved — never need to be added per-job
function getGlobalParams(): { key: string; value: string }[] {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const yyyymmdd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const isoDate  = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return [
    { key: 'business_date',       value: yyyymmdd },
    { key: 'business_date_from',  value: isoDate },
    { key: 'business_date_to',    value: isoDate },
    { key: 'business_date_range', value: `${isoDate} / ${isoDate}` },
  ]
}

interface SqlParam { key: string; value: string }

// ─────────────────────────────────────────────────────────────────────────────
// SQL Bottom Panel
// ─────────────────────────────────────────────────────────────────────────────

function injectParams(sql: string, params: { key: string; value: string }[]): string {
  let result = sql
  const sorted = [...params].sort((a, b) => b.key.length - a.key.length)
  for (const { key, value } of sorted) {
    if (key) result = result.split(`$${key}`).join(value)
  }
  return result
}

/** Returns list of $param names still present in the SQL (i.e. not injected). */
function findUnresolvedParams(sql: string): string[] {
  const matches = sql.match(/\$[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []
  return [...new Set(matches)]
}

interface SqlPanelState {
  open: boolean
  height: number
  connectionId: number | null
  sql: string
  params: { key: string; value: string }[]
  onSqlChange: (sql: string) => void
  iteratorInfo?: string   // shown as info banner when previewing with sample entry
}

const CLOSED_PANEL: SqlPanelState = {
  open: false, height: 320, connectionId: null, sql: '', params: [],
  onSqlChange: () => {},
}

function SqlBottomPanel({
  panel, onClose, onHeightChange,
}: {
  panel: SqlPanelState
  onClose: () => void
  onHeightChange: (h: number) => void
}) {
  const theme = useTheme()
  const dragging = useRef(false)

  const globalParams = getGlobalParams()
  // Globals are auto-injected; explicit node params take precedence
  const allParams = [...globalParams, ...panel.params]
  const resolved = injectParams(panel.sql, allParams)
  // Only flag params as unresolved if they are NOT iterator-supplied (those are real values now)
  const unresolvedParams = findUnresolvedParams(resolved)
  const hasUnresolved = unresolvedParams.length > 0

  const handleDragMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startY = e.clientY
    const startH = panel.height
    const onMove = (mv: MouseEvent) => {
      if (!dragging.current) return
      onHeightChange(Math.max(160, Math.min(700, startH + (startY - mv.clientY))))
    }
    const onUp = () => {
      dragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!panel.open) return null

  return (
    <Box
      sx={{
        height: panel.height, flexShrink: 0,
        display: 'flex', flexDirection: 'column',
        borderTop: `1px solid ${theme.palette.divider}`,
        bgcolor: 'background.paper',
        position: 'relative',
      }}
    >
      {/* Drag handle */}
      <Box
        onMouseDown={handleDragMouseDown}
        sx={{
          height: 6, cursor: 'row-resize', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          '&:hover .drag-indicator': { bgcolor: 'primary.main', opacity: 0.6 },
        }}
      >
        <Box className="drag-indicator" sx={{ width: 40, height: 3, borderRadius: 2, bgcolor: 'divider', transition: 'background 0.15s' }} />
      </Box>

      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, pb: 0.5, flexShrink: 0, gap: 1 }}>
        <Code sx={{ fontSize: 15, color: 'primary.main' }} />
        <Typography variant="caption" sx={{ flex: 1, fontSize: '0.75rem', fontWeight: 700 }}>SQL Editor</Typography>
        <IconButton size="small" onClick={onClose}><Close sx={{ fontSize: 15 }} /></IconButton>
      </Box>

      {/* Body: editor + resolved */}
      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden', px: 1, pb: 1, gap: 1 }}>
        {/* Left: SQL editor */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 0.25, fontSize: '0.65rem' }}>SQL</Typography>
          <textarea
            value={panel.sql}
            onChange={e => panel.onSqlChange(e.target.value)}
            spellCheck={false}
            style={{
              flex: 1, width: '100%', resize: 'none',
              fontFamily: 'monospace', fontSize: '0.75rem',
              padding: '6px 8px', boxSizing: 'border-box',
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 4,
              background: theme.palette.mode === 'dark' ? '#1e1e2e' : '#f6f8fa',
              color: theme.palette.text.primary,
              outline: 'none', lineHeight: 1.5,
            }}
          />
        </Box>

        {/* Right: resolved SQL */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 0.25, fontSize: '0.65rem' }}>
            {(() => {
              const explicit = panel.params.filter(p => p.key && p.value).length
              const globals = globalParams.length
              const total = explicit + globals
              return total > 0
                ? `Resolved SQL (${globals} global + ${explicit} job param${explicit !== 1 ? 's' : ''})`
                : 'Resolved SQL (no params)'
            })()}
          </Typography>
          {panel.iteratorInfo && (
            <Alert severity="info" sx={{ py: 0.25, mb: 0.5, fontSize: '0.68rem' }}>
              {panel.iteratorInfo}
            </Alert>
          )}
          {hasUnresolved && (
            <Alert severity="warning" sx={{ py: 0.25, mb: 0.5, fontSize: '0.68rem' }}>
              Unresolved: {unresolvedParams.join(', ')} — add values in the <strong>Parameters</strong> table on the right
            </Alert>
          )}
          <Box
            sx={{
              flex: 1, overflow: 'auto', fontFamily: 'monospace', fontSize: '0.73rem',
              padding: '6px 8px', borderRadius: 1, lineHeight: 1.5,
              border: `1px solid ${theme.palette.divider}`,
              background: theme.palette.mode === 'dark' ? '#1e1e2e' : '#f6f8fa',
              color: theme.palette.text.secondary, whiteSpace: 'pre-wrap',
            }}
          >
            {resolved || <span style={{ opacity: 0.4 }}>Write SQL on the left…</span>}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared JDBC config fields — reused by JdbcExtractForm and DWExtractForm
// ─────────────────────────────────────────────────────────────────────────────

function JdbcSharedConfig({
  config,
  onChange,
  connections,
  sqlFiles,
  dictionaries,
  connectionType,
  connectionLabel = 'Connection',
  onOpenSqlEditor,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange: (patch: Record<string, any>) => void
  connections: Connection[]
  sqlFiles: SqlFile[]
  dictionaries: Dictionary[]
  connectionType: string
  connectionLabel?: string
  onOpenSqlEditor?: () => void
}) {
  const [sqlMode, setSqlMode] = useState<'inline' | 'file'>(config.sql_file_id ? 'file' : 'inline')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; latency_ms: number; message: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const params: SqlParam[] = config.params ?? []
  const selectedSql = sqlFiles.find(f => f.id === config.sql_file_id)
  const extractSqlFiles = useMemo(
    () => sqlFiles
      .filter(f => f.file_type === 'extract')
      .sort((a, b) => a.name.localeCompare(b.name)),
    [sqlFiles],
  )
  const selectedExtractSql = extractSqlFiles.find(f => f.id === config.sql_file_id) ?? null
  const filteredConnections = connections.filter(c => c.conn_type === connectionType)

  const addParam = (key = '', value = '') => onChange({ params: [...params, { key, value }] })
  const updateParam = (i: number, field: 'key' | 'value', val: string) => {
    const next = params.map((p, j) => j === i ? { ...p, [field]: val } : p)
    onChange({ params: next })
  }
  const removeParam = (i: number) => onChange({ params: params.filter((_, j) => j !== i) })

  const handleTest = async () => {
    if (!config.connection_id) return
    setTesting(true); setTestResult(null)
    try {
      const r = await connectionsApi.test(config.connection_id)
      setTestResult(r)
    } catch (e) { setTestResult({ ok: false, latency_ms: 0, message: String(e) }) }
    finally { setTesting(false) }
  }

  const hasInlineSql = !!onOpenSqlEditor  // inline SQL only available when bottom panel is wired up

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}>
      {/* Connection picker */}
      <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-end' }}>
        <FormControl size="small" fullWidth>
          <InputLabel>{connectionLabel}</InputLabel>
          <Select
            label={connectionLabel}
            value={config.connection_id ?? ''}
            onChange={e => onChange({ connection_id: e.target.value || null })}
          >
            <MenuItem value=""><em>None</em></MenuItem>
            {filteredConnections.length === 0 && (
              <MenuItem disabled><em>No {connectionType} connections</em></MenuItem>
            )}
            {filteredConnections.map(c => (
              <MenuItem key={c.id} value={c.id}>
                <Typography variant="body2" sx={{ fontSize: '0.78rem' }}>{c.name}</Typography>
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Tooltip title="Test connection">
          <span>
            <IconButton size="small" onClick={handleTest} disabled={!config.connection_id || testing} sx={{ mb: 0.25 }}>
              {testing ? <CircularProgress size={14} /> : <PlayArrow sx={{ fontSize: 16 }} />}
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      {testResult && (
        <Alert severity={testResult.ok ? 'success' : 'error'} sx={{ py: 0.25, fontSize: '0.72rem' }}>
          {testResult.message}{testResult.ok && ` · ${testResult.latency_ms}ms`}
        </Alert>
      )}

      <Divider />

      {/* SQL mode toggle (only when inline SQL is available) */}
      {hasInlineSql && (
        <Box>
          <ToggleButtonGroup
            value={sqlMode}
            exclusive
            onChange={(_, v) => { if (v) { setSqlMode(v); onOpenSqlEditor?.() } }}
            size="small"
            fullWidth
          >
            <ToggleButton value="inline" sx={{ fontSize: '0.72rem' }}>Inline SQL</ToggleButton>
            <ToggleButton value="file" sx={{ fontSize: '0.72rem' }}>SQL File</ToggleButton>
          </ToggleButtonGroup>
        </Box>
      )}

      {/* Inline SQL area */}
      {hasInlineSql && sqlMode === 'inline' ? (
        <Box
          onClick={onOpenSqlEditor}
          sx={{
            border: '1px solid', borderColor: 'divider', borderRadius: 1,
            p: 1, cursor: 'pointer', bgcolor: 'action.hover',
            '&:hover': { borderColor: 'primary.main' },
            minHeight: 48, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 0.25,
          }}
        >
          {config.sql?.trim() ? (
            <Typography sx={{ fontFamily: 'monospace', fontSize: '0.68rem', color: 'text.primary', whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', maxHeight: 56 }}>
              {config.sql.trim().slice(0, 180)}{config.sql.trim().length > 180 ? '…' : ''}
            </Typography>
          ) : (
            <Typography sx={{ fontSize: '0.72rem', color: 'text.disabled', fontStyle: 'italic' }}>
              Click to open SQL editor…
            </Typography>
          )}
        </Box>
      ) : (
        /* SQL file picker */
        <>
          <Autocomplete
            size="small"
            fullWidth
            options={extractSqlFiles}
            value={selectedExtractSql}
            onChange={(_, selected) => {
              onChange({ sql_file_id: selected?.id ?? null, sql: '' })
              if (hasInlineSql) onOpenSqlEditor?.()
            }}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            getOptionLabel={(option) => option.name}
            renderOption={(props, option) => (
              <li {...props}>
                <Typography variant="body2" sx={{ fontSize: '0.78rem' }}>{option.name}</Typography>
              </li>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="SQL File"
                placeholder="Type SQL file name"
              />
            )}
            noOptionsText="No extract SQL files"
            clearOnEscape
          />
          {selectedSql && (
            <Box
              onClick={hasInlineSql ? onOpenSqlEditor : undefined}
              sx={{
                bgcolor: 'action.hover', borderRadius: 1, p: 1, fontFamily: 'monospace',
                fontSize: '0.64rem', whiteSpace: 'pre', overflow: 'hidden', maxHeight: 56,
                border: '1px solid', borderColor: 'divider', color: 'text.secondary',
                cursor: hasInlineSql ? 'pointer' : 'default',
                ...(hasInlineSql ? { '&:hover': { borderColor: 'primary.main' } } : {}),
                textOverflow: 'ellipsis',
              }}
            >
              {selectedSql.content.slice(0, 200)}{selectedSql.content.length > 200 ? '…' : ''}
            </Box>
          )}
        </>
      )}

      {/* Available injection variables */}
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
          <Info sx={{ fontSize: 13, color: 'text.secondary' }} />
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>Available SQL Variables</Typography>
        </Box>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {BUILTIN_PARAMS.map(v => (
            <Tooltip key={v.key} title={v.hint}>
              <Chip
                label={v.label}
                size="small"
                sx={{ fontFamily: 'monospace', fontSize: '0.62rem', height: 18, cursor: 'pointer' }}
                onClick={() => addParam(v.key, '')}
              />
            </Tooltip>
          ))}
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          Click a variable to add it as a parameter below. In SQL: <code>WHERE d = &apos;$business_date&apos;</code>
        </Typography>
      </Box>

      <Divider />

      {/* Parameters (collapsed) */}
      <Box>
        <Box
          sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'pointer', py: 0.5 }}
          onClick={() => setShowAdvanced(v => !v)}
        >
          {showAdvanced ? <ExpandLess sx={{ fontSize: 14, color: 'text.secondary' }} /> : <ExpandMore sx={{ fontSize: 14, color: 'text.secondary' }} />}
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.72rem', fontWeight: 600 }}>
            SQL Parameters
          </Typography>
          {params.length > 0 && (
            <Chip label={`${params.length} param${params.length > 1 ? 's' : ''}`} size="small"
              sx={{ fontSize: '0.58rem', height: 16, ml: 0.5 }} />
          )}
        </Box>
        <Collapse in={showAdvanced}>
          <Box sx={{ pt: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.75 }}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.6rem', fontWeight: 700 }}>
                Injected Parameters
              </Typography>
              <Tooltip title="Add parameter">
                <IconButton size="small" onClick={() => addParam()}><Add sx={{ fontSize: 14 }} /></IconButton>
              </Tooltip>
            </Box>
            {params.length === 0 && (
              <Typography variant="caption" color="text.disabled">No parameters. Add one or click a variable above.</Typography>
            )}
            {params.map((p, i) => (
              <Box key={i} sx={{ display: 'flex', gap: 0.75, mb: 0.75, alignItems: 'center' }}>
                <TextField
                  size="small" label="$param" value={p.key}
                  onChange={e => updateParam(i, 'key', e.target.value)}
                  sx={{ flex: 1 }}
                  slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: '0.72rem' } } }}
                />
                <TextField
                  size="small" label="value" value={p.value}
                  onChange={e => updateParam(i, 'value', e.target.value)}
                  sx={{ flex: 1.5 }} placeholder="2026-04-18 or APP001"
                  slotProps={{ htmlInput: { style: { fontSize: '0.72rem' } } }}
                />
                <IconButton size="small" onClick={() => removeParam(i)}><Close sx={{ fontSize: 13 }} /></IconButton>
              </Box>
            ))}
            {dictionaries.length > 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.62rem' }}>
                Use dict entries: add <code>app_id</code> / <code>app_name</code> from Dictionaries.
              </Typography>
            )}
          </Box>
        </Collapse>
      </Box>
    </Box>
  )
}

function JdbcExtractForm({
  config,
  onChange,
  connections,
  sqlFiles,
  dictionaries,
  onOpenSqlEditor,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange: (patch: Record<string, any>) => void
  connections: Connection[]
  sqlFiles: SqlFile[]
  dictionaries: Dictionary[]
  onOpenSqlEditor: () => void
}) {
  const [extracting, setExtracting] = useState(false)
  const [extractResult, setExtractResult] = useState<{ total_rows: number; file_count: number; output_dir: string } | null>(null)
  const [extractError, setExtractError] = useState<string | null>(null)

  const params: SqlParam[] = config.params ?? []
  const selectedSql = sqlFiles.find(f => f.id === config.sql_file_id)

  const buildParamsDict = (): Record<string, string> => {
    const d: Record<string, string> = {}
    for (const p of params) { if (p.key && p.value) d[p.key] = p.value }
    return d
  }

  const getSql = (): string => config.sql_file_id ? (selectedSql?.content ?? '') : (config.sql ?? '')

  const handleExtract = async () => {
    if (!config.connection_id) return
    const sql = getSql()
    if (!sql.trim()) return
    setExtracting(true); setExtractError(null); setExtractResult(null)
    try {
      const r = await connectionsApi.extract(
        config.connection_id, sql, buildParamsDict(),
        config.chunk_size ?? 50000, config.output_subdir || undefined,
      )
      setExtractResult(r)
    } catch (e) { setExtractError(String(e)) }
    finally { setExtracting(false) }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}>

      <JdbcSharedConfig
        config={config}
        onChange={onChange}
        connections={connections}
        sqlFiles={sqlFiles}
        dictionaries={dictionaries}
        connectionType="jdbc"
        connectionLabel="JDBC Connection"
        onOpenSqlEditor={onOpenSqlEditor}
      />

      <Divider />

      {/* Row Limit + Chunk Size */}
      <TextField
        label="Row Limit"
        size="small"
        type="number"
        fullWidth
        value={config.limit ?? ''}
        onChange={e => {
          const raw = e.target.value
          if (raw === '') { onChange({ limit: null }); return }
          const parsed = parseInt(raw, 10)
          onChange({ limit: Number.isFinite(parsed) && parsed > 0 ? parsed : null })
        }}
        helperText="Optional max rows per JDBC query (leave blank for no limit)"
      />

      <TextField
        label="Chunk Size"
        size="small"
        type="number"
        fullWidth
        value={config.chunk_size ?? 50000}
        onChange={e => onChange({ chunk_size: parseInt(e.target.value) || 50000 })}
        helperText="Rows per parquet file written by the downstream output node"
      />

      <Divider />

      {/* Preview button */}
      <Button
        variant="outlined"
        size="small"
        startIcon={<Visibility sx={{ fontSize: 14 }} />}
        onClick={onOpenSqlEditor}
        disabled={!config.connection_id}
        sx={{ fontSize: '0.72rem' }}
        fullWidth
      >
        Preview SQL
      </Button>

      {/* Extract feedback */}
      {extractError && (
        <Alert severity="error" sx={{ fontSize: '0.72rem' }}>{extractError}</Alert>
      )}
      {extractResult && (
        <Alert severity="success" sx={{ fontSize: '0.72rem' }}>
          Extracted {extractResult.total_rows.toLocaleString()} rows → {extractResult.file_count} file(s) in {extractResult.output_dir}
        </Alert>
      )}
      {extracting && <CircularProgress size={18} sx={{ alignSelf: 'center' }} />}

    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DW Extract form
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// S3 Extract form
// ─────────────────────────────────────────────────────────────────────────────

const S3_FORMATS     = ['auto', 'parquet', 'csv', 'json', 'orc']
const S3_WRITE_MODES = ['overwrite', 'append', 'ignore', 'error']

function S3ExtractForm({
  config, onChange, connections,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange: (patch: Record<string, any>) => void
  connections: Connection[]
}) {
  const [showSql, setShowSql] = useState(false)
  const s3Connections = connections.filter(c => c.conn_type === 's3')

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}>
      {/* Connection */}
      <FormControl size="small" fullWidth>
        <InputLabel>S3 Connection</InputLabel>
        <Select
          label="S3 Connection"
          value={config.connection_id ?? ''}
          onChange={e => onChange({ connection_id: e.target.value || null })}
        >
          <MenuItem value=""><em>None</em></MenuItem>
          {s3Connections.length === 0 && (
            <MenuItem disabled><em>No S3 connections — add one in Connections</em></MenuItem>
          )}
          {s3Connections.map(c => (
            <MenuItem key={c.id} value={c.id}>
              <Box>
                <Typography variant="body2" sx={{ fontSize: '0.78rem' }}>{c.name}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
                  s3://{(c.extra?.bucket as string) ?? '?'} · {(c.extra?.region as string) ?? 'us-east-1'}
                </Typography>
              </Box>
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Prefix + Pattern */}
      <Box sx={{ display: 'flex', gap: 1 }}>
        <TextField
          label="Path prefix"
          value={config.prefix ?? ''}
          onChange={e => onChange({ prefix: e.target.value })}
          size="small"
          sx={{ flex: 3 }}
          placeholder="data/trades/2026-04/"
          helperText="S3 key prefix (directory)"
        />
        <TextField
          label="File pattern"
          value={config.pattern ?? '*'}
          onChange={e => onChange({ pattern: e.target.value })}
          size="small"
          sx={{ flex: 2 }}
          placeholder="*.parquet"
        />
      </Box>

      {/* Format */}
      <Box sx={{ display: 'flex', gap: 1 }}>
        <FormControl size="small" sx={{ flex: 1 }}>
          <InputLabel>Format</InputLabel>
          <Select
            label="Format"
            value={config.format ?? 'auto'}
            onChange={e => onChange({ format: e.target.value })}
          >
            {S3_FORMATS.map(f => <MenuItem key={f} value={f}>{f}</MenuItem>)}
          </Select>
        </FormControl>
        {config.format === 'csv' && (
          <TextField
            label="CSV sep"
            value={config.csv_sep ?? ','}
            onChange={e => onChange({ csv_sep: e.target.value })}
            size="small"
            sx={{ flex: 1 }}
          />
        )}
      </Box>

      {/* Target table */}
      <Divider />
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', fontSize: '0.62rem', letterSpacing: '0.06em', fontWeight: 600 }}>
        Target Spark Table
      </Typography>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <TextField
          label="Database"
          value={config.target_db ?? 'default'}
          onChange={e => onChange({ target_db: e.target.value })}
          size="small"
          sx={{ flex: 1 }}
        />
        <TextField
          label="Table *"
          value={config.target_table ?? ''}
          onChange={e => onChange({ target_table: e.target.value })}
          size="small"
          sx={{ flex: 2 }}
          required
          error={!config.target_table}
        />
      </Box>
      <FormControl size="small" fullWidth>
        <InputLabel>Write mode</InputLabel>
        <Select
          label="Write mode"
          value={config.write_mode ?? 'overwrite'}
          onChange={e => onChange({ write_mode: e.target.value })}
        >
          {S3_WRITE_MODES.map(m => <MenuItem key={m} value={m}>{m}</MenuItem>)}
        </Select>
      </FormControl>

      {/* Optional SQL transform */}
      <Box
        sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'pointer' }}
        onClick={() => setShowSql(v => !v)}
      >
        {showSql ? <ExpandLess sx={{ fontSize: 14, color: 'text.secondary' }} /> : <ExpandMore sx={{ fontSize: 14, color: 'text.secondary' }} />}
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>SQL Transform (optional)</Typography>
      </Box>
      <Collapse in={showSql}>
        <TextField
          label="Transform SQL"
          multiline
          minRows={3}
          value={config.transform_sql ?? ''}
          onChange={e => onChange({ transform_sql: e.target.value })}
          size="small"
          fullWidth
          placeholder="SELECT * FROM {source} WHERE date >= '2026-01-01'"
          helperText="Use {source} to reference the raw ingested data."
          slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: '0.75rem' } } }}
        />
      </Collapse>
    </Box>
  )
}

function DWExtractForm({
  config, onChange, connections, sqlFiles, dictionaries, onOpenSqlEditor,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange: (patch: Record<string, any>) => void
  connections: Connection[]
  sqlFiles: SqlFile[]
  dictionaries: Dictionary[]
  onOpenSqlEditor?: () => void
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}>

      <JdbcSharedConfig
        config={config}
        onChange={onChange}
        connections={connections}
        sqlFiles={sqlFiles}
        dictionaries={dictionaries}
        connectionType="datawarehouse"
        connectionLabel="DataWarehouse Connection"
        onOpenSqlEditor={onOpenSqlEditor}
      />

      <Divider />

      {/* Date format */}
      <FormControl size="small" fullWidth>
        <InputLabel>Date Format</InputLabel>
        <Select
          label="Date Format"
          value={config.date_format ?? 'YYYY-MM-DD'}
          onChange={e => onChange({ date_format: e.target.value })}
        >
          {['YYYY-MM-DD', 'YYYYMMDD', 'YYYYMM', 'YYYY/MM/DD', 'DD/MM/YYYY', 'MM/DD/YYYY'].map(f => (
            <MenuItem key={f} value={f}><Typography sx={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{f}</Typography></MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Date range mode */}
      <FormControl size="small" fullWidth>
        <InputLabel>Date Range</InputLabel>
        <Select
          label="Date Range"
          value={config.date_range_mode ?? 'current_month'}
          onChange={e => onChange({ date_range_mode: e.target.value })}
        >
          <MenuItem value="single">Single (business date)</MenuItem>
          <MenuItem value="current_month">Current Month</MenuItem>
          <MenuItem value="previous_month">Previous Month</MenuItem>
          <MenuItem value="custom">Custom Range</MenuItem>
        </Select>
      </FormControl>

      {/* Custom range */}
      {config.date_range_mode === 'custom' && (
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            label="From"
            type="date"
            size="small"
            value={config.date_from ?? ''}
            onChange={e => onChange({ date_from: e.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: 1 }}
          />
          <TextField
            label="To"
            type="date"
            size="small"
            value={config.date_to ?? ''}
            onChange={e => onChange({ date_to: e.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: 1 }}
          />
        </Box>
      )}

      <Divider />

      {/* Output format */}
      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.75 }}>
          Output Format
        </Typography>
        <ToggleButtonGroup
          value={config.output_format ?? 'parquet'}
          exclusive
          onChange={(_, v) => v && onChange({ output_format: v })}
          size="small"
          fullWidth
        >
          <ToggleButton value="parquet" sx={{ fontSize: '0.72rem' }}>Parquet</ToggleButton>
          <ToggleButton value="sql_table" sx={{ fontSize: '0.72rem' }}>SQL Table</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Divider />

      {/* Sample data */}
      <Box>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={Boolean(config.sample_data)}
              onChange={e => onChange({ sample_data: e.target.checked })}
            />
          }
          label={<Typography variant="body2" sx={{ fontSize: '0.78rem' }}>Generate Sample Data</Typography>}
        />
        {config.sample_data && (
          <TextField
            label="Max Rows"
            type="number"
            size="small"
            fullWidth
            value={config.sample_row_limit ?? 1000}
            onChange={e => onChange({ sample_row_limit: Number(e.target.value) })}
            sx={{ mt: 1 }}
            slotProps={{ htmlInput: { min: 1, max: 100000 } }}
            helperText="Rows returned when sample mode is enabled"
          />
        )}
      </Box>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic/simple transform forms
// ─────────────────────────────────────────────────────────────────────────────

function FilterForm({ config, onChange }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>; onChange: (p: Record<string, any>) => void
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <FormControl size="small" fullWidth>
        <InputLabel>Logic</InputLabel>
        <Select label="Logic" value={config.logic ?? 'AND'} onChange={e => onChange({ logic: e.target.value })}>
          <MenuItem value="AND">AND — all conditions must match</MenuItem>
          <MenuItem value="OR">OR — any condition must match</MenuItem>
        </Select>
      </FormControl>
      {(config.conditions ?? []).map((_: unknown, i: number) => (
        <Box key={i} sx={{ display: 'flex', gap: 0.75 }}>
          <TextField label="Column" size="small" sx={{ flex: 2 }}
            value={config.conditions[i].column}
            onChange={e => { const c = [...config.conditions]; c[i] = { ...c[i], column: e.target.value }; onChange({ conditions: c }) }}
          />
          <Select size="small" sx={{ flex: 1, fontSize: '0.72rem' }}
            value={config.conditions[i].operator}
            onChange={e => { const c = [...config.conditions]; c[i] = { ...c[i], operator: e.target.value }; onChange({ conditions: c }) }}
          >
            {['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IN', 'IS NULL'].map(op => <MenuItem key={op} value={op}>{op}</MenuItem>)}
          </Select>
          <TextField label="Value" size="small" sx={{ flex: 2 }}
            value={config.conditions[i].value}
            onChange={e => { const c = [...config.conditions]; c[i] = { ...c[i], value: e.target.value }; onChange({ conditions: c }) }}
          />
        </Box>
      ))}
      <Button size="small" startIcon={<Add />} onClick={() => onChange({ conditions: [...(config.conditions ?? []), { column: '', operator: '=', value: '' }] })}>
        Add Condition
      </Button>
    </Box>
  )
}

function JoinForm({ config, onChange }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>; onChange: (p: Record<string, any>) => void
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Alert severity="info" sx={{ fontSize: '0.72rem', py: 0.5 }}>
        Join requires two data sources and is not yet supported in pipeline execution. It is saved for future use.
      </Alert>
      <FormControl size="small" fullWidth>
        <InputLabel>Join Type</InputLabel>
        <Select label="Join Type" value={config.join_type ?? 'inner'} onChange={e => onChange({ join_type: e.target.value })}>
          {['inner', 'left', 'right', 'full'].map(t => <MenuItem key={t} value={t}>{t.toUpperCase()} JOIN</MenuItem>)}
        </Select>
      </FormControl>
      {(config.keys ?? []).map((_: unknown, i: number) => (
        <Box key={i} sx={{ display: 'flex', gap: 0.75 }}>
          <TextField label="Left col" size="small" sx={{ flex: 1 }}
            value={config.keys[i].left}
            onChange={e => { const k = [...config.keys]; k[i] = { ...k[i], left: e.target.value }; onChange({ keys: k }) }}
          />
          <TextField label="Right col" size="small" sx={{ flex: 1 }}
            value={config.keys[i].right}
            onChange={e => { const k = [...config.keys]; k[i] = { ...k[i], right: e.target.value }; onChange({ keys: k }) }}
          />
        </Box>
      ))}
      <Button size="small" startIcon={<Add />} onClick={() => onChange({ keys: [...(config.keys ?? []), { left: '', right: '' }] })}>
        Add Key
      </Button>
    </Box>
  )
}

function SortForm({ config, onChange }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>; onChange: (p: Record<string, any>) => void
}) {
  const columns: Array<{ column: string; direction: string }> = config.columns ?? []
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {columns.map((_, i) => (
        <Box key={i} sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-start' }}>
          <TextField label="Column" size="small" sx={{ flex: 2 }}
            value={columns[i].column}
            onChange={e => { const c = [...columns]; c[i] = { ...c[i], column: e.target.value }; onChange({ columns: c }) }}
          />
          <FormControl size="small" sx={{ flex: 1 }}>
            <InputLabel>Dir</InputLabel>
            <Select label="Dir" value={columns[i].direction ?? 'asc'} onChange={e => { const c = [...columns]; c[i] = { ...c[i], direction: e.target.value }; onChange({ columns: c }) }}>
              <MenuItem value="asc">ASC ↑</MenuItem>
              <MenuItem value="desc">DESC ↓</MenuItem>
            </Select>
          </FormControl>
          <IconButton size="small" sx={{ mt: 0.5 }} onClick={() => onChange({ columns: columns.filter((_, j) => j !== i) })}>
            <Close fontSize="small" />
          </IconButton>
        </Box>
      ))}
      <Button size="small" startIcon={<Add />} onClick={() => onChange({ columns: [...columns, { column: '', direction: 'asc' }] })}>
        Add Column
      </Button>
    </Box>
  )
}

function AggregateForm({ config, onChange }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>; onChange: (p: Record<string, any>) => void
}) {
  const aggs: Array<{ column: string; function: string; alias: string }> = config.aggregations ?? []
  const AGG_FNS = ['sum', 'avg', 'count', 'min', 'max', 'first']
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <TextField
        label="Group By (comma-separated columns)"
        size="small" fullWidth
        value={(config.group_by ?? []).join(', ')}
        onChange={e => onChange({ group_by: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })}
        placeholder="date, app_id"
        helperText="Leave blank for global aggregation"
      />
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>Aggregations</Typography>
      {aggs.map((_, i) => (
        <Box key={i} sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-start' }}>
          <TextField label="Column" size="small" sx={{ flex: 2 }}
            value={aggs[i].column}
            onChange={e => { const a = [...aggs]; a[i] = { ...a[i], column: e.target.value }; onChange({ aggregations: a }) }}
          />
          <FormControl size="small" sx={{ flex: 1.5 }}>
            <InputLabel>Fn</InputLabel>
            <Select label="Fn" value={aggs[i].function ?? 'sum'} onChange={e => { const a = [...aggs]; a[i] = { ...a[i], function: e.target.value }; onChange({ aggregations: a }) }}>
              {AGG_FNS.map(f => <MenuItem key={f} value={f}>{f.toUpperCase()}</MenuItem>)}
            </Select>
          </FormControl>
          <TextField label="Alias" size="small" sx={{ flex: 2 }}
            value={aggs[i].alias ?? ''}
            onChange={e => { const a = [...aggs]; a[i] = { ...a[i], alias: e.target.value }; onChange({ aggregations: a }) }}
            placeholder="optional"
          />
          <IconButton size="small" sx={{ mt: 0.5 }} onClick={() => onChange({ aggregations: aggs.filter((_, j) => j !== i) })}>
            <Close fontSize="small" />
          </IconButton>
        </Box>
      ))}
      <Button size="small" startIcon={<Add />} onClick={() => onChange({ aggregations: [...aggs, { column: '', function: 'sum', alias: '' }] })}>
        Add Aggregation
      </Button>
    </Box>
  )
}

function LookupForm({ config, onChange, dictionaries }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>; onChange: (p: Record<string, any>) => void
  dictionaries: Dictionary[]
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <FormControl size="small" fullWidth>
        <InputLabel>Dictionary</InputLabel>
        <Select label="Dictionary" value={config.dict_id ?? ''} onChange={e => onChange({ dict_id: e.target.value || null })}>
          <MenuItem value=""><em>None</em></MenuItem>
          {dictionaries.map(d => (
            <MenuItem key={d.id} value={d.id}>
              <Typography variant="body2" sx={{ fontSize: '0.78rem' }}>{d.name}</Typography>
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <TextField label="Match Column" size="small" fullWidth value={config.match_column ?? ''}
        onChange={e => onChange({ match_column: e.target.value })}
        helperText="Column in the data to look up" />
      <TextField label="Output Column" size="small" fullWidth value={config.output_column ?? ''}
        onChange={e => onChange({ output_column: e.target.value })}
        helperText="Column to write the looked-up value into" />
      <TextField label="Default Value" size="small" fullWidth value={config.default_value ?? ''}
        onChange={e => onChange({ default_value: e.target.value })}
        helperText="Value when no match is found" />
    </Box>
  )
}

function LoadParquetForm({ config, onChange }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>; onChange: (p: Record<string, any>) => void
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <TextField
        label="Output Path Template"
        size="small" fullWidth
        value={config.path_template ?? ''}
        onChange={e => onChange({ path_template: e.target.value })}
        placeholder="{business_date}/{pipeline_name}/{app_id}"
        slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: '0.72rem' } } }}
        helperText="Supports {app_id}, {app_name}, {business_date} from connected Iterator"
      />
      <TextField
        label="Fixed Output Directory"
        size="small" fullWidth
        value={config.output_dir ?? ''}
        onChange={e => onChange({ output_dir: e.target.value })}
        placeholder="Leave blank to use path template"
        helperText="Relative to data/pipeline/parquet/ — overrides template if set"
      />
      <TextField
        label="Partition By (comma separated)"
        size="small" fullWidth
        value={(config.partition_by ?? []).join(', ')}
        onChange={e => onChange({ partition_by: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })}
        placeholder="date, application_id"
      />
      <FormControl size="small" fullWidth>
        <InputLabel>Write Mode</InputLabel>
        <Select label="Write Mode" value={config.mode ?? 'overwrite'} onChange={e => onChange({ mode: e.target.value })}>
          <MenuItem value="overwrite">Overwrite</MenuItem>
          <MenuItem value="append">Append</MenuItem>
        </Select>
      </FormControl>
    </Box>
  )
}

function LoadSQLForm({ config, onChange, defaultDatabase }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>; onChange: (p: Record<string, any>) => void
  defaultDatabase: string
}) {
  const dbValue = (config.namespace_db ?? config.database ?? '').toString()
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <TextField
        label="Database"
        size="small"
        fullWidth
        value={dbValue || defaultDatabase}
        onChange={e => onChange({ namespace_db: e.target.value, database: e.target.value })}
        helperText={`Defaults to ${defaultDatabase}`}
      />
      <TextField label="Table Name" size="small" fullWidth value={config.table_name ?? ''} onChange={e => onChange({ table_name: e.target.value })} />
      <FormControl size="small" fullWidth>
        <InputLabel>Write Mode</InputLabel>
        <Select label="Write Mode" value={config.mode ?? 'overwrite'} onChange={e => onChange({ mode: e.target.value })}>
          <MenuItem value="overwrite">Overwrite</MenuItem>
          <MenuItem value="append">Append</MenuItem>
        </Select>
      </FormControl>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Node properties panel
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Iterator node form — pick dictionary, select entries, map params
// ─────────────────────────────────────────────────────────────────────────────

interface IteratorPreviewStep {
  id: string
  label: string
  type: string
  color: string
}

interface IteratorPreviewBranch {
  key: string
  value: string
  params: { key: string; value: string }[]
  output?: string
}

interface IteratorPreviewModel {
  iteratorLabel: string
  dictName?: string
  keyParam: string
  valueParam: string
  totalBranches: number
  steps: IteratorPreviewStep[]
  branches: IteratorPreviewBranch[]
  warnings: string[]
}

interface ExecutionPlanForkPreview {
  iteratorNodeId: string
  iteratorLabel: string
  dictName?: string
  keyParam: string
  valueParam: string
  totalBranches: number
  branches: IteratorPreviewBranch[]
  branchSteps: IteratorPreviewStep[]
  mergeStep?: IteratorPreviewStep
  postMergeSteps: IteratorPreviewStep[]
  warnings: string[]
}

interface ExecutionPlanLane {
  id: string
  label: string
  steps: IteratorPreviewStep[]
  iteratorPreviews: ExecutionPlanForkPreview[]
  warnings: string[]
}

interface ExecutionPlanModel {
  pipelineLabel: string
  totalNodes: number
  totalEdges: number
  lanes: ExecutionPlanLane[]
  warnings: string[]
}

function ExecutionPlanDialog({
  open,
  onClose,
  plan,
}: {
  open: boolean
  onClose: () => void
  plan: ExecutionPlanModel
}) {
  const theme = useTheme()

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>Execution Plan</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Alert severity="info" sx={{ py: 0.5 }}>
          End-to-end preview of planned execution flow. No run will be started.
        </Alert>

        {plan.warnings.map((warning, i) => (
          <Alert key={i} severity="warning" sx={{ py: 0.5 }}>
            {warning}
          </Alert>
        ))}

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          <Chip label={`Pipeline: ${plan.pipelineLabel || 'Untitled pipeline'}`} size="small" />
          <Chip label={`${plan.totalNodes} node${plan.totalNodes !== 1 ? 's' : ''}`} size="small" />
          <Chip label={`${plan.totalEdges} edge${plan.totalEdges !== 1 ? 's' : ''}`} size="small" />
          <Chip label={`${plan.lanes.length} execution path${plan.lanes.length !== 1 ? 's' : ''}`} size="small" color="secondary" />
        </Box>

        {plan.lanes.length === 0 ? (
          <Typography variant="caption" color="text.secondary">
            No nodes in the canvas. Add nodes to build an execution plan.
          </Typography>
        ) : (
          plan.lanes.map(lane => (
            <Paper key={lane.id} variant="outlined" sx={{ p: 1.25 }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {lane.label}
              </Typography>

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', mt: 1 }}>
                {lane.steps.map((step, index) => (
                  <Box key={step.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    {index > 0 && <Typography sx={{ fontSize: '0.78rem', color: 'text.disabled' }}>→</Typography>}
                    <Box
                      sx={{
                        px: 1,
                        py: 0.75,
                        borderRadius: 1,
                        border: `1px solid ${alpha(step.color, 0.35)}`,
                        bgcolor: alpha(step.color, 0.1),
                        minWidth: 110,
                      }}
                    >
                      <Typography sx={{ fontSize: '0.62rem', color: step.color, fontWeight: 700, textTransform: 'uppercase' }}>
                        {CATALOG_MAP[step.type]?.label ?? step.type}
                      </Typography>
                      <Typography sx={{ fontSize: '0.74rem', fontWeight: 600 }} noWrap>
                        {step.label}
                      </Typography>
                    </Box>
                  </Box>
                ))}
              </Box>

              {lane.warnings.map((warning, i) => (
                <Alert key={i} severity="warning" sx={{ mt: 1, py: 0.4 }}>
                  {warning}
                </Alert>
              ))}

              {lane.iteratorPreviews.map(iter => {
                const visibleBranches = iter.branches.slice(0, 8)
                const hiddenCount = Math.max(0, iter.totalBranches - visibleBranches.length)
                return (
                  <Box key={iter.iteratorNodeId} sx={{ mt: 1.25 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Fork Preview · {iter.iteratorLabel}
                    </Typography>

                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.6, mt: 0.5 }}>
                      <Chip label={`Dictionary: ${iter.dictName ?? '—'}`} size="small" />
                      <Chip label={`${iter.totalBranches} fork${iter.totalBranches !== 1 ? 's' : ''}`} size="small" color="secondary" />
                      <Chip label={`$${iter.keyParam} / $${iter.valueParam}`} size="small" sx={{ fontFamily: 'monospace' }} />
                    </Box>

                    {iter.warnings.map((warning, i) => (
                      <Alert key={i} severity="warning" sx={{ mt: 0.8, py: 0.35 }}>
                        {warning}
                      </Alert>
                    ))}

                    <Box sx={{ mt: 0.8 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Fork Diagram
                      </Typography>
                      <Box sx={{ mt: 0.5, overflowX: 'auto' }}>
                        {(() => {
                          const stepCols: Array<{ key: string; title: string }> = [
                            { key: 'iterator', title: 'Iterator' },
                            { key: 'branch', title: `Fork (${iter.keyParam})` },
                            ...iter.branchSteps.map((step, idx) => ({
                              key: `branch-step-${idx}`,
                              title: CATALOG_MAP[step.type]?.label ?? step.type,
                            })),
                            ...(iter.mergeStep ? [{ key: 'merge', title: 'Aggregate (Merge)' }] : []),
                            ...iter.postMergeSteps.map((step, idx) => ({
                              key: `post-step-${idx}`,
                              title: CATALOG_MAP[step.type]?.label ?? step.type,
                            })),
                          ]

                          const colCount = Math.max(stepCols.length, 2)
                          const minDiagramWidth = colCount * 180

                          return (
                            <Box sx={{ minWidth: minDiagramWidth, display: 'flex', flexDirection: 'column', gap: 0.6 }}>
                              <Box
                                sx={{
                                  display: 'grid',
                                  gridTemplateColumns: `repeat(${colCount}, minmax(160px, 1fr))`,
                                  gap: 0.6,
                                }}
                              >
                                {stepCols.map((col, idx) => (
                                  <Paper key={col.key} variant="outlined" sx={{ px: 0.75, py: 0.5, bgcolor: alpha(theme.palette.info.main, 0.06) }}>
                                    <Typography sx={{ fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'text.secondary', fontWeight: 700 }}>
                                      Step {idx + 1}
                                    </Typography>
                                    <Typography sx={{ fontSize: '0.68rem', fontWeight: 600 }} noWrap>
                                      {col.title}
                                    </Typography>
                                  </Paper>
                                ))}
                              </Box>

                              {/* Single iterator start row */}
                              <Box
                                sx={{
                                  display: 'grid',
                                  gridTemplateColumns: `repeat(${colCount}, minmax(160px, 1fr))`,
                                  gap: 0.6,
                                }}
                              >
                                <Box sx={{
                                  px: 1,
                                  py: 0.65,
                                  borderRadius: 1,
                                  border: `1px solid ${alpha(ORCHESTRATION_COLOR, 0.35)}`,
                                  bgcolor: alpha(ORCHESTRATION_COLOR, 0.1),
                                }}>
                                  <Typography sx={{ fontSize: '0.62rem', color: ORCHESTRATION_COLOR, fontWeight: 700, textTransform: 'uppercase' }}>
                                    Iterator
                                  </Typography>
                                  <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }} noWrap>
                                    {iter.iteratorLabel}
                                  </Typography>
                                </Box>
                                {Array.from({ length: colCount - 1 }).map((_, i) => (
                                  <Box
                                    key={`iter-empty-${i}`}
                                    sx={{
                                      border: `1px dashed ${theme.palette.divider}`,
                                      borderRadius: 1,
                                      minHeight: 46,
                                    }}
                                  />
                                ))}
                              </Box>

                              {/* Branch rows */}
                              {visibleBranches.map((branch, index) => (
                                <Box
                                  key={`${iter.iteratorNodeId}-diagram-${branch.key}-${index}`}
                                  sx={{
                                    display: 'grid',
                                    gridTemplateColumns: `repeat(${colCount}, minmax(160px, 1fr))`,
                                    gap: 0.6,
                                  }}
                                >
                                  <Box sx={{ border: `1px dashed ${theme.palette.divider}`, borderRadius: 1, minHeight: 46, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <Box sx={{ position: 'relative', width: '76%', height: 2, bgcolor: alpha(theme.palette.text.secondary, 0.55), borderRadius: 999 }}>
                                      <Box
                                        sx={{
                                          position: 'absolute',
                                          right: -1,
                                          top: '50%',
                                          transform: 'translateY(-50%)',
                                          width: 0,
                                          height: 0,
                                          borderTop: '5px solid transparent',
                                          borderBottom: '5px solid transparent',
                                          borderLeft: `8px solid ${alpha(theme.palette.text.secondary, 0.75)}`,
                                        }}
                                      />
                                    </Box>
                                  </Box>
                                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', px: 0.75 }}>
                                    <Box
                                      sx={{
                                        width: '100%',
                                        px: 0.8,
                                        py: 0.45,
                                        borderRadius: 1,
                                        border: `1px solid ${alpha(theme.palette.secondary.main, 0.35)}`,
                                        bgcolor: alpha(theme.palette.secondary.main, 0.12),
                                      }}
                                    >
                                      <Typography sx={{ fontSize: '0.58rem', color: 'secondary.main', fontWeight: 700, textTransform: 'uppercase' }}>
                                        Fork
                                      </Typography>
                                      <Typography sx={{ fontFamily: 'monospace', fontSize: '0.67rem', fontWeight: 700 }} noWrap>
                                        {iter.keyParam}: {branch.key}
                                      </Typography>
                                      <Typography sx={{ fontFamily: 'monospace', fontSize: '0.64rem', color: 'text.secondary' }} noWrap>
                                        {iter.valueParam}: {branch.value}
                                      </Typography>
                                    </Box>
                                  </Box>

                                  {iter.branchSteps.map((step, stepIdx) => (
                                    <Box
                                      key={`${branch.key}-${step.id}-${stepIdx}`}
                                      sx={{
                                        px: 1,
                                        py: 0.65,
                                        borderRadius: 1,
                                        border: `1px solid ${alpha(step.color, 0.35)}`,
                                        bgcolor: alpha(step.color, 0.1),
                                      }}
                                    >
                                      <Typography sx={{ fontSize: '0.62rem', color: step.color, fontWeight: 700, textTransform: 'uppercase' }}>
                                        {CATALOG_MAP[step.type]?.label ?? step.type}
                                      </Typography>
                                      <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }} noWrap>
                                        {step.label}
                                      </Typography>
                                    </Box>
                                  ))}

                                  {Array.from({ length: colCount - (2 + iter.branchSteps.length) }).map((_, i) => (
                                    <Box
                                      key={`${branch.key}-tail-empty-${i}`}
                                      sx={{
                                        border: `1px dashed ${theme.palette.divider}`,
                                        borderRadius: 1,
                                        minHeight: 46,
                                      }}
                                    />
                                  ))}
                                </Box>
                              ))}

                              {/* Single merge/load end row */}
                              {(iter.mergeStep || iter.postMergeSteps.length > 0) && (
                                <Box
                                  sx={{
                                    display: 'grid',
                                    gridTemplateColumns: `repeat(${colCount}, minmax(160px, 1fr))`,
                                    gap: 0.6,
                                  }}
                                >
                                  {Array.from({ length: 2 + iter.branchSteps.length }).map((_, i) => (
                                    <Box
                                      key={`pre-merge-empty-${i}`}
                                      sx={{
                                        border: `1px dashed ${theme.palette.divider}`,
                                        borderRadius: 1,
                                        minHeight: 46,
                                      }}
                                    />
                                  ))}

                                  {iter.mergeStep && (
                                    <Box
                                      sx={{
                                        px: 1,
                                        py: 0.65,
                                        borderRadius: 1,
                                        border: `1px solid ${alpha(iter.mergeStep.color, 0.45)}`,
                                        bgcolor: alpha(iter.mergeStep.color, 0.16),
                                      }}
                                    >
                                      <Typography sx={{ fontSize: '0.62rem', color: iter.mergeStep.color, fontWeight: 700, textTransform: 'uppercase' }}>
                                        Aggregate (Merge)
                                      </Typography>
                                      <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }} noWrap>
                                        {iter.mergeStep.label}
                                      </Typography>
                                    </Box>
                                  )}

                                  {iter.postMergeSteps.map((step, stepIdx) => (
                                    <Box
                                      key={`${iter.iteratorNodeId}-post-${step.id}-${stepIdx}`}
                                      sx={{
                                        px: 1,
                                        py: 0.65,
                                        borderRadius: 1,
                                        border: `1px solid ${alpha(step.color, 0.35)}`,
                                        bgcolor: alpha(step.color, 0.1),
                                      }}
                                    >
                                      <Typography sx={{ fontSize: '0.62rem', color: step.color, fontWeight: 700, textTransform: 'uppercase' }}>
                                        {CATALOG_MAP[step.type]?.label ?? step.type}
                                      </Typography>
                                      <Typography sx={{ fontSize: '0.7rem', fontWeight: 600 }} noWrap>
                                        {step.label}
                                      </Typography>
                                    </Box>
                                  ))}
                                </Box>
                              )}
                            </Box>
                          )
                        })()}
                      </Box>
                    </Box>

                    {hiddenCount > 0 && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.8 }}>
                        +{hiddenCount} more fork{hiddenCount !== 1 ? 's' : ''}
                      </Typography>
                    )}
                  </Box>
                )
              })}
            </Paper>
          ))
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} autoFocus>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

function IteratorPreviewDialog({
  open,
  onClose,
  preview,
}: {
  open: boolean
  onClose: () => void
  preview: IteratorPreviewModel | null
}) {
  const theme = useTheme()

  if (!preview) return null

  const visibleBranches = preview.branches.slice(0, 12)
  const hiddenCount = Math.max(0, preview.totalBranches - visibleBranches.length)

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>Iterator Preview</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Alert severity="info" sx={{ py: 0.5 }}>
          Preview only. No pipeline run will be started.
        </Alert>

        {preview.warnings.map((warning, i) => (
          <Alert key={i} severity="warning" sx={{ py: 0.5 }}>
            {warning}
          </Alert>
        ))}

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          <Chip label={`Dictionary: ${preview.dictName ?? '—'}`} size="small" />
          <Chip
            label={`${preview.totalBranches} fork${preview.totalBranches !== 1 ? 's' : ''}`}
            size="small"
            color="secondary"
          />
          <Chip
            label={`$${preview.keyParam} / $${preview.valueParam}`}
            size="small"
            sx={{ fontFamily: 'monospace' }}
          />
        </Box>

        <Paper
          variant="outlined"
          sx={{
            p: 1.25,
            borderColor: alpha(ORCHESTRATION_COLOR, 0.3),
            bgcolor: alpha(ORCHESTRATION_COLOR, 0.04),
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Flow
          </Typography>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', mt: 1 }}>
            <Box
              sx={{
                px: 1,
                py: 0.75,
                borderRadius: 1,
                border: `1px solid ${alpha(ORCHESTRATION_COLOR, 0.35)}`,
                bgcolor: alpha(ORCHESTRATION_COLOR, 0.12),
                minWidth: 100,
              }}
            >
              <Typography sx={{ fontSize: '0.62rem', color: ORCHESTRATION_COLOR, fontWeight: 700, textTransform: 'uppercase' }}>
                Iterator
              </Typography>
              <Typography sx={{ fontSize: '0.74rem', fontWeight: 600 }} noWrap>
                {preview.iteratorLabel}
              </Typography>
            </Box>

            {preview.steps.length === 0 ? (
              <Typography variant="caption" color="text.secondary">
                No downstream nodes connected
              </Typography>
            ) : (
              preview.steps.map(step => (
                <Box key={step.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <Typography sx={{ fontSize: '0.78rem', color: 'text.disabled' }}>→</Typography>
                  <Box
                    sx={{
                      px: 1,
                      py: 0.75,
                      borderRadius: 1,
                      border: `1px solid ${alpha(step.color, 0.35)}`,
                      bgcolor: alpha(step.color, 0.1),
                      minWidth: 108,
                    }}
                  >
                    <Typography sx={{ fontSize: '0.62rem', color: step.color, fontWeight: 700, textTransform: 'uppercase' }}>
                      {CATALOG_MAP[step.type]?.label ?? step.type}
                    </Typography>
                    <Typography sx={{ fontSize: '0.74rem', fontWeight: 600 }} noWrap>
                      {step.label}
                    </Typography>
                  </Box>
                </Box>
              ))
            )}
          </Box>
        </Paper>

        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Fork Preview
          </Typography>

          <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {visibleBranches.map((branch, index) => (
              <Box
                key={`${branch.key}-${index}`}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '24px 1fr',
                  gap: 1,
                  alignItems: 'stretch',
                }}
              >
                <Box sx={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 0,
                      bottom: index === visibleBranches.length - 1 && hiddenCount === 0 ? '50%' : 0,
                      width: 2,
                      bgcolor: theme.palette.divider,
                    }}
                  />
                  <Box
                    sx={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      bgcolor: ORCHESTRATION_COLOR,
                      mt: 2,
                      zIndex: 1,
                    }}
                  />
                </Box>

                <Paper variant="outlined" sx={{ p: 1.25 }}>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 0.75 }}>
                    {branch.params.map(param => (
                      <Chip
                        key={param.key}
                        label={`$${param.key} = ${param.value}`}
                        size="small"
                        sx={{ fontFamily: 'monospace', fontSize: '0.64rem' }}
                      />
                    ))}
                  </Box>

                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                    {preview.steps.length === 0 ? (
                      <Typography variant="caption" color="text.secondary">
                        No downstream flow connected
                      </Typography>
                    ) : (
                      preview.steps.map(step => (
                        <Box key={`${branch.key}-${step.id}`} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                          <Typography sx={{ fontSize: '0.78rem', color: 'text.disabled' }}>→</Typography>
                          <Box
                            sx={{
                              px: 0.9,
                              py: 0.6,
                              borderRadius: 1,
                              border: `1px solid ${alpha(step.color, 0.35)}`,
                              bgcolor: alpha(step.color, 0.08),
                            }}
                          >
                            <Typography sx={{ fontSize: '0.68rem', fontWeight: 600 }} noWrap>
                              {step.label}
                            </Typography>
                          </Box>
                        </Box>
                      ))
                    )}
                  </Box>

                </Paper>
              </Box>
            ))}
          </Box>

          {hiddenCount > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              +{hiddenCount} more fork{hiddenCount !== 1 ? 's' : ''}
            </Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} autoFocus>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

function IteratorForm({ config, onChange, dictionaries, onPreview }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>; onChange: (p: Record<string, any>) => void
  dictionaries: Dictionary[]
  onPreview: () => IteratorPreviewModel
}) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewModel, setPreviewModel] = useState<IteratorPreviewModel | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const selectedDict = dictionaries.find(d => d.id === Number(config.dictionary_id))
  const selectedKeys: string[] = config.selected_keys ?? []
  const entryFilters: IteratorEntryFilter[] = (config.entry_filters ?? [])
    .filter((f: { column?: string; value?: string }) => f?.column && f?.value)
    .map((f: { column?: string; value?: string }) => ({
      column: String(f.column).trim(),
      value: String(f.value).trim(),
    }))
  const [pendingFilterColumn, setPendingFilterColumn] = useState('')
  const [pendingFilterValue, setPendingFilterValue] = useState('')
  const [isFilterEditorOpen, setIsFilterEditorOpen] = useState(false)

  const availableExtraColumns = useMemo(() => {
    if (!selectedDict) return [] as string[]
    const columns = new Set<string>(selectedDict.extra_columns ?? [])
    selectedDict.entries.forEach(entry => {
      Object.keys(entry.extra ?? {}).forEach(col => columns.add(col))
    })
    return Array.from(columns).sort((a, b) => a.localeCompare(b))
  }, [selectedDict])

  const filterValuesByColumn = useMemo(() => {
    const map: Record<string, string[]> = {}
    if (!selectedDict) return map
    for (const column of availableExtraColumns) {
      const values = new Set<string>()
      selectedDict.entries.forEach(entry => {
        const value = String((entry.extra ?? {})[column] ?? '').trim()
        if (value) values.add(value)
      })
      map[column] = Array.from(values).sort((a, b) => a.localeCompare(b))
    }
    return map
  }, [selectedDict, availableExtraColumns])

  const activeEntries = getIteratorActiveEntries(selectedDict, selectedKeys, entryFilters)
  const activeKeys = activeEntries.map(e => e.key)

  const toggleEntry = (key: string) => {
    if (selectedKeys.length === 0) {
      // Was "all" — now explicitly deselect this one by listing all others
      const allKeys = selectedDict?.entries.map(e => e.key) ?? []
      onChange({ selected_keys: allKeys.filter(k => k !== key) })
    } else if (selectedKeys.includes(key)) {
      const next = selectedKeys.filter(k => k !== key)
      // If all remaining === all entries, reset to empty (= all)
      const allKeys = selectedDict?.entries.map(e => e.key) ?? []
      onChange({ selected_keys: next.length === allKeys.length ? [] : next })
    } else {
      onChange({ selected_keys: [...selectedKeys, key] })
    }
  }

  const selectAll = () => onChange({ selected_keys: [] })
  const addEntryFilter = () => {
    const column = pendingFilterColumn.trim()
    const value = pendingFilterValue.trim()
    if (!column || !value) return
    const exists = entryFilters.some(f => f.column === column && f.value === value)
    if (exists) return
    onChange({ entry_filters: [...entryFilters, { column, value }] })
    setPendingFilterColumn('')
    setPendingFilterValue('')
    setIsFilterEditorOpen(false)
  }

  const removeEntryFilter = (idx: number) => {
    const next = entryFilters.filter((_, i) => i !== idx)
    onChange({ entry_filters: next })
  }

  const handlePreview = () => {
    try {
      setPreviewError(null)
      setPreviewModel(onPreview())
      setPreviewOpen(true)
    } catch (e) { setPreviewError(String(e)) }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}>
      {/* Dictionary picker */}
      <FormControl size="small" fullWidth>
        <InputLabel>Dictionary</InputLabel>
        <Select label="Dictionary" value={config.dictionary_id ?? ''}
          onChange={e => {
            const dictId = Number(e.target.value)
            const dict = dictionaries.find(d => d.id === dictId)
            onChange({ dictionary_id: dictId || null, selected_keys: [], entry_filters: [], dict_name: dict?.name ?? null })
            setPendingFilterColumn('')
            setPendingFilterValue('')
            setIsFilterEditorOpen(false)
          }}>
          <MenuItem value=""><em>None</em></MenuItem>
          {dictionaries.map(d => (
            <MenuItem key={d.id} value={d.id}>
              <Box>
                <Typography variant="body2" sx={{ fontSize: '0.78rem' }}>{d.name}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
                  {d.entries.length} entries · {d.key_label} / {d.value_label}
                </Typography>
              </Box>
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Param name mapping */}
      {selectedDict && (
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField size="small" fullWidth
            label={`${selectedDict.key_label} → $param`}
            value={config.key_param ?? selectedDict.key_label.toLowerCase().replace(/\s+/g, '_')}
            onChange={e => onChange({ key_param: e.target.value })}
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: '0.72rem' } } }}
            helperText="SQL param name for key column" />
          <TextField size="small" fullWidth
            label={`${selectedDict.value_label} → $param`}
            value={config.value_param ?? selectedDict.value_label.toLowerCase().replace(/\s+/g, '_')}
            onChange={e => onChange({ value_param: e.target.value })}
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: '0.72rem' } } }}
            helperText="SQL param name for value column" />
        </Box>
      )}

      <Divider />

      {/* Entry selection */}
      {selectedDict ? (
        <Box>
          {availableExtraColumns.length > 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mb: 0.8 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="caption" color="text.secondary"
                  sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.6rem', fontWeight: 700 }}>
                  Entry filters {entryFilters.length > 0 ? `(${entryFilters.length})` : ''}
                </Typography>
                {!isFilterEditorOpen ? (
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => setIsFilterEditorOpen(true)}
                    sx={{ fontSize: '0.66rem', minWidth: 0, px: 0.75 }}
                  >
                    Add filter
                  </Button>
                ) : (
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => {
                      setIsFilterEditorOpen(false)
                      setPendingFilterColumn('')
                      setPendingFilterValue('')
                    }}
                    sx={{ fontSize: '0.66rem', minWidth: 0, px: 0.75 }}
                  >
                    Cancel
                  </Button>
                )}
              </Box>

              {isFilterEditorOpen && (
                <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center', flexWrap: 'wrap' }}>
                  <FormControl size="small" sx={{ minWidth: 140, flex: '0 0 160px' }}>
                    <InputLabel>Column</InputLabel>
                    <Select
                      label="Column"
                      value={pendingFilterColumn}
                      onChange={e => {
                        const col = String(e.target.value || '')
                        setPendingFilterColumn(col)
                        setPendingFilterValue('')
                      }}
                    >
                      <MenuItem value=""><em>Select</em></MenuItem>
                      {availableExtraColumns.map(col => (
                        <MenuItem key={col} value={col}>{col}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>

                  <Autocomplete
                    size="small"
                    freeSolo
                    sx={{ minWidth: 180, flex: '1 1 240px' }}
                    value={pendingFilterValue}
                    options={pendingFilterColumn ? (filterValuesByColumn[pendingFilterColumn] ?? []) : []}
                    onInputChange={(_, value) => setPendingFilterValue(value)}
                    renderInput={(params) => <TextField {...params} label="Value" placeholder="Type value" />}
                  />

                  <Button size="small" variant="outlined" onClick={addEntryFilter}>
                    Add
                  </Button>
                </Box>
              )}

              {entryFilters.length > 0 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                  {entryFilters.map((filter, idx) => (
                    <Chip
                      key={`${filter.column}-${filter.value}-${idx}`}
                      size="small"
                      label={`${filter.column}: ${filter.value}`}
                      onDelete={() => removeEntryFilter(idx)}
                      sx={{ fontFamily: 'monospace', fontSize: '0.65rem', height: 20 }}
                    />
                  ))}
                  <Chip
                    size="small"
                    variant="outlined"
                    label="Clear"
                    onClick={() => {
                      onChange({ entry_filters: [] })
                      setIsFilterEditorOpen(false)
                      setPendingFilterColumn('')
                      setPendingFilterValue('')
                    }}
                    sx={{ fontSize: '0.62rem', height: 20, cursor: 'pointer' }}
                  />
                </Box>
              )}
            </Box>
          )}

          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary"
              sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.6rem', fontWeight: 700 }}>
              Entries to iterate ({activeKeys.length} of {selectedDict.entries.length})
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              <Chip label="All" size="small" onClick={selectAll}
                variant={selectedKeys.length === 0 ? 'filled' : 'outlined'}
                sx={{ fontSize: '0.6rem', height: 18, cursor: 'pointer' }} />
            </Box>
          </Box>
          <Box sx={{
            border: '1px solid', borderColor: 'divider', borderRadius: 1,
            maxHeight: 200, overflowY: 'auto',
          }}>
            {activeEntries.map(entry => {
              const checked = selectedKeys.length === 0 || selectedKeys.includes(entry.key)
              const extra = entry.extra ?? {}
              const appTypeColumn = Object.keys(extra).find(col => {
                const normalized = col.toLowerCase()
                return normalized === 'app_type' || normalized === 'type'
              })
              const appTypeValue = appTypeColumn ? String(extra[appTypeColumn] ?? '').trim() : ''
              const extraPairs = availableExtraColumns
                .filter(col => col !== appTypeColumn)
                .map(col => ({ col, val: String(extra[col] ?? '').trim() }))
                .filter(item => item.val.length > 0)
              return (
                <Box
                  key={entry.id}
                  onClick={() => toggleEntry(entry.key)}
                  sx={{
                    display: 'flex', alignItems: 'flex-start', gap: 1, px: 1, py: 0.5,
                    cursor: 'pointer', borderBottom: '1px solid', borderColor: 'divider',
                    '&:last-child': { borderBottom: 'none' },
                    '&:hover': { bgcolor: 'action.hover' },
                    bgcolor: checked ? 'action.selected' : 'transparent',
                  }}
                >
                  <Checkbox
                    checked={checked}
                    size="small"
                    sx={{ p: 0 }}
                    icon={<CheckBoxOutlineBlank sx={{ fontSize: 16 }} />}
                    checkedIcon={<CheckBox sx={{ fontSize: 16 }} />}
                  />
                  <Box sx={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 0.75, overflow: 'hidden' }}>
                    <Typography sx={{ fontFamily: 'monospace', fontSize: '0.72rem', fontWeight: 600, flexShrink: 0 }}>
                      {entry.key}
                    </Typography>
                    <Typography sx={{ fontSize: '0.68rem', color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {entry.value}
                    </Typography>
                    {appTypeValue && (
                      <Chip
                        size="small"
                        label={appTypeValue}
                        sx={{ fontSize: '0.58rem', height: 17, fontFamily: 'monospace', flexShrink: 0 }}
                        color="secondary"
                        variant="outlined"
                      />
                    )}
                    {extraPairs.slice(0, 2).map(item => (
                      <Chip
                        key={`${entry.id}-${item.col}`}
                        size="small"
                        label={`${item.col}: ${item.val}`}
                        sx={{ fontSize: '0.58rem', height: 17, fontFamily: 'monospace', flexShrink: 0 }}
                        variant="outlined"
                      />
                    ))}
                    {extraPairs.length > 2 && (
                      <Chip
                        size="small"
                        label={`+${extraPairs.length - 2}`}
                        sx={{ fontSize: '0.58rem', height: 17, flexShrink: 0 }}
                        variant="outlined"
                      />
                    )}
                  </Box>
                </Box>
              )
            })}
            {selectedDict.entries.length === 0 && (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography variant="caption" color="text.disabled">No entries in this dictionary</Typography>
              </Box>
            )}
            {selectedDict.entries.length > 0 && activeEntries.length === 0 && (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography variant="caption" color="text.disabled">No entries match current filters</Typography>
              </Box>
            )}
          </Box>
        </Box>
      ) : (
        <Typography variant="caption" color="text.disabled">Select a dictionary above to choose entries</Typography>
      )}

      <Divider />

      {/* Preview button */}
      <Button
        variant="outlined" size="small" fullWidth
        startIcon={<Visibility sx={{ fontSize: 14 }} />}
        onClick={handlePreview}
        disabled={!selectedDict || activeKeys.length === 0}
        sx={{ fontSize: '0.72rem' }}
      >
        Preview Iterator
      </Button>

      <Typography variant="caption" color="text.secondary">
        Shows the iterator fan-out and downstream path for each selected entry.
      </Typography>

      {previewError && <Alert severity="error" sx={{ fontSize: '0.72rem', py: 0.25, wordBreak: 'break-word' }}>{previewError}</Alert>}

      <IteratorPreviewDialog open={previewOpen} onClose={() => setPreviewOpen(false)} preview={previewModel} />
    </Box>
  )
}

function PropertiesPanel({
  node, onUpdateConfig, connections, sqlFiles, dictionaries, notebooks, onOpenSqlEditor, onPreviewIterator, nodes, edges, pipelineName, businessDate,
}: {
  node: Node<PipelineNodeData>
  onUpdateConfig: (nodeId: string, patch: Record<string, unknown>) => void
  connections: Connection[]
  sqlFiles: SqlFile[]
  notebooks: NotebookFile[]
  onOpenSqlEditor: () => void
  onPreviewIterator: (nodeId: string) => IteratorPreviewModel
  dictionaries: Dictionary[]
  nodes: Node<PipelineNodeData>[]
  edges: Edge[]
  pipelineName: string
  businessDate?: string
}) {
  const nodeById = useMemo(
    () => new Map(nodes.map(n => [n.id, n])),
    [nodes],
  )
  const incomingNodeIds = useMemo(
    () => edges.filter(e => e.target === node.id).map(e => e.source),
    [edges, node.id],
  )
  const outgoingNodeIds = useMemo(
    () => edges.filter(e => e.source === node.id).map(e => e.target),
    [edges, node.id],
  )

  const findUpstreamIterator = useCallback((): Node<PipelineNodeData> | null => {
    const visited = new Set<string>()
    const queue = [...incomingNodeIds]
    while (queue.length > 0) {
      const currentId = queue.shift()!
      if (visited.has(currentId)) continue
      visited.add(currentId)
      const current = nodeById.get(currentId)
      if (!current) continue
      if (current.data.nodeType === 'iterator') return current
      const parents = edges.filter(e => e.target === currentId).map(e => e.source)
      queue.push(...parents)
    }
    return null
  }, [incomingNodeIds, nodeById, edges])

  const ioPreview = useMemo(() => {
    const nodeName = node.data.label || CATALOG_MAP[node.data.nodeType]?.label || node.data.nodeType
    const upstream = incomingNodeIds
      .map(id => nodeById.get(id))
      .filter((n): n is Node<PipelineNodeData> => Boolean(n))
    const downstream = outgoingNodeIds
      .map(id => nodeById.get(id))
      .filter((n): n is Node<PipelineNodeData> => Boolean(n))

    const inputs: string[] = []
    const outputs: string[] = []

    if (upstream.length > 0) {
      inputs.push(`From: ${upstream.map(n => n.data.label || CATALOG_MAP[n.data.nodeType]?.label || n.data.nodeType).join(', ')}`)
    } else {
      inputs.push('From: Pipeline start')
    }

    if (downstream.length > 0) {
      outputs.push(`To: ${downstream.map(n => n.data.label || CATALOG_MAP[n.data.nodeType]?.label || n.data.nodeType).join(', ')}`)
    } else {
      outputs.push('To: Final output sink')
    }

    if (node.data.nodeType === 'iterator') {
      const dict = dictionaries.find(d => d.id === Number(node.data.config?.dictionary_id))
      const selectedKeys: string[] = node.data.config?.selected_keys ?? []
      const entryFilters: IteratorEntryFilter[] = (node.data.config?.entry_filters ?? [])
        .filter((f: { column?: string; value?: string }) => f?.column && f?.value)
      const activeKeys = getIteratorActiveEntries(dict, selectedKeys, entryFilters).map(e => e.key)
      const keyParam = node.data.config?.key_param ?? 'app_id'
      const valueParam = node.data.config?.value_param ?? 'app_name'
      inputs.push(`Dictionary: ${dict?.name ?? 'not selected'}`)
      if (entryFilters.length > 0) {
        inputs.push(`Filters: ${entryFilters.map(f => `${f.column}=${f.value}`).join(' ; ')}`)
      }
      outputs.push(`Branches: ${activeKeys.length} (${activeKeys.slice(0, 6).join(', ')}${activeKeys.length > 6 ? ' ...' : ''})`)
      outputs.push(`Params emitted: $${keyParam}, $${valueParam}`)
    }

    if (node.data.nodeType === 'jdbc_extract' || node.data.nodeType === 'dw_extract') {
      const sqlConfigured = Boolean((node.data.config?.sql ?? '').trim() || node.data.config?.sql_file_id)
      inputs.push(sqlConfigured ? 'SQL: configured' : 'SQL: not configured')
      const limit = Number(node.data.config?.limit)
      outputs.push(Number.isFinite(limit) && limit > 0
        ? `Rows: up to ${limit.toLocaleString()} per run`
        : 'Rows: all matching rows')
      outputs.push(`Chunk size: ${(Number(node.data.config?.chunk_size) || 50000).toLocaleString()} rows`)
    }

    if (node.data.nodeType === 'aggregate' || node.data.nodeType === 'load_sql') {
      const iteratorNode = findUpstreamIterator()
      const dict = iteratorNode ? dictionaries.find(d => d.id === Number(iteratorNode.data.config?.dictionary_id)) : undefined
      const selectedKeys: string[] = iteratorNode?.data.config?.selected_keys ?? []
      const entryFilters: IteratorEntryFilter[] = (iteratorNode?.data.config?.entry_filters ?? [])
        .filter((f: { column?: string; value?: string }) => f?.column && f?.value)
      const activeKeys = getIteratorActiveEntries(dict, selectedKeys, entryFilters).map(e => e.key)
      const basePath = `data/pipeline/parquet/{business_date}/${pipelineName || 'pipeline'}`
      inputs.push(`Source root: ${basePath}`)
      if (activeKeys.length > 0) {
        const previewKeys = activeKeys.slice(0, 6)
        inputs.push('Source dirs:')
        previewKeys.forEach(k => inputs.push(`• ${k}`))
        if (activeKeys.length > previewKeys.length) {
          inputs.push(`• +${activeKeys.length - previewKeys.length} more`)
        }
      } else {
        inputs.push('Source dirs:')
        inputs.push('• {app_id}')
      }
    }

    if (node.data.nodeType === 'aggregate') {
      const groupBy = (node.data.config?.group_by ?? []) as string[]
      const aggCount = ((node.data.config?.aggregations ?? []) as unknown[]).length
      inputs.push(groupBy.length > 0 ? `Group by: ${groupBy.join(', ')}` : 'Group by: none (global aggregate)')
      outputs.push(`Aggregations: ${aggCount}`)
      outputs.push(`Output dataset: ${nodeName} (in-memory)`)
    }

    if (node.data.nodeType === 'load_parquet') {
      const pathTemplate = (node.data.config?.path_template ?? '').trim()
      const outputDir = (node.data.config?.output_dir ?? '').trim()
      outputs.push(`Parquet path: ${outputDir || pathTemplate || 'data/pipeline/parquet/{business_date}/{pipeline_name}/{app_id}'}`)
      outputs.push(`Write mode: ${node.data.config?.mode ?? 'overwrite'}`)
    }

    if (node.data.nodeType === 'load_sql') {
      const database = (node.data.config?.namespace_db ?? node.data.config?.database ?? deriveSparkDatabaseName(businessDate)).trim() || deriveSparkDatabaseName(businessDate)
      const table = (node.data.config?.table_name ?? '').trim() || '{table_name}'
      outputs.push(`Spark table: ${database}.${table}`)
      outputs.push(`Write mode: ${node.data.config?.mode ?? 'overwrite'}`)
    }

    if (node.data.nodeType === 'filter' || node.data.nodeType === 'sort' || node.data.nodeType === 'join' || node.data.nodeType === 'lookup' || node.data.nodeType === 'sql_transform' || node.data.nodeType === 'notebook_transform') {
      outputs.push('Output dataset: transformed rows')
    }

    return { inputs, outputs }
  }, [node, incomingNodeIds, outgoingNodeIds, nodeById, dictionaries, findUpstreamIterator, pipelineName, businessDate])

  const cat = CATALOG_MAP[node.data.nodeType]
  const onChange = (patch: Record<string, unknown>) => onUpdateConfig(node.id, patch)

  return (
    <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {/* Node header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>

        <Box sx={{ color: cat?.color ?? '#888', fontSize: 18, display: 'flex' }}>{cat?.icon}</Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            {cat?.label ?? node.data.nodeType}
          </Typography>
        </Box>
      </Box>

      {/* Label */}
      <TextField
        label="Label"
        size="small"
        fullWidth
        value={node.data.label}
        onChange={e => onUpdateConfig(node.id, { label: e.target.value } as Record<string, unknown>)}
      />

      <Divider />

      {/* Type-specific config */}
      {node.data.nodeType === 'iterator' && (
        <IteratorForm config={node.data.config} onChange={onChange} dictionaries={dictionaries}
          onPreview={() => onPreviewIterator(node.id)} />
      )}
      {node.data.nodeType === 'dw_extract' && (
        <DWExtractForm config={node.data.config} onChange={onChange} connections={connections} sqlFiles={sqlFiles} dictionaries={dictionaries} onOpenSqlEditor={onOpenSqlEditor} />
      )}
      {node.data.nodeType === 'jdbc_extract' && (
        <JdbcExtractForm config={node.data.config} onChange={onChange} connections={connections} sqlFiles={sqlFiles} dictionaries={dictionaries} onOpenSqlEditor={onOpenSqlEditor} />
      )}
      {node.data.nodeType === 's3_extract' && (
        <S3ExtractForm config={node.data.config} onChange={onChange} connections={connections} />
      )}
      {node.data.nodeType === 'filter' && (
        <FilterForm config={node.data.config} onChange={onChange} />
      )}
      {node.data.nodeType === 'join' && (
        <JoinForm config={node.data.config} onChange={onChange} />
      )}
      {node.data.nodeType === 'sort' && (
        <SortForm config={node.data.config} onChange={onChange} />
      )}
      {node.data.nodeType === 'aggregate' && (
        <AggregateForm config={node.data.config} onChange={onChange} />
      )}
      {node.data.nodeType === 'lookup' && (
        <LookupForm config={node.data.config} onChange={onChange} dictionaries={dictionaries} />
      )}
      {node.data.nodeType === 'sql_transform' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Alert severity="info" sx={{ fontSize: '0.72rem', py: 0.5 }}>
            SQL Transform requires Spark and is not yet supported in pipeline execution.
          </Alert>
          <FormControl size="small" fullWidth>
            <InputLabel>SQL File</InputLabel>
            <Select label="SQL File" value={node.data.config.sql_file_id ?? ''} onChange={e => onChange({ sql_file_id: e.target.value || null })}>
              <MenuItem value=""><em>None</em></MenuItem>
              {sqlFiles.map(f => <MenuItem key={f.id} value={f.id}><Typography sx={{ fontSize: '0.78rem' }}>{f.name}</Typography></MenuItem>)}
            </Select>
          </FormControl>
        </Box>
      )}
      {node.data.nodeType === 'notebook_transform' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Alert severity="info" sx={{ fontSize: '0.72rem', py: 0.5 }}>
            Notebook Transform runs via Spark Connect. The notebook's <code>result_df</code> is passed to the next step.
          </Alert>
          <FormControl size="small" fullWidth>
            <InputLabel>Notebook</InputLabel>
            <Select
              label="Notebook"
              value={node.data.config.notebook_file_id ?? ''}
              onChange={e => onChange({ notebook_file_id: e.target.value || null })}
            >
              <MenuItem value=""><em>None</em></MenuItem>
              {notebooks.map(n => (
                <MenuItem key={n.id} value={n.id}>
                  <Typography sx={{ fontSize: '0.78rem' }}>{n.name}</Typography>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
      )}
      {node.data.nodeType === 'load_parquet' && (
        <LoadParquetForm config={node.data.config} onChange={onChange} />
      )}
      {node.data.nodeType === 'load_sql' && (
        <LoadSQLForm config={node.data.config} onChange={onChange} defaultDatabase={deriveSparkDatabaseName(businessDate)} />
      )}

      <Divider />

      <Paper variant="outlined" sx={{ p: 1.25, bgcolor: 'action.hover' }}>
        <Typography variant="caption" sx={{ fontWeight: 700, fontSize: '0.64rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Expected I/O (Pre-Run)
        </Typography>
        <Box sx={{ mt: 0.8 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.62rem', fontWeight: 700 }}>Inputs</Typography>
          {ioPreview.inputs.map((line, i) => (
            <Typography key={`in-${i}`} variant="caption" sx={{ display: 'block', fontSize: '0.72rem', lineHeight: 1.35 }}>
              - {line}
            </Typography>
          ))}
        </Box>
        <Box sx={{ mt: 0.8 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.62rem', fontWeight: 700 }}>Outputs</Typography>
          {ioPreview.outputs.map((line, i) => (
            <Typography key={`out-${i}`} variant="caption" sx={{ display: 'block', fontSize: '0.72rem', lineHeight: 1.35 }}>
              - {line}
            </Typography>
          ))}
        </Box>
      </Paper>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Connections panel
// ─────────────────────────────────────────────────────────────────────────────

const CONN_TYPE_LABELS: Record<string, string> = {
  datawarehouse: 'DW',
  jdbc: 'JDBC',
  grpc: 'gRPC',
  rest: 'REST',
  other: 'Other',
}

const EMPTY_FORM = { name: '', description: '', conn_type: 'datawarehouse', host: '', port: '', database: '', username: '', password: '' }

function ConnectionsPanel({ onConnectionsChange }: { onConnectionsChange?: () => void }) {
  const qc = useQueryClient()
  const theme = useTheme()
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null)

  const { data: connections = [], isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
  })

  const refetch = () => {
    qc.invalidateQueries({ queryKey: ['connections'] })
    onConnectionsChange?.()
  }

  const createMut = useMutation({
    mutationFn: (d: typeof form) =>
      connectionsApi.create({ ...d, port: d.port ? Number(d.port) : undefined }),
    onSuccess: () => { refetch(); setEditing(null) },
  })

  const updateMut = useMutation({
    mutationFn: (d: typeof form & { id: number }) =>
      connectionsApi.update(d.id, { ...d, port: d.port ? Number(d.port) : undefined }),
    onSuccess: () => { refetch(); setEditing(null) },
  })

  const deleteMut = useMutation({
    mutationFn: connectionsApi.delete,
    onSuccess: () => { refetch(); setDeleteConfirm(null) },
  })

  function openNew() {
    setForm({ ...EMPTY_FORM })
    setEditing('new')
  }

  function openEdit(c: Connection) {
    setForm({ name: c.name, description: c.description ?? '', conn_type: c.conn_type,
      host: c.host ?? '', port: c.port?.toString() ?? '', database: c.database ?? '',
      username: c.username ?? '', password: '' })
    setEditing(c.id)
  }

  function handleSave() {
    if (editing === 'new') createMut.mutate(form)
    else if (typeof editing === 'number') updateMut.mutate({ ...form, id: editing })
  }

  if (isLoading) return <Box sx={{ p: 2 }}><CircularProgress size={20} /></Box>

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box sx={{ px: 1.5, pt: 1, pb: 0.75, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', fontSize: '0.6rem' }}>
          Connections
        </Typography>
        <Tooltip title="New connection">
          <IconButton size="small" onClick={openNew}><Add sx={{ fontSize: 16 }} /></IconButton>
        </Tooltip>
      </Box>

      <Box sx={{ flex: 1, overflowY: 'auto' }}>
        {connections.length === 0 && editing !== 'new' && (
          <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, display: 'block' }}>
            No connections yet. Click + to add one.
          </Typography>
        )}

        {connections.map(conn => (
          <Box key={conn.id}>
            {editing === conn.id ? (
              <ConnectionForm
                form={form}
                onChange={p => setForm(f => ({ ...f, ...p }))}
                onSave={handleSave}
                onCancel={() => setEditing(null)}
                pending={updateMut.isPending}
              />
            ) : (
              <Box
                sx={{
                  px: 1.5, py: 0.75, display: 'flex', alignItems: 'center', gap: 1,
                  '&:hover .conn-actions': { opacity: 1 },
                  borderBottom: `1px solid ${theme.palette.divider}`,
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Chip label={CONN_TYPE_LABELS[conn.conn_type] ?? conn.conn_type} size="small"
                      sx={{ height: 16, fontSize: '0.58rem', bgcolor: alpha(EXTRACT_COLOR, 0.15), color: EXTRACT_COLOR }} />
                    <Typography variant="body2" sx={{ fontSize: '0.75rem', fontWeight: 500 }} noWrap>{conn.name}</Typography>
                  </Box>
                  {conn.host && (
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }} noWrap>
                      {conn.host}{conn.port ? `:${conn.port}` : ''}{conn.database ? ` / ${conn.database}` : ''}
                    </Typography>
                  )}
                </Box>
                <Box className="conn-actions" sx={{ opacity: 0, transition: 'opacity 0.15s', display: 'flex', gap: 0.25 }}>
                  <IconButton size="small" onClick={() => openEdit(conn)}><Edit sx={{ fontSize: 13 }} /></IconButton>
                  <IconButton size="small" color="error" onClick={() => setDeleteConfirm(conn.id)}><Delete sx={{ fontSize: 13 }} /></IconButton>
                </Box>
              </Box>
            )}
          </Box>
        ))}

        {editing === 'new' && (
          <ConnectionForm
            form={form}
            onChange={p => setForm(f => ({ ...f, ...p }))}
            onSave={handleSave}
            onCancel={() => setEditing(null)}
            pending={createMut.isPending}
          />
        )}
      </Box>

      {/* Delete confirm dialog */}
      <Dialog open={deleteConfirm !== null} onClose={() => setDeleteConfirm(null)} maxWidth="xs">
        <DialogTitle>Delete Connection</DialogTitle>
        <DialogContent>
          <Typography>Remove this connection? Pipelines that reference it will need to be updated.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirm(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => deleteConfirm && deleteMut.mutate(deleteConfirm)} disabled={deleteMut.isPending}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

function ConnectionForm({
  form, onChange, onSave, onCancel, pending,
}: {
  form: Record<string, string>
  onChange: (p: Record<string, string>) => void
  onSave: () => void
  onCancel: () => void
  pending: boolean
}) {
  return (
    <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25, bgcolor: 'action.hover', borderBottom: '1px solid', borderColor: 'divider' }}>
      <TextField label="Name" size="small" fullWidth required value={form.name} onChange={e => onChange({ name: e.target.value })} />
      <FormControl size="small" fullWidth>
        <InputLabel>Type</InputLabel>
        <Select label="Type" value={form.conn_type} onChange={e => onChange({ conn_type: e.target.value })}>
          {Object.entries(CONN_TYPE_LABELS).map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
        </Select>
      </FormControl>
      <TextField label="Host / URL" size="small" fullWidth value={form.host} onChange={e => onChange({ host: e.target.value })} />
      <Box sx={{ display: 'flex', gap: 1 }}>
        <TextField label="Port" size="small" sx={{ width: 80 }} value={form.port} onChange={e => onChange({ port: e.target.value })} />
        <TextField label="Database" size="small" sx={{ flex: 1 }} value={form.database} onChange={e => onChange({ database: e.target.value })} />
      </Box>
      <TextField label="Username" size="small" fullWidth value={form.username} onChange={e => onChange({ username: e.target.value })} />
      <TextField
        label="Password"
        type="password"
        size="small"
        fullWidth
        value={form.password}
        onChange={e => onChange({ password: e.target.value })}
        helperText="Leave blank to keep existing"
      />
      <TextField label="Description" size="small" fullWidth multiline rows={2} value={form.description} onChange={e => onChange({ description: e.target.value })} />
      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
        <Button size="small" onClick={onCancel}>Cancel</Button>
        <Button size="small" variant="contained" onClick={onSave} disabled={pending || !form.name}>
          {pending ? <CircularProgress size={14} /> : 'Save'}
        </Button>
      </Box>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema panel (full JSON editor for the pipeline canvas)
// ─────────────────────────────────────────────────────────────────────────────

function SchemaPanel({
  nodes, edges, pipelineName,
  onApply,
}: {
  nodes: Node<PipelineNodeData>[]
  edges: Edge[]
  pipelineName: string
  onApply: (nodes: Node<PipelineNodeData>[], edges: Edge[]) => void
}) {
  // Viewer shows config only (no positions). Edit mode also edits config only;
  // existing positions are preserved when applying.
  const derived = useMemo(() => canvasToConfig(nodes, edges), [nodes, edges])
  const [editMode, setEditMode] = useState(false)
  const [editText, setEditText] = useState('')
  const [parseErr, setParseErr] = useState('')

  function startEdit() {
    setEditText(JSON.stringify(derived, null, 2))
    setParseErr('')
    setEditMode(true)
  }

  function applyEdit() {
    try {
      const parsed = JSON.parse(editText)
      // Merge existing positions so drag layout is preserved
      const posById = new Map(nodes.map(n => [n.id, n.position]))
      const { nodes: newNodes, edges: newEdges } = jsonToCanvas(parsed)
      const merged = newNodes.map(n => ({
        ...n,
        position: posById.get(n.id) ?? n.position,
      }))
      onApply(merged, newEdges)
      setEditMode(false)
      setParseErr('')
    } catch (e) {
      setParseErr((e as Error).message)
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', p: 1.5, gap: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', fontSize: '0.6rem', flex: 1 }}>
          Pipeline JSON — {pipelineName}
        </Typography>
        {editMode ? (
          <>
            <Button size="small" onClick={() => setEditMode(false)}>Cancel</Button>
            <Button size="small" variant="contained" onClick={applyEdit}>Apply</Button>
          </>
        ) : (
          <Tooltip title="Edit JSON directly">
            <IconButton size="small" onClick={startEdit}><EditNote sx={{ fontSize: 15 }} /></IconButton>
          </Tooltip>
        )}
        <Tooltip title="Copy to clipboard">
          <IconButton size="small" onClick={() => navigator.clipboard.writeText(JSON.stringify(derived, null, 2))}>
            <ContentCopy sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {parseErr && <Alert severity="error" sx={{ fontSize: '0.72rem', py: 0.5 }}>{parseErr}</Alert>}

      {editMode ? (
        <TextField
          multiline
          fullWidth
          size="small"
          value={editText}
          onChange={e => { setEditText(e.target.value); setParseErr('') }}
          sx={{
            flex: 1,
            '& .MuiInputBase-root': { fontFamily: 'monospace', fontSize: '0.72rem', alignItems: 'flex-start', height: '100%' },
            '& textarea': { height: '100% !important' },
          }}
          slotProps={{ htmlInput: { style: { whiteSpace: 'pre', overflowX: 'auto' } } }}
        />
      ) : (
        <Box
          component="pre"
          sx={{
            flex: 1, overflow: 'auto', bgcolor: 'action.hover',
            borderRadius: 1, p: 1.25, m: 0,
            fontFamily: 'monospace', fontSize: '0.68rem', lineHeight: 1.6,
            border: '1px solid', borderColor: 'divider', color: 'text.secondary',
          }}
        >
          {JSON.stringify(derived, null, 2)}
        </Box>
      )}
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main PipelineEditor page
// ─────────────────────────────────────────────────────────────────────────────

let _nodeIdSeq = 1000

function _newNodeId(): string {
  return `node_${_nodeIdSeq++}`
}

function buildIteratorJdbcAggregateSparkTemplate(
  position: { x: number; y: number },
): { nodes: Node<PipelineNodeData>[]; edges: Edge[] } {
  const iteratorId = _newNodeId()
  const jdbcId = _newNodeId()
  const aggregateId = _newNodeId()
  const loadId = _newNodeId()

  const nodeGap = 220
  const y = position.y

  const templateNodes: Node<PipelineNodeData>[] = [
    {
      id: iteratorId,
      type: 'pipeline',
      position: { x: position.x, y },
      data: {
        nodeType: 'iterator',
        label: 'Iterator',
        config: defaultConfig('iterator'),
      },
    },
    {
      id: jdbcId,
      type: 'pipeline',
      position: { x: position.x + nodeGap, y },
      data: {
        nodeType: 'jdbc_extract',
        label: 'JDBC Extract',
        config: {
          ...defaultConfig('jdbc_extract'),
          sql: "SELECT *\nFROM your_table\nWHERE business_date = '$business_date'\n  AND app_id = '$app_id'",
          chunk_size: 50000,
        },
      },
    },
    {
      id: aggregateId,
      type: 'pipeline',
      position: { x: position.x + nodeGap * 2, y },
      data: {
        nodeType: 'aggregate',
        label: 'Aggregate',
        config: {
          ...defaultConfig('aggregate'),
          group_by: ['app_id', 'business_date'],
          aggregations: [{ column: 'amount', function: 'sum', alias: 'total_amount' }],
        },
      },
    },
    {
      id: loadId,
      type: 'pipeline',
      position: { x: position.x + nodeGap * 3, y },
      data: {
        nodeType: 'load_sql',
        label: 'SQL/Spark Table',
        config: {
          ...defaultConfig('load_sql'),
          table_name: 'app_daily_aggregate',
          mode: 'overwrite',
        },
      },
    },
  ]

  const templateEdges: Edge[] = [
    {
      id: `edge_${iteratorId}_${jdbcId}`,
      source: iteratorId,
      target: jdbcId,
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed },
    },
    {
      id: `edge_${jdbcId}_${aggregateId}`,
      source: jdbcId,
      target: aggregateId,
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed },
    },
    {
      id: `edge_${aggregateId}_${loadId}`,
      source: aggregateId,
      target: loadId,
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed },
    },
  ]

  return { nodes: templateNodes, edges: templateEdges }
}

export default function PipelineEditor() {
  const { id } = useParams<{ id: string }>()
  const pipelineId = Number(id)
  const hasExistingPipelineId = Number.isFinite(pipelineId) && pipelineId > 0
  const navigate = useNavigate()
  const theme = useTheme()
  const qc = useQueryClient()

  const [pipelineName, setPipelineName] = useState('')
  const [pipelineCategory, setPipelineCategory] = useState(DEFAULT_PIPELINE_CATEGORY)
  const [pipelineStatus, setPipelineStatus] = useState<Pipeline['status']>(DEFAULT_PIPELINE_STATUS)
  const [editMetaOpen, setEditMetaOpen] = useState(false)
  const [metaEditorMode, setMetaEditorMode] = useState<'edit' | 'clone'>('edit')
  const [metaDraftName, setMetaDraftName] = useState('')
  const [metaDraftCategory, setMetaDraftCategory] = useState(DEFAULT_PIPELINE_CATEGORY)
  const [metaDraftStatus, setMetaDraftStatus] = useState<Pipeline['status']>(DEFAULT_PIPELINE_STATUS)
  const [metaEditError, setMetaEditError] = useState('')
  const [deletePipelineConfirm, setDeletePipelineConfirm] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<PipelineNodeData>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selectedNode, setSelectedNode] = useState<Node<PipelineNodeData> | null>(null)
  const [rightTab, setRightTab] = useState(0)
  const [rightPanelWidth, setRightPanelWidth] = useState(340)
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false)
  const rightPanelDragging = useRef(false)
  const [sqlPanel, setSqlPanel] = useState<SqlPanelState>({ ...CLOSED_PANEL })
  const reactFlowWrapper = useRef<HTMLDivElement>(null)

  const handleRightPanelMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    rightPanelDragging.current = true
    const startX = e.clientX
    const startWidth = rightPanelWidth
    const onMove = (mv: MouseEvent) => {
      if (!rightPanelDragging.current) return
      const next = Math.max(340, Math.min(600, startWidth + (startX - mv.clientX)))
      setRightPanelWidth(next)
    }
    const onUp = () => {
      rightPanelDragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const rfRef = useRef<ReactFlowInstance | null>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 })

  // ── Queries ──────────────────────────────────────────────────────────────

  const { data: execContext } = useQuery({
    queryKey: ['execution-context'],
    queryFn: contextApi.get,
    staleTime: 30_000,
  })

  const { data: pipeline, isLoading: pipelineLoading } = useQuery<Pipeline>({
    queryKey: ['pipeline', id],
    queryFn: () => pipelinesApi.list().then(list => list.find(p => p.id === pipelineId)!),
    enabled: hasExistingPipelineId,
  })

  const { data: allPipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: pipelinesApi.list,
  })

  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
  })

  const { data: sqlFiles = [] } = useQuery({
    queryKey: ['sql-files', 'extract'],
    queryFn: () => sqlFilesApi.list('extract'),
  })

  const { data: dictionaries = [] } = useQuery({
    queryKey: ['dictionaries'],
    queryFn: dictionariesApi.list,
  })

  const { data: notebooks = [] } = useQuery({
    queryKey: ['notebooks'],
    queryFn: transformApi.listNotebooks,
  })

  const { data: pipelineRuns = [], isLoading: runsLoading } = useQuery<RunSummary[]>({
    queryKey: ['pipeline-runs', id],
    queryFn: () => pipelinesApi.getRuns(pipelineId),
    enabled: hasExistingPipelineId,
    refetchInterval: (q) => {
      const runs = (q.state.data as RunSummary[] | undefined) ?? []
      return runs.some(r => r.status === 'running' || r.status === 'pending') ? 3000 : false
    },
  })

  const recentRuns = useMemo(
    () => [...pipelineRuns].sort((a, b) => b.id - a.id).slice(0, 20),
    [pipelineRuns],
  )

  const setupChecklist = useMemo(() => {
    const iteratorNode = nodes.find(n => n.data.nodeType === 'iterator')
    const jdbcNode = nodes.find(n => n.data.nodeType === 'jdbc_extract')
    const aggregateNode = nodes.find(n => n.data.nodeType === 'aggregate')
    const loadNode = nodes.find(n => ['load_sql', 'load_parquet'].includes(n.data.nodeType))

    const items = [
      {
        key: 'iter-node',
        label: 'Iterator node is on canvas',
        ok: Boolean(iteratorNode),
      },
      {
        key: 'iter-dict',
        label: 'Iterator dictionary selected',
        ok: Boolean(iteratorNode?.data.config?.dictionary_id),
      },
      {
        key: 'jdbc-node',
        label: 'JDBC Extract node is on canvas',
        ok: Boolean(jdbcNode),
      },
      {
        key: 'jdbc-conn',
        label: 'JDBC connection selected',
        ok: Boolean(jdbcNode?.data.config?.connection_id),
      },
      {
        key: 'jdbc-sql',
        label: 'JDBC SQL configured (inline or file)',
        ok: Boolean((jdbcNode?.data.config?.sql ?? '').trim() || jdbcNode?.data.config?.sql_file_id),
      },
      {
        key: 'agg-node',
        label: 'Aggregate node exists',
        ok: Boolean(aggregateNode),
      },
      {
        key: 'load-node',
        label: 'Load node exists (Spark table or Parquet file)',
        ok: Boolean(loadNode),
      },
      {
        key: 'load-spark-table',
        label: 'Spark table name is set (for load-to-table runs)',
        ok: loadNode?.data.nodeType !== 'load_sql' || Boolean((loadNode.data.config?.table_name ?? '').trim()),
      },
      {
        key: 'biz-date',
        label: 'Business date is set in execution context',
        ok: Boolean(execContext?.business_date),
      },
    ]

    const completeCount = items.filter(i => i.ok).length
    return {
      items,
      completeCount,
      total: items.length,
      percent: Math.round((completeCount / Math.max(items.length, 1)) * 100),
    }
  }, [nodes, execContext?.business_date])

  const categoryOptions = useMemo(
    () => buildPipelineCategoryOptions(allPipelines.map(p => p.category)),
    [allPipelines],
  )

  // ── Load canvas state when pipeline arrives ──────────────────────────────

  useEffect(() => {
    if (!hasExistingPipelineId || !pipeline) {
      setPipelineName('')
      setPipelineCategory(DEFAULT_PIPELINE_CATEGORY)
      setPipelineStatus(DEFAULT_PIPELINE_STATUS)
      setNodes([])
      setEdges([])
      setSelectedNode(null)
      setActiveRunId(null)
      setSqlPanel({ ...CLOSED_PANEL })
      setViewport({ x: 0, y: 0, zoom: 1 })
      setTimeout(() => rfRef.current?.setViewport({ x: 0, y: 0, zoom: 1 }), 50)
      return
    }
    setPipelineName(pipeline.name)
    setPipelineCategory((pipeline.category ?? '').trim() || DEFAULT_PIPELINE_CATEGORY)
    setPipelineStatus(pipeline.status ?? DEFAULT_PIPELINE_STATUS)

    const cc = pipeline.canvas_config as { nodes?: unknown[]; edges?: unknown[]; viewport?: Viewport } | undefined
    if (cc?.nodes && cc.nodes.length > 0) {
      setNodes(cc.nodes as Node<PipelineNodeData>[])
      setEdges((cc.edges ?? []) as Edge[])
      if (cc.viewport) {
        const savedVp = cc.viewport
        setViewport(savedVp)
        setTimeout(() => rfRef.current?.setViewport(savedVp), 50)
      } else {
        setTimeout(() => rfRef.current?.fitView({ padding: 0.25 }), 50)
      }
    }
    // else: empty canvas for new pipeline
    setSelectedNode(null)
  }, [pipeline, hasExistingPipelineId])

  // ── Mutations ────────────────────────────────────────────────────────────

  const deletePipelineMut = useMutation({
    mutationFn: () => pipelinesApi.delete(Number(id)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pipelines'] }); navigate('/pipelines') },
  })

  const [activeRunId, setActiveRunId] = useState<number | null>(null)
  const [warnNoBizDate, setWarnNoBizDate] = useState(false)
  const [executionPlanOpen, setExecutionPlanOpen] = useState(false)
  const [runScope, setRunScope] = useState<'full' | 'extract' | 'load'>('full')
  const lineRenderStyle = useThemeStore(s => s.lineRenderStyle)
  const checklistIncomplete = useMemo(
    () => setupChecklist.items.filter(i => !i.ok),
    [setupChecklist],
  )

  useEffect(() => {
    const nextEdgeType = EDGE_TYPE_BY_STYLE[lineRenderStyle]
    setEdges(eds => eds.map(edge => ({ ...edge, type: nextEdgeType })))
  }, [lineRenderStyle, setEdges])

  function buildPipelineRequestPayload(name: string, category: string, status: Pipeline['status']) {
    const dwNode = nodes.find(n => n.data.nodeType === 'dw_extract')
    const loadNode =
      nodes.find(n => n.data.nodeType === 'load_sql')
      ?? nodes.find(n => n.data.nodeType === 'load_parquet')

    // Topological sort of canvas nodes → determine execution order
    const adj: Record<string, string[]> = {}
    const inDeg: Record<string, number> = {}
    for (const n of nodes) { adj[n.id] = []; inDeg[n.id] = 0 }
    for (const e of edges) { adj[e.source].push(e.target); inDeg[e.target]++ }
    const queue = nodes.filter(n => inDeg[n.id] === 0).map(n => n.id)
    const order: string[] = []
    while (queue.length > 0) {
      const cur = queue.shift()!
      order.push(cur)
      for (const next of adj[cur] ?? []) { if (--inDeg[next] === 0) queue.push(next) }
    }
    const TRANSFORM_TYPES = ['filter', 'join', 'sort', 'lookup', 'sql_transform', 'aggregate', 'notebook_transform']
    const transforms_pipeline = order
      .map(nid => nodes.find(n => n.id === nid)!)
      .filter(n => n && TRANSFORM_TYPES.includes(n.data.nodeType))
      .map(n => ({ node_id: n.id, node_type: n.data.nodeType, config: n.data.config }))

    const jdbcNode = nodes.find(n => n.data.nodeType === 'jdbc_extract')

    const extract_config = dwNode ? {
      source_type: 'datawarehouse',
      dw_connection_id: dwNode.data.config.connection_id,
      jdbc_sql_file_id: dwNode.data.config.sql_file_id,
      jdbc_date_var_format: dwNode.data.config.date_format,
      jdbc_date_range_mode: dwNode.data.config.date_range_mode,
      jdbc_date_range_from: dwNode.data.config.date_from,
      jdbc_date_range_to: dwNode.data.config.date_to,
      output_format: dwNode.data.config.output_format,
    } : jdbcNode ? {
      source_type: 'jdbc',
      jdbc_connection_id: jdbcNode.data.config.connection_id,
      jdbc_sql: jdbcNode.data.config.sql || undefined,
      jdbc_sql_file_id: jdbcNode.data.config.sql_file_id || undefined,
      jdbc_date_var_format: jdbcNode.data.config.date_format,
    } : undefined

    const load_config = loadNode ? {
      target: loadNode.data.nodeType === 'load_parquet' ? 'parquet' : 'spark_table',
      ...loadNode.data.config,
      ...(loadNode.data.nodeType === 'load_sql'
        ? {
            namespace_db:
              (loadNode.data.config.namespace_db ?? loadNode.data.config.database ?? '').trim()
              || deriveSparkDatabaseName(execContext?.business_date),
          }
        : {}),
    } : undefined

    return {
      name,
      category,
      status,
      canvas_config: {
        nodes: nodes.map(n => ({
          id: n.id, type: n.type, position: n.position,
          data: n.data,
        })),
        edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target })),
        viewport,
      },
      ...(extract_config && { extract_config }),
      ...(load_config && { load_config }),
      transform_config: { transforms_pipeline },
    }
  }

  const runMut = useMutation({
    mutationFn: (scope: 'full' | 'extract' | 'load') => pipelinesApi.run(Number(id), { run_scope: scope }),
    onSuccess: (run) => {
      setActiveRunId(run.id)
      qc.invalidateQueries({ queryKey: ['pipelines'] })
      qc.invalidateQueries({ queryKey: ['all-runs'] })
      qc.invalidateQueries({ queryKey: ['pipeline-runs', id] })
    },
  })

  function handleRunPipeline(scope: 'full' | 'extract' | 'load' = runScope) {
    if (!execContext?.business_date) {
      setWarnNoBizDate(true)
      return
    }
    runMut.mutate(scope)
  }

  function handleRunSelectedStep() {
    if (!selectedNode) return
    const sourceNodeTypes = new Set(['iterator', 'jdbc_extract', 'dw_extract', 's3_extract'])
    const targetScope: 'extract' | 'load' = sourceNodeTypes.has(selectedNode.data.nodeType) ? 'extract' : 'load'
    handleRunPipeline(targetScope)
  }

  const saveMut = useMutation({
    mutationFn: () => {
      const payload = buildPipelineRequestPayload(
        pipelineName,
        pipelineCategory.trim() || DEFAULT_PIPELINE_CATEGORY,
        pipelineStatus,
      )
      return pipelinesApi.update(Number(id), payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipelines'] })
      qc.invalidateQueries({ queryKey: ['pipeline', id] })
    },
  })

  const cloneMut = useMutation({
    mutationFn: () => {
      const payload = buildPipelineRequestPayload(
        metaDraftName.trim(),
        normalizePipelineCategory(metaDraftCategory),
        metaDraftStatus,
      )
      return pipelinesApi.create(payload)
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['pipelines'] })
      closeMetaEditor()
      navigate(`/pipelines/${created.id}/edit`)
    },
  })

  // ── ReactFlow callbacks ──────────────────────────────────────────────────

  const onConnect = useCallback((connection: RFConnection) => {
    setEdges(eds => addEdge({
      ...connection,
      type: EDGE_TYPE_BY_STYLE[lineRenderStyle],
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed },
    }, eds))
  }, [lineRenderStyle, setEdges])

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    const templateId = event.dataTransfer.getData('application/pipeline-template')
    const nodeType = event.dataTransfer.getData('application/pipeline-node')

    const bounds = reactFlowWrapper.current?.getBoundingClientRect()
    if (!bounds) return

    const position = {
      x: event.clientX - bounds.left - 90,
      y: event.clientY - bounds.top  - 40,
    }

    if (templateId === 'iterator-jdbc-aggregate-spark') {
      const { nodes: templateNodes, edges: templateEdges } = buildIteratorJdbcAggregateSparkTemplate(position)
      setNodes(nds => [...nds, ...templateNodes])
      setEdges(eds => [...eds, ...templateEdges])
      return
    }

    const cat = CATALOG_MAP[nodeType]
    if (!cat) return

    const newNode: Node<PipelineNodeData> = {
      id: _newNodeId(),
      type: 'pipeline',
      position,
      data: {
        nodeType,
        label: cat.label,
        config: defaultConfig(nodeType),
      },
    }
    setNodes(nds => [...nds, newNode])
  }, [setNodes])

  function onNodeClick(_: React.MouseEvent, node: Node<PipelineNodeData>) {
    setSelectedNode(node)
    setRightTab(0)  // jump to Properties when clicking a node
  }

  function onPaneClick() {
    setSelectedNode(null)
  }

  function updateNodeConfig(nodeId: string, patch: Record<string, unknown>) {
    setNodes(nds => nds.map(n => {
      if (n.id !== nodeId) return n
      const updated = { ...n, data: { ...n.data, ...patch } }
      // Keep config patches under data.config
      if (!('label' in patch) && !('nodeType' in patch)) {
        updated.data = { ...n.data, config: { ...n.data.config, ...patch } }
      }
      // Refresh selected node reference
      if (selectedNode?.id === nodeId) {
        setSelectedNode(updated)
      }
      // Keep SQL panel in sync if it's open
      if ('sql' in patch && typeof patch.sql === 'string') {
        setSqlPanel(p => p.open ? { ...p, sql: patch.sql as string } : p)
      }
      if ('params' in patch) {
        setSqlPanel(p => p.open ? { ...p, params: patch.params as { key: string; value: string }[] } : p)
      }
      return updated
    }))
  }

  function openSqlEditorForNode(node: Node<PipelineNodeData>) {
    const cfg = node.data.config ?? {}
    const params: { key: string; value: string }[] = cfg.params ?? []
    const sqlMode = cfg.sql_file_id ? 'file' : 'inline'
    const sqlFiles_: SqlFile[] = sqlFiles ?? []
    const sql = sqlMode === 'file'
      ? (sqlFiles_.find(f => f.id === cfg.sql_file_id)?.content ?? '')
      : (cfg.sql ?? '')
    setSqlPanel(p => ({
      open: true,
      height: p.open ? p.height : 320,
      connectionId: cfg.connection_id ?? null,
      sql,
      params,
      onSqlChange: (s: string) => updateNodeConfig(node.id, { sql: s, sql_file_id: null }),
    }))
  }

  function buildIteratorPreview(iteratorNodeId: string): IteratorPreviewModel {
    const iterNode = nodes.find(n => n.id === iteratorNodeId)
    if (!iterNode) throw new Error('Iterator node not found')
    const iterCfg = iterNode.data.config ?? {}

    const dict = dictionaries.find(d => d.id === Number(iterCfg.dictionary_id))
    if (!dict) throw new Error('Select a dictionary before previewing')

    const selectedKeys: string[] = iterCfg.selected_keys ?? []
    const entryFilters: IteratorEntryFilter[] = (iterCfg.entry_filters ?? [])
      .filter((f: { column?: string; value?: string }) => f?.column && f?.value)
    const activeEntries = getIteratorActiveEntries(dict, selectedKeys, entryFilters)
    if (activeEntries.length === 0) throw new Error('No iterator entries selected')

    const keyParam = iterCfg.key_param ?? 'app_id'
    const valueParam = iterCfg.value_param ?? 'app_name'
    const warnings: string[] = []
    const steps: IteratorPreviewStep[] = []
    const visited = new Set<string>([iteratorNodeId])
    let currentId = iteratorNodeId

    while (true) {
      const outgoing = edges.filter(e => e.source === currentId)
      if (outgoing.length === 0) break

      if (outgoing.length > 1) {
        const currentNode = nodes.find(n => n.id === currentId)
        warnings.push(
          `Node "${currentNode?.data.label ?? currentId}" has ${outgoing.length} outgoing paths. Preview shows the first path only.`
        )
      }

      const nextEdge = outgoing[0]
      const nextNode = nodes.find(n => n.id === nextEdge.target)
      if (!nextNode || visited.has(nextNode.id)) break

      const cat = CATALOG_MAP[nextNode.data.nodeType]
      steps.push({
        id: nextNode.id,
        label: nextNode.data.label || cat?.label || nextNode.data.nodeType,
        type: nextNode.data.nodeType,
        color: cat?.color ?? '#666',
      })

      visited.add(nextNode.id)
      currentId = nextNode.id
    }

    const terminalStep = steps[steps.length - 1]
    const terminalNode = terminalStep ? nodes.find(n => n.id === terminalStep.id) : null
    const businessDate = execContext?.business_date ?? '{business_date}'
    const pipelineLabel = pipelineName || 'pipeline'

    const replaceToken = (value: string, token: string, nextValue: string) => value.split(token).join(nextValue)
    const resolveTemplate = (template: string, entry: { key: string; value: string }) => {
      let output = template
      output = replaceToken(output, `{${keyParam}}`, entry.key)
      output = replaceToken(output, `{${valueParam}}`, entry.value)
      output = replaceToken(output, '{business_date}', businessDate)
      output = replaceToken(output, '{pipeline_name}', pipelineLabel)
      output = replaceToken(output, '{app_id}', keyParam === 'app_id' ? entry.key : '{app_id}')
      output = replaceToken(output, '{app_name}', valueParam === 'app_name' ? entry.value : '{app_name}')
      return output
    }

    const branches: IteratorPreviewBranch[] = activeEntries.map(entry => {
      let output: string | undefined

      if (terminalNode?.data.nodeType === 'load_parquet') {
        const cfg = terminalNode.data.config ?? {}
        output = cfg.output_dir?.trim()
          ? cfg.output_dir.trim()
          : resolveTemplate(
              cfg.path_template?.trim() || '{business_date}/{pipeline_name}/{app_id}',
              entry,
            )
      } else if (terminalNode?.data.nodeType === 'load_sql') {
        const cfg = terminalNode.data.config ?? {}
        output = `${cfg.database || 'default'}.${cfg.table_name || '(table)'}`
      } else if (terminalNode?.data.nodeType === 'load_s3') {
        const cfg = terminalNode.data.config ?? {}
        output = `${cfg.namespace_db || cfg.database || deriveSparkDatabaseName(execContext?.business_date)}.${cfg.table_name || '(table)'}`
      }

      return {
        key: entry.key,
        value: entry.value,
        params: [
          { key: keyParam, value: entry.key },
          { key: valueParam, value: entry.value },
        ],
        ...(output ? { output } : {}),
      }
    })

    return {
      iteratorLabel: iterNode.data.label,
      dictName: dict.name,
      keyParam,
      valueParam,
      totalBranches: branches.length,
      steps,
      branches,
      warnings,
    }
  }

  function buildExecutionPlanModel(): ExecutionPlanModel {
    const warnings: string[] = []
    const nodeById = new Map(nodes.map(n => [n.id, n]))
    const outgoing = new Map<string, Edge[]>()
    const inDegree = new Map<string, number>()

    for (const node of nodes) {
      outgoing.set(node.id, [])
      inDegree.set(node.id, 0)
    }

    for (const edge of edges) {
      const list = outgoing.get(edge.source)
      if (list) list.push(edge)
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    }

    const roots = nodes
      .filter(n => (inDegree.get(n.id) ?? 0) === 0)
      .sort((a, b) => (a.position.y - b.position.y) || (a.position.x - b.position.x))

    const rootNodes = roots.length > 0 ? roots : nodes.slice(0, 1)
    if (roots.length === 0 && nodes.length > 0) {
      warnings.push('No explicit root node detected. Plan starts from the first node in the canvas.')
    }

    const seenOverall = new Set<string>()

    const buildIteratorForkPreview = (iterNode: Node<PipelineNodeData>): ExecutionPlanForkPreview => {
      const iterCfg = iterNode.data.config ?? {}
      const dict = dictionaries.find(d => d.id === Number(iterCfg.dictionary_id))
      const selectedKeys: string[] = iterCfg.selected_keys ?? []
      const entryFilters: IteratorEntryFilter[] = (iterCfg.entry_filters ?? [])
        .filter((f: { column?: string; value?: string }) => f?.column && f?.value)
      const keyParam = iterCfg.key_param ?? 'app_id'
      const valueParam = iterCfg.value_param ?? 'app_name'
      const iterWarnings: string[] = []
      const branchSteps: IteratorPreviewStep[] = []
      const postMergeSteps: IteratorPreviewStep[] = []
      let mergeStep: IteratorPreviewStep | undefined

      if (!dict) {
        iterWarnings.push('Dictionary is not selected.')
      }

      const activeEntries = getIteratorActiveEntries(dict, selectedKeys, entryFilters)

      if (dict && activeEntries.length === 0) {
        iterWarnings.push('No iterator entries selected.')
      }

      const branches: IteratorPreviewBranch[] = activeEntries.map(entry => ({
        key: entry.key,
        value: entry.value,
        params: [
          { key: keyParam, value: entry.key },
          { key: valueParam, value: entry.value },
        ],
      }))

      // Walk the first downstream path from iterator to model branch steps and merge point.
      const branchVisited = new Set<string>([iterNode.id])
      let current: Node<PipelineNodeData> | undefined = iterNode
      while (current) {
        const nextEdges = outgoing.get(current.id) ?? []
        if (nextEdges.length === 0) break
        if (nextEdges.length > 1) {
          iterWarnings.push(
            `Node "${current.data.label || current.id}" has ${nextEdges.length} outgoing paths. Diagram follows the first path.`,
          )
        }
        const nextNode = nodeById.get(nextEdges[0].target)
        if (!nextNode) break
        if (branchVisited.has(nextNode.id)) {
          iterWarnings.push('Loop detected in iterator downstream path. Diagram stops at loop start.')
          break
        }

        const cat = CATALOG_MAP[nextNode.data.nodeType]
        const step: IteratorPreviewStep = {
          id: nextNode.id,
          label: nextNode.data.label || cat?.label || nextNode.data.nodeType,
          type: nextNode.data.nodeType,
          color: cat?.color ?? '#666',
        }

        if (nextNode.data.nodeType === 'aggregate') {
          mergeStep = step
          branchVisited.add(nextNode.id)

          // Continue from aggregate to capture the single downstream path (typically load).
          let mergeCurrent: Node<PipelineNodeData> | undefined = nextNode
          while (mergeCurrent) {
            const mergeNextEdges = outgoing.get(mergeCurrent.id) ?? []
            if (mergeNextEdges.length === 0) break
            if (mergeNextEdges.length > 1) {
              iterWarnings.push(
                `Merge node "${mergeCurrent.data.label || mergeCurrent.id}" has ${mergeNextEdges.length} outgoing paths. Diagram follows the first post-merge path.`,
              )
            }
            const mergeNextNode = nodeById.get(mergeNextEdges[0].target)
            if (!mergeNextNode) break
            if (branchVisited.has(mergeNextNode.id)) {
              iterWarnings.push('Loop detected in post-merge path. Diagram stops at loop start.')
              break
            }

            const mergeCat = CATALOG_MAP[mergeNextNode.data.nodeType]
            postMergeSteps.push({
              id: mergeNextNode.id,
              label: mergeNextNode.data.label || mergeCat?.label || mergeNextNode.data.nodeType,
              type: mergeNextNode.data.nodeType,
              color: mergeCat?.color ?? '#666',
            })
            branchVisited.add(mergeNextNode.id)
            mergeCurrent = mergeNextNode
          }
          break
        }

        branchSteps.push(step)
        branchVisited.add(nextNode.id)
        current = nextNode
      }

      return {
        iteratorNodeId: iterNode.id,
        iteratorLabel: iterNode.data.label,
        dictName: dict?.name,
        keyParam,
        valueParam,
        totalBranches: branches.length,
        branches,
        branchSteps,
        ...(mergeStep ? { mergeStep } : {}),
        postMergeSteps,
        warnings: iterWarnings,
      }
    }

    const lanes: ExecutionPlanLane[] = rootNodes.map(root => {
      const laneWarnings: string[] = []
      const steps: IteratorPreviewStep[] = []
      const iteratorPreviews: ExecutionPlanForkPreview[] = []
      const visited = new Set<string>()
      let loopDetected = false

      let current: Node<PipelineNodeData> | undefined = root
      while (current) {
        if (visited.has(current.id)) {
          loopDetected = true
          break
        }
        visited.add(current.id)
        seenOverall.add(current.id)

        const cat = CATALOG_MAP[current.data.nodeType]
        steps.push({
          id: current.id,
          label: current.data.label || cat?.label || current.data.nodeType,
          type: current.data.nodeType,
          color: cat?.color ?? '#666',
        })

        if (current.data.nodeType === 'iterator') {
          iteratorPreviews.push(buildIteratorForkPreview(current))
        }

        const nextEdges = outgoing.get(current.id) ?? []
        if (nextEdges.length === 0) break

        if (nextEdges.length > 1) {
          laneWarnings.push(
            `Node "${current.data.label || current.id}" has ${nextEdges.length} outgoing paths. Plan follows the first path for lane rendering.`
          )
        }

        const nextNode = nodeById.get(nextEdges[0].target)
        if (!nextNode) {
          laneWarnings.push(`Missing target node for edge from "${current.data.label || current.id}".`)
          break
        }

        current = nextNode
      }

      if (loopDetected) {
        laneWarnings.push('This path loops back to an earlier step. The preview stops where the loop begins.')
      }

      return {
        id: root.id,
        label: `Path from ${root.data.label || root.id}`,
        steps,
        iteratorPreviews,
        warnings: laneWarnings,
      }
    })

    const unreachable = nodes.filter(n => !seenOverall.has(n.id))
    if (unreachable.length > 0) {
      warnings.push(`${unreachable.length} node${unreachable.length !== 1 ? 's are' : ' is'} not included in root-based paths.`)
      for (const node of unreachable) {
        const cat = CATALOG_MAP[node.data.nodeType]
        lanes.push({
          id: `isolated-${node.id}`,
          label: `Unattached node ${node.data.label || node.id}`,
          steps: [{
            id: node.id,
            label: node.data.label || cat?.label || node.data.nodeType,
            type: node.data.nodeType,
            color: cat?.color ?? '#666',
          }],
          iteratorPreviews: node.data.nodeType === 'iterator' ? [buildIteratorForkPreview(node)] : [],
          warnings: ['This node is not reachable from any detected root path.'],
        })
      }
    }

    return {
      pipelineLabel: pipelineName,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      lanes,
      warnings,
    }
  }

  const executionPlan = useMemo(
    () => buildExecutionPlanModel(),
    [nodes, edges, dictionaries, pipelineName],
  )

  function handleSchemaApply(newNodes: Node<PipelineNodeData>[], newEdges: Edge[]) {
    setNodes(newNodes)
    setEdges(newEdges)
  }

  function openMetaEditor() {
    setMetaEditorMode('edit')
    setMetaDraftName(pipelineName)
    setMetaDraftCategory(pipelineCategory)
    setMetaDraftStatus(pipelineStatus)
    setMetaEditError('')
    setEditMetaOpen(true)
  }

  function openCloneEditor() {
    setMetaEditorMode('clone')
    setMetaDraftName(`${pipelineName || 'Pipeline'} Copy`)
    setMetaDraftCategory(pipelineCategory)
    setMetaDraftStatus(pipelineStatus)
    setMetaEditError('')
    setEditMetaOpen(true)
  }

  function closeMetaEditor() {
    setMetaEditError('')
    setEditMetaOpen(false)
  }

  function applyMetaEditor() {
    const nextName = metaDraftName.trim()
    if (!nextName) {
      setMetaEditError('Name is required')
      return
    }
    if (metaEditorMode === 'clone') {
      cloneMut.mutate()
      return
    }
    setPipelineName(nextName)
    setPipelineCategory(normalizePipelineCategory(metaDraftCategory))
    setPipelineStatus(metaDraftStatus)
    setEditMetaOpen(false)
    setMetaEditError('')
  }

  if (pipelineLoading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Top toolbar ────────────────────────────────────────────────── */}
      <Box
        sx={{
          display: 'flex', alignItems: 'center', gap: 1.5,
          px: 1.5, py: 0.75, flexShrink: 0,
          bgcolor: 'background.paper',
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Tooltip title="Back to Pipelines">
          <IconButton size="small" onClick={() => navigate('/pipelines')}>
            <ArrowBack sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        <Typography variant="body2" sx={{ fontWeight: 600, maxWidth: 340 }} noWrap>
          {pipelineName || 'Untitled pipeline'}
        </Typography>
        <Chip
          label={normalizePipelineCategory(pipelineCategory)}
          size="small"
          sx={{ fontSize: '0.68rem', height: 20 }}
        />
        <Chip
          label={pipelineStatus}
          size="small"
          color={pipelineStatus === 'active' ? 'success' : 'default'}
          sx={{ fontSize: '0.7rem', height: 20 }}
        />
        <Tooltip title="Edit pipeline details">
          <IconButton size="small" onClick={openMetaEditor}>
            <Edit sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Clone pipeline">
          <IconButton size="small" onClick={openCloneEditor} disabled={!hasExistingPipelineId || cloneMut.isPending}>
            <ContentCopy sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.68rem' }}>
          {nodes.length} node{nodes.length !== 1 ? 's' : ''} · {edges.length} edge{edges.length !== 1 ? 's' : ''}
        </Typography>
        <Tooltip
          arrow
          title={
            <Box sx={{ py: 0.25 }}>
              <Typography variant="caption" sx={{ fontWeight: 700 }}>
                Pipeline Setup
              </Typography>
              <Typography variant="caption" sx={{ display: 'block', opacity: 0.9, mb: checklistIncomplete.length ? 0.5 : 0 }}>
                {setupChecklist.completeCount}/{setupChecklist.total} complete ({setupChecklist.percent}%)
              </Typography>
              {checklistIncomplete.length === 0 ? (
                <Typography variant="caption">All required setup fields are complete.</Typography>
              ) : (
                <Box component="ul" sx={{ m: 0, pl: 2 }}>
                  {checklistIncomplete.map(item => (
                    <Box component="li" key={item.key} sx={{ mb: 0.25 }}>
                      <Typography variant="caption">{item.label}</Typography>
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          }
        >
          <Chip
            size="small"
            color={setupChecklist.completeCount === setupChecklist.total ? 'success' : 'warning'}
            icon={setupChecklist.completeCount === setupChecklist.total ? <CheckBox sx={{ fontSize: 14 }} /> : <CheckBoxOutlineBlank sx={{ fontSize: 13 }} />}
            label={`${setupChecklist.completeCount}/${setupChecklist.total}`}
            sx={{ height: 20, fontSize: '0.66rem', cursor: 'help' }}
          />
        </Tooltip>
        {saveMut.isSuccess && (
          <Typography variant="caption" color="success.main" sx={{ fontSize: '0.72rem' }}>Saved ✓</Typography>
        )}
        <FormControl size="small" sx={{ minWidth: 148 }}>
          <Select
            value={runScope}
            onChange={e => setRunScope(e.target.value as 'full' | 'extract' | 'load')}
            sx={{ fontSize: '0.76rem', height: 32 }}
          >
            <MenuItem value="full">Run Full Pipeline</MenuItem>
            <MenuItem value="extract">Run Extract</MenuItem>
            <MenuItem value="load">Run Load</MenuItem>
          </Select>
        </FormControl>
        <Button
          size="small"
          variant="outlined"
          color="success"
          startIcon={<PlayArrow sx={{ fontSize: 15 }} />}
          onClick={() => handleRunPipeline(runScope)}
          disabled={runMut.isPending || !hasExistingPipelineId}
        >
          Run
        </Button>
        <Button
          size="small"
          variant="outlined"
          color="success"
          onClick={handleRunSelectedStep}
          disabled={runMut.isPending || !selectedNode || !hasExistingPipelineId}
        >
          Run Selected Step
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<AccountTree sx={{ fontSize: 15 }} />}
          onClick={() => setExecutionPlanOpen(true)}
          disabled={nodes.length === 0}
        >
          Execution Plan
        </Button>
        <Button
          size="small"
          variant="contained"
          startIcon={<Save sx={{ fontSize: 15 }} />}
          onClick={() => saveMut.mutate()}
          disabled={saveMut.isPending || !hasExistingPipelineId}
        >
          {saveMut.isPending ? <CircularProgress size={14} /> : 'Save'}
        </Button>
        <Tooltip title="Delete pipeline">
          <IconButton size="small" color="error" onClick={() => setDeletePipelineConfirm(true)} disabled={!hasExistingPipelineId}>
            <Delete sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* ── Layout row ──────────────────────────────────────────────── */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          px: 1,
          py: 0.25,
          flexShrink: 0,
          bgcolor: 'background.paper',
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Tooltip title={rightPanelCollapsed ? 'Show right panel' : 'Hide right panel'}>
          <IconButton size="small" onClick={() => setRightPanelCollapsed(v => !v)}>
            {rightPanelCollapsed ? <FirstPage sx={{ fontSize: 16 }} /> : <LastPage sx={{ fontSize: 16 }} />}
          </IconButton>
        </Tooltip>
      </Box>

      {/* ── Main body ──────────────────────────────────────────────────── */}
      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Left: Node library */}
        <Box
          sx={{
            width: 168, flexShrink: 0,
            bgcolor: 'background.paper',
            borderRight: `1px solid ${theme.palette.divider}`,
            overflowY: 'auto', py: 0.5,
          }}
        >
          {[
            { label: 'Templates', items: PIPELINE_TEMPLATES },
            { label: 'Orchestration', items: CATALOG.filter(c => c.type === 'iterator') },
            { label: 'Sources',    items: CATALOG.filter(c => c.category === 'source' && c.type !== 'iterator') },
            { label: 'Transforms', items: CATALOG.filter(c => c.category === 'transform') },
            { label: 'Outputs',    items: CATALOG.filter(c => c.category === 'load') },
          ].map(group => (
            <Box key={group.label} sx={{ mb: 1 }}>
              <Typography
                variant="caption"
                sx={{ px: 1.5, py: 0.25, display: 'block', textTransform: 'uppercase',
                  letterSpacing: '0.07em', fontSize: '0.58rem', fontWeight: 700, color: 'text.secondary' }}
              >
                {group.label}
              </Typography>
              {group.items.map((item: CatalogItem | TemplateItem) => (
                <Box
                  key={'type' in item ? item.type : item.id}
                  draggable
                  onDragStart={e => {
                    if ('type' in item) {
                      e.dataTransfer.setData('application/pipeline-node', item.type)
                    } else {
                      e.dataTransfer.setData('application/pipeline-template', item.id)
                    }
                  }}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: 1,
                    mx: 0.75, px: 1, py: 0.6, mb: 0.25, borderRadius: 1.25, cursor: 'grab',
                    border: `1px solid ${alpha(item.color, 0.2)}`,
                    bgcolor: alpha(item.color, 0.05),
                    '&:hover': { bgcolor: alpha(item.color, 0.12) },
                    '&:active': { cursor: 'grabbing' },
                  }}
                >
                  {'type' in item ? (
                    <>
                      <Box sx={{ color: item.color, fontSize: 14, display: 'flex', flexShrink: 0 }}>{item.icon}</Box>
                      <Typography variant="caption" sx={{ color: item.color, fontWeight: 500, fontSize: '0.71rem', lineHeight: 1.3 }}>
                        {item.label}
                      </Typography>
                    </>
                  ) : (
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="caption" sx={{ color: item.color, fontWeight: 700, fontSize: '0.68rem', lineHeight: 1.25, display: 'block' }}>
                        {item.label}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.6rem', lineHeight: 1.25 }}>
                        {item.description}
                      </Typography>
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          ))}
        </Box>

        {/* Canvas */}
        <Box ref={reactFlowWrapper} sx={{ flex: 1, position: 'relative' }}>
          <DictionariesContext.Provider value={dictionaries}>
          <ConnectionsContext.Provider value={connections}>
          <NotebooksContext.Provider value={notebooks}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onEdgeClick={(_evt, edge) => setEdges(eds => eds.filter(e => e.id !== edge.id))}
            nodeTypes={nodeTypes}
            onInit={instance => { rfRef.current = instance }}
            onMoveEnd={(_, vp) => setViewport(vp)}
            defaultEdgeOptions={{
              type: EDGE_TYPE_BY_STYLE[lineRenderStyle],
              animated: true,
              markerEnd: { type: MarkerType.ArrowClosed },
            }}
            connectionLineType={CONNECTION_LINE_TYPE_BY_STYLE[lineRenderStyle]}
            deleteKeyCode="Delete"
            style={{ background: theme.palette.background.default }}
          >
            <Background color={theme.palette.divider} gap={22} />
            <ZoomControls />
            <MiniMap
              nodeColor={node => (node.data as PipelineNodeData)?.nodeType
                ? (CATALOG_MAP[(node.data as PipelineNodeData).nodeType]?.color ?? '#666')
                : '#666'
              }
              maskColor={theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(240,240,240,0.7)'}
              style={{
                background: theme.palette.background.paper,
                border: `1px solid ${theme.palette.divider}`,
                width: 130,
                height: 80,
              }}
            />
            {nodes.length === 0 && (
              <Panel position="top-center">
                <Box sx={{ textAlign: 'center', py: 2, opacity: 0.4, pointerEvents: 'none' }}>
                  <Cloud sx={{ fontSize: 52, color: 'text.secondary', mb: 1 }} />
                  <Typography color="text.secondary">
                    Drag nodes from the left panel to build your pipeline
                  </Typography>
                </Box>
              </Panel>
            )}
          </ReactFlow>
          </NotebooksContext.Provider>
          </ConnectionsContext.Provider>
          </DictionariesContext.Provider>
        </Box>

        {/* Right panel */}
        {!rightPanelCollapsed && (
          <Box
            sx={{
              width: rightPanelWidth, flexShrink: 0,
              bgcolor: 'background.paper',
              borderLeft: `1px solid ${theme.palette.divider}`,
              display: 'flex', flexDirection: 'column',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            {/* Drag handle */}
            <Box
              onMouseDown={handleRightPanelMouseDown}
              sx={{
                position: 'absolute', left: 0, top: 0, bottom: 0, width: 4,
                cursor: 'col-resize', zIndex: 10,
                '&:hover': { bgcolor: 'primary.main', opacity: 0.5 },
              }}
            />
            <Tabs
              value={rightTab}
              onChange={(_, v) => setRightTab(v)}
              variant="fullWidth"
              sx={{
                flexShrink: 0,
                borderBottom: `1px solid ${theme.palette.divider}`,
                '& .MuiTab-root': { fontSize: '0.66rem', minHeight: 36, textTransform: 'none', px: 0.75, minWidth: 0 },
              }}
            >
              <Tab label="Properties" />
              <Tab label="Runs" />
              <Tab label="Connections" />
              <Tab label="Schema" />
            </Tabs>

            <Box sx={{ flex: 1, overflowY: 'auto' }}>
            {/* Properties tab */}
            {rightTab === 0 && (
              selectedNode
                ? (
                  <PropertiesPanel
                    node={selectedNode}
                    onUpdateConfig={updateNodeConfig}
                    connections={connections}
                    sqlFiles={sqlFiles}
                    dictionaries={dictionaries}
                    notebooks={notebooks}
                    onOpenSqlEditor={() => selectedNode && openSqlEditorForNode(selectedNode)}
                    onPreviewIterator={buildIteratorPreview}
                    nodes={nodes}
                    edges={edges}
                    pipelineName={pipelineName}
                    businessDate={execContext?.business_date}
                  />
                )
                : (
                  <Box sx={{ p: 2, opacity: 0.55 }}>
                    <Typography variant="caption" color="text.secondary">
                      Click a node on the canvas to configure it.
                    </Typography>
                  </Box>
                )
            )}

            {/* Runs tab */}
            {rightTab === 1 && (
              <Box sx={{ p: 1.25 }}>
                {runsLoading ? (
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                    <CircularProgress size={18} />
                  </Box>
                ) : recentRuns.length === 0 ? (
                  <Typography variant="caption" color="text.secondary" sx={{ px: 1, py: 0.5, display: 'block' }}>
                    No runs yet for this pipeline.
                  </Typography>
                ) : (
                  <List disablePadding>
                    {recentRuns.map(run => {
                      const selected = activeRunId === run.id
                      return (
                        <ListItemButton
                          key={run.id}
                          selected={selected}
                          disableRipple
                          onClick={() => setActiveRunId(run.id)}
                          sx={{
                            color: theme.palette.text.primary,
                            borderRadius: 1,
                            mb: 0.5,
                            border: `1px solid ${theme.palette.divider}`,
                            bgcolor: selected ? alpha(theme.palette.text.primary, 0.12) : 'transparent',
                            '&.Mui-selected': {
                              bgcolor: alpha(theme.palette.text.primary, 0.16),
                              borderColor: alpha(theme.palette.text.primary, 0.32),
                              color: theme.palette.text.primary,
                            },
                            '&.Mui-selected:hover': {
                              bgcolor: `${alpha(theme.palette.text.primary, 0.22)} !important`,
                            },
                            '&.Mui-focusVisible': {
                              bgcolor: `${alpha(theme.palette.text.primary, 0.22)} !important`,
                            },
                            '& .MuiTouchRipple-root': {
                              display: 'none',
                            },
                            '& .MuiTypography-root': {
                              color: theme.palette.text.primary,
                            },
                            '&:hover': {
                              bgcolor: `${alpha(theme.palette.text.primary, 0.1)} !important`,
                            },
                          }}
                        >
                          <ListItemText
                            primary={
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                                <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>#{run.id}</Typography>
                                <StatusChip status={run.status} />
                              </Box>
                            }
                            secondary={
                              <Typography variant="caption" sx={{ display: 'block', mt: 0.4, color: alpha(theme.palette.text.primary, 0.82) }}>
                                {formatRunDate(run.started_at)} · {formatDuration(run.duration_seconds)}
                              </Typography>
                            }
                          />
                        </ListItemButton>
                      )
                    })}
                  </List>
                )}
              </Box>
            )}

            {/* Connections tab */}
            {rightTab === 2 && <ConnectionsPanel />}

            {/* Schema tab */}
            {rightTab === 3 && (
              <SchemaPanel
                nodes={nodes}
                edges={edges}
                pipelineName={pipelineName}
                onApply={handleSchemaApply}
              />
            )}
            </Box>
          </Box>
        )}
      </Box>

      {/* ── Run Detail Panel ────────────────────────────────────────── */}
      {activeRunId != null && (
        <Box sx={{ flexShrink: 0, maxHeight: '50vh', display: 'flex', flexDirection: 'column', borderTop: `1px solid ${theme.palette.divider}` }}>
          <Box sx={{ display: 'flex', alignItems: 'center', px: 2, py: 0.5, flexShrink: 0, bgcolor: 'background.paper', borderBottom: `1px solid ${theme.palette.divider}` }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>Run #{activeRunId}</Typography>
            <Box sx={{ flex: 1 }} />
            <Tooltip title="Close run panel">
              <IconButton size="small" onClick={() => setActiveRunId(null)}>
                <Close sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Box>
          <Box sx={{ overflowY: 'auto', flex: 1 }}>
            <RunDetailPanel
              runId={activeRunId}
              disableGraphView
              onCancelled={() => {
                qc.invalidateQueries({ queryKey: ['pipelines'] })
                qc.invalidateQueries({ queryKey: ['all-runs'] })
                qc.invalidateQueries({ queryKey: ['pipeline-runs', id] })
              }}
            />
          </Box>
        </Box>
      )}

      {/* SQL Bottom Panel */}
      <SqlBottomPanel
        panel={(() => {
          const base = { ...sqlPanel }
          if (selectedNode?.data?.nodeType !== 'jdbc_extract') return base
          base.connectionId = selectedNode.data.config?.connection_id ?? null
          const ownParams: { key: string; value: string }[] = selectedNode.data.config?.params ?? []
          // Look for an upstream Iterator node connected to this JDBC Extract
          const inEdge = edges.find(e => e.target === selectedNode.id)
          const iterNode = inEdge
            ? nodes.find(n => n.id === inEdge.source && n.data.nodeType === 'iterator')
            : null
          if (!iterNode) {
            base.params = ownParams
            return base
          }
          const iterCfg = iterNode.data.config ?? {}
          // Use first active entry as sample values for preview
          const dict = dictionaries.find(d => d.id === iterCfg.dictionary_id)
          const selectedKeys: string[] = iterCfg.selected_keys ?? []
          const entryFilters: IteratorEntryFilter[] = (iterCfg.entry_filters ?? [])
            .filter((f: { column?: string; value?: string }) => f?.column && f?.value)
          const activeEntries = getIteratorActiveEntries(dict, selectedKeys, entryFilters)
          const sampleEntry = activeEntries[0]
          const ownKeys = new Set(ownParams.map(p => p.key))
          if (sampleEntry) {
            const iterParams: { key: string; value: string }[] = [
              { key: iterCfg.key_param ?? 'app_id',     value: sampleEntry.key },
              { key: iterCfg.value_param ?? 'app_name', value: sampleEntry.value },
            ]
            base.params = [...ownParams, ...iterParams.filter(p => !ownKeys.has(p.key))]
            base.iteratorInfo = `Preview uses first iterator entry: ${iterCfg.key_param ?? 'app_id'} = "${sampleEntry.key}", ${iterCfg.value_param ?? 'app_name'} = "${sampleEntry.value}"${
              activeEntries.length > 1 ? ` (${activeEntries.length} entries will run in full execution)` : ''
            }`
          } else {
            // No entries — add placeholder that surfaces as unresolved
            base.params = ownParams
            base.iteratorInfo = dict
              ? 'Iterator dictionary has no entries — preview unavailable'
              : 'No dictionary selected on Iterator node'
          }
          return base
        })()}
        onClose={() => setSqlPanel(p => ({ ...p, open: false }))}
        onHeightChange={h => setSqlPanel(p => ({ ...p, height: h }))}
      />

      <ExecutionPlanDialog
        open={executionPlanOpen}
        onClose={() => setExecutionPlanOpen(false)}
        plan={executionPlan}
      />

      <Dialog open={editMetaOpen} onClose={closeMetaEditor} maxWidth="sm" fullWidth>
        <DialogTitle>{metaEditorMode === 'clone' ? 'Clone Pipeline' : 'Edit Pipeline Details'}</DialogTitle>
        <DialogContent sx={{ pt: '16px !important' }}>
          {metaEditError && <Alert severity="error" sx={{ mb: 1.5 }}>{metaEditError}</Alert>}
          <TextField
            label="Name"
            value={metaDraftName}
            onChange={e => {
              setMetaDraftName(e.target.value)
              if (metaEditError) setMetaEditError('')
            }}
            fullWidth
            size="small"
            autoFocus
          />
          <Autocomplete
            freeSolo
            options={categoryOptions}
            value={metaDraftCategory}
            onInputChange={(_, value) => setMetaDraftCategory(value)}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Category"
                fullWidth
                size="small"
                sx={{ mt: 1.5 }}
              />
            )}
          />
          <Box sx={{ mt: 1.5 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Status
            </Typography>
            <Select
              value={metaDraftStatus}
              onChange={event => setMetaDraftStatus(event.target.value as Pipeline['status'])}
              size="small"
              fullWidth
            >
              <MenuItem value="active">Active</MenuItem>
              <MenuItem value="inactive">Inactive</MenuItem>
              <MenuItem value="draft">Draft</MenuItem>
            </Select>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeMetaEditor} disabled={cloneMut.isPending}>Cancel</Button>
          <Button variant="contained" onClick={applyMetaEditor} disabled={cloneMut.isPending}>
            {cloneMut.isPending ? <CircularProgress size={14} /> : (metaEditorMode === 'clone' ? 'Save Clone' : 'Apply')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete pipeline confirm */}
      <Dialog open={deletePipelineConfirm} onClose={() => setDeletePipelineConfirm(false)} maxWidth="xs">
        <DialogTitle>Delete Pipeline</DialogTitle>
        <DialogContent>
          <Typography>
            Permanently delete <strong>{pipelineName || 'this pipeline'}</strong>? This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeletePipelineConfirm(false)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={deletePipelineMut.isPending}
            onClick={() => deletePipelineMut.mutate()}>
            {deletePipelineMut.isPending ? <CircularProgress size={16} /> : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={warnNoBizDate} onClose={() => setWarnNoBizDate(false)} maxWidth="xs">
        <DialogTitle>Business Date Not Set</DialogTitle>
        <DialogContent>
          <Typography>
            No <strong>business date</strong> is set in the execution context. Set one in the context bar or <strong>Settings</strong> before running a pipeline.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWarnNoBizDate(false)} autoFocus>OK</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
