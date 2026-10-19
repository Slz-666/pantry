/**
 * 提醒扫描：到期 / 开封到期 / 低库存。
 *
 * 设计要点：
 * - 扫描是「幂等」的：重复扫不会生成重复提醒，靠 alert 的唯一键
 *   (batch_id, type, due_date) + INSERT IGNORE 天然去重。第二次扫数量不变。
 * - 日期判断在 JS 里按「纯日期字符串」做（不碰时区）：DB 里是 DATE，
 *   如果先转成 JS Date 再算天数，服务器时区一漂就整个差一天。
 * - 规则来自 reminder_rule（按分类），没有规则的分类用默认值兜底。
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
 * 扫一遍并写 alert，返回 { created, expired, opened, lowStock }。
 * created 只统计这次真正新插入的条数（INSERT IGNORE 的 affectedRows）。
 */
export async function scanAlerts(tenantId) {
  const rules = await loadRules(tenantId);
  const stats = { created: 0, expire: 0, opened: 0, lowStock: 0 };

  // 1) 到期：active 且还有剩余量的批次
  const expiring = await query(
    `SELECT b.id AS batch_id, b.expire_at, b.qty, i.category
     FROM batch b
     JOIN item i ON i.id = b.item_id AND i.tenant_id = b.tenant_id
     WHERE b.tenant_id = ? AND b.status = 'active' AND b.qty > 0 AND b.expire_at IS NOT NULL`,
    [tenantId],
  );
  for (const row of expiring) {
    const rule = rules.get(row.category) || { days: DEFAULT_DAYS };
    const threshold = Math.max(...rule.days, 0);
    const daysLeft = Math.round(
      (Date.parse(`${row.expire_at}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86400000,
    );
    if (daysLeft > threshold) continue;
    const res = await query(
      "INSERT IGNORE INTO alert (tenant_id, batch_id, type, due_date) VALUES (?, ?, 'expire', ?)",
      [tenantId, row.batch_id, row.expire_at],
    );
    if (res.affectedRows) {
      stats.created += 1;
      stats.expire += 1;
    }
  }

  // 2) 开封到期：opened_at + N 天
  const opened = await query(
    `SELECT b.id AS batch_id, b.opened_at, i.category
     FROM batch b
     JOIN item i ON i.id = b.item_id AND i.tenant_id = b.tenant_id
     WHERE b.tenant_id = ? AND b.status = 'active' AND b.qty > 0 AND b.opened_at IS NOT NULL`,
    [tenantId],
  );
  const now = today();
  for (const row of opened) {
    const rule = rules.get(row.category) || {};
    const days = rule.openedDays ?? DEFAULT_OPENED_DAYS;
    const due = addDays(String(row.opened_at), days);
    if (due > now) continue;
    const res = await query(
      "INSERT IGNORE INTO alert (tenant_id, batch_id, type, due_date) VALUES (?, ?, 'opened_expire', ?)",
      [tenantId, row.batch_id, due],
    );
    if (res.affectedRows) {
      stats.created += 1;
      stats.opened += 1;
    }
  }

  // 3) 低库存：item 设了阈值且剩余总量 <= 阈值
  // 注意：alert 表要求 batch_id 非空，低库存不是批次级事件，
  // 这里挂在该 item 剩余量最少的那个 active 批次上；没有批次就跳过（说明压根没买过）。
  const low = await query(
    `SELECT i.id AS item_id, i.low_stock_threshold,
            COALESCE(SUM(b.qty), 0) AS total,
            MIN(b.id) AS batch_id
     FROM item i
     LEFT JOIN batch b ON b.item_id = i.id AND b.tenant_id = i.tenant_id AND b.status = 'active'
     WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND i.low_stock_threshold IS NOT NULL
     GROUP BY i.id, i.low_stock_threshold
     HAVING total <= i.low_stock_threshold`,
    [tenantId],
  );
  for (const row of low) {
    if (!row.batch_id) continue;
    const res = await query(
      "INSERT IGNORE INTO alert (tenant_id, batch_id, type, due_date) VALUES (?, ?, 'low_stock', ?)",
      [tenantId, row.batch_id, now],
    );
    if (res.affectedRows) {
      stats.created += 1;
      stats.lowStock += 1;
    }
  }

  return stats;
}
