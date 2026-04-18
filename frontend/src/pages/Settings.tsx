import { useState, useEffect } from 'react'
import {
  Box, Typography, Card, CardContent, TextField, Button,
  Alert, CircularProgress, Divider, Tab, Tabs, Chip,
  ToggleButtonGroup, ToggleButton,
} from '@mui/material'
import {
  Save, Brightness4, Brightness7, Water,
  ViewAgenda, ViewCompact,
} from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { contextApi } from '../api/client'
import { useThemeStore, ThemeMode, Density } from '../store/theme'

const APP_VERSION = '0.1.0'
const BACKEND_URL = 'http://localhost:8000'

// ── Tab panel helper ──────────────────────────────────────────────────────────

function TabPanel({ children, value, index }: {
  children?: React.ReactNode
  value: number
  index: number
}) {
  return value === index ? <Box sx={{ pt: 2.5 }}>{children}</Box> : null
}

// ── Settings page ─────────────────────────────────────────────────────────────

export default function Settings() {
  const qc = useQueryClient()
  const [tab, setTab] = useState(0)
  const { mode, setMode, density, setDensity } = useThemeStore()

  const { data: ctx, isLoading } = useQuery({
    queryKey: ['execution-context'],
    queryFn: contextApi.get,
  })

  const [businessDate, setBusinessDate] = useState('')
  const [namespacePrefix, setNamespacePrefix] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [saveErr, setSaveErr] = useState('')

  useEffect(() => {
    if (ctx) {
      setBusinessDate(ctx.business_date ?? '')
      setNamespacePrefix(ctx.namespace_prefix ?? '')
    }
  }, [ctx])

  const updateMut = useMutation({
    mutationFn: (data: { business_date: string; namespace_prefix: string }) =>
      contextApi.update(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['execution-context'] })
      setSaveMsg('Context saved.')
      setSaveErr('')
      setTimeout(() => setSaveMsg(''), 3000)
    },
    onError: (e: Error) => setSaveErr(e.message),
  })

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress size={28} />
      </Box>
    )
  }

  return (
    <Box sx={{ p: 3, maxWidth: 740 }}>
      <Typography variant="h5" fontWeight={700} mb={0.5}>Settings</Typography>
      <Typography variant="body2" color="text.secondary" mb={2.5}>
        Configure workspace preferences and execution context.
      </Typography>

      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          textColor="primary"
          indicatorColor="primary"
        >
          <Tab label="General"    sx={{ textTransform: 'none', fontWeight: 500, minHeight: 40, fontSize: '0.82rem' }} />
          <Tab label="Appearance" sx={{ textTransform: 'none', fontWeight: 500, minHeight: 40, fontSize: '0.82rem' }} />
          <Tab label="About"      sx={{ textTransform: 'none', fontWeight: 500, minHeight: 40, fontSize: '0.82rem' }} />
        </Tabs>
      </Box>

      {/* ── General ──────────────────────────────────────────────────── */}
      <TabPanel value={tab} index={0}>
        {saveMsg && <Alert severity="success" sx={{ mb: 2 }}>{saveMsg}</Alert>}
        {saveErr && <Alert severity="error"   sx={{ mb: 2 }}>{saveErr}</Alert>}

        <Card>
          <CardContent>
            <Typography variant="subtitle2" fontWeight={700} mb={0.5}>
              Execution Context
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block" mb={2.5}>
              The business date and namespace prefix are used as reference values during
              pipeline runs and SQL variable injection.
            </Typography>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 360 }}>
              <TextField
                label="Business Date"
                type="date"
                value={businessDate}
                onChange={e => setBusinessDate(e.target.value)}
                size="small"
                InputLabelProps={{ shrink: true }}
                helperText="Reference date for pipeline runs and SQL variable injection"
              />
              <TextField
                label="Namespace Prefix"
                value={namespacePrefix}
                onChange={e => setNamespacePrefix(e.target.value)}
                size="small"
                placeholder="e.g. markets_"
                helperText="Optional prefix prepended to the derived namespace (prefix + YYYYMMDD)"
              />
              {ctx && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Derived namespace:
                  </Typography>
                  <Chip
                    label={ctx.namespace ?? '—'}
                    size="small"
                    variant="outlined"
                    sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}
                  />
                </Box>
              )}
            </Box>

            <Box sx={{ mt: 2.5 }}>
              <Button
                variant="contained"
                size="small"
                startIcon={<Save />}
                onClick={() =>
                  updateMut.mutate({ business_date: businessDate, namespace_prefix: namespacePrefix })
                }
                disabled={updateMut.isPending}
              >
                Save Context
              </Button>
            </Box>
          </CardContent>
        </Card>
      </TabPanel>

      {/* ── Appearance ───────────────────────────────────────────────── */}
      <TabPanel value={tab} index={1}>
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle2" fontWeight={700} mb={0.5}>
              Color Theme
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block" mb={2}>
              Saved automatically. Also accessible from the account menu in the sidebar.
            </Typography>
            <ToggleButtonGroup
              value={mode}
              exclusive
              onChange={(_, val) => val && setMode(val as ThemeMode)}
              size="small"
            >
              <ToggleButton value="github-dark" sx={{ flexDirection: 'column', py: 1, gap: 0.5, px: 2.5 }}>
                <Brightness4 sx={{ fontSize: 20 }} />
                <Typography variant="caption">GitHub Dark</Typography>
              </ToggleButton>
              <ToggleButton value="dark-blue" sx={{ flexDirection: 'column', py: 1, gap: 0.5, px: 2.5 }}>
                <Water sx={{ fontSize: 20 }} />
                <Typography variant="caption">Dark Blue</Typography>
              </ToggleButton>
              <ToggleButton value="light" sx={{ flexDirection: 'column', py: 1, gap: 0.5, px: 2.5 }}>
                <Brightness7 sx={{ fontSize: 20 }} />
                <Typography variant="caption">Light</Typography>
              </ToggleButton>
            </ToggleButtonGroup>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <Typography variant="subtitle2" fontWeight={700} mb={0.5}>
              Layout Density
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block" mb={2}>
              Compact mode reduces font sizes and element spacing to show more content at once.
            </Typography>
            <ToggleButtonGroup
              value={density}
              exclusive
              onChange={(_, val) => val && setDensity(val as Density)}
              size="small"
            >
              <ToggleButton value="normal" sx={{ flexDirection: 'column', py: 1, gap: 0.5, px: 3 }}>
                <ViewAgenda sx={{ fontSize: 20 }} />
                <Typography variant="caption">Default</Typography>
              </ToggleButton>
              <ToggleButton value="compact" sx={{ flexDirection: 'column', py: 1, gap: 0.5, px: 3 }}>
                <ViewCompact sx={{ fontSize: 20 }} />
                <Typography variant="caption">Compact</Typography>
              </ToggleButton>
            </ToggleButtonGroup>
          </CardContent>
        </Card>
      </TabPanel>

      {/* ── About ────────────────────────────────────────────────────── */}
      <TabPanel value={tab} index={2}>
        <Card>
          <CardContent>
            <Typography variant="subtitle2" fontWeight={700} mb={2}>
              System Information
            </Typography>
            <Divider sx={{ mb: 2 }} />
            <Box sx={{ display: 'grid', gridTemplateColumns: '160px 1fr', rowGap: 1.5 }}>
              <Typography variant="body2" color="text.secondary">App Version</Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{APP_VERSION}</Typography>

              <Typography variant="body2" color="text.secondary">Backend URL</Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{BACKEND_URL}</Typography>

              <Typography variant="body2" color="text.secondary">Active Theme</Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{mode}</Typography>

              <Typography variant="body2" color="text.secondary">Density</Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{density}</Typography>
            </Box>
          </CardContent>
        </Card>
      </TabPanel>
    </Box>
  )
}
