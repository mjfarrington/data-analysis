import { useState, useMemo } from 'react'
import ReactFlow, {
  Background, Handle, Position, Node, Edge, BackgroundVariant,
} from 'reactflow'
import 'reactflow/dist/style.css'
import {
  Box, Typography, alpha, useTheme, Button, CircularProgress, Tooltip,
} from '@mui/material'
import { PlayArrow, Replay } from '@mui/icons-material'
import { RunDetail, RunStep, Pipeline } from '../api/client'

// ── Constants ──────────────────────────────────────────────────────────────────

const NODE_COLOR: Record<string, string> = {
  jdbc_extract: '#58a6ff', impala_extract: '#58a6ff', s3_extract: '#3fb950',
  iterator: '#58a6ff', csv_extract: '#58a6ff',
  filter: '#e3b341', sort: '#e3b341', aggregate: '#e3b341',
  sql_transform: '#c0c7d1', lookup: '#e3b341', join: '#e3b341',
  notebook_transform: '#8b5cf6', foreach: '#e3b341',
  load_parquet: '#f4d35e', load_sql: '#f4d35e',
}

const STATUS_COLOR: Record<string, string> = {
  completed: '#3fb950',
  failed: '#f85149',
  running: '#58a6ff',
  pending: '#58a6ff',
  cancelled: '#6e7681',
  skipped: '#6e7681',
  completed_with_warnings: '#d29922',
}

/** Map canvas nodeType → run step_type */
function toStepType(nodeType: string): string {
  if (['jdbc_extract', 'impala_extract', 's3_extract', 'iterator', 'csv_extract'].includes(nodeType))
    return 'extract'
  if (['load_parquet', 'load_sql'].includes(nodeType))
    return 'load'
  return nodeType
}

function formatDur(s: number): string {
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`
}

function extractNodeIdFromStepLabel(label?: string): string | null {
  if (!label) return null
  const match = label.match(/\[([^\]]+)\]\s*$/)
  return match?.[1]?.trim() || null
}

// ── Custom node ────────────────────────────────────────────────────────────────

interface RunNodeData {
  nodeType: string
  label: string
  step?: RunStep
  stepRef?: string
}

function RunStatusNode({ data, selected }: { data: RunNodeData; selected?: boolean }) {
  const theme = useTheme()
  const { nodeType, label, step, stepRef } = data
  const color = NODE_COLOR[nodeType] ?? '#6e7681'
  const status = step?.status ?? 'pending'
  const statusColor = STATUS_COLOR[status] ?? '#6e7681'
  const isFailed = status === 'failed'
  const isRunning = status === 'running'
  const isPending = status === 'pending'

  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        style={{ width: 7, height: 7, background: '#4a5568', border: `1.5px solid ${theme.palette.background.paper}` }}
      />
      <Box
        sx={{
          minWidth: 148, maxWidth: 190,
          bgcolor: theme.palette.background.paper,
          border: `2px solid ${selected ? '#58a6ff' : isFailed ? statusColor : alpha(statusColor, 0.45)}`,
          borderRadius: 1.5,
          boxShadow: isFailed
            ? `0 0 0 1px ${alpha(statusColor, 0.25)}, 0 2px 10px rgba(0,0,0,0.45)`
            : '0 2px 8px rgba(0,0,0,0.3)',
          p: '7px 9px',
          transition: 'border-color 0.15s',
          userSelect: 'none',
        }}
      >
        {/* Type badge + status dot */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
          <Box sx={{
            fontSize: '0.55rem', fontWeight: 700, px: 0.55, py: 0.1, flexShrink: 0,
            borderRadius: 0.5, bgcolor: alpha(color, 0.15), color,
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>
            {nodeType.replace(/_/g, ' ')}
          </Box>
          <Box sx={{ flex: 1 }} />
          {(isRunning || isPending)
            ? <CircularProgress size={9} thickness={5} sx={{ color: statusColor, flexShrink: 0 }} />
            : <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: statusColor, flexShrink: 0 }} />
          }
        </Box>

        {/* Label */}
        <Typography sx={{ fontSize: '0.74rem', fontWeight: 600, lineHeight: 1.2, mb: 0.25 }}>
          {label}
        </Typography>
        {step && (
          <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.6rem', display: 'block', mb: 0.25 }}>
            step #{step.id} • {step.status}
          </Typography>
        )}

        {/* Stats */}
        {step && (step.duration_seconds != null || step.records_out != null) && (
          <Box sx={{ display: 'flex', gap: 1 }}>
            {step.duration_seconds != null && (
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.62rem' }}>
                {formatDur(step.duration_seconds)}
              </Typography>
            )}
            {step.records_out != null && (
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.62rem' }}>
                {step.records_out.toLocaleString()} rows
              </Typography>
            )}
          </Box>
        )}

        {/* Error preview */}
        {isFailed && step?.error_message && (
          <Tooltip title={step.error_message} placement="bottom">
            <Typography sx={{
              fontSize: '0.6rem', color: 'error.main', mt: 0.3,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              maxWidth: 172, cursor: 'help',
            }}>
              {step.error_message}
            </Typography>
          </Tooltip>
        )}
      </Box>
      <Handle
        type="source"
        position={Position.Right}
        style={{ width: 7, height: 7, background: '#4a5568', border: `1.5px solid ${theme.palette.background.paper}` }}
      />
    </>
  )
}

const nodeTypes = { runStatus: RunStatusNode }

// ── Main component ────────────────────────────────────────────────────────────

interface RunGraphViewProps {
  run: RunDetail
  pipeline: Pipeline
  onRerun: () => void
  onRetrySparkLoad: () => void
  retryPending?: boolean
}

export default function RunGraphView({
  run, pipeline, onRerun, onRetrySparkLoad, retryPending,
}: RunGraphViewProps) {
  const theme = useTheme()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusCleared, setStatusCleared] = useState(false)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canvasConfig = pipeline.canvas_config as any

  // Group top-level run steps by type, ordered by step_order
  const stepsByType = useMemo(() => {
    const top = (run.steps ?? [])
      .filter(s => !['app', 'chunk'].includes(s.step_type))
      .sort((a, b) => a.step_order - b.step_order)
    const map: Record<string, RunStep[]> = {}
    for (const s of top) {
      if (!map[s.step_type]) map[s.step_type] = []
      map[s.step_type].push(s)
    }
    return map
  }, [run.steps])

  // Topological sort of canvas nodes so order matches engine execution order
  const sortedCanvasNodes = useMemo(() => {
    const cnodes: any[] = canvasConfig?.nodes ?? []
    const cedges: any[] = canvasConfig?.edges ?? []
    const inDeg: Record<string, number> = {}
    const adj: Record<string, string[]> = {}
    for (const n of cnodes) { inDeg[n.id] = 0; adj[n.id] = [] }
    for (const e of cedges) {
      adj[e.source] = adj[e.source] ?? []
      adj[e.source].push(e.target)
      inDeg[e.target] = (inDeg[e.target] ?? 0) + 1
    }
    const queue = cnodes.filter(n => (inDeg[n.id] ?? 0) === 0).map(n => n.id)
    const result: string[] = []
    let head = 0
    while (head < queue.length) {
      const cur = queue[head++]
      result.push(cur)
      for (const next of adj[cur] ?? []) {
        inDeg[next]--
        if (inDeg[next] === 0) queue.push(next)
      }
    }
    for (const n of cnodes) { if (!result.includes(n.id)) result.push(n.id) }
    return result.map(id => cnodes.find((n: any) => n.id === id)).filter(Boolean)
  }, [canvasConfig])

  // Match each canvas node to its run step (by type, in execution order)
  const nodeStepMap = useMemo(() => {
    const byStepId = new Map<number, RunStep>()
    for (const s of (run.steps ?? [])) byStepId.set(s.id, s)

    const nodeStepMapRaw = ((run.run_metadata as Record<string, unknown> | undefined)?.node_step_map ?? {}) as Record<string, number>
    const fromMetadata: Record<string, RunStep> = {}
    for (const [nodeId, stepId] of Object.entries(nodeStepMapRaw)) {
      const s = byStepId.get(Number(stepId))
      if (s) fromMetadata[nodeId] = s
    }

    const byNodeId: Record<string, RunStep> = {}
    for (const s of (run.steps ?? [])) {
      const nodeId = extractNodeIdFromStepLabel(s.step_label)
      if (nodeId && !byNodeId[nodeId]) byNodeId[nodeId] = s
    }

    const typeIdx: Record<string, number> = {}
    const map: Record<string, RunStep | undefined> = {}
    for (const cn of sortedCanvasNodes) {
      if (fromMetadata[cn.id]) {
        map[cn.id] = fromMetadata[cn.id]
        continue
      }
      if (byNodeId[cn.id]) {
        map[cn.id] = byNodeId[cn.id]
        continue
      }
      const nodeType = cn.data?.nodeType ?? cn.type
      const stepType = toStepType(nodeType)
      const candidates = stepsByType[stepType] ?? []
      const idx = typeIdx[stepType] ?? 0
      map[cn.id] = candidates[idx]
      typeIdx[stepType] = idx + 1
    }
    return map
  }, [sortedCanvasNodes, stepsByType])

  const flowNodes: Node[] = useMemo(() => {
    const cnodes: any[] = canvasConfig?.nodes ?? []
    return cnodes.map(n => ({
      id: n.id,
      type: 'runStatus',
      position: n.position ?? { x: 0, y: 0 },
      selected: n.id === selectedId,
      data: {
        nodeType: n.data?.nodeType ?? n.type ?? 'unknown',
        label: n.data?.label ?? (n.data?.nodeType ?? n.type ?? '').replace(/_/g, ' '),
        step: statusCleared ? undefined : nodeStepMap[n.id],
        stepRef: (!statusCleared && nodeStepMap[n.id]) ? `step #${nodeStepMap[n.id]!.id}` : undefined,
      } satisfies RunNodeData,
    }))
  }, [canvasConfig, nodeStepMap, selectedId, statusCleared])

  const flowEdges: Edge[] = useMemo(() => {
    const cedges: any[] = canvasConfig?.edges ?? []
    return cedges.map((e, i) => ({
      id: e.id ?? `edge-${i}`,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      type: 'smoothstep',
      style: { stroke: alpha(theme.palette.divider, 0.55), strokeWidth: 1.5 },
      markerEnd: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: 'arrowclosed' as any,
        color: alpha(theme.palette.divider, 0.55),
        width: 14, height: 14,
      },
    }))
  }, [canvasConfig, theme.palette.divider])

  // Selected node info
  const selectedNodeInfo = useMemo(() => {
    if (!selectedId) return null
    const cn = (canvasConfig?.nodes ?? []).find((n: any) => n.id === selectedId)
    if (!cn) return null
    const nodeType = cn.data?.nodeType ?? cn.type ?? ''
    return {
      nodeType,
      label: cn.data?.label ?? nodeType.replace(/_/g, ' '),
      step: statusCleared ? undefined : nodeStepMap[selectedId],
    }
  }, [selectedId, canvasConfig, nodeStepMap, statusCleared])

  if (!canvasConfig?.nodes?.length) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 160, color: 'text.secondary' }}>
        <Typography variant="body2">No canvas layout for this pipeline.</Typography>
      </Box>
    )
  }

  const isLoadNode = selectedNodeInfo && ['load_parquet', 'load_sql'].includes(selectedNodeInfo.nodeType)
  const showRetrySparkLoad = isLoadNode && run.status === 'completed_with_warnings'
  const showRerun = selectedNodeInfo?.step?.status === 'failed'

  return (
    <Box>
      {/* Graph canvas */}
      <Box sx={{
        height: 320,
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: selectedNodeInfo ? '6px 6px 0 0' : 1,
        overflow: 'hidden',
        bgcolor: alpha(theme.palette.background.default, 0.7),
        position: 'relative',
      }}>
        <Box sx={{ position: 'absolute', right: 8, top: 8, zIndex: 5 }}>
          <Button
            size="small"
            variant="outlined"
            onClick={() => setStatusCleared(v => !v)}
            sx={{ fontSize: '0.68rem', py: 0.2, minWidth: 96, bgcolor: alpha(theme.palette.background.paper, 0.9) }}
          >
            {statusCleared ? 'Show Status' : 'Clear Status'}
          </Button>
        </Box>
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          zoomOnDoubleClick={false}
          panOnScroll
          onNodeClick={(_, node) => setSelectedId(id => id === node.id ? null : node.id)}
          onPaneClick={() => setSelectedId(null)}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22} size={1}
            color={alpha(theme.palette.divider, 0.35)}
          />
        </ReactFlow>
      </Box>

      {/* Selected node action panel */}
      {selectedNodeInfo && (
        <Box sx={{
          border: `1px solid ${theme.palette.divider}`,
          borderTop: 'none',
          borderRadius: '0 0 6px 6px',
          p: 1.25,
          bgcolor: alpha(theme.palette.background.paper, 0.9),
          display: 'flex', alignItems: 'flex-start', gap: 1.5,
        }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.25 }}>
              <Box sx={{
                fontSize: '0.6rem', fontWeight: 700, px: 0.55, py: 0.1,
                borderRadius: 0.5,
                bgcolor: alpha(NODE_COLOR[selectedNodeInfo.nodeType] ?? '#6e7681', 0.15),
                color: NODE_COLOR[selectedNodeInfo.nodeType] ?? '#6e7681',
                textTransform: 'uppercase', flexShrink: 0,
              }}>
                {selectedNodeInfo.nodeType.replace(/_/g, ' ')}
              </Box>
              <Typography variant="body2" noWrap sx={{ fontWeight: 700 }}>{selectedNodeInfo.label}</Typography>
              {selectedNodeInfo.step && (
                <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.66rem' }}>
                  step #{selectedNodeInfo.step.id}
                </Typography>
              )}
              {selectedNodeInfo.step && (
                <Box sx={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  bgcolor: STATUS_COLOR[selectedNodeInfo.step.status] ?? '#6e7681',
                }} />
              )}
              {selectedNodeInfo.step?.duration_seconds != null && (
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.68rem' }}>
                  {formatDur(selectedNodeInfo.step.duration_seconds)}
                </Typography>
              )}
              {selectedNodeInfo.step?.records_out != null && (
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.68rem' }}>
                  {selectedNodeInfo.step.records_out.toLocaleString()} rows
                </Typography>
              )}
            </Box>
            {selectedNodeInfo.step?.error_message && (
              <Typography variant="caption" color="error.main" sx={{ display: 'block', fontSize: '0.72rem' }}>
                {selectedNodeInfo.step.error_message}
              </Typography>
            )}
            {!selectedNodeInfo.step && (
              <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.72rem' }}>
                Step not yet executed
              </Typography>
            )}
          </Box>

          {/* Actions */}
          {showRetrySparkLoad && (
            <Button
              size="small" color="warning" variant="outlined"
              startIcon={retryPending ? <CircularProgress size={12} color="inherit" /> : <Replay sx={{ fontSize: '0.9rem !important' }} />}
              disabled={retryPending}
              onClick={onRetrySparkLoad}
              sx={{ flexShrink: 0, fontSize: '0.72rem' }}
            >
              Retry Spark Load
            </Button>
          )}
          {showRerun && !showRetrySparkLoad && (
            <Button
              size="small" color="primary" variant="outlined"
              startIcon={<PlayArrow sx={{ fontSize: '0.9rem !important' }} />}
              onClick={onRerun}
              sx={{ flexShrink: 0, fontSize: '0.72rem' }}
            >
              Re-run Pipeline
            </Button>
          )}
        </Box>
      )}
    </Box>
  )
}
