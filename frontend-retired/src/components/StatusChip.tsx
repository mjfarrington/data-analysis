import { Chip } from '@mui/material'

const STATUS_MAP: Record<string, { color: 'success' | 'warning' | 'error' | 'default' | 'info'; label: string }> = {
  healthy: { color: 'success', label: 'Healthy' },
  degraded: { color: 'warning', label: 'Degraded' },
  unhealthy: { color: 'error', label: 'Unhealthy' },
  unknown: { color: 'default', label: 'Unknown' },
  active: { color: 'success', label: 'Active' },
  inactive: { color: 'default', label: 'Inactive' },
  draft: { color: 'info', label: 'Draft' },
  pending: { color: 'info', label: 'Pending' },
  running: { color: 'warning', label: 'Running' },
  completed: { color: 'success', label: 'Completed' },
  failed: { color: 'error', label: 'Failed' },
  cancelled: { color: 'default', label: 'Cancelled' },
}

export default function StatusChip({ status, size = 'small' }: { status: string; size?: 'small' | 'medium' }) {
  const mapped = STATUS_MAP[status] ?? { color: 'default' as const, label: status }
  return <Chip label={mapped.label} color={mapped.color} size={size} variant="filled" sx={{ fontWeight: 600, fontSize: '0.7rem' }} />
}
