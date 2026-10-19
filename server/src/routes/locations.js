/**
 * 位置树：列表（组树）、创建、改名/移动、删除。
 *
 * 注意：
 * - 同级重名由数据库唯一键 (tenant_id, parent_key, name) 兜底 —— parent_key 是
 *   生成列（根节点用 0），因为 MySQL 唯一键里 NULL 不参与去重，根节点会漏判。
 * - 删除前检查子位置和物品批次引用：有引用 → 409，先挪走再删（外键 RESTRICT 兜底）。
 * - 移动防环：不能把位置移到它自己的任意后代下，否则树变成环。
 */
import { query } from '../db.js';
import { fail } from '../lib/http.js';

const NAME_MAX = 32;

/** 取一个位置，不存在返回 null 并已经写过 404 响应。 */
async function getLocationOr404(id, tenantId, reply) {
  const rows = await query(
    'SELECT id, name, parent_id, sort_order FROM location WHERE id = ? AND tenant_id = ?',
    [id, tenantId],
  );
  if (!rows.length) {
    fail(reply, 404, 'NOT_FOUND', '位置不存在');
    return null;
  }
  return rows[0];
}

/** 递归 CTE：某位置自身 + 全部后代的 id 集合（位置过滤、防环都要用）。 */
export async function subtreeIds(rootId, tenantId) {
  const rows = await query(
    `WITH RECURSIVE sub AS (
       SELECT id FROM location WHERE id = ? AND tenant_id = ?
       UNION ALL
       SELECT l.id FROM location l JOIN sub s ON l.parent_id = s.id WHERE l.tenant_id = ?
     )
     SELECT id FROM sub`,
    [rootId, tenantId, tenantId],
  );
  return rows.map((r) => Number(r.id));
}

export default async function locationRoutes(app) {
  // 树：一次查询全部行，应用层组装（家里位置就十来个节点，比递归 CTE 好读）
  app.get('/locations', async (req) => {
    const rows = await query(
      'SELECT id, name, parent_id, sort_order FROM location WHERE tenant_id = ? ORDER BY sort_order, id',
      [req.user.tenantId],
    );
    const map = new Map(
      rows.map((r) => [
        r.id,
        { id: r.id, name: r.name, parentId: r.parent_id, sortOrder: r.sort_order, children: [] },
      ]),
    );
    const roots = [];
    for (const node of map.values()) {
      if (node.parentId && map.has(node.parentId)) map.get(node.parentId).children.push(node);
      else roots.push(node);
    }
    return roots;
  });

  app.post('/locations', async (req, reply) => {
    const { name, parentId = null, sortOrder = 0 } = req.body || {};
    const cleanName = String(name ?? '').trim();
    if (!cleanName) return fail(reply, 400, 'BAD_REQUEST', '位置名称必填');
    if (cleanName.length > NAME_MAX) return fail(reply, 400, 'BAD_REQUEST', `位置名称不能超过 ${NAME_MAX} 字`);
    if (parentId != null) {
      const parent = await query('SELECT id FROM location WHERE id = ? AND tenant_id = ?', [parentId, req.user.tenantId]);
      if (!parent.length) return fail(reply, 400, 'BAD_REQUEST', '父位置不存在');
    }
    try {
      const result = await query(
        'INSERT INTO location (tenant_id, name, parent_id, sort_order) VALUES (?, ?, ?, ?)',
        [req.user.tenantId, cleanName, parentId, Number(sortOrder) || 0],
      );
      return reply.code(201).send({ id: result.insertId });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return fail(reply, 409, 'CONFLICT', '同级下已有同名位置');
      throw err;
    }
  });

  app.patch('/locations/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const loc = await getLocationOr404(id, req.user.tenantId, reply);
    if (!loc) return;

    const { name, parentId, sortOrder } = req.body || {};
    const sets = [];
    const params = [];

    if (name !== undefined) {
      const cleanName = String(name).trim();
      if (!cleanName) return fail(reply, 400, 'BAD_REQUEST', '位置名称不能为空');
      if (cleanName.length > NAME_MAX) return fail(reply, 400, 'BAD_REQUEST', `位置名称不能超过 ${NAME_MAX} 字`);
      sets.push('name = ?');
      params.push(cleanName);
    }
    if (parentId !== undefined) {
      if (parentId !== null) {
        // 防环：新的父位置不能是自己或自己的后代
        const descendants = await subtreeIds(id, req.user.tenantId);
        if (descendants.includes(Number(parentId))) {
          return fail(reply, 400, 'BAD_REQUEST', '不能把位置移到它自己或它的子位置下');
        }
        const parent = await query('SELECT id FROM location WHERE id = ? AND tenant_id = ?', [
          parentId,
          req.user.tenantId,
        ]);
        if (!parent.length) return fail(reply, 400, 'BAD_REQUEST', '父位置不存在');
      }
      sets.push('parent_id = ?');
      params.push(parentId);
    }
    if (sortOrder !== undefined) {
      sets.push('sort_order = ?');
      params.push(Number(sortOrder) || 0);
    }
    if (!sets.length) return { ok: true };

    params.push(id, req.user.tenantId);
    try {
      await query(`UPDATE location SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return fail(reply, 409, 'CONFLICT', '同级下已有同名位置');
      throw err;
    }
    return { ok: true };
  });

  app.delete('/locations/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const loc = await getLocationOr404(id, req.user.tenantId, reply);
    if (!loc) return;

    const kids = await query('SELECT COUNT(*) AS c FROM location WHERE parent_id = ? AND tenant_id = ?', [
      id,
      req.user.tenantId,
    ]);
    if (Number(kids[0].c) > 0) return fail(reply, 409, 'CONFLICT', '该位置下还有子位置，先删除子位置');
    const used = await query('SELECT COUNT(*) AS c FROM batch WHERE location_id = ? AND tenant_id = ?', [
      id,
      req.user.tenantId,
    ]);
    if (Number(used[0].c) > 0) return fail(reply, 409, 'CONFLICT', '该位置下还有物品批次，先挪走再删');

    await query('DELETE FROM location WHERE id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    return { ok: true };
  });
}
