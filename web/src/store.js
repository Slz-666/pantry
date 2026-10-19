/**
 * 全局状态：一个 reactive 对象，不引 Pinia（锁定决策 #6）。
 * 只放「跨页面共享 + 需要缓存」的东西：登录态、位置树、错误提示。
 * 页面自己的数据不进这里，各自在组件里请求。
 */
import { reactive } from 'vue';

const TOKEN_KEY = 'pantry_token';

export const store = reactive({
  token: localStorage.getItem(TOKEN_KEY) || '',
  member: null,
  /** 位置树（后端 GET /locations 已经组好树：{ id, name, parentId, children }） */
  tree: [],
  /** 扁平位置表，方便按 id 取名字 */
  locations: [],
  toasts: [],
});

export function setToken(token) {
  store.token = token || '';
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function clearAuth() {
  setToken('');
  store.member = null;
  store.tree = [];
  store.locations = [];
}

/** 轻量提示：api.js 出错时调用，App.vue 负责渲染，3.5 秒后自己消失。 */
export function pushToast(message, type = 'error') {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  store.toasts.push({ id, message, type });
  setTimeout(() => {
    const i = store.toasts.findIndex((t) => t.id === id);
    if (i >= 0) store.toasts.splice(i, 1);
  }, 3500);
}

/** 位置树加载（登录后 / 位置页增删改后调用，保持侧栏与页面一致） */
export async function loadLocations(apiGet) {
  const tree = await apiGet('/locations');
  store.tree = Array.isArray(tree) ? tree : [];
  const flat = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      flat.push({ id: n.id, name: n.name, parentId: n.parentId ?? null });
      if (Array.isArray(n.children) && n.children.length) walk(n.children);
    }
  };
  walk(store.tree);
  store.locations = flat;
  return store.tree;
}

/** 按 id 找位置名（找不到给空串，绝不显示 undefined） */
export function locationName(id) {
  if (id == null) return '';
  const hit = store.locations.find((l) => Number(l.id) === Number(id));
  return hit ? hit.name : '';
}

/** 找某个位置下的直接子位置（手机逐层下钻用） */
export function childLocations(parentId) {
  const pid = parentId == null ? null : Number(parentId);
  return store.locations.filter((l) => (l.parentId == null ? null : Number(l.parentId)) === pid);
}
