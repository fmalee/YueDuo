import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'
import { installApplicationMenu } from './menu'
import { initTheme } from './ipc/theme'
import { requestRendererFlush } from './ipc/session'
import { initActiveLibrary, shutdownLibrary } from './ipc/library'

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

  // 关窗立即保存（方案 §1.8）：拦下 close，等渲染层 session:persist 落定再真正关闭
  let closeFlushed = false
  mainWindow.on('close', (e) => {
    if (closeFlushed || quitFlushed) return
    e.preventDefault()
    void requestRendererFlush().finally(() => {
      closeFlushed = true
      // 验收模式：关窗 flush 已完成，置位后直接 quit，避免 before-quit 二次 flush
      // 掩盖真实关窗耗时；仍会走 will-quit 关库
      if (process.env['YUE_TEST']) {
        quitFlushed = true
        app.quit()
      } else {
        mainWindow.close()
      }
    })
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

// 自动化验收：YUE_USER_DATA 指向临时目录，隔离设置文件与数据库，避免测试写真实用户数据；
// 开发态默认用项目内 .dev/user-data（已 gitignore），与打包版系统默认配置完全分开。
if (process.env['YUE_USER_DATA']) {
  app.setPath('userData', process.env['YUE_USER_DATA'])
} else if (process.env['ELECTRON_RENDERER_URL']) {
  app.setPath('userData', join(__dirname, '../../.dev/user-data'))
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
    installApplicationMenu()
    // 每书库一份数据库（方案 §2.13）：建窗前按设置打开活动书库，渲染层启动即恢复它的会话
    initActiveLibrary()
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

// 退出前落盘会话（方案 §1.8）：before-quit 阻塞等待渲染层 session:persist 完成后再放行
let quitFlushed = false
app.on('before-quit', (e) => {
  // 无窗口（渲染层已随关窗销毁）时无需握手，直接交给 will-quit 关库
  if (quitFlushed || BrowserWindow.getAllWindows().length === 0) return
  e.preventDefault()
  void requestRendererFlush().finally(() => {
    quitFlushed = true
    app.quit()
  })
})

// 退出前关库：WAL 正常 checkpoint，避免残留 -wal/-shm
app.on('will-quit', () => {
  shutdownLibrary()
})
