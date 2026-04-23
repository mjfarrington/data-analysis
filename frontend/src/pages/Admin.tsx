import { useState } from 'react'
import {
  Box, Typography, Card, CardContent, Button, TextField,
  CircularProgress, Alert,
} from '@mui/material'
import { Save } from '@mui/icons-material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { contextApi } from '../api/client'

const APP_VERSION = '0.1.0'
const BACKEND_URL = 'http://localhost:8000'

export default function Admin() {
  const qc = useQueryClient()

  const { data: ctx, isLoading } = useQuery({
    queryKey: ['execution-context'],
    queryFn: contextApi.get,
  })

  const [businessDate, setBusinessDate] = useState('')
  const [namespace, setNamespace] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [saveErr, setSaveErr] = useState('')

  // Populate from server once loaded
  useState(() => {
    if (ctx) {
      setBusinessDate(ctx.business_date)
      setNamespace(ctx.namespace)
    }
  })

  const updateMut = useMutation({
    mutationFn: (data: { business_date: string; namespace: string }) =>
      contextApi.update(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['execution-context'] })
      setSaveMsg('Settings saved!')
      setSaveErr('')
      setTimeout(() => setSaveMsg(''), 3000)
    },
    onError: (e: Error) => {
      setSaveErr(e.message)
    },
  })

  function handleSave() {
    updateMut.mutate({ business_date: businessDate, namespace })
  }

  if (isLoading) return <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}><CircularProgress /></Box>

  return (
    <Box sx={{ p: 3, maxWidth: 720 }}>
      <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.5 }}>Admin</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Configure execution context and application settings
      </Typography>

      {saveMsg && <Alert severity="success" sx={{ mb: 2 }}>{saveMsg}</Alert>}
      {saveErr && <Alert severity="error" sx={{ mb: 2 }}>{saveErr}</Alert>}

      {/* Execution Context */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2 }}>Execution Context</Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField
              label="Business Date"
              type="date"
              value={businessDate || (ctx?.business_date ?? '')}
              onChange={e => setBusinessDate(e.target.value)}
              size="small"
              sx={{ maxWidth: 240 }}
              slotProps={{ inputLabel: { shrink: true } }}
              helperText="Used as the reference date for pipeline runs"
            />
            <TextField
              label="Namespace"
              value={namespace || (ctx?.namespace ?? '')}
              onChange={e => setNamespace(e.target.value)}
              size="small"
              sx={{ maxWidth: 320 }}
              helperText="Logical namespace for data isolation"
            />
          </Box>
          <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
            <Button
              variant="contained"
              startIcon={updateMut.isPending ? <CircularProgress size={16} /> : <Save />}
              onClick={handleSave}
              disabled={updateMut.isPending}
            >
              Save Context
            </Button>
          </Box>
        </CardContent>
      </Card>

      {/* About */}
      <Card>
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2 }}>About</Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {[
              { label: 'Application', value: 'Data Studio' },
              { label: 'Version', value: APP_VERSION },
              { label: 'Backend URL', value: BACKEND_URL },
              { label: 'React', value: '18.x' },
              { label: 'Build', value: 'Vite + TypeScript' },
            ].map(({ label, value }) => (
              <Box key={label} sx={{ display: 'flex', gap: 2 }}>
                <Typography variant="body2" color="text.secondary" sx={{ minWidth: 120 }}>
                  {label}
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: label === 'Backend URL' ? 'monospace' : undefined }}>
                  {value}
                </Typography>
              </Box>
            ))}
          </Box>
        </CardContent>
      </Card>
    </Box>
  )
}
