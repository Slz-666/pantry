<script setup>
/**
 * 物品详情（T3.9 + 阶段 8 修复）：档案 + 批次（哪盒先过期）+ 最近流水。
 *
 * 阶段 3 时这页只读，PRD 的核心场景「用的时候一键消耗」没有入口（验收测试记了这条）。
 * 现在每个批次都有：用掉 1 / 改数量 / 挪位置 / 丢掉，顶部还有「再买一次」——
 * 全部复用现成的批次接口，前端不发明新的库存语义（数量变化照样只有 inventory.js 一条路）。
 *
 * 写操作一律走 submitWrite：断网时进 IndexedDB 队列，联网后按 client_op_id 重放，
 * 厨房里信号差也能点「用掉 1」。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { get, getCached, newClientOpId } from '../api.js';
import { pushToast, store } from '../store.js';
import { submitWrite } from '../offline/sync.js';
import BatchRow from '../components/BatchRow.vue';
import Empty from '../components/Empty.vue';
import Field from '../components/Field.vue';
import Sheet from '../components/Sheet.vue';

const route = useRoute();
const itemId = computed(() => Number(route.params.id));

const item = ref(null);
const batches = ref([]);
const logs = ref([]);
const loading = ref(true);
const errorText = ref('');
/** 详情是否来自缓存（离线可看，但不保证最新） */
const fromCache = ref(false);
const busy = ref(false);

const TYPE_TEXT = {
  in: '入库',
  consume: '消耗',
  discard: '丢弃',
  adjust: '调账',
  move: '移动',
  extract_in: '录入入库',
};

/** 操作抽屉：一个抽屉服务五种动作，模式不同、字段不同 */
const sheet = reactive({
  open: false,
  mode: '',
  batch: null,
  qty: '',
  locationId: '',
  expireAt: '',
  opened: false,
});

const MODE_TEXT = {
  consume: '用掉',
  discard: '丢掉',
  adjust: '改数量',
  move: '挪位置',
  restock: '再买一次',
};

/** 位置树拍平：用全角空格缩进，手机上也能看出层级 */
function flattenTree(nodes, depth = 0, out = []) {
  for (const n of nodes || []) {
    out.push({ id: n.id, label: `${'　'.repeat(depth)}${n.name}` });
    if (n.children?.length) flattenTree(n.children, depth + 1, out);
  }
  return out;
}
const locationOptions = computed(() => flattenTree(store.tree));

async function load() {
  errorText.value = '';
  try {
    // 详情走「缓存优先」（T6.4）：断网也能看到上次的批次和流水
    await getCached(`/items/${itemId.value}`, undefined, (data, meta) => {
      item.value = data.item;
      batches.value = data.batches ?? [];
      fromCache.value = Boolean(meta?.cached);
      loading.value = false;
    });
    try {
      logs.value = await get('/stock-logs', { itemId: itemId.value, limit: 20 }, { silent: true });
    } catch {
      // 流水是次要信息，离线时保留旧值即可
    }
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

/* ---------------- 操作抽屉 ---------------- */

function openSheet(mode, batch = null) {
  sheet.mode = mode;
  sheet.batch = batch;
  sheet.qty = mode === 'adjust' ? String(batch?.qty ?? '') : '1';
  sheet.opened = Boolean(batch?.opened);
  sheet.expireAt = mode === 'restock' ? '' : batch?.expireAt || '';
  if (mode === 'move') sheet.locationId = batch?.locationId ?? '';
  else if (mode === 'restock') sheet.locationId = item.value?.defaultLocationId ?? batches.value[0]?.locationId ?? '';
  else sheet.locationId = '';
  sheet.open = true;
}

/** 抽屉主按钮：按模式发对应请求（全部带 clientOpId，可离线排队） */
async function submit() {
  if (busy.value) return;
  const b = sheet.batch;
  const opId = newClientOpId(sheet.mode || 'op');
  busy.value = true;
  try {
    let queued = false;

    if (sheet.mode === 'consume') {
      const qty = Number(sheet.qty) || 1;
      ({ queued } = await submitWrite({
        path: `/batches/${b.id}/consume`,
        body: { qty, clientOpId: opId },
        label: `用掉 ${qty}`,
      }));
      if (queued) b.qty = Math.max(0, Number(b.qty) - qty);
    } else if (sheet.mode === 'discard') {
      const qty = sheet.qty === '' ? null : Number(sheet.qty);
      ({ queued } = await submitWrite({
        path: `/batches/${b.id}/discard`,
        body: { qty, clientOpId: opId },
        label: '丢掉一批',
      }));
      if (queued) b.qty = qty == null ? 0 : Math.max(0, Number(b.qty) - qty);
    } else if (sheet.mode === 'adjust') {
      const qty = Number(sheet.qty);
      if (!Number.isFinite(qty) || qty < 0) throw new Error('数量要填 0 或正数');
      ({ queued } = await submitWrite({
        path: `/batches/${b.id}`,
        method: 'PATCH',
        body: { qty, reason: 'manual_adjust', clientOpId: opId },
        label: '改数量',
      }));
      if (queued) b.qty = qty;
    } else if (sheet.mode === 'move') {
      if (!sheet.locationId) throw new Error('先选一个位置');
      ({ queued } = await submitWrite({
        path: `/batches/${b.id}`,
        method: 'PATCH',
        body: { locationId: Number(sheet.locationId), clientOpId: opId },
        label: '挪位置',
      }));
      if (queued) b.locationId = Number(sheet.locationId);
    } else if (sheet.mode === 'restock') {
      const qty = Number(sheet.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error('数量要大于 0');
      if (!sheet.locationId) throw new Error('先选一个位置');
      ({ queued } = await submitWrite({
        path: '/batches',
        body: {
          itemId: item.value.id,
          qty,
          locationId: Number(sheet.locationId),
          expireAt: sheet.expireAt || null,
          opened: Boolean(sheet.opened),
          clientOpId: opId,
        },
        label: `${item.value.name} 再买一次`,
      }));
    }

    sheet.open = false;
    if (queued) {
      pushToast(`已记下（离线，待同步 ${store.pending} 条）`, 'warn');
    } else {
      pushToast(`${MODE_TEXT[sheet.mode]} 完成`, 'ok');
      await load();
    }
  } catch (err) {
    if (err?.message && !err.code) pushToast(err.message);
    // 其余错误 api.js 已经提示过，抽屉保持打开让人改
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="detail-page">
    <p v-if="errorText" class="card">{{ errorText }}</p>
    <p v-if="fromCache && store.online === false" class="muted mb-2">离线：下面是上次同步的数据</p>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-else-if="item">
      <div class="card">
        <div class="detail-head">
          <h2 class="detail-head__name">{{ item.name }}</h2>
          <span v-if="item.category" class="badge">{{ item.category }}</span>
          <span v-if="item.lowStock" class="badge badge--danger">该补货</span>
        </div>
        <div class="detail-sub">
          <span v-if="item.spec">{{ item.spec }} · </span>
          共 {{ item.totalQty }} {{ item.unit }} · {{ item.batchCount }} 个批次
          <span v-if="item.locationName"> · 默认位置 {{ item.locationName }}</span>
        </div>
        <div v-if="item.barcode" class="detail-sub">条码 {{ item.barcode }}</div>
        <p v-if="item.note" class="detail-sub">{{ item.note }}</p>

        <div class="detail-acts">
          <button type="button" class="btn btn--primary" @click="openSheet('restock')">再买一次</button>
          <router-link to="/add" class="btn">用一句话记</router-link>
        </div>
      </div>

      <div class="section-title"><span>批次（先过期先处理）</span></div>
      <Empty v-if="!batches.length" icon="📦" text="还没有批次" hint="入库后才会有具体批次" />
      <div v-else class="list">
        <BatchRow
          v-for="b in batches"
          :key="b.id"
          :batch="b"
          :unit="item.unit"
          editable
          @consume="openSheet('consume', $event)"
          @adjust="openSheet('adjust', $event)"
          @move="openSheet('move', $event)"
          @discard="openSheet('discard', $event)"
        />
      </div>

      <div class="section-title"><span>最近流水</span></div>
      <Empty v-if="!logs.length" icon="🧾" text="还没有流水" />
      <div v-else class="card card--flush">
        <div v-for="log in logs" :key="log.id" class="log-row">
          <span class="log-row__type">{{ TYPE_TEXT[log.type] || log.type }}</span>
          <span class="log-row__delta">{{ signed(log.qtyDelta) }}</span>
          <span class="log-row__meta">
            {{ log.createdAt }}<template v-if="log.reason"> · {{ log.reason }}</template> ·
            余 {{ log.qtyAfter }}<template v-if="log.operatorName"> · {{ log.operatorName }}</template>
          </span>
        </div>
      </div>
    </template>

    <Sheet :open="sheet.open" :title="MODE_TEXT[sheet.mode] || '操作'" @close="sheet.open = false">
      <div class="form">
        <p v-if="sheet.batch" class="muted">
          {{ item?.name }} · 这一批现在 {{ sheet.batch.qty }} {{ item?.unit }}
          <template v-if="sheet.batch.locationName"> · {{ sheet.batch.locationName }}</template>
        </p>

        <!-- 用掉 / 丢掉 / 改数量：都是一个数字 -->
        <Field
          v-if="sheet.mode === 'consume' || sheet.mode === 'adjust'"
          v-model="sheet.qty"
          :label="sheet.mode === 'adjust' ? '改成多少（盘点后填真实剩余）' : '用掉多少'"
          type="number"
          inputmode="decimal"
          min="0"
          step="1"
        />
        <Field
          v-else-if="sheet.mode === 'discard'"
          v-model="sheet.qty"
          label="丢掉多少（留空 = 这批剩下的全丢）"
          type="number"
          inputmode="decimal"
          min="0"
          step="1"
          hint="过期的整盒扔掉，直接留空"
        />

        <!-- 挪位置 -->
        <label v-if="sheet.mode === 'move' || sheet.mode === 'restock'" class="field">
          <span class="field__label">放到哪里</span>
          <select v-model="sheet.locationId" class="input">
            <option value="">请选择位置</option>
            <option v-for="loc in locationOptions" :key="loc.id" :value="loc.id">{{ loc.label }}</option>
          </select>
        </label>

        <!-- 再买一次 -->
        <template v-if="sheet.mode === 'restock'">
          <Field v-model="sheet.qty" label="买了几" type="number" inputmode="decimal" min="0.01" step="1" />
          <Field v-model="sheet.expireAt" label="到期日" type="date" hint="不知道就留空" />
          <label class="checkbox">
            <input v-model="sheet.opened" type="checkbox" />
            <span>已经开封</span>
          </label>
        </template>

        <div class="row row--tight mt-2">
          <button type="button" class="btn btn--block" @click="sheet.open = false">取消</button>
          <button type="button" class="btn btn--primary btn--block" :disabled="busy" @click="submit">
            {{ busy ? '保存中…' : '确认' }}
          </button>
        </div>
      </div>
    </Sheet>
  </div>
</template>
