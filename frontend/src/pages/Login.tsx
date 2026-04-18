import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Button, TextField, Typography, Alert,
  InputAdornment, IconButton, alpha,
} from '@mui/material'
import { Visibility, VisibilityOff, HubOutlined } from '@mui/icons-material'
import { useAuthStore } from '../store/auth'

export default function Login() {
  const navigate = useNavigate()
  const login = useAuthStore(s => s.login)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim() || !password.trim()) {
      setError('Username and password are required.')
      return
    }
    const ok = login(username, password)
    if (ok) navigate('/pipelines', { replace: true })
    else setError('Login failed.')
  }

  return (
    <Box sx={{ display: 'flex', height: '100vh', width: '100vw' }}>
      {/* Left panel */}
      <Box
        sx={{
          flex: 1,
          display: { xs: 'none', md: 'flex' },
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(145deg, #0d1117 0%, #161b22 40%, #1c2230 100%)',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          p: 6,
          gap: 3,
        }}
      >
        <Box
          sx={{
            width: 72, height: 72, borderRadius: 3,
            background: 'linear-gradient(135deg, #58a6ff 0%, #3fb950 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 40px rgba(88,166,255,0.3)',
          }}
        >
          <HubOutlined sx={{ fontSize: 40, color: '#fff' }} />
        </Box>
        <Typography variant="h3" fontWeight={700} color="#e6edf3">
          Data Studio
        </Typography>
        <Typography variant="h6" color="#8b949e" textAlign="center" maxWidth={340}>
          Data Pipeline Orchestration
        </Typography>
        <Box sx={{ mt: 4, display: 'flex', flexDirection: 'column', gap: 2, width: '100%', maxWidth: 320 }}>
          {['Build complex ETL pipelines visually', 'Monitor runs in real-time', 'Explore and query your data'].map(t => (
            <Box key={t} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: '#3fb950', flexShrink: 0 }} />
              <Typography color="#8b949e" variant="body2">{t}</Typography>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Right panel */}
      <Box
        sx={{
          width: { xs: '100%', md: 480 },
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
          p: 4,
        }}
      >
        <Box sx={{ width: '100%', maxWidth: 360 }}>
          <Box sx={{ display: { md: 'none' }, mb: 4, textAlign: 'center' }}>
            <HubOutlined sx={{ fontSize: 48, color: 'primary.main' }} />
            <Typography variant="h5" fontWeight={700} mt={1}>Data Studio</Typography>
          </Box>

          <Typography variant="h5" fontWeight={700} mb={0.5}>Sign In</Typography>
          <Typography variant="body2" color="text.secondary" mb={3}>
            Enter your credentials to continue
          </Typography>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField
              label="Username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              fullWidth
              size="small"
            />
            <TextField
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              fullWidth
              size="small"
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => setShowPassword(v => !v)} edge="end">
                      {showPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
            <Button
              type="submit"
              variant="contained"
              fullWidth
              size="large"
              sx={{
                mt: 1,
                background: 'linear-gradient(135deg, #58a6ff 0%, #1f6feb 100%)',
                '&:hover': { background: 'linear-gradient(135deg, #79b8ff 0%, #388bfd 100%)' },
              }}
            >
              Sign In
            </Button>
          </Box>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 3, display: 'block', textAlign: 'center' }}>
            Any non-empty credentials will work in this demo.
          </Typography>
        </Box>
      </Box>
    </Box>
  )
}
