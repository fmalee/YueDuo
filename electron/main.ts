import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'
import { initTheme } from './ipc/theme'
import { closeDatabase, initDatabase } from './services/database'

// 自动化验收：YUE_DEBUG=1 时开 CDP 远程调试端口
if (process.env['YUE_DEBUG']) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true, // contextBridge 唯一通道，渲染层禁触 Node API
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    // YUE_TEST=1：自动化验收模式，窗口保持不显示不抢前台
    if (!process.env['YUE_TEST']) {
      mainWindow.show()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  // 注意：Electron 45 在 macOS 从 node_modules 的 Electron.app 启动时 app.isPackaged=true，
  // is.dev 会误判为 false，故以 ELECTRON_RENDERER_URL 是否存在为判定准绳
  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = process.env['ELECTRON_RENDERER_URL'] + (process.env['YUE_DEBUG'] ? '?auto=1' : '')
    mainWindow.loadURL(url)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// 自动化验收：YUE_USER_DATA 指向临时目录，隔离设置文件与数据库，避免测试写真实用户数据
if (process.env['YUE_USER_DATA']) {
  app.setPath('userData', process.env['YUE_USER_DATA'])
}

// 单实例锁：重复启动时聚焦既有窗口后退出，避免 dev 验收互相干扰
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.yueduo.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerIpcHandlers()
    initDatabase(app.getPath('userData'))
    initTheme()
    createWindow()

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 退出前关库：WAL 正常 checkpoint，避免残留 -wal/-shm
app.on('will-quit', () => {
  closeDatabase()
})
