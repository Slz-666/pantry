/**
 * 录入 Agent 的两个接口（PRD 9 / DEV-PLAN T4.4–T4.5）：
 *
 * POST /extract          —— 原话 → 草稿（只写 extraction_log，绝不写业务表）
 * POST /extract/:id/confirm —— 用户确认后的字段 → 一个事务建 item(如需)+batch+stock_log
 * POST /extract/:id/reject  —— 用户放弃这笔草稿
 *
 * 关键约束：
 * - 只产草稿：extract 之后库里业务表一条都不变，用户点确认才落库。
 * - 重复 confirm 返回 409：靠 extraction_log.status 的 FOR UPDATE 判状态，
 *   同一笔草稿不会被重复入库（前端网络重试也不会多扣一次）。
 * - 事务里复用 inventory.js 的 stockInTx，所以「入库」路径只有一份实现：
 *   批次数量、流水、client_op_id 幂等的规则完全一致。
 */
import { query, withTransaction } from '../db.js';
import { fail } from '../lib/http.js';
import { jsonArray } from '../lib/json.js';
import { MAX_STOCK_IN, OpError, stockInTx } from '../services/inventory.js';
import { extractRaw } from '../services/extract.js';
import { addDays, addMonths, isValidDate, normalizeDraft, todayString, UNIT_LIST } from '../services/normalize.js';
import { categoryNames } from '../services/categories.js';

const MAX_TEXT = 500;
const BARCODE_RE = /^[0-9A-Za-z-]{4,64}$/;

/** 位置、物品、存量批次、分类：一次拉齐给归一化用（自用库很小，不做分页）。 */
async function loadContext(tenantId) {
  const [locations, itemRows, batchRows, categories] = await Promise.all([
    query('SELECT id, name, parent_id FROM location WHERE tenant_id = ? ORDER BY sort_order, id', [tenantId]),
    query(
      'SELECT id, name, spec, aliases FROM item WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY id',
      [tenantId],
    ),
    query(
      `SELECT id, item_id, location_id, expire_at, qty FROM batch
       WHERE tenant_id = ? AND status = 'active' AND qty > 0 AND expire_at IS NOT NULL
       ORDER BY id DESC LIMIT 500`,
      [tenantId],
    ),
    categoryNames(tenantId),
  ]);

  return {
    categories,
    locations: locations.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id })),
    items: itemRows.map((r) => ({
      id: r.id,
      name: r.name,
      spec: r.spec,
      // JSON 列已由驱动解析成数组，直接用 jsonArray 兼容两种返回
      aliases: jsonArray(r.aliases),
    })),
    batches: batchRows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      locationId: r.location_id,
      expireAt: r.expire_at,
      qty: Number(r.qty),
    })),
  };
}

/**
 * 到期日换算（确定性，不让模型算）：
 * 给了生产日期 + 保质期 → 日历加法；否则用用户填的到期日；都没有就留空。
 */
export function resolveExpire({ expireAt, producedAt, shelfLifeValue, shelfLifeUnit }) {
  if (isValidDate(expireAt)) return expireAt;
  if (!isValidDate(producedAt)) return null;
  const n = Number(shelfLifeValue);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (shelfLifeUnit) {
    case '天':
    case '日':
      return addDays(producedAt, n);
    case '周':
      return addDays(producedAt, n * 7);
    case '月':
      return addMonths(producedAt, n);
    case '年':
      return addMonths(producedAt, n * 12);
    default:
      return null;
  }
}

export default async function extractRoutes(app) {
  const tenantId = () => 1; // 个人版固定租户；多租户时从 req.user.tenantId 取

  // ---------------------------------------------------------------- 抽取
  app.post('/extract', async (req, reply) => {
    const tenant = req.user?.tenantId ?? tenantId();
    const memberId = req.user?.memberId ?? 1;
    const text = String(req.body?.text ?? '').trim();
    const channel = req.body?.channel === 'voice' ? 'voice' : 'text';

    if (!text) return fail(reply, 400, 'BAD_REQUEST', '说一句话吧，比如「牛奶两盒放冰箱冷藏」');
    if (text.length > MAX_TEXT) return fail(reply, 400, 'BAD_REQUEST', `一次最多 ${MAX_TEXT} 字，太多了拆开记`);

    const today = todayString();
    const startedAt = Date.now();

    let raw = null;
    let usage = null;
    let latencyMs = 0;
    let errorText = null;

    try {
      const result = await extractRaw({ text, today });
      raw = result.raw;
      usage = result.usage;
      latencyMs = result.latencyMs;
    } catch (err) {
      errorText = String(err?.message || err).slice(0, 255);
      latencyMs = Date.now() - startedAt;
    }

    // 模型失败：记一条 failed 方便复盘指标（成功率的分母就靠它），
    // 但对外不报 5xx——前端要的是「退手动表单」而不是错误码。
    if (!raw) {
      const log = await query(
        `INSERT INTO extraction_log (tenant_id, member_id, input_text, channel, status, error, latency_ms)
         VALUES (?, ?, ?, ?, 'failed', ?, ?)`,
        [tenant, memberId, text, channel, errorText, latencyMs],
      );
      req.log.warn({ err: errorText }, 'extract failed, fallback to manual form');
      return {
        draftId: log.insertId,
        failed: true,
        message: '这次没解析出来，直接手动填吧（原话给你留着）',
        originalText: text,
      };
    }

    const ctx = await loadContext(tenant);
    const draft = normalizeDraft(raw, { today, ...ctx });

    const log = await query(
      `INSERT INTO extraction_log
         (tenant_id, member_id, input_text, channel, raw_response, draft, status, latency_ms, prompt_tokens, completion_tokens)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      [
        tenant,
        memberId,
        text,
        channel,
        JSON.stringify(raw),
        JSON.stringify(draft),
        latencyMs,
        usage?.prompt_tokens ?? null,
        usage?.completion_tokens ?? null,
      ],
    );

    return {
      draftId: log.insertId,
      failed: false,
      // 前端拿这份草稿填确认卡片；raw 不回传，避免前端误用未归一化的字段
      draft,
      originalText: text,
      today,
    };
  });

  // ---------------------------------------------------------------- 确认入库
  app.post('/extract/:id/confirm', async (req, reply) => {
    const tenant = req.user?.tenantId ?? tenantId();
    const memberId = req.user?.memberId ?? 1;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(reply, 400, 'BAD_REQUEST', '草稿 id 不合法');

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const clientOpId = String(req.body?.clientOpId ?? '').trim();
    if (!items.length) return fail(reply, 400, 'BAD_REQUEST', '没有要入库的条目');
    if (!clientOpId) return fail(reply, 400, 'BAD_REQUEST', '缺少 clientOpId（幂等键）');

    const today = todayString();
    // 分类白名单要按租户取（F-5.2 可自定义），校验和建档都用这一份
    const cats = await categoryNames(tenant);

    try {
      const results = await withTransaction(async (conn) => {
        // 先锁草稿行：两个人同时点确认，只有第一个能过状态检查
        const [rows] = await conn.execute(
          'SELECT id, status FROM extraction_log WHERE id = ? AND tenant_id = ? FOR UPDATE',
          [id, tenant],
        );
        if (!rows.length) throw new OpError(404, 'NOT_FOUND', '草稿不存在');
        if (rows[0].status !== 'draft') {
          throw new OpError(409, 'CONFLICT', '这笔草稿已经处理过了，请重新说一句');
        }

        const done = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i] || {};
          const name = String(it.name ?? '').trim();
          if (!name) throw new OpError(400, 'BAD_REQUEST', `第 ${i + 1} 条缺物品名称`);
          if (name.length > 64) throw new OpError(400, 'BAD_REQUEST', `「${name}」名称太长（最多 64 字）`);

          const qty = Number(it.qty);
          if (!Number.isFinite(qty) || qty <= 0) throw new OpError(400, 'BAD_REQUEST', `「${name}」数量不合法`);
          // 上限校验以前只在界面做，直接打接口能塞进 5000 箱（PRD 9.2 上限 999）
          if (qty > MAX_STOCK_IN) {
            throw new OpError(400, 'BAD_REQUEST', `「${name}」数量太大（最多 ${MAX_STOCK_IN}），是不是单位弄错了？`);
          }

          const locationId = Number(it.locationId);
          if (!Number.isInteger(locationId) || locationId <= 0) {
            throw new OpError(400, 'BAD_REQUEST', `「${name}」没选位置`);
          }

          const unit = it.unit ? String(it.unit).trim() : null;
          if (!unit) throw new OpError(400, 'BAD_REQUEST', `「${name}」没选单位`);
          // 单位也必须是白名单里的：以前 confirm 完全没校验，unit=吨 也能入库
          if (!UNIT_LIST.includes(unit)) {
            throw new OpError(400, 'BAD_REQUEST', `「${name}」的单位「${unit}」不在白名单里（可选：${UNIT_LIST.join('/')}）`);
          }

          // 分类：模型偶尔给出不在词表里的分类（「蔬菜」「零食」），不因此拦住入库，
          // 落到「其他」而不是「食品」——宁可少分类，不要乱分类。
          const category = it.category && cats.includes(String(it.category))
            ? String(it.category)
            : cats.includes('其他')
              ? '其他'
              : cats[0] || '其他';

          const barcode = it.barcode ? String(it.barcode).trim() : null;
          if (barcode && !BARCODE_RE.test(barcode)) {
            throw new OpError(400, 'BAD_REQUEST', `「${name}」的条码格式不对（4–64 位数字/字母/横线）`);
          }

          // 复用已有物品（方案 A：同名即复用，不再产生「酸奶」和「酸奶 100g」两条档案）。
          // item 表的唯一键是 (tenant_id, name_key)，name_key 含 spec，所以数据库允许同名多规格并存；
          // 但站在用户角度「酸奶」就是一罐酸奶，规格写没写齐不该变成两样东西。
          // 同名有多条时优先挑 spec 完全一致的那条（`<=>` 是 NULL 安全等值），否则挑最早建的。
          let itemId = Number(it.itemId) || null;
          if (itemId) {
            const [found] = await conn.execute(
              'SELECT id FROM item WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
              [itemId, tenant],
            );
            if (!found.length) throw new OpError(400, 'BAD_REQUEST', `「${name}」选的物品不存在`);
          } else {
            const spec = it.spec ? String(it.spec).trim() : null;
            const [same] = await conn.execute(
              `SELECT id FROM item
                WHERE tenant_id = ? AND name = ? AND deleted_at IS NULL
                ORDER BY (spec <=> ?) DESC, id
                LIMIT 1`,
              [tenant, name, spec],
            );
            if (same.length) {
              itemId = same[0].id;
              // 老档案没填规格、这次说了规格：顺手补上，避免信息永远丢
              if (spec) {
                await conn.execute('UPDATE item SET spec = COALESCE(spec, ?) WHERE id = ? AND tenant_id = ?', [
                  spec,
                  itemId,
                  tenant,
                ]);
              }
            } else {
              const [ins] = await conn.execute(
                `INSERT INTO item (tenant_id, name, spec, unit, category, aliases, default_location_id, note)
                 VALUES (?, ?, ?, ?, ?, '[]', ?, NULL)`,
                [tenant, name, spec, unit, category, locationId],
              );
              itemId = ins.insertId;
            }
          }

          // 条码：新档案直接写进去；老档案没条码就补上（扫一次，以后就能扫出来）。
          // 撞了别的物品的条码不算错误——不能因为一个码重复就让整笔录入失败，
          // 这里跳过即可（物品本身还是要入库的）。
          if (barcode) {
            try {
              await conn.execute('UPDATE item SET barcode = COALESCE(barcode, ?) WHERE id = ? AND tenant_id = ?', [
                barcode,
                itemId,
                tenant,
              ]);
            } catch (err) {
              if (err.code !== 'ER_DUP_ENTRY') throw err;
            }
          }

          const expireAt = resolveExpire({
            expireAt: it.expireAt,
            producedAt: it.producedAt,
            shelfLifeValue: it.shelfLifeValue,
            shelfLifeUnit: it.shelfLifeUnit,
          });

          // 每条 item 一个独立的 client_op_id：同一笔草稿里的多条不会互相顶掉，
          // 而整笔草稿的幂等由上面 extraction_log 的状态保证。
          const opId = `${clientOpId}-${i + 1}`.slice(0, 64);
          const op = await stockInTx(conn, {
            tenantId: tenant,
            memberId,
            itemId,
            locationId,
            qty,
            expireAt,
            openedAt: it.opened ? `${today} 00:00:00` : null,
            note: it.note ? String(it.note).slice(0, 200) : null,
            clientOpId: opId,
          });

          done.push({
            itemId,
            itemName: name,
            batchId: op.batchId,
            logId: op.logId,
            qtyAfter: op.qtyAfter,
            expireAt,
          });
        }

        // 把「最终确认的字段」写回草稿：复盘时能看到人改了什么（指标与面试素材）
        await conn.execute(
          "UPDATE extraction_log SET status = 'confirmed', draft = ? WHERE id = ? AND tenant_id = ?",
          [JSON.stringify({ confirmedItems: items, results: done }), id, tenant],
        );

        return done;
      });

      return { ok: true, results };
    } catch (err) {
      if (err instanceof OpError) return fail(reply, err.statusCode, err.code, err.message);
      throw err;
    }
  });

  // ---------------------------------------------------------------- 放弃
  app.post('/extract/:id/reject', async (req, reply) => {
    const tenant = req.user?.tenantId ?? tenantId();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(reply, 400, 'BAD_REQUEST', '草稿 id 不合法');

    const result = await query(
      "UPDATE extraction_log SET status = 'rejected' WHERE id = ? AND tenant_id = ? AND status = 'draft'",
      [id, tenant],
    );
    if (!result.affectedRows) {
      const [rows] = await query('SELECT status FROM extraction_log WHERE id = ? AND tenant_id = ?', [id, tenant]);
      if (!rows.length) return fail(reply, 404, 'NOT_FOUND', '草稿不存在');
      return fail(reply, 409, 'CONFLICT', '这笔草稿已经处理过了');
    }
    return { ok: true };
  });
}
