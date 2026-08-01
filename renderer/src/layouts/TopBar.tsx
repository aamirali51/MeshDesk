import { Search, Bell, Moon, Sun, User, ShieldCheck, QrCode } from 'lucide-react'
import { useNavigation } from '@/hooks/useNavigation'
import { useData } from '@/hooks/useData'
import { useTheme } from '@/hooks/useTheme'
import { ContextMenu } from '@/components/ContextMenu'
import { useState } from 'react'
import type { NavRoute } from '@/types'

export function TopBar() {
  const { currentRoute, navigate } = useNavigation()
  const {
    toggleCommandPalette,
    toggleNotificationDrawer,
    toggleQRCodeModal,
    notifications,
    diagnostics,
    identity
  } = useData()
  const { theme, toggle } = useTheme()
  const [profileMenu, setProfileMenu] = useState<{ x: number; y: number } | null>(null)

  const pageTitles: Record<NavRoute, string> = {
    '/dashboard': 'Dashboard',
    '/devices': 'Devices',
    '/transfers': 'Transfers',
    '/activity': 'Activity',
    '/history': 'History',
    '/diagnostics': 'Diagnostics',
    '/settings': 'Settings',
    '/about': 'About'
  }

  const unreadCount = notifications.filter((n) => !n.read).length

  return (
    <header className='flex h-16 items-center gap-3 md:gap-4 border-b border-border/60 bg-background/80 px-4 md:px-6 z-10 select-none backdrop-blur-2xl'>
      {/* Title */}
      <div className='flex min-w-0 items-center gap-3'>
        <h1 className='truncate text-base font-extrabold tracking-tight text-foreground'>
          {pageTitles[currentRoute] || 'MeshDesk'}
        </h1>
        <div className='hidden md:flex items-center gap-1.5 rounded-full border border-status-online/30 bg-status-online/15 px-2.5 py-0.5'>
          <span className='h-2 w-2 rounded-full bg-status-online' />
          <span className='font-mono text-[10px] font-bold text-status-online'>
            {diagnostics.avgLatencyMs != null ? `${diagnostics.avgLatencyMs}ms` : '—'} · Encrypted
          </span>
        </div>
      </div>

      {/* Global Command Palette Trigger (Cmd+K) — hidden on small screens (⌘K still works) */}
      <div className='hidden md:block mx-auto max-w-md flex-1'>
        <button
          onClick={toggleCommandPalette}
          className='group flex w-full items-center gap-2.5 rounded-xl border border-border/60 bg-card/40 px-3.5 py-1.5 text-xs text-muted-foreground shadow-sm transition-all hover:bg-card/80'
        >
          <Search className='h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground' />
          <span className='flex-1 text-left'>Search devices, transfers, actions...</span>
          <span className='rounded-md border border-border/60 bg-muted/60 px-2 py-0.5 font-mono text-[10px] font-bold text-muted-foreground'>
            ⌘K
          </span>
        </button>
      </div>

      {/* Action Controls */}
      <div className='flex items-center gap-2'>
        {/* QR Code Button */}
        <button
          onClick={toggleQRCodeModal}
          className='rounded-xl border border-border/60 bg-card/40 p-2 text-muted-foreground transition-all hover:bg-accent hover:text-foreground'
          title='Device Pairing QR Code'
        >
          <QrCode className='h-4 w-4' />
        </button>

        {/* Notifications */}
        <button
          onClick={toggleNotificationDrawer}
          className='relative rounded-xl border border-border/60 bg-card/40 p-2 text-muted-foreground transition-all hover:bg-accent hover:text-foreground'
          title='Notifications'
        >
          <Bell className='h-4 w-4' />
          {unreadCount > 0 && (
            <span className='absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-white shadow-sm'>
              {unreadCount}
            </span>
          )}
        </button>

        {/* Theme Toggle */}
        <button
          onClick={toggle}
          className='rounded-xl border border-border/60 bg-card/40 p-2 text-muted-foreground transition-all hover:bg-accent hover:text-foreground'
          title='Toggle Theme'
        >
          {theme === 'dark' ? <Sun className='h-4 w-4' /> : <Moon className='h-4 w-4' />}
        </button>

        {/* Profile Pill */}
        <button
          onClick={(e) => setProfileMenu({ x: e.clientX, y: e.clientY })}
          className='flex items-center gap-2 border-l border-border/40 pl-2'
          aria-label='Open profile menu'
        >
          <div className='flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 text-white shadow-sm'>
            <User className='h-4 w-4' />
          </div>
        </button>
      </div>

      {profileMenu && (
        <ContextMenu
          x={profileMenu.x}
          y={profileMenu.y}
          onClose={() => setProfileMenu(null)}
          items={[
            {
              label: 'Copy Device Address',
              icon: <ShieldCheck className='h-3.5 w-3.5' />,
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
              icon: <Moon className='h-3.5 w-3.5' />,
              onClick: () => navigate('/settings')
            }
          ]}
        />
      )}
    </header>
  )
}
