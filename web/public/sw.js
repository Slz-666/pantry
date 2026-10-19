/* 家里有什么 —— 手写 Service Worker
 *
 * 为什么手写、不引 workbox：这里只缓存一个 SPA 壳 + 几个接口 GET，
 * 引构建插件会多一层黑盒；而"哪些走 cache-first、哪些走 network-first"的取舍，
 * 恰好是这个项目要能讲清楚的部分。
 *
 * 策略（对应 DEV-PLAN T6.2 / T6.4）：
 * - 导航请求（HTML）：network-first，失败回缓存 index.html —— 断网刷新也能打开
 * - 静态资源（/assets/*.js|css、/icons/）：cache-first —— 文件名带内容 hash，不会变
 * - 接口 GET（/api/*）：network-first，失败回最后一次成功的响应 —— 厨房弱网也能看到上次库存
 * - 接口写（POST/PATCH/DELETE）：一律不拦。离线写由页面层队列负责（client_op_id 幂等），
 *   SW 不替业务做重试，免得引入"重放顺序"这类更难查的坑。
 *
 * 版本号：CACHE 名带版本，activate 时清掉旧版本。改缓存策略必须改 VERSION，
 * 否则老客户端会一直用旧壳。
 */
const VERSION = 'v1';
const CACHE = `pantry-${VERSION}`;
const SHELL = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    // 只缓存成功的 GET；401/500 之类不能让缓存变味
    if (res && res.status === 200) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const shell = await cache.match(fallbackUrl);
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.status === 200) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return; // 第三方请求不碰
  if (request.method !== 'GET') return; // 写请求交给页面层队列

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/index.html'));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request));
  }
});
