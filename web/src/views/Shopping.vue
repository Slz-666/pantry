<script setup>
/**
 * 购物清单（T5.5 / T5.6）。
 *
 * 三条链路：
 * 1. 手动加：写名字 + 数量 + 单位，落 shopping_item（source=manual）
 * 2. 建议补货：低库存 / 已过期由后端实时算出来（不落库），点「加进清单」才采纳
 * 3. 买回来：选位置 + 到期日 → POST /shopping/:id/stock，一个事务里
 *    建批次 + 写 in 流水 + 关清单项（不用先去物品页再建一遍）
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { get, patch, post, newClientOpId } from '../api.js';
import { pushToast, store } from '../store.js';
import { submitWrite } from '../offline/sync.js';
import Empty from '../components/Empty.vue';
import Field from '../components/Field.vue';
import Sheet from '../components/Sheet.vue';

const items = ref([]);
const suggestions = ref([]);
const units = ref(['个']);
const loading = ref(true);
const errorText = ref('');
const busy = ref(false);

const form = reactive({ name: '', qty: '1', unit: '个' });

/** 买回来入库的抽屉状态 */
const stock = reactive({ open: false, item: null, locationId: '', qty: '1', expireAt: '' });

const pendingCount = computed(() => items.value.length);

/** 位置树拍平成下拉选项，用全角空格做缩进，手机上也能看出层级 */
function flattenTree(nodes, depth = 0, out = []) {
  for (const n of nodes || []) {
    out.push({ id: n.id, label: `${'　'.repeat(depth)}${n.name}` });
    if (n.children?.length) flattenTree(n.children, depth + 1, out);
  }
  return out;
}
const locationOptions = computed(() => flattenTree(store.tree));

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const [list, tips] = await Promise.all([
      get('/shopping', { status: 'pending' }),
      get('/shopping/suggestions'),
    ]);
    items.value = list;
    suggestions.value = tips;
  } catch (err) {
    errorText.value = err.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

async function loadMeta() {
  try {
    const meta = await get('/meta');
    if (Array.isArray(meta?.units) && meta.units.length) {
      units.value = meta.units;
      if (!meta.units.includes(form.unit)) form.unit = meta.units[0];
    }
  } catch {
    // 元数据失败不阻塞主流程：退回默认「个」
  }
}

async function addManual() {
  const name = form.name.trim();
  if (!name) return pushToast('先写个名字', 'warn');
  busy.value = true;
  try {
    await post('/shopping', {
      name,
      qty: form.qty || 1,
      unit: form.unit,
      source: 'manual',
      clientOpId: newClientOpId('shop'),
    });
    form.name = '';
    form.qty = '1';
    pushToast(`已加入清单：${name}`, 'ok');
    await load();
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

async function adopt(s) {
  busy.value = true;
  try {
    await post('/shopping', {
      name: s.name,
      itemId: s.itemId,
      qty: s.qty,
      unit: s.unit,
      source: s.reason === 'expired' ? 'alert' : 'low_stock',
      clientOpId: newClientOpId('adopt'),
    });
    pushToast(`已加入清单：${s.name}`, 'ok');
    await load();
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

async function removeItem(it) {
  busy.value = true;
  try {
    await patch(`/shopping/${it.id}`, { status: 'cancelled', clientOpId: newClientOpId('cancel') });
    await load();
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

function openStock(it) {
  stock.open = true;
  stock.item = it;
  stock.qty = String(it.qty);
  stock.expireAt = '';
  stock.locationId = '';
}

async function doStock() {
  if (!stock.locationId) return pushToast('先选个位置', 'warn');
  busy.value = true;
  try {
    // 「买回来了」也支持离线：入库操作先进队列，联网后重放（client_op_id 保证只入一次）
    const { queued } = await submitWrite({
      path: `/shopping/${stock.item.id}/stock`,
      method: 'POST',
      body: {
        locationId: Number(stock.locationId),
        qty: stock.qty || stock.item.qty,
        expireAt: stock.expireAt || null,
        clientOpId: newClientOpId('stock'),
      },
      label: `${stock.item.name} 入库`,
    });
    pushToast(queued ? `${stock.item.name} 已入库（离线，待同步 ${store.pending} 条）` : `${stock.item.name} 已入库`, queued ? 'warn' : 'ok');
    stock.open = false;
    await load();
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await Promise.all([load(), loadMeta()]);
});
</script>

<template>
  <div>
    <p v-if="errorText" class="card">{{ errorText }}</p>

    <div class="card">
      <div class="section-title"><span>加一件要买的</span></div>
      <Field v-model="form.name" label="名称" placeholder="例：抽纸" maxlength="64" />
      <div class="grid-2">
        <Field v-model="form.qty" label="数量" type="number" inputmode="decimal" min="0.01" step="1" />
        <label class="field">
          <span class="field__label">单位</span>
          <select v-model="form.unit" class="input">
            <option v-for="u in units" :key="u" :value="u">{{ u }}</option>
          </select>
        </label>
      </div>
      <button type="button" class="btn btn--primary btn--block mt-3" :disabled="busy" @click="addManual">
        加入清单
      </button>
    </div>

    <template v-if="suggestions.length">
      <div class="section-title">
        <span>建议补货（{{ suggestions.length }}）</span>
      </div>
      <div class="list">
        <div v-for="s in suggestions" :key="s.key" class="card card--flush">
          <div class="row row--tight">
            <div class="row__main">
              <div class="row__title">
                {{ s.name }}
                <span class="badge">{{ s.reason === 'expired' ? '已过期' : '低于补货线' }}</span>
              </div>
              <div class="row__sub">{{ s.detail }}</div>
            </div>
            <div class="row__side">
              <button type="button" class="btn btn--sm" :disabled="busy" @click="adopt(s)">加进清单</button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div class="section-title">
      <span>待买（{{ pendingCount }}）</span>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <Empty
      v-else-if="!items.length"
      icon="🧺"
      text="清单是空的"
      hint="上面可以手动加，或者从「建议补货」一键加进来"
    />
    <div v-else class="list">
      <div v-for="it in items" :key="it.id" class="card card--flush">
        <div class="row row--tight">
          <div class="row__main">
            <div class="row__title">{{ it.name }}</div>
            <div class="row__sub">
              {{ it.qty }} {{ it.unit }}
              <template v-if="it.source === 'low_stock'"> · 低库存</template>
              <template v-else-if="it.source === 'alert'"> · 过期换新</template>
            </div>
          </div>
          <div class="row__side row__side--wrap">
            <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="openStock(it)">
              买回来了
            </button>
            <button type="button" class="btn btn--sm" :disabled="busy" @click="removeItem(it)">删</button>
          </div>
        </div>
      </div>
    </div>

    <p class="muted mt-4">「买回来了」会生成一个批次、写一条入库流水，并把清单项标成已买。</p>

    <Sheet :open="stock.open" title="买回来入库" @close="stock.open = false">
      <div v-if="stock.item">
        <p class="muted">把「{{ stock.item.name }}」放进家里，库存会加上去。</p>
        <div class="grid-2">
          <Field v-model="stock.qty" label="数量" type="number" inputmode="decimal" min="0.01" step="1" />
          <Field v-model="stock.expireAt" label="到期日" type="date" hint="不知道就留空" />
        </div>
        <label class="field">
          <span class="field__label">放到哪里</span>
          <select v-model="stock.locationId" class="input">
            <option value="">请选择位置</option>
            <option v-for="loc in locationOptions" :key="loc.id" :value="loc.id">{{ loc.label }}</option>
          </select>
        </label>
        <button type="button" class="btn btn--primary btn--block mt-3" :disabled="busy" @click="doStock">
          确认入库
        </button>
      </div>
    </Sheet>
  </div>
</template>
