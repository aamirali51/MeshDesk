interface DialogResult {
  filePath: string
  filename: string
  fileSize: number
}

export interface UpdateStatusData {
  status:
    | 'checking'
    | 'update_available'
    | 'up_to_date'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'unconfigured'
  version?: string
  message?: string
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  releaseNotes?: string
}

interface Bridge {
  pkg(): Record<string, unknown>
  checkForUpdates: () => Promise<{ status: string; message: string; version?: string }>
  downloadUpdate: () => Promise<{ status: string; message: string }>
  quitAndInstall: () => Promise<void>
  getUpdateChannel: () => Promise<string>
  setUpdateChannel: (channel: 'stable' | 'beta' | 'nightly') => Promise<string>
  onUpdateStatus: (callback: (data: UpdateStatusData) => void) => () => void
  onUpdateDownloaded: (
    callback: (data: { version?: string; message?: string }) => void
  ) => () => void
  restartAndInstall: () => Promise<void>
  applyUpdate: () => Promise<void>
  appAfterUpdate: () => Promise<void>
  startWorker: (specifier: string) => Promise<void>
  onWorkerStdout: (specifier: string, listener: (data: unknown) => void) => () => void
  onWorkerStderr: (specifier: string, listener: (data: unknown) => void) => () => void
  onWorkerIPC: (specifier: string, listener: (data: unknown) => void) => () => void
  onWorkerExit: (specifier: string, listener: (code: number) => void) => () => void
  writeWorkerIPC: (specifier: string, data: Uint8Array) => Promise<void>
  getPathForFile?: (file: File) => string
  openFileDialog: () => Promise<DialogResult | null>
  openFolderDialog: () => Promise<string | null>
  saveTempFile: (filename: string, buffer: ArrayBuffer) => Promise<DialogResult | null>
  openPath: (filePath: string) => Promise<{ error?: string; success?: boolean }>
  showItemInFolder: (filePath: string) => void
  writeClipboard: (data: { text: string }) => Promise<void>
  onClipboardChanged: (callback: (data: { type: string; content: string }) => void) => () => void
  onTrayHidden: (callback: () => void) => () => void
  onDeepLink: (callback: (data: { url: string; code?: string | null }) => void) => () => void
}

declare global {
  interface Window {
    bridge: Bridge
  }
}

export type { Bridge, DialogResult, UpdateStatusData }
