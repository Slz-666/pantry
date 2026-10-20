<script setup>
/**
 * 应用外壳：手机 = 顶栏 + 底部 4 tab + 悬浮录入；桌面 = 左侧栏（导航 + 位置树）+ 右侧内容。
 * 同一套 DOM，靠 styles.css 的 768px 断点切换显示，不写 JS 判断屏幕宽度
 * （JS 判断会在窗口缩放时漏更新，也更容易出现「手机上出现桌面样式」）。
 */
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { store, loadLocations, locationName, pushToast } from './store.js';
import { get } from './api.js';
import { flushQueue, startSync } from './offline/sync.js';

const route = useRoute();
const router = useRouter();

const isLogin = computed(() => route.name === 'login');

const TITLES = {
  home: '家里有什么',
  location: '位置',
  item: '物品详情',
  add: '记一笔',
  shopping: '购物清单',
  alerts: '提醒',
  settings: '我的',
};

const title = computed(() => {
  if (route.name === 'location') {
    return route.params.id ? locationName(route.params.id) || '位置' : '全部位置';
  }
  return TITLES[route.name] || '家里有什么';
});

const tabs = [
  { name: 'home', label: '首页', icon: '🏠', to: '/' },
  { name: 'shopping', label: '清单', icon: '🧺', to: '/shopping' },
  { name: 'alerts', label: '提醒', icon: '🔔', to: '/alerts' },
  { name: 'settings', label: '我的', icon: '👤', to: '/settings' },
];

function isActive(name) {
  return route.name === name;
}

function isLocationActive(id) {
  return route.name === 'location' && String(route.params.id ?? '') === String(id);
}

async function ensureSession() {
  if (!store.token) return;
  try {
    await loadLocations(get);
  } catch {
    /* 位置树加载失败不阻塞页面，具体页会各自报错 */
  }
  try {
    // 后端 /auth/me 返回 { member: {...} }；这里兼容「有包装」和「直接返回成员」两种形状
    const me = await get('/auth/me', undefined, { silent: true });
    store.member = me?.member ?? me ?? null;
  } catch {
    /* /auth/me 失败说明 token 无效，api 层已经处理跳登录 */
  }
}

function onAuthExpired() {
  if (route.name === 'login') return;
  router.replace({ name: 'login', query: { redirect: route.fullPath } });
}

/** 手动同步：成功后给一条反馈，失败（又断网）就等自动触发 */
async function onSyncClick() {
  store.syncError = '';
  const r = await flushQueue();
  if (r.sent > 0) pushToast(`已同步 ${r.sent} 条`, 'ok');
  else if (r.remaining > 0) pushToast(store.syncError || '还在离线，等联网后自动同步', 'warn');
}

onMounted(() => {
  ensureSession();
  window.addEventListener('auth:expired', onAuthExpired);
  // 离线队列：注册 online/visibilitychange/页面加载/30s 定时四个触发点（DEV-PLAN T6.7）
  void startSync();
});

onUnmounted(() => {
  window.removeEventListener('auth:expired', onAuthExpired);
});

// 登录成功后 token 变化，补加载会话数据（Login 页没有这一层）
watch(
  () => store.token,
  (token) => {
    if (token) ensureSession();
  },
);
</script>

<template>
  <div v-if="isLogin" class="login-shell">
    <RouterView />
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand__mark">🥫</span>家里有什么</div>

      <nav class="nav-section">
        <RouterLink to="/" class="nav-link" :class="{ 'is-active': isActive('home') }">
          <span>首页</span>
        </RouterLink>
        <RouterLink to="/shopping" class="nav-link" :class="{ 'is-active': isActive('shopping') }">
          <span>购物清单</span>
        </RouterLink>
        <RouterLink to="/alerts" class="nav-link" :class="{ 'is-active': isActive('alerts') }">
          <span>提醒</span>
        </RouterLink>
      </nav>

      <nav class="nav-section">
        <div class="nav-section__title">位置</div>
        <RouterLink
          to="/"
          class="nav-link"
          :class="{ 'is-active': route.name === 'location' && !route.params.id }"
        >
          <span>全部物品</span>
        </RouterLink>
        <template v-for="root in store.tree" :key="root.id">
          <RouterLink
            :to="{ name: 'location', params: { id: root.id } }"
            class="nav-link"
            :class="{ 'is-active': isLocationActive(root.id) }"
          >
            <span>{{ root.name }}</span>
          </RouterLink>
          <RouterLink
            v-for="child in root.children"
            :key="child.id"
            :to="{ name: 'location', params: { id: child.id } }"
            class="nav-link nav-link--child"
            :class="{ 'is-active': isLocationActive(child.id) }"
          >
            <span>{{ child.name }}</span>
          </RouterLink>
        </template>
      </nav>
    </aside>

    <main class="main">
      <header class="topbar">
        <h1 class="topbar__title">{{ title }}</h1>
        <div class="topbar__spacer"></div>
        <RouterLink v-if="route.name === 'home'" to="/add" class="btn btn--primary">记一笔</RouterLink>
        <span v-else-if="store.member" class="muted">{{ store.member.displayName || store.member.username }}</span>
      </header>

      <div class="content">
        <!-- 离线/待同步状态条（DEV-PLAN T6.8）：只有真的有队列或断网时才出现 -->
        <div v-if="store.pending > 0 || !store.online" class="sync-bar" :class="{ 'sync-bar--off': !store.online }">
          <span class="sync-bar__dot"></span>
          <span class="sync-bar__text">
            <template v-if="!store.online && store.pending > 0">离线 · 待同步 {{ store.pending }} 条</template>
            <template v-else-if="!store.online">离线 · 改动会先存在手机上</template>
            <template v-else-if="store.syncing">正在同步 {{ store.pending }} 条…</template>
            <template v-else>待同步 {{ store.pending }} 条</template>
          </span>
          <button
            v-if="store.pending > 0 && store.online && !store.syncing"
            type="button"
            class="btn btn--sm"
            @click="onSyncClick"
          >
            立即同步
          </button>
        </div>
        <RouterView />
      </div>
    </main>

    <nav class="tabbar">
      <RouterLink
        v-for="tab in tabs"
        :key="tab.name"
        :to="tab.to"
        class="tabbar__item"
        :class="{ 'is-active': isActive(tab.name) }"
      >
        <span class="tabbar__icon">{{ tab.icon }}</span>
        <span>{{ tab.label }}</span>
      </RouterLink>
    </nav>

    <RouterLink to="/add" class="fab" aria-label="记一笔" />

    <div class="toasts">
      <div v-for="t in store.toasts" :key="t.id" class="toast">{{ t.message }}</div>
    </div>
  </div>
</template>
