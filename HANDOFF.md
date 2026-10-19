# 交接文档：家里有什么（pantry）

> **给接手的 AI：这份文件是唯一入口。** 读完本文即可开工，不需要回溯任何对话记录。
> 生成日期：2026-10-19　｜　当前进度：**0 行代码，只有文档**
> 项目根目录：`D:\vibecoding`（Windows 11 本机，非 Linux 服务器）

---

## 0. 30 秒上手

**这个项目是什么**：一个自用的家庭物资与效期管理 PWA（手机 + 电脑同一套代码），核心能力是「说一句话 → LLM 抽成结构化字段 → 确定性代码校验归一化 → 用户确认 → 入库」，配套到期提醒与购物清单。

**它同时是作品集**：用于投 AI Agent 岗。因此代码本身要能讲清楚「LLM 干什么、不干什么、边界在哪」，指标要能量化。这一条不是附加要求，是需求的一部分。

**现在的状态**：产品文档已定稿并确认，代码一行没写。第一个动作是阶段 0（搭骨架）。

**必读的三个文件**（按顺序）：

| 文件 | 作用 | 什么时候看 |
|---|---|---|
| `PRD.md` | 产品需求，13 节，含验收条件、数据模型、接口契约、抽取 JSON 契约 | 开工前通读一遍 |
| `DEV-PLAN.md` | 阶段 0–8 的任务表（T 编号）+ 每阶段验收命令 + CHECKPOINT 门禁 | 每做一个阶段看一节 |
| 本文 `HANDOFF.md` | 决策锁定、环境实况、硬规则、已知坑、协作约定 | 开工前 + 卡住时 |

`docs/` 下两份是选题调研历史（`2026-10-19-MySQL-Agent-选题清单.md`、`2026-10-19-家里有什么-功能清单.md`），**只作背景，不作为开发依据**。如与 PRD 冲突，以 PRD 为准。

---

## 1. 定位与成功定义

**一句话**：把家里所有「有保质期、有位置、有数量」的东西，变成一个说一句话就能进出、到期会提醒的库。

**三个真正的痛点**（用户自己的，不是编的）：买了重复的、放过期了、找不到在哪。这三个都不是「记不住」，而是「记了但没结构」。所以解法不是更努力地记，而是**把录入摩擦降到接近零**。

**成功定义**（四条，按重要性）：

1. 录入一句话 ≤ 3 步、≤ 15 秒（这是项目立身之本）
2. 到期提醒能被一键处理，不是看完就忘
3. 手机和电脑同一份数据，厨房信号差也能用
4. 能拿出量化指标：抽取成功率 ≥ 80%、录入耗时中位 ≤ 15s、提醒处理率 ≥ 70%

---

## 2. 已锁定决策（不要重新讨论，想改必须先问用户）

下表每一条都是用户拍过板或经过论证的。**接手的 AI 最常见的错误就是「觉得这样更好」然后擅自换掉**——尤其第 1、2、3 条。

| # | 决策 | 理由（被追问时要能答） | 改动代价 |
|---|---|---|---|
| 1 | **不用 ORM**，`mysql2` + 裸 SQL | 本项目的面试价值就在事务、行锁、批次建模、索引；ORM 正好把这些藏起来 | 高，等于换掉技术骨架 |
| 2 | **`batch` 批次表是核心**，一个 item 下挂多条 batch | 只存总数量就回答不了「哪盒先过期该先喝」 | 极高，数据模型地基 |
| 3 | **LLM 只做「话→字段」**，绝不参与日期换算、数量校验、重复判断、位置匹配 | 模型输出不可靠，这些必须可复现、可测试。算不出来就让人填，**绝不猜** | 高，等于放弃项目叙事 |
| 4 | **响应式 PWA 单套前端**，不做小程序 + Web 两套 | 小程序不能直连 MySQL，后端照样要写，工作量翻倍零收益 | 高 |
| 5 | **桌面端不是放大版手机**：手机卡片+语音+单手，电脑表格+键盘+批量操作 | 同一份数据，两种交互 | 中 |
| 6 | 前端 **Vue 3 + Vite + 纯手写 CSS，无 UI 库、无 Pinia** | 组件只有 6 个，自己写更快；风格要两端统一 | 中 |
| 7 | 后端 **Node + Fastify + JS(ESM)**，不引 TypeScript | 减少构建环节；用户正在学 JS | 中 |
| 8 | 迁移 **手写编号 SQL + 20 行脚本**，不引 knex/prisma | 同上，SQL 要能讲 | 低 |
| 9 | LLM 用 **DeepSeek `deepseek-chat` JSON 模式** | 用户已有 key，中文口述理解好，成本低 | 低 |
| 10 | 语音**只做安卓 `webkitSpeechRecognition`** | iOS 不支持，日常主用安卓机，已明确 iOS 为非目标 | 低 |
| 11 | 定位**自己日常使用**，所以**离线与同步必须做** | 不是演示品，断网要能录入 | 中 |
| 12 | **必须 HTTPS**（手机端） | PWA 安装、Service Worker、麦克风全都要求安全上下文 | 不可协商 |

**如果用户提出新需求**：先改 `PRD.md`（加进对应章节并写验收条件），再写代码。这条是硬性流程，理由是这类项目最常见的死因就是需求膨胀。

---

## 3. 明确不做（第一版）

菜谱推荐 · 营养成分/卡路里 · OCR 识别小票明细 · 智能硬件 · 与记账打通 · 多语言 · 严格 FIFO 成本核算 · 自然语言查询（P1）。

**用户说「顺便加个 X」时，先看这张表。** 表里有的，回答「PRD 2.2 已排除，要加得先改 PRD，并说明砍掉什么换它」。表里没有的（比如条码扫描 P1、Web Push P1），可以记进 P1 清单，但不许插进当前阶段。

---

## 4. 本机环境实况（2026-10-19 18:10 实测）

| 项 | 实况 | 注意 |
|---|---|---|
| OS | Windows 11（中文），默认 shell 是 Git Bash | 路径用 `/d/vibecoding` 或 `D:/vibecoding`，别用 `C:\...` 反斜杠裸写 |
| Node | **v24.14.0**（`C:\Users\<你的用户名>\.workbuddy\binaries\node\versions\24.14.0\node.exe`，另有 22.22.2） | 满足 ≥20 要求 |
| npm | 11.9.0 | — |
| Git | 2.55.0.windows.3 | 仓库根见 §5 |
| MySQL | **8.0.46 本机安装版**，路径 `C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe`，**3306 已在监听**（PID 7176） | 见下方「环境注意 1」 |
| Docker | 29.7.2 可用 | 可作为隔离方案 |
| 端口 | 3306 / 33060 被 MySQL 占用；**8787（后端）、5173（前端）空闲** | 与 DEV-PLAN 一致，不用改 |
| 安卓设备 | 安卓机（Android 15）+ Chrome | 语音、PWA 真机测试用 |

**环境注意 1：MySQL 的处理方式（重要）**
本机 3306 上跑着用户自己的 MySQL 8.0 服务，root 密码未知，且可能有其他项目的库。**不要直接往里建库**，两个安全做法：

- 推荐：Docker 起独立实例，映射到 **3307** 避开冲突：
  `docker run -d --name pantry-mysql -e MYSQL_ROOT_PASSWORD=pantry -e MYSQL_DATABASE=pantry -p 3307:3306 mysql:8.4`
  然后 `.env` 里写 `DB_PORT=3307`。
- 备选：用本机 3306，但**必须先向用户要账号密码**，且只建 `pantry` 一个库，不动其他库。

MySQL 8.0/8.4 都满足需求（递归 CTE、JSON、CHECK、`FOR UPDATE`、`SKIP LOCKED` 全都有）。**不需要 VECTOR 类型，别被上一轮调研带偏**——本项目不做向量检索。

**环境注意 2：沙箱与权限**
写 `C:\` 根目录会被静默丢弃；写 `D:\` 正常。不要执行 `cmd.exe` / `powershell` 之外的重活；需要注册表/进程信息时用 PowerShell 工具。删文件走回收站，不用 `rm -rf`。

**环境注意 3：麦克风与 HTTPS**
`localhost` 是唯一不需要 HTTPS 的例外，所以电脑上能测语音；**手机上走 `http://192.168.x.x` 时麦克风按钮会静默失效**，且无法安装 PWA。真机联调必须上 HTTPS（阶段 7）。

---

## 5. 技术形态与目录结构

**仓库根 = `D:\vibecoding`**（不再套一层 `pantry/`）。理由：PRD、README、docs 都要进版本库，作品集需要它们一起公开。

```
D:\vibecoding\                 # git 仓库根
├── package.json               # npm workspaces: server, web
├── .env.example
├── docker-compose.yml
├── README.md                  # 阶段 8 写：定位/架构图/指标
├── PRD.md  DEV-PLAN.md  HANDOFF.md
├── docs/                      # schema.md · extract-eval.md · interview.md
├── server/
│   ├── migrations/001_init.sql
│   ├── scripts/{migrate.js, seed.js, smoke.sh}
│   └── src/
│       ├── index.js           # 启动 + 注册插件
│       ├── db.js              # 连接池（timezone '+08:00', dateStrings true）
│       ├── auth.js            # JWT 签发与校验
│       ├── routes/            # auth items batches locations extract shopping alerts
│       ├── services/
│       │   ├── extract.js     # 调 LLM
│       │   ├── normalize.js   # ★ 确定性归一化，全项目最有价值的文件
│       │   ├── inventory.js   # ★ 事务化库存增减，全局最关键 100 行
│       │   └── alerts.js      # 扫描与去重
│       └── lib/               # 日期、单位、错误类
└── web/
    ├── index.html  vite.config.js  public/{manifest.json, icons}
    └── src/
        ├── main.js App.vue router.js api.js store.js voice.js styles.css
        ├── offline/{idb.js, sync.js}
        ├── views/             # Home Location ItemDetail Add Shopping Alerts Settings Login（8 个）
        └── components/        # ItemCard BatchRow ConfirmSheet Sheet Field Empty（6 个）
```

**组件上限 6 个、页面 8 个。** 超了就说明设计出问题，停下来看 PRD，不要闷头加组件。

---

## 6. 数据模型（11 张表）

个人版 `tenant_id` 恒为 1，但**结构直接按多租户设计**——这是「个人项目如何长成企业版」的答案，面试必问。

| 表 | 职责 | 关键点 |
|---|---|---|
| `tenant` | 家庭/企业 | 个人版 1 行 |
| `member` | 成员 | bcrypt；role 预留 |
| `location` | 位置树 | `parent_id` 自关联；删除有子节点被外键拦（→ 409） |
| `item` | 物品 SKU | 别名存 JSON；barcode 可空 |
| **`batch`** | **批次（核心）** | qty / location_id / produced_at / expire_at / opened_at |
| `stock_log` | 流水 | **只增不改**；`client_op_id` 唯一键做幂等 |
| `shopping_item` | 购物清单 | 单表，不拆「清单」实体（YAGNI） |
| `reminder_rule` | 提醒规则 | 按品类配 days_before 数组 + opened_days |
| `alert` | 已生成提醒 | `(batch_id, type, due_date)` UNIQUE → 天然去重 |
| `extraction_log` | 抽取记录 | 原话 + 模型原始 JSON + 最终草稿 + 耗时/token，算指标全靠它 |
| `setting` | 键值配置 | 免打扰时段等 |

**索引下限**：`batch(tenant_id, expire_at)`（每日扫描靠它）、`batch(tenant_id, location_id)`、`item(tenant_id, name)`、`stock_log(client_op_id) UNIQUE`、`alert(batch_id, type, due_date) UNIQUE`。

**迁移纪律**：`001_init.sql` 起编号，`migrate.js` 建 `schema_migrations` 表、按文件名排序执行未跑过的。要求**可重复执行**（第二次输出 nothing to migrate）。

---

## 7. 接口契约

统一前缀 `/api`，除登录外全部要 `Authorization: Bearer <jwt>`。完整清单在 `PRD.md` §9，这里只列结构要点：

| 组 | 端点 | 要点 |
|---|---|---|
| 认证 | `POST /auth/login`、`GET /auth/me` | 错误统一 401，不泄露「用户不存在」 |
| 位置 | `GET/POST/PATCH/DELETE /locations` | 树用递归 CTE；删除有子节点或有批次引用 → **409** |
| 物品 | `GET/POST/GET:id/PATCH/DELETE /items` | 列表支持 `q`（名称/别名/条码）、`category`、`location_id`、`expiring_in`；删除是软删 |
| 批次 | `GET/POST /batches`、`POST /batches/:id/consume\|discard`、`PATCH /batches/:id` | 所有写操作**必须**带 `client_op_id` |
| 抽取 | `POST /extract`、`POST /extract/:draftId/confirm`、`/reject` | extract **只产草稿不写业务表**；confirm 才在一个事务里建 item（如需）+ batch + stock_log |
| 清单 | `GET/POST/PATCH /shopping`、`POST /shopping/:id/stock` | 入库=生成批次+写流水+关清单项，一个事务 |
| 提醒 | `GET /alerts?status=pending`、`POST /alerts/:id/handle`、`POST /jobs/scan` | handle 三动作 done/discard/ignore；前两者同时扣库存 |
| 其他 | `GET /summary/today`、`GET /health` | summary 给首页一句话 |

**错误格式统一** `{ code, message }`，绝不把 SQL 错误原文吐给前端。

---

## 8. 抽取层（项目一半的价值在这里）

### 8.1 JSON 契约（模型输出）

```json
{
  "items": [{
    "name": "牛奶", "spec": null, "qty": 6, "unit": "盒", "category": null,
    "location_hint": "冰箱中层", "expire_at": "2026-10-25", "date_phrase": null,
    "shelf_life_value": null, "shelf_life_unit": null, "opened": false
  }],
  "missing": ["location"],
  "question": "放哪儿了？"
}
```

### 8.2 写进 system prompt 的 6 条规则

1. 只输出 JSON，不解释。
2. 用户没说的字段填 `null`，**不许编造**。
3. 绝对日期 → `expire_at`（`YYYY-MM-DD`）；相对日期（"下周""三天后"）→ `expire_at` 置 null，原话放 `date_phrase`。
4. 只给保质期 → 填 `shelf_life_value/unit`，**不要自己算到期日**。
5. 位置只放原话 `location_hint`，不许猜 id。
6. 缺关键字段时在 `missing` 列出，并在 `question` 里用一句中文追问。

参数：`response_format: { type: 'json_object' }`，超时 15s，失败重试 1 次，然后退手动表单。

### 8.3 归一化六步（后端确定性代码，纯函数、可单测）

| 步 | 规则 |
|---|---|
| 日期校验 | 合法，且不早于「今天 − 30 天」（更早视为录入错误） |
| 保质期换算 | 有 `produced_at` 才换算：`expire = produced + N 月`，**用日历加法，不用 30×N 天** |
| 位置匹配 | 完全匹配 > 包含匹配 > 别名；唯一命中才填 `location_id`，多义让用户选 |
| 物品匹配 | 名称相等 > 别名包含 > 相似度；命中复用 `item_id`，否则新建 |
| 重复检测 | 同 item + 同 location + 同 expire_at 已存在 → 提示「合并为新批次 / 新建物品」，默认合并 |
| 数量校验 | `0 < qty <= 999`，单位在白名单内 |

**20 条测试集**在 `DEV-PLAN.md` 阶段 4，含相对日期、缺字段、多物品、修改语义、非录入语义五类边界。**第 11、19 条的正确行为是明确拒绝并引导**（"冰箱里还剩几盒"→ 去搜索；"把牛奶改成4盒"→ 去编辑），不是硬解析。这个细节最能体现「Agent 知道自己的边界」，面试必讲。

---

## 9. 执行顺序与门禁

**不许跳阶段。** 每个阶段结束必须跑通验收命令、记录 CHECKPOINT，才进下一阶段。任务级细节（T 编号）见 `DEV-PLAN.md`。

| 阶段 | 目标 | 验收（可直接复制执行） |
|---|---|---|
| **0 地基** | 前后端起来 | `npm run dev:server` 后 `curl http://localhost:8787/api/health` → `{"ok":true}`；前端 5173 页面能显示该结果 |
| **1 数据层** | 11 张表 + seed | `node server/scripts/migrate.js` 跑两次，第二次输出 nothing to migrate；`node server/scripts/seed.js` 幂等；`SHOW TABLES` 是 11 张 |
| **2 接口层** | 库存全流程可用 | `bash server/scripts/smoke.sh` 全绿；**两条硬断言**：同 `client_op_id` 连发 2 次只多 1 条流水；qty=3 消耗 4 → 400 且数量不变 |
| **3 界面** | 双端布局 | 375×812 与 1440×900 各一张截图，不塌、无横向滚动；两端看到同一批数据 |
| **4 录入 Agent** | 一句话 → 确认 → 入库 | 20 条测试集 `confirmed/(confirmed+failed+rejected)` ≥ 80%；6 条边界用例行为正确 |
| **5 提醒/清单** | 扫描 + 处理闭环 | 造 4 条触发数据 → 扫描出 4 条；再扫一次数量不变；点「已用掉」→ 提醒消失 + 数量 −1 + 流水 +1 |
| **6 离线 PWA** | 断网可用 | DevTools 离线刷新能打开；断网消耗 → 显示「待同步 1 条」；恢复后 `stock_log` **只多 1 条** |
| **7 部署真机** | 手机装 PWA 跑通 | 手机上完成一次真实闭环（语音录入 → 次日提醒 → 点已用掉），电脑同步可见 |
| **8 作品集** | README + 指标 + 60 秒演示 | `docs/extract-eval.md`、`docs/interview.md` 齐备；仓库无 `.env` 与调试日志 |

**兜底规则（写死在计划里，用户已知悉）**：若第 2 周结束抽取成功率 < 60%，**砍掉阶段 6 离线**，把时间给抽取。离线是加分项，抽取是立身之本——讲不出「我怎么把一句话变成结构化数据」，这项目就只是又一个 CRUD。

**建议节奏**：第 1 周 0–2，第 2 周 3–4，第 3 周 5–6，第 4 周 7–8。

---

## 10. 硬规则清单（每条都要能落到代码里）

1. 所有查询带 `tenant_id` 条件——未来多租户的地基，现在就是肌肉记忆。
2. 所有写接口带 `client_op_id`，服务端靠唯一键做幂等；离线重试的前提。
3. 库存扣减必须**事务 + `SELECT ... FOR UPDATE`**（`qty` 是 DECIMAL 不是 FLOAT）。
4. `stock_log` **只增不改**，任何数量变化都必须留下流水。
5. 日期用 `DATE`，时刻用 `DATETIME`；连接时区固定 `+08:00`；`dateStrings: true`。
6. 单用户冲突策略用 LWW（`updated_at` 新的赢），并在 `docs/` 写明局限。
7. 新需求先改 PRD 再写代码。
8. 不引入 UI 库、状态管理库、ORM、CSS 框架、迁移工具（新增其他依赖先说明理由）。
9. 抽取接口**只产草稿**，`confirm` 才写业务表；重复 confirm 返回 409。
10. 模型输出不合法 → 退手动表单，字段清空但**保留原话**，绝不卡死流程。
11. 前端不加动画，不做设计系统，颜色/间距只从 `styles.css` 的变量取。
12. 每次数量变化都要能被 `stock_log` 解释；测不出来的效果不算做完。

---

## 11. 已知坑（提前知道能省一天）

| 坑 | 症状 | 正确做法 |
|---|---|---|
| **手机 http 访问** | 语音按钮点了没反应、PWA 装不上 | 必须 HTTPS；`localhost` 例外。真机联调直接上 Cloudflare Tunnel / Tailscale Funnel |
| **时区差一天** | 到期日显示比填写少/多一天 | DATE 字段 + `dateStrings: true` + 连接 `timezone:'+08:00'`，别用 JS Date 转字符串 |
| **`dateStrings` 忘开** | mysql2 把 DATE 转成 Date 对象，跨时区漂移 | `db.js` 里统一配，别在每个查询里补 |
| **相对日期** | "下周三"被模型硬算成错日期 | prompt 第 3 条禁止换算，进 `date_phrase` 让人确认 |
| **保质期按 30 天计算** | 18 个月算成 540 天，误差几天 | 用日历加法（`addMonths`），边界日取当月最后一天 |
| **安卓后台挂起** | 队列不刷、数据看着丢了 | `online` + `visibilitychange` + 30s 定时 + 页面加载，四个触发点都要 |
| **Service Worker 缓存住旧前端** | 改了代码手机上还是旧版 | SW 用版本号命名 cache，dev 环境禁用 SW |
| **`FOR UPDATE` 漏在事务外** | 并发下超卖/扣成负数 | `getConnection()` → `beginTransaction` → `FOR UPDATE` → 校验 → 更新 → `commit`，`catch` 里 `rollback` 并 `release` |

---

## 12. 与用户协作的约定

- **语言**：中文，结构化输出（要点列表 + 表格），先给结论再给理由。
- **回复「1」= 已知悉，继续执行**，不需要再确认一遍。
- **每个 CHECKPOINT 停下来汇报**：做了什么、验收命令的真实输出、下一步。不许「我觉得应该没问题」。
- **动代码前先给方案**，尤其是改数据结构、加依赖、动已锁定决策（§2）。
- **破坏性操作必须先列清单 + 说明风险 + 等确认**，删文件走回收站。
- **技术说明要诚实**：包括做不了的部分、性能边界、已知缺陷。不许杜撰 API 行为或跑不通的命令输出。
- **调用 skill / 装工具前先说明用途和将产生的文件**。
- 用户是计算机专业大二学生（前端打底 → 全栈，目标杭州/上海），**代码要写注释解释「为什么」**，尤其是事务、锁、索引、幂等这几处——这些是他面试要讲的东西。

---

## 13. 接手后的第一步（照做即可）

```bash
cd /d/vibecoding
git init
# 建 workspaces 根 package.json，装依赖（见 DEV-PLAN 阶段 0 T0.1–T0.3）
```

然后严格按 `DEV-PLAN.md` 阶段 0 的 T0.1 → T0.8 顺序做，**做完跑 CHECKPOINT 0 的验收，再动阶段 1**。

第一轮回复用户时，建议这样说（不要长篇大论）：

> 已读完 PRD / DEV-PLAN / HANDOFF。确认三件事：MySQL 用 Docker 起在 3307 还是用本机 3306（需要密码）？DeepSeek key 现在是否可用？我先按阶段 0 搭骨架，跑通 `/api/health` 后停下来给你验收。

---

## 14. 文档地图与变更记录

| 文件 | 关系 |
|---|---|
| `PRD.md` | 需求唯一来源。功能冲突以它为准 |
| `DEV-PLAN.md` | 执行唯一来源。任务顺序以它为准 |
| `HANDOFF.md`（本文） | 决策与环境唯一来源。与上两者冲突时，**本文优先**（因为它记录的是最新核对结果） |
| `docs/*选题清单*` `docs/*功能清单*` | 历史调研，仅背景 |

| 日期 | 变更 |
|---|---|
| 2026-10-19 | 初版。汇总选题调研 → 方向 8 选定 → PRD v1.0 → DEV-PLAN → 工作区迁至 `D:\vibecoding`；明确仓库根不再套 `pantry/`；记录本机 MySQL 8.0.46 占用 3306 的处理方式 |
