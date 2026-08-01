const { app, BrowserWindow, ipcMain, Menu, Notification, shell } = require('electron')

const fs = require('fs')
const os = require('os')
const path = require('path')
const child_process = require('child_process')

function fixAsarPath(pathStr) {
  if (
    typeof pathStr === 'string' &&
    pathStr.includes('app.asar') &&
    !pathStr.includes('app.asar.unpacked')
  ) {
    const unpackedPath = pathStr.replace('app.asar', 'app.asar.unpacked')
    if (fs.existsSync(unpackedPath)) {
      return unpackedPath
    }
  }
  return pathStr
}

const originalAccessSync = fs.accessSync
fs.accessSync = function (path, mode) {
  return originalAccessSync.call(fs, fixAsarPath(path), mode)
}

const originalChmodSync = fs.chmodSync
fs.chmodSync = function (path, mode) {
  return originalChmodSync.call(fs, fixAsarPath(path), mode)
}

const originalSpawn = child_process.spawn
child_process.spawn = function (command, args, options) {
  return originalSpawn.call(child_process, fixAsarPath(command), args, options)
}

const PearRuntime = require('pear-runtime')
const FramedStream = require('framed-stream')

const { isMac, isLinux, isWindows } = require('which-runtime')
const { command, flag } = require('paparam')
const LanDiscovery = require('./lan-discovery')
const pkg = require('../package.json')
const { name, productName, version, upgrade } = pkg
const {
  createRequest,
  createResponse,
  parseMessage,
  METHODS,
  EVENTS
} = require('../src/shared/protocol.js')
const {
  startWebDAVServer,
  stopWebDAVServer,
  mountWindowsDrive,
  unmountWindowsDrive,
  getDriveStatus,
  updateDrivePermissions,
  updateCatalogData,
  setFileCreatedCallback
} = require('./webdav')
const { setupUpdater } = require('./updater')
const { registerIpcHandlers } = require('./ipc')
const { createTrayIcon } = require('./tray')

const protocol = name
const mainWorkerSpecifier = '/workers/main.js'

const workers = new Map()

// UDP advertiser for noise-key LAN discovery. The Bare worker has no UDP
// stack, so main owns the socket: it advertises the worker's swarm public key
// and forwards discovered keys back via LAN_DISCOVERY_PEER.
const lanDiscovery = new LanDiscovery({
  log: (...args) => console.log(...args)
})

const appName = productName ?? name

const cmd = command(
  appName,
  flag('--storage <dir>', 'pass custom storage to pear-runtime'),
  flag('--no-updates', 'start without OTA updates'),
  flag('--no-sandbox', 'start without Chromium sandbox').hide(),
  flag('--allow-multiple-instances', 'allow multiple app instances').hide(),
  flag(
    '--test-peer',
    'local multi-instance testing: dedicated profile, no single-instance lock'
  ).hide()
)

const APP_FLAGS = new Set([
  '--no-updates',
  '--allow-multiple-instances',
  '--storage',
  '--test-peer'
])
let argStart = 1
while (argStart < process.argv.length) {
  const a = process.argv[argStart]
  if (!a.startsWith('-')) {
    argStart++
    continue
  }
  if (APP_FLAGS.has(a)) break
  argStart++
}
cmd.parse(process.argv.slice(argStart))

const pearStore = cmd.flags.storage
const updates = cmd.flags.updates
const allowMultipleInstances = cmd.flags.allowMultipleInstances
// Dev-only: run a second instance side-by-side with its own identity for
// local P2P testing. Implies skipping the single-instance lock and using a
// dedicated userData directory.
const testPeer = cmd.flags.testPeer

function getAppPath() {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  if (isWindows) return process.execPath
  return path.join(process.resourcesPath, '..', '..')
}

function getStorageDir() {
  if (pearStore) return path.resolve(pearStore)
  // Local multi-instance testing: a dedicated profile next to the project
  // root gives this instance its own corestore, hence its own cryptographic
  // identity, without touching real user data.
  if (testPeer) return path.join(process.cwd(), '.p2p-test-profile')
  const appPath = getAppPath()
  if (appPath === null) return path.join(os.tmpdir(), 'pear', appName)
  const isSnap = !!process.env.SNAP_USER_COMMON
  const linuxConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return isMac
    ? path.join(os.homedir(), 'Library', 'Application Support', appName)
    : isLinux
      ? isSnap
        ? path.join(process.env.SNAP_USER_COMMON, appName)
        : path.join(linuxConfigHome, appName)
      : path.join(os.homedir(), 'AppData', 'Roaming', appName)
}

const storageDir = getStorageDir()
app.setPath('userData', storageDir)

function getLabel() {
  if (cmd.flags.storage) return path.basename(cmd.flags.storage)
  if (testPeer) return 'test-peer'
  return 'default'
}

ipcMain.on('pkg', (evt) => {
  evt.returnValue = pkg
})

function sendToAll(name, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(name, data)
  }
}

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier)
  const appPath = getAppPath()

  const extension = isLinux ? '.AppImage' : isMac ? '.app' : '.exe'

  const workerScript = fixAsarPath(require.resolve('..' + specifier))
  const worker = PearRuntime.run(workerScript, [
    storageDir,
    appPath,
    updates,
    version,
    upgrade,
    productName + extension
  ])
  const pipe = new FramedStream(worker)

  setFileCreatedCallback((item) => {
    try {
      console.log('[Main] WebDAV file created, broadcasting to P2P worker:', item.filename)
      const reqStr = createRequest(METHODS.DRIVE_BROADCAST_FILE, item)
      pipe.write(Buffer.from(reqStr))
    } catch (err) {
      console.error('[Main] Failed to broadcast WebDAV file to worker:', err.message)
    }
  })

  function sendWorkerStdout(data) {
    const label = getLabel()
    console.log(`[Worker:${label} stdout] ${data.toString().trim()}`)
    sendToAll('pear:worker:stdout:' + specifier, data)
  }
  function sendWorkerStderr(data) {
    const label = getLabel()
    console.error(`[Worker:${label} stderr] ${data.toString().trim()}`)
    sendToAll('pear:worker:stderr:' + specifier, data)
  }
  function onWorkerData(data) {
    try {
      const msg = parseMessage(data)
      if (msg && msg.type === 'response' && msg.result && Array.isArray(msg.result)) {
        if (msg.result.length > 0 && msg.result[0].status) {
          updateCatalogData({ transfers: msg.result })
        } else if (msg.result.length > 0 && (msg.result[0].path || msg.result[0].name)) {
          updateCatalogData({ sharedFiles: msg.result })
        }
      }
      if (msg && msg.type === 'event' && msg.event === EVENTS.LAN_DISCOVERY_KEY && msg.data) {
        lanDiscovery.setSelf(msg.data)
        lanDiscovery.start((ann) => {
          try {
            pipe.write(Buffer.from(createRequest(METHODS.LAN_DISCOVERY_PEER, { key: ann.key })))
          } catch (err) {
            console.warn('[Main] Failed to forward LAN peer to worker:', err.message)
          }
        })
      }
    } catch {}
    sendToAll('pear:worker:ipc:' + specifier, data)
  }
  function onBeforeQuit() {
    pipe.destroy()
  }
  function safeParseIPC(raw) {
    try {
      if (!raw) return null
      if (typeof raw === 'string') return JSON.parse(raw)
      if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf8'))
      if (raw instanceof Uint8Array || raw instanceof ArrayBuffer)
        return JSON.parse(Buffer.from(raw).toString('utf8'))
      if (typeof raw === 'object' && raw.type === 'Buffer' && Array.isArray(raw.data)) {
        return JSON.parse(Buffer.from(raw.data).toString('utf8'))
      }
      if (typeof raw === 'object') return raw
      return null
    } catch {
      return null
    }
  }

  ipcMain.handle('pear:worker:writeIPC:' + specifier, async (evt, data) => {
    const msg = safeParseIPC(data)
    if (
      msg &&
      msg.type === 'request' &&
      typeof msg.method === 'string' &&
      msg.method.startsWith('drive.')
    ) {
      let result = null
      let error = null
      try {
        if (msg.method === 'drive.getStatus') {
          result = getDriveStatus()
        } else if (msg.method === 'drive.mount') {
          result = await mountWindowsDrive(msg.params?.driveLetter || 'Z')
        } else if (msg.method === 'drive.unmount') {
          result = await unmountWindowsDrive(msg.params?.driveLetter || 'Z')
        } else if (msg.method === 'drive.updatePermissions') {
          result = updateDrivePermissions(msg.params)
        }
      } catch (err) {
        error = err.message
      }
      const response = createResponse(msg.id, result, error)
      const encoded = new TextEncoder().encode(response)
      sendToAll('pear:worker:ipc:' + specifier, encoded)
      return true
    }

    const ts = new Date().toISOString().slice(11, 23)
    const label = getLabel()
    console.log(
      `[Main:${label} ${ts}] forwarding IPC to worker (${data.byteLength || data.length} bytes)`
    )
    return pipe.write(Buffer.from(data))
  })
  workers.set(specifier, pipe)
  pipe.on('data', onWorkerData)
  worker.stdout.on('data', sendWorkerStdout)
  worker.stderr.on('data', sendWorkerStderr)
  worker.once('exit', (code) => {
    lanDiscovery.stop()
    app.removeListener('before-quit', onBeforeQuit)
    ipcMain.removeHandler('pear:worker:writeIPC:' + specifier)
    pipe.removeListener('data', onWorkerData)
    worker.stdout.removeListener('data', sendWorkerStdout)
    worker.stderr.removeListener('data', sendWorkerStderr)
    sendToAll('pear:worker:exit:' + specifier, code)
    workers.delete(specifier)
  })
  app.on('before-quit', onBeforeQuit)
  return pipe
}

let mainWindow = null
let isQuitting = false
let trayHintShown = false

app.on('before-quit', () => {
  isQuitting = true
})

async function createWindow() {
  const instLabel = getLabel()
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      // The app hides to the tray on close; without this, Chromium throttles
      // hidden windows' JS timers to ~1/min, so the 4s diagnostics poll (and
      // any other renderer timers) would stall while the window is hidden.
      backgroundThrottling: false,
      devTools: !!process.env.PEAR_DEV_SERVER_URL
    }
  })

  mainWindow = win
  createTrayIcon({
    win,
    onQuit: () => {
      isQuitting = true
      app.quit()
    }
  })

  win.on('close', (evt) => {
    if (!isQuitting) {
      evt.preventDefault()
      win.hide()
      if (!trayHintShown) {
        trayHintShown = true
        try {
          new Notification({
            title: appName,
            body: 'MeshDesk is still running in the system tray.'
          }).show()
        } catch {}
        win.webContents.send('app:tray-hidden')
      }
    }
  })

  win.on('closed', () => console.log(`[Main:${instLabel}] window closed`))
  win.webContents.on('destroyed', () => console.log(`[Main:${instLabel}] webContents destroyed`))
  win.webContents.on('crashed', () => console.log(`[Main:${instLabel}] webContents crashed`))
  win.webContents.on('render-process-gone', (e, details) =>
    console.log(`[Main:${instLabel}] render-process-gone:`, JSON.stringify(details))
  )
  win.webContents.on('did-finish-load', () => console.log(`[Main:${instLabel}] did-finish-load`))
  win.webContents.on('dom-ready', () => console.log(`[Main:${instLabel}] dom-ready`))
  win.webContents.on('did-fail-load', (e, code, desc) =>
    console.log(`[Main:${instLabel}] did-fail-load: ${code} ${desc}`)
  )

  // Forward renderer console.log/warn/error to the main-process terminal so
  // we can read [Renderer] / [App] / [ThemeProvider] logs in the dev:p2p output.
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const tag = ['verbose', 'info', 'warn', 'error'][level] || 'log'
    const src = sourceId ? sourceId.replace(/.*\/renderer\//, '') : ''
    const fn = level >= 3 ? console.error : level >= 2 ? console.warn : console.log
    fn(`[Renderer:${instLabel}][${tag}] ${message}  (${src}:${line})`)
  })

  const devServerUrl = process.env.PEAR_DEV_SERVER_URL

  if (devServerUrl) {
    await win.loadURL(devServerUrl)
    win.webContents.openDevTools()
  } else {
    // Build a real application menu (roles restore native shortcuts like
    // Cmd+C/V on macOS and Ctrl+C/V on Windows).
    const template = [
      ...(isMac
        ? [
            {
              label: appName,
              submenu: [
                { role: 'about', label: `About ${appName}` },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
              ]
            }
          ]
        : []),
      {
        label: 'File',
        submenu: [{ role: 'close', label: 'Close Window' }]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      {
        label: 'Window',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ role: 'front' }] : [])]
      },
      {
        label: 'Help',
        submenu: [
          {
            label: `About ${appName}`,
            click: () => win.webContents.send('app:deep-link', { url: '' })
          }
        ]
      }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
    win.webContents.on('devtools-opened', () => {
      win.webContents.closeDevTools()
    })
    const distPath = path.join(__dirname, '..', 'renderer', 'dist', 'index.html')
    const srcPath = path.join(__dirname, '..', 'renderer', 'index.html')

    if (fs.existsSync(distPath)) {
      await win.loadFile(distPath)
    } else {
      await win.loadFile(srcPath)
    }
  }

  getWorker(mainWorkerSpecifier)
}

ipcMain.handle('pear:startWorker', (evt, filename) => {
  getWorker(filename)
  return true
})

function handleDeepLink(url) {
  const win = mainWindow
  if (win) {
    win.show()
    win.focus()
  }
  try {
    const u = new URL(url)
    const code = u.searchParams.get('code')
    if (win) win.webContents.send('app:deep-link', { url, code })
  } catch {
    if (win) win.webContents.send('app:deep-link', { url })
  }
}

app.setAsDefaultProtocolClient(protocol)

app.on('open-url', (evt, url) => {
  evt.preventDefault()
  handleDeepLink(url)
})

if (!allowMultipleInstances && !testPeer) {
  const lock = app.requestSingleInstanceLock()

  if (!lock) {
    app.quit()
  }
}

{
  app.on('second-instance', (evt, args) => {
    const url = args.find((arg) => arg.startsWith(protocol + '://'))
    if (url) handleDeepLink(url)
  })

  app.whenReady().then(() => {
    // CSP is owned by index.html (dev meta) and the vite build transform
    // (production meta). No header override needed.

    // WebDAV ("Drive") is intentionally NOT started at boot: it exposes an
    // unauthenticated local server (RW/DELETE on the sync dir) and no UI
    // consumes it. Opt-in only — startWebDAVServer() must be called
    // explicitly when the Drive feature is built and permission-gated.

    createWindow().catch((err) => {
      console.error('Failed to create window:', err)
      app.quit()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch((err) => {
          console.error('Failed to create window:', err)
        })
      }
    })
  })

  app.on('window-all-closed', () => {
    console.log(`[Main:${getLabel()}] window-all-closed, quitting`)
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('will-quit', () => {
    console.log(`[Main:${getLabel()}] will-quit`)
    lanDiscovery.stop()
    stopWebDAVServer()
  })
}

// ─── Module Wiring ───────────────────────────────────────────────────────────

// Auto-updater (electron-updater) and renderer IPC (dialogs/shell/clipboard)
// live in sibling modules; main.js wires them with its shared state.
setupUpdater({ sendToAll, version, appName, enabled: updates !== false })
registerIpcHandlers({ storageDir, getMainWindow: () => mainWindow, getLabel })
