import { useState } from 'react'
import {
  Box, Typography, Button, Card, CardContent, CardActions,
  Chip, IconButton, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, MenuItem, List, ListItem, ListItemText, ListItemIcon,
  Divider, CircularProgress, Alert, Collapse, alpha, useTheme,
  Tooltip,
} from '@mui/material'
import {
  Add, PlayArrow, Edit, Delete, ExpandMore, ExpandLess,
  Schema as PipelineIcon, Transform as TransformIcon,
  DragIndicator, Close,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { transformApi, pipelinesApi, ETLChain, ChainStep } from '../api/client'
import StatusChip from '../components/StatusChip'

function StepTypeIcon({ type }: { type: string }) {
  return type === 'pipeline'
    ? <PipelineIcon fontSize="small" sx={{ color: '#58a6ff' }} />
    : <TransformIcon fontSize="small" sx={{ color: '#d29922' }} />
}

interface WorkflowDialogProps {
  open: boolean
  onClose: () => void
  initial?: ETLChain
  onSave: (data: Partial<ETLChain>) => Promise<void>
}

function WorkflowDialog({ open, onClose, initial, onSave }: WorkflowDialogProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [steps, setSteps] = useState<ChainStep[]>(initial?.steps ?? [])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const { data: pipelines = [] } = useQuery({ queryKey: ['pipelines'], queryFn: pipelinesApi.list })
  const { data: jobs = [] } = useQuery({ queryKey: ['transform-jobs'], queryFn: transformApi.listJobs })

  function addStep() {
    setSteps(s => [...s, { type: 'pipeline', label: `Step ${s.length + 1}` }])
  }

  function removeStep(i: number) {
    setSteps(s => s.filter((_, idx) => idx !== i))
  }

  function updateStep(i: number, patch: Partial<ChainStep>) {
    setSteps(s => s.map((step, idx) => idx === i ? { ...step, ...patch } : step))
  }

  async function handleSave() {
    if (!name.trim()) { setErr('Name is required'); return }
    setSaving(true)
    try {
      await onSave({ name, description, steps })
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{initial ? 'Edit Workflow' : 'New Workflow'}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '16px !important' }}>
        {err && <Alert severity="error">{err}</Alert>}
        <TextField label="Name" value={name} onChange={e => setName(e.target.value)} size="small" fullWidth />
        <TextField label="Description" value={description} onChange={e => setDescription(e.target.value)} size="small" fullWidth multiline rows={2} />
        <Divider />
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Steps</Typography>
          <Button size="small" startIcon={<Add />} onClick={addStep}>Add Step</Button>
        </Box>
        {steps.map((step, i) => (
          <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
            <Typography variant="body2" sx={{ minWidth: 24, pt: 1.2, color: 'text.secondary' }}>
              {i + 1}
            </Typography>
            <TextField
              select label="Type" value={step.type}
              onChange={e => updateStep(i, { type: e.target.value as 'pipeline' | 'transform', pipeline_id: undefined, transform_job_id: undefined })}
              size="small" sx={{ width: 130 }}
            >
              <MenuItem value="pipeline">Pipeline</MenuItem>
              <MenuItem value="transform">Transform</MenuItem>
            </TextField>
            {step.type === 'pipeline' ? (
              <TextField
                select label="Pipeline" value={step.pipeline_id ?? ''}
                onChange={e => updateStep(i, { pipeline_id: Number(e.target.value), label: pipelines.find(p => p.id === Number(e.target.value))?.name ?? step.label })}
                size="small" sx={{ flex: 1 }}
              >
                {pipelines.map(p => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
              </TextField>
            ) : (
              <TextField
                select label="Transform Job" value={step.transform_job_id ?? ''}
                onChange={e => updateStep(i, { transform_job_id: Number(e.target.value), label: jobs.find(j => j.id === Number(e.target.value))?.name ?? step.label })}
                size="small" sx={{ flex: 1 }}
              >
                {jobs.map(j => <MenuItem key={j.id} value={j.id}>{j.name}</MenuItem>)}
              </TextField>
            )}
            <TextField
              label="Label" value={step.label}
              onChange={e => updateStep(i, { label: e.target.value })}
              size="small" sx={{ flex: 1 }}
            />
            <IconButton size="small" onClick={() => removeStep(i)} sx={{ mt: 0.5 }}>
              <Close fontSize="small" />
            </IconButton>
          </Box>
        ))}
        {steps.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 2 }}>
            No steps yet. Add a step to get started.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving}>
          {saving ? <CircularProgress size={18} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

interface RunResult {
  id: number
  status: string
}

export default function Workflows() {
  const theme = useTheme()
  const qc = useQueryClient()
  const [newOpen, setNewOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<ETLChain | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [runResults, setRunResults] = useState<Record<number, RunResult>>({})

  const { data: chains = [], isLoading } = useQuery({
    queryKey: ['chains'],
    queryFn: transformApi.listChains,
  })

  const createMut = useMutation({
    mutationFn: (data: Partial<ETLChain>) => transformApi.createChain(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chains'] }),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<ETLChain> }) =>
      transformApi.updateChain(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chains'] }),
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => transformApi.deleteChain(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chains'] }),
  })

  const runMut = useMutation({
    mutationFn: (id: number) => transformApi.runChain(id),
    onSuccess: (result, id) => {
      setRunResults(r => ({ ...r, [id]: { id: result.id, status: result.status } }))
    },
  })

  if (isLoading) return <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 3 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>Workflows</Typography>
          <Typography variant="body2" color="text.secondary">Orchestrate pipelines and transforms in sequence</Typography>
        </Box>
        <Button variant="contained" startIcon={<Add />} onClick={() => setNewOpen(true)}>
          New Workflow
        </Button>
      </Box>

      {chains.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
          <PipelineIcon sx={{ fontSize: 48, opacity: 0.3, mb: 2 }} />
          <Typography>No workflows yet. Create one to get started.</Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
          {chains.map(chain => {
            const expanded = expandedId === chain.id
            const runResult = runResults[chain.id]
            return (
              <Box key={chain.id}>
                <Card sx={{ height: '100%' }}>
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 1 }}>
                      <Box sx={{ flex: 1 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{chain.name}</Typography>
                        {chain.description && (
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            {chain.description}
                          </Typography>
                        )}
                      </Box>
                      <Chip label={`${chain.steps.length} steps`} size="small" variant="outlined" />
                    </Box>

                    {runResult && (
                      <StatusChip status={runResult.status} />
                    )}

                    <Collapse in={expanded}>
                      <Divider sx={{ my: 1.5 }} />
                      <List dense disablePadding>
                        {chain.steps.map((step, index) => (
                          <ListItem key={`${step.type}-${step.label}-${index}`} disablePadding sx={{ py: 0.25 }}>
                            <ListItemIcon sx={{ minWidth: 28 }}>
                              <StepTypeIcon type={step.type} />
                            </ListItemIcon>
                            <ListItemText
                              primary={<Typography variant="body2" sx={{ fontWeight: 500 }}>{step.label}</Typography>}
                              secondary={<Typography variant="caption">{step.type}</Typography>}
                            />
                            <Chip
                              label={step.type}
                              size="small"
                              sx={{
                                fontSize: '0.65rem', height: 18,
                                bgcolor: alpha(step.type === 'pipeline' ? '#58a6ff' : '#d29922', 0.12),
                                color: step.type === 'pipeline' ? '#58a6ff' : '#d29922',
                              }}
                            />
                          </ListItem>
                        ))}
                      </List>
                    </Collapse>
                  </CardContent>
                  <CardActions sx={{ justifyContent: 'space-between', pt: 0 }}>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <Tooltip title="Run workflow">
                        <IconButton
                          size="small" color="primary"
                          onClick={() => runMut.mutate(chain.id)}
                          disabled={runMut.isPending}
                        >
                          <PlayArrow fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => setEditTarget(chain)}>
                          <Edit fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton
                          size="small" color="error"
                          onClick={() => { if (window.confirm('Delete this workflow?')) deleteMut.mutate(chain.id) }}
                        >
                          <Delete fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                    <IconButton size="small" onClick={() => setExpandedId(expanded ? null : chain.id)}>
                      {expanded ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
                    </IconButton>
                  </CardActions>
                </Card>
              </Box>
            )
          })}
        </Box>
      )}

      <WorkflowDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onSave={async data => { await createMut.mutateAsync(data) }}
      />
      {editTarget && (
        <WorkflowDialog
          open
          onClose={() => setEditTarget(null)}
          initial={editTarget}
          onSave={async data => { await updateMut.mutateAsync({ id: editTarget.id, data }) }}
        />
      )}
    </Box>
  )
}
