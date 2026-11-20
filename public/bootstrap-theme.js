/**
 * 首帧主题引导（同步执行，先于 Vue 挂载，消除深色启动闪白）。
 * 只负责「窗口显示前的底色」：窗口由 Rust 侧 set_theme 设置 appearance，
 * matchMedia 反映的就是生效主题（system 跟随系统 / light、dark 锁定）。
 * 色值必须与 src/styles/theme.ts 的 bg-1 保持一致（applyTheme 启动后会覆盖全部 token）。
 */
;(function () {
  var dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  var bg = dark ? '#1b1916' : '#ffffff'
  var root = document.documentElement
  root.style.setProperty('--yd-bg-1', bg)
  root.style.background = bg
  root.style.colorScheme = dark ? 'dark' : 'light'
})()
