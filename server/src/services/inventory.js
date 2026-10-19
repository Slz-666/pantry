/**
 * 库存五个操作：in / consume / discard / adjust / move。
 *
 * 硬规则（HANDOFF §10，面试就讲这几条）：
 * - 所有「改数量」的路径必须在事务里先 SELECT ... FOR UPDATE 锁批次，再校验、再更新。
 *   行锁只在事务内有效，所以顺序固定是 getConnection → beginTransaction → FOR UPDATE
 *   → 校验 → UPDATE/INSERT → commit，出错 rollback + release（见 db.js withTransaction）。
 * - 每个写操作都带 client_op_id：同一个 id 重放只入账一次（离线重试的前提），
 *   命中已有流水就原样返回，不重复扣/加。
 * - stock_log 只增不改：qty_before / qty_after 让每一次数量变化都能被流水解释。
 * - 库存数量用 DECIMAL，进出都按两位小数字符串处理，不让 JS 浮点误差混进账。
 * - 服务层只抛 OpError，路由层统一转成 { code, message }，SQL 原文不出现在响应里。
 *
 * 每个操作都有两层：
 *   xxx      —— 自己开事务（单接口调用用这个，幂等检查也在这层）
 *   xxxTx    —— 用调用方给的 conn，假定已在事务里（组合操作，例如
 *               「购物清单入库 = 建批次 + 写流水 + 关清单项」必须整体原子，
 *               不能再套一个事务，否则就是两个独立事务了）
 */
import { query, withTransaction } from '../db.js';

export class OpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** client_op_id 是所有写接口的必填项，缺失直接 400（宁可不做，也不做错账）。 */
export function requireClientOpId(clientOpId) {
  const id = String(clientOpId ?? '').trim();
  if (!id) throw new OpError(400, 'BAD_REQUEST', '缺少 client_op_id（写操作必须带，用于重试幂等）');
  if (id.length > 64) throw new OpError(400, 'BAD_REQUEST', 'client_op_id 最长 64 字符');
  return id;
}

/** DECIMAL(10,2) 的数量：非负数字 → 两位小数字符串。 */
export function qty2(value, field) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) throw new OpError(400, 'BAD_REQUEST', `${field} 必须是非负数字`);
  return v.toFixed(2);
}

function posInt(value, field) {
  const v = Number(value);
  if (!Number.isInteger(v) || v <= 0) throw new OpError(400, 'BAD_REQUEST', `${field} 必须是正整数`);
  return v;
}

/** 事务内锁批次：这是整条链路的并发安全点，别的请求改同一批次会在这里排队。 */
export async function lockBatch(conn, tenantId, batchId) {
  const [rows] = await conn.execute(
    'SELECT id, item_id, location_id, qty, status FROM batch WHERE id = ? AND tenant_id = ? FOR UPDATE',
    [batchId, tenantId],
  );
  if (!rows.length) throw new OpError(404, 'NOT_FOUND', '批次不存在');
  return rows[0];
}

/** 写一条流水（只增不改），返回流水 id。 */
export async function writeLog(conn, log) {
  const [res] = await conn.execute(
    `INSERT INTO stock_log
       (tenant_id, batch_id, item_id, location_id, type, qty_delta, qty_before, qty_after,
        reason, client_op_id, operator_member_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      log.tenantId,
      log.batchId,
      log.itemId,
      log.locationId,
      log.type,
      log.delta,
      log.before,
      log.after,
      log.reason ?? null,
      log.clientOpId,
      log.memberId ?? null,
    ],
  );
  return res.insertId;
}

/** 幂等检查：client_op_id 已经入过账就直接把上次的结果还回去。 */
async function replayIfDuplicate(tenantId, clientOpId) {
  const rows = await query(
    `SELECT id, batch_id, item_id, location_id, type, qty_delta, qty_before, qty_after
     FROM stock_log WHERE client_op_id = ? AND tenant_id = ?`,
    [clientOpId, tenantId],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    idempotent: true,
    logId: r.id,
    batchId: r.batch_id,
    type: r.type,
    qtyDelta: Number(r.qty_delta),
    qtyBefore: Number(r.qty_before),
    qtyAfter: Number(r.qty_after),
  };
}

/**
 * 所有写操作的统一外壳：先查幂等 → 没查到时开事务执行。
 * 并发同 client_op_id 时两个请求可能都过了幂等检查，此时只有一个能写进
 * stock_log（UNIQUE(client_op_id)），另一个撞 ER_DUP_ENTRY，再查一次流水即可。
 */
export async function runWrite(tenantId, clientOpId, fn) {
  const replay = await replayIfDuplicate(tenantId, clientOpId);
  if (replay) return replay;
  try {
    return await withTransaction(fn);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const again = await replayIfDuplicate(tenantId, clientOpId);
      if (again) return again;
    }
    throw err;
  }
}

/* ---------------- in：入库 ---------------- */

/**
 * 入库 Tx 版：新建一个批次 + 一条 in 流水。
 * 一个 item 可以挂多个批次（同一物品买了三次、三个到期日），所以入库永远建新批次。
 */
export async function stockInTx(conn, { tenantId, memberId, itemId, locationId, qty, producedAt, expireAt, openedAt, note, clientOpId }) {
  const iid = posInt(itemId, 'itemId');
  const lid = posInt(locationId, 'locationId');
  const q = qty2(qty, 'qty');
  if (Number(q) <= 0) throw new OpError(400, 'BAD_REQUEST', '入库数量必须大于 0');

  const [itemRows] = await conn.execute(
    'SELECT id FROM item WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [iid, tenantId],
  );
  if (!itemRows.length) throw new OpError(404, 'NOT_FOUND', '物品不存在');
  const [locRows] = await conn.execute('SELECT id FROM location WHERE id = ? AND tenant_id = ?', [lid, tenantId]);
  if (!locRows.length) throw new OpError(404, 'NOT_FOUND', '位置不存在');

  const [res] = await conn.execute(
    `INSERT INTO batch (tenant_id, item_id, location_id, qty, produced_at, expire_at, opened_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, iid, lid, q, producedAt ?? null, expireAt ?? null, openedAt ?? null, note ?? null],
  );
  const batchId = res.insertId;
  const logId = await writeLog(conn, {
    tenantId, batchId, itemId: iid, locationId: lid,
    type: 'in', delta: q, before: '0.00', after: q,
    reason: 'manual', clientOpId, memberId,
  });
  return { idempotent: false, logId, batchId, type: 'in', qtyAfter: Number(q) };
}

export async function stockIn(args) {
  const opId = requireClientOpId(args.clientOpId);
  return runWrite(args.tenantId, opId, (conn) => stockInTx(conn, { ...args, clientOpId: opId }));
}

/* ---------------- consume：消耗 ---------------- */

/** 消耗 Tx 版：数量不足 → 400 且什么都不写。 */
export async function consumeTx(conn, { tenantId, memberId, batchId, qty, reason, clientOpId }) {
  const bid = posInt(batchId, 'batchId');
  const q = qty2(qty, 'qty');
  if (Number(q) <= 0) throw new OpError(400, 'BAD_REQUEST', '消耗数量必须大于 0');

  const b = await lockBatch(conn, tenantId, bid);
  if (b.status !== 'active') throw new OpError(409, 'CONFLICT', '该批次已结束（用完或已丢弃），不能再消耗');
  const before = Number(b.qty);
  if (Number(q) > before) {
    throw new OpError(400, 'BAD_REQUEST', `数量不足：该批次当前只有 ${before}，不能消耗 ${Number(q)}`);
  }
  const after = before - Number(q);
  await conn.execute('UPDATE batch SET qty = ? WHERE id = ? AND tenant_id = ?', [after.toFixed(2), bid, tenantId]);
  if (after <= 0) {
    await conn.execute("UPDATE batch SET status = 'finished' WHERE id = ? AND tenant_id = ?", [bid, tenantId]);
  }
  const logId = await writeLog(conn, {
    tenantId, batchId: bid, itemId: b.item_id, locationId: b.location_id,
    type: 'consume', delta: (-Number(q)).toFixed(2),
    before: before.toFixed(2), after: after.toFixed(2),
    reason, clientOpId, memberId,
  });
  return { idempotent: false, logId, batchId: bid, type: 'consume', qtyBefore: before, qtyAfter: after };
}

export async function consume(args) {
  const opId = requireClientOpId(args.clientOpId);
  return runWrite(args.tenantId, opId, (conn) => consumeTx(conn, { ...args, clientOpId: opId }));
}

/* ---------------- discard：丢弃 ---------------- */

/** 丢弃 Tx 版：qty 不传就丢掉这一批剩下的全部（过期整盒扔的场景）。 */
export async function discardTx(conn, { tenantId, memberId, batchId, qty, reason, clientOpId }) {
  const bid = posInt(batchId, 'batchId');
  const q = qty == null ? null : qty2(qty, 'qty');
  if (q != null && Number(q) <= 0) throw new OpError(400, 'BAD_REQUEST', '丢弃数量必须大于 0');

  const b = await lockBatch(conn, tenantId, bid);
  const before = Number(b.qty);
  if (before <= 0) throw new OpError(409, 'CONFLICT', '该批次已经没有数量可丢弃');
  const amount = q == null ? before : Number(q);
  if (amount > before) throw new OpError(400, 'BAD_REQUEST', `数量不足：该批次当前只有 ${before}`);
  const after = before - amount;
  await conn.execute('UPDATE batch SET qty = ? WHERE id = ? AND tenant_id = ?', [after.toFixed(2), bid, tenantId]);
  if (after <= 0) {
    await conn.execute("UPDATE batch SET status = 'discarded' WHERE id = ? AND tenant_id = ?", [bid, tenantId]);
  }
  const logId = await writeLog(conn, {
    tenantId, batchId: bid, itemId: b.item_id, locationId: b.location_id,
    type: 'discard', delta: (-amount).toFixed(2),
    before: before.toFixed(2), after: after.toFixed(2),
    reason, clientOpId, memberId,
  });
  return { idempotent: false, logId, batchId: bid, type: 'discard', qtyBefore: before, qtyAfter: after };
}

export async function discard(args) {
  const opId = requireClientOpId(args.clientOpId);
  return runWrite(args.tenantId, opId, (conn) => discardTx(conn, { ...args, clientOpId: opId }));
}

/* ---------------- adjust：调账 ---------------- */

/**
 * 调账 Tx 版：把批次剩余数量直接改成新值（盘点对不上的场景）。
 * 和 consume/discard 的区别：这里相信人填的数字，流水里记 delta 让差额可追溯。
 */
export async function adjustTx(conn, { tenantId, memberId, batchId, qty, reason, clientOpId }) {
  const bid = posInt(batchId, 'batchId');
  const q = qty2(qty, 'qty');

  const b = await lockBatch(conn, tenantId, bid);
  const before = Number(b.qty);
  const after = Number(q);
  if (after === before) return { idempotent: false, noop: true, batchId: bid, qtyAfter: before };

  await conn.execute('UPDATE batch SET qty = ? WHERE id = ? AND tenant_id = ?', [after.toFixed(2), bid, tenantId]);
  if (after <= 0 && b.status === 'active') {
    await conn.execute("UPDATE batch SET status = 'finished' WHERE id = ? AND tenant_id = ?", [bid, tenantId]);
  }
  const logId = await writeLog(conn, {
    tenantId, batchId: bid, itemId: b.item_id, locationId: b.location_id,
    type: 'adjust', delta: (after - before).toFixed(2),
    before: before.toFixed(2), after: after.toFixed(2),
    reason, clientOpId, memberId,
  });
  return { idempotent: false, logId, batchId: bid, type: 'adjust', qtyBefore: before, qtyAfter: after };
}

export async function adjust(args) {
  const opId = requireClientOpId(args.clientOpId);
  return runWrite(args.tenantId, opId, (conn) => adjustTx(conn, { ...args, clientOpId: opId }));
}

/* ---------------- move：挪位置 ---------------- */

/** 挪位置 Tx 版：数量不变，但流水里记一笔（qty_delta=0），「什么时候挪到哪」有据可查。 */
export async function moveTx(conn, { tenantId, memberId, batchId, locationId, reason, clientOpId }) {
  const bid = posInt(batchId, 'batchId');
  const lid = posInt(locationId, 'locationId');

  const b = await lockBatch(conn, tenantId, bid);
  if (Number(b.location_id) === lid) return { idempotent: false, noop: true, batchId: bid };
  const [locRows] = await conn.execute('SELECT id FROM location WHERE id = ? AND tenant_id = ?', [lid, tenantId]);
  if (!locRows.length) throw new OpError(404, 'NOT_FOUND', '目标位置不存在');

  await conn.execute('UPDATE batch SET location_id = ? WHERE id = ? AND tenant_id = ?', [lid, bid, tenantId]);
  const qty = Number(b.qty).toFixed(2);
  const logId = await writeLog(conn, {
    tenantId, batchId: bid, itemId: b.item_id, locationId: lid,
    type: 'move', delta: '0.00', before: qty, after: qty,
    reason, clientOpId, memberId,
  });
  return { idempotent: false, logId, batchId: bid, type: 'move', locationId: lid };
}

export async function move(args) {
  const opId = requireClientOpId(args.clientOpId);
  return runWrite(args.tenantId, opId, (conn) => moveTx(conn, { ...args, clientOpId: opId }));
}
