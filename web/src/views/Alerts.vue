<script setup>
/**
 * 提醒页（阶段 5 完善）。现在只读展示待处理提醒，
 * 一键处理（用掉 / 丢弃 / 忽略）在阶段 5 接上——后端 /alerts/:id/handle 已经就绪。
 */
import { onMounted, ref } from 'vue';
import { get } from '../api.js';
import Empty from '../components/Empty.vue';
import { expiryClass, expiryText } from '../lib/expiry.js';

const alerts = ref([]);
const loading = ref(true);
const errorText = ref('');

const TYPE_TEXT = { expire: '到期', opened_expire: '开封后到期', low_stock: '库存不足' };

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    alerts.value = await get('/alerts', { status: 'pending' });
  } catch (err) {
    errorText.value = err.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <p v-if="errorText" class="card">{{ errorText }}</p>
    <div class="section-title">
      <span>待处理（{{ alerts.length }}）</span>
      <RouterLink to="/settings">提醒设置</RouterLink>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <Empty v-else-if="!alerts.length" icon="✅" text="没有待处理的提醒" hint="过期、快到期、低库存都会出现在这里" />
    <div v-else class="list">
      <div v-for="a in alerts" :key="a.id" class="row">
        <div class="row__main">
          <div class="row__title">
            {{ a.itemName }}
            <span class="badge">{{ TYPE_TEXT[a.type] || a.type }}</span>
          </div>
          <div class="row__sub">{{ a.locationName }} · {{ a.qty }} {{ a.unit }}</div>
        </div>
        <div class="row__side">
          <span :class="expiryClass(a.dueDate)">{{ expiryText(a.dueDate) }}</span>
        </div>
      </div>
    </div>

    <p class="muted mt-4">
      阶段 5 接上：一键「用掉 / 丢弃 / 忽略」，用掉会同时扣库存并写流水。
    </p>
  </div>
</template>
