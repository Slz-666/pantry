// migrate.js｜按文件名顺序执行 server/migrations/*.sql，已经执行过的跳过。
// 为什么手写这 20 行而不用 knex/prisma：迁移本身就是"按顺序跑 SQL 文件"，
// 引一个框架要学一套 DSL，面试时说不清里面的东西，这里保持透明（HANDOFF 决策 #8）。
// 用法：node server/scripts/migrate.js
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pantry',
  // 迁移文件是一整段 SQL，允许多语句一次执行
  multipleStatements: true,
  charset: 'utf8mb4',
});

// 记录表：谁执行过，第二个跑的人/第二次跑就知道跳过
await conn.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    VARCHAR(128) NOT NULL,
    applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
`);

const [appliedRows] = await conn.query('SELECT version FROM schema_migrations');
const applied = new Set(appliedRows.map((r) => r.version));

const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort(); // 001_、002_ 前缀保证顺序

let count = 0;
for (const file of files) {
  if (applied.has(file)) continue;

  console.log(`applying ${file} ...`);
  try {
    await conn.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
    console.log(`  ok ${file}`);
    count += 1;
  } catch (err) {
    // MySQL 的 DDL 会隐式提交，没法真正回滚，所以这里明确报错并停止：
    // 修好迁移文件后重跑即可（脚本里的 CREATE TABLE IF NOT EXISTS 支持重复执行）。
    console.error(`  FAILED ${file}: ${err.message}`);
    console.error('迁移是 DDL，MySQL 无法自动回滚；修复该 SQL 后直接重跑本脚本。');
    console.error('已完成的迁移都在 schema_migrations 里记录，重跑不会重复执行。');
    process.exitCode = 1;
    break;
  }
}

if (count === 0) {
  console.log('nothing to migrate');
} else {
  console.log(`done, ${count} migration(s) applied`);
}

await conn.end();
