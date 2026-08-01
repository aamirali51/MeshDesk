import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import type { NavRoute } from '@/types'

const ROUTE_ORDER: NavRoute[] = [
  '/dashboard',
  '/devices',
  '/transfers',
  '/activity',
  '/history',
  '/diagnostics',
  '/settings',
  '/about'
]

export const ROUTE_SHORTCUTS: Record<NavRoute, number> = {
  '/dashboard': 1,
  '/devices': 2,
  '/transfers': 3,
  '/activity': 4,
  '/history': 5,
  '/diagnostics': 6,
  '/settings': 7,
  '/about': 8
}

export function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}

/** '⌘3' on macOS, 'Ctrl+3' elsewhere */
export function formatShortcut(route: NavRoute): string {
  return `${isMacPlatform() ? '⌘' : 'Ctrl+'}${ROUTE_SHORTCUTS[route]}`
}

interface NavigationContextValue {
  currentRoute: NavRoute
  navigate: (route: NavRoute) => void
}

const NavigationContext = createContext<NavigationContextValue | null>(null)

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [currentRoute, setCurrentRoute] = useState<NavRoute>('/dashboard')

  const navigate = useCallback((route: NavRoute) => {
    setCurrentRoute(route)
  }, [])

  // Global keyboard shortcuts: ⌘/Ctrl + 1..8 navigates to the matching page.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.altKey || e.shiftKey) return
      const num = Number(e.key)
      if (!Number.isInteger(num) || num < 1 || num > ROUTE_ORDER.length) return
      e.preventDefault()
      navigate(ROUTE_ORDER[num - 1])
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  return (
    <NavigationContext.Provider value={{ currentRoute, navigate }}>
      {children}
    </NavigationContext.Provider>
  )
}

export function useNavigation() {
  const ctx = useContext(NavigationContext)
  if (!ctx) throw new Error('useNavigation must be used within NavigationProvider')
  return ctx
}
