<script setup>
/**
 * 首页（T3.7）：三个问题一屏答完——家里有多少东西、什么快坏了、还有什么待办。
 * 数据全部来自 GET /summary/today（聚合接口，一次请求）。
 */
import { computed, onMounted, ref } from 'vue';
import { get } from '../api.js';
import Empty from '../components/Empty.vue';
import { expiryClass, expiryText } from '../lib/expiry.js';

const summary = ref(null);
const loading = ref(true);
const errorText = ref('');

const stocks = computed(() => summary.value?.stocks ?? {});

/**
 * T5.4 首页顶部一句话：把「今天该干什么」压缩成一屏可见的一句。
 * 不给数字堆砌，只说用户下一步要动的东西；全 0 时给一句正向反馈。
 */
const notice = computed(() => {
  const s = stocks.value;
  const parts = [];
  if (s.expiredCount) parts.push(`${s.expiredCount} 个批次已过期`);
  if (s.expiringCount) parts.push(`${s.expiringCount} 个 7 天内到期`);
  if (s.pendingAlertCount) parts.push(`${s.pendingAlertCount} 条提醒待处理`);
  if (s.pendingShoppingCount) parts.push(`清单还有 ${s.pendingShoppingCount} 样要补`);
  return parts.join(' · ');
});

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    summary.value = await get('/summary/today');
  } catch (err) {
    errorText.value = err.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function qtyOf(n) {
  return n ?? 0;
}
</script>

<template>
  <div>
    <p v-if="errorText" class="card">{{ errorText }}</p>

    <RouterLink v-if="!loading && notice" to="/alerts" class="notice">
      <span class="notice__dot"></span>
      <span class="grow">{{ notice }}</span>
      <span>去处理 →</span>
    </RouterLink>
    <p v-else-if="!loading" class="notice notice--ok">
      <span class="notice__dot"></span>家里东西都在保质期内，清单也空着 👍
    </p>

    <div class="stats">
      <div class="stat">
        <div class="stat__num">{{ qtyOf(stocks.itemCount) }}</div>
        <div class="stat__label">种物品</div>
      </div>
      <div class="stat">
        <div class="stat__num">{{ qtyOf(stocks.batchCount) }}</div>
        <div class="stat__label">个批次</div>
      </div>
      <div class="stat">
        <div class="stat__num">{{ qtyOf(stocks.expiringCount) }}</div>
        <div class="stat__label">7 天内到期</div>
      </div>
      <div class="stat">
        <div class="stat__num" :class="{ 'is-danger': stocks.expiredCount }">
          {{ qtyOf(stocks.expiredCount) }}
        </div>
        <div class="stat__label">已过期</div>
      </div>
    </div>

    <div class="section-title">
      <span>快到期</span>
      <RouterLink to="/alerts">全部提醒 →</RouterLink>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <Empty
      v-else-if="!summary?.expiring?.length"
      icon="✅"
      text="最近没有快到期的"
      hint="保持住，别忘了每天看一眼"
    />
    <div v-else class="list">
      <RouterLink
        v-for="b in summary.expiring"
        :key="b.batchId"
        :to="{ name: 'item', params: { id: b.itemId } }"
        class="row"
      >
        <div class="row__main">
          <div class="row__title">{{ b.itemName }}</div>
          <div class="row__sub">{{ b.locationName }} · {{ b.qty }} {{ b.unit }}</div>
        </div>
        <div class="row__side">
          <span :class="expiryClass(b.expireAt)">{{ expiryText(b.expireAt) }}</span>
        </div>
      </RouterLink>
    </div>

    <div class="section-title"><span>位置</span></div>
    <div class="list">
      <RouterLink
        v-for="loc in summary?.locations ?? []"
        :key="loc.id"
        :to="{ name: 'location', params: { id: loc.id } }"
        class="row"
      >
        <div class="row__main">
          <div class="row__title">{{ loc.name }}</div>
          <div class="row__sub">{{ loc.itemCount }} 种 · {{ loc.qty }} 件</div>
        </div>
        <div class="row__side muted">→</div>
      </RouterLink>
    </div>

    <div class="section-title"><span>待办</span></div>
    <div class="list">
      <RouterLink to="/alerts" class="row">
        <div class="row__main">
          <div class="row__title">待处理提醒</div>
          <div class="row__sub">到期、开封过期、低库存</div>
        </div>
        <div class="row__side">
          <span class="badge">{{ qtyOf(stocks.pendingAlertCount) }}</span>
        </div>
      </RouterLink>
      <RouterLink to="/shopping" class="row">
        <div class="row__main">
          <div class="row__title">待买的</div>
          <div class="row__sub">购物清单</div>
        </div>
        <div class="row__side">
          <span class="badge">{{ qtyOf(stocks.pendingShoppingCount) }}</span>
        </div>
      </RouterLink>
    </div>
  </div>
</template>
