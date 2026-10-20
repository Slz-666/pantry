/**
 * 分类（F-5.2 可自定义）。唯一事实源是 category 表，按租户隔离。
 *
 * 为什么还要留 normalize.js 的 CATEGORY_LIST：
 * - 它是「默认 8 类」的初始值，新租户/刚迁移完的库靠它初始化；
 * - 分类表为空时（老库没跑 006）用它兜底，不能因为少一张表就让录入链路直接失败。
 * 但校验一律以本文件为准——items / extract / reminder-rules 三处都用同一个函数，
 * 避免「下拉里有、保存被拒」或反过来。
 */
import { query } from '../db.js';
import { CATEGORY_LIST } from './normalize.js';

export const NAME_MAX = 32;

export async function listCategories(tenantId) {
  const rows = await query(
    'SELECT id, name, sort_order FROM category WHERE tenant_id = ? ORDER BY sort_order, id',
    [tenantId],
  );
  if (rows.length) {
    return rows.map((r) => ({ id: r.id, name: r.name, sortOrder: Number(r.sort_order) }));
  }
  return CATEGORY_LIST.map((name, i) => ({ id: null, name, sortOrder: i + 1 }));
}

/** 只要名字数组（/meta 与录入归一化都用它） */
export async function categoryNames(tenantId) {
  return (await listCategories(tenantId)).map((c) => c.name);
}

/** 分类是否存在：DB 有就查 DB，DB 空就认默认名单。 */
export async function categoryExists(tenantId, name) {
  const n = String(name ?? '').trim();
  if (!n) return false;
  const rows = await query('SELECT id FROM category WHERE tenant_id = ? AND name = ?', [tenantId, n]);
  if (rows.length) return true;
  const [{ c }] = await query('SELECT COUNT(*) AS c FROM category WHERE tenant_id = ?', [tenantId]);
  return Number(c) === 0 && CATEGORY_LIST.includes(n);
}

/** 新建租户/首次使用时的默认分类（幂等） */
export async function seedCategories(tenantId) {
  const [{ c }] = await query('SELECT COUNT(*) AS c FROM category WHERE tenant_id = ?', [tenantId]);
  if (Number(c) > 0) return 0;
  let n = 0;
  for (let i = 0; i < CATEGORY_LIST.length; i++) {
    await query('INSERT IGNORE INTO category (tenant_id, name, sort_order) VALUES (?, ?, ?)', [
      tenantId,
      CATEGORY_LIST[i],
      i + 1,
    ]);
    n += 1;
  }
  return n;
}
