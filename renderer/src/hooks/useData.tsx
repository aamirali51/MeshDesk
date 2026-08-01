import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode
} from 'react'
import type {
  Device,
  ActivityItem,
  NetworkDiagnostics,
  NotificationItem,
  UserIdentity,
  PendingShare,
  TransferRecord,
  NavRoute
} from '@/types'
import { METHODS, EVENTS } from '@/types/protocol'
import { call, on } from '@/lib/ipc'
import { useToast } from '@/hooks/useToast'
import { useNavigation } from '@/hooks/useNavigation'

const EMPTY_IDENTITY: UserIdentity = {
  id: '',
  name: 'Local Node',
  os: '',
  publicKey: '',
  pairingCode: ''
}

interface DataContextValue {
  identity: UserIdentity
  devices: Device[]
  activity: ActivityItem[]
  notifications: NotificationItem[]
  diagnostics: NetworkDiagnostics
  pendingOffers: IncomingOffer[]
  transfers: TransferRecord[]
  isCommandPaletteOpen: boolean
  isQuickConnectOpen: boolean
  isNotificationDrawerOpen: boolean
  isQRCodeModalOpen: boolean
  isDropCodeModalOpen: boolean
  pendingShares: PendingShare[]
  isOneTimeReceiveOpen: boolean
  inspectingDevice: Device | null

  // Actions
  toggleCommandPalette: () => void
  toggleQuickConnect: () => void
  toggleNotificationDrawer: () => void
  toggleQRCodeModal: () => void
  toggleDropCodeModal: () => void
  toggleOneTimeReceiveModal: () => void
  cancelShareCode: (id: string) => Promise<unknown>
  extendShareExpiration: (id: string, addMinutes: number) => Promise<unknown>
  setInspectingDevice: (device: Device | null) => void
  toggleTrustDevice: (deviceId: string) => void
  toggleFavoriteDevice: (deviceId: string) => void
  renameDevice: (deviceId: string, newName: string) => void
  removeDevice: (deviceId: string) => void
  getPairingCode: () => Promise<{ code: string; id: string }>
  pairWithCode: (code: string) => Promise<unknown>
  claimFileWithCode: (code: string) => Promise<unknown>
  createDropCode: (
    file: { filePath: string; filename: string; fileSize: number },
    expirationPreset: string
  ) => Promise<unknown>
  acceptTransfer: (transferId: string) => void
  declineTransfer: (transferId: string) => void
  pauseTransfer: (transferId: string) => void
  resumeTransfer: (transferId: string) => void
  cancelTransfer: (transferId: string) => void
  retryTransfer: (transferId: string) => void
  clearTransfers: () => void
  sendFileToDevice: (device: Device) => Promise<unknown>
  sendFilePath: (device: Device, file: File) => Promise<unknown>
  markAllNotificationsRead: () => void
  clearNotifications: () => void
  clearHistory: () => void
  addNotification: (title: string, description: string, type?: NotificationItem['type']) => void
}

export interface IncomingOffer {
  transferId: string
  filename: string
  fileSize: number
  fileType?: string
  senderIdentity?: { name?: string; id?: string }
}

const DataContext = createContext<DataContextValue | null>(null)

export function DataProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast()
  const { currentRoute, navigate } = useNavigation()
  // Where the user was before an auto-shift to /transfers, so completion can
  // return them. Refs keep the subscription effect stable across route changes.
  const returnRouteRef = useRef<NavRoute | null>(null)
  const currentRouteRef = useRef<NavRoute>(currentRoute)
  useEffect(() => {
    currentRouteRef.current = currentRoute
  }, [currentRoute])
  const [identity, setIdentity] = useState<UserIdentity>(EMPTY_IDENTITY)
  const [devices, setDevices] = useState<Device[]>([])
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [diagnostics, setDiagnostics] = useState<NetworkDiagnostics>({
    natType: null,
    relayStatus: 'Disabled',
    dhtNodes: null,
    avgLatencyMs: null,
    packetLossPercent: null,
    noiseProtocol: 'Noise_XX_25519_ChaChaPoly_BLAKE2b',
    bandwidthMbps: null,
    systemCpuUsage: null,
    systemRamUsage: null,
    uptimeMs: 0,
    bytesReceived: 0,
    bytesSent: 0
  })
  const [pendingOffers, setPendingOffers] = useState<IncomingOffer[]>([])
  const [transfers, setTransfers] = useState<TransferRecord[]>([])

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [isQuickConnectOpen, setIsQuickConnectOpen] = useState(false)
  const [isNotificationDrawerOpen, setIsNotificationDrawerOpen] = useState(false)
  const [isQRCodeModalOpen, setIsQRCodeModalOpen] = useState(false)
  const [isDropCodeModalOpen, setIsDropCodeModalOpen] = useState(false)
  const [pendingShares, setPendingShares] = useState<PendingShare[]>([])
  const [isOneTimeReceiveOpen, setIsOneTimeReceiveOpen] = useState(false)
  const [inspectingDevice, setInspectingDevice] = useState<Device | null>(null)

  const toggleOneTimeReceiveModal = useCallback(() => {
    setIsOneTimeReceiveOpen((prev) => !prev)
  }, [])

  const refreshPendingShares = useCallback(() => {
    call(METHODS.FILES_LIST_PENDING)
      .then((res: any) => {
        if (Array.isArray(res)) setPendingShares(res)
      })
      .catch(() => {})
  }, [])

  const cancelShareCode = useCallback((id: string) => {
    return call(METHODS.FILES_CANCEL_CODE, { id })
  }, [])

  const extendShareExpiration = useCallback((id: string, addMinutes: number) => {
    return call(METHODS.FILES_EXTEND_EXPIRATION, { id, addMinutes })
  }, [])

  // Sync state strictly with Backend Managers via IPC
  useEffect(() => {
    call(METHODS.DEVICES_GET_IDENTITY, null)
      .then((res: any) => {
        if (res && res.id) setIdentity(res)
      })
      .catch(() => {})

    call(METHODS.DEVICES_LIST, null)
      .then((res: any) => {
        if (Array.isArray(res)) setDevices(res)
      })
      .catch(() => {})

    call(METHODS.HISTORY_LIST, null)
      .then((res: any) => {
        if (Array.isArray(res)) setActivity(res)
      })
      .catch(() => {})

    // Live activity: refresh whenever a transfer or session lifecycle event lands.
    const refreshActivity = () => {
      call(METHODS.HISTORY_LIST, null)
        .then((res: any) => {
          if (Array.isArray(res)) setActivity(res)
        })
        .catch(() => {})
    }

    call(METHODS.DIAGNOSTICS_GET, null)
      .then((res: any) => {
        if (res && typeof res === 'object') setDiagnostics(res)
      })
      .catch(() => {})

    call(METHODS.NOTIFICATIONS_LIST, null)
      .then((res: any) => {
        if (Array.isArray(res)) setNotifications(res)
      })
      .catch(() => {})

    call(METHODS.TRANSFERS_LIST, null)
      .then((res: any) => {
        if (Array.isArray(res)) setTransfers(res)
      })
      .catch(() => {})

    // Real diagnostics: refresh on connection changes and on a short poll so
    // peer counts, throughput, and uptime stay live without fabrication.
    const refreshDiagnostics = () => {
      call(METHODS.DIAGNOSTICS_GET, null)
        .then((res: any) => {
          if (res && typeof res === 'object') setDiagnostics(res)
        })
        .catch(() => {})
    }
    const diagTimer = setInterval(refreshDiagnostics, 4000)
    const unsubConnChanged = on(EVENTS.CONNECTION_CHANGED, refreshDiagnostics)

    // Subscribe to live Backend Manager Events
    const unsub1 = on(EVENTS.DEVICE_UPDATED, () => {
      call(METHODS.DEVICES_LIST, null)
        .then((res: any) => {
          if (Array.isArray(res)) setDevices(res)
        })
        .catch(() => {})
    })

    const unsub4 = on(EVENTS.NOTIFICATION_RECEIVED, (notif: any) => {
      if (notif) setNotifications((prev) => [notif, ...prev])
    })

    const unsubOffer = on(EVENTS.TRANSFER_OFFER_RECEIVED, (offer: any) => {
      if (offer && offer.transferId) {
        setPendingOffers((prev) =>
          prev.some((o) => o.transferId === offer.transferId) ? prev : [...prev, offer]
        )
        // Shift the receiver to the Transfers page so the incoming file is
        // visible (with its approval dialog) the moment it arrives; remember
        // where they came from so completion can shift them back.
        if (currentRouteRef.current !== '/transfers')
          returnRouteRef.current = currentRouteRef.current
        navigate('/transfers')
      }
    })

    // Live pending shares: refresh whenever a share lifecycle event lands.
    const unsubShareUpdated = on(EVENTS.PENDING_SHARE_UPDATED, refreshPendingShares)
    const unsubShareExpired = on(EVENTS.PENDING_SHARE_EXPIRED, refreshPendingShares)
    const unsubShareClaimed = on(EVENTS.PENDING_SHARE_CLAIMED, refreshPendingShares)
    // A DROP claim rejected by the sender's device (expired / already used /
    // revoked) surfaces asynchronously; toast it so the receiver gets feedback
    // even after the receive dialog has closed and they are on Transfers.
    const unsubClaimFailed = on(EVENTS.PENDING_SHARE_CLAIM_FAILED, (d: any) => {
      if (d && d.code) {
        toast.error('Claim Failed', `${d.code} — ${d.error || 'Share expired or invalid code'}`)
      }
    })
    refreshPendingShares()

    const unsubStarted = on(EVENTS.TRANSFER_STARTED, (t: any) => {
      if (t && t.status === 'active')
        setPendingOffers((prev) => prev.filter((o) => o.transferId !== t.id))
    })

    const unsubCancelled = on(EVENTS.TRANSFER_CANCELLED, (t: any) => {
      if (t && t.id) setPendingOffers((prev) => prev.filter((o) => o.transferId !== t.id))
    })

    const upsertTransfer = (t: any) => {
      if (!t || !t.id) return
      setTransfers((prev) => {
        const idx = prev.findIndex((x) => x.id === t.id)
        if (idx === -1) return [t, ...prev]
        const next = [...prev]
        next[idx] = { ...next[idx], ...t }
        return next
      })
    }
    const unsubTQueued = on(EVENTS.TRANSFER_QUEUED, upsertTransfer)
    const unsubTStarted = on(EVENTS.TRANSFER_STARTED, upsertTransfer)
    const unsubTPaused = on(EVENTS.TRANSFER_PAUSED, upsertTransfer)
    const unsubTResumed = on(EVENTS.TRANSFER_RESUMED, upsertTransfer)
    const unsubTCancelled = on(EVENTS.TRANSFER_CANCELLED, upsertTransfer)
    const unsubTFailed = on(EVENTS.TRANSFER_FAILED, upsertTransfer)
    const unsubTCompleted = on(EVENTS.TRANSFER_COMPLETED, (t: any) => {
      upsertTransfer(t)
      refreshActivity()
      // The transfer is done: shift the user back to where they were before
      // the auto-navigation, but only if they haven't manually moved on.
      const back = returnRouteRef.current
      if (back) {
        returnRouteRef.current = null
        if (currentRouteRef.current === '/transfers') navigate(back)
      }
    })
    const unsubTProgress = on(EVENTS.TRANSFER_PROGRESS, (d: any) => {
      if (d && d.id) {
        setTransfers((prev) => prev.map((t) => (t.id === d.id ? { ...t, ...d } : t)))
      }
    })

    const unsubTray = window.bridge?.onTrayHidden?.(() => {
      toast.info(
        'MeshDesk is Still Running',
        'The app stays active in the system tray. Click the tray icon to restore it.'
      )
    })
    const unsubDeepLink = window.bridge?.onDeepLink?.((data) => {
      if (data.code) {
        toast.info(
          'Deep Link Received',
          `Pairing code ${data.code} ready. Open Quick Connect to use it.`
        )
      }
    })
    // A new version finished downloading in the background: non-intrusive
    // toast with a one-click restart to apply it.
    const unsubUpdateDownloaded = window.bridge?.onUpdateDownloaded?.((d: any) => {
      toast.info(
        'New update ready',
        d?.message || `Version ${d?.version || ''} has been downloaded and is ready to install.`,
        {
          actions: [{ label: 'Restart Now', onClick: () => window.bridge?.restartAndInstall?.() }],
          durationMs: 60000
        }
      )
    })

    return () => {
      clearInterval(diagTimer)
      unsubConnChanged()
      unsub1()
      unsub4()
      unsubOffer()
      unsubShareUpdated()
      unsubShareExpired()
      unsubShareClaimed()
      unsubStarted()
      unsubCancelled()
      unsubTQueued()
      unsubTStarted()
      unsubTPaused()
      unsubTResumed()
      unsubTCancelled()
      unsubTFailed()
      unsubTCompleted()
      unsubTProgress()
      unsubShareUpdated()
      unsubShareExpired()
      unsubShareClaimed()
      unsubClaimFailed()
      unsubTray?.()
      unsubDeepLink?.()
      unsubUpdateDownloaded?.()
    }
  }, [navigate, refreshPendingShares])

  // Keyboard shortcuts listener (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setIsCommandPaletteOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const toggleCommandPalette = useCallback(() => {
    setIsCommandPaletteOpen((prev) => !prev)
  }, [])

  const toggleQuickConnect = useCallback(() => {
    setIsQuickConnectOpen((prev) => !prev)
  }, [])

  const toggleNotificationDrawer = useCallback(() => {
    setIsNotificationDrawerOpen((prev) => !prev)
  }, [])

  const toggleQRCodeModal = useCallback(() => {
    setIsQRCodeModalOpen((prev) => !prev)
  }, [])

  const toggleDropCodeModal = useCallback(() => {
    setIsDropCodeModalOpen((prev) => !prev)
  }, [])

  const toggleTrustDevice = useCallback(
    async (deviceId: string) => {
      const prev = devices.find((d) => d.id === deviceId)
      if (!prev) return
      const nextTrusted = !prev.isTrusted
      setDevices((list) =>
        list.map((d) => (d.id === deviceId ? { ...d, isTrusted: nextTrusted } : d))
      )
      try {
        await call(METHODS.DEVICES_TRUST, { id: deviceId })
        toast.success('Device Trust Updated', 'Trust preference saved.')
      } catch (err: any) {
        setDevices((list) =>
          list.map((d) => (d.id === deviceId ? { ...d, isTrusted: prev.isTrusted } : d))
        )
        toast.error('Update Failed', err?.message || 'Could not update trust preference.')
      }
    },
    [devices, toast]
  )

  const toggleFavoriteDevice = useCallback(
    async (deviceId: string) => {
      const prev = devices.find((d) => d.id === deviceId)
      if (!prev) return
      const nextFavorite = !prev.isFavorite
      setDevices((list) =>
        list.map((d) => (d.id === deviceId ? { ...d, isFavorite: nextFavorite } : d))
      )
      try {
        await call(METHODS.DEVICES_FAVORITE, { id: deviceId })
      } catch (err: any) {
        setDevices((list) =>
          list.map((d) => (d.id === deviceId ? { ...d, isFavorite: prev.isFavorite } : d))
        )
        toast.error('Update Failed', err?.message || 'Could not update favorite.')
      }
    },
    [devices, toast]
  )

  const renameDevice = useCallback(
    async (deviceId: string, newName: string) => {
      const trimmed = newName.trim()
      if (!trimmed) return
      const prev = devices.find((d) => d.id === deviceId)
      setDevices((list) => list.map((d) => (d.id === deviceId ? { ...d, name: trimmed } : d)))
      try {
        await call(METHODS.DEVICES_RENAME, { id: deviceId, name: trimmed })
        toast.success('Device Renamed', `Name updated to "${trimmed}"`)
      } catch (err: any) {
        if (prev) {
          setDevices((list) => list.map((d) => (d.id === deviceId ? { ...d, name: prev.name } : d)))
        }
        toast.error('Rename Failed', err?.message || 'Could not rename the device.')
      }
    },
    [devices, toast]
  )

  const removeDevice = useCallback(
    async (deviceId: string) => {
      const prev = devices
      setDevices((list) => list.filter((d) => d.id !== deviceId))
      try {
        await call(METHODS.DEVICES_REMOVE, { id: deviceId })
        toast.info('Device Removed', 'Device deleted from storage.')
      } catch (err: any) {
        setDevices(prev)
        toast.error('Remove Failed', err?.message || 'Could not remove the device.')
      }
    },
    [devices, toast]
  )

  const getPairingCode = useCallback(async () => {
    return call(METHODS.DEVICES_GET_CODE) as Promise<{ code: string; id: string }>
  }, [])

  const pairWithCode = useCallback((code: string) => {
    return call(METHODS.DEVICES_PAIR_CODE, { code })
  }, [])

  const claimFileWithCode = useCallback((code: string) => {
    return call(METHODS.FILES_CLAIM_CODE, { code })
  }, [])

  const createDropCode = useCallback(
    (file: { filePath: string; filename: string; fileSize: number }, expirationPreset: string) => {
      return call(METHODS.FILES_CREATE_CODE, {
        filePath: file.filePath,
        filename: file.filename,
        fileSize: file.fileSize,
        expirationPreset
      })
    },
    []
  )

  const acceptTransfer = useCallback(
    (transferId: string) => {
      call(METHODS.TRANSFERS_ACCEPT, { id: transferId })
        .then(() => {
          setPendingOffers((prev) => prev.filter((o) => o.transferId !== transferId))
          toast.success('Transfer Started', 'Incoming transfer approved.')
        })
        .catch((err: any) => {
          toast.error(
            'Could Not Start Transfer',
            err?.message || 'The remote device did not accept the transfer.'
          )
        })
    },
    [toast]
  )

  const declineTransfer = useCallback((transferId: string) => {
    call(METHODS.TRANSFERS_DECLINE, { id: transferId })
      .then(() => {
        setPendingOffers((prev) => prev.filter((o) => o.transferId !== transferId))
      })
      .catch(() => {})
  }, [])

  const pauseTransfer = useCallback((transferId: string) => {
    call(METHODS.TRANSFERS_PAUSE, { id: transferId }).catch(() => {})
  }, [])

  const resumeTransfer = useCallback((transferId: string) => {
    call(METHODS.TRANSFERS_RESUME, { id: transferId }).catch(() => {})
  }, [])

  const cancelTransfer = useCallback((transferId: string) => {
    call(METHODS.TRANSFERS_CANCEL, { id: transferId }).catch(() => {})
  }, [])

  const retryTransfer = useCallback((transferId: string) => {
    call(METHODS.TRANSFERS_RETRY, { id: transferId }).catch(() => {})
  }, [])

  const clearTransfers = useCallback(() => {
    call(METHODS.TRANSFERS_CLEAR, null)
      .then(() => {
        setTransfers((prev) =>
          prev.filter(
            (t) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(t.status)
          )
        )
      })
      .catch(() => {})
  }, [])

  const sendFileToDevice = useCallback(
    async (device: Device) => {
      if (typeof window === 'undefined' || !window.bridge?.openFileDialog) {
        throw new Error('File dialogs are only available in the desktop app')
      }
      const file = await window.bridge.openFileDialog()
      if (!file) return null
      const result = await call(METHODS.TRANSFERS_START, {
        filename: file.filename,
        filePath: file.filePath,
        fileSize: file.fileSize,
        peerId: device.publicKey || device.id,
        peerName: device.name
      })
      // Shift to the Transfers page the moment a send is started; remember
      // where we came from so completion can shift the user back.
      if (currentRouteRef.current !== '/transfers') returnRouteRef.current = currentRouteRef.current
      navigate('/transfers')
      return result
    },
    [navigate]
  )

  const sendFilePath = useCallback(
    async (device: Device, file: File) => {
      if (!window.bridge?.getPathForFile) {
        throw new Error('File drag & drop is only available in the desktop app')
      }
      const filePath = window.bridge.getPathForFile(file)
      if (!filePath) throw new Error('Could not resolve the dropped file path')
      const result = await call(METHODS.TRANSFERS_START, {
        filename: file.name,
        filePath,
        fileSize: file.size,
        peerId: device.publicKey || device.id,
        peerName: device.name
      })
      // Shift to the Transfers page the moment a send is started; remember
      // where we came from so completion can shift the user back.
      if (currentRouteRef.current !== '/transfers') returnRouteRef.current = currentRouteRef.current
      navigate('/transfers')
      return result
    },
    [navigate]
  )

  const addNotification = useCallback(
    (title: string, description: string, type: NotificationItem['type'] = 'info') => {
      const item: NotificationItem = {
        id: `notif-${Date.now()}`,
        title,
        description,
        type,
        timestamp: new Date().toISOString(),
        read: false
      }
      setNotifications((prev) => [item, ...prev])
    },
    []
  )

  const markAllNotificationsRead = useCallback(() => {
    call(METHODS.NOTIFICATIONS_MARK_READ, null).catch(() => {})
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
  }, [])

  const clearNotifications = useCallback(() => {
    call(METHODS.NOTIFICATIONS_CLEAR, null).catch(() => {})
    setNotifications([])
  }, [])

  const clearHistory = useCallback(async () => {
    try {
      await call(METHODS.HISTORY_CLEAR, null)
      const res = await call(METHODS.HISTORY_LIST, null)
      if (Array.isArray(res)) setActivity(res)
      toast.success('History Cleared', 'Transfer and session records were removed.')
    } catch (err: any) {
      toast.error('Clear Failed', err?.message || 'Could not clear history.')
    }
  }, [toast])

  return (
    <DataContext.Provider
      value={{
        identity,
        devices,
        activity,
        notifications,
        diagnostics,
        pendingOffers,
        transfers,
        isCommandPaletteOpen,
        isQuickConnectOpen,
        isNotificationDrawerOpen,
        isQRCodeModalOpen,
        isDropCodeModalOpen,
        pendingShares,
        isOneTimeReceiveOpen,
        inspectingDevice,
        toggleCommandPalette,
        toggleQuickConnect,
        toggleNotificationDrawer,
        toggleQRCodeModal,
        toggleDropCodeModal,
        toggleOneTimeReceiveModal,
        cancelShareCode,
        extendShareExpiration,
        setInspectingDevice,
        toggleTrustDevice,
        toggleFavoriteDevice,
        renameDevice,
        removeDevice,
        getPairingCode,
        pairWithCode,
        claimFileWithCode,
        createDropCode,
        acceptTransfer,
        declineTransfer,
        pauseTransfer,
        resumeTransfer,
        cancelTransfer,
        retryTransfer,
        clearTransfers,
        sendFileToDevice,
        sendFilePath,
        markAllNotificationsRead,
        clearNotifications,
        clearHistory,
        addNotification
      }}
    >
      {children}
    </DataContext.Provider>
  )
}

export function useData() {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within DataProvider')
  return ctx
}
