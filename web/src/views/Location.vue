<script setup>
/**
 * 位置浏览（T3.8）：同一路由两种呈现。
 * 手机：逐层下钻（子位置列表 + 当前位置的物品）。
 * 桌面：左侧栏已有位置树，这里只显示当前节点的内容，物品用表格行。
 * 两者共用同一份数据，不存在「手机看得到、电脑看不到」。
 */
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get } from '../api.js';
import { store, childLocations } from '../store.js';
import ItemCard from '../components/ItemCard.vue';
import Empty from '../components/Empty.vue';

const route = useRoute();
const router = useRouter();

const items = ref([]);
const loading = ref(false);
const errorText = ref('');

const currentId = computed(() => (route.params.id ? Number(route.params.id) : null));

const currentNode = computed(() => {
  if (currentId.value == null) return null;
  const walk = (nodes) => {
    for (const n of nodes) {
      if (Number(n.id) === currentId.value) return n;
      const hit = walk(n.children || []);
      if (hit) return hit;
    }
    return null;
  };
  return walk(store.tree);
});

const parentId = computed(() => {
  const node = currentNode.value;
  return node && node.parentId != null ? Number(node.parentId) : null;
});

const children = computed(() => childLocations(currentId.value));

const totalQty = computed(() => items.value.reduce((sum, it) => sum + Number(it.totalQty || 0), 0));

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    items.value = await get('/items', currentId.value == null ? {} : { locationId: currentId.value });
  } catch (err) {
    errorText.value = err.message || '加载失败';
    items.value = [];
  } finally {
    loading.value = false;
  }
}

watch(currentId, load, { immediate: true });

function goParent() {
  if (parentId.value == null) router.push({ name: 'location' });
  else router.push({ name: 'location', params: { id: parentId.value } });
}
</script>

<template>
  <div>
    <div class="page-head">
      <button v-if="currentId != null" class="btn btn--ghost" type="button" @click="goParent">← 上一层</button>
      <h2 class="page-title">{{ currentNode ? currentNode.name : '全部物品' }}</h2>
    </div>

    <p v-if="errorText" class="card">{{ errorText }}</p>

    <div v-if="children.length" class="section-title"><span>子位置</span></div>
    <div v-if="children.length" class="list">
      <RouterLink
        v-for="child in children"
        :key="child.id"
        :to="{ name: 'location', params: { id: child.id } }"
        class="row"
      >
        <div class="row__main">
          <div class="row__title">{{ child.name }}</div>
        </div>
        <div class="row__side muted">→</div>
      </RouterLink>
    </div>

    <div class="section-title">
      <span>物品（{{ items.length }} 种 · {{ totalQty }} 件）</span>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <Empty v-else-if="!items.length" icon="📦" text="这里还没有东西" hint="用右下角的 + 记一笔" />
    <div v-else class="list list--table">
      <RouterLink
        v-for="it in items"
        :key="it.id"
        :to="{ name: 'item', params: { id: it.id } }"
        class="row-link"
      >
        <ItemCard :item="it" />
      </RouterLink>
    </div>
  </div>
</template>
