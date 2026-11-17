<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useTabsStore } from '@/stores/tabs'
import { useTabs } from '@/composables/useTabs'

/**
 * 左栏「编辑」页（方案 §1.11，VS Code 资源管理器逻辑）：
 * 顺序与标签页一致，点击切换，dirty 圆点 + 完整名称，右键关闭 / 关闭其他。
 */
const store = useTabsStore()
const { activateTab, closeTab } = useTabs()

interface MenuState {
  x: number
  y: number
  tabId: string
}

const menu = ref<MenuState | null>(null)

// 菜单尺寸用于贴边收敛，避免超出窗口
const MENU_WIDTH = 140
const MENU_HEIGHT = 72

function openMenu(e: MouseEvent, tabId: string): void {
  e.preventDefault()
  // 右键只弹菜单，不切活动标签；菜单动作按 tabId 作用于被右击的那一项
  menu.value = {
    x: Math.min(e.clientX, window.innerWidth - MENU_WIDTH),
    y: Math.min(e.clientY, window.innerHeight - MENU_HEIGHT),
    tabId
  }
}

function dismiss(): void {
  menu.value = null
}

async function closeCurrent(): Promise<void> {
  const id = menu.value?.tabId
  dismiss()
  if (id) await closeTab(id)
}

/** 关闭其他：逐个走 closeTab，dirty 的仍会正常弹确认 */
async function closeOthers(): Promise<void> {
  const id = menu.value?.tabId
  dismiss()
  if (!id) return
  const others = store.tabs.filter((t) => t.id !== id).map((t) => t.id)
  for (const other of others) await closeTab(other)
}

function onWindowPointerDown(e: PointerEvent): void {
  const target = e.target as HTMLElement | null
  if (target?.closest('.context-menu')) return
  dismiss()
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') dismiss()
}

onMounted(() => {
  window.addEventListener('pointerdown', onWindowPointerDown, true)
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('blur', dismiss)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown, true)
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('blur', dismiss)
})
</script>

<template>
  <div class="yd-panel">
    <div class="yd-panel-scroll" @scroll="dismiss">
      <div
        v-for="tab in store.tabs"
        :key="tab.id"
        class="sidebar-item"
        :class="{ active: tab.id === store.activeTabId }"
        :title="tab.title"
        @click="activateTab(tab.id)"
        @contextmenu="openMenu($event, tab.id)"
      >
        <span v-if="tab.dirty" class="dirty-dot" title="未保存"></span>
        <span v-else class="dirty-placeholder"></span>
        <span class="item-title">{{ tab.title }}</span>
      </div>
      <div v-if="store.tabs.length === 0" class="yd-sidebar-empty">无打开的文件</div>
    </div>

    <Teleport to="body">
      <div
        v-if="menu"
        class="context-menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @pointerdown.stop
      >
        <button class="menu-item" @click="closeCurrent">关闭</button>
        <button class="menu-item" @click="closeOthers">关闭其他</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sidebar-item {
  display: flex;
  align-items: center;
  gap: calc(var(--yd-sidebar-gap) / 2);
  height: var(--yd-sidebar-item-height);
  padding: 0 var(--yd-sidebar-padding-x);
  color: var(--yd-text-3);
  font-size: var(--yd-sidebar-font-size);
  white-space: nowrap;
  cursor: pointer;
}
.sidebar-item:hover {
  background: var(--yd-hover-1);
  color: var(--yd-text-2);
}
.sidebar-item.active {
  background: var(--yd-active-1);
  color: var(--yd-text-1);
}
.dirty-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--yd-text-1);
}
/* 无脏标记时占位，保证所有条目文字左对齐 */
.dirty-placeholder {
  flex: none;
  width: 8px;
  height: 8px;
}
.item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.context-menu {
  position: fixed;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  min-width: 120px;
  padding: 4px 0;
  border: 1px solid var(--yd-border-1);
  border-radius: 6px;
  background: var(--yd-bg-2);
  box-shadow: 0 6px 18px rgb(0 0 0 / 18%);
}
.menu-item {
  padding: 5px 14px;
  border: none;
  background: transparent;
  color: var(--yd-text-1);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.menu-item:hover {
  background: var(--yd-hover-1);
}
</style>
