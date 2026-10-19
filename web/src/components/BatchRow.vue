<script setup>
/**
 * 批次行：一个批次 = 一盒/一袋具体的货，带自己的位置和到期日。
 * 「哪盒先过期」靠它回答，所以到期日与位置必须一行内可见。
 * 单位挂在物品上（batch 表不存 unit），所以由父组件通过 unit 传进来。
 */
import { expiryClass, expiryText } from '../lib/expiry.js';

defineProps({
  batch: { type: Object, required: true },
  unit: { type: String, default: '' },
});
</script>

<template>
  <div class="row">
    <div class="row__main">
      <div class="row__title">
        {{ batch.qty }} {{ batch.unit || unit || '个' }}
        <span v-if="batch.opened" class="badge">已开封</span>
        <span v-if="batch.status && batch.status !== 'active'" class="muted">（{{ batch.status }}）</span>
      </div>
      <div class="row__sub">
        <span>{{ batch.locationName || '未记录位置' }}</span>
        <span v-if="batch.expireAt"> · 到期 {{ batch.expireAt }}</span>
      </div>
    </div>
    <div class="row__side">
      <span :class="expiryClass(batch.expireAt)">{{ expiryText(batch.expireAt) }}</span>
    </div>
  </div>
</template>
