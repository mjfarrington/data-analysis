import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ReactFlow, Background, MiniMap,
  addEdge, useNodesState, useEdgesState,
  useReactFlow, useViewport,
  type Node, type Edge, type Connection,
  MarkerType, Panel, BackgroundVariant,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Box, Typography, Card, CardContent, Chip, Alert, CircularProgress,
  List, ListItem, ListItemText, ListItemSecondaryAction, IconButton,
  Divider, Button, Select, MenuItem, FormControl, InputLabel,
  useTheme, alpha, Tooltip, LinearProgress,
  Dialog, DialogTitle, DialogContent, DialogActions,
  Tab, Tabs, TextField,
} from '@mui/material'
import {
  Delete, Add, Refresh, AccountTree, Storage, Info,
  CheckCircle, Error as ErrorIcon, PendingOutlined, Cancel,
  ZoomIn as ZoomInIcon, ZoomOut as ZoomOutIcon,
  FitScreen as FitScreenIcon, RestartAlt as ResetIcon,
  Edit as EditIcon, OpenInNew as OpenInNewIcon,
  PlayArrow, Schedule,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { graphApi, pipelinesApi, GraphNode as ApiNode, GraphEdge as ApiEdge } from '../api/client'

// ─── Constants ────────────────────────────────────────────────────────────────
const NODE_W = 220
const NODE_H = 80

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
  json: 'JSON',
  csv: 'CSV',
}

// ─── Custom node component ────────────────────────────────────────────────────
function PipelineNode({ data }: { data: ApiNode & { selected: boolean } }) {
  const borderColor = data.selected ? '#3b82f6' : (STATUS_COLOUR[data.status] ?? '#2a3550')
  const runColor = data.last_run_status ? (RUN_STATUS_COLOUR[data.last_run_status] ?? '#6b7280') : '#2a3550'

  return (
    <Box
      sx={{
        width: NODE_W,
        height: NODE_H,
        borderRadius: '8px',
        border: `2px solid ${borderColor}`,
        bgcolor: '#1a2236',
        boxShadow: data.selected ? `0 0 0 3px ${alpha('#3b82f6', 0.3)}` : '0 2px 8px rgba(0,0,0,0.4)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        px: 1.5,
        py: 1,
        cursor: 'pointer',
        transition: 'box-shadow 0.15s, border-color 0.15s',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* run status bar at top */}
      {data.last_run_status && (
        <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, bgcolor: runColor }} />
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
        <Storage sx={{ fontSize: 14, color: '#3b82f6', flexShrink: 0 }} />
        <Typography
          sx={{ fontSize: '0.78rem', fontWeight: 700, color: '#e2e8f0', lineHeight: 1.2, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {data.name}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Chip
          label={SOURCE_LABEL[data.source_type] ?? data.source_type.toUpperCase()}
          size="small"
          sx={{ height: 16, fontSize: '0.62rem', bgcolor: '#2a3550', color: '#94a3b8' }}
        />
        {data.last_run_status && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, color: runColor }}>
            {RUN_STATUS_ICON[data.last_run_status]}
            <Typography sx={{ fontSize: '0.62rem', color: runColor }}>{data.last_run_status}</Typography>
          </Box>
        )}
        <Box sx={{ flex: 1 }} />
        <Chip
          label={data.status}
          size="small"
          sx={{ height: 16, fontSize: '0.62rem', bgcolor: alpha(STATUS_COLOUR[data.status] ?? '#2a3550', 0.15), color: STATUS_COLOUR[data.status] ?? '#94a3b8' }}
        />
      </Box>
    </Box>
  )
}

const nodeTypes = { pipeline: PipelineNode }

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

// ─── Zoom toolbar (must render inside ReactFlow for context) ──────────────────
function ZoomPanel({ onResetLayout }: { onResetLayout: () => void }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  const { zoom } = useViewport()

  return (
    <Panel position="bottom-center">
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 0.25,
        bgcolor: '#1a2236', border: '1px solid #2a3550',
        borderRadius: 2, px: 0.75, py: 0.5,
        boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
      }}>
        <Tooltip title="Zoom out (−)">
          <IconButton size="small" onClick={() => zoomOut({ duration: 200 })} sx={{ color: '#e2e8f0', p: 0.5 }}>
            <ZoomOutIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Typography sx={{ fontSize: '0.72rem', color: '#94a3b8', fontFamily: 'monospace', minWidth: 38, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </Typography>
        <Tooltip title="Zoom in (+)">
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
        <Tooltip title="Reset layout (clear saved positions)">
          <IconButton size="small" onClick={onResetLayout} sx={{ color: '#64748b', p: 0.5, '&:hover': { color: '#ef4444' } }}>
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
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<'active' | 'inactive' | 'draft'>('active')
  useEffect(() => {
    if (pipeline) {
      setName(pipeline.name)
      setDescription(pipeline.description ?? '')
      setStatus(pipeline.status)
    }
  }, [pipeline])
  const mut = useMutation({
    mutationFn: () => pipelinesApi.update(pipelineId!, { name, description, status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipeline-graph'] })
      qc.invalidateQueries({ queryKey: ['pipeline', pipelineId] })
      onClose()
    },
  })
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>Edit Pipeline</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
        <TextField
          label="Name" value={name} onChange={(e) => setName(e.target.value)}
          size="small" fullWidth autoFocus
        />
        <TextField
          label="Description" value={description} onChange={(e) => setDescription(e.target.value)}
          size="small" fullWidth multiline rows={3}
        />
        <FormControl size="small" fullWidth>
          <InputLabel>Status</InputLabel>
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <MenuItem value="active">Active</MenuItem>
            <MenuItem value="inactive">Inactive</MenuItem>
            <MenuItem value="draft">Draft</MenuItem>
          </Select>
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} size="small">Cancel</Button>
        <Button
          variant="contained" size="small"
          disabled={!name.trim() || mut.isPending}
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
                {pipeline.last_run.status === 'success'
                  ? <CheckCircle sx={{ fontSize: '0.8rem', color: STATUS_COLOUR.active }} />
                  : pipeline.last_run.status === 'running'
                    ? <PendingOutlined sx={{ fontSize: '0.8rem', color: STATUS_COLOUR.inactive }} />
                    : <ErrorIcon sx={{ fontSize: '0.8rem', color: '#ef4444' }} />}
                <Typography variant="caption" fontWeight={600}>
                  {pipeline.last_run.started_at
                    ? formatDistanceToNow(new Date(pipeline.last_run.started_at), { addSuffix: true })
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
              {formatDistanceToNow(new Date(pipeline.updated_at), { addSuffix: true })}
            </Typography>
          </Box>
        </Box>
      ) : (
        <CircularProgress size={16} sx={{ alignSelf: 'center' }} />
      )}
    </Box>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function PipelineGraph() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [sideTab, setSideTab] = useState(0)   // 0 = Details, 1 = Dependencies
  const [editOpen, setEditOpen] = useState(false)

  const { data: graph, isLoading, refetch } = useQuery({
    queryKey: ['pipeline-graph'],
    queryFn: () => graphApi.graph().then((r) => r.data),
    refetchInterval: 30_000,
  })

  const { nodes: initNodes, edges: initEdges } = useMemo(
    () => (graph ? computeLayout(graph.nodes, graph.edges) : { nodes: [], edges: [] }),
    [graph]
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(initNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initEdges)

  // Sync when graph data changes — preserve dragged positions, apply saved for new nodes
  useEffect(() => {
    const saved = loadSavedPositions()
    const { nodes: n, edges: e } = computeLayout(graph?.nodes ?? [], graph?.edges ?? [])
    setNodes((prev) => n.map((newN) => {
      const existing = prev.find((p) => p.id === newN.id)
      if (existing) return { ...newN, position: existing.position, data: { ...newN.data, selected: existing.data.selected } }
      const savedPos = saved[newN.id]
      return savedPos ? { ...newN, position: savedPos } : newN
    }))
    setEdges(e)
  }, [graph])

  // Save positions when the user finishes dragging a node
  const onNodeDragStop = useCallback((_: React.MouseEvent, __: Node, allNodes: Node[]) => {
    savePositions(allNodes)
  }, [])

  // Reset to auto-layout and clear saved positions
  const resetLayout = useCallback(() => {
    localStorage.removeItem(LAYOUT_KEY)
    if (graph) {
      const { nodes: n, edges: e } = computeLayout(graph.nodes, graph.edges)
      setNodes(n)
      setEdges(e)
    }
  }, [graph, setNodes, setEdges])

  // Highlight selected node
  useEffect(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, selected: Number(n.id) === selectedId } })))
  }, [selectedId])

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  )

  const selectedNode = graph?.nodes.find((n) => n.id === selectedId) ?? null

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, flexShrink: 0 }}>
        <AccountTree sx={{ mr: 1, color: 'primary.main' }} />
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>Pipeline Graph</Typography>
          <Typography variant="caption" color="text.secondary">
            Visualise and manage pipeline dependencies · drag to rearrange · click to inspect
          </Typography>
        </Box>
        <Tooltip title="Refresh">
          <IconButton onClick={() => { refetch(); qc.invalidateQueries({ queryKey: ['pipeline-graph'] }) }}>
            <Refresh />
          </IconButton>
        </Tooltip>
        <Tooltip title="Reset layout (restore auto-layout and clear saved positions)">
          <IconButton onClick={resetLayout} size="small" sx={{ color: 'text.secondary' }}>
            <ResetIcon />
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
        <Box sx={{ flex: 1, borderRadius: 2, overflow: 'hidden', border: `1px solid ${theme.palette.divider}`, bgcolor: '#0a0e1a', minHeight: 500 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId(Number(node.id))}
            onPaneClick={() => setSelectedId(null)}
            onNodeDragStop={onNodeDragStop}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            defaultEdgeOptions={{
              markerEnd: { type: MarkerType.ArrowClosed, color: '#3b82f6' },
              style: { stroke: '#3b82f6', strokeWidth: 2 },
              animated: true,
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e293b" />
            <MiniMap
              nodeStrokeColor={(n) => STATUS_COLOUR[(n.data as unknown as ApiNode).status] ?? '#2a3550'}
              nodeColor={() => '#1a2236'}
              maskColor={alpha('#0a0e1a', 0.6)}
              style={{ background: '#111827', border: '1px solid #2a3550' }}
            />
            <ZoomPanel onResetLayout={resetLayout} />
            <Panel position="top-left">
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {Object.entries(STATUS_COLOUR).map(([s, c]) => (
                  <Box key={s} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, bgcolor: alpha(c, 0.15), px: 1, py: 0.25, borderRadius: 1 }}>
                    <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: c }} />
                    <Typography sx={{ fontSize: '0.68rem', color: c }}>{s}</Typography>
                  </Box>
                ))}
              </Box>
            </Panel>
          </ReactFlow>
        </Box>

        {/* ── Side panel ── */}
        <Card variant="outlined" sx={{ width: 280, flexShrink: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          {selectedNode ? (
            <>
              {/* Tabs header */}
              <Tabs
                value={sideTab}
                onChange={(_, v) => setSideTab(v)}
                variant="fullWidth"
                sx={{ borderBottom: `1px solid ${theme.palette.divider}`, minHeight: 36 }}
                TabIndicatorProps={{ style: { height: 2 } }}
              >
                <Tab label="Details" sx={{ minHeight: 36, fontSize: '0.75rem', py: 0 }} />
                <Tab label="Dependencies" sx={{ minHeight: 36, fontSize: '0.75rem', py: 0 }} />
              </Tabs>

              {sideTab === 0 && (
                <NodeDetailPanel
                  selectedNode={selectedNode}
                  onEdit={() => setEditOpen(true)}
                />
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
            <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
              <Box sx={{ px: 1.5, py: 1, bgcolor: alpha(theme.palette.primary.main, 0.08), borderBottom: `1px solid ${theme.palette.divider}` }}>
                <Typography variant="subtitle2" fontWeight={700}>All Pipelines</Typography>
              </Box>
              {graph && graph.nodes.length > 0 ? (
                <List dense disablePadding sx={{ px: 0.5, py: 0.5 }}>
                  {graph.nodes.map((n) => (
                    <ListItem
                      key={n.id}
                      disableGutters
                      sx={{ py: 0.25, cursor: 'pointer', borderRadius: 1, px: 0.5 }}
                      onClick={() => { setSelectedId(n.id); setSideTab(0) }}
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

        {/* Edit dialog */}
        <EditPipelineDialog
          pipelineId={selectedId}
          open={editOpen}
          onClose={() => setEditOpen(false)}
        />
      </Box>
    </Box>
  )
}
