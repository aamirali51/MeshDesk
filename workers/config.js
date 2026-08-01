'use strict'

// Worker configuration derived from the Bare process argv.

const path = require('bare-path')
const os = require('bare-os')

function createConfig() {
  const updaterConfig = {
    dir: Bare.argv[2],
    app: Bare.argv[3],
    updates: Bare.argv[4] !== 'false',
    version: Bare.argv[5],
    upgrade: Bare.argv[6],
    name: Bare.argv[7]
  }

  const STORAGE_DIR = path.join(updaterConfig.dir, 'p2p')

  function getDeviceName() {
    try {
      const hostname = os.hostname()
      const platform = os.platform()
      const map = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', android: 'Android' }

      let name = hostname || 'Unknown Device'
      const match = (STORAGE_DIR || '').match(/p2p-instance-(\d+)/)
      if (match) {
        name = `${name} (Instance ${match[1]})`
      }
      return { name, os: map[platform] || platform }
    } catch {
      return { name: 'Unknown Device', os: 'Unknown' }
    }
  }

  return { updaterConfig, STORAGE_DIR, getDeviceName }
}

module.exports = { createConfig }
