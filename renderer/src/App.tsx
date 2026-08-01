import { ThemeProvider } from '@/hooks/useTheme'
import { NavigationProvider } from '@/hooks/useNavigation'
import { DataProvider } from '@/hooks/useData'
import { ToastProvider } from '@/hooks/useToast'
import { ToastContainer } from '@/components/Toast'
import { MainLayout } from '@/layouts/MainLayout'
import { MotionConfig } from 'framer-motion'

export default function App() {
  return (
    <MotionConfig reducedMotion='user'>
      <ToastProvider>
        <ThemeProvider>
          <NavigationProvider>
            <DataProvider>
              <MainLayout />
              <ToastContainer />
            </DataProvider>
          </NavigationProvider>
        </ThemeProvider>
      </ToastProvider>
    </MotionConfig>
  )
}
