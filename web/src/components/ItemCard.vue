<script setup>
/**
 * 物品卡片：手机一行一张卡片，桌面一行表格（样式由父容器的 .list--table 决定）。
 * 只负责展示，点击交给外层 RouterLink。
 *
 * 低库存（F-1.9）：数量标红 + 「该补货」徽章。判断依据是后端给的 lowStock 布尔，
 * 前端不再自己拿阈值比大小——不然「提醒说缺货、列表不标红」这种不一致还会回来。
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
        <span v-if="item.lowStock" class="badge badge--danger">该补货</span>
      </div>
      <div class="row__sub">
        <span v-if="item.locationName">{{ item.locationName }}</span>
        <span v-else>未设置默认位置</span>
        <span> · {{ item.batchCount }} 个批次</span>
        <span v-if="item.barcode"> · {{ item.barcode }}</span>
      </div>
    </div>
    <div class="row__side">
      <div class="row__title" :class="{ 'qty--low': item.lowStock }">{{ item.totalQty }} {{ item.unit }}</div>
      <span :class="expiryClass(item.earliestExpireAt)">{{ expiryText(item.earliestExpireAt) }}</span>
    </div>
  </div>
</template>
