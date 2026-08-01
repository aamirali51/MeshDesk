const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')
const pkg = require('../package.json')

function calculateSha512(filePath) {
  const fileBuffer = fs.readFileSync(filePath)
  return crypto.createHash('sha512').update(fileBuffer).digest('base64')
}

async function buildCleanRelease() {
  console.log(`[Build] Starting clean release packaging for v${pkg.version}...`)

  const projectRoot = path.join(__dirname, '..')
  const finalReleaseDir = path.join(projectRoot, 'out', 'release')

  // Clean old release folder
  await fsp.rm(finalReleaseDir, { recursive: true, force: true }).catch(() => {})
  await fsp.mkdir(finalReleaseDir, { recursive: true })

  // Build Vite and run electron-forge make
  console.log('[Build] Compiling frontend & packaging app with Electron Forge...')
  execSync('npm run make', { cwd: projectRoot, stdio: 'inherit' })

  const packagedFolder = path.join(projectRoot, 'out', 'MeshDesk-win32-x64')
  let primaryInstallerName = 'MeshDeskSetup.exe'

  // Compile Inno Setup installer on Windows
  if (process.platform === 'win32') {
    console.log('[Build] Packaging with Inno Setup...')
    const standardPaths = [
      path.join(
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'Inno Setup 7',
        'ISCC.exe'
      ),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Inno Setup 7', 'ISCC.exe'),
      path.join(
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'Inno Setup 6',
        'ISCC.exe'
      ),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe')
    ]
    let isccPath = null
    try {
      const stdout = execSync('where ISCC', { stdio: 'pipe' }).toString().trim()
      const paths = stdout.split('\r\n').filter(Boolean)
      if (paths.length > 0) isccPath = paths[0]
    } catch {}

    if (!isccPath) {
      for (const p of standardPaths) {
        if (fs.existsSync(p)) {
          isccPath = p
          break
        }
      }
    }

    if (isccPath) {
      console.log(`[Build] Found Inno Setup compiler at: ${isccPath}`)
      execSync(
        `"${isccPath}" /DAppVersion="${pkg.version}" /O"${finalReleaseDir}" "${path.join(projectRoot, 'setup.iss')}"`,
        { stdio: 'inherit' }
      )
      console.log('[Build] Inno Setup installer compiled successfully.')
    } else {
      console.warn(
        '[Build WARNING] Inno Setup (ISCC.exe) was not found on your system. Please install Inno Setup 6 to generate the .exe installer.'
      )
      primaryInstallerName = null
    }
  }

  // 3. Create Zip Distribution
  const zipName = `MeshDesk-v${pkg.version}-win32-x64.zip`
  const zipPath = path.join(finalReleaseDir, zipName)

  if (fs.existsSync(packagedFolder)) {
    console.log('[Build] Creating distribution ZIP...')
    const psZipCmd = `Compress-Archive -Path '${packagedFolder}\\*' -DestinationPath '${zipPath}' -Force`
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psZipCmd}"`, {
      stdio: 'inherit'
    })
  }

  // 4. Generate latest.yml & beta.yml for electron-updater
  const targetFileForUpdate = primaryInstallerName || zipName
  const targetFilePath = path.join(finalReleaseDir, targetFileForUpdate)

  if (fs.existsSync(targetFilePath)) {
    const stat = await fsp.stat(targetFilePath)
    const sha512 = calculateSha512(targetFilePath)
    const releaseDate = new Date().toISOString()

    const ymlContent = `version: ${pkg.version}
files:
  - url: ${targetFileForUpdate}
    sha512: ${sha512}
    size: ${stat.size}
path: ${targetFileForUpdate}
sha512: ${sha512}
releaseDate: '${releaseDate}'
`
    await fsp.writeFile(path.join(finalReleaseDir, 'latest.yml'), ymlContent, 'utf-8')
    await fsp.writeFile(path.join(finalReleaseDir, 'beta.yml'), ymlContent, 'utf-8')
    console.log('[Build] Generated latest.yml and beta.yml for auto-updater.')
  }

  console.log(`\n==================================================`)
  console.log(`✅ RELEASE BUILD COMPLETE (v${pkg.version})`)
  console.log(`📁 Release Folder: ${finalReleaseDir}`)
  console.log(`==================================================\n`)
}

buildCleanRelease().catch((err) => {
  console.error('[Build Failed]', err)
  process.exit(1)
})
