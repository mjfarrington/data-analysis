/**
 * DateField — themed date picker using MUI X DatePicker.
 *
 * Accepts and returns ISO date strings (YYYY-MM-DD | '') so callers
 * don't need to deal with Date objects. Fully respects the active
 * MUI theme (dark / light) without any native browser date picker styling.
 */
import { DatePicker } from '@mui/x-date-pickers/DatePicker'
import { format, parseISO, isValid } from 'date-fns'


interface DateFieldProps {
  label: string
  value: string          // YYYY-MM-DD or ''
  onChange: (value: string) => void
  fullWidth?: boolean
  size?: 'small' | 'medium'
  helperText?: string
  placeholder?: string
  disabled?: boolean
  sx?: object
}

export default function DateField({
  label,
  value,
  onChange,
  fullWidth = false,
  size = 'small',
  helperText,
  disabled,
  sx,
}: DateFieldProps) {
  const parsed = value ? parseISO(value) : null
  const dateValue = parsed && isValid(parsed) ? parsed : null

  return (
    <DatePicker
      label={label}
      value={dateValue}
      onChange={(d) => onChange(d && isValid(d) ? format(d, 'yyyy-MM-dd') : '')}
      disabled={disabled}
      slotProps={{
        textField: {
          size,
          fullWidth,
          helperText,
          sx,
        },
        actionBar: { actions: ['clear', 'today', 'accept'] },
      }}
    />
  )
}
