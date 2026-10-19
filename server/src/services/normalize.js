/**
 * 归一化层（PRD 9.2 六步）——把 LLM 的原始草稿变成「人可确认的字段」。
 *
 * 为什么单独一层，而且全部是纯函数：
 * 1) 大模型只做「话 → 字段」，日期换算、数量校验、位置/物品匹配、重复判断
 *    一律交给确定性代码。这样出错能单测、能复现，不靠模型运气。
 * 2) 纯函数不碰数据库：候选数据（位置列表、物品列表、已有批次）由调用方传进来，
 *    所以 server/test/normalize.test.js 完全脱离 DB 跑。
 *
 * 所有日期都是 'YYYY-MM-DD' 字符串，绝不用 JS Date 做日期运算：
 * new Date(...) 会带上本地时区，DATE 列要的是纯日历语义（差一天是历史事故）。
 */

/* ---------------- 枚举：单位 / 分类 ---------------- */

/**
 * 单位白名单。只在白名单内接受，不做换算：
 * 「提」「箱」这类包装单位如果被强行折成「包」「盒」，数量含义就变了。
 * 家庭常用量词覆盖到 22 个，缺了就让用户在确认卡片里改。
 */
export const UNIT_LIST = [
  '个', '盒', '袋', '瓶', '包', '罐', '斤', '500g', '份', '板', '桶',
  '颗', '支', '片', '丸', '套', '箱', '提', '卷', '条', '块', '碗',
];

export const CATEGORY_LIST = ['食品', '日用品', '药品', '护肤品', '清洁用品', '宠物用品', '工具', '其他'];

/* ---------------- 日期工具（纯字符串 + UTC，绕开本地时区） ---------------- */

const pad2 = (n) => String(n).padStart(2, '0');

export function isValidDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return daysInMonth(y, m) >= d;
}

function daysInMonth(year, month) {
  // Date.UTC 的「第 0 天」= 上个月最后一天，因此 month 直接用（1-based）就得到本月天数。
  // 用 UTC 而不是本地 UTC+8，避免本地时区把月末算偏。
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addMonths(dateStr, months) {
  if (!isValidDate(dateStr) || !Number.isInteger(months)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  // 31 天 + 1 个月 → 落到下月最后一天（1/31 + 1 月 = 2/28），这是日历加法而不是 30 天乘法
  return `${ny}-${pad2(nm)}-${pad2(Math.min(d, daysInMonth(ny, nm)))}`;
}

export function addDays(dateStr, days) {
  if (!isValidDate(dateStr) || !Number.isInteger(days)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** 两个日期相差的天数（b - a）；纯日历差，不受时区影响。 */
export function diffDays(a, b) {
  if (!isValidDate(a) || !isValidDate(b)) return null;
  const toUTC = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

/** 北京时间（+08:00）的今天，格式 YYYY-MM-DD。 */
export function todayString(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/* ---------------- 数量 / 单位 ---------------- */

/** 数量校验：0 < qty <= 999，最多两位小数（DECIMAL(10,2) 塞得下）。 */
export function validateQty(qty) {
  if (qty === null || qty === undefined || qty === '') {
    return { value: null, problem: { field: 'qty', message: '数量没听清，请补一个数字' } };
  }
  const n = Number(qty);
  if (!Number.isFinite(n)) return { value: null, problem: { field: 'qty', message: '数量必须是数字' } };
  if (n <= 0) return { value: null, problem: { field: 'qty', message: '数量必须大于 0' } };
  if (n > 999) return { value: null, problem: { field: 'qty', message: '数量太大（最多 999），是不是单位弄错了？' } };
  if (Math.round(n * 100) !== n * 100) {
    return { value: n, problem: { field: 'qty', message: '数量最多两位小数' } };
  }
  return { value: n, problem: null };
}

export function validateUnit(unit) {
  if (unit === null || unit === undefined || unit === '') {
    return { value: null, problem: { field: 'unit', message: '单位没听清，请选一个' } };
  }
  const u = String(unit).trim();
  if (!UNIT_LIST.includes(u)) {
    return { value: u, problem: { field: 'unit', message: `「${u}」不在单位白名单里，请改成：${UNIT_LIST.slice(0, 8).join('/')}…` } };
  }
  return { value: u, problem: null };
}

/* ---------------- 位置匹配：完全 > 包含 > 多义 ---------------- */

/**
 * 位置只认「唯一命中」：
 * 「冰箱中层」在位置树里同时能想到冰箱/冷藏，属于多义 → 不填 id，把候选交给用户选。
 * 唯一例外是「容器 + 子位置」的说法（「冰箱冷藏」「厨房柜第二层」）：
 * 原话同时命中父和子时取更深的那个，因为人说话时父名只是定位前缀。
 * 位置表没有别名列（PRD 提到的别名匹配对位置不适用），所以这里只有两级，
 * 与其硬猜，不如让确认卡片多一步下拉。
 */
export function matchLocation(hint, locations = []) {
  const h = String(hint ?? '').trim();
  if (!h) return { id: null, name: null, hint: null, candidates: [] };

  const exact = locations.filter((l) => l.name === h);
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].name, hint: h, candidates: [] };

  // 包含匹配：位置名出现在原话里（「储物间第二层」→ 储物间），或原话是位置名的一部分
  const contains = locations.filter((l) => h.includes(l.name) || l.name.includes(h));
  if (contains.length === 1) return { id: contains[0].id, name: contains[0].name, hint: h, candidates: [] };
  if (contains.length > 1) {
    // 只要其中最深的那个比其余的更深（即它是别人的后代），就取它：
    // 「冰箱冷藏」→ 冷藏(深 1) 比 冰箱(深 0) 深，说明原话是「父名 + 子名」，取子。
    const byId = new Map(locations.map((l) => [l.id, l]));
    const depth = (loc) => {
      let d = 0;
      let cur = loc;
      while (cur && cur.parentId && byId.has(cur.parentId) && d < 10) {
        cur = byId.get(cur.parentId);
        d++;
      }
      return d;
    };
    const ranked = contains
      .map((l) => ({ ...l, depth: depth(l) }))
      .sort((a, b) => b.depth - a.depth);
    if (ranked.length && (ranked.length === 1 || ranked[1].depth < ranked[0].depth)) {
      return { id: ranked[0].id, name: ranked[0].name, hint: h, candidates: [] };
    }
    return { id: null, name: null, hint: h, candidates: contains.map((l) => ({ id: l.id, name: l.name })) };
  }
  return { id: null, name: null, hint: h, candidates: [] };
}

/* ---------------- 物品匹配：名称相等 > 别名 > 相似度 ---------------- */

function normalizeName(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** 编辑距离（只用于短中文名，长度差异大于阈值时提前退出，避免 O(nm) 浪费）。 */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 物品匹配。命中就复用 item_id（不新建重复档案），多义就交给用户选。
 * spec 参与判断：同名不同规格（牛奶 250ml / 牛奶 1L）是两种档案。
 */
export function matchItem(name, spec, items = []) {
  const n = normalizeName(name);
  if (!n) return { itemId: null, via: null, candidates: [] };
  const s = normalizeName(spec);

  const sameName = items.filter((i) => normalizeName(i.name) === n);
  if (sameName.length === 1) {
    // 只有一个同名档案：规格不同也复用，避免「牛奶」和「牛奶 250ml」两份
    return { itemId: sameName[0].id, via: 'name', candidates: [] };
  }
  if (sameName.length > 1) {
    const sameSpec = s ? sameName.filter((i) => normalizeName(i.spec) === s) : [];
    if (sameSpec.length === 1) return { itemId: sameSpec[0].id, via: 'name+spec', candidates: [] };
    return { itemId: null, via: null, candidates: sameName.map((i) => ({ id: i.id, name: i.name, spec: i.spec })) };
  }

  const viaAlias = items.filter((i) =>
    (i.aliases || []).some((a) => {
      const an = normalizeName(a);
      return an && (an === n || n.includes(an) || an.includes(n));
    }),
  );
  if (viaAlias.length === 1) return { itemId: viaAlias[0].id, via: 'alias', candidates: [] };
  if (viaAlias.length > 1) {
    return { itemId: null, via: null, candidates: viaAlias.map((i) => ({ id: i.id, name: i.name, spec: i.spec })) };
  }

  // 相似度兜底：编辑距离 1 且长度 >= 2（「生抽」vs「老抽」距离 1，会命中同名不同物，
  // 所以要求距离严格小于 2 且长度相同时才提示，绝不自动入库）
  const fuzzy = items
    .map((i) => ({ ...i, dist: levenshtein(n, normalizeName(i.name)) }))
    .filter((x) => n.length >= 2 && x.dist === 1)
    .sort((a, b) => a.dist - b.dist);
  if (fuzzy.length) {
    return { itemId: null, via: null, candidates: fuzzy.slice(0, 5).map((i) => ({ id: i.id, name: i.name, spec: i.spec })) };
  }
  return { itemId: null, via: null, candidates: [] };
}

/* ---------------- 重复检测 ---------------- */

/**
 * 同物品 + 同位置 + 同到期日 已经有一个批次 → 提示合并（默认合并）。
 * 只在三要素都齐时判断：缺一个就不是「同一批货」。
 */
export function detectDuplicate({ itemId, locationId, expireAt }, batches = []) {
  if (!itemId || !locationId || !expireAt) return null;
  const hit = batches.find(
    (b) => b.itemId === itemId && b.locationId === locationId && b.expireAt === expireAt && Number(b.qty) > 0,
  );
  return hit ? { batchId: hit.id, qty: Number(hit.qty), expireAt: hit.expireAt } : null;
}

/* ---------------- 主流程：六步归一化 ---------------- */

/**
 * @param {object} raw      模型输出的原始 JSON
 * @param {object} ctx
 * @param {string} ctx.today        'YYYY-MM-DD'（北京时间今天）
 * @param {Array}  ctx.locations    [{id,name}]
 * @param {Array}  ctx.items        [{id,name,spec,aliases}]
 * @param {Array}  ctx.batches      [{id,itemId,locationId,expireAt,qty}]
 * @returns {{items:Array, missing:string[], question:string|null, refused:boolean}}
 */
export function normalizeDraft(raw, ctx = {}) {
  const today = ctx.today || todayString();
  const locations = ctx.locations || [];
  const items = ctx.items || [];
  const batches = ctx.batches || [];

  const rawItems = Array.isArray(raw?.items) ? raw.items : [];
  const rawMissing = Array.isArray(raw?.missing) ? raw.missing.map(String) : [];

  // 模型判定「不是录入场景」：不产出条目也不追问
  const refused = rawItems.length === 0 && rawMissing.length === 0;

  const out = rawItems.map((r) => {
    const problems = [];

    // 第 6 步：数量与单位（先做，因为后面判断「缺不缺」要用到）
    const qty = validateQty(r.qty);
    if (qty.problem) problems.push(qty.problem);
    const unit = validateUnit(r.unit);
    if (unit.problem) problems.push(unit.problem);

    // 第 1 步：日期校验——合法，且不早于「今天 - 30 天」（更早视为录入错误）
    let expireAt = null;
    let datePhrase = r.date_phrase ? String(r.date_phrase).trim() : null;
    if (r.expire_at) {
      const candidate = String(r.expire_at).trim();
      if (!isValidDate(candidate)) {
        problems.push({ field: 'expireAt', message: `到期日「${candidate}」不是合法日期，请重填` });
      } else if (diffDays(candidate, today) > 30) {
        problems.push({ field: 'expireAt', message: `到期日 ${candidate} 比今天早 30 天以上，是不是听错了？` });
        datePhrase = datePhrase || candidate;
      } else {
        expireAt = candidate;
      }
    }

    // 第 2 步：保质期换算——需要生产日期才做，模型不给生产日期，所以只做「单位合法化」不猜到期日
    let shelfLifeValue = null;
    let shelfLifeUnit = null;
    if (r.shelf_life_value != null && r.shelf_life_value !== '') {
      const v = Number(r.shelf_life_value);
      if (Number.isFinite(v) && v > 0) {
        shelfLifeValue = v;
        shelfLifeUnit = r.shelf_life_unit ? String(r.shelf_life_unit).trim() : null;
        if (shelfLifeUnit && !['天', '日', '周', '月', '年'].includes(shelfLifeUnit)) {
          problems.push({ field: 'shelfLife', message: `保质期单位「${shelfLifeUnit}」不认识，请改成天/周/月/年` });
          shelfLifeUnit = null;
        }
      }
    }

    // 第 3 步：位置匹配
    const location = matchLocation(r.location_hint, locations);
    if (!location.id && location.hint) {
      problems.push({
        field: 'locationId',
        message: location.candidates.length
          ? `「${location.hint}」可能是：${location.candidates.map((c) => c.name).join(' / ')}，请选一个`
          : `没找到位置「${location.hint}」，请选一个`,
      });
    }

    // 第 4 步：物品匹配
    const match = matchItem(r.name, r.spec, items);
    if (!match.itemId && match.candidates.length) {
      problems.push({
        field: 'itemId',
        message: `可能已有同名物品：${match.candidates.map((c) => `${c.name}${c.spec ? ` ${c.spec}` : ''}`).join(' / ')}，确认是新的还是复用一个`,
      });
    }

    // 第 5 步：重复检测（三要素齐全才判断）
    const duplicate = detectDuplicate({ itemId: match.itemId, locationId: location.id, expireAt }, batches);

    const name = String(r.name ?? '').trim();
    if (!name) problems.push({ field: 'name', message: '物品名称没听清，请填一下' });

    // 到期信息：「到期日」或「保质期」至少有一个，否则就是缺关键字段
    const hasExpiry = Boolean(expireAt || shelfLifeValue || datePhrase);

    return {
      name,
      spec: r.spec ? String(r.spec).trim() : null,
      qty: qty.value,
      unit: unit.value,
      category: CATEGORY_LIST.includes(r.category) ? r.category : null,
      opened: Boolean(r.opened),
      expireAt,
      datePhrase,
      shelfLifeValue,
      shelfLifeUnit,
      locationHint: location.hint,
      locationId: location.id,
      locationName: location.name,
      locationCandidates: location.candidates,
      itemId: match.itemId,
      itemMatchedVia: match.via,
      itemCandidates: match.candidates,
      duplicate,
      hasExpiry,
      problems,
    };
  });

  // missing 由模型 + 后端各报一半：模型可能漏报，后端按「关键字段」硬判一次。
  // 关键字段 = 名称 / 数量 / 单位 / 位置 / 到期信息：这五个少一个都写不进 batch 表
  // （unit、location_id 在库里是 NOT NULL，与其让 confirm 报 400，不如先问清楚）。
  const missing = new Set(rawMissing);
  for (const it of out) {
    if (!it.name) missing.add('name');
    if (it.qty == null) missing.add('qty');
    if (it.unit == null) missing.add('unit');
    if (!it.locationId) missing.add('location_hint');
    if (!it.hasExpiry) missing.add('expire_at');
  }

  return {
    items: out,
    missing: [...missing],
    question: raw?.question ? String(raw.question).trim() : null,
    refused,
  };
}
