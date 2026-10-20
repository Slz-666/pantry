<script setup>
/**
 * 记一笔：一句话 → 草稿 → 确认入库（阶段 4 核心链路）+ 最近常用一键复购（F-2.6）。
 *
 * 为什么这页这么短：真正的理解在服务端（extract.js 的 prompt + normalize.js 的确定性校验），
 * 这里只负责「收文字/语音」和「把草稿交给确认卡片」。前端不做任何字段猜测，
 * 否则同一句话在手机和电脑上会得到两种结果。
 *
 * 语音只在支持 webkitSpeechRecognition 的浏览器出现（安卓 Chrome）；
 * 拿不到就隐藏按钮而不是报错——iOS 不是目标设备，打字路径永远可用。
 *
 * 两条入库路径都走 submitWrite：
 * - 有草稿（提取成功）→ 服务端事务入库，必须联网（草稿在服务器上）；
 * - 手动表单 → 逐条 POST /batches，断网时进 IndexedDB 队列，联网后重放。
 *   之前手动路径用的是裸 post()，断网直接失败且不入队，与 README「断网可录入」不符。
 */
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get, post, newClientOpId } from '../api.js';
import { pushToast, store } from '../store.js';
import { submitWrite } from '../offline/sync.js';
import { createRecognizer, voiceSupported } from '../voice.js';
import ConfirmSheet from '../components/ConfirmSheet.vue';
import Field from '../components/Field.vue';
import Sheet from '../components/Sheet.vue';

const router = useRouter();

const text = ref('');
const loading = ref(false);
const submitting = ref(false);
const listening = ref(false);
const units = ref([]);
const categories = ref([]);
const payload = ref(null);
const sheetOpen = ref(false);

/** 最近记过的物品（一键复购的入口） */
const recent = ref([]);
const buying = ref(false);
const buy = reactive({ open: false, item: null, qty: '1', locationId: '', expireAt: '', opened: false });

const supported = voiceSupported();
let recognizer = null;

const examples = [
  '牛奶两盒放冰箱冷藏，10月25号过期',
  '鸡蛋一板30个放冷藏，保质期30天',
  '洗衣液囤了两桶放储藏室',
  '纸巾和抽纸各买一份',
];

/** 位置树拍平：全角空格缩进，手机上也能看出层级 */
function flattenTree(nodes, depth = 0, out = []) {
  for (const n of nodes || []) {
    out.push({ id: n.id, label: `${'　'.repeat(depth)}${n.name}` });
    if (n.children?.length) flattenTree(n.children, depth + 1, out);
  }
  return out;
}
const locationOptions = ref([]);

onMounted(async () => {
  try {
    const meta = await get('/meta', null, { silent: true });
    units.value = meta.units || [];
    categories.value = meta.categories || [];
  } catch {
    // 拿不到白名单就退成「只能手动填单位」的降级路径，不影响主流程
  }
  locationOptions.value = flattenTree(store.tree);
  try {
    // 最近常用：从入库流水倒序取（后端 /recent-items），断网就少这个入口，不影响主流程
    recent.value = await get('/recent-items', { limit: 6 }, { silent: true });
  } catch {
    recent.value = [];
  }
});

onBeforeUnmount(() => {
  if (recognizer) recognizer.abort();
});

async function doExtract() {
  const input = text.value.trim();
  if (!input || loading.value) return;
  loading.value = true;
  payload.value = null;
  try {
    const data = await post('/extract', { text: input, channel: 'text' }, { silent: true });
    payload.value = data;
    sheetOpen.value = true;
  } catch (err) {
    // 抽取服务挂了也别让人白说：原话留在输入框，退手动表单
    payload.value = {
      draftId: null,
      error: err?.message || '抽取服务暂时不可用',
      draft: { text: input, items: [], failed: true },
    };
    sheetOpen.value = true;
  } finally {
    loading.value = false;
  }
}

function openManual() {
  payload.value = {
    draftId: null,
    draft: { text: text.value.trim(), items: [], failed: true, error: '' },
  };
  sheetOpen.value = true;
}

/** 语音：点一下开始说，再点一下停；识别结果直接写进输入框，人还能改。 */
function toggleVoice() {
  if (!supported) return;
  if (listening.value) {
    recognizer?.stop();
    return;
  }
  recognizer = createRecognizer({
    onPartial: (t) => {
      text.value = t;
    },
    onFinal: (t) => {
      text.value = t;
    },
    onError: (code) => {
      const messages = {
        'not-allowed': '麦克风被拒了：允许麦克风后再试，或者直接打字',
        'no-speech': '没听到声音，再说一次',
        network: '语音识别要联网，检查一下网络',
        'audio-capture': '没找到麦克风',
        aborted: '',
      };
      const msg = code in messages ? messages[code] : `语音识别失败（${code}）`;
      if (msg) pushToast(msg);
      listening.value = false;
    },
    onEnd: () => {
      listening.value = false;
    },
  });
  if (!recognizer) return;
  try {
    listenerStart();
  } catch {
    listening.value = false;
  }
}

function listenerStart() {
  recognizer.start();
  listening.value = true;
}

async function onConfirm(items) {
  const p = payload.value;
  if (!p) return;
  submitting.value = true;
  try {
    if (p.draftId) {
      // 草稿在服务端：断网时没法发（提取本身就要求联网），这里如实报错
      const res = await post(`/extract/${p.draftId}/confirm`, {
        items,
        clientOpId: newClientOpId('extract'),
      });
      pushToast(`已入库 ${res.results?.length ?? items.length} 条`);
      text.value = '';
      payload.value = null;
      sheetOpen.value = false;
      const first = res.results?.[0];
      router.push(first?.itemId ? `/item/${first.itemId}` : '/');
      return;
    }

    // 手动路径：没有草稿，直接按批次入库（每条一个 client_op_id，可离线排队、重试安全）
    let queuedCount = 0;
    let lastItemId = null;
    for (const it of items) {
      const { queued, data } = await submitWrite({
        path: '/batches',
        body: {
          itemId: null,
          name: it.name,
          spec: it.spec,
          unit: it.unit,
          category: it.category,
          barcode: it.barcode || null,
          qty: it.qty,
          locationId: it.locationId,
          expireAt: it.expireAt,
          opened: it.opened,
          clientOpId: newClientOpId('manual'),
        },
        label: `${it.name} 入库`,
      });
      if (queued) queuedCount += 1;
      else lastItemId = data?.itemId ?? lastItemId;
    }
    if (queuedCount) {
      pushToast(`已记下 ${queuedCount} 条（离线，待同步 ${store.pending} 条）`, 'warn');
    } else {
      pushToast(`已入库 ${items.length} 条`, 'ok');
    }
    text.value = '';
    payload.value = null;
    sheetOpen.value = false;
    router.push(!queuedCount && lastItemId ? `/item/${lastItemId}` : '/');
  } catch {
    // api.js 已经弹过错误提示，这里只保持卡片打开让人改
  } finally {
    submitting.value = false;
  }
}

/* ---------------- 最近常用：一键复购 ---------------- */

function openBuy(it) {
  buy.item = it;
  buy.qty = '1';
  buy.expireAt = '';
  buy.opened = false;
  buy.locationId = it.defaultLocationId ?? store.locations[0]?.id ?? '';
  buy.open = true;
}

async function doBuy() {
  if (!buy.item || buying.value) return;
  const qty = Number(buy.qty);
  if (!Number.isFinite(qty) || qty <= 0) return pushToast('数量要大于 0', 'warn');
  if (!buy.locationId) return pushToast('先选一个位置', 'warn');
  buying.value = true;
  try {
    const { queued } = await submitWrite({
      path: '/batches',
      body: {
        itemId: buy.item.id,
        qty,
        locationId: Number(buy.locationId),
        expireAt: buy.expireAt || null,
        opened: Boolean(buy.opened),
        clientOpId: newClientOpId('buy'),
      },
      label: `${buy.item.name} 补货`,
    });
    pushToast(
      queued ? `${buy.item.name} 已记下（离线，待同步 ${store.pending} 条）` : `${buy.item.name} 已入库`,
      queued ? 'warn' : 'ok',
    );
    buy.open = false;
    router.push(`/item/${buy.item.id}`);
  } catch {
    // api.js 已提示
  } finally {
    buying.value = false;
  }
}
</script>

<template>
  <div class="entry-page">
    <div class="card">
      <h2 class="page-title">一句话录入</h2>
      <p class="muted mt-1">说一句就行，比如「牛奶两盒放冰箱冷藏，10月25号过期」。</p>

      <textarea
        v-model="text"
        class="input entry-textarea"
        rows="4"
        placeholder="例：牛奶两盒放冰箱冷藏，10月25号过期"
        @keydown.ctrl.enter="doExtract"
      ></textarea>

      <div class="entry-actions">
        <button
          v-if="supported"
          class="btn btn--mic"
          :class="{ 'is-listening': listening }"
          type="button"
          @click="toggleVoice"
        >
          {{ listening ? '● 正在听，点这里停' : '🎤 说一句' }}
        </button>
        <button class="btn btn--primary" type="button" :disabled="loading || !text.trim()" @click="doExtract">
          {{ loading ? '理解中…' : '变成草稿' }}
        </button>
      </div>

      <p v-if="!supported" class="muted">
        这个浏览器没有语音识别（安卓 Chrome 才有；iOS Safari 没有），打字一样能记。
      </p>
    </div>

    <!-- 最近常用（F-2.6）：买了同样东西时不用再想怎么说，点一下填好数量位置 -->
    <div v-if="recent.length" class="card">
      <div class="section-title"><span>最近记过的（点一下直接补货）</span></div>
      <div class="chips">
        <button v-for="it in recent" :key="it.id" class="chip" type="button" @click="openBuy(it)">
          {{ it.name }}<template v-if="it.totalQty > 0"> · 还有 {{ it.totalQty }}{{ it.unit }}</template>
        </button>
      </div>
    </div>

    <div class="card">
      <div class="section-title"><span>试着说</span></div>
      <div class="chips">
        <button v-for="ex in examples" :key="ex" class="chip" type="button" @click="text = ex">
          {{ ex }}
        </button>
      </div>
      <button class="btn btn--ghost btn--block mt-2" type="button" @click="openManual">
        不想说，手动填
      </button>
    </div>

    <ConfirmSheet
      :open="sheetOpen"
      :payload="payload"
      :units="units"
      :categories="categories"
      :submitting="submitting"
      @close="sheetOpen = false"
      @confirm="onConfirm"
    />

    <Sheet :open="buy.open" title="再买一次" @close="buy.open = false">
      <div v-if="buy.item" class="form">
        <p class="muted">{{ buy.item.name }}<template v-if="buy.item.spec"> · {{ buy.item.spec }}</template></p>
        <Field v-model="buy.qty" label="买了几" type="number" inputmode="decimal" min="0.01" step="1" />
        <label class="field">
          <span class="field__label">放到哪里</span>
          <select v-model="buy.locationId" class="input">
            <option value="">请选择位置</option>
            <option v-for="loc in locationOptions" :key="loc.id" :value="loc.id">{{ loc.label }}</option>
          </select>
        </label>
        <Field v-model="buy.expireAt" label="到期日" type="date" hint="不知道就留空" />
        <label class="checkbox">
          <input v-model="buy.opened" type="checkbox" />
          <span>已经开封</span>
        </label>
        <button type="button" class="btn btn--primary btn--block mt-2" :disabled="buying" @click="doBuy">
          {{ buying ? '入库中…' : '确认入库' }}
        </button>
      </div>
    </Sheet>
  </div>
</template>
