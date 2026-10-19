/**
 * 认证插件：/api/auth/login、/api/auth/me，以及全局「默认锁死」守卫。
 *
 * 错误一律 401 且消息相同 —— 不区分「用户不存在」和「密码错误」，
 * 防止通过错误信息枚举账号。
 */
import bcrypt from 'bcryptjs';
import { query } from './db.js';

// 用户不存在时也跑一次 bcrypt 对比的「假哈希」：让两条分支耗时相当，防时序攻击。
// 格式必须是合法 bcrypt 结构（$2a$10$ + 53 位 base64），否则 compare 会抛格式错误。
const DUMMY_HASH = '$2a$10$' + 'x'.repeat(53);

export default async function authPlugin(app) {
  const { default: jwt } = await import('@fastify/jwt');
  await app.register(jwt, {
    secret: process.env.JWT_SECRET,
    sign: { expiresIn: '7d' },
  });

  /** 路由守卫：挂 preHandler。没带 token / 过期 / 伪造 → 统一 401。 */
  app.decorate('requireAuth', async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: '请先登录' });
    }
  });

  /**
   * 全局默认锁死：/api/* 下除公开路径外，一律需要登录。
   * 这是 fail-closed —— 之后新加的业务路由不需要记得挂守卫，漏挂也不会裸奔。
   */
  await app.register((scoped) => {
    scoped.addHook('onRequest', async (req, reply) => {
      const path = (req.raw.url || '').split('?')[0];
      if (path === '/api/health' || path === '/api/auth/login') return;
      return app.requireAuth(req, reply);
    });
  });

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
