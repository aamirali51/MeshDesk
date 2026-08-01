import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { useNavigation } from '@/hooks/useNavigation'
import { Dashboard } from '@/pages/Dashboard'
import { Devices } from '@/pages/Devices'
import { Transfers } from '@/pages/Transfers'
import { Activity } from '@/pages/Activity'
import { History } from '@/pages/History'
import { Diagnostics } from '@/pages/Diagnostics'
import { Settings } from '@/pages/Settings'
import { About } from '@/pages/About'
import { AnimatePresence, motion } from 'framer-motion'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { CommandPalette } from '@/components/CommandPalette'
import { NotificationDrawer } from '@/components/NotificationDrawer'
import { QuickConnectModal } from '@/components/QuickConnectModal'
import { DeviceDetailsModal } from '@/components/DeviceDetailsModal'
import { QRCodeModal } from '@/components/QRCodeModal'
import { DropCodeModal } from '@/components/DropCodeModal'
import { OneTimeReceiveModal } from '@/components/OneTimeReceiveModal'
import { TransferApprovalDialog } from '@/components/TransferApprovalDialog'
import { useData } from '@/hooks/useData'

const pages: Record<string, React.FC> = {
  '/dashboard': Dashboard,
  '/devices': Devices,
  '/transfers': Transfers,
  '/activity': Activity,
  '/history': History,
  '/diagnostics': Diagnostics,
  '/settings': Settings,
  '/about': About
}

export function MainLayout() {
  const { currentRoute } = useNavigation()
  const { isQRCodeModalOpen, toggleQRCodeModal } = useData()
  const Page = pages[currentRoute] || Dashboard

  return (
    <div className='relative flex h-screen overflow-hidden bg-background'>
      <Sidebar />
      <div className='flex flex-1 flex-col min-w-0'>
        <TopBar />
        <main className='flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-6'>
          <div className='w-full pb-6'>
            <AnimatePresence mode='wait'>
              <motion.div
                key={currentRoute}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
              >
                <ErrorBoundary>
                  <Page />
                </ErrorBoundary>
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>

      {/* Global Overlays & Modals */}
      <CommandPalette />
      <NotificationDrawer />
      <QuickConnectModal />
      <DeviceDetailsModal />
      <QRCodeModal isOpen={isQRCodeModalOpen} onClose={toggleQRCodeModal} />
      <DropCodeModal />
      <OneTimeReceiveModal />
      <TransferApprovalDialog />
    </div>
  )
}
