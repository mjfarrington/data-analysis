import { useEffect, useRef, useState, useCallback } from 'react'

export function useWebSocket<T = unknown>(url: string, enabled = true) {
  const [messages, setMessages] = useState<T[]>([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback(() => {
    if (!enabled) return
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${url}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as T
        setMessages((prev) => [...prev.slice(-499), data])
      } catch (_) {}
    }
    ws.onclose = () => {
      setConnected(false)
      // Reconnect after 3s
      reconnectTimer.current = setTimeout(connect, 3000)
    }
    ws.onerror = () => ws.close()
  }, [url, enabled])

  useEffect(() => {
    connect()
    return () => {
      reconnectTimer.current && clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const clear = useCallback(() => setMessages([]), [])
  const send = useCallback((msg: string) => wsRef.current?.send(msg), [])

  return { messages, connected, clear, send }
}
