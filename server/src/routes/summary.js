/**
 * 今日摘要（PRD 接口契约里的 GET /summary/today）。
 * 首页要在一屏里回答三个问题：家里有多少东西、什么快坏了、待办有几件。
 * 全部走聚合查询，不返回明细列表（列表另有接口，避免一次拉一堆数据）。
 */
import { query } from '../db.js';

export default async function summaryRoutes(app) {
  app.get('/summary/today', async (req) => {
    const tenantId = req.user.tenantId;

    const [stocks] = await query(
      `SELECT
         (SELECT COUNT(*) FROM item WHERE tenant_id = ? AND deleted_at IS NULL) AS item_count,
         (SELECT COUNT(*) FROM batch WHERE tenant_id = ? AND status = 'active' AND qty > 0) AS batch_count,
         (SELECT COUNT(*) FROM batch WHERE tenant_id = ? AND status = 'active' AND qty > 0
            AND expire_at IS NOT NULL AND expire_at BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)) AS expiring_count,
         (SELECT COUNT(*) FROM batch WHERE tenant_id = ? AND status = 'active' AND qty > 0
            AND expire_at IS NOT NULL AND expire_at < CURDATE()) AS expired_count,
         (SELECT COUNT(*) FROM alert WHERE tenant_id = ? AND status = 'pending') AS pending_alert_count,
         (SELECT COUNT(*) FROM shopping_item WHERE tenant_id = ? AND status = 'pending') AS pending_shopping_count`,
      [tenantId, tenantId, tenantId, tenantId, tenantId, tenantId],
    );

    // 快到期（含已过期）：只取前 8 条，首页是概览不是清单
    const expiringRows = await query(
      `SELECT b.id AS batch_id, b.item_id, i.name AS item_name, i.unit, b.qty, b.expire_at,
              b.location_id, l.name AS location_name,
              DATEDIFF(b.expire_at, CURDATE()) AS days_left
       FROM batch b
       JOIN item i ON i.id = b.item_id AND i.tenant_id = b.tenant_id
       JOIN location l ON l.id = b.location_id AND l.tenant_id = b.tenant_id
       WHERE b.tenant_id = ? AND b.status = 'active' AND b.qty > 0
         AND b.expire_at IS NOT NULL AND b.expire_at <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
       ORDER BY b.expire_at, b.id
       LIMIT 8`,
      [tenantId],
    );

    // 位置快捷入口：每个顶级位置下有多少种物品（含子位置）
    const locationRows = await query(
      `WITH RECURSIVE tree AS (
         SELECT id, name AS root_name, id AS root_id
         FROM location WHERE tenant_id = ? AND parent_id IS NULL
         UNION ALL
         SELECT l.id, t.root_name, t.root_id
         FROM location l JOIN tree t ON l.parent_id = t.id
         WHERE l.tenant_id = ?
       )
       SELECT t.root_id AS id, t.root_name AS name,
              COUNT(DISTINCT b.item_id) AS item_count,
              COALESCE(SUM(b.qty), 0) AS qty
       FROM tree t
       LEFT JOIN batch b ON b.location_id = t.id AND b.tenant_id = ? AND b.status = 'active' AND b.qty > 0
       GROUP BY t.root_id, t.root_name
       ORDER BY t.root_id`,
      [tenantId, tenantId, tenantId],
    );

    return {
      stocks: {
        itemCount: Number(stocks.item_count),
        batchCount: Number(stocks.batch_count),
        expiringCount: Number(stocks.expiring_count),
        expiredCount: Number(stocks.expired_count),
        pendingAlertCount: Number(stocks.pending_alert_count),
        pendingShoppingCount: Number(stocks.pending_shopping_count),
      },
      expiring: expiringRows.map((r) => ({
        batchId: r.batch_id,
        itemId: r.item_id,
        itemName: r.item_name,
        unit: r.unit,
        qty: Number(r.qty),
        expireAt: r.expire_at,
        locationId: r.location_id,
        locationName: r.location_name,
        daysLeft: Number(r.days_left),
      })),
      locations: locationRows.map((r) => ({
        id: r.id,
        name: r.name,
        itemCount: Number(r.item_count),
        qty: Number(r.qty),
      })),
    };
  });
}
