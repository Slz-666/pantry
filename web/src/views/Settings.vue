<script setup>
/** 我的：账号信息、退出登录、当前阶段说明（自用工具不需要一堆设置项）。 */
import { useRouter } from 'vue-router';
import { store, clearAuth } from '../store.js';

const router = useRouter();

function logout() {
  clearAuth();
  router.replace({ name: 'login' });
}
</script>

<template>
  <div>
    <div class="card">
      <div class="section-title"><span>账号</span></div>
      <p>{{ store.member?.displayName || store.member?.username || '未登录' }}</p>
      <p class="muted">家里有什么 · 自用版</p>
    </div>

    <div class="card">
      <div class="section-title"><span>提醒规则</span></div>
      <p class="muted">默认在到期前 30 / 7 / 1 天提醒，开封后 7 天内提醒，低于阈值提醒补货。规则编辑在阶段 5。</p>
    </div>

    <div class="card">
      <div class="section-title"><span>阶段进度</span></div>
      <p class="muted">0 地基 ✓ · 1 数据层 ✓ · 2 接口层 ✓ · 3 界面骨架 ✓ · 4 录入 Agent · 5 提醒与清单 · 6 离线 · 7 手机</p>
    </div>

    <button class="btn btn--block" type="button" style="margin-top: 12px" @click="logout">退出登录</button>
  </div>
</template>
