import { TableCell, Box } from '@mui/material'
import { ArrowUpward, ArrowDownward, UnfoldMore } from '@mui/icons-material'

interface Props<T extends string> {
  field: T
  label: string
  current: T
  dir: 'asc' | 'desc'
  onSort: (f: T) => void
  width?: number | string
  align?: 'left' | 'right' | 'center'
  padding?: 'normal' | 'checkbox' | 'none'
}

export default function SortableTableCell<T extends string>({
  field, label, current, dir, onSort, width, align, padding,
}: Props<T>) {
  const active = current === field
  return (
    <TableCell
      onClick={() => onSort(field)}
      width={width}
      align={align}
      padding={padding}
      sx={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', '&:hover': { color: 'primary.main' } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}>
        {label}
        {active
          ? dir === 'asc' ? <ArrowUpward sx={{ fontSize: 14 }} /> : <ArrowDownward sx={{ fontSize: 14 }} />
          : <UnfoldMore sx={{ fontSize: 14, opacity: 0.3 }} />}
      </Box>
    </TableCell>
  )
}
