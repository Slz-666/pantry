<script setup>
/**
 * 物品详情（T3.9）：档案 + 批次（哪盒先过期）+ 最近流水（每次数量变化都能解释）。
 * 阶段 3 只读；消耗/丢弃/改数量的操作按钮在阶段 5 接上。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { get } from '../api.js';
import BatchRow from '../components/BatchRow.vue';
import Empty from '../components/Empty.vue';

const route = useRoute();
const itemId = computed(() => Number(route.params.id));

const item = ref(null);
const batches = ref([]);
const logs = ref([]);
const loading = ref(true);
const errorText = ref('');

const TYPE_TEXT = {
  in: '入库',
  consume: '消耗',
  discard: '丢弃',
  adjust: '调账',
  move: '移动',
  extract_in: '录入入库',
};

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const detail = await get(`/items/${itemId.value}`);
    item.value = detail.item;
    batches.value = detail.batches ?? [];
    logs.value = await get('/stock-logs', { itemId: itemId.value, limit: 20 });
  } catch (err) {
    errorText.value = err.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function signed(n) {
  const v = Number(n);
  return v > 0 ? `+${v}` : `${v}`;
}
</script>

<template>
  <div>
    <p v-if="errorText" class="card">{{ errorText }}</p>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-else-if="item">
      <div class="card">
        <div class="page-head" style="margin-bottom: 8px">
          <h2 class="page-title">{{ item.name }}</h2>
          <span v-if="item.category" class="badge">{{ item.category }}</span>
        </div>
        <div class="muted">
          <span v-if="item.spec">{{ item.spec }} · </span>
          共 {{ item.totalQty }} {{ item.unit }} · {{ item.batchCount }} 个批次
          <span v-if="item.locationName"> · 默认位置 {{ item.locationName }}</span>
        </div>
        <p v-if="item.note" class="muted">{{ item.note }}</p>
      </div>

      <div class="section-title"><span>批次（先过期先处理）</span></div>
      <Empty v-if="!batches.length" icon="📦" text="还没有批次" hint="入库后才会有具体批次" />
      <div v-else class="list">
        <BatchRow v-for="b in batches" :key="b.id" :batch="b" :unit="item.unit" />
      </div>

      <div class="section-title"><span>最近流水</span></div>
      <Empty v-if="!logs.length" icon="🧾" text="还没有流水" />
      <div v-else class="list">
        <div v-for="log in logs" :key="log.id" class="row">
          <div class="row__main">
            <div class="row__title">
              {{ TYPE_TEXT[log.type] || log.type }}
              <span class="muted">{{ signed(log.qtyDelta) }}</span>
            </div>
            <div class="row__sub">
              {{ log.createdAt }}
              <span v-if="log.reason"> · {{ log.reason }}</span>
            </div>
          </div>
          <div class="row__side muted">{{ log.qtyAfter }}</div>
        </div>
      </div>
    </template>
  </div>
</template>
