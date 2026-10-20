/**
 * 批次接口：查询、入库（建新批次）、消耗、丢弃、修改（数量/位置/日期/备注）。
 *
 * 设计要点：
 * - 库存数量只在 inventory.js 里改，路由层不直接 UPDATE batch.qty ——
 *   保证「每次数量变化都能被 stock_log 解释」这条硬规则不被绕开。
 * - 所有写接口必须带 client_op_id；同一个 id 重放只会入账一次。
 * - 列表查询走索引 (tenant_id, expire_at) / (tenant_id, location_id)，
 *   位置过滤用递归 CTE 取子树，和位置页的「整柜数量」口径一致。
 */
import { query } from '../db.js';
import { fail } from '../lib/http.js';
import { OpError, stockIn, stockInTx, runWrite, consume, discard, adjust, move } from '../services/inventory.js';
import { subtreeIds } from './locations.js';
import { UNIT_LIST, todayString } from '../services/normalize.js';
import { categoryNames } from '../services/categories.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BARCODE_RE = /^[0-9A-Za-z-]{4,64}$/;

/** DATE 参数：允许 null（清空），字符串必须是 YYYY-MM-DD，不许让 DB 猜。 */
function dateArg(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value);
  if (!DATE_RE.test(s)) throw new OpError(400, 'BAD_REQUEST', `${field} 格式必须是 YYYY-MM-DD`);
  return s;
}

/**
 * 开封时间的两种入参：
 * - openedAt：手里已经有具体时间（详情页改批次）
 * - opened: true：手工录入的复选框，只表示「已经开封了」，时间就记今天零点
 * 之前只读 openedAt，前端传的 opened 被静默丢掉，导致「开封到期」提醒永远不触发。
 */
function openedArg(body) {
  if (body.openedAt) {
    const s = String(body.openedAt);
    if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
      throw new OpError(400, 'BAD_REQUEST', 'openedAt 格式必须是 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss');
    }
    return s.replace('T', ' ');
  }
  if (body.opened === true) return `${todayString()} 00:00:00`;
  return null;
}

/** 把服务层的 OpError 转成统一 { code, message }；其他错误交给全局处理器。 */
function handleOpError(reply, err) {
  if (err instanceof OpError) return fail(reply, err.status, err.code, err.message);
  throw err;
}

function toBatch(row) {
  return {
    id: row.id,
    itemId: row.item_id,
    itemName: row.item_name,
    locationId: row.location_id,
    locationName: row.location_name,
    qty: Number(row.qty),
    unit: row.unit,
    producedAt: row.produced_at,
    expireAt: row.expire_at,
    opened: !!row.opened_at,
    openedAt: row.opened_at,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default async function batchRoutes(app) {
  // 查询参数里的 id 一律按正整数校验：传 abc 直接 400，
  // 而不是悄悄变成 NaN 查不到东西（前端排查时 400 比空数组好定位）
  function posInt(value, name) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new OpError(400, 'BAD_REQUEST', `${name} 必须是正整数`);
    return n;
  }

  // 批次列表：itemId / locationId（含子树）/ expiringIn（N 天内到期，含已过期，前端用颜色区分）/ status
  app.get('/batches', async (req) => {
    const tenantId = req.user.tenantId;
    const { itemId, locationId, expiringIn, status, limit = 200, offset = 0 } = req.query || {};

    const wheres = ['b.tenant_id = ?'];
    const params = [tenantId];

    if (itemId) {
      wheres.push('b.item_id = ?');
      params.push(posInt(itemId, 'itemId'));
    }
    if (locationId) {
      const ids = await subtreeIds(posInt(locationId, 'locationId'), tenantId);
      if (!ids.length) return [];
      wheres.push(`b.location_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (expiringIn != null && expiringIn !== '') {
      const days = Number(expiringIn);
      if (!Number.isInteger(days) || days < 0) throw new OpError(400, 'BAD_REQUEST', 'expiringIn 必须是非负整数');
      // 走索引 (tenant_id, expire_at)，DATE_ADD 只影响右侧常量
      wheres.push('b.expire_at IS NOT NULL AND b.expire_at <= DATE_ADD(CURDATE(), INTERVAL ? DAY)');
      params.push(days);
    }
    if (status) {
      wheres.push('b.status = ?');
      params.push(String(status));
    }

    const n = Math.min(Number(limit) || 200, 500);
    const off = Math.max(Number(offset) || 0, 0);
    params.push(n, off);

    const rows = await query(
      `SELECT b.id, b.item_id, i.name AS item_name, i.unit, b.location_id, l.name AS location_name,
              b.qty, b.produced_at, b.expire_at, b.opened_at, b.status, b.note, b.created_at, b.updated_at
       FROM batch b
       JOIN item i ON i.id = b.item_id AND i.tenant_id = b.tenant_id
       JOIN location l ON l.id = b.location_id AND l.tenant_id = b.tenant_id
       WHERE ${wheres.join(' AND ')}
       ORDER BY (b.expire_at IS NULL), b.expire_at, b.id
       LIMIT ? OFFSET ?`,
      params,
    );
    return rows.map(toBatch);
  });

  app.get('/batches/:id', async (req, reply) => {
    const rows = await query(
      `SELECT b.id, b.item_id, i.name AS item_name, i.unit, b.location_id, l.name AS location_name,
              b.qty, b.produced_at, b.expire_at, b.opened_at, b.status, b.note, b.created_at, b.updated_at
       FROM batch b
       JOIN item i ON i.id = b.item_id AND i.tenant_id = b.tenant_id
       JOIN location l ON l.id = b.location_id AND l.tenant_id = b.tenant_id
       WHERE b.id = ? AND b.tenant_id = ?`,
      [Number(req.params.id), req.user.tenantId],
    );
    if (!rows.length) return fail(reply, 404, 'NOT_FOUND', '批次不存在');
    return toBatch(rows[0]);
  });

  /**
   * 入库 = 建新批次 + 写 in 流水（一个事务，见 inventory.stockIn）。
   *
   * 两种用法：
   * - 有 itemId：物品已经存在（例如从物品详情页「再买一次」）；
   * - 没有 itemId 但有 name：手动录入的路径。物品还不存在就先建档，
   *   建档和入库在同一个事务里，失败一起回滚，不会留下没人认领的空物品。
   *   匹配口径（方案 A）：同名即复用，规格只在多条同名里挑最接近的那条，
   *   不让「写了规格 / 没写规格」变成两条档案。
   */
  app.post('/batches', async (req, reply) => {
    const body = req.body || {};
    const tenantId = req.user.tenantId;
    const memberId = req.user.memberId;
    try {
      const expireAt = dateArg(body.expireAt, 'expireAt');
      const producedAt = dateArg(body.producedAt, 'producedAt');
      const openedAt = openedArg(body);

      if (body.itemId != null) {
        const out = await stockIn({
          tenantId,
          memberId,
          itemId: body.itemId,
          locationId: body.locationId,
          qty: body.qty,
          producedAt,
          expireAt,
          openedAt,
          note: body.note ?? null,
          clientOpId: body.clientOpId,
        });
        return reply.code(201).send({ ok: true, ...out });
      }

      // 手动录入：先找同名物品，找不到再建，然后入库，全程一个事务 + 一个幂等键
      const name = String(body.name ?? '').trim();
      if (!name) throw new OpError(400, 'BAD_REQUEST', '缺少 itemId，或者给一个物品名称');
      if (name.length > 64) throw new OpError(400, 'BAD_REQUEST', '物品名称最多 64 个字');
      const spec = body.spec ? String(body.spec).trim().slice(0, 32) : null;
      // 单位和分类都要过白名单：以前只有前端限制，直接打接口就能把「吨」「随便」写进库，
      // 之后列表、提醒规则全都被这条脏数据带偏（验收测试实测能绕过）
      const unit = body.unit ? String(body.unit).trim() : '个';
      if (!UNIT_LIST.includes(unit)) {
        throw new OpError(400, 'BAD_REQUEST', `单位只能是：${UNIT_LIST.join('/')}`);
      }
      const names = await categoryNames(tenantId);
      if (body.category != null && body.category !== '' && !names.includes(String(body.category))) {
        throw new OpError(400, 'BAD_REQUEST', `分类不存在，可选：${names.join('/')}`);
      }
      const category = body.category ? String(body.category) : names[0] || '其他';

      const barcode = body.barcode ? String(body.barcode).trim() : null;
      if (barcode && !BARCODE_RE.test(barcode)) {
        throw new OpError(400, 'BAD_REQUEST', '条码只能是 4–64 位的数字、字母或横线');
      }

      // 手动录入时前端要知道最后落到哪个物品档案上（跳详情页 / 建最近常用），
      // 所以把事务里定下来的 itemId 带回外层
      let resolvedItemId = null;
      const out = await runWrite(tenantId, body.clientOpId, async (conn) => {
        let [rows] = await conn.execute(
          `SELECT id, barcode FROM item
            WHERE tenant_id = ? AND name = ? AND deleted_at IS NULL
            ORDER BY (spec <=> ?) DESC, id
            LIMIT 1`,
          [tenantId, name, spec],
        );
        let itemId = rows[0]?.id;
        if (!itemId) {
          try {
            const [ins] = await conn.execute(
              'INSERT INTO item (tenant_id, name, spec, unit, category, barcode) VALUES (?, ?, ?, ?, ?, ?)',
              [tenantId, name, spec, unit, category, barcode],
            );
            itemId = ins.insertId;
          } catch (err) {
            // 并发建同名物品：唯一键挡住后重新取一次，接着入库即可
            if (err.code !== 'ER_DUP_ENTRY') throw err;
            [rows] = await conn.execute(
              `SELECT id, barcode FROM item
                WHERE tenant_id = ? AND name = ? AND deleted_at IS NULL
                ORDER BY (spec <=> ?) DESC, id
                LIMIT 1`,
              [tenantId, name, spec],
            );
            itemId = rows[0]?.id;
            if (!itemId) throw err;
          }
        } else if (barcode && !rows[0].barcode) {
          // 老档案没条码、这次扫了：补上，下次就能直接扫出来
          await conn.execute('UPDATE item SET barcode = ? WHERE id = ? AND tenant_id = ?', [barcode, itemId, tenantId]);
        }
        resolvedItemId = itemId;
        return stockInTx(conn, {
          tenantId,
          memberId,
          itemId,
          locationId: body.locationId,
          qty: body.qty,
          producedAt,
          expireAt,
          openedAt,
          note: body.note ?? null,
          clientOpId: body.clientOpId,
        });
      });
      return reply.code(201).send({ ok: true, itemId: resolvedItemId, ...out });
    } catch (err) {
      return handleOpError(reply, err);
    }
  });

  app.post('/batches/:id/consume', async (req, reply) => {
    const body = req.body || {};
    try {
      const out = await consume({
        tenantId: req.user.tenantId,
        memberId: req.user.memberId,
        batchId: Number(req.params.id),
        qty: body.qty,
        reason: body.reason ?? null,
        clientOpId: body.clientOpId,
      });
      return { ok: true, ...out };
    } catch (err) {
      return handleOpError(reply, err);
    }
  });

  app.post('/batches/:id/discard', async (req, reply) => {
    const body = req.body || {};
    try {
      const out = await discard({
        tenantId: req.user.tenantId,
        memberId: req.user.memberId,
        batchId: Number(req.params.id),
        qty: body.qty,
        reason: body.reason ?? null,
        clientOpId: body.clientOpId,
      });
      return { ok: true, ...out };
    } catch (err) {
      return handleOpError(reply, err);
    }
  });

  /**
   * 修改批次：
   * - qty      → 调账（adjust），写 adjust 流水
   * - locationId → 挪位置（move），写 move 流水（qty_delta=0）
   * - 两者不能同一次改（一个 client_op_id 对应一条流水，拆成两次请求更清楚）
   * - expireAt / producedAt / openedAt / note 是元信息，直接改，不写流水
   */
  app.patch('/batches/:id', async (req, reply) => {
    const body = req.body || {};
    const batchId = Number(req.params.id);
    try {
      if (body.qty !== undefined && body.locationId !== undefined) {
        return fail(reply, 400, 'BAD_REQUEST', '数量和位置请分两次修改（一次写一条流水）');
      }
      let result = null;
      if (body.qty !== undefined) {
        result = await adjust({
          tenantId: req.user.tenantId,
          memberId: req.user.memberId,
          batchId,
          qty: body.qty,
          reason: body.reason ?? null,
          clientOpId: body.clientOpId,
        });
      } else if (body.locationId !== undefined) {
        result = await move({
          tenantId: req.user.tenantId,
          memberId: req.user.memberId,
          batchId,
          locationId: body.locationId,
          reason: body.reason ?? null,
          clientOpId: body.clientOpId,
        });
      }

      // 元信息（日期/备注）：允许单独改，也允许和数量/位置一起改
      // opened 布尔是前端复选框的写法（true=开封、false=取消开封），统一折算成 opened_at
      if (body.opened !== undefined && body.openedAt === undefined) {
        body.openedAt = body.opened ? `${todayString()} 00:00:00` : null;
      }
      const metaFields = { expireAt: 'expire_at', producedAt: 'produced_at', openedAt: 'opened_at', note: 'note' };
      const sets = [];
      const params = [];
      for (const [field, column] of Object.entries(metaFields)) {
        if (body[field] === undefined) continue;
        sets.push(`${column} = ?`);
        if (field === 'note') params.push(body.note ?? null);
        else if (field === 'openedAt') params.push(body.openedAt ?? null);
        else params.push(dateArg(body[field], field));
      }
      if (sets.length) {
        params.push(batchId, req.user.tenantId);
        await query(`UPDATE batch SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
      }
      if (!result && !sets.length) return fail(reply, 400, 'BAD_REQUEST', '没有可修改的字段');
      return { ok: true, ...(result || {}) };
    } catch (err) {
      return handleOpError(reply, err);
    }
  });

  // 流水：只读。物品详情页的「最近流水」和冒烟脚本的幂等断言都靠它。
  app.get('/stock-logs', async (req) => {
    const tenantId = req.user.tenantId;
    const { itemId, batchId, type, limit = 50, offset = 0 } = req.query || {};
    const wheres = ['s.tenant_id = ?'];
    const params = [tenantId];
    if (itemId) {
      wheres.push('s.item_id = ?');
      params.push(posInt(itemId, 'itemId'));
    }
    if (batchId) {
      wheres.push('s.batch_id = ?');
      params.push(posInt(batchId, 'batchId'));
    }
    if (type) {
      wheres.push('s.type = ?');
      params.push(String(type));
    }
    const n = Math.min(Number(limit) || 50, 200);
    const off = Math.max(Number(offset) || 0, 0);
    params.push(n, off);
    const rows = await query(
      `SELECT s.id, s.batch_id, s.item_id, s.location_id, s.type, s.qty_delta, s.qty_before,
              s.qty_after, s.reason, s.client_op_id, s.created_at, s.operator_member_id,
              m.display_name AS operator_name
       FROM stock_log s
       LEFT JOIN member m ON m.id = s.operator_member_id AND m.tenant_id = s.tenant_id
       WHERE ${wheres.join(' AND ')}
       ORDER BY s.id DESC
       LIMIT ? OFFSET ?`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      batchId: r.batch_id,
      itemId: r.item_id,
      locationId: r.location_id,
      type: r.type,
      qtyDelta: Number(r.qty_delta),
      qtyBefore: Number(r.qty_before),
      qtyAfter: Number(r.qty_after),
      reason: r.reason,
      clientOpId: r.client_op_id,
      // 谁改的（F-1.6）：家里不止一个人用时，流水必须能追到人
      operatorId: r.operator_member_id,
      operatorName: r.operator_name ?? null,
      createdAt: r.created_at,
    }));
  });
}
