import { Box, TextField, InputAdornment, IconButton, Tooltip, Typography } from '@mui/material'
import { Search, Close, Refresh } from '@mui/icons-material'

interface Props {
  search: string
  onSearchChange: (v: string) => void
  searchPlaceholder?: string
  /** If provided, a refresh icon button appears on the right */
  onRefresh?: () => void
  /** Filtered count — shown as "N / total" when both are provided */
  count?: number
  total?: number
  /** Additional controls rendered between the search field and the spacer (filters, chips, etc.) */
  children?: React.ReactNode
}

export default function TableToolbar({
  search, onSearchChange, searchPlaceholder = 'Search…',
  onRefresh, count, total, children,
}: Props) {
  return (
    <Box sx={{ display: 'flex', gap: 1.5, mb: 2, flexWrap: 'wrap', alignItems: 'center' }}>
      <TextField
        placeholder={searchPlaceholder}
        value={search}
        onChange={e => onSearchChange(e.target.value)}
        size="small"
        sx={{ width: 240 }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <Search fontSize="small" />
            </InputAdornment>
          ),
          endAdornment: search ? (
            <InputAdornment position="end">
              <IconButton size="small" onClick={() => onSearchChange('')} sx={{ p: 0.3 }}>
                <Close sx={{ fontSize: 14 }} />
              </IconButton>
            </InputAdornment>
          ) : null,
        }}
      />
      {children}
      <Box sx={{ flex: 1 }} />
      {count != null && total != null && count < total && (
        <Typography variant="caption" color="text.disabled">
          {count} / {total}
        </Typography>
      )}
      {onRefresh && (
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={onRefresh}>
            <Refresh fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  )
}
