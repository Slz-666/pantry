import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // host: true → 监听 0.0.0.0，手机用 http://<电脑局域网IP>:5173 就能打开。
    // 注意：手机走 http 时麦克风/pwa 不可用（安全上下文限制），阶段 7 上 HTTPS。
    host: true,
    // 代理的意义：前端代码里永远只写 /api/xxx，不写后端地址。
    // 这样开发（vite 代理）、上线（同源反向代理）代码完全不用改，也顺带绕开 CORS。
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
})
