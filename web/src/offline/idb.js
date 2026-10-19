/**
 * 离线用的两个 IndexedDB store（DEV-PLAN T6.3）：
 *
 * - cache：接口快照（今日汇总、位置下物品、物品详情…），读路径先给缓存再拉网络
 * - queue：待同步的写操作（断网点「用掉」时先记下来，联网后按顺序重放）
 *
 * 为什么用 idb-keyval 而不是手写 IDB：这里要的就是一个 KV 存取，
 * 手写 open/upgrade/事务的样板代码对这个项目没有额外价值（事务和行锁的价值在后端）。
 */
import { createStore, del, get, keys, set } from 'idb-keyval';

/**
 * 注意：cache 与 queue 必须是**两个独立的数据库**，不能共用同一个库名。
 * idb-keyval 的 createStore 靠 onupgradeneeded 建 object store，而同一个库名只有第一次打开
 * 会触发升级；两个 createStore 并发打开同一个库时，第二个 store 大概率建不出来，
 * 之后一读就报 "One of the specified object stores was not found"。
 * 这个 bug 在 https 真机验证时抓到的（`.cache/p7-https.mjs`）。
 */
export const cacheStore = createStore('pantry-cache', 'cache');
export const queueStore = createStore('pantry-queue', 'queue');

/** 写快照（带时间戳，方便界面上显示「刚才/几分钟前」） */
export async function putCache(key, value) {
  await set(key, { at: Date.now(), value }, cacheStore);
}

export async function getCache(key) {
  const row = await get(key, cacheStore);
  return row ?? null;
}

/** 入队；同一个 id 覆盖写，天然幂等 */
export async function queuePush(item) {
  await set(item.id, item, queueStore);
}

/** 按入队时间排序取出全部待同步项（flush 必须按序，否则两个改同一批次的操作会乱序） */
export async function queueAll() {
  const ks = await keys(queueStore);
  const rows = await Promise.all(ks.map((k) => get(k, queueStore)));
  return rows.filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
}

export async function queueRemove(id) {
  await del(id, queueStore);
}

export async function queueCount() {
  return (await keys(queueStore)).length;
}
