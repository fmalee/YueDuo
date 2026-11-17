import { BrowserWindow, Menu, type BaseWindow, type MenuItemConstructorOptions } from 'electron'
import type { AppMenuCommand } from '../shared/types'

/** 保存/关闭类命令下发给渲染层：与标签右键菜单复用同一套动作（方案 §3.5） */
function sendMenuCommand(command: AppMenuCommand, win?: BaseWindow): void {
  const target = win instanceof BrowserWindow ? win : BrowserWindow.getFocusedWindow()
  target?.webContents.send('app:menuCommand', command)
}

/**
 * 顶部应用菜单：Electron 默认模板是英文，这里按平台习惯自建中文模板。
 * 系统行为走 role（加速键由 role 自带），label 给中文；未显式给 label 的 role
 * 项由 Electron 回落到英文默认文字，英文即兜底。
 * 「文件」里的保存/关闭类为自定义项：点击后把命令发给渲染层，与标签右键菜单共用实现。
 */
export function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const name = '悦读'

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: name,
      submenu: [
        { role: 'about', label: `关于 ${name}` },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${name}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${name}` }
      ]
    })
  }

  template.push(
    {
      label: '文件',
      submenu: [
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: (_item, win) => sendMenuCommand('save', win)
        },
        {
          label: '关闭标签',
          accelerator: 'CmdOrCtrl+W',
          click: (_item, win) => sendMenuCommand('closeTab', win)
        },
        {
          label: '关闭其他标签',
          click: (_item, win) => sendMenuCommand('closeOthers', win)
        },
        {
          label: '关闭全部标签',
          click: (_item, win) => sendMenuCommand('closeAll', win)
        },
        { type: 'separator' },
        isMac
          ? { role: 'close', label: '关闭窗口', accelerator: 'CmdOrCtrl+Shift+W' }
          : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤消' },
        { role: 'redo', label: '恢复' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        ...(isMac
          ? [{ role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' } as MenuItemConstructorOptions]
          : []),
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' },
        ...(isMac
          ? [
              { type: 'separator' } as MenuItemConstructorOptions,
              {
                label: '朗读',
                submenu: [
                  { role: 'startSpeaking', label: '开始朗读' },
                  { role: 'stopSpeaking', label: '停止朗读' }
                ] as MenuItemConstructorOptions[]
              }
            ]
          : [])
      ]
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '切换开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: isMac
        ? [
            { role: 'minimize', label: '最小化' },
            { role: 'zoom', label: '缩放' },
            { type: 'separator' },
            { role: 'front', label: '前置全部窗口' }
          ]
        : [
            { role: 'minimize', label: '最小化' },
            { role: 'close', label: '关闭' }
          ]
    },
    {
      label: '帮助',
      submenu: [{ role: 'about', label: `关于 ${name}` }]
    }
  )

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
