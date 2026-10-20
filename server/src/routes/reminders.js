/**
 * 提醒规则（reminder_rule）：按品类设「提前几天提醒」+「开封后几天内用完」。
 *
 * 为什么 days_before 用 JSON 存数组：节点是「提前 30 / 7 / 1 / 0 天」这种列表，
 * 一个字段就能表达完，不用为每个节点建一行、也不用加列。
 *
 * 语义提醒：改规则只影响**以后扫描出来的提醒**。已经生成的 alert 不会自己消失，
 * 因为 alert 的唯一键是 (batch_id, type, due_date)——历史提醒算的是当时那天的账。
 */
import { query } from '../db.js';
import { fail } from '../lib/http.js';
import { jsonArray } from '../lib/json.js';
// 分类可以是用户自定义的（F-5.2），所以校验走 category 表而不是硬编码数组
import { categoryExists, categoryNames } from '../services/categories.js';

const MAX_NODES = 8;

function toRule(row) {
  return {
    id: row.id,
    category: row.category,
    // JSON 列由 mysql2 直接给数组；统一走 jsonArray 兼容「字符串 / 已是数组」两种返回
    daysBefore: jsonArray(row.days_before)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
    openedDays: row.opened_days == null ? null : Number(row.opened_days),
    enabled: Boolean(Number(row.enabled)),
    updatedAt: row.updated_at,
  };
}

/** 校验并规整提前天数：0–365 的整数、去重、降序（扫描时从大到小匹配，顺序稳定便于调试） */
function normalizeDays(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: '至少给一个提醒节点' };
  if (raw.length > MAX_NODES) return { error: `最多 ${MAX_NODES} 个提醒节点` };
  const nums = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 365) return { error: '提醒节点必须是 0–365 的整数天' };
    nums.push(n);
  }
  return { days: Array.from(new Set(nums)).sort((a, b) => b - a) };
}

function normalizeOpened(raw) {
  if (raw == null || raw === '') return { opened: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365) return { error: '开封后天数必须是 1–365 的整数，或留空' };
  return { opened: n };
}

export default async function reminderRoutes(app) {
  app.get('/reminder-rules', async (req) => {
    const rows = await query(
      `SELECT id, category, days_before, opened_days, enabled, updated_at
         FROM reminder_rule WHERE tenant_id = ? ORDER BY id`,
      [req.user.tenantId],
    );
    return rows.map(toRule);
  });

  app.post('/reminder-rules', async (req, reply) => {
    const body = req.body || {};
    const tenantId = req.user.tenantId;
    const category = String(body.category ?? '').trim();
    if (!(await categoryExists(tenantId, category))) {
      const names = await categoryNames(tenantId);
      return fail(reply, 400, 'BAD_REQUEST', `品类不存在，可选：${names.join('/')}`);
    }
    const d = normalizeDays(body.daysBefore);
    if (d.error) return fail(reply, 400, 'BAD_REQUEST', d.error);
    const o = normalizeOpened(body.openedDays);
    if (o.error) return fail(reply, 400, 'BAD_REQUEST', o.error);

    try {
      const res = await query(
        'INSERT INTO reminder_rule (tenant_id, category, days_before, opened_days, enabled) VALUES (?, ?, ?, ?, ?)',
        [tenantId, category, JSON.stringify(d.days), o.opened, body.enabled === false ? 0 : 1],
      );
      return reply.code(201).send({ id: res.insertId });
    } catch (err) {
      // 一个品类一条规则，重复建没意义，直接告诉用户去改已有的那条
      if (err.code === 'ER_DUP_ENTRY') return fail(reply, 409, 'CONFLICT', '这个品类已经有规则了，直接改那条');
      throw err;
    }
  });

  app.patch('/reminder-rules/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const tenantId = req.user.tenantId;
    const body = req.body || {};
    if (!Number.isInteger(id) || id <= 0) return fail(reply, 400, 'BAD_REQUEST', '规则 id 不合法');

    const rows = await query('SELECT id FROM reminder_rule WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!rows.length) return fail(reply, 404, 'NOT_FOUND', '规则不存在');

    const sets = [];
    const params = [];
    if (body.daysBefore !== undefined) {
      const d = normalizeDays(body.daysBefore);
      if (d.error) return fail(reply, 400, 'BAD_REQUEST', d.error);
      sets.push('days_before = ?');
      params.push(JSON.stringify(d.days));
    }
    if (body.openedDays !== undefined) {
      const o = normalizeOpened(body.openedDays);
      if (o.error) return fail(reply, 400, 'BAD_REQUEST', o.error);
      sets.push('opened_days = ?');
      params.push(o.opened);
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(body.enabled ? 1 : 0);
    }
    if (!sets.length) return { ok: true };

    params.push(id, tenantId);
    await query(`UPDATE reminder_rule SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    return { ok: true };
  });
}
