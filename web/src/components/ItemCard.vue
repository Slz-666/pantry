<script setup>
/**
 * 物品卡片：手机一行一张卡片，桌面一行表格（样式由父容器的 .list--table 决定）。
 * 只负责展示，点击交给外层 RouterLink。
 */
import { expiryClass, expiryText } from '../lib/expiry.js';

defineProps({
  item: { type: Object, required: true },
});
</script>

<template>
  <div class="row">
    <div class="row__main">
      <div class="row__title">
        {{ item.name }}<span v-if="item.spec" class="muted"> · {{ item.spec }}</span>
      </div>
      <div class="row__sub">
        <span v-if="item.locationName">{{ item.locationName }}</span>
        <span v-else>未设置默认位置</span>
        <span> · {{ item.batchCount }} 个批次</span>
      </div>
    </div>
    <div class="row__side">
      <div class="row__title">{{ item.totalQty }} {{ item.unit }}</div>
      <span :class="expiryClass(item.earliestExpireAt)">{{ expiryText(item.earliestExpireAt) }}</span>
    </div>
  </div>
</template>
