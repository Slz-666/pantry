<script setup>
/**
 * 录入确认卡片（阶段 4 的主界面）。
 *
 * 职责边界（面试要讲清楚的那条线）：
 * - 大模型只产草稿，字段可能是 null、位置可能没匹配上、日期可能是「下周三」这种没法算的话；
 * - 这个卡片就是「人兜底」的地方：缺什么就地标红让人补，绝不静默补默认值；
 * - 点「确认入库」才发 /extract/:id/confirm，服务端在一个事务里建 item + batch + stock_log。
 *
 * 支持三种进入方式：
 * 1) 正常草稿（可能多条物品）
 * 2) 模型判定「不是录入场景」（refused）→ 告诉用户该去搜索/编辑
 * 3) 抽取失败（failed）→ 原话保留，退成手动表单
 */
import { computed, reactive, ref, watch } from 'vue';
import Sheet from './Sheet.vue';
import { store } from '../store.js';
import { expiryClass, expiryText } from '../lib/expiry.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  /** { draftId, draft, error } —— draft 是后端归一化后的草稿 */
  payload: { type: Object, default: null },
  units: { type: Array, default: () => [] },
  categories: { type: Array, default: () => [] },
  submitting: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'confirm']);

function blank() {
  return {
    name: '',
    spec: '',
    qty: '',
    unit: '',
    category: '',
    locationId: '',
    expireAt: '',
    barcode: '',
    opened: false,
    // 下面这些都是「提示信息」，不参与提交
    locationHint: '',
    datePhrase: '',
    shelfLifeValue: null,
    shelfLifeUnit: null,
    duplicate: null,
    itemName: '',
  };
}

const items = reactive([]);
const refused = ref(false);
const draftError = ref('');
const question = ref('');

watch(
  () => props.payload,
  (p) => {
    items.splice(0, items.length);
    refused.value = false;
    draftError.value = '';
    question.value = '';
    if (!p) return;

    const d = p.draft || {};
    if (p.error) {
      draftError.value = p.error;
    } else if (d.failed) {
      draftError.value = d.error || '这句话没听懂，改成手动填一下';
    }
    refused.value = Boolean(d.refused);
    question.value = d.question || '';

    const list = Array.isArray(d.items) ? d.items : [];
    if (!list.length) {
      // 抽取失败 / 用户主动走手动：给一张空表
      if (!refused.value) items.push(blank());
      return;
    }
    for (const it of list) {
      items.push({
        ...blank(),
        name: it.name || '',
        spec: it.spec || '',
        // qty 为 null 说明模型没听到数量，留空让人填，不默认 1
        qty: it.qty == null ? '' : String(it.qty),
        unit: it.unit || '',
        category: it.category || '',
        locationId: it.locationId == null ? '' : String(it.locationId),
        expireAt: it.expireAt || '',
        barcode: it.barcode || '',
        opened: Boolean(it.opened),
        locationHint: it.locationHint || '',
        datePhrase: it.datePhrase || '',
        shelfLifeValue: it.shelfLifeValue,
        shelfLifeUnit: it.shelfLifeUnit,
        duplicate: it.duplicate || null,
        itemName: it.itemName || '',
      });
    }
  },
  { immediate: true },
);

/** 位置下拉：显示「父 > 子」，让人在手机上也能分清冷藏和冷冻 */
const locOptions = computed(() => {
  const byId = new Map(store.locations.map((l) => [Number(l.id), l]));
  return store.locations.map((l) => {
    const parent = l.parentId != null ? byId.get(Number(l.parentId)) : null;
    return { id: l.id, label: parent ? `${parent.name} > ${l.name}` : l.name };
  });
});

const qtyNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const complete = computed(() =>
  items.length > 0 &&
  items.every(
    (it) =>
      String(it.name).trim() &&
      qtyNumber(it.qty) > 0 &&
      it.unit &&
      it.locationId !== '' &&
      it.locationId !== null,
  ),
);

function submit() {
  if (!complete.value || props.submitting) return;
  emit(
    'confirm',
    items.map((it) => ({
      name: String(it.name).trim(),
      spec: it.spec || null,
      qty: qtyNumber(it.qty),
      unit: it.unit,
      category: it.category || null,
      locationId: Number(it.locationId),
      expireAt: it.expireAt || null,
      // 条码可选：扫一次之后就能按码搜到（F-1.1 / F-1.8）
      barcode: it.barcode ? String(it.barcode).trim() : null,
      opened: Boolean(it.opened),
    })),
  );
}
</script>

<template>
  <Sheet :open="props.open" title="确认一下" @close="emit('close')">
    <div class="form">
      <!-- 1. 模型判定「这不是录入」 -->
      <div v-if="refused" class="entry-note">
        <strong>这句话不是「记东西」</strong>
        <p class="muted">
          模型判断你在问库存或者改数量。查询请用搜索；改数量请进物品详情页改批次。
        </p>
        <button class="btn btn--block mt-2" type="button" @click="emit('close')">
          知道了
        </button>
      </div>

      <template v-else>
        <!-- 2. 抽取失败：原话保留，退手动 -->
        <div v-if="draftError" class="entry-note entry-note--warn">
          <strong>{{ draftError }}</strong>
          <p class="muted">原话已经留着，下面手动填一样能记。</p>
        </div>

        <p v-if="question" class="entry-question">{{ question }}</p>

        <!-- 3. 物品条卡：缺什么标红什么 -->
        <div v-for="(it, i) in items" :key="i" class="item-editor">
          <div class="item-editor__head">
            <span class="item-editor__no">
              第 {{ i + 1 }} 条
              <span v-if="it.itemName && it.itemName !== it.name" class="badge">已有物品</span>
            </span>
            <button
              v-if="items.length > 1"
              class="btn btn--ghost"
              type="button"
              @click="items.splice(i, 1)"
            >
              删掉
            </button>
          </div>

          <div class="item-editor__grid">
            <label class="field">
              <span class="field__label">名称<span v-if="!it.name" class="field__req">必填</span></span>
              <input v-model="it.name" class="input" placeholder="牛奶" />
            </label>

            <label class="field">
              <span class="field__label">规格</span>
              <input v-model="it.spec" class="input" placeholder="250ml" />
            </label>

            <label class="field">
              <span class="field__label">数量<span v-if="!(qtyNumber(it.qty) > 0)" class="field__req">必填</span></span>
              <input v-model="it.qty" class="input" type="number" inputmode="decimal" min="0" step="1" placeholder="2" />
            </label>

            <label class="field">
              <span class="field__label">单位<span v-if="!it.unit" class="field__req">必填</span></span>
              <select v-model="it.unit" class="input">
                <option value="">选单位</option>
                <option v-for="u in props.units" :key="u" :value="u">{{ u }}</option>
              </select>
            </label>

            <label class="field">
              <span class="field__label">位置<span v-if="!it.locationId" class="field__req">必填</span></span>
              <select v-model="it.locationId" class="input">
                <option value="">选位置</option>
                <option v-for="l in locOptions" :key="l.id" :value="String(l.id)">{{ l.label }}</option>
              </select>
            </label>

            <label class="field">
              <span class="field__label">到期日</span>
              <input v-model="it.expireAt" class="input" type="date" />
            </label>

            <label class="field">
              <span class="field__label">条码</span>
              <input v-model="it.barcode" class="input" inputmode="numeric" placeholder="有就填，之后能扫码搜" />
            </label>
          </div>

          <!-- 人兜底的提示：把模型「不敢算」的东西指出来，但不替用户填 -->
          <p v-if="it.locationHint && !it.locationId" class="entry-hint">
            你说的是「{{ it.locationHint }}」，没匹配到位置，请自己选一个
          </p>
          <p v-if="it.datePhrase && !it.expireAt" class="entry-hint">
            你说的「{{ it.datePhrase }}」没有自动换算，请确认到期日
          </p>
          <p v-if="it.shelfLifeValue && !it.expireAt" class="entry-hint">
            保质期 {{ it.shelfLifeValue }}{{ it.shelfLifeUnit || '' }}，但没有生产日期，到期日请自己填
          </p>
          <p v-if="it.expireAt" :class="expiryClass(it.expireAt)">{{ expiryText(it.expireAt) }}</p>
          <p v-if="it.duplicate" class="entry-hint entry-hint--info">
            已有同批次：{{ it.duplicate.expireAt ? `到期 ${it.duplicate.expireAt}` : '无到期日' }}，
            共 {{ it.duplicate.qty }} —— 确认后会作为同一物品的新批次记入（不覆盖原来那批）
          </p>

          <label class="checkbox">
            <input v-model="it.opened" type="checkbox" />
            <span>已经开封</span>
          </label>
        </div>

        <button class="btn btn--ghost" type="button" @click="items.push(blank())">＋ 再加一条</button>

        <p v-if="!complete" class="entry-hint">名称、数量（大于 0）、单位、位置都齐了才能入库</p>

        <div class="row mt-2 row--tight">
          <button class="btn btn--block" type="button" @click="emit('close')">取消</button>
          <button
            class="btn btn--primary btn--block"
            type="button"
            :disabled="!complete || props.submitting"
            @click="submit"
          >
            {{ props.submitting ? '保存中…' : `确认入库${items.length > 1 ? `（${items.length} 条）` : ''}` }}
          </button>
        </div>
      </template>
    </div>
  </Sheet>
</template>
