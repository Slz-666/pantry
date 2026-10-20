// seed.js｜幂等种子数据：默认租户、管理员账号、位置树、提醒规则。
// 幂等的意思：跑一次和跑十次结果一样（靠唯一键 + 先查后插），不会重复插入。
// 用法：node server/scripts/seed.js
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pantry',
  charset: 'utf8mb4',
});

// Docker/自建实例里 root 是唯一账号，用它当 owner 成员
const TENANT_NAME = '我家';
const ADMIN_USERNAME = 'admin';
// 这个密码是本地演示用，写进 README 前会提醒用户自己改
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'pantry123';

// ---- 租户 ----
let [tenants] = await conn.query('SELECT id FROM tenant WHERE name = ? LIMIT 1', [TENANT_NAME]);
let tenantId = tenants[0]?.id;
if (!tenantId) {
  const [r] = await conn.query('INSERT INTO tenant (name) VALUES (?)', [TENANT_NAME]);
  tenantId = r.insertId;
  console.log(`created tenant: ${TENANT_NAME} (id=${tenantId})`);
} else {
  console.log(`tenant exists: ${TENANT_NAME} (id=${tenantId})`);
}

// ---- 分类（默认 8 类，用户之后可以在「我的 → 分类管理」里增删改）----
const DEFAULT_CATEGORIES = ['食品', '日用品', '药品', '护肤品', '清洁用品', '宠物用品', '工具', '其他'];
for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
  await conn.query('INSERT IGNORE INTO category (tenant_id, name, sort_order) VALUES (?, ?, ?)', [
    tenantId,
    DEFAULT_CATEGORIES[i],
    i + 1,
  ]);
}
const [[{ catCount }]] = await conn.query('SELECT COUNT(*) AS catCount FROM category WHERE tenant_id = ?', [tenantId]);
console.log(`categories ready: ${catCount}`);

// ---- 管理员账号 ----
let [members] = await conn.query('SELECT id FROM member WHERE tenant_id = ? AND username = ? LIMIT 1', [
  tenantId,
  ADMIN_USERNAME,
]);
if (!members[0]) {
  // bcrypt 10 轮：本地单用户够用，再高会让登录明显变慢
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  await conn.query(
    'INSERT INTO member (tenant_id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)',
    [tenantId, ADMIN_USERNAME, hash, '管理员', 'owner'],
  );
  console.log(`created member: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
} else {
  console.log(`member exists: ${ADMIN_USERNAME}`);
}

// ---- 位置树 ----
// PRD 的默认结构：厨房=1，冰箱下分冷藏/冷冻/冷冻室，储藏室=3，阳台=7，卫生间=8，车库=9
// 名称是用户能自己改的展示名；key 只用于种子脚本的重复执行判断，不进表。
const LOCATION_TREE = [
  { name: '厨房', children: [] },
  { name: '冰箱', children: ['冷藏', '冷冻', '冷冻室'] },
  { name: '储藏室', children: [] },
  { name: '阳台', children: [] },
  { name: '卫生间', children: [] },
  { name: '车库', children: [] },
];

async function ensureLocation(parentId, name, sortOrder) {
  // parent_id 为 NULL 时用 IS NULL 查询，避免 = NULL 永远不成立
  const where = parentId === null ? 'tenant_id = ? AND parent_id IS NULL AND name = ?' : 'tenant_id = ? AND parent_id = ? AND name = ?';
  const params = parentId === null ? [tenantId, name] : [tenantId, parentId, name];
  const [rows] = await conn.query(`SELECT id FROM location WHERE ${where} LIMIT 1`, params);
  if (rows[0]) return rows[0].id;

  const [r] = await conn.query(
    'INSERT INTO location (tenant_id, parent_id, name, sort_order) VALUES (?, ?, ?, ?)',
    [tenantId, parentId, name, sortOrder],
  );
  return r.insertId;
}

let locSort = 0;
for (const node of LOCATION_TREE) {
  const rootId = await ensureLocation(null, node.name, locSort++);
  let childSort = 0;
  for (const child of node.children) {
    await ensureLocation(rootId, child, childSort++);
  }
}
const [[{ locCount }]] = await conn.query('SELECT COUNT(*) AS locCount FROM location WHERE tenant_id = ?', [tenantId]);
console.log(`locations ready: ${locCount}`);

// ---- 提醒规则 ----
// days_before 是提前提醒的天数节点（数组）；opened_days 是开封后几天内要吃掉的提醒。
// 食品/药品/日用品先各给一组默认值，用户之后可以改。
const RULES = [
  { category: '食品', daysBefore: [30, 7, 1, 0], openedDays: 3 },
  { category: '药品', daysBefore: [90, 30, 7, 0], openedDays: 30 },
  { category: '日用品', daysBefore: [30, 7, 0], openedDays: null },
];

for (const rule of RULES) {
  const [rows] = await conn.query('SELECT id FROM reminder_rule WHERE tenant_id = ? AND category = ? LIMIT 1', [
    tenantId,
    rule.category,
  ]);
  if (rows[0]) continue;
  await conn.query(
    'INSERT INTO reminder_rule (tenant_id, category, days_before, opened_days) VALUES (?, ?, ?, ?)',
    [tenantId, rule.category, JSON.stringify(rule.daysBefore), rule.openedDays],
  );
  console.log(`created rule: ${rule.category} days=${JSON.stringify(rule.daysBefore)} opened=${rule.openedDays}`);
}

const [[{ ruleCount }]] = await conn.query('SELECT COUNT(*) AS ruleCount FROM reminder_rule WHERE tenant_id = ?', [
  tenantId,
]);
console.log(`rules ready: ${ruleCount}`);
console.log('seed done');
await conn.end();
