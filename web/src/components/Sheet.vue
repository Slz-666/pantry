<script setup>
/**
 * 底部抽屉（手机）/ 居中弹窗（桌面）。确认卡片、表单都放里面。
 * 只做容器与关闭，不做业务。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
});
const emit = defineEmits(['close']);

function onMaskClick(e) {
  if (e.target === e.currentTarget) emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="sheet-mask" @click="onMaskClick">
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="sheet__head">
          <div class="sheet__title">{{ props.title }}</div>
          <div class="grow"></div>
          <button class="btn btn--ghost" type="button" @click="emit('close')">关闭</button>
        </div>
        <slot />
      </div>
    </div>
  </Teleport>
</template>
