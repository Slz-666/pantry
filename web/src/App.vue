<script setup>
// 阶段 0 的 App.vue 只干一件事：证明「前端 → vite 代理 → 后端」这条链是通的。
// 阶段 3 会把它换成路由 + 真正的首页。
import { onMounted, ref } from 'vue'

const health = ref(null)
const error = ref('')

onMounted(async () => {
  try {
    const res = await fetch('/api/health')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    health.value = await res.json()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})
</script>

<template>
  <main>
    <h1>家里有什么</h1>
    <p v-if="error">接口请求失败：{{ error }}</p>
    <p v-else-if="health"><code>/api/health</code> → {{ JSON.stringify(health) }}</p>
    <p v-else>检查中…</p>
  </main>
</template>
