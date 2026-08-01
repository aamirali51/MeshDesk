'use strict'

// Auto-updater module (electron-updater) with a GitHub Releases feed.
// Configure the repository via the GH_UPDATE_OWNER / GH_UPDATE_REPO env vars
// (or hardcode them below). Releases must be produced by electron-builder so
// the metadata assets electron-updater expects (latest.yml etc.) exist in the
// GitHub release. Pear OTA (the `upgrade` field) remains the worker-side
// update channel and is owned by main.js / pear-runtime, not this module.

const { app, ipcMain } = require('electron')

// GitHub Releases feed. Read from the environment so the repo can be set
// without code changes; when empty the updater honestly reports itself as
// "unconfigured" instead of erroring against a bogus endpoint.
const GH_OWNER = process.env.GH_UPDATE_OWNER || ''
const GH_REPO = process.env.GH_UPDATE_REPO || ''
const isFeedConfigured = Boolean(GH_OWNER && GH_REPO)

let autoUpdater = null
try {
  autoUpdater = require('electron-updater').autoUpdater
} catch (err) {
  console.warn('[Main] Warning: electron-updater module could not be required:', err?.message)
}

let updateChannel = 'beta'
let downloadedUpdatePath = null

function broadcastUpdateStatus(sendToAll, data) {
  sendToAll('updater:status', data)
}

function runInstallerAndQuit() {
  if (process.platform === 'win32' && downloadedUpdatePath) {
    try {
      const { spawn } = require('child_process')
      console.log('[AutoUpdater] Spawning installer silently:', downloadedUpdatePath)
      const child = spawn(downloadedUpdatePath, ['/SILENT', '/SUPPRESSMSGBOXES'], {
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      app.quit()
      return
    } catch (err) {
      console.error('[AutoUpdater] Failed to spawn installer silently, falling back:', err.message)
    }
  }

  if (autoUpdater) {
    autoUpdater.quitAndInstall(false, true)
  } else {
    app.quit()
  }
}

function setupUpdater({ sendToAll, version, appName, enabled = true }) {
  if (autoUpdater) {
    if (isFeedConfigured) {
      autoUpdater.setFeedURL({ provider: 'github', owner: GH_OWNER, repo: GH_REPO })
    } else {
      console.warn(
        '[AutoUpdater] GitHub update feed not configured — set GH_UPDATE_OWNER and GH_UPDATE_REPO'
      )
    }
    // NOTE: feed comes from setFeedURL above; autoDownload makes the
    // background check download silently with no user interaction.
    autoUpdater.autoDownload = true
    autoUpdater.allowPrerelease = true
    autoUpdater.allowDowngrade = false

    autoUpdater.on('checking-for-update', () => {
      console.log('[AutoUpdater] Checking for updates...')
      broadcastUpdateStatus(sendToAll, { status: 'checking', message: 'Checking for updates...' })
    })

    autoUpdater.on('update-available', (info) => {
      console.log('[AutoUpdater] Update available:', info.version)
      broadcastUpdateStatus(sendToAll, {
        status: 'update_available',
        version: info.version,
        releaseNotes: info.releaseNotes,
        message: `Update v${info.version} is available. Downloading in background...`
      })
    })

    autoUpdater.on('update-not-available', (info) => {
      console.log('[AutoUpdater] Up to date:', info?.version || version)
      broadcastUpdateStatus(sendToAll, {
        status: 'up_to_date',
        version: info?.version || version,
        message: 'Application is already up to date.'
      })
    })

    autoUpdater.on('error', (err) => {
      console.error('[AutoUpdater] Error:', err?.message || err)
      broadcastUpdateStatus(sendToAll, {
        status: 'error',
        message: err?.message || 'Failed to check for updates'
      })
    })

    autoUpdater.on('download-progress', (progressObj) => {
      const percent = Math.round(progressObj.percent || 0)
      const speed = progressObj.bytesPerSecond || 0
      const transferred = progressObj.transferred || 0
      const total = progressObj.total || 0
      broadcastUpdateStatus(sendToAll, {
        status: 'downloading',
        percent,
        bytesPerSecond: speed,
        transferred,
        total,
        message: `Downloading update... ${percent}%`
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      console.log('[AutoUpdater] Update downloaded:', info.version)
      downloadedUpdatePath = info?.downloadedFile || null
      broadcastUpdateStatus(sendToAll, {
        status: 'downloaded',
        version: info.version,
        message: `Update v${info.version} ready! Restart to install.`
      })
      // Non-intrusive renderer notification (UPDATE_DOWNLOADED): the UI shows
      // a toast with a "Restart Now" action — no blocking native dialog.
      sendToAll('updater:downloaded', {
        version: info.version,
        message: `Update v${info.version} ready! Restart to install.`
      })
    })
  }

  // Background update check on startup: non-blocking, silent background
  // download (autoDownload). Only meaningful in a packaged build with a
  // configured feed; --no-updates disables it entirely.
  if (enabled && isFeedConfigured && app.isPackaged && autoUpdater) {
    app.whenReady().then(() => {
      setTimeout(() => {
        console.log('[AutoUpdater] Background update check...')
        autoUpdater.checkForUpdates().catch((err) => {
          console.warn('[AutoUpdater] Background check failed:', err?.message || err)
        })
      }, 5000)
    })
  } else {
    console.log(
      `[AutoUpdater] Background update check skipped (${enabled ? 'feed unconfigured or dev/unpackaged' : 'disabled via --no-updates'})`
    )
  }

  ipcMain.handle('updater:check', async () => {
    if (!autoUpdater || !isFeedConfigured) {
      return { status: 'unconfigured', message: 'Updates are not configured for this build.' }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result) {
        return { status: 'up_to_date', message: 'Application is already up to date.' }
      }
      const info = result.updateInfo
      if (info && info.version !== version) {
        return {
          status: 'update_available',
          version: info.version,
          message: `Update v${info.version} is available!`
        }
      }
      return { status: 'up_to_date', message: 'Application is already up to date.' }
    } catch (err) {
      console.error('[Main] Manual update check error:', err?.message)
      return { status: 'error', message: err?.message || 'Check for updates failed.' }
    }
  })

  ipcMain.handle('updater:download', async () => {
    if (!autoUpdater || !isFeedConfigured) {
      return { status: 'error', message: 'Updates are not configured for this build.' }
    }
    try {
      await autoUpdater.downloadUpdate()
      return { status: 'downloading', message: 'Download started...' }
    } catch (err) {
      return { status: 'error', message: err?.message || 'Download failed.' }
    }
  })

  ipcMain.handle('updater:quitAndInstall', () => {
    runInstallerAndQuit()
  })

  // RESTART_AND_INSTALL: renderer-triggered install (the toast's
  // "Restart Now" action and the Settings page button).
  ipcMain.handle('updater:restartAndInstall', () => {
    runInstallerAndQuit()
  })

  ipcMain.handle('updater:getChannel', () => updateChannel)

  ipcMain.handle('updater:setChannel', (evt, channel) => {
    if (['stable', 'beta', 'nightly'].includes(channel)) {
      updateChannel = channel
      if (autoUpdater) {
        autoUpdater.allowPrerelease = channel !== 'stable'
        if (channel === 'nightly') {
          autoUpdater.channel = 'nightly'
        } else if (channel === 'beta') {
          autoUpdater.channel = 'beta'
        } else {
          autoUpdater.channel = 'latest'
        }
      }
    }
    return updateChannel
  })

  ipcMain.handle('app:afterUpdate', () => {
    runInstallerAndQuit()
  })
}

module.exports = { setupUpdater }
