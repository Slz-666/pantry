/**
 * 购物清单：缺什么记一笔，买回来一键入库。
 *
 * 设计要点：
 * - 清单项和「物品档案」不是一回事：可以只写名字还没建物品（item_id 为空），
 *   所以入库时先按名字找同名物品，找不到就自动建档（家里买东西的常见路径）。
 * - POST 要 client_op_id（离线重试幂等，唯一键 tenant_id+client_op_id）。
 * - 「入库」必须整体一个事务：建批次 + 写 in 流水 + 关闭清单项，
 *   任何一步失败都回滚，不会出现「清单关了但库存没加」。
 */
import { query, withTransaction } from '../db.js';
import { fail } from '../lib/http.js';
import { OpError, requireClientOpId, qty2, stockInTx } from '../services/inventory.js';
import { UNIT_LIST } from './items.js';

const STATUS_LIST = ['pending', 'bought', 'cancelled'];
/** 来源只允许这三种：手动 / 低库存建议采纳 / 提醒带出来的 */
const SOURCE_LIST = ['manual', 'low_stock', 'alert'];

function toShopping(row) {
  return {
    id: row.id,
    itemId: row.item_id,
    name: row.name,
    qty: Number(row.qty),
    unit: row.unit,
    status: row.status,
    source: row.source,
    note: row.note,
    doneAt: row.done_at,
    createdAt: row.created_at,
  };
}

function handleOpError(reply, err) {
  if (err instanceof OpError) return fail(reply, err.status, err.code, err.message);
  throw err;
}

export default async function shoppingRoutes(app) {
  app.get('/shopping', async (req) => {
    const { status = 'pending' } = req.query || {};
    const wheres = ['tenant_id = ?'];
    const params = [req.user.tenantId];
    if (status && status !== 'all') {
      wheres.push('status = ?');
      params.push(String(status));
    }
    const rows = await query(
      `SELECT id, item_id, name, qty, unit, status, source, note, done_at, created_at
       FROM shopping_item WHERE ${wheres.join(' AND ')}
       ORDER BY (status = 'pending') DESC, created_at DESC`,
      params,
    );
    return rows.map(toShopping);
  });

  /**
   * T5.6 补货建议：低库存 + 已过期，**先进「待确认」区，不自动进清单**。
   * 为什么不直接写 shopping_item：建议是「算出来的」，会随库存变化；
   * 落库就会留下过期建议，还得再写清理逻辑。这里每次实时算，用户点「加进清单」才落库。
   * 已在待买清单里的物品不再重复建议（按 item_id 或同名判断）。
   */
  app.get('/shopping/suggestions', async (req) => {
    const tenantId = req.user.tenantId;

    const pending = await query(
      "SELECT item_id, name FROM shopping_item WHERE tenant_id = ? AND status = 'pending'",
      [tenantId],
    );
    const skipIds = new Set(pending.filter((p) => p.item_id != null).map((p) => Number(p.item_id)));
    const skipNames = new Set(pending.map((p) => p.name));

    // 低库存：设了补货线的物品，当前有效批次总量 ≤ 补货线
    const low = await query(
      `SELECT i.id, i.name, i.unit, i.low_stock_threshold, COALESCE(SUM(b.qty), 0) AS total
         FROM item i
         LEFT JOIN batch b
           ON b.item_id = i.id AND b.tenant_id = i.tenant_id AND b.status = 'active'
        WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND i.low_stock_threshold IS NOT NULL
        GROUP BY i.id, i.name, i.unit, i.low_stock_threshold
       HAVING total <= i.low_stock_threshold
        ORDER BY (i.low_stock_threshold - total) DESC`,
      [tenantId],
    );

    // 已过期：还有剩余数量的过期批次（过期的直接换新，也该补）
    const expired = await query(
      `SELECT i.id, i.name, i.unit, COUNT(*) AS expired_batches, MIN(b.expire_at) AS first_expired
         FROM item i
         JOIN batch b
           ON b.item_id = i.id AND b.tenant_id = i.tenant_id AND b.status = 'active'
        WHERE i.tenant_id = ? AND i.deleted_at IS NULL
          AND b.qty > 0 AND b.expire_at IS NOT NULL AND b.expire_at < CURDATE()
        GROUP BY i.id, i.name, i.unit
        ORDER BY first_expired`,
      [tenantId],
    );

    const out = [];
    for (const r of low) {
      if (skipIds.has(Number(r.id)) || skipNames.has(r.name)) continue;
      const gap = Number(r.low_stock_threshold) - Number(r.total);
      out.push({
        key: `low-${r.id}`,
        itemId: r.id,
        name: r.name,
        unit: r.unit,
        qty: Math.max(1, Math.ceil(gap)),
        reason: 'low_stock',
        detail: `只剩 ${Number(r.total)} ${r.unit}，低于补货线 ${Number(r.low_stock_threshold)}`,
      });
    }
    for (const r of expired) {
      if (skipIds.has(Number(r.id)) || skipNames.has(r.name)) continue;
      out.push({
        key: `exp-${r.id}`,
        itemId: r.id,
        name: r.name,
        unit: r.unit,
        qty: 1,
        reason: 'expired',
        detail: `${r.expired_batches} 个批次已过期（最早 ${r.first_expired}）`,
      });
    }
    return out;
  });

  app.post('/shopping', async (req, reply) => {
    const body = req.body || {};
    const tenantId = req.user.tenantId;
    try {
      const clientOpId = requireClientOpId(body.clientOpId);
      const name = String(body.name ?? '').trim();
      if (!name) return fail(reply, 400, 'BAD_REQUEST', '清单项名称必填');
      if (name.length > 64) return fail(reply, 400, 'BAD_REQUEST', '清单项名称不能超过 64 字');
      const unit = String(body.unit ?? '个');
      if (!UNIT_LIST.includes(unit)) return fail(reply, 400, 'BAD_REQUEST', `单位只能是：${UNIT_LIST.join('/')}`);
      const qty = qty2(body.qty ?? 1, 'qty');
      if (Number(qty) <= 0) return fail(reply, 400, 'BAD_REQUEST', '数量必须大于 0');

      const source = String(body.source ?? 'manual');
      if (!SOURCE_LIST.includes(source)) {
        return fail(reply, 400, 'BAD_REQUEST', `来源只能是：${SOURCE_LIST.join('/')}`);
      }
      // itemId 是可选的「关联物品档案」，给了就必须是本租户还没删的
      let itemId = null;
      if (body.itemId != null) {
        itemId = Number(body.itemId);
        if (!Number.isInteger(itemId) || itemId <= 0) return fail(reply, 400, 'BAD_REQUEST', 'itemId 不合法');
        const own = await query('SELECT id FROM item WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [
          itemId,
          tenantId,
        ]);
        if (!own.length) return fail(reply, 400, 'BAD_REQUEST', '关联的物品不存在');
      }

      // 幂等：同一个 client_op_id 重放时返回已存在的那条
      const existing = await query(
        'SELECT id FROM shopping_item WHERE tenant_id = ? AND client_op_id = ?',
        [tenantId, clientOpId],
      );
      if (existing.length) return reply.code(200).send({ id: existing[0].id, idempotent: true });

      try {
        const res = await query(
          `INSERT INTO shopping_item (tenant_id, item_id, name, qty, unit, source, client_op_id, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [tenantId, itemId, name, qty, unit, source, clientOpId, body.note ?? null],
        );
        return reply.code(201).send({ id: res.insertId });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          const again = await query('SELECT id FROM shopping_item WHERE tenant_id = ? AND client_op_id = ?', [
            tenantId,
            clientOpId,
          ]);
          if (again.length) return reply.code(200).send({ id: again[0].id, idempotent: true });
        }
        throw err;
      }
    } catch (err) {
      return handleOpError(reply, err);
    }
  });

  app.patch('/shopping/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const tenantId = req.user.tenantId;
    const rows = await query('SELECT id, status FROM shopping_item WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!rows.length) return fail(reply, 404, 'NOT_FOUND', '清单项不存在');

    const body = req.body || {};
    try {
      requireClientOpId(body.clientOpId);
      const sets = [];
      const params = [];
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return fail(reply, 400, 'BAD_REQUEST', '名称不能为空');
        sets.push('name = ?');
        params.push(name);
      }
      if (body.qty !== undefined) {
        const qty = qty2(body.qty, 'qty');
        if (Number(qty) <= 0) return fail(reply, 400, 'BAD_REQUEST', '数量必须大于 0');
        sets.push('qty = ?');
        params.push(qty);
      }
      if (body.unit !== undefined) {
        if (!UNIT_LIST.includes(String(body.unit))) return fail(reply, 400, 'BAD_REQUEST', `单位只能是：${UNIT_LIST.join('/')}`);
        sets.push('unit = ?');
        params.push(String(body.unit));
      }
      if (body.note !== undefined) {
        sets.push('note = ?');
        params.push(body.note ?? null);
      }
      if (body.status !== undefined) {
        const st = String(body.status);
        if (!STATUS_LIST.includes(st)) {
          return fail(reply, 400, 'BAD_REQUEST', `状态只能是：${STATUS_LIST.join('/')}`);
        }
        sets.push('status = ?');
        params.push(st);
        // done_at 用 SQL 自己生成，不接收前端时间字符串（少一个时区坑）
        sets.push(st === 'pending' ? 'done_at = NULL' : 'done_at = CURRENT_TIMESTAMP');
      }
      if (!sets.length) return { ok: true };

      params.push(id, tenantId);
      await query(`UPDATE shopping_item SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
      return { ok: true };
    } catch (err) {
      return handleOpError(reply, err);
    }
  });

  /**
   * 买回来后入库：一个事务里建批次 + 写 in 流水 + 关清单项。
   * 没关联物品的清单项，先按名字复用同名物品，没有就建档（unit 用清单项的单位）。
   */
  app.post('/shopping/:id/stock', async (req, reply) => {
    const id = Number(req.params.id);
    const tenantId = req.user.tenantId;
    const body = req.body || {};
    try {
      const clientOpId = requireClientOpId(body.clientOpId);
      const locationId = Number(body.locationId);
      if (!Number.isInteger(locationId) || locationId <= 0) {
        return fail(reply, 400, 'BAD_REQUEST', '入库位置必填');
      }
      const qty = body.qty == null ? null : qty2(body.qty, 'qty');

      const out = await withTransaction(async (conn) => {
        const [rows] = await conn.execute(
          'SELECT id, item_id, name, qty, unit, status FROM shopping_item WHERE id = ? AND tenant_id = ? FOR UPDATE',
          [id, tenantId],
        );
        if (!rows.length) throw new OpError(404, 'NOT_FOUND', '清单项不存在');
        const item = rows[0];
        if (item.status === 'bought') {
          // 重复点「已买」：幂等返回，不再建第二个批次
          const prev = await query('SELECT id, batch_id, item_id FROM stock_log WHERE client_op_id = ? AND tenant_id = ?', [
            clientOpId,
            tenantId,
          ]);
          return { idempotent: true, batchId: prev.length ? prev[0].batch_id : null };
        }
        if (item.status !== 'pending') throw new OpError(409, 'CONFLICT', '该清单项已取消，不能再入库');

        // 找物品档案：没关联就按名字找（方案 A：同名即复用，不区分规格），找不到才建档
        let itemId = item.item_id;
        if (!itemId) {
          const [found] = await conn.execute(
            'SELECT id FROM item WHERE tenant_id = ? AND name = ? AND deleted_at IS NULL ORDER BY id LIMIT 1',
            [tenantId, item.name],
          );
          if (found.length) {
            itemId = found[0].id;
          } else {
            const [created] = await conn.execute(
              'INSERT INTO item (tenant_id, name, unit) VALUES (?, ?, ?)',
              [tenantId, item.name, item.unit],
            );
            itemId = created.insertId;
          }
        }

        const inResult = await stockInTx(conn, {
          tenantId,
          memberId: req.user.memberId,
          itemId,
          locationId,
          qty: qty ?? item.qty,
          expireAt: body.expireAt ?? null,
          clientOpId,
        });
        await conn.execute(
          "UPDATE shopping_item SET status = 'bought', done_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?",
          [id, tenantId],
        );
        return { idempotent: false, ...inResult };
      });

      if (out.idempotent) return reply.code(200).send({ ok: true, ...out });
      return reply.code(201).send({ ok: true, ...out });
    } catch (err) {
      return handleOpError(reply, err);
    }
  });
}
