<script setup>
/**
 * 录入确认卡片（阶段 4 的主界面，这里先把契约定好）：
 * LLM 只给草稿，人在这里看一眼改错 → 点「确认入库」才真正写库。
 * 草稿里有缺的字段就高亮提示，绝不自动补。
 */
import { reactive, watch } from 'vue';
import Sheet from './Sheet.vue';
import Field from './Field.vue';
import { expiryClass, expiryText } from '../lib/expiry.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  draft: { type: Object, default: () => ({}) },
  question: { type: String, default: '' },
  missing: { type: Array, default: () => [] },
  submitting: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'confirm']);

const form = reactive({
  name: '',
  spec: '',
  qty: '',
  unit: '',
  location: '',
  expireAt: '',
  datePhrase: '',
});

watch(
  () => props.draft,
  (d) => {
    const src = d || {};
    form.name = src.name ?? '';
    form.spec = src.spec ?? '';
    form.qty = src.qty ?? '';
    form.unit = src.unit ?? '';
    form.location = src.locationName || src.locationHint || '';
    form.expireAt = src.expireAt ?? '';
    form.datePhrase = src.datePhrase ?? '';
  },
  { immediate: true },
);

function isMissing(field) {
  return props.missing.includes(field);
}

function submit() {
  emit('confirm', { ...form });
}
</script>

<template>
  <Sheet :open="props.open" title="确认一下" @close="emit('close')">
    <div class="form">
      <p v-if="props.question" class="card">{{ props.question }}</p>

      <Field v-model="form.name" label="名称" :class="{ 'is-missing': isMissing('name') }" />
      <Field v-model="form.spec" label="规格" />
      <Field v-model="form.qty" label="数量" type="number" inputmode="decimal" min="0" />
      <Field v-model="form.unit" label="单位" placeholder="盒 / 袋 / 瓶…" />
      <Field v-model="form.location" label="位置" />

      <Field v-model="form.expireAt" label="到期日" type="date" />
      <p v-if="form.datePhrase" class="muted">
        你说的「{{ form.datePhrase }}」系统没自动换算，请手动确认到期日
      </p>
      <p v-if="form.expireAt" :class="expiryClass(form.expireAt)">{{ expiryText(form.expireAt) }}</p>

      <div style="display: flex; gap: 8px">
        <button class="btn btn--block" type="button" @click="emit('close')">取消</button>
        <button class="btn btn--primary btn--block" type="button" :disabled="props.submitting" @click="submit">
          {{ props.submitting ? '保存中…' : '确认入库' }}
        </button>
      </div>
    </div>
  </Sheet>
</template>
