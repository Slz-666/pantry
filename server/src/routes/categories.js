/**
 * 分类 CRUD（F-5.2）。分类是「自己的词表」，用户可以加「酒类」「母婴」，也能改名排序。
 *
 * 删除规则（宁可拒绝也不留脏数据）：
 * - 该分类下还有物品（未删除的）→ 409，先去物品详情页改分类；
 * - 该分类有提醒规则 → 同样 409（规则挂着它，删了规则就成了孤儿）。
 * 改名是安全的：item.category / reminder_rule.category 存的都是名字，改名要连带更新，
 * 所以这里改名走事务，两处一起改。
 */
import { query, withTransaction } from '../db.js';
import { fail } from '../lib/http.js';
import { NAME_MAX, listCategories } from '../services/categories.js';

function cleanName(name) {
  return String(name ?? '').trim();
}

export default async function categoryRoutes(app) {
  app.get('/categories', async (req) => listCategories(req.user.tenantId));

  app.post('/categories', async (req, reply) => {
    const tenantId = req.user.tenantId;
    const name = cleanName(req.body?.name);
    if (!name) return fail(reply, 400, 'BAD_REQUEST', '分类名称必填');
    if (name.length > NAME_MAX) return fail(reply, 400, 'BAD_REQUEST', `分类名称不能超过 ${NAME_MAX} 字`);

    const rows = await query('SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM category WHERE tenant_id = ?', [
      tenantId,
    ]);
    const sortOrder = Number(rows[0]?.maxOrder || 0) + 1;
    try {
      const res = await query('INSERT INTO category (tenant_id, name, sort_order) VALUES (?, ?, ?)', [
        tenantId,
        name,
        sortOrder,
      ]);
      return reply.code(201).send({ id: res.insertId, name, sortOrder });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return fail(reply, 409, 'CONFLICT', '这个分类已经存在了');
      throw err;
    }
  });

  app.patch('/categories/:id', async (req, reply) => {
    const tenantId = req.user.tenantId;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(reply, 400, 'BAD_REQUEST', '分类 id 不合法');

    const old = await query('SELECT id, name FROM category WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!old.length) return fail(reply, 404, 'NOT_FOUND', '分类不存在');

    const body = req.body || {};
    const sets = [];
    const params = [];
    if (body.name !== undefined) {
      const name = cleanName(body.name);
      if (!name) return fail(reply, 400, 'BAD_REQUEST', '分类名称不能为空');
      if (name.length > NAME_MAX) return fail(reply, 400, 'BAD_REQUEST', `分类名称不能超过 ${NAME_MAX} 字`);
      sets.push('name = ?');
      params.push(name);
    }
    if (body.sortOrder !== undefined) {
      const n = Number(body.sortOrder);
      if (!Number.isInteger(n)) return fail(reply, 400, 'BAD_REQUEST', 'sortOrder 必须是整数');
      sets.push('sort_order = ?');
      params.push(n);
    }
    if (!sets.length) return { ok: true };

    try {
      await withTransaction(async (conn) => {
        params.push(id, tenantId);
        await conn.execute(`UPDATE category SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
        // 改名要连带改物品和提醒规则上的分类名，否则原有物品会指向一个不存在的分类
        if (body.name !== undefined) {
          const name = cleanName(body.name);
          await conn.execute('UPDATE item SET category = ? WHERE tenant_id = ? AND category = ?', [
            name,
            tenantId,
            old[0].name,
          ]);
          await conn.execute('UPDATE reminder_rule SET category = ? WHERE tenant_id = ? AND category = ?', [
            name,
            tenantId,
            old[0].name,
          ]);
        }
      });
      return { ok: true };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return fail(reply, 409, 'CONFLICT', '这个分类已经存在了');
      throw err;
    }
  });

  app.delete('/categories/:id', async (req, reply) => {
    const tenantId = req.user.tenantId;
    const id = Number(req.params.id);
    const rows = await query('SELECT id, name FROM category WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!rows.length) return fail(reply, 404, 'NOT_FOUND', '分类不存在');
    const name = rows[0].name;

    const used = await query(
      'SELECT COUNT(*) AS c FROM item WHERE tenant_id = ? AND category = ? AND deleted_at IS NULL',
      [tenantId, name],
    );
    if (Number(used[0].c) > 0) {
      return fail(reply, 409, 'CONFLICT', `还有 ${Number(used[0].c)} 个物品用着「${name}」，先改掉它们的分类`);
    }
    const ruled = await query('SELECT COUNT(*) AS c FROM reminder_rule WHERE tenant_id = ? AND category = ?', [
      tenantId,
      name,
    ]);
    if (Number(ruled[0].c) > 0) {
      return fail(reply, 409, 'CONFLICT', `「${name}」还有提醒规则，先删掉规则再删分类`);
    }

    await query('DELETE FROM category WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    return { ok: true };
  });

  /** 一次提交整组的排列顺序（拖拽排序落地用）：body { ids: [3,1,2] } */
  app.put('/categories/order', async (req, reply) => {
    const tenantId = req.user.tenantId;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
    if (!ids || !ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
      return fail(reply, 400, 'BAD_REQUEST', 'ids 必须是正整数数组');
    }
    await withTransaction(async (conn) => {
      for (let i = 0; i < ids.length; i++) {
        await conn.execute('UPDATE category SET sort_order = ? WHERE id = ? AND tenant_id = ?', [
          i + 1,
          ids[i],
          tenantId,
        ]);
      }
    });
    return { ok: true };
  });
}
