<script setup>
/**
 * 批次行：一个批次 = 一盒/一袋具体的货，带自己的位置和到期日。
 * 「哪盒先过期」靠它回答，所以到期日与位置必须一行内可见。
 * 单位挂在物品上（batch 表不存 unit），所以由父组件通过 unit 传进来。
 *
 * editable 为真时（物品详情页）在行下方挂一组操作按钮：
 * 用掉 1 / 改数量 / 挪位置 / 丢掉。动作本身在父组件里发请求，
 * 这里只负责「点哪一行」，避免每个批次各自持有一份状态。
 */
import { expiryClass, expiryText } from '../lib/expiry.js';

const props = defineProps({
  batch: { type: Object, required: true },
  unit: { type: String, default: '' },
  editable: { type: Boolean, default: false },
});
const emit = defineEmits(['consume', 'adjust', 'move', 'discard']);

const canAct = () => props.editable && props.batch.status === 'active' && Number(props.batch.qty) > 0;
</script>

<template>
  <div class="batch-card">
    <div class="row">
      <div class="row__main">
        <div class="row__title">
          {{ batch.qty }} {{ batch.unit || unit || '个' }}
          <span v-if="batch.opened" class="badge">已开封</span>
          <span v-if="batch.status && batch.status !== 'active'" class="muted">（已用完/丢弃）</span>
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

    <div v-if="canAct()" class="row-actions">
      <button type="button" class="btn btn--sm btn--primary" @click="emit('consume', batch)">
        用掉 1
      </button>
      <button type="button" class="btn btn--sm" @click="emit('adjust', batch)">改数量</button>
      <button type="button" class="btn btn--sm" @click="emit('move', batch)">挪位置</button>
      <button type="button" class="btn btn--sm" @click="emit('discard', batch)">丢掉</button>
    </div>
  </div>
</template>
