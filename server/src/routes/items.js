/**
 * 物品档案：列表（聚合数量/最早效期）、详情（含批次）、创建、修改、软删。
 *
 * 注意：
 * - 列表的 totalQty / earliestExpireAt 由 batch 聚合得出，同一物品多批次只算一次物品行。
 * - locationId 过滤按「位置及其全部子位置」筛（递归 CTE 取子树），且只列出该位置下
 *   有剩余量的物品（HAVING totalQty > 0）——"冰箱里有什么"不该出现空的物品档案。
 * - 重名由唯一键 (tenant_id, name_key) 兜底，捕获 ER_DUP_ENTRY 返回 409。
 * - 删除是软删（deleted_at），历史批次与流水永远保留；有剩余量时 409 先清空。
 */
import { query } from '../db.js';
import { fail } from '../lib/http.js';
import { jsonArray } from '../lib/json.js';
import { subtreeIds } from './locations.js';
// 单位/分类白名单只有一份（在 normalize.js）：录入校验和手工编辑必须同一套标准，
// 否则会出现「Agent 能录进去、手工改不回来」的割裂。
import { CATEGORY_LIST, UNIT_LIST } from '../services/normalize.js';

export { CATEGORY_LIST, UNIT_LIST };

function toItem(row) {
  return {
    id: row.id,
    name: row.name,
    spec: row.spec,
    unit: row.unit,
    category: row.category,
    aliases: safeJson(row.aliases),
    defaultLocationId: row.default_location_id,
    locationName: row.location_name ?? null,
    shelfLifeDays: row.shelf_life_days,
    lowStockThreshold: row.low_stock_threshold,
    note: row.note,
    totalQty: Number(row.total_qty ?? 0),
    earliestExpireAt: row.earliest_expire_at,
    batchCount: Number(row.batch_count ?? 0),
  };
}

/** 兼容旧字段：aliases 是 JSON 列，mysql2 直接给数组，字符串老数据也要能读 */
function safeJson(text) {
  return jsonArray(text);
}

function validUnit(unit) {
  return unit == null || UNIT_LIST.includes(unit);
}
function validCategory(category) {
  return category == null || CATEGORY_LIST.includes(category);
}

export default async function itemRoutes(app) {
  // 列表：支持 q（名字/别名模糊）、category、locationId（含子位置）、expiringIn（N 天内到期）
  app.get('/items', async (req) => {
    const { q, category, locationId, expiringIn, limit = 50, offset = 0 } = req.query || {};
    const tenantId = req.user.tenantId;

    // 占位符按 SQL 文本里出现的顺序排：JOIN 里的（位置子树）在 WHERE 之前，
    // 所以两段参数分开攒，最后合并——混在一起会因为顺序错位静默查出空结果。
    const onParams = [];
    const joinConds = ['b.item_id = i.id', 'b.tenant_id = i.tenant_id'];
    const wheres = ['i.tenant_id = ?', 'i.deleted_at IS NULL'];
    const params = [tenantId];

    if (q) {
      wheres.push('(i.name LIKE ? OR i.aliases LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like);
    }
    if (category) {
      wheres.push('i.category = ?');
      params.push(category);
    }
    if (locationId) {
      const ids = await subtreeIds(Number(locationId), tenantId);
      if (!ids.length) wheres.push('1 = 0');
      else {
        joinConds.push(`b.location_id IN (${ids.map(() => '?').join(',')})`);
        onParams.push(...ids);
      }
    }
    if (expiringIn) {
      wheres.push(`EXISTS (
        SELECT 1 FROM batch eb
        WHERE eb.item_id = i.id AND eb.tenant_id = i.tenant_id AND eb.qty > 0
          AND eb.expire_at IS NOT NULL
          AND eb.expire_at BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
      )`);
      params.push(Number(expiringIn));
    }

    // locationId 过滤时，聚合数字是「该位置子树内」的；否则是全物品
    const having = locationId ? 'HAVING total_qty > 0' : '';

    const sql = `
      SELECT i.id, i.name, i.spec, i.unit, i.category, i.aliases,
             i.default_location_id, i.shelf_life_days, i.low_stock_threshold, i.note,
             MAX(l.name) AS location_name,
             COALESCE(SUM(b.qty), 0) AS total_qty,
             MIN(CASE WHEN b.qty > 0 THEN b.expire_at END) AS earliest_expire_at,
             COUNT(CASE WHEN b.qty > 0 THEN b.id END) AS batch_count
      FROM item i
      LEFT JOIN batch b ON ${joinConds.join(' AND ')}
      LEFT JOIN location l ON l.id = i.default_location_id AND l.tenant_id = i.tenant_id
      WHERE ${wheres.join(' AND ')}
      GROUP BY i.id
      ${having}
      ORDER BY i.name
      LIMIT ? OFFSET ?`;
    params.push(Math.min(Number(limit) || 50, 200), Number(offset) || 0);

    const rows = await query(sql, [...onParams, ...params]);
    return rows.map(toItem);
  });

  // 详情：物品档案 + 全部批次（含位置名），按创建时间倒序
  app.get('/items/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const tenantId = req.user.tenantId;
    const items = await query(
      `SELECT i.id, i.name, i.spec, i.unit, i.category, i.aliases,
              i.default_location_id, i.shelf_life_days, i.low_stock_threshold, i.note,
              MAX(l.name) AS location_name,
              COALESCE(SUM(b.qty), 0) AS total_qty,
              MIN(CASE WHEN b.qty > 0 THEN b.expire_at END) AS earliest_expire_at,
              COUNT(CASE WHEN b.qty > 0 THEN b.id END) AS batch_count
       FROM item i
       LEFT JOIN batch b ON b.item_id = i.id AND b.tenant_id = i.tenant_id
       LEFT JOIN location l ON l.id = i.default_location_id AND l.tenant_id = i.tenant_id
       WHERE i.id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
       GROUP BY i.id`,
      [id, tenantId],
    );
    if (!items.length) return fail(reply, 404, 'NOT_FOUND', '物品不存在');

    const batches = await query(
      `SELECT b.id, b.location_id, l.name AS location_name, b.qty, b.expire_at,
              b.opened_at, b.status, b.note, b.created_at
       FROM batch b
       JOIN location l ON l.id = b.location_id AND l.tenant_id = b.tenant_id
       WHERE b.item_id = ? AND b.tenant_id = ?
       ORDER BY b.created_at DESC`,
      [id, tenantId],
    );
    return {
      item: toItem(items[0]),
      batches: batches.map((b) => ({
        id: b.id,
        locationId: b.location_id,
        locationName: b.location_name,
        qty: Number(b.qty),
        expireAt: b.expire_at,
        opened: !!b.opened_at,
        openedAt: b.opened_at,
        status: b.status,
        note: b.note,
        createdAt: b.created_at,
      })),
    };
  });

  app.post('/items', async (req, reply) => {
    const tenantId = req.user.tenantId;
    const body = req.body || {};
    const name = String(body.name ?? '').trim();
    if (!name) return fail(reply, 400, 'BAD_REQUEST', '物品名称必填');
    if (name.length > 64) return fail(reply, 400, 'BAD_REQUEST', '物品名称不能超过 64 字');
    if (!body.unit) return fail(reply, 400, 'BAD_REQUEST', '单位必填');
    if (!validUnit(body.unit)) return fail(reply, 400, 'BAD_REQUEST', `单位只能是：${UNIT_LIST.join('/')}`);
    if (!validCategory(body.category)) return fail(reply, 400, 'BAD_REQUEST', `分类只能是：${CATEGORY_LIST.join('/')}`);
    if (body.aliases !== undefined && !Array.isArray(body.aliases)) {
      return fail(reply, 400, 'BAD_REQUEST', 'aliases 必须是数组');
    }
    if (body.defaultLocationId != null) {
      const loc = await query('SELECT id FROM location WHERE id = ? AND tenant_id = ?', [
        body.defaultLocationId,
        tenantId,
      ]);
      if (!loc.length) return fail(reply, 400, 'BAD_REQUEST', '默认位置不存在');
    }

    try {
      const result = await query(
        `INSERT INTO item (tenant_id, name, spec, unit, category, aliases, default_location_id,
                           shelf_life_days, low_stock_threshold, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantId,
          name,
          body.spec ?? null,
          body.unit ?? null,
          body.category ?? '其他',
          JSON.stringify(body.aliases ?? []),
          body.defaultLocationId ?? null,
          body.shelfLifeDays ?? null,
          body.lowStockThreshold ?? null,
          body.note ?? null,
        ],
      );
      return reply.code(201).send({ id: result.insertId });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return fail(reply, 409, 'CONFLICT', '同名同规格的物品已存在');
      throw err;
    }
  });

  app.patch('/items/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const tenantId = req.user.tenantId;
    const existing = await query('SELECT id FROM item WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [
      id,
      tenantId,
    ]);
    if (!existing.length) return fail(reply, 404, 'NOT_FOUND', '物品不存在');

    const body = req.body || {};
    // name/unit 在表里是 NOT NULL，PATCH 传 null 会让 SQL 直接 500，这里挡成 400
    if (body.name === null) return fail(reply, 400, 'BAD_REQUEST', '物品名称不能置空');
    if (body.unit === null) return fail(reply, 400, 'BAD_REQUEST', '单位不能置空');
    if (!validUnit(body.unit)) return fail(reply, 400, 'BAD_REQUEST', `单位只能是：${UNIT_LIST.join('/')}`);
    if (!validCategory(body.category)) return fail(reply, 400, 'BAD_REQUEST', `分类只能是：${CATEGORY_LIST.join('/')}`);
    if (body.defaultLocationId != null) {
      const loc = await query('SELECT id FROM location WHERE id = ? AND tenant_id = ?', [body.defaultLocationId, tenantId]);
      if (!loc.length) return fail(reply, 400, 'BAD_REQUEST', '默认位置不存在');
    }

    const map = {
      name: 'name',
      spec: 'spec',
      unit: 'unit',
      category: 'category',
      aliases: 'aliases',
      defaultLocationId: 'default_location_id',
      shelfLifeDays: 'shelf_life_days',
      lowStockThreshold: 'low_stock_threshold',
      note: 'note',
    };
    const sets = [];
    const params = [];
    for (const [field, column] of Object.entries(map)) {
      if (body[field] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(field === 'aliases' ? JSON.stringify(body[field] ?? []) : body[field]);
    }
    if (!sets.length) return { ok: true };

    params.push(id, tenantId);
    try {
      await query(`UPDATE item SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return fail(reply, 409, 'CONFLICT', '同名同规格的物品已存在');
      throw err;
    }
    return { ok: true };
  });

  app.delete('/items/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const tenantId = req.user.tenantId;
    const existing = await query('SELECT id FROM item WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [
      id,
      tenantId,
    ]);
    if (!existing.length) return fail(reply, 404, 'NOT_FOUND', '物品不存在');

    // 还有剩余量时先清空（消耗/丢弃走批次接口），避免归档后仍有"隐形库存"
    const left = await query(
      'SELECT COALESCE(SUM(qty), 0) AS total FROM batch WHERE item_id = ? AND tenant_id = ?',
      [id, tenantId],
    );
    if (Number(left[0].total) > 0) return fail(reply, 409, 'CONFLICT', '该物品还有剩余数量，先消耗或丢弃完再删除');

    await query('UPDATE item SET deleted_at = NOW() WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    return { ok: true };
  });
}
