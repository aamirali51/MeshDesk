import { useState, useEffect } from 'react'
import {
  LayoutDashboard,
  Monitor,
  ArrowLeftRight,
  History,
  Activity,
  Settings,
  Info,
  ChevronLeft,
  ChevronRight,
  Zap,
  ShieldCheck,
  UserCheck,
  Gauge,
  Copy,
  QrCode
} from 'lucide-react'
import { useNavigation, formatShortcut } from '@/hooks/useNavigation'
import { useData } from '@/hooks/useData'
import { ContextMenu } from '@/components/ContextMenu'
import type { NavRoute } from '@/types'

export function Sidebar() {
  const { currentRoute, navigate } = useNavigation()
  const { toggleQuickConnect, identity, transfers, toggleQRCodeModal } = useData()
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [profileMenu, setProfileMenu] = useState<{ x: number; y: number } | null>(null)

  // Toggle collapse via Cmd+B / Ctrl+B
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        setIsCollapsed((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Auto-collapse to icons-only when the window is too narrow for labels
  // (below lg). The user can still toggle manually between breakpoint changes.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const apply = () => setIsCollapsed(!mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  const activeTransfers = transfers.filter(
    (t) => t.status === 'active' || t.status === 'queued'
  ).length

  const navItems: {
    label: string
    route: NavRoute
    icon: React.ReactNode
    badge?: string
  }[] = [
    {
      label: 'Dashboard',
      route: '/dashboard',
      icon: <LayoutDashboard className='h-4 w-4' />
    },
    { label: 'Devices', route: '/devices', icon: <Monitor className='h-4 w-4' /> },
    {
      label: 'Transfers',
      route: '/transfers',
      icon: <ArrowLeftRight className='h-4 w-4' />,
      badge: activeTransfers > 0 ? String(activeTransfers) : undefined
    },
    { label: 'Activity', route: '/activity', icon: <Activity className='h-4 w-4' /> },
    { label: 'History', route: '/history', icon: <History className='h-4 w-4' /> },
    { label: 'Diagnostics', route: '/diagnostics', icon: <Gauge className='h-4 w-4' /> },
    { label: 'Settings', route: '/settings', icon: <Settings className='h-4 w-4' /> },
    { label: 'About', route: '/about', icon: <Info className='h-4 w-4' /> }
  ]

  return (
    <aside
      className={`hidden md:flex flex-col border-r border-border/60 bg-sidebar/95 backdrop-blur-2xl select-none z-20 transition-all duration-300 ${
        isCollapsed ? 'w-16' : 'w-60 md:w-64'
      }`}
    >
      {/* Sidebar Header / Brand */}
      <div className='flex h-16 items-center justify-between border-b border-border/40 px-4'>
        <div className='flex items-center gap-3'>
          <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-primary via-indigo-500 to-purple-600 shadow-md'>
            <ArrowLeftRight className='h-5 w-5 text-white' />
          </div>
          {!isCollapsed && (
            <div className='flex flex-col'>
              <span className='flex items-center gap-1.5 text-sm font-black tracking-tight text-foreground'>
                MeshDesk
              </span>
              <span className='font-mono text-[10px] text-muted-foreground'>P2P File Sharing</span>
            </div>
          )}
        </div>

        {!isCollapsed && (
          <button
            onClick={() => setIsCollapsed(true)}
            className='rounded-lg p-1 text-muted-foreground transition-all hover:bg-accent hover:text-foreground'
            title='Collapse Sidebar (⌘B)'
          >
            <ChevronLeft className='h-4 w-4' />
          </button>
        )}
      </div>

      {/* Quick Action Button */}
      <div className='border-b border-border/30 p-3'>
        <button
          onClick={toggleQuickConnect}
          className={`flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-xs font-bold text-white shadow-sm transition-all hover:bg-primary/90 ${
            isCollapsed ? 'px-0' : 'px-3'
          }`}
          title='Quick Connect to Device Code'
        >
          <Zap className='h-4 w-4 shrink-0' />
          {!isCollapsed && <span>Quick Connect</span>}
        </button>
      </div>

      {/* Navigation List */}
      <nav className='flex-1 space-y-1 overflow-y-auto p-2'>
        {navItems.map((item) => {
          const isActive = currentRoute === item.route
          return (
            <button
              key={item.route}
              onClick={() => navigate(item.route)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-xs font-semibold transition-all group ${
                isActive
                  ? 'bg-primary/15 text-primary border border-primary/30 shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              } ${isCollapsed ? 'justify-center px-0' : ''}`}
              title={isCollapsed ? item.label : undefined}
            >
              <div
                className={`shrink-0 ${isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'}`}
              >
                {item.icon}
              </div>

              {!isCollapsed && <span className='flex-1 truncate text-left'>{item.label}</span>}

              {!isCollapsed && item.badge && (
                <span className='rounded-full bg-status-online/20 px-2 py-0.5 font-mono text-[9px] font-extrabold text-status-online'>
                  {item.badge}
                </span>
              )}

              {!isCollapsed && !item.badge && (
                <span className='font-mono text-[9px] text-muted-foreground/60 group-hover:text-muted-foreground'>
                  {formatShortcut(item.route)}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {/* Expand Button for Collapsed Mode */}
      {isCollapsed && (
        <div className='flex justify-center border-t border-border/40 p-2'>
          <button
            onClick={() => setIsCollapsed(false)}
            className='rounded-lg p-2 text-muted-foreground transition-all hover:bg-accent hover:text-foreground'
            title='Expand Sidebar (⌘B)'
          >
            <ChevronRight className='h-4 w-4' />
          </button>
        </div>
      )}

      {/* Footer User & P2P Node Status */}
      {!isCollapsed && (
        <div className='border-t border-border/40 bg-muted/20 p-3 text-xs'>
          <button
            onClick={(e) => setProfileMenu({ x: e.clientX, y: e.clientY })}
            className='flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left transition-colors hover:bg-accent/60'
            aria-label='Open profile menu'
          >
            <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary'>
              <UserCheck className='h-4 w-4' />
            </div>
            <div className='flex min-w-0 flex-col'>
              <span className='truncate text-[11px] font-bold text-foreground'>
                {identity.name}
              </span>
              <span className='flex items-center gap-1 font-mono text-[10px] text-status-online'>
                <ShieldCheck className='h-3 w-3' /> P2P Node Active
              </span>
            </div>
          </button>
        </div>
      )}

      {profileMenu && (
        <ContextMenu
          x={profileMenu.x}
          y={profileMenu.y}
          onClose={() => setProfileMenu(null)}
          items={[
            {
              label: 'Copy Device Address',
              icon: <Copy className='h-3.5 w-3.5' />,
              onClick: () => navigator.clipboard.writeText(identity.pairingCode || '')
            },
            {
              label: 'Show Pairing QR',
              icon: <QrCode className='h-3.5 w-3.5' />,
              onClick: toggleQRCodeModal
            },
            { separator: true },
            {
              label: 'Settings',
              icon: <Settings className='h-3.5 w-3.5' />,
              onClick: () => navigate('/settings')
            },
            {
              label: 'About MeshDesk',
              icon: <Info className='h-3.5 w-3.5' />,
              onClick: () => navigate('/about')
            }
          ]}
        />
      )}
    </aside>
  )
}
