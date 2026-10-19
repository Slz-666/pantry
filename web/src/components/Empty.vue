<script setup>
/** 空状态：列表没数据时别留一片白，告诉用户下一步能干什么。 */
defineProps({
  icon: { type: String, default: '📦' },
  text: { type: String, default: '还没有东西' },
  hint: { type: String, default: '' },
});
</script>

<template>
  <div class="empty">
    <div class="empty__icon">{{ icon }}</div>
    <div>{{ text }}</div>
    <div v-if="hint" class="muted">{{ hint }}</div>
    <slot />
  </div>
</template>
