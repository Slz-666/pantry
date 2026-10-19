# 家里有什么 · pantry

**一句话记录家里的物资，快过期时提醒你，用掉了点一下。**

说一句话（或打一句话）：「牛奶两盒放冰箱冷藏，10月25号过期」→ 系统抽成结构化字段 →
确认卡片校对 → 入库（批次 + 流水）。到期前自动提醒，点「用掉 1 个」就扣库存。
手机和电脑用同一套响应式界面、同一份数据，厨房里断网也能记。

自用项目，同时也是投 AI Agent 岗的作品集：重点讲清楚**大模型在这个系统里做什么、不做什么**，
以及**为什么库存扣减必须走事务 + 行锁**。

---

## 1. 为什么做

家里物资的问题是**到期日靠脑子记**：冰箱里那盒牛奶哪天过期、药箱里的布洛芬还剩几粒。

现成的记账/清单 App 都不管"这一盒什么时候过期"，于是手写了个：

- 录入要快：**说一句话**，不用一层层选字段
- 要记得住：**按批次**管理，同一物品不同到期日分开算（"哪盒先过期"）
- 要提醒：到期 / 开封后到期 / 库存不足，每天早 8 点扫一遍
- 厨房没信号也要能用

## 2. 三条核心设计

### ① 批次表是核心，不是"物品 + 数量"

`item` 只描述"这是什么"，数量在 `batch` 上。一个物品挂多个批次：

```
牛奶(250ml) ├─ 批次#1  qty=2  到期 2026-10-22
            └─ 批次#2  qty=1  到期 2026-11-05
```

只存总数量的表回答不了"哪盒先过期"，也做不了"先过期先处理"。
每个批次的 `qty` 用 `DECIMAL(10,2)`（`FLOAT` 会算错），状态 `active/finished/discarded`。

### ② 大模型只做「话 → 字段」，绝不参与判断

模型输出的 JSON 只填字段，剩下的全在确定性代码里做（`server/src/services/normalize.js`，纯函数，有单测）：

| 事情 | 谁做 | 为什么 |
|---|---|---|
| 把「两盒」变成 `qty=2, unit=盒` | 模型 | 自然语言理解 |
| 把「10月25号」变成 `2026-10-25` | 模型（绝对日期） | 需要理解"没写年份" |
| 把「下周」「三天后」算成日期 | **人** | 模型不许猜；相对表达原话进 `date_phrase`，卡片里让人选 |
| 只有保质期（"保质期30天"）换算到期日 | **代码** | 日历加法，月末夹取；不用"30×N 天" |
| 位置「冰箱冷藏」匹配到哪个位置 id | **代码** | 完全匹配 > 包含 > 别名，唯一命中才填，多义给候选让人选 |
| 数量合法性 `0 < qty ≤ 999`、单位白名单 | **代码** | 模型说 9999 盒也不采信 |
| 同名物品是否复用、是否重复入库 | **代码** | 模型没有数据库上下文 |

模型输出的 JSON 契约在 `server/src/services/extract.js`（`SYSTEM_PROMPT`），
`response_format: json_object`、`temperature 0`、15 s 超时、失败重试 1 次后**退回手动表单**（字段清空但保留原话）。

模型输出不合法、或者识别出"这不是在记东西"（比如「冰箱里还剩几盒」是查询、「把牛奶改成4盒」是修改），
返回 `refused: true` 并引导去搜索/编辑——**不硬猜**。

### ③ 每一次数量变化都必须能被流水解释

`stock_log` 只增不改，每条记录 `type / qty_delta / qty_before / qty_after / reason / client_op_id`。
所有库存操作（入库、消耗、丢弃、调账、移动）都走 `server/src/services/inventory.js`：

```
getConnection → beginTransaction
  → SELECT ... FOR UPDATE（锁住这一行批次）
  → 校验（够不够扣、批次是否已结束）
  → UPDATE batch.qty
  → INSERT stock_log
→ commit / catch 回滚 + release
```

`stock_log.client_op_id` 是唯一键：离线重试、网络重发都只落一条流水。
数量校验、状态流转（扣到 0 → `finished`）、流水写入在**同一个事务**里，不会出现"扣了库存没写流水"。

## 3. 架构

```
┌──────────── 手机（安卓 Chrome / PWA）────────────┐
│ Add.vue 语音→文字   ConfirmSheet 确认卡片        │
│ Alerts 一键处理      Shopping 买回来入库          │
│ 离线：IndexedDB 快照 + 写队列（client_op_id）     │
└───────────────────────┬──────────────────────────┘
                        │ HTTPS（自签 CA，局域网/热点）
┌───────────────────────▼──────────────────────────┐
│ Fastify（Node 24 / ESM / 无 TypeScript）          │
│  /api/*  ← JWT 全局守卫 + tenant_id 贯穿           │
│   routes/extract.js → services/extract.js（DeepSeek）│
│                     → services/normalize.js（纯函数）│
│   routes/batches.js → services/inventory.js（事务+行锁）│
│   services/alerts.js（cron 08:00 / 手动扫描，INSERT IGNORE 去重）│
│   @fastify/static 托管 web/dist（同源，无 CORS）    │
└───────────────────────┬──────────────────────────┘
                        │ mysql2（无 ORM，裸 SQL）
┌───────────────────────▼──────────────────────────┐
│ MySQL 8.0.46 · 11 张表 · InnoDB · utf8mb4 · +08:00 │
└──────────────────────────────────────────────────┘
```

## 4. 抽取链路

```
用户原话
  │ POST /api/extract
  ▼
DeepSeek deepseek-chat（json_object / temp 0 / 15s / 重试 1 次）
  │ {"items":[{name,qty,unit,location_hint,expire_at,date_phrase,shelf_life_*,...}],
  │  "missing":[], "question":""}
  ▼
normalize.js（纯函数，不碰数据库，23 条单测）
  ├─ 日期校验：不早于「今天 − 30 天」；只有年月 → 月末；相对表达不猜，进 date_phrase
  ├─ 保质期换算：日历加法 + 月末夹取（addMonths('2026-01-31',1) = '2026-02-28'）
  ├─ 位置匹配：完全 > 包含 > 别名；唯一命中才填 id，多义给候选
  ├─ 物品匹配：同名复用，重名里挑规格最接近的（方案 A）
  ├─ 重复检测：同物品 + 同位置 + 同到期日 → 提示合并（默认合并）
  └─ 数量/单位校验：0 < qty ≤ 999，单位必须在 22 项白名单内
  ▼
确认卡片（缺字段标红；「下周」这类没换算的会提示"请确认到期日"）
  │ POST /api/extract/:id/confirm  ← 带 client_op_id
  ▼
一个事务：建 item（如需）+ batch + stock_log + extraction_log 置 confirmed
```

**评测**：20 条测试集（绝对日期 / 相对日期 / 缺字段 / 多物品 / 修改与非录入语义），
`confirmed/(confirmed+failed+rejected) = 90%`，20/20 行为正确，单条 0.9–1.5 s。
明细与失败分析：[`docs/extract-eval.md`](docs/extract-eval.md)，复跑 `node server/scripts/eval-extract.js --write`。

## 5. 数据模型（11 张表）

| 表 | 作用 | 关键约束 |
|---|---|---|
| `tenant` / `member` | 家庭（租户）与成员 | 所有业务表都带 `tenant_id` |
| `location` | 位置树（冰箱 > 冷藏/冷冻） | 自引用 `parent_id`；用生成列 `parent_key` 解决"根节点不能靠 UNIQUE 去重" |
| `item` | 物品定义 | `name_key = name|spec` 生成列做唯一键；`deleted_at` 软删 |
| **`batch`** | **批次：数量 + 到期日 + 位置** | `(tenant_id, expire_at)`、`(tenant_id, location_id)` 索引；`qty DECIMAL` |
| `stock_log` | 库存流水，只增不改 | `client_op_id` 唯一（幂等）；`qty_before/after` 可对账 |
| `alert` | 提醒 | `(batch_id, type, due_date)` 唯一 → 重复扫描天然去重 |
| `shopping_item` | 购物清单 | `client_op_id` 唯一（离线加购幂等） |
| `reminder_rule` | 按品类的提醒规则 | `days_before` JSON，如 `[30,7,1,0]` |
| `extraction_log` | 每次抽取的输入/原始输出/草稿/耗时 | 排查"模型到底抽成什么"的唯一入口 |
| `setting` | 键值配置 | |

完整 DDL 在 `server/migrations/001_init.sql`（手写编号 SQL + 32 行 `migrate.js`，不引迁移框架），
关系图与设计取舍在 [`docs/schema.md`](docs/schema.md)。

## 6. 离线与 PWA

- **读**：接口快照进 IndexedDB，先渲染缓存再拉网络（厨房弱网秒开）
- **写**：离线操作进队列，乐观更新 + 顶部「离线 · 待同步 1 条」；联网后**串行**重放，
  每项带 `client_op_id`，重放多少次库存只变一次
- **壳**：手写 Service Worker（导航 network-first、`/assets` cache-first、**写请求不拦**）
- **PWA**：manifest + 图标（192/512/maskable）+ `display: standalone`

设计说明与 LWW 冲突局限：[`docs/offline.md`](docs/offline.md)。

## 7. 快速开始（本机）

```bash
# 1. 依赖（Node ≥ 20）
npm install

# 2. 环境变量
cp .env.example .env      # 填 DB_PASSWORD / JWT_SECRET / DEEPSEEK_KEY

# 3. 数据库（本仓库用独立实例，不碰机器上已有的 3306）
server/scripts/db.cmd                 # 起 MySQL 8.0.46 @ 3307，数据目录 data/mysql
node server/scripts/migrate.js        # 建表（可重复执行）
node server/scripts/seed.js           # 建租户/管理员/位置树/提醒规则（幂等）

# 4. 起服务
npm run dev            # server:8787 + web:5173（vite 代理 /api）

# 5. 回归（55+ 项）
bash server/scripts/smoke.sh
```

生产形态（手机访问）见 [`docs/deploy.md`](docs/deploy.md)：构建产物由同一进程托管 + 自签 HTTPS。

### 环境变量

复制 `.env.example` 为 `.env`（已在 `.gitignore` 里，**不会**进仓库）。启动时 `server/src/env.js` 显式从仓库根加载。

| 键 | 必填 | 作用 | 缺了会怎样 |
|---|---|---|---|
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | 是 | MySQL 连接（示例值 `127.0.0.1:3307` / `pantry`） | 进程启动后第一个查询就失败：`Access denied for user` 或 `ECONNREFUSED` |
| `JWT_SECRET` | 是 | 签发登录 token（HS256，7 天） | 进程起不来（没有 secret 无法签名） |
| `DEEPSEEK_KEY` | 录入功能必填 | 调 `deepseek-chat` 抽取字段 | **应用照常启动，其他功能全部可用**：只有 `POST /api/extract` 返回 `{failed:true}`，前端把原话保留、直接退手动填表；`extraction_log` 里记 `status='failed'` 和错误原因，便于排查 |
| `PORT` `HOST` | 否 | 监听端口 / 地址 | 默认 `8787` / `0.0.0.0`（手机要连局域网，不能只听回环） |
| `DEEPSEEK_BASE_URL` `DEEPSEEK_MODEL` | 否 | 换代理或换模型 | 默认 `https://api.deepseek.com` / `deepseek-chat` |
| `EXTRACT_TIMEOUT_MS` `EXTRACT_RETRY` | 否 | 抽取超时与重试次数 | 默认 `15000` / `1`（只在超时、5xx、JSON 非法时重试；4xx 不重试） |
| `HTTPS_KEY` `HTTPS_CERT` | 否 | 填了就起 HTTPS（手机麦克风 / PWA 安装需要） | 不填走 HTTP，局域网真机访问会**静默拿不到麦克风** |
| `SEED_ADMIN_PASSWORD` | 否 | `seed.js` 建管理员时的密码 | 默认 `pantry123`，上线前务必改 |
| `SCAN_INTERVAL_MS` | 否 | 扫提醒的间隔毫秒（开发用） | 不设则只靠每早 8 点的 cron 和手动 `POST /jobs/scan` |

> 没有 `DEEPSEEK_KEY` 时整条链路仍然是可用的：「记一笔」会提示抽取失败并展开手动表单，确认后走 `POST /batches` 直接入库。LLM 是加速器，不是依赖。

## 8. 验收证据

| 阶段 | 验收内容 | 证据 |
|---|---|---|
| 0 地基 | `/api/health` 通、前端显示 | `docs/screenshots/checkpoint0-desktop.png` |
| 1 数据层 | `migrate` 跑两次、`seed` 幂等、11 张表 | `docs/schema.md` |
| 2 接口层 | `smoke.sh` 全绿 + 两条硬断言（同 `client_op_id` 重放只多 1 条流水；qty=3 消耗 4 → 400 且数量不变） | 脚本内断言 |
| 3 界面 | 375×812 / 1440×900 双端同一份数据、无横向溢出 | `docs/screenshots/checkpoint3-*.png` |
| 4 录入 | 20 条测试集 90%、6 条边界行为正确 | `docs/extract-eval.md` |
| 5 提醒/清单 | 造 3+1 条触发数据 → 扫出 4 条、再扫不变、点「用掉」→ 提醒消失 + 数量 −1 + 流水 +1 | `.cache/p5-check.mjs` |
| 6 离线 | 断网刷新能开、断网点「用掉」显示「待同步 1 条」、恢复后 `stock_log` 只多 1 条（11/11） | `docs/offline.md`、`docs/screenshots/p6-offline.png` |
| 7 真机 | 安卓 Chrome：语音录入闭环、飞行模式离线同步（PWA 独立窗口受国内 ROM 限制） | `docs/deploy.md` §8 |
| 8 作品集 | README / 评测 / 指标 / 面试清单 | 本文件、`docs/metrics.md`、`docs/interview.md` |

指标（真实数据）：抽取成功率 **90.2%**、模型往返中位 **1.12 s**、提醒处理率 **80%**，见 [`docs/metrics.md`](docs/metrics.md)。

## 9. 技术选择与"不做什么"

| 选择 | 理由 |
|---|---|
| 无 ORM，`mysql2` 裸 SQL | 面试要讲的是事务、行锁、批次建模、索引；ORM 会把这些藏起来 |
| 后端 JS（ESM），不用 TypeScript | 个人项目，省构建步骤；用 zod + 手写校验守边界 |
| Vue 3 + 纯手写 CSS，无 UI 库、无 Pinia | 组件就 6 个、页面 8 个，引框架反而要学它的约定；状态一个 `reactive` 对象够了 |
| 手写编号 SQL + 32 行 `migrate.js` | 迁移工具解决的是团队协作问题，这里不需要 |
| 迁移/建库用本机 mysqld 独立实例 | 机器上 3306 有别的库，不碰；Docker 镜像源坏了，`docker-compose.yml` 留着备用 |

**明确不做**：菜谱推荐、卡路里、OCR 小票、智能硬件、记账打通、多语言、严格 FIFO、自然语言查询。

## 10. 目录

```
server/
  migrations/001_init.sql … 004_*.sql   手写编号迁移
  scripts/{migrate.js,seed.js,smoke.sh,db.cmd,make-cert.sh,eval-extract.js}
  src/
    routes/{auth,locations,items,batches,shopping,alerts,summary,extract,meta,reminders}.js
    services/{extract.js,normalize.js,inventory.js,alerts.js}
    {index.js,db.js,auth.js,env.js,lib/}
  test/normalize.test.js               23 条纯函数单测
web/
  public/{manifest.json,sw.js,icons/}
  src/
    views/ 8 个页面    components/ 6 个组件
    offline/{idb.js,sync.js}           离线层
    {api.js,store.js,router.js,voice.js,styles.css,main.js,App.vue}
docs/  schema.md · extract-eval.md · offline.md · deploy.md · metrics.md · interview.md
```

## 11. 已知限制（诚实清单）

- **语音只支持安卓 Chrome**（`webkitSpeechRecognition`），iOS Safari 不支持，且必须在 HTTPS 或 localhost 下才会请求麦克风权限
- **PWA 独立窗口在国内 ROM 上装不出来**：无 GMS 时 WebAPK 不落地，退回快捷方式（功能不受影响，见 `docs/deploy.md` §8）
- **冲突策略是 LWW**（`updated_at` 新的赢），不做字段级合并；离线队列不重基，冲突时按业务错误出队并提示
- **单用户自用**：`tenant_id`/`member` 结构按多租户设计，但没有权限体系、没有审阅流
- **提醒处理率样本只有 5 条**，只能说明机制可用，不是统计结论
- 抽取成功率 90% 建立在 20 条自测集上，覆盖面有限（方言、口音、超长句子没测）

## 12. 文档

| 文件 | 内容 |
|---|---|
| [`docs/schema.md`](docs/schema.md) | 11 张表关系图 + 设计取舍 |
| [`docs/extract-eval.md`](docs/extract-eval.md) | 20 条抽取测试集结果 + 失败分析 |
| [`docs/offline.md`](docs/offline.md) | 三层缓存、离线队列、LWW 局限 |
| [`docs/deploy.md`](docs/deploy.md) | 部署、自签 HTTPS、手机装 CA、真机验收记录 |
| [`docs/metrics.md`](docs/metrics.md) | 三个核心指标的 SQL 口径 |
| [`docs/interview.md`](docs/interview.md) | 面试问答（7 题 + 追问） |
| [`docs/demo-script.md`](docs/demo-script.md) | 演示视频分镜（15 个镜头 / 60–90 秒） |

## License

[MIT](LICENSE) © 2026 [slz-666](https://github.com/slz-666)
