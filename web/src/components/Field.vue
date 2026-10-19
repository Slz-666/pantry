<script setup>
/**
 * 表单字段：label + 输入框。用 v-model 双向绑定，
 * 其余 input 属性（type/placeholder/inputmode/autocomplete）通过 attrs 透传。
 */
defineProps({
  label: { type: String, default: '' },
  modelValue: { type: [String, Number], default: '' },
  hint: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

function onInput(e) {
  emit('update:modelValue', e.target.value);
}
</script>

<template>
  <label class="field">
    <span v-if="label" class="field__label">{{ label }}</span>
    <input
      class="input"
      :value="modelValue"
      v-bind="$attrs"
      @input="onInput"
    />
    <span v-if="hint" class="muted">{{ hint }}</span>
  </label>
</template>
