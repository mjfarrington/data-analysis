/**
 * AppSettings context — stores user UI preferences in localStorage.
 *
 * Provides: density, diagram edge style.
 * Consumed by Layout (density) and PipelineGraph (edge style).
 */
import { createContext, useContext, useState, useEffect, ReactNode } from 'react'

export type UIDensity = 'comfortable' | 'compact'
export type DiagramEdgeStyle = 'bezier' | 'step' | 'smoothstep' | 'straight'

export interface AppSettings {
  density: UIDensity
  diagramEdgeStyle: DiagramEdgeStyle
}

interface AppSettingsCtx {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => void
}

const STORAGE_KEY = 'app-settings-v1'

const defaults: AppSettings = {
  density: 'comfortable',
  diagramEdgeStyle: 'smoothstep',
}

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaults, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return defaults
}

const Ctx = createContext<AppSettingsCtx>({
  settings: defaults,
  update: () => undefined,
})

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(load)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  const update = (patch: Partial<AppSettings>) =>
    setSettings((s) => ({ ...s, ...patch }))

  return <Ctx.Provider value={{ settings, update }}>{children}</Ctx.Provider>
}

export function useAppSettings() {
  return useContext(Ctx)
}
