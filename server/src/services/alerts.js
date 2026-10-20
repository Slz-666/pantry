/**
 * 提醒扫描：到期 / 开封到期 / 低库存。
 *
 * 设计要点：
 * - 扫描是「幂等」的：重复扫不会生成重复提醒，靠 alert 的唯一键
 *   (batch_id, type, due_date, days_before) + INSERT IGNORE 天然去重。第二次扫数量不变。
 * - 日期判断在 JS 里按「纯日期字符串」做（不碰时区）：DB 里是 DATE，
 *   如果先转成 JS Date 再算天数，服务器时区一漂就整个差一天。
 * - 规则来自 reminder_rule（按分类），没有规则的分类用默认值兜底。
 *
 * 多节点（T5.2 修正）：days_before 是 [30,7,1,0] 这种节点数组，每个节点各是一条提醒，
 * 不是「取最大提前量只发一条」。但为了不刷屏，一次扫描最多给一个批次补**最紧的那一档**：
 * 还剩 5 天时只补 T-7，等真到 1 天再补 T-1。刚入库就一次冒出 4 条只会让人把提醒关掉。
 */
import { query } from '../db.js';
import { jsonArray } from '../lib/json.js';

const DEFAULT_DAYS = [30, 7, 1, 0]; // 到期前 30/7/1/0 天提醒
const DEFAULT_OPENED_DAYS = 30; // 开封后 30 天提醒

/** 纯日期字符串加天数：'2026-10-19' + 3 → '2026-10-22'（用 UTC 算，避开时区）。 */
export function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** 两个日期字符串相差多少天（b - a），纯日历差 */
function diffDays(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

function today() {
  const now = new Date();
  // 服务器按北京时间跑，这里也按 +08:00 取「今天」，而不是 UTC 的今天
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  return beijing.toISOString().slice(0, 10);
}

async function loadRules(tenantId) {
  const rows = await query(
    'SELECT category, days_before, opened_days FROM reminder_rule WHERE tenant_id = ? AND enabled = 1',
    [tenantId],
  );
  const map = new Map();
  for (const r of rows) {
    // JSON 列已被驱动解析成数组；用 jsonArray 兼容两种返回，避免规则静默失效
    const arr = jsonArray(r.days_before);
    let days = DEFAULT_DAYS;
    if (arr.length) {
      const nums = arr.map(Number).filter(Number.isFinite);
      if (nums.length) days = nums;
    }
    map.set(r.category, {
      days,
      openedDays: r.opened_days == null ? null : Number(r.opened_days),
    });
  }
  return map;
}

/**
 * 补货后关掉该物品的低库存提醒（在入库事务里调用）。
 *
 * 为什么必须做：不关的话「买回来 → 清单还喊缺货 → 再去忽略」，提醒就变成噪音了。
 * 两条语句分别对应两种挂法：有批次的（挂 batch_id）和零库存的（挂 item_id）。
 */
export async function closeLowStockAlerts(conn, tenantId, itemId) {
  await conn.execute(
    `UPDATE alert a
       JOIN batch b ON b.id = a.batch_id
        SET a.status = 'done', a.handled_at = CURRENT_TIMESTAMP
      WHERE a.tenant_id = ? AND a.item_id = ? AND a.type = 'low_stock' AND a.status = 'pending'`,
    [tenantId, itemId],
  );
  await conn.execute(
    `UPDATE alert
        SET status = 'done', handled_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ? AND item_id = ? AND batch_id IS NULL AND type = 'low_stock' AND status = 'pending'`,
    [tenantId, itemId],
  );
}

/**
 * 扫一遍并写 alert，返回 { created, expire, opened, lowStock }。
 * created 只统计这次真正新插入的条数（INSERT IGNORE 的 affectedRows）。
 */
export async function scanAlerts(tenantId) {
  const rules = await loadRules(tenantId);
  const stats = { created: 0, expire: 0, opened: 0, lowStock: 0 };
  const now = today();

  // 1) 到期：active 且还有剩余量的批次，每个提前量节点一条
  const expiring = await query(
    `SELECT b.id AS batch_id, b.item_id, b.expire_at, b.qty, i.category
     FROM batch b
     JOIN item i ON i.id = b.item_id AND i.tenant_id = b.tenant_id
     WHERE b.tenant_id = ? AND b.status = 'active' AND b.qty > 0 AND b.expire_at IS NOT NULL`,
    [tenantId],
  );
  for (const row of expiring) {
    const rule = rules.get(row.category) || { days: DEFAULT_DAYS };
    const nodes = Array.from(new Set(rule.days.map(Number).filter((n) => Number.isFinite(n) && n >= 0))).sort(
      (a, b) => a - b,
    );
    if (!nodes.length) continue;
    const daysLeft = diffDays(row.expire_at, now);
    // 最紧的那一档：daysLeft=5 且有 [0,1,7,30] → 补 T-7；已过期 → 补 T-0
    const node = nodes.find((d) => daysLeft <= d);
    if (node === undefined) continue;

    const res = await query(
      `INSERT IGNORE INTO alert (tenant_id, batch_id, item_id, type, due_date, days_before)
       VALUES (?, ?, ?, 'expire', ?, ?)`,
      [tenantId, row.batch_id, row.item_id, row.expire_at, node],
    );
    if (res.affectedRows) {
      stats.created += 1;
      stats.expire += 1;
    }
  }

  // 2) 开封到期：opened_at + N 天
  const opened = await query(
    `SELECT b.id AS batch_id, b.item_id, b.opened_at, i.category
     FROM batch b
     JOIN item i ON i.id = b.item_id AND i.tenant_id = b.tenant_id
     WHERE b.tenant_id = ? AND b.status = 'active' AND b.qty > 0 AND b.opened_at IS NOT NULL`,
    [tenantId],
  );
  for (const row of opened) {
    const rule = rules.get(row.category) || {};
    const days = rule.openedDays ?? DEFAULT_OPENED_DAYS;
    const due = addDays(String(row.opened_at), days);
    if (due > now) continue;
    const res = await query(
      `INSERT IGNORE INTO alert (tenant_id, batch_id, item_id, type, due_date, days_before)
       VALUES (?, ?, ?, 'opened_expire', ?, 0)`,
      [tenantId, row.batch_id, row.item_id, due],
    );
    if (res.affectedRows) {
      stats.created += 1;
      stats.opened += 1;
    }
  }

  // 3) 低库存：item 设了阈值且剩余总量 <= 阈值
  // 有剩余批次就挂在那个批次上（点「用掉」能直接扣库存）；
  // 零库存（全用完 / 从来没买过）没有批次可挂，就挂 item_id，batch_id 留空——
  // 之前这里直接 `continue` 跳过，导致「购物建议说缺货、提醒里却没有」两套口径。
  const low = await query(
    `SELECT i.id AS item_id, i.low_stock_threshold,
            COALESCE(SUM(b.qty), 0) AS total,
            MIN(CASE WHEN b.qty > 0 THEN b.id END) AS batch_id
     FROM item i
     LEFT JOIN batch b ON b.item_id = i.id AND b.tenant_id = i.tenant_id AND b.status = 'active'
     WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND i.low_stock_threshold IS NOT NULL
     GROUP BY i.id, i.low_stock_threshold
     HAVING total <= i.low_stock_threshold`,
    [tenantId],
  );
  for (const row of low) {
    // 低库存不是「按天记账」的事件：同一样东西只要还有一条待处理的低库存提醒就不再新建。
    // 否则每天扫一次就多一条「抽纸库存不足」，攒几天后提醒列表全是同一个东西。
    // 这里用 NOT EXISTS 而不是依赖唯一键：零库存那条 batch_id 是 NULL，
    // MySQL 唯一键里 NULL 互不冲突，靠唯一键去不了重。
    const res = await query(
      `INSERT INTO alert (tenant_id, batch_id, item_id, type, due_date, days_before)
       SELECT ?, ?, ?, 'low_stock', ?, 0 FROM DUAL
        WHERE NOT EXISTS (
          SELECT 1 FROM alert a2
           WHERE a2.tenant_id = ? AND a2.item_id = ? AND a2.type = 'low_stock' AND a2.status = 'pending'
        )`,
      [tenantId, row.batch_id ?? null, row.item_id, now, tenantId, row.item_id],
    );
    if (res.affectedRows) {
      stats.created += 1;
      stats.lowStock += 1;
    }
  }

  return stats;
}
