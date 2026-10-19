import './env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { registerAuthGuard } from './auth.js';
import authRoutes from './auth.js';
import locationRoutes from './routes/locations.js';
import itemRoutes from './routes/items.js';
import batchRoutes from './routes/batches.js';
import shoppingRoutes from './routes/shopping.js';
import alertRoutes from './routes/alerts.js';
import summaryRoutes from './routes/summary.js';

const app = Fastify({ logger: true });

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
app.setNotFoundHandler((req, reply) => {
  reply.code(404).send({ code: 'NOT_FOUND', message: `接口不存在：${req.method} ${req.url}` });
});

// 认证与业务路由
await app.register(authRoutes, { prefix: '/api' });
await app.register(locationRoutes, { prefix: '/api' });
await app.register(itemRoutes, { prefix: '/api' });
await app.register(batchRoutes, { prefix: '/api' });
await app.register(shoppingRoutes, { prefix: '/api' });
await app.register(alertRoutes, { prefix: '/api' });
await app.register(summaryRoutes, { prefix: '/api' });

// 生产用定时扫描：每分钟检查一次提醒（本地 dev 不一定要跑，但起来也无害）。
// 用 unref 的 interval，不让它拖住进程退出。
const scanMs = Number(process.env.SCAN_INTERVAL_MS || 0);
if (scanMs > 0) {
  const { scanAlerts } = await import('./services/alerts.js');
  setInterval(() => {
    scanAlerts(1).catch((err) => app.log.error({ err }, 'scan failed'));
  }, scanMs).unref();
}

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
