# 开发计划：家里有什么（pantry）

> 依据：`PRD.md` v1.0
> 交接入口：`HANDOFF.md`（决策锁定 / 环境实况 / 硬规则 / 已知坑）
> 原则：每个阶段可独立验收，**通过 CHECKPOINT 才进入下一阶段**
> 阶段内任务按顺序执行，标 `[阻塞]` 的必须先完成

---

## 0. 前置条件

### 0.1 环境清单

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node | ≥ 20（本机 24 可用） | `node -v` |
| MySQL | 8.0+，本机或 Docker | `mysql -V` 或 `docker ps` |
| Git | 任意 | `git --version` |
| 安卓手机 | Chrome 100+，与电脑同一 WiFi | — |
| DeepSeek API Key | 已有 | — |

### 0.2 需要准备的外部资源

- 一个 MySQL 库（本地 Docker 最省事：`docker run -d --name pantry-mysql -e MYSQL_ROOT_PASSWORD=xxx -e MYSQL_DATABASE=pantry -p 3306:3306 mysql:8.4`）
- 一个能长期开机的机器（旧笔记本/迷你主机/公司不给就用自己的电脑，睡眠会断服务）
- 域名（可选，决定阶段 7 走哪条路）

### 0.3 目录结构（一开始就定死）

```
D:\vibecoding\                # git 仓库根，不再套一层 pantry/
├── package.json              # npm workspaces: server, web
├── .env.example
├── docker-compose.yml
├── README.md
├── PRD.md                    # 已有
├── DEV-PLAN.md               # 已有
├── HANDOFF.md                # 已有
├── docs/                     # 已有；后续加 schema.md / extract-eval.md / interview.md
├── server/
│   ├── package.json
│   ├── migrations/
│   │   └── 001_init.sql
│   ├── scripts/
│   │   ├── migrate.js
│   │   ├── seed.js
│   │   └── smoke.sh
│   └── src/
│       ├── index.js          # 启动 + 注册插件
│       ├── db.js             # 连接池
│       ├── auth.js           # JWT 签发与校验
│       ├── routes/           # auth items batches locations extract shopping alerts
│       ├── services/
│       │   ├── extract.js    # 调 LLM
│       │   ├── normalize.js  # 确定性归一化（最有价值的一个文件）
│       │   ├── inventory.js  # 事务化的增减库存
│       │   └── alerts.js     # 扫描与去重
│       └── lib/               # 日期、单位、错误类
└── web/
    ├── index.html
    ├── vite.config.js
    ├── public/               # manifest.json, icons
    └── src/
        ├── main.js
        ├── App.vue
        ├── router.js
        ├── api.js            # fetch 封装 + 401 处理
        ├── store.js          # 一个 reactive 对象，不引 Pinia
        ├── offline/
        │   ├── idb.js        # 缓存 + 队列
        │   └── sync.js       # flush
        ├── voice.js          # Web Speech 封装
        ├── styles.css        # 设计 token + 响应式
        ├── views/            # Home Location ItemDetail Add Shopping Alerts Settings Login
        └── components/       # ItemCard BatchRow ConfirmSheet Sheet Field
```

**组件数量上限 6 个，页面 8 个。** 超了就说明设计有问题，先停下来看 PRD。

---

## 阶段 0｜地基（先跑起来，不写业务）

**目标**：一条命令起前后端，浏览器能打开页面，`/api/health` 通。

| ID | 任务 | 产物 |
|---|---|---|
| T0.1 | `git init`，建目录，根 `package.json` 用 npm workspaces 声明 `server` `web` | 目录树 |
| T0.2 | 装服务端依赖：`fastify @fastify/cors @fastify/jwt mysql2 bcryptjs zod node-cron dotenv` | `server/package.json` |
| T0.3 | 装前端依赖：`vue vue-router idb-keyval` + `-D vite @vitejs/plugin-vue` | `web/package.json` |
| T0.4 | `server/src/index.js` 最小 Fastify + `/api/health`，端口 8787 | 能 `curl` 通 |
| T0.5 | `web/vite.config.js` 配 `server: { host: true, proxy: { '/api': 'http://localhost:8787' } }` | 前端能转请求 |
| T0.6 | `App.vue` 显示"家里有什么"，调一次 `/api/health` 打印结果 | 页面有输出 |
| T0.7 | `.env.example` 写清所有变量（DB、JWT_SECRET、DEEPSEEK_KEY、PORT） | 文件 |
| T0.8 | 根 `package.json` 加 `dev:server` `dev:web` `dev`（concurrently 或开两个终端） | 脚本 |

**验收**

```bash
npm run dev:server            # 另开一个终端
curl http://localhost:8787/api/health   # {"ok":true}
npm run dev:web               # 浏览器打开 5173，页面显示 ok:true
```

**CHECKPOINT 0**：两个终端都起来，页面能看到接口返回值。截图存档。

---

## 阶段 1｜数据层（表先立住）

**目标**：11 张表建好，seed 出一套能用的默认数据，迁移可重复执行。

| ID | 任务 | 产物 |
|---|---|---|
| T1.1 `[阻塞]` | 写 `001_init.sql`：tenant / member / location / item / batch / stock_log / shopping_item / reminder_rule / alert / extraction_log / setting | 11 张表 |
| T1.2 | 关键索引：`batch(tenant_id, expire_at)`、`batch(tenant_id, location_id)`、`item(tenant_id, name)`、`stock_log(client_op_id) UNIQUE`、`alert(batch_id, type, due_date) UNIQUE` | 索引齐全 |
| T1.3 | `scripts/migrate.js`：建 `schema_migrations`，按文件名排序执行未跑过的 SQL | 可重复跑 |
| T1.4 | `scripts/seed.js`：tenant=1、member（bcrypt 密码）、位置树（冰箱>冷藏/冷冻/门架、厨房柜、储物间、药箱、卫生间、阳台）、分类、默认提醒规则 | 一份家用数据 |
| T1.5 | `db.js`：连接池，`timezone: '+08:00'`，`charset: utf8mb4`，`dateStrings: true`（避免时区坑） | 连接正常 |
| T1.6 | 写 `docs/schema.md`，画一张表关系图（纯文字版即可） | 文档 |

**验收**

```bash
node server/scripts/migrate.js   # 第一次建表
node server/scripts/migrate.js   # 第二次输出 "nothing to migrate"
node server/scripts/seed.js      # 幂等：重复跑不报错、不重复插
mysql -e "SHOW TABLES FROM pantry"   # 11 张
```

**CHECKPOINT 1**：迁移可重复、seed 幂等、`SELECT * FROM alert` 有唯一键约束。

---

## 阶段 2｜接口层（先把库存跑通，不碰 AI）

**目标**：能用 curl 走完"登录 → 建位置 → 建物品 → 建批次 → 消耗 → 看流水"。

| ID | 任务 | 说明 |
|---|---|---|
| T2.1 | `auth.js`：bcrypt 比对、签发 JWT（7 天），中间件从 token 取 `{ tenantId, memberId }` 挂到 `request` | 所有路由的前置 |
| T2.2 | `POST /api/auth/login`、`GET /api/auth/me` | 错误统一 401 |
| T2.3 | `locations` 全组接口；树查询用递归 CTE（`WITH RECURSIVE`） | 删除有子节点返回 409 |
| T2.4 | `items` 全组接口；搜索支持 name / aliases(JSON) / barcode | 软删 `deleted_at` |
| T2.5 `[阻塞]` | `services/inventory.js`：`in / consume / discard / adjust / move` 五个操作，**每个都在事务里**：`SELECT ... FOR UPDATE` 锁批次 → 校验 qty → 更新 → 写 stock_log（带 client_op_id） | 并发安全 + 幂等 |
| T2.6 | `batches` 查询：按位置子树、按到期区间、按状态 | 走索引 |
| T2.7 | `shopping` 全组；`POST /shopping/:id/stock` 生成批次 + 写流水 + 关清单项 | 一个事务 |
| T2.8 | `alerts`：扫描函数（到期 / 开封到期 / 低库存）+ `POST /jobs/scan` + 列表 + handle 三动作 | 唯一键去重 |
| T2.9 | 统一错误处理：`{ code, message }`，不把 SQL 错误直接吐给前端 | 错误边界 |
| T2.10 | `scripts/smoke.sh`：上面全流程的 curl 脚本 | 一键回归 |

**验收**

```bash
bash server/scripts/smoke.sh
# 期望输出：每一步 200，最后打印 created batch 与 stock_log 数量
# 关键断言：同一个 client_op_id 连发 2 次，stock_log 只多 1 条
# 关键断言：qty=3 的批次消耗 4 个 → 400 且数量不变
```

**CHECKPOINT 2**：冒烟脚本全绿，两个幂等断言通过。这是整个后端的地基，**不过不许往前**。

---

## 阶段 3｜界面骨架（双端同时设计）

**目标**：375 宽和 1440 宽都能用，两种布局共用一套数据和接口。

| ID | 任务 | 说明 |
|---|---|---|
| T3.1 | `styles.css`：CSS 变量（色板、间距、圆角、字号），断点 `768px` | 先定 token，别边写边改 |
| T3.2 | `router.js` + 登录页 + 路由守卫（无 token 跳登录） | token 存 localStorage |
| T3.3 | `api.js`：fetch 封装，自动带 token，401 跳登录，错误 toast | 统一出口 |
| T3.4 | 移动端布局：底部 4 tab（首页/清单/提醒/我的）+ 悬浮录入按钮 | `<768px` |
| T3.5 | 桌面端布局：左侧位置树 + 右侧内容区 | `>=768px` |
| T3.6 | 组件 6 个：`ItemCard` `BatchRow` `ConfirmSheet` `Sheet` `Field` `Empty` | 就这 6 个 |
| T3.7 | 首页：今日摘要 + 快到期 + 位置快捷入口 | 真实数据 |
| T3.8 | 位置浏览页：手机逐层下钻 / 电脑左树右表 | 同一路由两种渲染 |
| T3.9 | 物品详情页：批次列表 + 最近流水 | 真实数据 |
| T3.10 | 到期色条：`>7天 灰 / 3-7天 黄 / ≤2天 红 / 已过期 深红` | 一眼能看出 |

**验收**

- 浏览器 DevTools 切 375×812 与 1440×900，各截一张图，布局不塌、不横向滚动
- 两端看到的是同一批数据（在手机上加一条批次，电脑刷新能看到）

**CHECKPOINT 3**：两张截图对比。**过不了就调布局，不要动业务逻辑。**

---

## 阶段 4｜录入 Agent（项目的核心，占全部价值的一半）

**目标**：说一句话 → 确认卡片 → 入库，全程 ≤ 3 步。

| ID | 任务 | 说明 |
|---|---|---|
| T4.1 | `services/extract.js`：调 DeepSeek，`response_format: {type:'json_object'}`，system prompt 用 PRD 9.1 的 6 条规则 | 超时 15s、失败重试 1 次 |
| T4.2 | 写 `extraction_log`：原话、模型原始 JSON、耗时、token 数 | 后面算指标靠它 |
| T4.3 `[阻塞]` | `services/normalize.js`：日期校验 → 保质期换算 → 位置匹配 → 物品匹配 → 重复检测 → 数量/单位校验（PRD 9.2 六步） | **纯函数，能单测** |
| T4.4 | `POST /api/extract`：返回 `{ draftId, draft, question, missing }`，不写业务表 | 草稿态 |
| T4.5 | `POST /api/extract/:id/confirm`：一个事务内建 item（如需）+ batch + stock_log，改 log 状态 | 幂等（重复 confirm 返回 409） |
| T4.6 | 前端录入页：输入框 + 麦克风按钮 + 确认卡片（字段可改、位置下拉、日期选择器） | 全屏，手机优先 |
| T4.7 | `voice.js`：`webkitSpeechRecognition`，`lang='zh-CN'`，`interimResults=true` 实时显示，出错给提示 | 仅安卓 Chrome |
| T4.8 | 缺字段追问：`missing` 非空时，确认卡片顶部显示 `question`，缺的字段高亮 | 不阻断其它字段 |
| T4.9 | 重复检测交互：提示"合并为已有物品的新批次 / 新建物品" | 默认选合并 |
| T4.10 | 一键复购：从物品详情页进录入页，预填规格/单位/位置 | 减摩擦 |
| T4.11 | 兜底：模型超时 / JSON 非法 → 直接跳手动表单，字段清空但保留原话 | 绝不卡死 |
| T4.12 | 20 条测试集（见下表）跑一遍，把结果记进 `docs/extract-eval.md` | 成功率 ≥ 80% |

### 20 条抽取测试集

| # | 输入 | 期望行为 |
|---|---|---|
| 1 | 牛奶6盒放冰箱中层，25号到期 | 4 字段全出，直接可确认 |
| 2 | 买了三提纸巾，储物间 | 数量=3、位置命中"储物间"、缺日期 → 追问 |
| 3 | 鸡蛋一板30个，冷藏，保质期30天 | 出 shelf_life，不自己算到期日 |
| 4 | 布洛芬一盒放药箱，明年3月过期 | 日期=次年 3 月 1 日或末日的合理推断，需人工确认 |
| 5 | 酸奶8杯，冷藏，下周三过期 | 相对日期 → `date_phrase`，追问具体日期 |
| 6 | 买了牛奶 | 缺 3 个字段 → 一次问全 |
| 7 | 两瓶生抽，厨房柜，保质期18个月 | 出 shelf_life，缺生产日期 → 追问或留空 |
| 8 | 维生素C一瓶，药箱，已经开封了 | `opened=true`，触发开封倒计时 |
| 9 | 冷冻了5斤猪肉 | 位置=冷冻、数量=5、单位=斤 |
| 10 | 上次那个牛奶又买了6盒 | 匹配到已有物品，复用 item_id |
| 11 | 冰箱里的牛奶还剩几盒 | **不是录入场景** → 明确拒绝并引导去搜索 |
| 12 | 大米10斤，储物间，2027年5月到期 | 跨年日期解析正确 |
| 13 | 牙膏三支，卫生间，保质期两年 | 中文数字 + 年为单位 |
| 14 | 速冻饺子2袋放冷冻，60天保质期 | 阿拉伯数字 + 天为单位 |
| 15 | 口罩一盒50个，储物间 | 规格 50 个/盒，数量 1 盒 |
| 16 | 啤酒一箱12瓶，阳台，明年1月到期 | 箱/瓶两级单位，取箱 |
| 17 | 纸巾和洗衣液各买一份，储物间 | **多物品** → 拆成 2 条 |
| 18 | 面包两个，明天到期 | 相对日期 → 追问 |
| 19 | 把冰箱的牛奶改成4盒 | **修改语义** → 拒绝，引导去编辑 |
| 20 | 洗面奶一瓶，卫生间，开封后6个月内用完 | 开封期限，不是保质期 |

**验收**

- 20 条过一遍，`confirmed` 占比 ≥ 80%
- 6 条边界用例（5/11/17/18/19/20）行为正确
- 每条失败都在 `extraction_log` 能查到原因

**CHECKPOINT 4**：这是项目能否成立的分水岭。过不了不要往下做提醒和离线，先修抽取。

---

## 阶段 5｜提醒与清单

| ID | 任务 | 说明 |
|---|---|---|
| T5.1 | `node-cron` 每早 8:00 跑扫描；同时保留手动触发接口 | 单进程部署就够 |
| T5.2 | 扫描逻辑：到期（按品类提前量）→ 开封到期 → 低库存；写 alert，靠唯一键去重 | 重复跑不重复生成 |
| T5.3 | `POST /alerts/:id/handle`：done / discard / ignore，前两者同时扣库存 | 事务 |
| T5.4 | `GET /summary/today`：今天到期几条、该补几条 | 首页顶部一句话 |
| T5.5 | 清单页：手动加、勾选、一键入库（选位置+到期日） | 复用阶段 2 的接口 |
| T5.6 | 自动建议：低库存/已过期进"待确认"区，不直接进清单 | 需手动采纳 |
| T5.7 | 提醒中心：待办 / 已处理两栏 | |

**验收**

- 造 3 条明天到期的批次 + 1 条低库存 → 跑扫描 → 出现 4 条提醒
- 再跑一次扫描 → 提醒数不变（去重生效）
- 点"已用掉" → 提醒消失、批次数量减 1、流水多一条

**CHECKPOINT 5**：去重、扣减、状态流转三个断言都通过。

---

## 阶段 6｜离线与 PWA（"自己用"的关键）

| ID | 任务 | 说明 |
|---|---|---|
| T6.1 | `manifest.json` + 图标（192/512）+ `theme_color` | 可安装 |
| T6.2 | Service Worker（手写）：缓存 app shell，接口走 network-first + 缓存兜底 | 不加构建插件 |
| T6.3 | `offline/idb.js`：两张 store——`cache`（items/batches 快照）、`queue`（待同步写操作） | idb-keyval |
| T6.4 | 读路径：先给缓存，再拉网络覆盖 | 厨房里秒开 |
| T6.5 | 写路径：`consume`/`in` 先入队列 → UI 乐观更新 → 后台 flush | 断网也能记 |
| T6.6 | `client_op_id` 用 `crypto.randomUUID()` 生成，作为幂等键 | 重试不会重复 |
| T6.7 | flush 触发点：`online` 事件、`visibilitychange`、每 30s 定时、页面加载 | 三个都要 |
| T6.8 | UI 显示"待同步 N 条"，同步失败给重试按钮 | 状态可见 |
| T6.9 | 冲突策略：LWW（服务端 `updated_at` 新的赢），在 `docs/` 里写明局限 | 单用户够用 |

**验收**

- DevTools → Network → Offline：刷新页面能打开，能看到上次的库存
- 断网状态下点"用掉一个" → 数字立刻变、显示"待同步 1 条"
- 恢复网络 → 自动同步 → 服务端 `stock_log` **只多 1 条**（幂等）

**CHECKPOINT 6**：断网闭环通过。这是"自己用"和"演示品"的分界线。

---

## 阶段 7｜部署与真机

### 7a 局域网先跑通

| ID | 任务 |
|---|---|
| T7.1 | `docker-compose.yml`：mysql + server + web（nginx 或 node 静态） |
| T7.2 | 前端 `npm run build`，产物由 server 的 `@fastify/static` 托管（少一个容器） |
| T7.3 | 用 `mkcert` 生成本地证书，服务端开 https，手机装根证书 |

### 7b 上公网（决定要不要买域名）

| 方案 | 条件 | 命令 |
|---|---|---|
| Cloudflare Tunnel（推荐） | 有域名 | `cloudflared tunnel create pantry` → `route dns` → `run --url http://localhost:8080` |
| Tailscale Funnel | 无域名 | `tailscale funnel 8080`，送一个 `*.ts.net` 域名，自带 HTTPS |

**这一步不能跳**：PWA 安装、Service Worker、麦克风全都要求 HTTPS。手机走 `http://192.168.x.x` 时语音按钮会静默失效。

| ID | 任务 |
|---|---|
| T7.4 | 手机 Chrome 打开 → 菜单 → 添加到主屏幕 → 全屏打开 |
| T7.5 | 真机测语音：说"牛奶6盒放冰箱中层25号到期"，看确认卡片 |
| T7.6 | 真机测离线：飞行模式录入 → 关飞行模式 → 确认同步 |
| T7.7 | 电脑端验证表格、批量改位置 |

**CHECKPOINT 7**：手机上完成一次真实闭环（语音录入 → 第二天收到提醒 → 点"已用掉"），电脑上看到结果。

---

## 阶段 8｜作品集包装（别省这步）

| ID | 任务 | 产出 |
|---|---|---|
| T8.1 | README：定位一句话、架构图、四张核心表的说明、抽取链路图 | 主页 |
| T8.2 | `docs/extract-eval.md`：20 条测试集结果 + 失败分析 | 效果证据 |
| T8.3 | 指标：抽取成功率、录入耗时中位数、提醒处理率（从 `extraction_log` 和 `alert` 里查） | 数字 |
| T8.4 | 60 秒演示视频：手机录屏（语音录入）+ 电脑（表格同步）分屏 | 附件 |
| T8.5 | 面试问答清单（见下） | `docs/interview.md` |
| T8.6 | 清理：去掉调试日志、`.env` 入库检查、仓库设为 public | |

### 面试问答预备（写在 docs/interview.md）

1. 为什么用批次表而不是只存总数量？
2. 库存扣减怎么防并发？为什么用 `FOR UPDATE` 而不是乐观锁？
3. 为什么不上 ORM？
4. LLM 在这个项目里到底做了什么、没做什么？边界画在哪？
5. 抽取失败率多少？失败集中在哪类表达？怎么改的？
6. 离线队列怎么保证不重复写入？
7. 这套表结构怎么长成企业版？（指向 `tenant_id` / `member` / `permission` / `audit_log`）

---

## 4. 全局约束（每个阶段都适用）

| 约束 | 原因 |
|---|---|
| 不引入 UI 库、状态管理库、ORM、CSS 框架 | 组件少，自己写更快；ORM 会把面试要考的 SQL 藏起来 |
| 每个写接口必须带 `client_op_id` | 离线重试的前提 |
| 所有查询必须带 `tenant_id` 条件 | 未来多租户的地基，现在就是肌肉记忆 |
| 数量、金额用 DECIMAL | FLOAT 会算错 |
| 日期存 DATE，时刻存 DATETIME，连接时区固定 +08:00 | 到期日差一天是最烦的 bug |
| 新需求先改 PRD 再写代码 | 防需求膨胀 |

---

## 5. 依赖顺序（一张图看懂）

```
阶段0 地基
  └─ 阶段1 数据层
       └─ 阶段2 接口层 ──┬─ 阶段3 界面骨架 ── 阶段4 录入（核心）
                          │                        └─ 阶段5 提醒/清单
                          │                              └─ 阶段6 离线/PWA
                          └────────────────────────────────┴─ 阶段7 部署 → 阶段8 包装
```

阶段 2 的 `inventory.js` 是全局最关键的 100 行：事务、行锁、幂等、流水，四件事都在里面。写它的时候慢一点，写测试。

---

## 6. 每周节奏建议

| 顺序 | 内容 | 结束标志 |
|---|---|---|
| 第 1 周 | 阶段 0–2 | 冒烟脚本全绿 |
| 第 2 周 | 阶段 3–4 | 20 条测试集 ≥ 80% |
| 第 3 周 | 阶段 5–6 | 断网闭环通过 |
| 第 4 周 | 阶段 7–8 | 手机装上 PWA，README 写完 |

如果第 2 周结束时抽取成功率不到 60%，**砍掉离线（阶段 6）**，把时间给抽取。理由：离线是加分项，抽取是立身之本——讲不出"我怎么把一句话变成结构化数据"，这个项目就只是又一个 CRUD。

---

## 7. 现在就可以执行的第一条命令

```bash
cd /d/vibecoding && git init
```

然后从 T0.1 开始（仓库根就是 `D:\vibecoding`，不另建 `pantry/` 子目录）。每完成一个 CHECKPOINT 回来对一次验收，不要跳阶段。
