/**
 * 唯一 HTTP 出口（T3.3）：
 * - 自动带 Authorization
 * - 401 统一清登录态并通知 App 跳登录页（绕开 router 循环依赖，用事件）
 * - 非 2xx 统一抛 ApiError，并在界面上弹一条提示
 * - 所有写操作需要幂等键：调用方用 newClientOpId() 生成
 */
import { store, pushToast, clearAuth } from './store.js';
import { getCache, putCache } from './offline/idb.js';

const BASE = (import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function queryString(params) {
  if (!params) return '';
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export async function api(path, { method = 'GET', body, params, silent = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (store.token) headers['Authorization'] = `Bearer ${store.token}`;

  let res;
  try {
    res = await fetch(`${BASE}${path}${queryString(params)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (!silent) pushToast('网络不通，检查一下连接或后端是否启动');
    throw new ApiError(0, 'NETWORK', '网络异常');
  }

  if (res.status === 401) {
    clearAuth();
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new ApiError(401, 'UNAUTHORIZED', '登录已过期，请重新登录');
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const message = (data && data.message) || `请求失败（${res.status}）`;
    if (!silent) pushToast(message);
    throw new ApiError(res.status, (data && data.code) || 'ERROR', message);
  }
  return data;
}

export const get = (path, params, opts = {}) => api(path, { ...opts, params });
export const post = (path, body, opts = {}) => api(path, { ...opts, method: 'POST', body });
export const patch = (path, body, opts = {}) => api(path, { ...opts, method: 'PATCH', body });
export const del = (path, params, opts = {}) => api(path, { ...opts, method: 'DELETE', params });

/**
 * 客户端操作 ID：离线重试、重复点击都靠它去重（后端唯一键兜底）。
 * DEV-PLAN T6.6 要求用 crypto.randomUUID：同一次点击无论重试几次都是同一个键；
 * 非 HTTPS/老浏览器没有 randomUUID，退回时间戳+随机串（仍然足够唯一）。
 */
export function newClientOpId(prefix = 'op') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/**
 * 读接口的离线路径（T6.4）：先给缓存（厨房里秒开），再拉网络覆盖。
 *
 * apply(data, { cached, at }) 由页面提供：缓存先到就先渲染，网络回来后同一个
 * 回调再跑一次覆盖。网络失败但手上有缓存时不算错误（弱网下这就是正常路径）。
 */
export async function getCached(path, params, apply) {
  const key = `GET ${path}${queryString(params)}`;
  const row = await getCache(key);
  if (row?.value) apply(row.value, { cached: true, at: row.at });
  try {
    const fresh = await api(path, { params, silent: true });
    await putCache(key, fresh);
    apply(fresh, { cached: false, at: Date.now() });
    return fresh;
  } catch (err) {
    if (row?.value) return row.value;
    throw err;
  }
}
