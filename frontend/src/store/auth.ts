import { create } from 'zustand'

interface User {
  username: string
}

interface AuthState {
  user: User | null
  login: (username: string, password: string) => boolean
  logout: () => void
}

const STORAGE_KEY = 'data_studio_user'

function loadUser(): User | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: loadUser(),
  login: (username: string, password: string) => {
    if (!username.trim() || !password.trim()) return false
    const user: User = { username: username.trim() }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user))
    set({ user })
    return true
  },
  logout: () => {
    localStorage.removeItem(STORAGE_KEY)
    set({ user: null })
  },
}))
