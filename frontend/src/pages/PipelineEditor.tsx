import { useCallback, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import ReactFlow, {
  Background, Controls, MiniMap,
  addEdge, useNodesState, useEdgesState,
  Connection, Edge, Node, NodeTypes,
  Handle, Position,
} from 'reactflow'
import 'reactflow/dist/style.css'
import {
  Box, Typography, Button, IconButton, Tooltip,
  Paper, TextField, List, ListItem, ListItemText,
  Divider, Chip, CircularProgress, alpha, useTheme,
} from '@mui/material'
import {
  ArrowBack, PlayArrow, Save, Tune,
  Input as InputIcon, Output as OutputIcon,
  Transform as TransformIcon, FilterList,
  MergeType, Sort, Search, Code, JoinFull,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { pipelinesApi, Pipeline } from '../api/client'

// ── Transform library items ───────────────────────────────────────────────────

const TRANSFORM_TYPES = [
  { type: 'extract_grpc', label: 'Extract (gRPC)', icon: <InputIcon />, color: '#58a6ff', category: 'extract' },
  { type: 'extract_jdbc', label: 'Extract (JDBC)', icon: <InputIcon />, color: '#58a6ff', category: 'extract' },
  { type: 'extract_sql', label: 'Extract (SQL)', icon: <Code />, color: '#58a6ff', category: 'extract' },
  { type: 'filter', label: 'Filter Rows', icon: <FilterList />, color: '#d29922', category: 'transform' },
  { type: 'join', label: 'Join', icon: <JoinFull />, color: '#d29922', category: 'transform' },
  { type: 'sort', label: 'Sort', icon: <Sort />, color: '#d29922', category: 'transform' },
  { type: 'lookup', label: 'Lookup (Dictionary)', icon: <Search />, color: '#d29922', category: 'transform' },
  { type: 'sql_transform', label: 'SQL Transform', icon: <Code />, color: '#d29922', category: 'transform' },
  { type: 'load_parquet', label: 'Load (Parquet)', icon: <OutputIcon />, color: '#3fb950', category: 'load' },
  { type: 'load_spark', label: 'Load (Spark Table)', icon: <OutputIcon />, color: '#3fb950', category: 'load' },
  { type: 'load_csv', label: 'Load (CSV)', icon: <OutputIcon />, color: '#3fb950', category: 'load' },
]

interface TransformNodeData {
  label: string
  transformType: string
  color: string
  icon: string
}

// ── Custom Node ───────────────────────────────────────────────────────────────

function TransformNode({ data, selected }: { data: TransformNodeData; selected: boolean }) {
  const theme = useTheme()
  return (
    <Box
      sx={{
        minWidth: 140, borderRadius: 1.5, border: `2px solid`,
        borderColor: selected ? data.color : alpha(data.color, 0.4),
        bgcolor: alpha(data.color, 0.08),
        p: 1, textAlign: 'center', cursor: 'pointer',
        boxShadow: selected ? `0 0 12px ${alpha(data.color, 0.4)}` : 'none',
        transition: 'all 0.15s',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: data.color }} />
      <Typography variant="caption" fontWeight={600} sx={{ color: data.color, display: 'block' }}>
        {data.label}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.6rem' }}>
        {data.transformType}
      </Typography>
      <Handle type="source" position={Position.Right} style={{ background: data.color }} />
    </Box>
  )
}

const nodeTypes: NodeTypes = { transform: TransformNode }

// ── Node properties panel ─────────────────────────────────────────────────────

function NodeProperties({
  node,
  onChange,
}: {
  node: Node<TransformNodeData>
  onChange: (id: string, data: Partial<TransformNodeData>) => void
}) {
  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="subtitle2" fontWeight={700}>Node Properties</Typography>
      <TextField
        label="Label"
        value={node.data.label}
        onChange={e => onChange(node.id, { label: e.target.value })}
        size="small"
        fullWidth
      />
      <Chip
        label={node.data.transformType}
        size="small"
        sx={{ alignSelf: 'flex-start', bgcolor: alpha(node.data.color, 0.12), color: node.data.color }}
      />
    </Box>
  )
}

// ── Pipeline Editor page ──────────────────────────────────────────────────────

let nodeIdCounter = 100

export default function PipelineEditor() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const theme = useTheme()
  const qc = useQueryClient()

  const [nodes, setNodes, onNodesChange] = useNodesState<TransformNodeData>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selectedNode, setSelectedNode] = useState<Node<TransformNodeData> | null>(null)
  const [pipelineName, setPipelineName] = useState('')

  const { data: pipeline, isLoading } = useQuery<Pipeline>({
    queryKey: ['pipeline', id],
    queryFn: () => pipelinesApi.list().then(list => {
      const found = list.find(p => p.id === Number(id))
      if (found) setPipelineName(found.name)
      return found!
    }),
    enabled: !!id,
  })

  const runMut = useMutation({
    mutationFn: () => pipelinesApi.run(Number(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pipelines'] }),
  })

  const saveMut = useMutation({
    mutationFn: () =>
      pipelinesApi.update(Number(id), {
        name: pipelineName,
        description: `visual_config:${JSON.stringify({ nodes: nodes.map(n => ({ id: n.id, type: n.data.transformType, position: n.position })), edges })}`,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pipelines'] }),
  })

  const onConnect = useCallback((connection: Connection) => {
    setEdges(eds => addEdge({ ...connection, animated: true }, eds))
  }, [setEdges])

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    const typeStr = event.dataTransfer.getData('application/transform-type')
    const item = TRANSFORM_TYPES.find(t => t.type === typeStr)
    if (!item) return

    const bounds = (event.target as Element).closest('.react-flow')?.getBoundingClientRect()
    if (!bounds) return

    const position = {
      x: event.clientX - bounds.left - 70,
      y: event.clientY - bounds.top - 25,
    }

    const newNode: Node<TransformNodeData> = {
      id: `node_${nodeIdCounter++}`,
      type: 'transform',
      position,
      data: { label: item.label, transformType: item.type, color: item.color, icon: item.category },
    }
    setNodes(nds => [...nds, newNode])
  }, [setNodes])

  function onNodeClick(_: React.MouseEvent, node: Node<TransformNodeData>) {
    setSelectedNode(node)
  }

  function updateNodeData(nodeId: string, data: Partial<TransformNodeData>) {
    setNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n))
    setSelectedNode(prev => prev?.id === nodeId ? { ...prev, data: { ...prev.data, ...data } } : prev)
  }

  if (isLoading) return <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Top toolbar */}
      <Box
        sx={{
          display: 'flex', alignItems: 'center', gap: 1.5,
          px: 2, py: 1,
          bgcolor: 'background.paper',
          borderBottom: `1px solid ${theme.palette.divider}`,
          flexShrink: 0,
        }}
      >
        <Tooltip title="Back">
          <IconButton size="small" onClick={() => navigate('/pipelines')}>
            <ArrowBack fontSize="small" />
          </IconButton>
        </Tooltip>
        <TextField
          value={pipelineName}
          onChange={e => setPipelineName(e.target.value)}
          size="small"
          variant="standard"
          sx={{ '& input': { fontWeight: 600, fontSize: '1rem' } }}
          placeholder="Pipeline name…"
        />
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          startIcon={<PlayArrow />}
          color="success"
          variant="outlined"
          onClick={() => runMut.mutate()}
          disabled={runMut.isPending}
        >
          Run
        </Button>
        <Button
          size="small"
          startIcon={<Save />}
          variant="contained"
          onClick={() => saveMut.mutate()}
          disabled={saveMut.isPending}
        >
          Save
        </Button>
      </Box>

      <Box sx={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left panel: Transform library */}
        <Box
          sx={{
            width: 200, flexShrink: 0,
            bgcolor: 'background.paper',
            borderRight: `1px solid ${theme.palette.divider}`,
            overflowY: 'auto',
            p: 1,
          }}
        >
          <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ px: 1, display: 'block', mb: 0.5, textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: '0.65rem' }}>
            Transform Library
          </Typography>
          {['extract', 'transform', 'load'].map(cat => (
            <Box key={cat} sx={{ mb: 1.5 }}>
              <Typography variant="caption" color="text.secondary" sx={{ px: 1, display: 'block', mb: 0.5, fontWeight: 600, fontSize: '0.7rem', textTransform: 'capitalize' }}>
                {cat}
              </Typography>
              {TRANSFORM_TYPES.filter(t => t.category === cat).map(t => (
                <Box
                  key={t.type}
                  draggable
                  onDragStart={e => e.dataTransfer.setData('application/transform-type', t.type)}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: 1,
                    px: 1.5, py: 0.75, borderRadius: 1, cursor: 'grab',
                    border: `1px solid ${alpha(t.color, 0.2)}`,
                    bgcolor: alpha(t.color, 0.05),
                    mb: 0.5,
                    '&:hover': { bgcolor: alpha(t.color, 0.12) },
                    '&:active': { cursor: 'grabbing' },
                  }}
                >
                  <Box sx={{ color: t.color, display: 'flex', fontSize: 14 }}>{t.icon}</Box>
                  <Typography variant="caption" fontWeight={500} sx={{ color: t.color, fontSize: '0.72rem' }}>
                    {t.label}
                  </Typography>
                </Box>
              ))}
            </Box>
          ))}
        </Box>

        {/* Canvas */}
        <Box sx={{ flex: 1, position: 'relative' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            fitView
            style={{ background: theme.palette.background.default }}
          >
            <Background color={theme.palette.divider} gap={20} />
            <Controls />
            <MiniMap
              nodeColor={node => (node.data as TransformNodeData)?.color ?? '#484f58'}
              style={{ background: theme.palette.background.paper }}
            />
          </ReactFlow>

          {nodes.length === 0 && (
            <Box
              sx={{
                position: 'absolute', inset: 0,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none', gap: 1,
              }}
            >
              <Tune sx={{ fontSize: 48, color: 'text.secondary', opacity: 0.3 }} />
              <Typography color="text.secondary" sx={{ opacity: 0.5 }}>
                Drag transforms from the left panel to build your pipeline
              </Typography>
            </Box>
          )}
        </Box>

        {/* Right panel: Node properties */}
        <Box
          sx={{
            width: 220, flexShrink: 0,
            bgcolor: 'background.paper',
            borderLeft: `1px solid ${theme.palette.divider}`,
            overflowY: 'auto',
          }}
        >
          {selectedNode ? (
            <NodeProperties node={selectedNode} onChange={updateNodeData} />
          ) : (
            <Box sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary">
                Select a node to view its properties
              </Typography>
            </Box>
          )}

          {pipeline?.last_run && (
            <>
              <Divider />
              <Box sx={{ p: 2 }}>
                <Typography variant="caption" fontWeight={700} color="text.secondary" display="block" mb={1} textTransform="uppercase" letterSpacing="0.08em" fontSize="0.65rem">
                  Last Run
                </Typography>
                <Chip label={pipeline.last_run.status} size="small" sx={{ mb: 1 }} />
                {pipeline.last_run.records_extracted != null && (
                  <Typography variant="caption" display="block" color="text.secondary">
                    Extracted: {pipeline.last_run.records_extracted.toLocaleString()}
                  </Typography>
                )}
                {pipeline.last_run.records_loaded != null && (
                  <Typography variant="caption" display="block" color="text.secondary">
                    Loaded: {pipeline.last_run.records_loaded.toLocaleString()}
                  </Typography>
                )}
              </Box>
            </>
          )}
        </Box>
      </Box>
    </Box>
  )
}
