/**
 * 离线写队列（DEV-PLAN T6.5 / T6.7 / T6.8）：
 *
 * 断网时点「用掉一个」不能失败——先把操作记进 IndexedDB 队列、界面立刻变，
 * 联网后按入队顺序重放。重放的安全性靠服务端的 client_op_id 唯一键：
 * 同一条操作重放多少次，库存和流水都只变一次。
 *
 * 三个关键取舍：
 * 1) 串行 flush：同一批按 createdAt 顺序发，避免两个改同一批次的操作乱序落库。
 * 2) 失败分两类：网络错 → 停下等下次触发（不丢队列）；4xx 业务拒绝 → 出队并提示
 *    （再做也不会成功，留着会卡住后面所有操作）。
 * 3) 触发点四个：online、visibilitychange、页面加载、30 秒定时轮询。
 *    安卓上切后台会挂起定时器，所以前两个事件必须都挂上（HANDOFF 已知坑）。
 */
import { api, ApiError, newClientOpId } from '../api.js';
import { pushToast, store } from '../store.js';
import { queueAll, queueCount, queuePush, queueRemove } from './idb.js';

let flushing = false;

function newOpId(prefix) {
  return newClientOpId(prefix);
}

export async function refreshPendingCount() {
  store.pending = await queueCount();
  return store.pending;
}

/** 入队一个写操作，返回队列项 id */
export async function enqueue({ path, method = 'POST', body, label = '' }) {
  const id = newOpId('q');
  await queuePush({ id, path, method, body, label, createdAt: Date.now() });
  await refreshPendingCount();
  return id;
}

/**
 * 统一的写操作入口：能联网就直连，网络失败（或本来就离线）就进队列。
 * 返回 { queued: boolean, data } —— 调用方据此决定提示文案。
 */
export async function submitWrite({ path, method = 'POST', body, label = '' }) {
  if (navigator.onLine === false) {
    await enqueue({ path, method, body, label });
    return { queued: true, data: null };
  }
  try {
    // silent：离线判断由这里负责，网络失败要落到队列上，不要先弹一条「网络不通」
    const data = await api(path, { method, body, silent: true });
    return { queued: false, data };
  } catch (err) {
    // 只有「网络层根本没通」才入队；业务错误（400/409…）如实抛给调用方
    if (err instanceof ApiError && err.code === 'NETWORK') {
      await enqueue({ path, method, body, label });
      return { queued: true, data: null };
    }
    pushToast(err?.message || '操作失败');
    throw err;
  }
}

/**
 * 重放队列。串行、失败分类、结束后刷新计数。
 * 返回 { sent, failed, remaining }
 */
export async function flushQueue() {
  if (flushing) return { sent: 0, failed: 0, remaining: store.pending };
  if (navigator.onLine === false) return { sent: 0, failed: 0, remaining: await refreshPendingCount() };

  flushing = true;
  store.syncing = true;
  let sent = 0;
  let failed = 0;
  try {
    const items = await queueAll();
    for (const item of items) {
      try {
        await api(item.path, { method: item.method, body: item.body, silent: true });
        await queueRemove(item.id);
        sent += 1;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'NETWORK') {
          // 又断网了：剩下的留到下次触发，不丢
          break;
        }
        // 业务拒绝（409 已被处理过、400 参数不合法…）：留着重试也不会成功，出队并提示
        await queueRemove(item.id);
        failed += 1;
        store.syncError = err?.message || '有一条离线操作没能同步';
      }
    }
  } finally {
    flushing = false;
    store.syncing = false;
    await refreshPendingCount();
  }
  const result = { sent, failed, remaining: store.pending };
  if (sent > 0) store.lastSyncAt = Date.now();
  return result;
}

let started = false;

/** 注册四个触发点（只该调一次） */
export async function startSync() {
  if (started) return;
  started = true;

  const onOnline = () => {
    store.online = true;
    void flushQueue();
  };
  const onOffline = () => {
    store.online = false;
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') void flushQueue();
  };

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);

  // 定时兜底：安卓切后台会把定时器挂起，回到前台靠 visibilitychange 补
  setInterval(() => {
    if (navigator.onLine !== false && store.pending > 0) void flushQueue();
  }, 30_000);

  store.online = navigator.onLine !== false;
  await refreshPendingCount();
  void flushQueue();
}
