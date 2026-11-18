import {
  app,
  BrowserWindow,
  Menu,
  type BaseWindow,
  type MenuItemConstructorOptions
} from 'electron'
import { readSettings } from './services/settingsStore'
import type { AppMenuCommand, AppMenuPayload, ThemeMode } from '../shared/types'

/** 外观三态（方案 §1.10）：菜单里以单选组呈现，勾选项跟设置落盘值一致 */
const APPEARANCES: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: '跟随系统' },
  { mode: 'light', label: '浅色' },
  { mode: 'dark', label: '深色' }
]

/** 「显示 → 预载数量」可选值 */
const PRELOAD_CHOICES = [4, 8, 10, 15, 20]

/** 菜单命令下发给渲染层：与标签右键菜单复用同一套动作（方案 §3.5） */
function sendMenuCommand(
  command: AppMenuCommand,
  win?: BaseWindow,
  value?: AppMenuPayload['value']
): void {
  const target = win instanceof BrowserWindow ? win : BrowserWindow.getFocusedWindow()
  const payload: AppMenuPayload = value === undefined ? { command } : { command, value }
  target?.webContents.send('app:menuCommand', payload)
}

/**
 * 顶部应用菜单：Electron 默认模板是英文，这里按平台习惯自建中文模板。
 * 系统行为走 role（加速键由 role 自带），label 给中文；未显式给 label 的 role
 * 项由 Electron 回落到英文默认文字，英文即兜底。
 * 「文件」里的保存/关闭类为自定义项：点击后把命令发给渲染层，与标签右键菜单共用实现。
 * 外观 / 预载数量 / 关闭按钮常驻菜单项的勾选状态取启动时的落盘设置。
 */
export function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const name = '悦读'
  const saved = readSettings(app.getPath('userData'))

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
          label: '新建',
          accelerator: 'CmdOrCtrl+N',
          click: (_item, win) => sendMenuCommand('newTab', win)
        },
        {
          label: '打开…',
          accelerator: 'CmdOrCtrl+O',
          click: (_item, win) => sendMenuCommand('open', win)
        },
        {
          label: '速查',
          accelerator: 'CmdOrCtrl+P',
          click: (_item, win) => sendMenuCommand('quickSearch', win)
        },
        {
          label: '书库…',
          click: (_item, win) => sendMenuCommand('chooseLibrary', win)
        },
        { type: 'separator' },
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
        { type: 'separator' },
        {
          label: '查找',
          accelerator: 'CmdOrCtrl+F',
          click: (_item, win) => sendMenuCommand('find', win)
        },
        {
          label: '替换',
          accelerator: 'Ctrl+Cmd+F',
          click: (_item, win) => sendMenuCommand('replace', win)
        },
        { type: 'separator' },
        {
          label: '一键整理',
          click: (_item, win) => sendMenuCommand('tidy', win)
        },
        {
          label: '繁简转换',
          submenu: [
            {
              label: '繁体 → 简体',
              click: (_item, win) => sendMenuCommand('toSimplified', win)
            },
            {
              label: '简体 → 繁体',
              click: (_item, win) => sendMenuCommand('toTraditional', win)
            }
          ]
        },
        {
          label: '全角转半角',
          click: (_item, win) => sendMenuCommand('toHalfwidth', win)
        },
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
        {
          label: '锁定阅读',
          accelerator: 'CmdOrCtrl+L',
          click: (_item, win) => sendMenuCommand('toggleLock', win)
        },
        { type: 'separator' },
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
      submenu: [
        {
          label: '预载数量',
          submenu: PRELOAD_CHOICES.map((count) => ({
            label: String(count),
            type: 'radio' as const,
            checked: saved.preloadCount === count,
            click: (_item, win) => sendMenuCommand('preloadCount', win, count)
          }))
        },
        { type: 'separator' },
        {
          label: '外观',
          submenu: APPEARANCES.map(({ mode, label }) => ({
            label,
            type: 'radio' as const,
            checked: saved.appearance === mode,
            click: (_item, win) => sendMenuCommand('appearance', win, mode)
          }))
        },
        { type: 'separator' },
        {
          label: '显示左侧栏',
          type: 'checkbox',
          checked: true,
          accelerator: 'Shift+Cmd+B',
          click: (item, win) => sendMenuCommand('toggleSidebar', win, item.checked)
        },
        {
          label: '显示右侧栏',
          type: 'checkbox',
          checked: true,
          accelerator: 'Cmd+B',
          click: (item, win) => sendMenuCommand('toggleRightPanel', win, item.checked)
        },
        {
          label: '显示标签关闭按钮',
          type: 'checkbox',
          checked: saved.closeButtonAlwaysVisible,
          click: (item, win) => sendMenuCommand('toggleCloseButton', win, item.checked)
        },
        { type: 'separator' },
        {
          label: '下一个标签',
          accelerator: 'Alt+Cmd+Right',
          click: (_item, win) => sendMenuCommand('nextTab', win)
        },
        {
          label: '上一个标签',
          accelerator: 'Alt+Cmd+Left',
          click: (_item, win) => sendMenuCommand('prevTab', win)
        },
        { type: 'separator' },
        ...(isMac
          ? ([
              { role: 'minimize', label: '最小化' },
              { role: 'zoom', label: '缩放' },
              { type: 'separator' },
              { role: 'front', label: '前置全部窗口' }
            ] as MenuItemConstructorOptions[])
          : ([
              { role: 'minimize', label: '最小化' },
              { role: 'close', label: '关闭' }
            ] as MenuItemConstructorOptions[]))
      ]
    },
    {
      label: '帮助',
      submenu: [{ role: 'about', label: `关于 ${name}` }]
    }
  )

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
