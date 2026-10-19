/**
 * 环境变量加载模块。
 * 必须第一个 import —— ESM 的 import 会被提升到文件顶部按依赖链顺序求值，
 * 如果把 dotenv.config() 写在 index.js 正文里，db.js 顶层的 createPool
 * 会先于它执行，DB_PASSWORD 等变量读不到，MySQL 会报 "using password: NO"。
 * 另外显式指向仓库根 .env：npm workspaces 会把 cwd 切到 server/，
 * 默认的 dotenv.config() 找不到根目录的 .env。
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(repoRoot, '.env') });
