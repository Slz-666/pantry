/**
 * 提醒接口：列表、一键处理（用掉 / 丢弃 / 忽略）、手动触发扫描。
 *
 * 「处理」的三动作语义（PRD 核心链路之一）：
 * - done    用掉：该批次数量 -1（剩多少不确定时按 1 个算），提醒标记 done
 * - discard 丢弃：该批次剩余量全部丢掉，提醒标记 discarded
 * - ignore  忽略：不动库存，只把提醒标记 ignored
 *
 * 幂等：同一个提醒重复处理直接返回上次结果，不会把库存扣两次。
 * 库存动作复用 inventory.js 的 Tx 版本 —— 和处理提醒本身在同一个事务里，
 * 要么都成，要么都不成。提醒行用 FOR UPDATE 锁住，防并发重复点击。
 */
import { query, withTransaction } from '../db.js';
import { fail } from '../lib/http.js';
import { OpError, consumeTx, discardTx, requireClientOpId } from '../services/inventory.js';
import { scanAlerts } from '../services/alerts.js';

const ACTIONS = ['done', 'discard', 'ignore'];

function toAlert(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    type: row.type,
    dueDate: row.due_date,
    status: row.status,
    handledAt: row.handled_at,
    itemId: row.item_id,
    itemName: row.item_name,
    unit: row.unit,
    locationId: row.location_id,
    locationName: row.location_name,
    qty: Number(row.qty),
    expireAt: row.expire_at,
    daysLeft: row.days_left == null ? null : Number(row.days_left),
  };
}

function handleOpError(reply, err) {
  if (err instanceof OpError) return fail(reply, err.status, err.code, err.message);
  throw err;
}

export default async function alertRoutes(app) {
  app.get('/alerts', async (req) => {
    const { status = 'pending' } = req.query || {};
    const params = [req.user.tenantId];
    let statusCond = '';
    if (status !== 'all') {
      statusCond = ' AND a.status = ?';
      params.push(String(status));
    }
    const rows = await query(
      `SELECT a.id, a.batch_id, a.type, a.due_date, a.status, a.handled_at, a.created_at,
              b.item_id, b.location_id, b.qty, b.expire_at,
              i.name AS item_name, i.unit, l.name AS location_name,
              DATEDIFF(a.due_date, CURDATE()) AS days_left
       FROM alert a
       JOIN batch b ON b.id = a.batch_id AND b.tenant_id = a.tenant_id
       JOIN item i ON i.id = b.item_id AND i.tenant_id = b.tenant_id
       JOIN location l ON l.id = b.location_id AND l.tenant_id = b.tenant_id
       WHERE a.tenant_id = ?${statusCond}
       ORDER BY (a.due_date IS NULL), a.due_date, a.id`,
      params,
    );
    return rows.map(toAlert);
  });

  app.post('/alerts/:id/handle', async (req, reply) => {
    const id = Number(req.params.id);
    const tenantId = req.user.tenantId;
    const body = req.body || {};
    try {
      const clientOpId = requireClientOpId(body.clientOpId);
      const action = String(body.action ?? '');
      if (!ACTIONS.includes(action)) {
        return fail(reply, 400, 'BAD_REQUEST', `action 只能是：${ACTIONS.join('/')}`);
      }
      const targetStatus = action === 'done' ? 'done' : action === 'discard' ? 'discarded' : 'ignored';

      const result = await withTransaction(async (conn) => {
        const [rows] = await conn.execute(
          'SELECT id, batch_id, type, status FROM alert WHERE id = ? AND tenant_id = ? FOR UPDATE',
          [id, tenantId],
        );
        if (!rows.length) throw new OpError(404, 'NOT_FOUND', '提醒不存在');
        const alert = rows[0];

        // 已经处理过：直接返回，不重复扣库存（幂等）
        if (alert.status !== 'pending') {
          return { ok: true, idempotent: true, status: alert.status };
        }
        if (alert.type === 'low_stock') {
          throw new OpError(409, 'CONFLICT', '低库存提醒请去购物清单处理，这里不能直接扣库存');
        }

        let stockOut = null;
        if (action === 'done') {
          const [brows] = await conn.execute('SELECT qty FROM batch WHERE id = ? AND tenant_id = ?', [
            alert.batch_id,
            tenantId,
          ]);
          const remaining = Number(brows[0]?.qty ?? 0);
          if (remaining <= 0) {
            // 批次已经空了，只关提醒
          } else {
            stockOut = await consumeTx(conn, {
              tenantId,
              memberId: req.user.memberId,
              batchId: alert.batch_id,
              qty: Math.min(1, remaining),
              reason: 'alert_done',
              clientOpId,
            });
          }
        } else if (action === 'discard') {
          stockOut = await discardTx(conn, {
            tenantId,
            memberId: req.user.memberId,
            batchId: alert.batch_id,
            qty: null,
            reason: 'alert_discard',
            clientOpId,
          });
        }

        await conn.execute(
          'UPDATE alert SET status = ?, handled_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?',
          [targetStatus, id, tenantId],
        );
        return { ok: true, idempotent: false, status: targetStatus, stock: stockOut };
      });

      return result;
    } catch (err) {
      return handleOpError(reply, err);
    }
  });

  // 手动触发扫描（开发调试、手机端「刷新提醒」用；生产用定时任务调同一个函数）
  app.post('/jobs/scan', async (req) => {
    const stats = await scanAlerts(req.user.tenantId);
    return { ok: true, ...stats };
  });
}
