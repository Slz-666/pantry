// 后端入口：只做「启动 + 注册插件」，业务逻辑一律不进这个文件。
// 为什么单独一个文件：阶段 2 起会往这里加 routes 注册，保持 index.js 短小，
// 面试时打开它就能一眼看到整个服务的组成。
import 'dotenv/config'
import Fastify from 'fastify'

const app = Fastify({ logger: true })

// 健康检查：不做任何 IO，只证明「进程活着、端口通、路由注册成功」。
// 阶段 0 的验收就是它，阶段 1 起才会加 db ping。
app.get('/api/health', async () => ({ ok: true }))

const port = Number(process.env.PORT || 8787)
// 监听 0.0.0.0 而不是 127.0.0.1：阶段 7 手机要连电脑的局域网 IP，
// 只听回环地址时手机永远连不上，这个坑提前避开。
const host = process.env.HOST || '0.0.0.0'

try {
  await app.listen({ port, host })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
