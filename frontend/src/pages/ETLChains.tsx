import { useState, useEffect, useCallback } from 'react'
import {
  Box, Typography, Button, CircularProgress, Chip, alpha,
  useTheme, IconButton, Alert, Paper, Divider,
  Select, MenuItem, FormControl, InputLabel, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, Tooltip, Stack,
  List, ListItem, ListItemText, ListItemIcon,
} from '@mui/material'
import {
  Add, PlayArrow, Delete, Refresh, CheckCircle,
  Error as ErrorIcon, HourglassBottom, RadioButtonUnchecked,
  AccountTree, Transform, DragIndicator, ArrowDownward,
  KeyboardArrowUp, KeyboardArrowDown,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSnackbar } from 'notistack'
import {
  pipelinesApi, transformJobsApi, chainsApi,
  ETLChain, ChainStep, Pipeline, TransformJob,
} from '../api/client'
import { formatDistanceToNow } from 'date-fns'
import { parseApiDate } from '../utils/dates'

const MONO = '"JetBrains Mono", "Fira Code", monospace'

// ─── Status chip ─────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { color: 'success' | 'error' | 'warning' | 'default'; icon: JSX.Element }> = {
    completed: { color: 'success', icon: <CheckCircle sx={{ fontSize: 14 }} /> },
    failed: { color: 'error', icon: <ErrorIcon sx={{ fontSize: 14 }} /> },
    running: { color: 'warning', icon: <HourglassBottom sx={{ fontSize: 14 }} /> },
    idle: { color: 'default', icon: <RadioButtonUnchecked sx={{ fontSize: 14 }} /> },
  }
  const { color, icon } = map[status] ?? map.idle
  return (
    <Chip
      icon={icon}
      label={status}
      color={color}
      size="small"
      variant="outlined"
      sx={{ fontFamily: MONO, fontSize: '0.7rem', textTransform: 'capitalize' }}
    />
  )
}

// ─── Step display ─────────────────────────────────────────────────────────────

function StepBadge({ step }: { step: ChainStep }) {
  const theme = useTheme()
  const isPipeline = step.type === 'pipeline'
  return (
    <Chip
      icon={isPipeline ? <AccountTree sx={{ fontSize: 13 }} /> : <Transform sx={{ fontSize: 13 }} />}
      label={step.label ?? (isPipeline ? `Pipeline #${step.pipeline_id}` : `Transform #${step.transform_job_id}`)}
      size="small"
      variant="outlined"
      color={isPipeline ? 'primary' : 'warning'}
      sx={{ fontFamily: MONO, fontSize: '0.72rem' }}
    />
  )
}

// ─── Chain editor dialog ──────────────────────────────────────────────────────

interface ChainEditorProps {
  open: boolean
  onClose: () => void
  initial?: ETLChain
  pipelines: Pipeline[]
  transformJobs: TransformJob[]
  onSave: (data: Pick<ETLChain, 'name' | 'description' | 'steps'>) => void
  saving: boolean
}

function ChainEditor({ open, onClose, initial, pipelines, transformJobs, onSave, saving }: ChainEditorProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [steps, setSteps] = useState<ChainStep[]>(initial?.steps ?? [])
  const [addType, setAddType] = useState<'pipeline' | 'transform'>('pipeline')
  const [addId, setAddId] = useState<number | ''>('')

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '')
      setDescription(initial?.description ?? '')
      setSteps(initial?.steps ?? [])
      setAddId('')
    }
  }, [open, initial])

  const addStep = () => {
    if (addId === '') return
    const step: ChainStep =
      addType === 'pipeline'
        ? {
            type: 'pipeline',
            pipeline_id: Number(addId),
            label: pipelines.find((p) => p.id === Number(addId))?.name,
          }
        : {
            type: 'transform',
            transform_job_id: Number(addId),
            label: transformJobs.find((j) => j.id === Number(addId))?.name,
          }
    setSteps((prev) => [...prev, step])
    setAddId('')
  }

  const moveStep = (idx: number, dir: -1 | 1) => {
    const next = [...steps]
    const target = idx + dir
    if (target < 0 || target >= next.length) return
    ;[next[idx], next[target]] = [next[target], next[idx]]
    setSteps(next)
  }

  const removeStep = (idx: number) => setSteps(steps.filter((_, i) => i !== idx))

  const valid = name.trim() && steps.length > 0

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial?.id ? 'Edit Chain' : 'New Chain'}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1.5 }}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required fullWidth size="small" />
        <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth size="small" />

        <Divider><Typography variant="caption" color="text.secondary">Steps (ordered)</Typography></Divider>

        {/* Existing steps */}
        {steps.length === 0 && (
          <Typography variant="caption" color="text.disabled" sx={{ textAlign: 'center', py: 1 }}>
            No steps yet — add pipelines and transforms below
          </Typography>
        )}
        {steps.map((step, idx) => (
          <Box
            key={idx}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              px: 1,
              py: 0.5,
              borderRadius: 1,
              border: '1px solid',
              borderColor: 'divider',
            }}
          >
            <DragIndicator sx={{ fontSize: 16, color: 'text.disabled' }} />
            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 20 }}>
              {idx + 1}.
            </Typography>
            <StepBadge step={step} />
            <Box sx={{ flex: 1 }} />
            <IconButton size="small" disabled={idx === 0} onClick={() => moveStep(idx, -1)}>
              <KeyboardArrowUp sx={{ fontSize: 16 }} />
            </IconButton>
            <IconButton size="small" disabled={idx === steps.length - 1} onClick={() => moveStep(idx, 1)}>
              <KeyboardArrowDown sx={{ fontSize: 16 }} />
            </IconButton>
            <IconButton size="small" color="error" onClick={() => removeStep(idx)}>
              <Delete sx={{ fontSize: 15 }} />
            </IconButton>
          </Box>
        ))}

        {/* Add step */}
        <Divider><Typography variant="caption" color="text.secondary">Add step</Typography></Divider>
        <Stack direction="row" spacing={1} alignItems="flex-end">
          <FormControl size="small" sx={{ width: 130 }}>
            <InputLabel>Type</InputLabel>
            <Select value={addType} label="Type" onChange={(e) => { setAddType(e.target.value as 'pipeline' | 'transform'); setAddId('') }}>
              <MenuItem value="pipeline">Pipeline</MenuItem>
              <MenuItem value="transform">Transform</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ flex: 1 }}>
            <InputLabel>{addType === 'pipeline' ? 'ETL Pipeline' : 'Transform Job'}</InputLabel>
            <Select value={addId} label={addType === 'pipeline' ? 'ETL Pipeline' : 'Transform Job'} onChange={(e) => setAddId(e.target.value as number)}>
              {addType === 'pipeline'
                ? pipelines.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)
                : transformJobs.map((j) => <MenuItem key={j.id} value={j.id}>{j.name}</MenuItem>)
              }
            </Select>
          </FormControl>
          <Button variant="outlined" size="small" onClick={addStep} disabled={addId === ''} startIcon={<Add />}>
            Add
          </Button>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => onSave({ name: name.trim(), description: description.trim() || undefined, steps })}
          disabled={!valid || saving}
        >
          {saving ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Chain card ───────────────────────────────────────────────────────────────

function ChainCard({
  chain,
  onEdit,
  onDelete,
  onRun,
  running,
}: {
  chain: ETLChain
  onEdit: () => void
  onDelete: () => void
  onRun: () => void
  running: boolean
}) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)

  return (
    <Paper
      variant="outlined"
      sx={{
        mb: 2,
        overflow: 'hidden',
        borderColor: chain.status === 'running'
          ? theme.palette.warning.main
          : chain.status === 'failed'
          ? theme.palette.error.main
          : chain.status === 'completed'
          ? theme.palette.success.main
          : 'divider',
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 2,
          py: 1.5,
          bgcolor: alpha(theme.palette.background.paper, 0.6),
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
            <Typography variant="subtitle1" fontWeight={700} noWrap>{chain.name}</Typography>
            <StatusChip status={chain.status} />
          </Box>
          {chain.description && (
            <Typography variant="caption" color="text.secondary">{chain.description}</Typography>
          )}
          {chain.last_run_at && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              Last run {formatDistanceToNow(parseApiDate(chain.last_run_at), { addSuffix: true })}
              {chain.last_run_duration_s != null && ` · ${chain.last_run_duration_s.toFixed(1)}s`}
            </Typography>
          )}
          {chain.last_error && (
            <Alert severity="error" icon={false} sx={{ mt: 0.5, py: 0, px: 0.75, fontSize: '0.7rem' }}>
              {chain.last_error}
            </Alert>
          )}
        </Box>

        <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
          <Chip
            label={`${chain.steps.length} step${chain.steps.length !== 1 ? 's' : ''}`}
            size="small"
            variant="outlined"
            onClick={() => setExpanded((e) => !e)}
            sx={{ cursor: 'pointer', fontSize: '0.7rem' }}
          />
          <Tooltip title="Run chain">
            <span>
              <IconButton
                size="small"
                color="success"
                disabled={chain.status === 'running' || running}
                onClick={onRun}
              >
                {chain.status === 'running' ? <CircularProgress size={16} /> : <PlayArrow />}
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Edit chain">
            <IconButton size="small" onClick={onEdit}><AccountTree sx={{ fontSize: 16 }} /></IconButton>
          </Tooltip>
          <Tooltip title="Delete chain">
            <IconButton size="small" color="error" onClick={onDelete}><Delete sx={{ fontSize: 16 }} /></IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Steps preview */}
      {(expanded || chain.steps.length > 0) && (
        <Box
          sx={{
            px: 2,
            py: 1,
            borderTop: `1px solid ${theme.palette.divider}`,
            bgcolor: alpha(theme.palette.background.default, 0.4),
            display: 'flex',
            flexWrap: 'wrap',
            gap: 0.5,
            alignItems: 'center',
          }}
        >
          {chain.steps.map((step, idx) => (
            <Box key={idx} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {idx > 0 && <ArrowDownward sx={{ fontSize: 14, color: 'text.disabled', transform: 'rotate(-90deg)' }} />}
              <StepBadge step={step} />
            </Box>
          ))}
          {chain.steps.length === 0 && (
            <Typography variant="caption" color="text.disabled">No steps configured</Typography>
          )}
        </Box>
      )}
    </Paper>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ETLChains() {
  const theme = useTheme()
  const qc = useQueryClient()
  const { enqueueSnackbar } = useSnackbar()

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingChain, setEditingChain] = useState<ETLChain | null>(null)
  const [deleteChainId, setDeleteChainId] = useState<number | null>(null)

  const { data: chains = [], isLoading } = useQuery({
    queryKey: ['etl-chains'],
    queryFn: () => chainsApi.list().then((r) => r.data),
    refetchInterval: 5000,
  })

  const { data: pipelines = [] } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => pipelinesApi.list().then((r) => r.data),
  })

  const { data: transformJobs = [] } = useQuery({
    queryKey: ['transform-jobs'],
    queryFn: () => transformJobsApi.list().then((r) => r.data),
  })

  const createChain = useMutation({
    mutationFn: chainsApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['etl-chains'] }); setEditorOpen(false); enqueueSnackbar('Chain created', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to create chain', { variant: 'error' }),
  })

  const updateChain = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof chainsApi.update>[1] }) => chainsApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['etl-chains'] }); setEditorOpen(false); enqueueSnackbar('Chain saved', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to save chain', { variant: 'error' }),
  })

  const deleteChain = useMutation({
    mutationFn: chainsApi.delete,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['etl-chains'] }); setDeleteChainId(null); enqueueSnackbar('Chain deleted', { variant: 'success' }) },
    onError: () => enqueueSnackbar('Failed to delete chain', { variant: 'error' }),
  })

  const runChain = useMutation({
    mutationFn: chainsApi.run,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['etl-chains'] }); enqueueSnackbar('Chain started', { variant: 'info' }) },
    onError: (err: any) => enqueueSnackbar(err?.response?.data?.detail ?? 'Failed to start chain', { variant: 'error' }),
  })

  const handleSave = useCallback((data: Parameters<typeof createChain.mutate>[0]) => {
    if (editingChain?.id) updateChain.mutate({ id: editingChain.id, data })
    else createChain.mutate(data)
  }, [editingChain, createChain, updateChain])

  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3, gap: 2 }}>
        <AccountTree sx={{ color: 'primary.main', fontSize: 28 }} />
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={700}>ETL Chains</Typography>
          <Typography variant="body2" color="text.secondary">
            Combine ETL pipelines and transform jobs into ordered execution chains
          </Typography>
        </Box>
        <Tooltip title="Refresh">
          <IconButton onClick={() => qc.invalidateQueries({ queryKey: ['etl-chains'] })}>
            <Refresh />
          </IconButton>
        </Tooltip>
        <Button
          variant="contained"
          startIcon={<Add />}
          onClick={() => { setEditingChain(null); setEditorOpen(true) }}
        >
          New Chain
        </Button>
      </Box>

      {/* Summary chips */}
      <Stack direction="row" spacing={1} sx={{ mb: 3 }}>
        <Chip label={`${chains.length} chain${chains.length !== 1 ? 's' : ''}`} size="small" variant="outlined" />
        <Chip label={`${pipelines.length} pipeline${pipelines.length !== 1 ? 's' : ''}`} size="small" variant="outlined" color="primary" icon={<AccountTree sx={{ fontSize: 13 }} />} />
        <Chip label={`${transformJobs.length} transform${transformJobs.length !== 1 ? 's' : ''}`} size="small" variant="outlined" color="warning" icon={<Transform sx={{ fontSize: 13 }} />} />
      </Stack>

      {/* Content */}
      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', pt: 6 }}>
          <CircularProgress />
        </Box>
      )}

      {!isLoading && chains.length === 0 && (
        <Paper
          variant="outlined"
          sx={{
            textAlign: 'center',
            py: 8,
            color: 'text.secondary',
            borderStyle: 'dashed',
          }}
        >
          <AccountTree sx={{ fontSize: 48, mb: 2, opacity: 0.4 }} />
          <Typography variant="h6" gutterBottom>No chains yet</Typography>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Create a chain to sequence ETL pipelines and transform jobs together
          </Typography>
          <Button variant="outlined" startIcon={<Add />} onClick={() => { setEditingChain(null); setEditorOpen(true) }}>
            Create your first chain
          </Button>
        </Paper>
      )}

      {!isLoading && chains.map((chain) => (
        <ChainCard
          key={chain.id}
          chain={chain}
          running={runChain.isPending}
          onEdit={() => { setEditingChain(chain); setEditorOpen(true) }}
          onDelete={() => setDeleteChainId(chain.id)}
          onRun={() => runChain.mutate(chain.id)}
        />
      ))}

      {/* Chain editor dialog */}
      <ChainEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        initial={editingChain ?? undefined}
        pipelines={pipelines}
        transformJobs={transformJobs}
        onSave={handleSave}
        saving={createChain.isPending || updateChain.isPending}
      />

      {/* Delete confirmation */}
      <Dialog open={deleteChainId !== null} onClose={() => setDeleteChainId(null)} maxWidth="xs">
        <DialogTitle>Delete chain?</DialogTitle>
        <DialogContent>
          <Typography>This will permanently delete the chain.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteChainId(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => deleteChainId && deleteChain.mutate(deleteChainId)}
            disabled={deleteChain.isPending}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
