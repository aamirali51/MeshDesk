'use strict'

// System tray icon. Own module so main.js stays focused on window/worker
// lifecycle. `onQuit` is provided by main.js (it flips the quitting flag
// before calling app.quit()).

const { Tray, Menu, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

let tray = null

function createTrayIcon({ win, onQuit }) {
  if (tray) return
  try {
    const iconFileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    const iconPath = path.join(__dirname, '..', 'build', iconFileName)
    let icon
    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath)
    } else {
      const iconPngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA_SURBVDhPY2AYCjAwMvwfhJpGBhgZGBgYD8f__wxgGMDEyMDDAxBhgGgY0MP4HwzD1wzAMwzAaBwADAM0nEQz6cWjDAAAAAElFTkSuQmCC',
        'base64'
      )
      icon = nativeImage.createFromBuffer(iconPngBuffer)
    }
    tray = new Tray(icon)
    tray.setToolTip('MeshDesk — P2P File Sharing')

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open Application',
        click: () => {
          win.show()
          win.focus()
        }
      },
      { type: 'separator' },
      {
        label: 'Quit Application',
        click: onQuit
      }
    ])

    tray.setContextMenu(contextMenu)
    tray.on('double-click', () => {
      win.show()
      win.focus()
    })
  } catch (err) {
    console.error('Failed to create tray icon:', err.message)
  }
}

module.exports = { createTrayIcon }
