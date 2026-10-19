<script setup>
/**
 * 购物清单（阶段 5 完善）。现在先只读展示待买项，
 * 方便验证接口与首页计数一致；「加购 / 买回来入库」在阶段 5 接上。
 */
import { onMounted, ref } from 'vue';
import { get } from '../api.js';
import Empty from '../components/Empty.vue';

const items = ref([]);
const loading = ref(true);
const errorText = ref('');

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    items.value = await get('/shopping', { status: 'pending' });
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
      <span>待买（{{ items.length }}）</span>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <Empty v-else-if="!items.length" icon="🧺" text="清单是空的" hint="阶段 5 可以把低库存一键加进来" />
    <div v-else class="list">
      <div v-for="it in items" :key="it.id" class="row">
        <div class="row__main">
          <div class="row__title">{{ it.name }}</div>
          <div class="row__sub">
            {{ it.qty }} {{ it.unit }}
            <span v-if="it.source === 'low_stock'"> · 低库存自动加</span>
          </div>
        </div>
      </div>
    </div>

    <p class="muted mt-4">阶段 5 接上：手动加购、买回来一键入库（生成批次 + 写流水）。</p>
  </div>
</template>
