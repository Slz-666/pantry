import './env.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import cron from 'node-cron';
import { query } from './db.js';
import { scanAlerts } from './services/alerts.js';
import { registerAuthGuard } from './auth.js';
import authRoutes from './auth.js';
import locationRoutes from './routes/locations.js';
import itemRoutes from './routes/items.js';
import batchRoutes from './routes/batches.js';
import shoppingRoutes from './routes/shopping.js';
import alertRoutes from './routes/alerts.js';
import summaryRoutes from './routes/summary.js';
import extractRoutes from './routes/extract.js';
import metaRoutes from './routes/meta.js';
import reminderRoutes from './routes/reminders.js';
import categoryRoutes from './routes/categories.js';

/**
 * 生产形态（HANDOFF 阶段 7 / DEV-PLAN T7.2、T7.3）：
 * 1) 前端构建产物交给本进程托管，前端与 API 同源——少一个 nginx 容器，也不用配 CORS/反代；
 * 2) HTTPS_CERT + HTTPS_KEY 存在时用 https 起服务：PWA 安装、Service Worker、麦克风都要求安全上下文，
 *    手机走 http://192.168.x.x 时语音按钮会静默失效（HANDOFF §9 已知坑）。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = process.env.WEB_DIST || path.resolve(here, '../../web/dist');
const hasWebDist = existsSync(path.join(webDist, 'index.html'));

const httpsCert = process.env.HTTPS_CERT;
const httpsKey = process.env.HTTPS_KEY;
const useHttps = Boolean(httpsCert && httpsKey);

const app = Fastify({
  logger: true,
  ...(useHttps
    ? {
        https: {
          cert: readFileSync(httpsCert),
          key: readFileSync(httpsKey),
        },
      }
    : {}),
});

// 开发期允许 Vite 5173 跨域直连（生产中前端和 API 同源，CORS 只影响开发体验）
await app.register(cors, { origin: true });

// 健康检查：部署/监控用，不需要登录
app.get('/api/health', async () => ({ ok: true }));

// JWT 插件（它用 fastify-plugin 包装，装饰对子作用域可见）
await app.register(jwt, {
  secret: process.env.JWT_SECRET,
  sign: { expiresIn: '7d' },
});

// 根级守卫装饰（全局钩子跑在根作用域，必须能访问到它）
registerAuthGuard(app);

/**
 * 全局默认锁死：/api/* 下除公开路径外一律要求登录（fail-closed）。
 * 钩子必须在业务路由注册之前定义，因为 Fastify 的钩子只对之后注册的路由生效。
 * 这样以后新加的路由不用记得挂守卫，漏挂也不会裸奔。
 */
app.addHook('onRequest', async (req, reply) => {
  const path = (req.raw.url || '').split('?')[0];
  if (path === '/api/health' || path === '/api/auth/login') return;
  if (!path.startsWith('/api/')) return;
  return app.requireAuth(req, reply);
});

/**
 * 统一错误出口（T2.9）：前端永远只看到 { code, message }。
 * 业务错误在路由里已经显式 fail() 了，这里兜住「没预期的异常」——
 * 绝不能把 MySQL 原文、SQL 片段、堆栈吐给客户端（既难看也泄露表结构）。
 * 完整的错误照旧进服务端日志，方便自己排查。
 */
app.setErrorHandler((err, req, reply) => {
  const status = Number.isInteger(err.statusCode) && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) {
    // 只有 5xx 才需要记完整堆栈；日志不脱敏是给自己排查用的
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'INTERNAL', message: '服务器内部错误，请稍后重试' });
  }
  // 4xx：业务错误自带 code（OpError），其余情况统一 BAD_REQUEST，不泄露内部细节
  const code = typeof err.code === 'string' && /^[A-Z_]{2,32}$/.test(err.code) ? err.code : 'BAD_REQUEST';
  return reply.code(status).send({ code, message: err.message || '请求不合法' });
});

// 不存在的接口也返回统一格式，而不是 Fastify 默认的 { error, message }
// 有前端产物时，非 /api 的 GET 交给 SPA（刷新 /item/42 这类深链接不会 404）
app.setNotFoundHandler((req, reply) => {
  if (hasWebDist && req.method === 'GET' && !req.url.startsWith('/api')) {
    return reply.sendFile('index.html');
  }
  return reply.code(404).send({ code: 'NOT_FOUND', message: `接口不存在：${req.method} ${req.url}` });
});

// 静态产物：/sw.js、/manifest.json、/icons/*、/assets/* 都由它送出（带正确的 MIME 与缓存头）
if (hasWebDist) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
}

// 认证与业务路由
await app.register(authRoutes, { prefix: '/api' });
await app.register(locationRoutes, { prefix: '/api' });
await app.register(itemRoutes, { prefix: '/api' });
await app.register(batchRoutes, { prefix: '/api' });
await app.register(shoppingRoutes, { prefix: '/api' });
await app.register(alertRoutes, { prefix: '/api' });
await app.register(summaryRoutes, { prefix: '/api' });
await app.register(extractRoutes, { prefix: '/api' });
await app.register(metaRoutes, { prefix: '/api' });
await app.register(reminderRoutes, { prefix: '/api' });
await app.register(categoryRoutes, { prefix: '/api' });

/**
 * T5.1 每天早 8:00 扫一遍提醒（到期 / 开封后到期 / 低库存）。
 * 为什么可以放心重复跑：alert 表有 (batch_id, type, due_date) 唯一键，
 * 扫描用 INSERT IGNORE，跑 100 次和跑 1 次数结果一样——不需要「上次扫到哪」的状态。
 * 多租户结构上是对的，所以按 tenant 表逐个扫（个人版实际只有 id=1）。
 */
async function scanAllTenants(reason) {
  const tenants = await query('SELECT id FROM tenant');
  const total = { expire: 0, opened: 0, lowStock: 0 };
  for (const t of tenants) {
    const r = await scanAlerts(t.id);
    total.expire += r.expire ?? 0;
    total.opened += r.opened ?? 0;
    total.lowStock += r.lowStock ?? 0;
  }
  app.log.info({ reason, ...total }, 'alert scan done');
  return total;
}

cron.schedule(
  '0 8 * * *',
  () => {
    scanAllTenants('cron-8am').catch((err) => app.log.error({ err }, 'daily alert scan failed'));
  },
  { timezone: 'Asia/Shanghai' },
);

// 开发期可选的高频扫描（SCAN_INTERVAL_MS>0 才开），生产用上面的 cron 就够
const scanMs = Number(process.env.SCAN_INTERVAL_MS || 0);
if (scanMs > 0) {
  setInterval(() => {
    scanAllTenants('interval').catch((err) => app.log.error({ err }, 'scan failed'));
  }, scanMs).unref();
}

const port = Number(process.env.HTTPS_PORT || process.env.PORT || (useHttps ? 8443 : 8787));
const host = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port, host });
  if (hasWebDist) app.log.info({ webDist }, 'serving web build');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// 开了 HTTPS 之后 PORT（默认 8787）就空出来了，但电脑上的旧书签还写着 http://localhost:8787。
// 这里补一个极轻的 301 跳转，让旧地址不至于直接打不开——省得用户以为服务挂了。
const plainPort = Number(process.env.PORT || 8787);
if (useHttps && plainPort !== port) {
  const { createServer } = await import('node:http');
  const redirect = createServer((req, res) => {
    const hostname = (req.headers.host || 'localhost').split(':')[0];
    res.writeHead(301, { Location: `https://${hostname}:${port}${req.url || '/'}` });
    res.end();
  });
  redirect.on('error', (err) => app.log.warn({ err }, 'http redirect listener failed'));
  redirect.listen(plainPort, host, () => app.log.info({ port: plainPort, to: port }, 'http → https redirect on'));
}
