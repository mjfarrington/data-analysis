import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ReactFlow, Background, MiniMap,
  addEdge, useNodesState, useEdgesState,
  useReactFlow, useViewport,
  type Node, type Edge, type Connection, type EdgeProps,
  MarkerType, Panel, BackgroundVariant,
  NodeToolbar, Position, Handle,
  BaseEdge, EdgeLabelRenderer, getSmoothStepPath,
  ConnectionLineType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Box, Typography, Card, CardContent, Chip, Alert, CircularProgress,
  List, ListItem, ListItemText, ListItemSecondaryAction, IconButton,
  Divider, Button, Select, MenuItem, FormControl, InputLabel,
  useTheme, alpha, Tooltip, LinearProgress,
  Dialog, DialogTitle, DialogContent, DialogActions,
  Tab, Tabs, TextField, Menu as MuiMenu, InputAdornment,
  Switch, FormControlLabel, Grid,
} from '@mui/material'
import {
  Delete, Add, Refresh, AccountTree, Storage, Info,
  CheckCircle, Error as ErrorIcon, PendingOutlined, Cancel,
  ZoomIn as ZoomInIcon, ZoomOut as ZoomOutIcon,
  FitScreen as FitScreenIcon, RestartAlt as ResetIcon,
  Edit as EditIcon, OpenInNew as OpenInNewIcon,
  PlayArrow, Schedule, CloudUpload,
  Search as SearchIcon, ViewModule as SnapGridIcon,
} from '@mui/icons-material'
import { useAppSettings } from '../hooks/useAppSettings'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import { formatDistanceToNow } from 'date-fns'
import { parseApiDate } from '../utils/dates'
import { graphApi, pipelinesApi, sqlFilesApi, connectionsApi, GraphNode as ApiNode, GraphEdge as ApiEdge, ExecutionContext, ExtractConfig, Pipeline, LoadSparkRequest, LoadSparkResult, ParquetDatesResult } from '../api/client'
import ExtractConfigWizard from '../components/ExtractConfigWizard'
import DateField from '../components/DateField'

// ─── Constants ────────────────────────────────────────────────────────────────
const NODE_W = 240
const NODE_H = 96
const SNAP_GRID: [number, number] = [20, 20]
const VIEWPORT_KEY = 'pipeline-graph-viewport-v1'

// ─── Colour helpers ───────────────────────────────────────────────────────────
const STATUS_COLOUR: Record<string, string> = {
  active: '#10b981',
  inactive: '#94a3b8',
  draft: '#f59e0b',
}

const RUN_STATUS_COLOUR: Record<string, string> = {
  completed: '#10b981',
  failed: '#ef4444',
  running: '#3b82f6',
  pending: '#f59e0b',
  cancelled: '#6b7280',
}

const RUN_STATUS_ICON: Record<string, React.ReactNode> = {
  completed: <CheckCircle sx={{ fontSize: 13 }} />,
  failed: <ErrorIcon sx={{ fontSize: 13 }} />,
  running: <CircularProgress size={11} />,
  pending: <PendingOutlined sx={{ fontSize: 13 }} />,
  cancelled: <Cancel sx={{ fontSize: 13 }} />,
}

const SOURCE_LABEL: Record<string, string> = {
  grpc: 'gRPC',
  jdbc: 'JDBC',
  datawarehouse: 'DW',
}

// ─── Module-level action registry (singleton for this page) ─────────────────
const nodeActions = {
  onEdit: (_id: number) => {},
  onTrigger: (_id: number) => {},
  onViewDeps: (_id: number) => {},
  onOpenPipelines: (_id: number) => {},
  onLoadSpark: (_id: number) => {},
}

// Module-level context passed down to nodes (avoids prop-drilling through ReactFlow)
const nodeContext = { businessDate: null as string | null }

// ─── Custom node component ────────────────────────────────────────────────────
function PipelineNode({ data, selected }: { data: ApiNode; selected?: boolean }) {
  const isRunning = data.last_run_status === 'running'
  const runColor = data.last_run_status ? (RUN_STATUS_COLOUR[data.last_run_status] ?? '#6b7280') : '#2a3550'
  const borderColor = selected ? '#3b82f6' : runColor
  const statusColor = STATUS_COLOUR[data.status] ?? '#94a3b8'
  const appNames = data.app_names ?? []

  return (
    <>
      {/* Quick-action toolbar — appears when node is selected */}
      <NodeToolbar isVisible={selected} position={Position.Top} offset={10}>
        <Box sx={{
          display: 'flex', gap: 0.25,
          bgcolor: '#111827', border: '1px solid #2a3550',
          borderRadius: 1.5, px: 0.75, py: 0.4,
          boxShadow: '0 4px 14px rgba(0,0,0,0.7)',
        }}>
          <Tooltip title="Edit pipeline">
            <IconButton size="small" onClick={() => nodeActions.onEdit(data.id)}
              sx={{ color: '#94a3b8', p: 0.5, '&:hover': { color: '#e2e8f0', bgcolor: '#1e293b' } }}>
              <EditIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Trigger run">
            <IconButton size="small" onClick={() => nodeActions.onTrigger(data.id)}
              sx={{ color: '#94a3b8', p: 0.5, '&:hover': { color: '#10b981', bgcolor: '#1e293b' } }}>
              <PlayArrow sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="View dependencies">
            <IconButton size="small" onClick={() => nodeActions.onViewDeps(data.id)}
              sx={{ color: '#94a3b8', p: 0.5, '&:hover': { color: '#e2e8f0', bgcolor: '#1e293b' } }}>
              <AccountTree sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Open in Studio">
            <IconButton size="small" onClick={() => nodeActions.onOpenPipelines(data.id)}
              sx={{ color: '#94a3b8', p: 0.5, '&:hover': { color: '#3b82f6', bgcolor: '#1e293b' } }}>
              <OpenInNewIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Load to Spark">
            <IconButton size="small" onClick={() => nodeActions.onLoadSpark(data.id)}
              sx={{ color: '#94a3b8', p: 0.5, '&:hover': { color: '#a78bfa', bgcolor: '#1e293b' } }}>
              <CloudUpload sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </NodeToolbar>

      {/* Node body */}
      <Box
        sx={{
          width: NODE_W,
          borderRadius: '10px',
          border: `2px solid ${borderColor}`,
          bgcolor: '#111827',
          boxShadow: selected
            ? `0 0 0 3px ${alpha('#3b82f6', 0.25)}, 0 4px 16px rgba(0,0,0,0.5)`
            : '0 2px 8px rgba(0,0,0,0.4)',
          display: 'flex',
          flexDirection: 'column',
          cursor: 'pointer',
          transition: 'box-shadow 0.15s, border-color 0.15s',
          overflow: 'hidden',
          ...(isRunning && {
            '@keyframes borderPulse': {
              '0%, 100%': { borderColor: RUN_STATUS_COLOUR.running },
              '50%': { borderColor: '#60a5fa', boxShadow: `0 0 0 4px ${alpha(RUN_STATUS_COLOUR.running, 0.2)}` },
            },
            animation: 'borderPulse 1.4s ease-in-out infinite',
          }),
        }}
      >
        {/* Solid status header */}
        <Box sx={{
          bgcolor: alpha(statusColor, 0.18),
          borderBottom: `1px solid ${alpha(statusColor, 0.25)}`,
          px: 1.25, py: 0.5,
          display: 'flex', alignItems: 'center', gap: 0.75,
        }}>
          <Storage sx={{ fontSize: 13, color: statusColor, flexShrink: 0 }} />
          <Typography sx={{
            fontSize: '0.78rem', fontWeight: 700, color: '#e2e8f0',
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {data.name}
          </Typography>
          <Typography sx={{ fontSize: '0.6rem', fontWeight: 600, color: statusColor, textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>
            {data.status}
          </Typography>
        </Box>

        {/* App names */}
        {appNames.length > 0 && (
          <Box sx={{ px: 1.25, pt: 0.5, pb: 0.25, display: 'flex', flexWrap: 'wrap', gap: 0.4 }}>
            {appNames.slice(0, 3).map((n) => (
              <Typography key={n} sx={{
                fontSize: '0.6rem', color: '#94a3b8', bgcolor: '#1e293b',
                px: 0.6, py: 0.1, borderRadius: 0.5,
                maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{n}</Typography>
            ))}
            {appNames.length > 3 && (
              <Typography sx={{ fontSize: '0.6rem', color: '#64748b' }}>+{appNames.length - 3}</Typography>
            )}
          </Box>
        )}

        {/* Footer */}
        <Box sx={{ display: 'flex', alignItems: 'center', px: 1.25, py: 0.5, gap: 0.5 }}>
          <Chip
            label={SOURCE_LABEL[data.source_type] ?? data.source_type.toUpperCase()}
            size="small"
            sx={{ height: 16, fontSize: '0.62rem', bgcolor: '#1e293b', color: '#64748b' }}
          />
          {data.last_run_status && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, color: runColor }}>
              {RUN_STATUS_ICON[data.last_run_status]}
              <Typography sx={{ fontSize: '0.62rem', color: runColor }}>{data.last_run_status}</Typography>
            </Box>
          )}
          <Box sx={{ flex: 1 }} />
          {nodeContext.businessDate && (
            <Typography sx={{ fontSize: '0.58rem', color: '#64748b', fontFamily: 'monospace' }}>
              {nodeContext.businessDate}
            </Typography>
          )}
        </Box>
      </Box>

      <Handle type="target" position={Position.Left}
        style={{ background: '#3b82f6', width: 10, height: 10, border: '2px solid #111827' }} />
      <Handle type="source" position={Position.Right}
        style={{ background: '#3b82f6', width: 10, height: 10, border: '2px solid #111827' }} />
    </>
  )
}

// ─── Custom edge — smoothstep path with floating delete on selection ──────────
function DependencyEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, selected, markerEnd, style,
}: EdgeProps) {
  const { deleteElements } = useReactFlow()
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 8,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: selected ? '#60a5fa' : '#3b82f6',
          strokeWidth: selected ? 3 : 2,
          filter: selected ? 'drop-shadow(0 0 4px rgba(59,130,246,0.6))' : undefined,
        }}
      />
      {selected && (
        <EdgeLabelRenderer>
          <Box
            sx={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
              zIndex: 10,
            }}
            className="nodrag nopan"
          >
            <Tooltip title="Remove dependency (Del)">
              <IconButton
                size="small"
                onClick={() => deleteElements({ edges: [{ id }] })}
                sx={{
                  bgcolor: '#ef4444', color: 'white', width: 22, height: 22,
                  '&:hover': { bgcolor: '#dc2626', transform: 'scale(1.15)' },
                  transition: 'all 0.15s',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
                }}
              >
                <Delete sx={{ fontSize: 12 }} />
              </IconButton>
            </Tooltip>
          </Box>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const nodeTypes = { pipeline: PipelineNode }
const edgeTypes = { dependency: DependencyEdge }

// ─── Layout persistence ───────────────────────────────────────────────────────
const LAYOUT_KEY = 'pipeline-graph-layout-v1'

function loadSavedPositions(): Record<string, { x: number; y: number }> {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function savePositions(nodes: Node[]) {
  const positions: Record<string, { x: number; y: number }> = {}
  for (const n of nodes) positions[n.id] = n.position
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(positions))
}

// ─── Viewport persistence ─────────────────────────────────────────────────────
function loadViewport(): { x: number; y: number; zoom: number } | null {
  try { return JSON.parse(localStorage.getItem(VIEWPORT_KEY) ?? 'null') } catch { return null }
}
function saveViewport(vp: { x: number; y: number; zoom: number }) {
  localStorage.setItem(VIEWPORT_KEY, JSON.stringify(vp))
}

// Stable ref so the outer component can call setCenter from inside ReactFlow context
const rfCenterRef = {
  current: (_x: number, _y: number, _opts?: { zoom?: number; duration?: number }) => {},
}

// Rendered inside <ReactFlow> — handles viewport restore + exposes setCenter
function ViewportHelper() {
  const { setCenter, setViewport, fitView } = useReactFlow()
  const initDone = useRef(false)
  useEffect(() => {
    if (!initDone.current) {
      initDone.current = true
      const saved = loadViewport()
      if (saved) setViewport(saved, { duration: 0 })
      else fitView({ padding: 0.2, duration: 300 })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  rfCenterRef.current = (x, y, opts) => setCenter(x, y, opts as Parameters<typeof setCenter>[2])
  return null
}

// ─── Zoom toolbar (must render inside ReactFlow for context) ──────────────────
function ZoomPanel({ onResetLayout, snapGrid, onToggleSnap }: {
  onResetLayout: () => void
  snapGrid: boolean
  onToggleSnap: () => void
}) {
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  const { zoom } = useViewport()

  return (
    <Panel position="bottom-center">
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 0.25,
        bgcolor: '#111827', border: '1px solid #2a3550',
        borderRadius: 2, px: 0.75, py: 0.5,
        boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
      }}>
        <Tooltip title="Zoom out">
          <IconButton size="small" onClick={() => zoomOut({ duration: 200 })} sx={{ color: '#e2e8f0', p: 0.5 }}>
            <ZoomOutIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Typography sx={{ fontSize: '0.72rem', color: '#94a3b8', fontFamily: 'monospace', minWidth: 38, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </Typography>
        <Tooltip title="Zoom in">
          <IconButton size="small" onClick={() => zoomIn({ duration: 200 })} sx={{ color: '#e2e8f0', p: 0.5 }}>
            <ZoomInIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Box sx={{ width: 1, height: 16, bgcolor: '#2a3550', mx: 0.5 }} />
        <Tooltip title="Fit all nodes in view">
          <IconButton size="small" onClick={() => fitView({ duration: 400, padding: 0.2 })} sx={{ color: '#e2e8f0', p: 0.5 }}>
            <FitScreenIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title={snapGrid ? 'Snap to grid: ON' : 'Snap to grid: OFF'}>
          <IconButton
            size="small" onClick={onToggleSnap}
            sx={{ color: snapGrid ? '#3b82f6' : '#475569', p: 0.5, '&:hover': { color: '#e2e8f0' } }}
          >
            <SnapGridIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Box sx={{ width: 1, height: 16, bgcolor: '#2a3550', mx: 0.5 }} />
        <Tooltip title="Reset to auto-layout">
          <IconButton size="small" onClick={onResetLayout} sx={{ color: '#475569', p: 0.5, '&:hover': { color: '#ef4444' } }}>
            <ResetIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Panel>
  )
}

// ─── Layout: simple left-to-right layered layout ─────────────────────────────
function computeLayout(apiNodes: ApiNode[], apiEdges: ApiEdge[]): { nodes: Node[]; edges: Edge[] } {
  // Topological layer assignment
  const inDegree: Record<number, number> = {}
  const children: Record<number, number[]> = {}
  for (const n of apiNodes) { inDegree[n.id] = 0; children[n.id] = [] }
  for (const e of apiEdges) {
    inDegree[e.target] = (inDegree[e.target] ?? 0) + 1
    children[e.source] = children[e.source] ?? []
    children[e.source].push(e.target)
  }

  // BFS to assign layers
  const layer: Record<number, number> = {}
  const queue = apiNodes.filter((n) => inDegree[n.id] === 0).map((n) => n.id)
  for (const id of queue) layer[id] = 0
  let head = 0
  while (head < queue.length) {
    const cur = queue[head++]
    for (const child of children[cur] ?? []) {
      layer[child] = Math.max(layer[child] ?? 0, (layer[cur] ?? 0) + 1)
      queue.push(child)
    }
  }
  // Nodes with no layer assignment go to layer 0
  for (const n of apiNodes) { if (layer[n.id] === undefined) layer[n.id] = 0 }

  // Position within each layer
  const layerCounts: Record<number, number> = {}
  const layerIdx: Record<number, number> = {}
  const GAP_X = 280
  const GAP_Y = 110
  for (const n of apiNodes) {
    const l = layer[n.id]
    layerIdx[n.id] = layerCounts[l] ?? 0
    layerCounts[l] = (layerCounts[l] ?? 0) + 1
  }

  const nodes: Node[] = apiNodes.map((n) => {
    const l = layer[n.id]
    const idx = layerIdx[n.id]
    const totalInLayer = layerCounts[l]
    return {
      id: String(n.id),
      type: 'pipeline',
      position: {
        x: l * GAP_X + 40,
        y: idx * GAP_Y - ((totalInLayer - 1) * GAP_Y) / 2 + 300,
      },
      data: { ...n, selected: false },
    }
  })

  const edges: Edge[] = apiEdges.map((e) => ({
    id: e.id,
    type: 'dependency',
    source: String(e.source),
    target: String(e.target),
    markerEnd: { type: MarkerType.ArrowClosed, color: '#3b82f6', width: 16, height: 16 },
    style: { stroke: '#3b82f6', strokeWidth: 2 },
    animated: true,
    data: { dependency_id: e.dependency_id },
  }))

  return { nodes, edges }
}

// ─── Dependency panel ─────────────────────────────────────────────────────────
function DependencyPanel({
  selected,
  allNodes,
  onAdded,
  onRemoved,
}: {
  selected: ApiNode | null
  allNodes: ApiNode[]
  onAdded: () => void
  onRemoved: () => void
}) {
  const theme = useTheme()
  const qc = useQueryClient()
  const [upstreamId, setUpstreamId] = useState<number | ''>('')

  const { data: deps, isLoading } = useQuery({
    queryKey: ['deps', selected?.id],
    queryFn: () => graphApi.listDeps(selected!.id).then((r) => r.data),
    enabled: !!selected,
  })

  const addMut = useMutation({
    mutationFn: ({ pid, uid }: { pid: number; uid: number }) => graphApi.addDep(pid, uid),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pipeline-graph'] }); qc.invalidateQueries({ queryKey: ['deps', selected?.id] }); setUpstreamId(''); onAdded() },
  })

  const removeMut = useMutation({
    mutationFn: ({ pid, depId }: { pid: number; depId: number }) => graphApi.removeDep(pid, depId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pipeline-graph'] }); qc.invalidateQueries({ queryKey: ['deps', selected?.id] }); onRemoved() },
  })

  const available = allNodes.filter((n) => n.id !== selected?.id && !deps?.some((d) => d.upstream_id === n.id))

  if (!selected) {
    return (
      <Box sx={{ p: 2, color: 'text.secondary', textAlign: 'center' }}>
        <AccountTree sx={{ fontSize: 40, mb: 1, opacity: 0.3 }} />
        <Typography variant="body2">Click a node to manage its dependencies</Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ p: 1.5 }}>
      <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>{selected.name}</Typography>
      <Chip label={selected.status} size="small" sx={{ mb: 1.5, fontSize: '0.68rem', color: STATUS_COLOUR[selected.status], bgcolor: alpha(STATUS_COLOUR[selected.status] ?? '#2a3550', 0.15) }} />

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
        DEPENDS ON (upstream must complete first)
      </Typography>

      {isLoading && <LinearProgress sx={{ mb: 1 }} />}
      {!isLoading && (!deps || deps.length === 0) && (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 1 }}>No dependencies</Typography>
      )}
      {deps && deps.length > 0 && (
        <List dense disablePadding sx={{ mb: 1 }}>
          {deps.map((dep) => {
            const upNode = allNodes.find((n) => n.id === dep.upstream_id)
            return (
              <ListItem key={dep.id} disableGutters sx={{ py: 0.25 }}>
                <ListItemText
                  primary={upNode?.name ?? `Pipeline #${dep.upstream_id}`}
                  primaryTypographyProps={{ variant: 'body2', fontSize: '0.78rem' }}
                />
                <ListItemSecondaryAction>
                  <Tooltip title="Remove dependency">
                    <IconButton size="small" edge="end" onClick={() => removeMut.mutate({ pid: selected.id, depId: dep.id })}
                      disabled={removeMut.isPending}>
                      <Delete sx={{ fontSize: 15 }} />
                    </IconButton>
                  </Tooltip>
                </ListItemSecondaryAction>
              </ListItem>
            )
          })}
        </List>
      )}

      <Divider sx={{ my: 1 }} />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>ADD UPSTREAM</Typography>
      {addMut.isError && (
        <Alert severity="error" sx={{ mb: 1, py: 0, fontSize: '0.72rem' }}>
          {(addMut.error as Error).message}
        </Alert>
      )}
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <FormControl size="small" fullWidth>
          <InputLabel sx={{ fontSize: '0.78rem' }}>Pipeline</InputLabel>
          <Select
            value={upstreamId}
            label="Pipeline"
            onChange={(e) => setUpstreamId(e.target.value as number)}
            sx={{ fontSize: '0.78rem' }}
          >
            {available.map((n) => (
              <MenuItem key={n.id} value={n.id} sx={{ fontSize: '0.78rem' }}>{n.name}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button
          variant="contained" size="small" startIcon={<Add />}
          disabled={upstreamId === '' || addMut.isPending}
          onClick={() => upstreamId !== '' && addMut.mutate({ pid: selected.id, uid: upstreamId as number })}
          sx={{ flexShrink: 0 }}
        >
          Add
        </Button>
      </Box>
    </Box>
  )
}

// ─── Edit dialog ─────────────────────────────────────────────────────────────
interface EditDialogProps {
  pipelineId: number | null
  open: boolean
  onClose: () => void
}
function EditPipelineDialog({ pipelineId, open, onClose }: EditDialogProps) {
  const qc = useQueryClient()
  const { data: pipeline } = useQuery({
    queryKey: ['pipeline', pipelineId],
    queryFn: () => pipelinesApi.get(pipelineId!).then((r) => r.data),
    enabled: !!pipelineId && open,
  })
  const { data: sqlFiles = [] } = useQuery({
    queryKey: ['sql-files', 'extract'],
    queryFn: () => sqlFilesApi.list('extract').then((r) => r.data),
    enabled: open,
  })
  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.list().then((r) => r.data),
    enabled: open,
  })

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<'active' | 'inactive' | 'draft'>('active')
  const [extractConfig, setExtractConfig] = useState<ExtractConfig | null>(null)

  useEffect(() => {
    if (pipeline) {
      setName(pipeline.name)
      setDescription(pipeline.description ?? '')
      setStatus(pipeline.status)
      setExtractConfig(pipeline.extract_config)
    }
  }, [pipeline])

  const setExtract = (key: string, val: unknown) =>
    setExtractConfig((prev) => prev ? { ...prev, [key]: val } : prev)

  const mut = useMutation({
    mutationFn: () => pipelinesApi.update(pipelineId!, {
      name,
      description,
      status,
      ...(extractConfig && { extract_config: extractConfig }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipeline-graph'] })
      qc.invalidateQueries({ queryKey: ['pipeline', pipelineId] })
      onClose()
    },
  })

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>Edit Pipeline</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '20px !important' }}>
        {/* Identity fields */}
        <Box sx={{ display: 'flex', gap: 1.5 }}>
          <TextField
            label="Name" value={name} onChange={(e) => setName(e.target.value)}
            size="small" sx={{ flex: 1 }} autoFocus
          />
          <FormControl size="small" sx={{ width: 140 }}>
            <InputLabel>Status</InputLabel>
            <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <MenuItem value="active">Active</MenuItem>
              <MenuItem value="inactive">Inactive</MenuItem>
              <MenuItem value="draft">Draft</MenuItem>
            </Select>
          </FormControl>
        </Box>
        <TextField
          label="Description" value={description} onChange={(e) => setDescription(e.target.value)}
          size="small" fullWidth multiline rows={2}
        />

        {/* Extract configuration */}
        {extractConfig ? (
          <ExtractConfigWizard
            config={extractConfig}
            onChange={setExtract}
            sqlFiles={sqlFiles}
            connections={connections}
          />
        ) : (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}><CircularProgress size={20} /></Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} size="small">Cancel</Button>
        <Button
          variant="contained" size="small"
          disabled={!name.trim() || mut.isPending || !extractConfig}
          onClick={() => mut.mutate()}
        >
          {mut.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Node detail panel ────────────────────────────────────────────────────────
interface NodeDetailPanelProps {
  selectedNode: ApiNode
  onEdit: () => void
}
function NodeDetailPanel({ selectedNode, onEdit }: NodeDetailPanelProps) {
  const navigate = useNavigate()
  const { data: pipeline } = useQuery({
    queryKey: ['pipeline', selectedNode.id],
    queryFn: () => pipelinesApi.get(selectedNode.id).then((r) => r.data),
  })
  const theme = useTheme()
  const statusColor = STATUS_COLOUR[selectedNode.status] ?? '#6b7280'

  return (
    <Box sx={{ px: 1.5, py: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {/* name + actions */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
        <Typography variant="subtitle2" fontWeight={700} sx={{ flex: 1, wordBreak: 'break-word' }}>
          {selectedNode.name}
        </Typography>
        <Tooltip title="Edit pipeline">
          <IconButton size="small" onClick={onEdit} sx={{ color: 'text.secondary' }}>
            <EditIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Open in Pipelines">
          <IconButton size="small" onClick={() => navigate('/etl')} sx={{ color: 'text.secondary' }}>
            <OpenInNewIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {/* status + source */}
      <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
        <Chip
          size="small"
          label={selectedNode.status}
          sx={{ bgcolor: alpha(statusColor, 0.15), color: statusColor, fontWeight: 600, fontSize: '0.68rem', height: 20 }}
        />
        <Chip
          size="small"
          icon={<Storage sx={{ fontSize: '0.75rem !important' }} />}
          label={SOURCE_LABEL[selectedNode.source_type] ?? selectedNode.source_type}
          sx={{ fontSize: '0.68rem', height: 20 }}
          variant="outlined"
        />
      </Box>

      {/* description */}
      {selectedNode.description && (
        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.4 }}>
          {selectedNode.description}
        </Typography>
      )}

      <Divider />

      {/* run stats */}
      {pipeline ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <PlayArrow sx={{ fontSize: '0.85rem', color: 'text.secondary' }} />
              <Typography variant="caption" color="text.secondary">Total runs</Typography>
            </Box>
            <Typography variant="caption" fontWeight={600}>{pipeline.total_runs}</Typography>
          </Box>
          {pipeline.last_run && (
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Schedule sx={{ fontSize: '0.85rem', color: 'text.secondary' }} />
                <Typography variant="caption" color="text.secondary">Last run</Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                {pipeline.last_run.status === 'completed'
                  ? <CheckCircle sx={{ fontSize: '0.8rem', color: STATUS_COLOUR.active }} />
                  : pipeline.last_run.status === 'running'
                    ? <PendingOutlined sx={{ fontSize: '0.8rem', color: STATUS_COLOUR.inactive }} />
                    : <ErrorIcon sx={{ fontSize: '0.8rem', color: '#ef4444' }} />}
                <Typography variant="caption" fontWeight={600}>
                  {pipeline.last_run.started_at
                    ? formatDistanceToNow(parseApiDate(pipeline.last_run.started_at), { addSuffix: true })
                    : '—'}
                </Typography>
              </Box>
            </Box>
          )}
          {pipeline.schedule && (
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="caption" color="text.secondary">Schedule</Typography>
              <Chip
                size="small"
                label={pipeline.schedule}
                sx={{ fontSize: '0.65rem', height: 18, fontFamily: 'monospace' }}
                variant="outlined"
              />
            </Box>
          )}
          <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
            <Typography variant="caption" color="text.secondary">Updated</Typography>
            <Typography variant="caption">
              {formatDistanceToNow(parseApiDate(pipeline.updated_at), { addSuffix: true })}
            </Typography>
          </Box>
        </Box>
      ) : (
        <CircularProgress size={16} sx={{ alignSelf: 'center' }} />
      )}
    </Box>
  )
}

// ─── Load to Spark dialog ──────────────────────────────────────────────────────
function LoadToSparkDialog({ pipeline, open, onClose }: { pipeline: Pipeline | null; open: boolean; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar()
  const qc = useQueryClient()

  const { data: ctx } = useQuery<ExecutionContext>({
    queryKey: ['execution-context'],
    queryFn: () => pipelinesApi.getContext().then((r) => r.data),
    enabled: open,
  })

  const { data: parquetInfo } = useQuery<ParquetDatesResult>({
    queryKey: ['parquet-dates', pipeline?.id],
    queryFn: () => pipelinesApi.parquetDates(pipeline!.id).then((r) => r.data),
    enabled: open && !!pipeline,
  })

  const nsPrefix = ctx?.namespace_prefix || 'data_'
  const derivedDate = ctx?.business_date || ''

  const [date, setDate] = useState('')
  const [namespaceDb, setNamespaceDb] = useState('')
  const [tableName, setTableName] = useState('')
  const [mode, setMode] = useState<'overwrite' | 'append'>('overwrite')
  const [result, setResult] = useState<LoadSparkResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const derivedNs = (date || derivedDate)
    ? `${nsPrefix}${(date || derivedDate).replace(/-/g, '')}`
    : ''

  useEffect(() => {
    if (open) {
      setDate(ctx?.business_date || '')
      setResult(null)
      setErrorMsg(null)
    }
  }, [open, ctx])

  useEffect(() => {
    const d = date || derivedDate
    if (d) setNamespaceDb(`${nsPrefix}${d.replace(/-/g, '')}`)
  }, [date, derivedDate, nsPrefix])

  const jobName = pipeline?.extract_config?.job_name
    || pipeline?.name?.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || ''

  const mutation = useMutation({
    mutationFn: () => {
      const body: LoadSparkRequest = {
        date: date || derivedDate,
        namespace_db: namespaceDb || derivedNs,
        table_name: tableName || undefined,
        mode,
      }
      return pipelinesApi.loadToSpark(pipeline!.id, body).then((r) => r.data)
    },
    onSuccess: (data: LoadSparkResult) => {
      setResult(data)
      setErrorMsg(null)
      enqueueSnackbar(`Loaded ${data.rows_loaded.toLocaleString()} rows into ${data.table}`, { variant: 'success' })
      qc.invalidateQueries({ queryKey: ['catalog'] })
    },
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        || (e as Error).message || 'Unknown error'
      setErrorMsg(detail)
      setResult(null)
    },
  })

  const availableDates = parquetInfo?.dates ?? []

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <CloudUpload fontSize="small" color="primary" />
        Load to Spark: {pipeline?.name}
      </DialogTitle>
      <DialogContent dividers>
        <Alert severity="info" sx={{ mb: 2, fontSize: '0.78rem' }}>
          Reads all saved <strong>{jobName}</strong> output files for the selected date and consolidates every app_id into one Spark table.
        </Alert>

        {availableDates.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
              Available dates with data:
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
              {availableDates.map((d) => (
                <Chip
                  key={d.date}
                  label={`${d.date} (${d.app_ids} app${d.app_ids !== 1 ? 's' : ''}, ${d.file_count} files)`}
                  size="small"
                  variant={date === d.date ? 'filled' : 'outlined'}
                  color={date === d.date ? 'primary' : 'default'}
                  onClick={() => { setDate(d.date); setResult(null); setErrorMsg(null) }}
                  sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.72rem', cursor: 'pointer' }}
                />
              ))}
            </Box>
          </Box>
        )}

        {availableDates.length === 0 && parquetInfo && (
          <Alert severity="warning" sx={{ mb: 2, fontSize: '0.78rem' }}>
            No parquet/CSV output found for job <strong>{parquetInfo.job_name}</strong>. Run the pipeline first.
          </Alert>
        )}

        <Grid container spacing={2}>
          <Grid item xs={6}>
            <DateField label="Date" value={date || derivedDate} fullWidth
              onChange={(v) => { setDate(v); setResult(null); setErrorMsg(null) }}
              helperText="Business date to load" />
          </Grid>
          <Grid item xs={6}>
            <TextField label="Spark database" value={namespaceDb} fullWidth size="small"
              placeholder={derivedNs || 'e.g. data_20260417'}
              helperText="Spark catalog database (namespace)"
              onChange={(e) => setNamespaceDb(e.target.value)} />
          </Grid>
          <Grid item xs={6}>
            <TextField label="Table name" value={tableName} fullWidth size="small"
              placeholder={jobName.toLowerCase() || 'default: job_name'}
              helperText="Override table name (default: job name)"
              onChange={(e) => setTableName(e.target.value)} />
          </Grid>
          <Grid item xs={6}>
            <TextField select label="Write mode" value={mode} fullWidth size="small"
              onChange={(e) => setMode(e.target.value as 'overwrite' | 'append')}>
              <MenuItem value="overwrite">Overwrite</MenuItem>
              <MenuItem value="append">Append</MenuItem>
            </TextField>
          </Grid>
        </Grid>

        {result && (
          <Alert severity="success" sx={{ mt: 2, fontSize: '0.78rem' }}>
            Loaded <strong>{result.rows_loaded.toLocaleString()}</strong> rows from{' '}
            <strong>{result.app_ids_merged}</strong> app_id(s) into{' '}
            <code>{result.table}</code>
          </Alert>
        )}
        {errorMsg && (
          <Alert severity="error" sx={{ mt: 2, fontSize: '0.78rem', wordBreak: 'break-word' }}>
            {errorMsg}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" color="primary"
          startIcon={mutation.isPending ? <CircularProgress size={14} color="inherit" /> : <CloudUpload />}
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}>
          Load to Spark
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function PipelineGraph() {
  const theme = useTheme()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { enqueueSnackbar } = useSnackbar()
  const { settings: appSettings } = useAppSettings()

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [sideTab, setSideTab] = useState(0)
  const [editOpen, setEditOpen] = useState(false)
  const [snapGrid, setSnapGrid] = useState(false)
  const [search, setSearch] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const [loadSparkPipeline, setLoadSparkPipeline] = useState<Pipeline | null>(null)

  const { data: graph, isLoading, refetch } = useQuery({
    queryKey: ['pipeline-graph'],
    queryFn: () => graphApi.graph().then((r) => r.data),
    refetchInterval: 30_000,
  })

  const { data: execCtx } = useQuery<ExecutionContext>({
    queryKey: ['execution-context'],
    queryFn: () => pipelinesApi.getContext().then((r) => r.data),
    refetchInterval: 60_000,
  })
  // Keep module-level context in sync so PipelineNode can read it without props
  nodeContext.businessDate = execCtx?.business_date ?? null

  // ── Mutations ────────────────────────────────────────────────────────────────
  const runMut = useMutation({
    mutationFn: (id: number) => pipelinesApi.run(id).then((r) => r.data),
    onSuccess: () => {
      enqueueSnackbar('Run triggered', { variant: 'success' })
      setTimeout(() => qc.invalidateQueries({ queryKey: ['pipeline-graph'] }), 1500)
    },
    onError: () => enqueueSnackbar('Failed to trigger run', { variant: 'error' }),
  })

  const removeMut = useMutation({
    mutationFn: ({ pid, depId }: { pid: number; depId: number }) => graphApi.removeDep(pid, depId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipeline-graph'] })
      enqueueSnackbar('Dependency removed', { variant: 'info' })
    },
    onError: () => enqueueSnackbar('Failed to remove dependency', { variant: 'error' }),
  })

  const addDepMut = useMutation({
    mutationFn: ({ pid, uid }: { pid: number; uid: number }) => graphApi.addDep(pid, uid),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipeline-graph'] })
      enqueueSnackbar('Dependency added', { variant: 'success' })
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      enqueueSnackbar(msg ?? 'Cannot add dependency (cycle or duplicate)', { variant: 'error' })
      qc.invalidateQueries({ queryKey: ['pipeline-graph'] })
    },
  })

  // ── Register node toolbar / context-menu actions ──────────────────────────────
  const handleEdit = useCallback((id: number) => { setSelectedId(id); setEditOpen(true) }, [])
  const handleTrigger = useCallback((id: number) => { runMut.mutate(id) }, [runMut])
  const handleViewDeps = useCallback((id: number) => { setSelectedId(id); setSideTab(1) }, [])
  const handleOpenPipelines = useCallback((id: number) => { navigate(`/studio?id=${id}`) }, [navigate])
  const handleLoadSpark = useCallback((id: number) => {
    const pl = graph?.nodes.find((n) => n.id === id) as unknown as Pipeline | undefined
    // graph nodes don't carry full Pipeline; fetch it
    pipelinesApi.get(id).then((r) => setLoadSparkPipeline(r.data))
  }, [graph])
  nodeActions.onEdit = handleEdit
  nodeActions.onTrigger = handleTrigger
  nodeActions.onViewDeps = handleViewDeps
  nodeActions.onOpenPipelines = handleOpenPipelines
  nodeActions.onLoadSpark = handleLoadSpark

  // ── Graph layout ─────────────────────────────────────────────────────────────
  const { nodes: initNodes, edges: initEdges } = useMemo(
    () => (graph ? computeLayout(graph.nodes, graph.edges) : { nodes: [], edges: [] }),
    [graph]
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(initNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initEdges)

  // Sync when graph data changes — preserve dragged positions and selection state
  useEffect(() => {
    const saved = loadSavedPositions()
    const { nodes: n, edges: e } = computeLayout(graph?.nodes ?? [], graph?.edges ?? [])
    setNodes((prev) => n.map((newN) => {
      const existing = prev.find((p) => p.id === newN.id)
      if (existing) return { ...newN, position: existing.position, selected: !!existing.selected }
      const savedPos = saved[newN.id]
      return savedPos ? { ...newN, position: savedPos } : newN
    }))
    setEdges(e)
  }, [graph])

  const onNodeDragStop = useCallback((_: React.MouseEvent, __: Node, allNodes: Node[]) => {
    savePositions(allNodes)
  }, [])

  const resetLayout = useCallback(() => {
    localStorage.removeItem(LAYOUT_KEY)
    localStorage.removeItem(VIEWPORT_KEY)
    if (graph) {
      const { nodes: n, edges: e } = computeLayout(graph.nodes, graph.edges)
      setNodes(n)
      setEdges(e)
    }
  }, [graph, setNodes, setEdges])

  // Select a node both in the side panel and visually on canvas
  const selectNode = useCallback((id: number) => {
    setSelectedId(id)
    setNodes((nds) => nds.map((n) => ({ ...n, selected: Number(n.id) === id })))
  }, [setNodes])

  // ── Connection handlers ───────────────────────────────────────────────────────
  const onConnect = useCallback((params: Connection) => {
    if (!params.source || !params.target || params.source === params.target) return
    const pid = Number(params.target)
    const uid = Number(params.source)
    setEdges((eds) => addEdge({
      ...params,
      id: `dep-opt-${uid}-${pid}`,
      type: 'dependency',
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#3b82f6', width: 16, height: 16 },
      style: { stroke: '#3b82f6', strokeWidth: 2 },
      data: { dependency_id: 0 },
    }, eds))
    addDepMut.mutate({ pid, uid })
  }, [addDepMut, setEdges])

  const onEdgesDelete = useCallback((deletedEdges: Edge[]) => {
    for (const edge of deletedEdges) {
      const depId = (edge.data as { dependency_id?: number })?.dependency_id
      const pid = Number(edge.target)
      if (depId && pid) removeMut.mutate({ pid, depId })
    }
  }, [removeMut])

  // ── Search ────────────────────────────────────────────────────────────────────
  const filteredNodes = useMemo(() => {
    if (!search.trim()) return graph?.nodes ?? []
    const s = search.toLowerCase()
    return (graph?.nodes ?? []).filter((n) => n.name.toLowerCase().includes(s))
  }, [graph?.nodes, search])

  const jumpToNode = useCallback((nodeId: number) => {
    const n = nodes.find((nd) => nd.id === String(nodeId))
    if (n) rfCenterRef.current(n.position.x + NODE_W / 2, n.position.y + NODE_H / 2, { zoom: 1.2, duration: 500 })
  }, [nodes])

  const selectedNode = graph?.nodes.find((n) => n.id === selectedId) ?? null

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, flexShrink: 0 }}>
        <AccountTree sx={{ mr: 1, color: 'primary.main' }} />
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>Pipeline Graph</Typography>
          <Typography variant="caption" color="text.secondary">
            Drag nodes · click to inspect · right-click for actions · drag between handles to link
          </Typography>
        </Box>
        <Tooltip title="Refresh">
          <IconButton onClick={() => { refetch(); qc.invalidateQueries({ queryKey: ['pipeline-graph'] }) }}>
            <Refresh />
          </IconButton>
        </Tooltip>
      </Box>

      {isLoading && <LinearProgress sx={{ mb: 1 }} />}

      {!isLoading && graph?.nodes.length === 0 && (
        <Alert severity="info" icon={<Info />} sx={{ mb: 2 }}>
          No pipelines yet. Create pipelines on the <strong>ETL Pipelines</strong> page, then add dependencies here.
        </Alert>
      )}

      <Box sx={{ display: 'flex', flex: 1, gap: 2, minHeight: 0 }}>
        {/* ── Graph canvas ── */}
        <Box sx={{ flex: 1, borderRadius: 2, overflow: 'hidden', border: `1px solid ${theme.palette.divider}`, bgcolor: '#070b14', minHeight: 500 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            onNodeClick={(_, node) => { selectNode(Number(node.id)); setContextMenu(null) }}
            onPaneClick={() => { setSelectedId(null); setContextMenu(null) }}
            onNodeDragStop={onNodeDragStop}
            onNodeContextMenu={(e, node) => {
              e.preventDefault()
              setContextMenu({ x: e.clientX, y: e.clientY, nodeId: String(node.id) })
              selectNode(Number(node.id))
            }}
            onPaneContextMenu={(e) => e.preventDefault()}
            onMoveEnd={(_e, vp) => saveViewport(vp)}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            snapToGrid={snapGrid}
            snapGrid={SNAP_GRID}
            connectionLineType={ConnectionLineType.SmoothStep}
            defaultEdgeOptions={{
              type: appSettings.diagramEdgeStyle === 'bezier' ? 'default' : appSettings.diagramEdgeStyle,
              animated: true,
              markerEnd: { type: MarkerType.ArrowClosed, color: '#3b82f6', width: 16, height: 16 },
              style: { stroke: '#3b82f6', strokeWidth: 2 },
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={snapGrid ? 20 : 28}
              size={1}
              color={snapGrid ? '#1a2535' : '#0f172a'}
            />
            <MiniMap
              nodeStrokeColor={(n) => {
                const d = n.data as unknown as ApiNode
                if (d.last_run_status === 'running') return RUN_STATUS_COLOUR.running
                if (d.last_run_status === 'failed') return RUN_STATUS_COLOUR.failed
                return STATUS_COLOUR[d.status] ?? '#2a3550'
              }}
              nodeColor={(n) => {
                const d = n.data as unknown as ApiNode
                if (d.last_run_status === 'failed') return alpha(RUN_STATUS_COLOUR.failed, 0.2)
                if (d.last_run_status === 'running') return alpha(RUN_STATUS_COLOUR.running, 0.2)
                return '#131c2f'
              }}
              maskColor={alpha('#070b14', 0.7)}
              style={{ background: '#0d1424', border: '1px solid #1e293b', borderRadius: 6 }}
            />
            <ZoomPanel
              onResetLayout={resetLayout}
              snapGrid={snapGrid}
              onToggleSnap={() => setSnapGrid((s) => !s)}
            />
            <Panel position="top-left">
              <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                {Object.entries(STATUS_COLOUR).map(([s, c]) => (
                  <Box key={s} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, bgcolor: alpha(c, 0.12), px: 1, py: 0.25, borderRadius: 1, border: `1px solid ${alpha(c, 0.25)}` }}>
                    <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: c }} />
                    <Typography sx={{ fontSize: '0.65rem', color: c }}>{s}</Typography>
                  </Box>
                ))}
              </Box>
            </Panel>
            <ViewportHelper />
          </ReactFlow>
        </Box>

        {/* ── Side panel ── */}
        <Card variant="outlined" sx={{ width: 280, flexShrink: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {/* Always-visible search */}
          <Box sx={{ px: 1.5, py: 1, borderBottom: `1px solid ${theme.palette.divider}`, flexShrink: 0 }}>
            <TextField
              size="small"
              fullWidth
              placeholder="Find pipeline…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                  </InputAdornment>
                ),
              }}
              sx={{ '& .MuiInputBase-input': { fontSize: '0.8rem', py: 0.5 } }}
            />
          </Box>

          {search.trim() ? (
            /* Search results */
            <Box sx={{ flex: 1, overflow: 'auto' }}>
              {filteredNodes.length === 0 ? (
                <Box sx={{ p: 2, textAlign: 'center' }}>
                  <Typography variant="caption" color="text.secondary">No matches</Typography>
                </Box>
              ) : (
                <List dense disablePadding>
                  {filteredNodes.map((n) => (
                    <ListItem
                      key={n.id}
                      disableGutters
                      sx={{ px: 1.5, py: 0.75, cursor: 'pointer', '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.07) } }}
                      onClick={() => { selectNode(n.id); setSideTab(0); setSearch(''); jumpToNode(n.id) }}
                    >
                      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: STATUS_COLOUR[n.status] ?? '#6b7280', mr: 1.25, flexShrink: 0 }} />
                      <ListItemText
                        primary={n.name}
                        primaryTypographyProps={{ variant: 'body2', fontSize: '0.78rem', noWrap: true, fontWeight: 600 }}
                        secondary={SOURCE_LABEL[n.source_type] ?? n.source_type}
                        secondaryTypographyProps={{ fontSize: '0.68rem' }}
                      />
                    </ListItem>
                  ))}
                </List>
              )}
            </Box>
          ) : selectedNode ? (
            /* Node detail tabs */
            <>
              <Tabs
                value={sideTab}
                onChange={(_, v) => setSideTab(v)}
                variant="fullWidth"
                sx={{ borderBottom: `1px solid ${theme.palette.divider}`, minHeight: 36, flexShrink: 0 }}
                TabIndicatorProps={{ style: { height: 2 } }}
              >
                <Tab label="Details" sx={{ minHeight: 36, fontSize: '0.75rem', py: 0 }} />
                <Tab label="Dependencies" sx={{ minHeight: 36, fontSize: '0.75rem', py: 0 }} />
              </Tabs>

              {sideTab === 0 && (
                <Box sx={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
                  <NodeDetailPanel selectedNode={selectedNode} onEdit={() => setEditOpen(true)} />
                  <Divider />
                  <Box sx={{ px: 1.5, py: 1 }}>
                    <Button
                      fullWidth variant="contained" size="small"
                      startIcon={runMut.isPending ? <CircularProgress size={12} color="inherit" /> : <PlayArrow sx={{ fontSize: 14 }} />}
                      disabled={runMut.isPending || selectedNode.status !== 'active'}
                      onClick={() => runMut.mutate(selectedNode.id)}
                      sx={{ bgcolor: '#10b981', '&:hover': { bgcolor: '#059669' }, textTransform: 'none', fontWeight: 600 }}
                    >
                      {runMut.isPending ? 'Triggering…' : 'Trigger Run'}
                    </Button>
                  </Box>
                </Box>
              )}
              {sideTab === 1 && (
                <DependencyPanel
                  selected={selectedNode}
                  allNodes={graph?.nodes ?? []}
                  onAdded={() => refetch()}
                  onRemoved={() => refetch()}
                />
              )}
            </>
          ) : (
            /* All pipelines list */
            <CardContent sx={{ p: 0, flex: 1, overflow: 'auto', '&:last-child': { pb: 0 } }}>
              <Box sx={{ px: 1.5, py: 1, bgcolor: alpha(theme.palette.primary.main, 0.08), borderBottom: `1px solid ${theme.palette.divider}` }}>
                <Typography variant="subtitle2" fontWeight={700}>All Pipelines</Typography>
                <Typography variant="caption" color="text.secondary">{graph?.nodes.length ?? 0} total</Typography>
              </Box>
              {graph && graph.nodes.length > 0 ? (
                <List dense disablePadding sx={{ px: 0.5, py: 0.5 }}>
                  {graph.nodes.map((n) => (
                    <ListItem
                      key={n.id}
                      disableGutters
                      sx={{ py: 0.25, cursor: 'pointer', borderRadius: 1, px: 0.5, '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.06) } }}
                      onClick={() => { selectNode(n.id); setSideTab(0); jumpToNode(n.id) }}
                    >
                      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: STATUS_COLOUR[n.status] ?? '#6b7280', mr: 1, flexShrink: 0 }} />
                      <ListItemText
                        primary={n.name}
                        primaryTypographyProps={{ variant: 'body2', fontSize: '0.78rem', noWrap: true }}
                        secondary={SOURCE_LABEL[n.source_type] ?? n.source_type}
                        secondaryTypographyProps={{ fontSize: '0.68rem' }}
                      />
                    </ListItem>
                  ))}
                </List>
              ) : (
                <Box sx={{ px: 1.5, py: 2 }}>
                  <Typography variant="caption" color="text.secondary">
                    Click a node to inspect it, or create pipelines on the ETL page.
                  </Typography>
                </Box>
              )}
            </CardContent>
          )}
        </Card>
      </Box>

      {/* ── Right-click context menu ── */}
      {contextMenu && (
        <MuiMenu
          open
          onClose={() => setContextMenu(null)}
          anchorReference="anchorPosition"
          anchorPosition={{ top: contextMenu.y, left: contextMenu.x }}
          sx={{ '& .MuiMenu-paper': { bgcolor: '#111827', border: '1px solid #1e293b', boxShadow: '0 8px 24px rgba(0,0,0,0.6)', minWidth: 190 } }}
        >
          {(() => {
            const cNode = graph?.nodes.find((n) => String(n.id) === contextMenu.nodeId)
            if (!cNode) return null
            return [
              <Box key="hdr" sx={{ px: 2, py: 0.75, borderBottom: '1px solid #1e293b' }}>
                <Typography sx={{ fontSize: '0.7rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {cNode.name}
                </Typography>
              </Box>,
              <MenuItem key="edit" onClick={() => { nodeActions.onEdit(cNode.id); setContextMenu(null) }} sx={{ fontSize: '0.82rem', gap: 1.5, py: 0.75 }}>
                <EditIcon sx={{ fontSize: 15, color: '#64748b' }} /> Edit pipeline
              </MenuItem>,
              <MenuItem key="run" onClick={() => { nodeActions.onTrigger(cNode.id); setContextMenu(null) }} sx={{ fontSize: '0.82rem', gap: 1.5, py: 0.75 }}>
                <PlayArrow sx={{ fontSize: 15, color: '#10b981' }} /> Trigger run
              </MenuItem>,
              <MenuItem key="deps" onClick={() => { nodeActions.onViewDeps(cNode.id); setContextMenu(null) }} sx={{ fontSize: '0.82rem', gap: 1.5, py: 0.75 }}>
                <AccountTree sx={{ fontSize: 15, color: '#64748b' }} /> Dependencies
              </MenuItem>,
              <Divider key="div" sx={{ borderColor: '#1e293b' }} />,
              <MenuItem key="open" onClick={() => { nodeActions.onOpenPipelines(cNode.id); setContextMenu(null) }} sx={{ fontSize: '0.82rem', gap: 1.5, py: 0.75 }}>
                <OpenInNewIcon sx={{ fontSize: 15, color: '#64748b' }} /> Open in Studio
              </MenuItem>,
            ]
          })()}
        </MuiMenu>
      )}

      {/* ── Edit dialog ── */}
      <EditPipelineDialog
        pipelineId={selectedId}
        open={editOpen}
        onClose={() => setEditOpen(false)}
      />

      {/* ── Load to Spark dialog ── */}
      <LoadToSparkDialog
        pipeline={loadSparkPipeline}
        open={loadSparkPipeline !== null}
        onClose={() => setLoadSparkPipeline(null)}
      />
    </Box>
  )
}
