/**
 * 认证：/api/auth/login、/api/auth/me，以及根级 requireAuth 守卫。
 *
 * 错误一律 401 且消息相同 —— 不区分「用户不存在」和「密码错误」，
 * 防止通过错误信息枚举账号。
 *
 * 注意作用域：Fastify 插件里的 app.decorate 只对该插件作用域及后代可见。
 * 全局 onRequest 钩子跑在根作用域，所以 requireAuth 必须装饰在根 app 上
 * （由 index.js 调 registerAuthGuard 完成），本文件只定义路由。
 */
import bcrypt from 'bcryptjs';
import { query } from './db.js';

// 用户不存在时也跑一次 bcrypt 对比的「假哈希」：让两条分支耗时相当，防时序攻击。
// 格式必须是合法 bcrypt 结构（$2a$10$ + 53 位 base64），否则 compare 会抛格式错误。
const DUMMY_HASH = '$2a$10$' + 'x'.repeat(53);

/** 在根实例上装饰守卫。index.js 里必须在注册路由前调用。 */
export function registerAuthGuard(app) {
  app.decorate('requireAuth', async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: '请先登录' });
    }
  });
}

export default async function authRoutes(app) {
  // 登录：用户名 + 密码 → token（7 天有效，自用不做 refresh token）
  app.post('/auth/login', async (req, reply) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return reply.code(400).send({ code: 'BAD_REQUEST', message: '用户名和密码必填' });
    }

    const rows = await query(
      'SELECT id, tenant_id, username, display_name, role, password_hash FROM member WHERE username = ? AND is_active = 1',
      [username],
    );
    const member = rows[0];

    // 用户不存在时也做一次对比（用假哈希），确保两条分支耗时接近
    const hash = member?.password_hash ?? DUMMY_HASH;
    const ok = await bcrypt.compare(password, hash);

    if (!member || !ok) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: '用户名或密码错误' });
    }

    const token = app.jwt.sign({
      memberId: member.id,
      tenantId: member.tenant_id,
      role: member.role,
    });
    return {
      token,
      member: {
        id: member.id,
        username: member.username,
        displayName: member.display_name,
        role: member.role,
      },
    };
  });

  // 当前用户：带 token 调，返回自己的信息（字段用 camelCase 与登录接口一致，前端少一层映射）
  app.get('/auth/me', { preHandler: [app.requireAuth] }, async (req) => {
    const rows = await query(
      'SELECT id, username, display_name, role, created_at FROM member WHERE id = ? AND tenant_id = ?',
      [req.user.memberId, req.user.tenantId],
    );
    const m = rows[0];
    return {
      member: m && {
        id: m.id,
        username: m.username,
        displayName: m.display_name,
        role: m.role,
        createdAt: m.created_at,
      },
    };
  });
}
