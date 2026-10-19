<script setup>
/**
 * 记一笔：一句话 → 草稿 → 确认入库（阶段 4 核心链路）。
 *
 * 为什么这页这么短：真正的理解在服务端（extract.js 的 prompt + normalize.js 的确定性校验），
 * 这里只负责「收文字/语音」和「把草稿交给确认卡片」。前端不做任何字段猜测，
 * 否则同一句话在手机和电脑上会得到两种结果。
 *
 * 语音只在支持 webkitSpeechRecognition 的浏览器出现（安卓 Chrome）；
 * 拿不到就隐藏按钮而不是报错——iOS 不是目标设备，打字路径永远可用。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get, post, newClientOpId } from '../api.js';
import { pushToast } from '../store.js';
import { createRecognizer, voiceSupported } from '../voice.js';
import ConfirmSheet from '../components/ConfirmSheet.vue';

const router = useRouter();

const text = ref('');
const loading = ref(false);
const submitting = ref(false);
const listening = ref(false);
const units = ref([]);
const categories = ref([]);
const payload = ref(null);
const sheetOpen = ref(false);

const supported = voiceSupported();
let recognizer = null;

const examples = [
  '牛奶两盒放冰箱冷藏，10月25号过期',
  '鸡蛋一板30个放冷藏，保质期30天',
  '洗衣液囤了两桶放储藏室',
  '纸巾和抽纸各买一份',
];

onMounted(async () => {
  try {
    const meta = await get('/meta', null, { silent: true });
    units.value = meta.units || [];
    categories.value = meta.categories || [];
  } catch {
    // 拿不到白名单就退成「只能手动填单位」的降级路径，不影响主流程
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
    } else {
      // 手动路径：没有草稿，直接按批次入库（每条一个 client_op_id，重试安全）
      const results = [];
      for (const it of items) {
        results.push(
          await post('/batches', {
            itemId: null,
            name: it.name,
            spec: it.spec,
            unit: it.unit,
            category: it.category,
            qty: it.qty,
            locationId: it.locationId,
            expireAt: it.expireAt,
            opened: it.opened,
            clientOpId: newClientOpId('manual'),
          }),
        );
      }
      pushToast(`已入库 ${results.length} 条`);
      text.value = '';
      payload.value = null;
      sheetOpen.value = false;
      router.push('/');
    }
  } catch {
    // api.js 已经弹过错误提示，这里只保持卡片打开让人改
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div>
    <div class="card">
      <h2 class="page-title">记一笔</h2>
      <p class="muted" style="margin-top: 4px">
        说一句就行：「牛奶两盒放冰箱冷藏，10月25号过期」。
      </p>

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

    <div class="card">
      <div class="section-title"><span>试着说</span></div>
      <div class="chips">
        <button v-for="ex in examples" :key="ex" class="chip" type="button" @click="text = ex">
          {{ ex }}
        </button>
      </div>
      <button class="btn btn--ghost btn--block" type="button" style="margin-top: 8px" @click="openManual">
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
  </div>
</template>
