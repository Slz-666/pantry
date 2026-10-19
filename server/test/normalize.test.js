/**
 * 归一化层单测（node:test，零依赖）。
 * 为什么要单测这一层：它是「LLM 出字段之后」唯一把关的地方，
 * 日期换算、数量边界、位置/物品匹配、重复判断错了都会脏数据，
 * 而这些全是纯函数，测试跑起来不需要数据库也不需要模型。
 * 跑：npm test --workspace server
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidDate,
  addMonths,
  addDays,
  diffDays,
  todayString,
  validateQty,
  validateUnit,
  matchLocation,
  matchItem,
  detectDuplicate,
  normalizeDraft,
  UNIT_LIST,
} from '../src/services/normalize.js';

test('日期合法性：只有真实的年月日才算合法', () => {
  assert.equal(isValidDate('2026-10-19'), true);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2024-02-29'), true); // 闰年
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('2026-1-1'), false); // 必须补零
  assert.equal(isValidDate(''), false);
  assert.equal(isValidDate('下周三'), false);
});

test('日历加法：1/31 + 1 个月 = 2/28（月末夹取），不是 30 天乘法', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29'); // 闰年
  assert.equal(addMonths('2026-08-31', 1), '2026-09-30');
  assert.equal(addMonths('2026-10-19', 18), '2028-04-19');
  assert.equal(addMonths('2026-11-30', 2), '2027-01-30');
  assert.equal(addMonths('bad', 1), null);
});

test('加减天数跨月跨年不差一天', () => {
  assert.equal(addDays('2026-10-19', 3), '2026-10-22');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(diffDays('2026-10-19', '2026-10-22'), 3);
  assert.equal(diffDays('2026-10-22', '2026-10-19'), -3);
});

test('今天的字符串用北京时间（+08:00），不受机器时区影响', () => {
  // 2026-10-19T16:30:00Z = 北京时间 2026-10-20 00:30
  assert.equal(todayString(new Date('2026-10-19T16:30:00Z')), '2026-10-20');
  assert.equal(todayString(new Date('2026-10-19T15:30:00Z')), '2026-10-19');
});

test('数量校验：0 < qty <= 999，最多两位小数', () => {
  assert.deepEqual(validateQty(6), { value: 6, problem: null });
  assert.deepEqual(validateQty('0.5'), { value: 0.5, problem: null });
  assert.equal(validateQty(0).problem.field, 'qty');
  assert.equal(validateQty(1000).problem.field, 'qty');
  assert.equal(validateQty(null).problem.field, 'qty');
  assert.equal(validateQty('六').problem.field, 'qty');
  assert.equal(validateQty(1.234).problem.field, 'qty');
});

test('单位白名单：箱/提/卷/条/块/碗 都在内，未知单位只提示不静默改写', () => {
  assert.equal(validateUnit('盒').problem, null);
  assert.equal(validateUnit('提').problem, null);
  assert.equal(validateUnit('箱').problem, null);
  assert.ok(UNIT_LIST.length >= 22);
  const bad = validateUnit('坨');
  assert.equal(bad.problem.field, 'unit');
  assert.equal(bad.value, '坨'); // 原值保留给用户改，不自动替换
});

test('位置匹配：完全命中优先', () => {
  const locs = [{ id: 3, name: '冷藏' }, { id: 4, name: '冷冻' }, { id: 6, name: '储物间' }];
  assert.deepEqual(matchLocation('冷藏', locs).id, 3);
  assert.deepEqual(matchLocation('储物间', locs).id, 6);
});

test('位置匹配：包含命中（原话里带修饰词），多义则不给 id 而是给候选', () => {
  const locs = [
    { id: 2, name: '冰箱' },
    { id: 3, name: '冷藏' },
    { id: 6, name: '储物间' },
  ];
  assert.equal(matchLocation('储物间第二层', locs).id, 6);
  // 「冰箱中层」同时包含「冰箱」和「冷藏」的父级？这里只命中冰箱一个，交给用户改成冷藏
  assert.equal(matchLocation('冰箱中层', locs).id, 2);
  // 完全没命中：不给 id，也不瞎猜
  const miss = matchLocation('阳台柜子', locs);
  assert.equal(miss.id, null);
  assert.deepEqual(miss.candidates, []);
});

test('位置匹配：原话同时命中父和子时取更深的子位置（「冰箱冷藏」→ 冷藏）', () => {
  const locs = [
    { id: 2, name: '冰箱', parentId: null },
    { id: 3, name: '冷藏', parentId: 2 },
    { id: 4, name: '冷冻', parentId: 2 },
  ];
  const r = matchLocation('冰箱冷藏', locs);
  assert.equal(r.id, 3);
  assert.equal(r.candidates.length, 0);
  // 「冰箱中层」只命中父（中层不是位置名）→ 取冰箱，让用户在卡片里改成冷藏
  assert.equal(matchLocation('冰箱中层', locs).id, 2);
});

test('位置匹配：并列的多义（同层两个）仍然交给用户', () => {
  const locs = [
    { id: 2, name: '冰箱', parentId: null },
    { id: 3, name: '冷藏', parentId: 2 },
    { id: 4, name: '冷冻', parentId: 2 },
  ];
  const r = matchLocation('冰箱冷冻或冷藏都行', locs);
  assert.equal(r.id, null);
  assert.equal(r.candidates.length, 3);
});

test('位置匹配：多义时返回候选列表（不自动选）', () => {
  const locs = [
    { id: 1, name: '厨房' },
    { id: 5, name: '厨房柜' },
  ];
  // 「厨房」完全命中唯一，所以直接给 id=1，不是多义
  assert.equal(matchLocation('厨房', locs).id, 1);
  // 「厨房柜里」同时包含两个位置名 → 多义，交给用户选
  const r2 = matchLocation('厨房柜里', locs);
  assert.equal(r2.id, null);
  assert.equal(r2.candidates.length, 2);
});

test('物品匹配：同名复用，同名不同规格交给用户', () => {
  const items = [
    { id: 42, name: '牛奶', spec: '250ml', aliases: [] },
    { id: 43, name: '牛奶', spec: '1L', aliases: [] },
    { id: 45, name: '速冻饺子', spec: '500g', aliases: ['水饺'] },
  ];
  // 两个同名档案且没给规格 → 多义
  const multi = matchItem('牛奶', null, items);
  assert.equal(multi.itemId, null);
  assert.equal(multi.candidates.length, 2);
  // 给了规格 → 精确命中
  assert.equal(matchItem('牛奶', '1L', items).itemId, 43);
  // 别名命中
  assert.equal(matchItem('水饺', null, items).itemId, 45);
  // 完全没命中 → null（新建）
  assert.equal(matchItem('没听过的东西', null, items).itemId, null);
});

test('物品匹配：编辑距离 1 的相似名只做候选，绝不自动入库', () => {
  const items = [{ id: 1, name: '生抽', spec: null, aliases: [] }];
  const r = matchItem('老抽', null, items);
  assert.equal(r.itemId, null);
  assert.equal(r.candidates.length, 1);
});

test('重复检测：同物品+同位置+同到期日 才算重复', () => {
  const batches = [{ id: 9, itemId: 42, locationId: 3, expireAt: '2026-10-22', qty: 2 }];
  assert.equal(detectDuplicate({ itemId: 42, locationId: 3, expireAt: '2026-10-22' }, batches).batchId, 9);
  assert.equal(detectDuplicate({ itemId: 42, locationId: 4, expireAt: '2026-10-22' }, batches), null);
  assert.equal(detectDuplicate({ itemId: 42, locationId: 3, expireAt: null }, batches), null);
});

/* ---------------- 整条草稿 ---------------- */

const CTX = {
  today: '2026-10-19',
  locations: [
    { id: 2, name: '冰箱' },
    { id: 3, name: '冷藏' },
    { id: 4, name: '冷冻' },
    { id: 6, name: '储物间' },
    { id: 47, name: '药箱' },
  ],
  items: [{ id: 42, name: '牛奶', spec: '250ml', aliases: [] }],
  batches: [{ id: 9, itemId: 42, locationId: 3, expireAt: '2026-10-22', qty: 2 }],
};

test('normalizeDraft：正常一条，四要素齐全、无追问', () => {
  const r = normalizeDraft(
    {
      items: [
        {
          name: '牛奶', spec: '250ml', qty: 6, unit: '盒', category: '食品',
          location_hint: '冷藏', expire_at: '2026-10-25', date_phrase: null,
          shelf_life_value: null, shelf_life_unit: null, opened: false,
        },
      ],
      missing: [], question: null,
    },
    CTX,
  );
  assert.equal(r.refused, false);
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.equal(it.qty, 6);
  assert.equal(it.unit, '盒');
  assert.equal(it.expireAt, '2026-10-25');
  assert.equal(it.locationId, 3);
  assert.equal(it.itemId, 42); // 复用已有牛奶
  assert.equal(it.duplicate, null);
  assert.deepEqual(it.problems, []);
  assert.deepEqual(r.missing, []);
});

test('normalizeDraft：重复批次会被标出来（默认合并）', () => {
  const r = normalizeDraft(
    {
      items: [{ name: '牛奶', spec: '250ml', qty: 2, unit: '盒', location_hint: '冷藏', expire_at: '2026-10-22' }],
      missing: [], question: null,
    },
    CTX,
  );
  assert.equal(r.items[0].duplicate.batchId, 9);
});

test('normalizeDraft：相对日期不换算，保留原话并要求人工确认到期日', () => {
  const r = normalizeDraft(
    {
      items: [{ name: '酸奶', qty: 8, unit: '盒', location_hint: '冷藏', expire_at: null, date_phrase: '下周三' }],
      missing: ['expire_at'], question: '下周三具体是几号？',
    },
    CTX,
  );
  const it = r.items[0];
  assert.equal(it.expireAt, null);
  assert.equal(it.datePhrase, '下周三');
  assert.equal(it.hasExpiry, true); // 有原话，算「有到期信息」，只是没换算
  assert.equal(r.missing.includes('expire_at'), true); // 模型报的 missing 保留
  // 数量/位置都有，所以后端不会再补 qty/location
  assert.equal(r.missing.includes('qty'), false);
});

test('normalizeDraft：到期日早于今天 30 天 → 判为录入错误，退回原话', () => {
  const r = normalizeDraft(
    {
      items: [{ name: '布洛芬', qty: 1, unit: '盒', location_hint: '药箱', expire_at: '2020-01-01' }],
      missing: [], question: null,
    },
    CTX,
  );
  const it = r.items[0];
  assert.equal(it.expireAt, null);
  assert.equal(it.datePhrase, '2020-01-01');
  assert.equal(it.problems.some((p) => p.field === 'expireAt'), true);
});

test('normalizeDraft：非法日期格式同样退回，不静默丢弃', () => {
  const r = normalizeDraft(
    { items: [{ name: '牛奶', qty: 1, unit: '盒', location_hint: '冷藏', expire_at: '2026-02-30' }], missing: [], question: null },
    CTX,
  );
  assert.equal(r.items[0].expireAt, null);
  assert.equal(r.items[0].problems.some((p) => p.field === 'expireAt'), true);
});

test('normalizeDraft：数量越界/单位不认识 → 进 problems，不阻断其它字段', () => {
  const r = normalizeDraft(
    { items: [{ name: '纸巾', qty: 5000, unit: '坨', location_hint: '储物间', expire_at: null }], missing: [], question: null },
    CTX,
  );
  const it = r.items[0];
  assert.equal(it.qty, null);
  assert.equal(it.problems.some((p) => p.field === 'qty'), true);
  assert.equal(it.problems.some((p) => p.field === 'unit'), true);
  assert.equal(it.locationId, 6); // 位置仍然解析出来
});

test('normalizeDraft：模型判「不是录入场景」→ refused，无条目', () => {
  const r = normalizeDraft(
    { items: [], missing: [], question: '这是在问库存，去首页看就行。' },
    CTX,
  );
  assert.equal(r.refused, true);
  assert.equal(r.items.length, 0);
  assert.match(r.question, /首页/);
});

test('normalizeDraft：缺字段时后端补进 missing（不依赖模型自觉）', () => {
  const r = normalizeDraft(
    { items: [{ name: '牛奶', qty: null, unit: null, location_hint: null, expire_at: null }], missing: [], question: null },
    CTX,
  );
  assert.deepEqual([...r.missing].sort(), ['expire_at', 'location_hint', 'qty', 'unit'].sort());
});

test('normalizeDraft：多物品拆成多条', () => {
  const r = normalizeDraft(
    {
      items: [
        { name: '纸巾', qty: 1, unit: '提', location_hint: '储物间', expire_at: null },
        { name: '洗衣液', qty: 1, unit: '瓶', location_hint: '储物间', expire_at: null },
      ],
      missing: [], question: null,
    },
    CTX,
  );
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map((i) => i.unit), ['提', '瓶']);
});
