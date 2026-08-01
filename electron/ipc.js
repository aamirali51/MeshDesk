'use strict'

// Renderer-facing IPC handlers: file dialogs, shell integration, temp files,
// and local clipboard. The P2P worker bridge (pear:*) stays in main.js — it
// owns worker lifecycle and the drive.* interception.

const { ipcMain, dialog, shell, clipboard, nativeImage, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

function registerIpcHandlers({ storageDir, getMainWindow, getLabel }) {
  ipcMain.handle('dialog:openFile', async (evt) => {
    console.log(`[Main:${getLabel()}] dialog:openFile opened`)
    const win = BrowserWindow.fromWebContents(evt.sender)
    if (!win) {
      console.log(`[Main:${getLabel()}] dialog:openFile: no window found, aborting`)
      return null
    }
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths?.length) {
      console.log(`[Main:${getLabel()}] dialog:openFile cancelled`)
      return null
    }
    const filePath = result.filePaths[0]
    const stat = fs.statSync(filePath)
    console.log(`[Main:${getLabel()}] dialog:openFile selected`, {
      filePath,
      filename: path.basename(filePath),
      fileSize: stat.size
    })
    return { filePath, filename: path.basename(filePath), fileSize: stat.size }
  })

  ipcMain.handle('dialog:openFolder', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths?.length) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('shell:openPath', async (evt, filePath) => {
    if (!filePath || typeof filePath !== 'string') return { error: 'Invalid path' }
    const err = await shell.openPath(filePath)
    return err ? { error: err } : { success: true }
  })

  ipcMain.handle('shell:showItemInFolder', (evt, filePath) => {
    if (!filePath || typeof filePath !== 'string') return
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('file:saveTemp', async (evt, filename, buffer) => {
    const tempDir = path.join(storageDir, 'p2p-temp')
    fs.mkdirSync(tempDir, { recursive: true })
    const safeName = Date.now() + '-' + filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    const dest = path.join(tempDir, safeName)
    console.log('[Main] file:saveTemp writing', { filename, byteLength: buffer.byteLength, dest })
    fs.writeFileSync(dest, Buffer.from(buffer))
    const stat = fs.statSync(dest)
    console.log('[Main] file:saveTemp done', { filePath: dest, fileSize: stat.size })
    return { filePath: dest, filename, fileSize: stat.size }
  })

  // ─── Clipboard ───────────────────────────────────────────────────────────

  let lastClipboardHash = ''
  let isSelfClipboardWrite = false

  ipcMain.handle('clipboard:read', () => {
    try {
      const text = clipboard.readText()
      const img = clipboard.readImage()
      const image = !img.isEmpty() ? img.toDataURL() : null
      return { text, image }
    } catch (err) {
      return { text: '', image: null }
    }
  })

  ipcMain.handle('clipboard:write', (evt, data) => {
    if (!data) return false
    isSelfClipboardWrite = true
    try {
      if (data.image) {
        const img = nativeImage.createFromDataURL(data.image)
        clipboard.writeImage(img)
        lastClipboardHash = data.image
      } else if (data.text) {
        clipboard.writeText(data.text)
        lastClipboardHash = data.text
      }
    } catch (err) {
      console.warn('[Main] Clipboard write error:', err.message)
    }
    setTimeout(() => {
      isSelfClipboardWrite = false
    }, 2500)
    return true
  })

  setInterval(() => {
    if (isSelfClipboardWrite) return
    try {
      const text = clipboard.readText()
      if (text && text.trim() && text !== lastClipboardHash) {
        lastClipboardHash = text
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('clipboard:changed', { type: 'text', content: text })
        }
      }
    } catch {}
  }, 2000)
}

module.exports = { registerIpcHandlers }
