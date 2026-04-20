import { Chip } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { CircularProgress } from '@mui/material'
import { Box } from '@mui/material'

// Canonical color for each status value
export const STATUS_COLOR: Record<string, string> = {
  // green — success states
  active:    '#3fb950',
  completed: '#3fb950',
  healthy:   '#3fb950',
  passed:    '#3fb950',
  success:   '#3fb950',
  // red — failure states
  failed:    '#f85149',
  error:     '#f85149',
  unhealthy: '#f85149',
  // blue — in-progress
  running:   '#58a6ff',
  pending:   '#58a6ff',
  // amber — warning / draft
  draft:                    '#d29922',
  degraded:                 '#d29922',
  warning:                  '#d29922',
  completed_with_warnings:  '#d29922',
  // grey — neutral / terminal
  inactive:  '#8b949e',
  cancelled: '#8b949e',
  skipped:   '#8b949e',
  idle:      '#8b949e',
  unknown:   '#8b949e',
}

const DEFAULT_COLOR = '#8b949e'

interface Props {
  status: string
  size?: 'small' | 'medium'
  /** Override the display label (defaults to the status string) */
  label?: string
}

export default function StatusChip({ status, size = 'small', label }: Props) {
  const color = STATUS_COLOR[status.toLowerCase()] ?? DEFAULT_COLOR
  const isRunning = status === 'running'
  const displayLabel = label ?? (status === 'completed_with_warnings' ? 'completed (warnings)' : status)

  return (
    <Chip
      size={size}
      label={
        isRunning ? (
          <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <CircularProgress size={9} thickness={4} sx={{ color, flexShrink: 0 }} />
            {displayLabel}
          </Box>
        ) : displayLabel
      }
      sx={{
        height: size === 'medium' ? 24 : 20,
        fontSize: size === 'medium' ? '0.72rem' : '0.67rem',
        fontWeight: 600,
        letterSpacing: '0.02em',
        bgcolor: alpha(color, 0.14),
        color,
        border: `1px solid ${alpha(color, 0.38)}`,
        '& .MuiChip-label': { px: 1 },
        animation: isRunning ? 'statusPulse 1.4s ease-in-out infinite' : 'none',
        '@keyframes statusPulse': {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.55 },
        },
      }}
    />
  )
}
