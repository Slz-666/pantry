import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.js';
import './styles.css';

createApp(App).use(router).mount('#app');

/**
 * PWA：只在生产构建里注册 Service Worker。
 * dev 下注册会把热更新的模块缓存住，改代码看不到效果（HANDOFF 里的「dev 禁 SW」），
 * 所以这里用 import.meta.env.PROD 卡死，本地开发永远不注册。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service Worker 注册失败', err);
    });
  });
}
