<script setup>
/**
 * 我的：账号、提醒规则、位置管理、分类管理、阶段进度、退出登录。
 *
 * 阶段 8 补了两块「接口早就有了、界面一直没做」的管理面板：
 * - 位置管理（F-5.1）：增 / 改名 / 删 / 拖动排序。拖拽只在桌面顺手，
 *   所以每行同时留了 ↑ ↓ 按钮（手机上靠它排序，不指望长按拖）。
 * - 分类管理（F-5.2）：分类从硬编码白名单搬到了 category 表，这里能加「酒类」这种自己的词。
 *
 * 提醒规则直接改 reminder_rule：days_before 是「提前几天」节点数组，
 * opened_days 是「开封后几天内用完」。改完只影响之后扫描出来的提醒。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get, patch, post, put, del } from '../api.js';
import { pushToast, store, clearAuth, loadLocations } from '../store.js';
import Field from '../components/Field.vue';

const router = useRouter();

const rules = ref([]);
const categories = ref([]);
const categoryList = ref([]);
const busy = ref(false);
const errorText = ref('');

const draft = reactive({ category: '', daysText: '30,7,1,0', openedText: '' });

/* ---------------- 位置管理 ---------------- */

/** 树拍平成「带缩进」的一维列表：拖拽/上下移都按同父级的兄弟组算 */
const flatLocs = computed(() => {
  const out = [];
  const walk = (nodes, depth, parentId) => {
    for (const n of nodes || []) {
      out.push({ id: n.id, name: n.name, depth, parentId, childCount: n.children?.length ?? 0 });
      walk(n.children, depth + 1, n.id);
    }
  };
  walk(store.tree, 0, null);
  return out;
});

const locNew = reactive({ parentId: '', name: '' });
const dragId = ref(0);
const overId = ref(0);
const editing = reactive({ kind: '', id: 0, text: '' });

function startEdit(kind, node) {
  editing.kind = kind;
  editing.id = node.id;
  editing.text = node.name;
}

async function saveEdit() {
  if (!editing.id) return;
  const text = editing.text.trim();
  if (!text) return pushToast('名称不能为空', 'warn');
  busy.value = true;
  try {
    if (editing.kind === 'loc') await patch(`/locations/${editing.id}`, { name: text });
    else await patch(`/categories/${editing.id}`, { name: text });
    editing.id = 0;
    pushToast('已改名', 'ok');
    await reloadAll();
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

async function addLocation() {
  const name = locNew.name.trim();
  if (!name) return pushToast('先写位置名', 'warn');
  busy.value = true;
  try {
    await post('/locations', { name, parentId: locNew.parentId === '' ? null : Number(locNew.parentId) });
    locNew.name = '';
    pushToast(`已添加「${name}」`, 'ok');
    await reloadAll();
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

async function removeLocation(node) {
  if (!window.confirm(`删除位置「${node.name}」？下面还有子位置或物品时会拒绝。`)) return;
  busy.value = true;
  try {
    await del(`/locations/${node.id}`);
    pushToast(`已删除「${node.name}」`, 'ok');
    await reloadAll();
  } catch {
    // 409 的说明（还有子位置/还有批次）由 api.js 弹出
  } finally {
    busy.value = false;
  }
}

/** 把一组兄弟位置的顺序写进 sort_order（拖拽和上下移共用） */
async function saveLocOrder(ids) {
  busy.value = true;
  try {
    for (let i = 0; i < ids.length; i++) {
      await patch(`/locations/${ids[i]}`, { sortOrder: i });
    }
    await loadLocations(get);
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

async function moveLocation(node, delta) {
  const sibs = flatLocs.value.filter((l) => l.parentId === node.parentId).map((l) => l.id);
  const from = sibs.indexOf(node.id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= sibs.length) return;
  sibs.splice(to, 0, sibs.splice(from, 1)[0]);
  await saveLocOrder(sibs);
}

function onDragStart(node) {
  dragId.value = node.id;
}

/** 只允许同父级之间换位：跨层拖会让「位置树」变成猜谜，改动层级请用「加子位置」 */
async function onDrop(node) {
  const from = dragId.value;
  dragId.value = 0;
  overId.value = 0;
  if (!from || from === node.id) return;
  const a = flatLocs.value.find((l) => l.id === from);
  if (!a || a.parentId !== node.parentId) return pushToast('只能在同一层里拖', 'warn');
  const sibs = flatLocs.value.filter((l) => l.parentId === a.parentId).map((l) => l.id);
  const i = sibs.indexOf(from);
  const j = sibs.indexOf(node.id);
  sibs.splice(j, 0, sibs.splice(i, 1)[0]);
  await saveLocOrder(sibs);
}

/* ---------------- 分类管理 ---------------- */

const catNew = ref('');

async function addCategory() {
  const name = catNew.value.trim();
  if (!name) return pushToast('先写分类名', 'warn');
  busy.value = true;
  try {
    await post('/categories', { name });
    catNew.value = '';
    pushToast(`已添加分类「${name}」`, 'ok');
    await reloadAll();
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

async function removeCategory(cat) {
  if (!window.confirm(`删除分类「${cat.name}」？还有物品或提醒规则在用时会被拒绝。`)) return;
  busy.value = true;
  try {
    await del(`/categories/${cat.id}`);
    pushToast(`已删除「${cat.name}」`, 'ok');
    await reloadAll();
  } catch {
    // 409 的说明由 api.js 弹出
  } finally {
    busy.value = false;
  }
}

async function moveCategory(cat, delta) {
  const ids = categoryList.value.map((c) => c.id);
  const from = ids.indexOf(cat.id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  busy.value = true;
  try {
    await put('/categories/order', { ids });
    await load();
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

/* ---------------- 提醒规则 ---------------- */

/** 把接口返回的数组映射成「文本输入框」用的行，避免在模板里做格式转换 */
function toRow(r) {
  return {
    ...r,
    daysText: (r.daysBefore || []).join(','),
    openedText: r.openedDays == null ? '' : String(r.openedDays),
  };
}

function parseDays(text) {
  return String(text)
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 365);
}

async function load() {
  errorText.value = '';
  try {
    const [list, meta] = await Promise.all([get('/reminder-rules'), get('/meta')]);
    rules.value = (list || []).map(toRow);
    categories.value = meta?.categories || [];
    categoryList.value = meta?.categoryList || [];
  } catch (err) {
    errorText.value = err.message || '加载失败';
  }
}

async function reloadAll() {
  await Promise.all([load(), loadLocations(get)]);
}

async function save(rule) {
  const days = parseDays(rule.daysText);
  if (!days.length) return pushToast('至少填一个提前天数，例如 30,7,1,0', 'warn');
  busy.value = true;
  try {
    await patch(`/reminder-rules/${rule.id}`, {
      daysBefore: days,
      openedDays: rule.openedText === '' ? null : Number(rule.openedText),
      enabled: rule.enabled,
    });
    pushToast(`${rule.category}的规则已保存`, 'ok');
    await load();
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

async function addRule() {
  if (!draft.category) return pushToast('先选一个品类', 'warn');
  const days = parseDays(draft.daysText);
  if (!days.length) return pushToast('至少填一个提前天数', 'warn');
  busy.value = true;
  try {
    await post('/reminder-rules', {
      category: draft.category,
      daysBefore: days,
      openedDays: draft.openedText === '' ? null : Number(draft.openedText),
    });
    draft.category = '';
    pushToast('规则已添加', 'ok');
    await load();
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

/** 立刻按当前规则扫一遍，验证规则改得对不对（不用等到早上 8 点） */
async function scanNow() {
  busy.value = true;
  try {
    const r = await post('/jobs/scan');
    pushToast(`扫描完成：新增 ${r?.created ?? 0} 条提醒`, 'ok');
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

function logout() {
  clearAuth();
  router.replace({ name: 'login' });
}

onMounted(reloadAll);
</script>

<template>
  <div>
    <p v-if="errorText" class="card">{{ errorText }}</p>

    <div class="card">
      <div class="section-title"><span>账号</span></div>
      <p>{{ store.member?.displayName || store.member?.username || '未登录' }}</p>
      <p class="muted">
        <template v-if="store.member?.username">账号 {{ store.member.username }} · </template>家里有什么 · 自用版
      </p>
    </div>

    <!-- 位置管理（F-5.1） -->
    <div class="card">
      <div class="section-title">
        <span>位置管理</span>
        <span class="touch-hint">拖动排序 · 手机用 ↑↓</span>
      </div>
      <p class="muted">位置是三层树（家 → 冰箱 → 冷藏）。有子位置或有物品时不允许删除，先挪走再删。</p>

      <div class="mgr">
        <div
          v-for="node in flatLocs"
          :key="node.id"
          class="mgr__row"
          :class="{ 'is-dragging': dragId === node.id, 'is-over': overId === node.id }"
          draggable="true"
          @dragstart="onDragStart(node)"
          @dragend="dragId = 0; overId = 0"
          @dragover.prevent="overId = node.id"
          @dragleave="overId = overId === node.id ? 0 : overId"
          @drop.prevent="onDrop(node)"
        >
          <span class="mgr__grip">⋮⋮</span>
          <span class="mgr__name" :style="{ paddingLeft: `${node.depth * 16}px` }">
            <template v-if="editing.kind === 'loc' && editing.id === node.id">
              <input
                v-model="editing.text"
                class="input"
                style="min-height: 32px"
                @keyup.enter="saveEdit"
              />
            </template>
            <template v-else>{{ node.name }}</template>
          </span>
          <span class="mgr__acts">
            <template v-if="editing.kind === 'loc' && editing.id === node.id">
              <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="saveEdit">存</button>
              <button type="button" class="btn btn--sm" @click="editing.id = 0">取消</button>
            </template>
            <template v-else>
              <button type="button" class="btn btn--sm" :disabled="busy" @click="startEdit('loc', node)">改名</button>
              <button type="button" class="btn btn--sm" :disabled="busy" @click="moveLocation(node, -1)">↑</button>
              <button type="button" class="btn btn--sm" :disabled="busy" @click="moveLocation(node, 1)">↓</button>
              <button type="button" class="btn btn--sm" :disabled="busy" @click="removeLocation(node)">删</button>
            </template>
          </span>
        </div>
      </div>

      <div class="inline-form">
        <select v-model="locNew.parentId" class="input">
          <option value="">加在根层</option>
          <option v-for="l in flatLocs" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
        <input v-model="locNew.name" class="input" placeholder="新位置名，如「冷冻室」" maxlength="32" />
        <button type="button" class="btn btn--primary" :disabled="busy" @click="addLocation">加</button>
      </div>
    </div>

    <!-- 分类管理（F-5.2） -->
    <div class="card">
      <div class="section-title"><span>分类管理</span></div>
      <p class="muted">分类决定录入时的下拉选项和提醒规则；改名会连带更新已有物品。</p>

      <div class="mgr">
        <div v-for="cat in categoryList" :key="cat.id ?? cat.name" class="mgr__row">
          <span class="mgr__name">
            <template v-if="editing.kind === 'cat' && editing.id === cat.id">
              <input v-model="editing.text" class="input" style="min-height: 32px" @keyup.enter="saveEdit" />
            </template>
            <template v-else>{{ cat.name }}</template>
          </span>
          <span class="mgr__acts">
            <template v-if="editing.kind === 'cat' && editing.id === cat.id">
              <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="saveEdit">存</button>
              <button type="button" class="btn btn--sm" @click="editing.id = 0">取消</button>
            </template>
            <template v-else>
              <button type="button" class="btn btn--sm" :disabled="busy || !cat.id" @click="startEdit('cat', cat)">
                改名
              </button>
              <button type="button" class="btn btn--sm" :disabled="busy || !cat.id" @click="moveCategory(cat, -1)">↑</button>
              <button type="button" class="btn btn--sm" :disabled="busy || !cat.id" @click="moveCategory(cat, 1)">↓</button>
              <button type="button" class="btn btn--sm" :disabled="busy || !cat.id" @click="removeCategory(cat)">删</button>
            </template>
          </span>
        </div>
      </div>

      <div class="inline-form">
        <input v-model="catNew" class="input" placeholder="新分类名，如「酒类」" maxlength="32" @keyup.enter="addCategory" />
        <button type="button" class="btn btn--primary" :disabled="busy" @click="addCategory">加</button>
      </div>
    </div>

    <div class="card">
      <div class="section-title">
        <span>提醒规则</span>
        <button type="button" class="btn btn--sm" :disabled="busy" @click="scanNow">立即扫描</button>
      </div>
      <p class="muted">
        提前提醒按品类分开设；「开封后」留空表示不提醒。改完点保存，只影响之后扫出来的提醒。
      </p>

      <div v-for="r in rules" :key="r.id" class="rule">
        <div class="rule__head">
          <span class="row__title">{{ r.category }}</span>
          <label class="rule__toggle">
            <input v-model="r.enabled" type="checkbox" />
            启用
          </label>
          <button type="button" class="btn btn--sm" :disabled="busy" @click="save(r)">保存</button>
        </div>
        <div class="grid-2">
          <Field v-model="r.daysText" label="提前几天（逗号分隔）" placeholder="30,7,1,0" />
          <Field v-model="r.openedText" label="开封后（天）" type="number" inputmode="numeric" placeholder="留空=不提醒" />
        </div>
      </div>

      <div class="rule rule--new">
        <div class="section-title"><span>加一条品类规则</span></div>
        <label class="field">
          <span class="field__label">品类</span>
          <select v-model="draft.category" class="input">
            <option value="">请选择品类</option>
            <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
        <div class="grid-2">
          <Field v-model="draft.daysText" label="提前几天" placeholder="30,7,1,0" />
          <Field v-model="draft.openedText" label="开封后（天）" type="number" inputmode="numeric" placeholder="留空=不提醒" />
        </div>
        <button type="button" class="btn btn--block mt-3" :disabled="busy" @click="addRule">添加规则</button>
      </div>
    </div>

    <div class="card">
      <div class="section-title"><span>阶段进度</span></div>
      <p class="muted">
        0 地基 ✓ · 1 数据层 ✓ · 2 接口层 ✓ · 3 界面骨架 ✓ · 4 录入 Agent ✓ · 5 提醒与清单 ✓ ·
        6 离线 ✓ · 7 手机 ✓ · 8 作品集 ✓ · 9 验收修复 ✓
      </p>
    </div>

    <button class="btn btn--block mt-3" type="button" @click="logout">退出登录</button>
  </div>
</template>
