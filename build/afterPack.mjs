// 打包后裁剪 better-sqlite3 的预编译产物，只留与目标架构匹配的那一份。
// electron-builder 对 node_modules 只认 files 里的排除项（正向 include 会被丢弃），
// 无法在 yml 里用 ${arch} 表达「保留目标架构那一份」，所以放到 afterPack 里按 context.arch 删除。
// 这样不写死架构：构建机是什么架构（或 --x64 / --arm64 显式指定什么）就留什么。
/* eslint-disable @typescript-eslint/explicit-function-return-type -- 构建钩子是纯 JS，无法标注返回类型 */
import fs from 'node:fs'
import path from 'node:path'

// builder-util 的 Arch 枚举：0 ia32 / 1 x64 / 2 armv7l / 3 arm64 / 4 universal
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

export default async function afterPack(context) {
  const arch = ARCH_NAMES[context.arch]
  // universal 包里 x64 与 arm64 两份都要，不做裁剪
  if (arch == null || arch === 'universal') return

  const resourcesDir =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources'
        )
      : path.join(context.appOutDir, 'resources')
  const prebuildDir = path.join(
    resourcesDir,
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'prebuilds'
  )
  if (!fs.existsSync(prebuildDir)) return

  // linux 的 musl 与 glibc 是两份产物，构建机 libc 未知，两份都留；其它平台精确匹配 <platform>-<arch>.node
  const keep = new Set([`${context.electronPlatformName}-${arch}.node`])
  if (context.electronPlatformName === 'linux') keep.add(`linuxmusl-${arch}.node`)

  const removed = fs
    .readdirSync(prebuildDir)
    .filter((name) => name.endsWith('.node') && !keep.has(name))
  for (const name of removed) {
    fs.rmSync(path.join(prebuildDir, name), { force: true })
  }
  if (removed.length > 0) {
    console.log(`afterPack: better-sqlite3 保留 ${arch} 预编译，删除 ${removed.join(', ')}`)
  }
}
