/**
 * 抽取评测：把 DEV-PLAN 阶段 4 的 20 条测试集跑一遍真实链路。
 *
 * 这不是「跑一下看看」的脚本，而是阶段 4 的验收证据：
 *   - 每条都走 POST /extract（真调 DeepSeek）→ 断言字段与行为
 *   - 期望能确认的用例继续走 POST /extract/:id/confirm（验证事务真的能落库）
 *   - 期望拒绝的用例走 /reject，而不是硬解析
 *   - 结束后把本轮新建的批次/物品清掉（只删 id 大于开始时的快照，绝不动演示数据）
 *
 * 指标口径（PRD 11）：confirmed / (confirmed + failed + rejected)。
 * 追问类用例（缺字段）按「用户补全后确认」计入 confirmed —— 真实使用里
 * 用户在确认卡片上补一个数字/日期就完事了，这就是一次成功的录入。
 *
 * 用法：node scripts/eval-extract.js [--write]   （--write 同时更新 docs/extract-eval.md）
 */
import '../src/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '../src/db.js';

const BASE = process.env.EVAL_BASE || 'http://127.0.0.1:8787/api';
const USER = process.env.EVAL_USER || 'admin';
const PASS = process.env.EVAL_PASS || 'pantry123';

/* ---------------- 20 条测试集（期望值来自 DEV-PLAN 阶段 4 表格） ---------------- */
const CASES = [
  { id: 1, text: '牛奶6盒放冰箱中层，25号到期', kind: 'confirm',
    expect: { count: 1, name: '牛奶', qty: 6, unit: '盒', expireAt: '2026-10-25' } },
  { id: 2, text: '买了三提纸巾，储藏室', kind: 'confirm',
    expect: { count: 1, qty: 3, unit: '提', location: '储藏室', missingExpire: true } },
  { id: 3, text: '鸡蛋一板30个，冷藏，保质期30天', kind: 'confirm',
    expect: { count: 1, unit: '板', shelfLifeValue: 30, shelfLifeUnit: '天', expireAtNull: true } },
  { id: 4, text: '布洛芬一盒放药箱，明年3月过期', kind: 'confirm',
    expect: { count: 1, unit: '盒', location: '药箱', expireAt: '2027-03-31' } },
  { id: 5, text: '酸奶8杯，冷藏，下周三过期', kind: 'confirm',
    expect: { count: 1, qty: 8, unit: '杯', datePhrase: '下周三', expireAtNull: true } },
  { id: 6, text: '买了牛奶', kind: 'confirm',
    expect: { count: 1, name: '牛奶', qtyNull: true, missingQty: true } },
  { id: 7, text: '两瓶生抽，厨房柜，保质期18个月', kind: 'confirm',
    expect: { count: 1, qty: 2, unit: '瓶', shelfLifeValue: 18, shelfLifeUnit: '月' } },
  { id: 8, text: '维生素C一瓶，药箱，已经开封了', kind: 'confirm',
    expect: { count: 1, qty: 1, unit: '瓶', opened: true } },
  { id: 9, text: '冷冻了5斤猪肉', kind: 'confirm',
    expect: { count: 1, qty: 5, unit: '斤', location: '冷冻' } },
  { id: 10, text: '上次那个牛奶又买了6盒', kind: 'confirm',
    expect: { count: 1, name: '牛奶', qty: 6, itemMatched: true } },
  { id: 11, text: '冰箱里的牛奶还剩几盒', kind: 'reject',
    expect: { refused: true } },
  { id: 12, text: '大米10斤，储藏室，2027年5月到期', kind: 'confirm',
    expect: { count: 1, qty: 10, unit: '斤', expireAt: '2027-05-31' } },
  { id: 13, text: '牙膏三支，卫生间，保质期两年', kind: 'confirm',
    expect: { count: 1, qty: 3, unit: '支', shelfLifeValue: 2, shelfLifeUnit: '年' } },
  { id: 14, text: '速冻饺子2袋放冷冻，60天保质期', kind: 'confirm',
    expect: { count: 1, qty: 2, unit: '袋', shelfLifeValue: 60, shelfLifeUnit: '天' } },
  { id: 15, text: '口罩一盒50个，储藏室', kind: 'confirm',
    expect: { count: 1, qty: 1, unit: '盒', specContains: '50' } },
  { id: 16, text: '啤酒一箱12瓶，阳台，明年1月到期', kind: 'confirm',
    expect: { count: 1, qty: 1, unit: '箱', specContains: '12', expireAt: '2027-01-31' } },
  { id: 17, text: '纸巾和洗衣液各买一份，储藏室', kind: 'confirm',
    expect: { count: 2, names: ['纸巾', '洗衣液'] } },
  { id: 18, text: '面包两个，明天到期', kind: 'confirm',
    expect: { count: 1, qty: 2, datePhrase: '明天', expireAtNull: true } },
  { id: 19, text: '把冰箱的牛奶改成4盒', kind: 'reject',
    expect: { refused: true } },
  { id: 20, text: '洗面奶一瓶，卫生间，开封后6个月内用完', kind: 'confirm',
    expect: { count: 1, unit: '瓶', opened: true, shelfLifeValue: 6, shelfLifeUnit: '月' } },
];

/* ---------------- HTTP ---------------- */
async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`登录失败：${JSON.stringify(data)}`);
  return data.token;
}

function client(timeoutMs = 40000) {
  return async (token, method, url, body) => {
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };
}

/* ---------------- 断言 ---------------- */
function checkCase(c, draft) {
  const reasons = [];
  const e = c.expect || {};
  const items = draft.items || [];

  if (e.refused !== undefined) {
    if (draft.refused !== e.refused) reasons.push(`refused 期望 ${e.refused} 实际 ${draft.refused}`);
    return reasons;
  }
  if (e.count !== undefined && items.length !== e.count) reasons.push(`条目数期望 ${e.count} 实际 ${items.length}`);
  if (!items.length) return reasons;

  const it = items[0];
  const eq = (label, actual, expected) => {
    if (expected !== undefined && String(actual) !== String(expected)) {
      reasons.push(`${label} 期望 ${expected} 实际 ${actual}`);
    }
  };

  if (e.name) eq('name', it.name, e.name);
  if (e.names) eq('names', items.map((x) => x.name).sort().join('/'), [...e.names].sort().join('/'));
  if (e.qty !== undefined) eq('qty', it.qty, e.qty);
  if (e.qtyNull) {
    if (it.qty !== null) reasons.push(`qty 期望 null 实际 ${it.qty}`);
  }
  if (e.unit) eq('unit', it.unit, e.unit);
  if (e.specContains && !String(it.spec || '').includes(e.specContains)) {
    reasons.push(`spec 期望包含「${e.specContains}」实际 ${it.spec}`);
  }
  if (e.expireAt) eq('expireAt', it.expireAt, e.expireAt);
  if (e.expireAtNull && it.expireAt !== null) reasons.push(`expireAt 期望 null 实际 ${it.expireAt}`);
  if (e.datePhrase) {
    if (!String(it.datePhrase || '').includes(e.datePhrase)) {
      reasons.push(`datePhrase 期望含「${e.datePhrase}」实际 ${it.datePhrase}`);
    }
  }
  if (e.opened !== undefined && it.opened !== e.opened) reasons.push(`opened 期望 ${e.opened} 实际 ${it.opened}`);
  if (e.shelfLifeValue !== undefined) eq('shelfLifeValue', it.shelfLifeValue, e.shelfLifeValue);
  if (e.shelfLifeUnit) eq('shelfLifeUnit', it.shelfLifeUnit, e.shelfLifeUnit);
  if (e.itemMatched && !it.itemId) reasons.push('期望匹配到已有物品，实际没匹配上');
  if (e.qtyNull === undefined && e.qty === undefined && it.qty === null && !e.missingQty) {
    // 没声明要求 qty 却拿不到数量，说明模型漏了字段
    reasons.push('qty 意外为 null');
  }
  if (e.location) {
    const hit = it.locationName === e.location || (it.locationCandidates || []).some((x) => x.name === e.location);
    if (!hit) reasons.push(`位置 期望「${e.location}」实际 ${it.locationName || JSON.stringify(it.locationCandidates)}`);
  }
  if (e.missingQty && !draft.missing.includes('qty')) reasons.push('missing 里应该有 qty');
  if (e.missingExpire && !draft.missing.includes('expire_at')) reasons.push('missing 里应该有 expire_at');
  return reasons;
}

/** 用户在确认卡片上要补的字段（模拟真人的最小补充） */
function fillItem(it, today) {
  const patch = {};
  if (it.qty == null) patch.qty = 1;
  if (!it.unit) patch.unit = '个';
  if (!it.locationId) {
    const cand = (it.locationCandidates || [])[0];
    patch.locationId = cand ? cand.id : 1; // 兜底用「厨房」，只为让链路跑通
  }
  if (!it.expireAt && !it.shelfLifeValue) patch.expireAt = today; // 无到期信息时按今天入库，仅测试用
  return { ...it, ...patch };
}

/* ---------------- 主流程 ---------------- */
const token = await login();
const call = client();

const beforeBatch = (await query('SELECT COALESCE(MAX(id),0) AS m FROM batch'))[0].m;
const beforeItem = (await query('SELECT COALESCE(MAX(id),0) AS m FROM item'))[0].m;

const todayStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const rows = [];
let confirmed = 0;
let failed = 0;
let rejected = 0;

for (const c of CASES) {
  const startedAt = Date.now();
  const res = await call(token, 'POST', '/extract', { text: c.text, channel: 'text' });
  const ms = Date.now() - startedAt;

  if (res.status !== 200 || !res.data || res.data.failed) {
    failed++;
    rows.push({ id: c.id, text: c.text, outcome: 'failed', ms, reasons: [`抽取失败：${JSON.stringify(res.data).slice(0, 120)}`] });
    console.error(`[${c.id}] extract failed ${ms}ms ${JSON.stringify(res.data).slice(0, 200)}`);
    continue;
  }

  const { draftId, draft } = res.data;
  const reasons = checkCase(c, draft);

  if (c.kind === 'reject') {
    // 期望被判定为「不是录入场景」：断言 + 主动标记 rejected
    if (draft.refused) {
      await call(token, 'POST', `/extract/${draftId}/reject`, {});
      rejected++;
      const ok = reasons.length === 0;
      rows.push({ id: c.id, text: c.text, outcome: ok ? 'refused(正确)' : 'wrong', ms, reasons });
      if (!ok) failed++;
    } else {
      failed++;
      rows.push({ id: c.id, text: c.text, outcome: 'wrong（该拒绝却去解析）', ms, reasons });
    }
    continue;
  }

  // 期望能确认：先按断言判行为，再真实 confirm 验证事务
  const items = (draft.items || []).map((it) => fillItem(it, todayStr));
  if (!items.length) {
    failed++;
    rows.push({ id: c.id, text: c.text, outcome: 'failed（没有条目可确认）', ms, reasons });
    continue;
  }
  const confirm = await call(token, 'POST', `/extract/${draftId}/confirm`, {
    items,
    clientOpId: `eval-${Date.now()}-${c.id}`,
  });

  if (confirm.status === 200 && confirm.data?.ok) {
    confirmed++;
    rows.push({
      id: c.id,
      text: c.text,
      outcome: reasons.length === 0 ? 'confirmed' : 'confirmed（有偏差）',
      ms,
      reasons,
    });
  } else {
    failed++;
    rows.push({ id: c.id, text: c.text, outcome: 'failed', ms, reasons: [...reasons, `confirm ${confirm.status} ${JSON.stringify(confirm.data).slice(0, 120)}`] });
  }
}

/* ---------------- 清理本轮造的数据（只删 id 大于快照的） ---------------- */
const newBatches = await query('SELECT id FROM batch WHERE id > ?', [beforeBatch]);
const batchIds = newBatches.map((r) => r.id);
if (batchIds.length) {
  const ph = batchIds.map(() => '?').join(',');
  await query(`DELETE FROM alert WHERE batch_id IN (${ph})`, batchIds);
  await query(`DELETE FROM stock_log WHERE batch_id IN (${ph})`, batchIds);
  await query(`DELETE FROM batch WHERE id IN (${ph})`, batchIds);
}
const newItems = await query(
  'SELECT id FROM item WHERE id > ? AND NOT EXISTS (SELECT 1 FROM batch b WHERE b.item_id = item.id)',
  [beforeItem],
);
if (newItems.length) {
  const ph = newItems.map(() => '?').join(',');
  await query(`DELETE FROM stock_log WHERE item_id IN (${ph})`, newItems.map((r) => r.id));
  await query(`DELETE FROM item WHERE id IN (${ph})`, newItems.map((r) => r.id));
}

/* ---------------- 汇总 ---------------- */
const total = CASES.length;
const rate = confirmed / Math.max(1, confirmed + failed + rejected);
const behaviorWrong = rows.filter((r) => /wrong|有偏差/.test(r.outcome)).length;

console.log('\n=== 抽取评测结果 ===\n');
for (const r of rows) {
  const mark = /^confirmed$|^refused\(正确\)$/.test(r.outcome) ? '✓' : '✗';
  console.log(`${mark} #${String(r.id).padStart(2)} ${r.outcome.padEnd(22)} ${String(r.ms).padStart(5)}ms  ${r.text}`);
  for (const reason of r.reasons) console.log(`     · ${reason}`);
}
console.log(`\nconfirmed=${confirmed} failed=${failed} rejected=${rejected} total=${total}`);
console.log(`抽取成功率（PRD 口径）=${(rate * 100).toFixed(1)}%  目标 ≥80%  ${rate >= 0.8 ? '通过' : '未通过'}`);
console.log(`行为正确率=${(((total - behaviorWrong - rows.filter((r) => r.outcome === 'failed').length) / total) * 100).toFixed(1)}%`);
console.log(`清理：删除批次 ${batchIds.length} 条，删除空物品 ${newItems.length} 条\n`);

if (process.argv.includes('--write')) {
  const lines = [
    '# 抽取评测记录（阶段 4 / T4.12）',
    '',
    `> 生成时间：${new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)}（北京时间）`,
    `> 模型：${process.env.DEEPSEEK_MODEL || 'deepseek-chat'}　20 条测试集来自 DEV-PLAN 阶段 4`,
    '',
    `**结果：confirmed=${confirmed} / failed=${failed} / rejected=${rejected}，抽取成功率 ${(rate * 100).toFixed(1)}%（目标 ≥80%）**`,
    '',
    '| # | 输入 | 结果 | 耗时 | 说明 |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.text} | ${r.outcome} | ${r.ms}ms | ${r.reasons.join('；') || '—'} |`),
    '',
    '## 口径',
    '',
    '- `confirmed`：抽取后走完 `/extract/:id/confirm`，真的写进了 batch + stock_log。',
    '- `rejected`：模型判定「不是录入场景」，走 `/extract/:id/reject`（测试集 11、19）。',
    '- `failed`：抽取失败（模型超时/JSON 非法）或确认失败。',
    '- 缺字段的用例（2/5/6/18）按「用户在确认卡片补一个字段后确认」计入 confirmed——这就是真实使用路径。',
    '- 抽取成功率的定义来自 PRD 11：`confirmed / (confirmed + failed + rejected)`。',
    '',
    '## 每条失败都能复查',
    '',
    '每次抽取（含失败）都会写一行 `extraction_log`：原话、模型原始 JSON、归一化后的草稿、耗时、token 数、状态。',
    '排查用：`SELECT id, status, error, latency_ms, input_text FROM extraction_log ORDER BY id DESC LIMIT 30;`',
    '',
  ];
  const outFile = path.resolve('docs/extract-eval.md');
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  console.log(`已写入 ${outFile}`);
}

process.exit(rate >= 0.8 ? 0 : 1);
