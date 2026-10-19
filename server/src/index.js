import './env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import authPlugin from './auth.js';

const app = Fastify({ logger: true });

// 开发期允许 Vite 5173 跨域直连（生产中前端和 API 同源，CORS 只影响开发体验）
await app.register(cors, { origin: true });

// 健康检查：部署/监控用，不需要登录
app.get('/api/health', async () => ({ ok: true }));

// 认证插件挂到 /api 前缀：内部路由 /auth/login、/auth/me，并带全局鉴权钩子
await app.register(authPlugin, { prefix: '/api' });

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
