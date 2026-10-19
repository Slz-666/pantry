# 离线与 PWA（阶段 6）

> 这套离线能力的范围是「自用 + 厨房弱网」：断网能看、能记，联网后自动补齐，
> 不追求多设备实时一致。下面写清楚每条策略和它的边界，方便面试时讲取舍。

## 1. 三层缓存

| 层 | 存什么 | 写在哪 | 失效方式 |
|---|---|---|---|
| Service Worker CacheStorage | app 壳（`/`、`index.html`、manifest、图标、构建产物 `/assets/*`） | `web/public/sw.js` | 改 `VERSION` 常量，activate 时清旧版本 |
| IndexedDB `cache` store | 接口 GET 的快照（今日汇总、位置下物品、物品详情…） | `web/src/offline/idb.js` | 每次网络成功即覆盖 |
| IndexedDB `queue` store | 待同步的写操作 | `web/src/offline/idb.js` | flush 成功后删除 |

SW 的 fetch 策略（`web/public/sw.js`）：

| 请求 | 策略 | 为什么 |
|---|---|---|
| 导航（HTML） | network-first → 缓存 `index.html` 兜底 | 断网刷新也能打开壳 |
| `/api/*` GET | network-first → 上次成功响应兜底 | 厨房弱网还能看到上次的库存 |
| `/assets/*`、`/icons/*` | cache-first | 文件名带内容 hash，内容不会变 |
| 写请求（POST/PATCH/DELETE） | **不拦** | 离线写由页面层队列负责，SW 不替业务做重试，避免重放顺序问题 |

dev 下不注册 SW（`web/src/main.js` 里 `import.meta.env.PROD` 卡死）：否则热更新会被缓存住，
改代码看不到效果。

## 2. 读路径：缓存优先，网络覆盖

`getCached(path, params, apply)`（`web/src/api.js`）：

1. 先读 IndexedDB 快照，有就立刻渲染（`apply(data, { cached: true })`）——厨房里秒开；
2. 同时发真实请求，成功则覆盖缓存并再渲染一次（`cached: false`）；
3. 网络失败但手上有缓存 → 不报错，界面顶部显示「离线 · 下面是上次同步的数据」。

用到的地方：首页 `/summary/today`、位置页 `/items?locationId=`、物品详情 `/items/:id`。

## 3. 写路径：入队 + 乐观更新 + 串行重放

`submitWrite({ path, method, body, label })`（`web/src/offline/sync.js`）：

- 离线或网络失败 → 操作落 `queue` store，返回 `{ queued: true }`，界面立刻变；
- 联网 → 直连，业务错误（400/409）如实抛给页面。

`flushQueue()` 的三条规矩：

1. **串行**：按 `createdAt` 顺序发。两个改同一批次的操作不能乱序落库。
2. **失败分类**：网络错 → 停在那儿等下次触发（队列不丢）；业务拒绝（4xx）→ 出队并提示，
   因为再做也不会成功，留着会卡住后面所有操作。
3. **幂等靠服务端**：每项都带 `client_op_id`（`crypto.randomUUID()`），
   `stock_log.client_op_id` 是唯一键，重放多少次库存和流水都只变一次。

触发点四个（`startSync()`）：`online` 事件、`visibilitychange`（回到前台）、页面加载、30 秒定时。
安卓切后台会挂起定时器，所以前两个事件必须都挂，定时只做兜底。

## 4. 冲突策略：LWW（Last Write Wins）

单用户自用场景下，冲突只有一种真实来源：**同一份数据在两台设备上几乎同时改**。
当前策略：以服务端 `updated_at` 新的为准，后到的写覆盖先到的。

局限（明确写出来，不装）：

- 不做字段级合并，也不做向量时钟。两台设备同时改同一个批次的数量，后同步的那个赢。
- 离线队列**不重基**：离线期间如果另一台设备把这个批次消耗光了，重放时会收到
  `409/400`（数量不足、批次已结束），队列按「业务拒绝」出队并提示，不会静默改坏数据。
- 提醒（`alert`）有 `(batch_id, type, due_date)` 唯一键，重复扫描天然去重，不产生"重复提醒"这类冲突。

## 5. PWA 可安装性

- `web/public/manifest.json`：`display: standalone`、`theme_color: #0e7c6b`（与界面主色一致）、
  192/512 常规图标 + 512 maskable 图标。
- 图标由 `.cache/icon.mjs` 用无头 Edge 渲染 HTML 生成（机器上没有设计工具），
  保证和 `styles.css` 的 `--c-primary` 完全同色。
- 装机要求 HTTPS 或 localhost（HANDOFF 已记：手机走 http 访问时麦克风也会静默失效）。

## 6. 验收结果（真实输出）

`.cache/p6-offline.mjs` 用无头 Edge + CDP 模拟断网，11 项全过：

```
✓ Service Worker 已注册 — {"supported":true,"registered":true,"controller":true,"scope":"http://localhost:4173/"}
  navigator.onLine = false
✓ 断网刷新页面能打开（SW 壳）
✓ 断网仍能看到上次的提醒内容 — 页面文本里找「酸奶」
✓ 断网点「用掉 1 个」能点（不报错）
✓ 界面出现「待同步」状态条 — 离线 · 待同步 1 条
✓ 离线队列里有 1 条待同步操作 — 队列 1 条
✓ 恢复网络后队列被清空 — 队列 0 条
✓ 该提醒已从待处理里消失
✓ stock_log 只多 1 条（幂等） — 12 → 13
✓ 批次数量正好少 1 — 1 → 0
```

截图：`docs/screenshots/p6-offline.png`（断网态的提醒页，顶部「离线 · 待同步 1 条」）。
