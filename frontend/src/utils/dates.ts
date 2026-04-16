/**
 * Parse a datetime string from the API as UTC.
 *
 * The backend (SQLite) returns naive datetime strings like "2026-04-16T14:30:00"
 * with no timezone suffix. JavaScript's Date constructor treats these as LOCAL
 * time, which shifts all timestamps by the local UTC offset.
 *
 * Appending "Z" forces UTC interpretation so relative/absolute displays are correct.
 */
export function parseApiDate(s: string | null | undefined): Date {
  if (!s) return new Date(NaN)
  // Already has timezone info — parse as-is
  if (s.endsWith('Z') || s.includes('+') || (s.length > 19 && s[19] === '-')) {
    return new Date(s)
  }
  return new Date(s + 'Z')
}
