<script setup>
/**
 * 提醒中心（T5.7）：待办 / 已处理两栏。
 *
 * 三个动作都走 POST /alerts/:id/handle：
 * - done：扣 1 个单位并写流水（一次点一个，家里「喝了一盒牛奶」的粒度）
 * - discard：把这个批次剩余全部丢掉
 * - ignore：只关提醒，不动库存
 * 后端保证幂等（alert 行锁 + status 判断），重复点不会重复扣。
 */
import { computed, onMounted, ref } from 'vue';
import { get, newClientOpId } from '../api.js';
import { pushToast, store } from '../store.js';
import { submitWrite } from '../offline/sync.js';
import Empty from '../components/Empty.vue';
import { expiryClass, expiryText } from '../lib/expiry.js';

const alerts = ref([]);
const loading = ref(true);
const errorText = ref('');
const tab = ref('pending');
/** 正在处理的 alert id：用来禁用按钮，防止连点扣两次 */
const busyId = ref(0);

const TYPE_TEXT = { expire: '到期', opened_expire: '开封后到期', low_stock: '库存不足' };
const STATUS_TEXT = { done: '已用掉', discarded: '已丢弃', ignored: '已忽略', pending_sync: '待同步' };

const pending = computed(() => alerts.value.filter((a) => a.status === 'pending'));
const handled = computed(() => alerts.value.filter((a) => a.status !== 'pending'));
const shown = computed(() => (tab.value === 'pending' ? pending.value : handled.value));

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    alerts.value = await get('/alerts', { status: 'all' });
  } catch (err) {
    errorText.value = err.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

async function handle(a, action) {
  if (busyId.value) return;
  busyId.value = a.id;
  const body = { action, clientOpId: newClientOpId('alert') };
  const okText =
    action === 'done' ? '已用掉 1 个，库存已扣减' : action === 'discard' ? '已丢弃这一批' : '已忽略这条提醒';
  try {
    // 断网时先进队列、界面立刻变，联网后自动重放（DEV-PLAN T6.5）
    const { queued } = await submitWrite({
      path: `/alerts/${a.id}/handle`,
      method: 'POST',
      body,
      label: okText,
    });
    if (queued) {
      // 乐观更新：本地把这条从待处理里摘掉，服务端稍后确认
      alerts.value = alerts.value.map((x) => (x.id === a.id ? { ...x, status: 'pending_sync' } : x));
      pushToast(`${okText}（离线，待同步 ${store.pending} 条）`, 'warn');
    } else {
      pushToast(okText, 'ok');
      await load();
    }
  } catch {
    // api.js 已经弹过错误提示，这里只负责解锁按钮
  } finally {
    busyId.value = 0;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <p v-if="errorText" class="card">{{ errorText }}</p>

    <div class="segmented">
      <button
        type="button"
        class="segmented__item"
        :class="{ 'is-active': tab === 'pending' }"
        @click="tab = 'pending'"
      >
        待处理 {{ pending.length }}
      </button>
      <button
        type="button"
        class="segmented__item"
        :class="{ 'is-active': tab === 'handled' }"
        @click="tab = 'handled'"
      >
        已处理 {{ handled.length }}
      </button>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <Empty
      v-else-if="!shown.length"
      :icon="tab === 'pending' ? '✅' : '🗂'"
      :text="tab === 'pending' ? '没有待处理的提醒' : '还没有处理过任何提醒'"
      :hint="tab === 'pending' ? '过期、快到期、低库存都会出现在这里' : '处理过的会留在这里，方便回看'"
    />
    <div v-else class="list">
      <div v-for="a in shown" :key="a.id" class="card card--flush">
        <div class="row row--tight">
          <div class="row__main">
            <div class="row__title">
              {{ a.itemName }}
              <span class="badge">{{ TYPE_TEXT[a.type] || a.type }}</span>
            </div>
            <div class="row__sub">{{ a.locationName }} · {{ a.qty }} {{ a.unit }}</div>
          </div>
          <div class="row__side">
            <span v-if="a.type === 'low_stock'" class="muted">库存低于补货线</span>
            <span v-else-if="a.status === 'pending'" :class="expiryClass(a.dueDate)">
              {{ expiryText(a.dueDate) }}
            </span>
            <span v-else class="muted">
              {{ STATUS_TEXT[a.status] || a.status }}
              <template v-if="a.handledAt"> · {{ a.handledAt.slice(0, 16) }}</template>
            </span>
          </div>
        </div>

        <div v-if="a.status === 'pending'" class="row-actions">
          <RouterLink v-if="a.type === 'low_stock'" to="/shopping" class="btn btn--sm">
            去购物清单补货
          </RouterLink>
          <template v-else>
            <button type="button" class="btn btn--sm btn--primary" :disabled="busyId === a.id" @click="handle(a, 'done')">
              用掉 1 个
            </button>
            <button type="button" class="btn btn--sm" :disabled="busyId === a.id" @click="handle(a, 'discard')">
              整批丢弃
            </button>
            <button type="button" class="btn btn--sm" :disabled="busyId === a.id" @click="handle(a, 'ignore')">
              忽略
            </button>
          </template>
        </div>
      </div>
    </div>

    <p class="muted mt-4">
      「用掉」会扣库存并写一条流水，「丢弃」丢掉这个批次剩余，「忽略」只关掉提醒。
    </p>
  </div>
</template>
