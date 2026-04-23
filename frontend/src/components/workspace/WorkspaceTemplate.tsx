import { useEffect, useRef, useState } from 'react'
import { Box, IconButton, Tooltip, alpha, useTheme } from '@mui/material'
import { SxProps, Theme } from '@mui/material/styles'

export interface WorkspaceLayoutState {
  leftSidebarWidth: number
  leftCollapsed: boolean
  rightCollapsed: boolean
}

export interface WorkspaceTemplateProps {
  storageKey: string
  renderLeftPanel: () => React.ReactNode
  renderMainPanel: () => React.ReactNode
  renderRightPanel: () => React.ReactNode
  defaultLayout?: Partial<WorkspaceLayoutState>
  minLeftWidth?: number
  maxLeftWidth?: number
  rightPanelWidth?: number
  leftPanelLabel?: string
  rightPanelLabel?: string
  showPanelControlsRow?: boolean
}

export const workspaceSidebarSurfaceSx = (theme: Theme) => ({
  bgcolor: '#0d1117',
  color: '#c9d1d9',
  '& .MuiDivider-root': {
    borderColor: alpha('#ffffff', 0.08),
  },
})

export const workspaceSidebarSectionLabelSx: SxProps<Theme> = {
  px: 1.5,
  py: 0.5,
  fontSize: '0.72rem',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#8b949e',
  fontWeight: 700,
}

export const workspaceSidebarItemButtonSx: SxProps<Theme> = (theme) => {
  const hoverBg = alpha('#ffffff', 0.06)
  const selectedBg = alpha(theme.palette.primary.main, 0.2)
  return {
    minHeight: 26,
    px: 1.5,
    py: 0.35,
    borderRadius: 0,
    gap: 0.75,
    color: '#c9d1d9',
    borderLeft: '2px solid transparent',
    '& .MuiSvgIcon-root': {
      color: '#8b949e',
    },
    '&:hover': {
      bgcolor: hoverBg,
    },
    '&.Mui-selected': {
      bgcolor: selectedBg,
      borderLeftColor: theme.palette.primary.main,
    },
    '&.Mui-selected:hover': {
      bgcolor: selectedBg,
    },
  }
}

export const workspaceSidebarItemTextSx: SxProps<Theme> = {
  fontSize: '0.72rem',
  fontWeight: 500,
  lineHeight: 1.3,
  color: '#c9d1d9',
}

const DEFAULT_LAYOUT: WorkspaceLayoutState = {
  leftSidebarWidth: 320,
  leftCollapsed: false,
  rightCollapsed: false,
}

function loadLayout(storageKey: string, defaults: WorkspaceLayoutState): WorkspaceLayoutState {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<WorkspaceLayoutState>
    return {
      leftSidebarWidth: Number.isFinite(parsed.leftSidebarWidth)
        ? Number(parsed.leftSidebarWidth)
        : defaults.leftSidebarWidth,
      leftCollapsed: Boolean(parsed.leftCollapsed),
      rightCollapsed: Boolean(parsed.rightCollapsed),
    }
  } catch {
    return defaults
  }
}

export function PanelSideIcon({ side, active }: { side: 'left' | 'right'; active: boolean }) {
  return (
    <Box
      sx={{
        width: 14,
        height: 14,
        border: '1.5px solid currentColor',
        borderRadius: '2px',
        position: 'relative',
        overflow: 'hidden',
        opacity: active ? 1 : 0.65,
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          width: '38%',
          [side]: 0,
          bgcolor: 'currentColor',
          opacity: active ? 0.85 : 0.2,
        }}
      />
    </Box>
  )
}

export default function WorkspaceTemplate({
  storageKey,
  renderLeftPanel,
  renderMainPanel,
  renderRightPanel,
  defaultLayout,
  minLeftWidth = 170,
  maxLeftWidth = 560,
  rightPanelWidth = 300,
  leftPanelLabel = 'files panel',
  rightPanelLabel = 'versions panel',
  showPanelControlsRow = true,
}: WorkspaceTemplateProps) {
  const theme = useTheme()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const defaults = {
    ...DEFAULT_LAYOUT,
    ...defaultLayout,
  }
  const initial = loadLayout(storageKey, defaults)

  const [leftSidebarWidth, setLeftSidebarWidth] = useState(initial.leftSidebarWidth)
  const [leftCollapsed, setLeftCollapsed] = useState(initial.leftCollapsed)
  const [rightCollapsed, setRightCollapsed] = useState(initial.rightCollapsed)
  const [leftResizing, setLeftResizing] = useState(false)

  useEffect(() => {
    if (!leftResizing) return

    const onMouseMove = (e: MouseEvent) => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const next = Math.max(minLeftWidth, Math.min(maxLeftWidth, e.clientX - rect.left))
      setLeftSidebarWidth(next)
    }

    const onMouseUp = () => {
      setLeftResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [leftResizing, minLeftWidth, maxLeftWidth])

  useEffect(() => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ leftSidebarWidth, leftCollapsed, rightCollapsed }),
    )
  }, [storageKey, leftSidebarWidth, leftCollapsed, rightCollapsed])

  useEffect(() => {
    const onToggleLeft = () => setLeftCollapsed(v => !v)
    const onToggleRight = () => setRightCollapsed(v => !v)
    window.addEventListener('workspace-panel-toggle-left', onToggleLeft)
    window.addEventListener('workspace-panel-toggle-right', onToggleRight)
    return () => {
      window.removeEventListener('workspace-panel-toggle-left', onToggleLeft)
      window.removeEventListener('workspace-panel-toggle-right', onToggleRight)
    }
  }, [])

  return (
    <Box ref={rootRef} sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {showPanelControlsRow && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            px: 1.25,
            py: 0.5,
            borderBottom: `1px solid ${theme.palette.divider}`,
            bgcolor: alpha(theme.palette.background.paper, 0.9),
            flexShrink: 0,
          }}
        >
          <Box sx={{ flex: 1 }} />
          <Tooltip title={leftCollapsed ? `Show ${leftPanelLabel}` : `Hide ${leftPanelLabel}`}>
            <IconButton
              size="small"
              onClick={() => setLeftCollapsed(v => !v)}
              sx={{
                color: leftCollapsed ? 'text.secondary' : 'primary.main',
                border: '1px solid',
                borderColor: leftCollapsed ? 'divider' : alpha(theme.palette.primary.main, 0.35),
                borderRadius: 1,
              }}
            >
              <PanelSideIcon side="left" active={!leftCollapsed} />
            </IconButton>
          </Tooltip>
          <Tooltip title={rightCollapsed ? `Show ${rightPanelLabel}` : `Hide ${rightPanelLabel}`}>
            <IconButton
              size="small"
              onClick={() => setRightCollapsed(v => !v)}
              sx={{
                color: rightCollapsed ? 'text.secondary' : 'primary.main',
                border: '1px solid',
                borderColor: rightCollapsed ? 'divider' : alpha(theme.palette.primary.main, 0.35),
                borderRadius: 1,
              }}
            >
              <PanelSideIcon side="right" active={!rightCollapsed} />
            </IconButton>
          </Tooltip>
        </Box>
      )}

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {!leftCollapsed && (
          <Box
            sx={[
              workspaceSidebarSurfaceSx,
              {
                width: leftSidebarWidth,
                flexShrink: 0,
                minWidth: 0,
                borderRight: `1px solid ${theme.palette.divider}`,
                display: 'flex',
                flexDirection: 'column',
              },
            ]}
          >
            {renderLeftPanel()}
          </Box>
        )}

        {!leftCollapsed && (
          <Box
            onMouseDown={() => setLeftResizing(true)}
            onDoubleClick={() => setLeftSidebarWidth(defaults.leftSidebarWidth)}
            sx={{
              width: 10,
              cursor: 'col-resize',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: leftResizing ? alpha(theme.palette.primary.main, 0.22) : 'transparent',
              transition: 'background-color 120ms ease',
              '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.14) },
              '&::after': {
                content: '""',
                width: 2,
                height: 34,
                borderRadius: 99,
                bgcolor: leftResizing ? 'primary.main' : alpha(theme.palette.text.secondary, 0.35),
              },
            }}
            title="Drag to resize sidebar"
          />
        )}

        <Box sx={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {renderMainPanel()}
          </Box>

          <Box
            sx={{
              width: rightCollapsed ? 0 : rightPanelWidth,
              flexShrink: 0,
              borderLeft: rightCollapsed ? 'none' : `1px solid ${theme.palette.divider}`,
              bgcolor: 'background.paper',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              transition: 'width 180ms ease',
              overflow: 'hidden',
            }}
          >
            {!rightCollapsed && renderRightPanel()}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}