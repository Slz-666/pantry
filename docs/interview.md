# 面试问答（阶段 8 T8.5）

> 每题按「一句话结论 → 机制 → 可能被追问什么」写。
> 凡是数字都能在库/文档里复算，不背编的指标。

---

## 1. 为什么用批次表，而不是只存总数量？

**一句话**：只存总量回答不了"哪盒先过期"，而"先过期先处理"是这个产品的核心动作。

**机制**：

- `item`（这东西是什么）+ `batch`（这一批有多少、哪天过期、放哪）一对多。
  牛奶有两个批次（10-22 两盒、11-05 一盒）时，过期提醒要能精确指到"10-22 那两盒"。
- 库存操作全部落到批次粒度：`consume` 扣某个批次、`discard` 丢弃某个批次、
  提醒里的「用掉 1 个」也是扣提醒指向的那个批次。
- 如果只有 `item.qty`：到期提醒只能提示"牛奶快过期了"，用户还得自己翻；
  而且 FIFO/LIFO 无法表达，只能用全局规则硬套。
- 代价：查询要聚合（列表页 `SUM(qty)`、`MIN(expire_at)` + `GROUP BY item`），
  靠 `batch(tenant_id, expire_at)`、`batch(tenant_id, location_id)` 两个索引撑住。

**可能追问**：

- *为什么不用"物品 + 到期日"组合当主键？* 同一天同一位置可能进两批（不同来源/规格），
  批次还需要自己的状态（opened/finished/discarded），必须有独立 id。
- *批次会无限增长吗？* 会。`status` 落到 `finished/discarded` 后不再参与库存聚合，
  实际查询都带 `status='active'`；真要归档可以加 `archived_at` 或分区（现在没做，因为量小）。

---

## 2. 库存扣减怎么防并发？为什么用 `FOR UPDATE` 而不是乐观锁？

**一句话**：库存是"读—判断—写"，判断依据（够不够扣）在写之前，所以必须用悲观锁把这一段夹在事务里。

**机制**（`server/src/services/inventory.js`）：

```sql
getConnection → beginTransaction
SELECT id, qty, status FROM batch
 WHERE id = ? AND tenant_id = ?
 FOR UPDATE            -- 锁这一行
-- 校验：批次 active？qty 够不够？(qty > before → 400 数量不足)
UPDATE batch SET qty = qty - ?, status = IF(qty <= 0, 'finished', status)
INSERT INTO stock_log (... qty_before, qty_after, client_op_id ...)
commit / catch → rollback + release
```

- 为什么不乐观锁（`UPDATE ... WHERE qty = 旧值`）：这里冲突概率高（同一个批次的"用掉"和"丢弃"
  很自然并发），乐观锁失败要重试，重试逻辑会把「够不够扣」的判断和幂等搅在一起；
  而 `FOR UPDATE` 让第二个请求**排队**，语义最直白。
- 事务边界是"一次库存操作"：数量更新、状态流转（扣到 0 → `finished`）、流水写入要么全成要么全不成。
- 死锁风险：所有操作都按同一模式"先锁 batch 行再写 stock_log"，不存在交叉加锁；
  `shopping/:id/stock` 里先锁清单项再锁批次，顺序固定。
- 连接必须 `release()`：`withTransaction` 里 `try/finally`，异常也回滚释放。

**可能追问**：

- *`FOR UPDATE` 会不会锁太久？* 事务里只有 3 条 SQL，没有网络调用、没有 LLM 调用——
  慢操作（DeepSeek 抽取）在事务外先做完，confirm 时才开事务。
- *超卖怎么防？* 不存在"超卖"场景（不是秒杀），但要防"扣成负数"：`qty > before` 直接 400，
  且 DB 层 `qty DECIMAL(10,2) NOT NULL DEFAULT 0`，业务校验在事务内、更新前。
- *为什么不用数据库触发器写流水？* 触发器会把逻辑藏进 DB，排查和测试都痛苦；
  显式写在服务层，配合 `stock_log` 单测和 smoke 断言更好讲。

---

## 3. 为什么不上 ORM？

**一句话**：这个项目要考察的正是 ORM 会隐藏的东西——事务边界、行锁、索引命中、批次聚合。

**机制**：

- 全项目只有 `mysql2` + 手写 SQL，`query()` 和 `withTransaction()` 两个入口。
- 有意思的查询都是"手写更清楚"的：位置子树用递归 CTE、列表页用 `GROUP BY` + `MAX` 聚合、
  提醒扫描用 `INSERT IGNORE` 靠唯一键去重——这些在 ORM 里要么写原生 SQL，要么写得很绕。
- 迁移也是手写编号 SQL（`001_init.sql`…`004_*.sql`）+ 32 行 `migrate.js`（建 `schema_migrations`、
  按文件名排序、跳过已执行的、DDL 不可回滚所以不做 down）。
- 代价：没有类型安全、没有关联预加载，字段改名要全局搜。用 zod 守接口入参、`toItem()` 之类
  映射函数守出口来补一部分。

**可能追问**：

- *团队协作会受不了吧？* 会。规则是「每张表一个 SQL 文件、所有查询集中在 routes/services、
  查询必须带 tenant_id」——靠约定而不是靠框架。
- *换 ORM 成本高吗？* 业务代码 90% 是 SQL，换 ORM 等于重写；但这也是这套表结构稳定的好处。

---

## 4. LLM 在这个项目里到底做了什么、没做什么？

**一句话**：模型只做「一句话 → JSON 字段」这一件事，所有需要**正确性保证**的事都在确定性代码里。

**做**（`server/src/services/extract.js` 的 `SYSTEM_PROMPT`）：

- 切分一句话里的多个物品（"纸巾和抽纸各买一份" → 2 条）
- 中文数字转阿拉伯（"三提" → `qty=3`）
- 包装数量不混进总数（"一盒 50 个" → `qty=1, unit=盒, spec=50个/盒`）
- 绝对日期归一（"10月25号" → `2026-10-25`；只说月份 → 该月月末，同时保留原话）
- 判断"这是不是录入"（查询句/修改句 → `items: []` + 引导语）

**不做**：

| 事 | 谁做 | 为什么不让模型做 |
|---|---|---|
| 相对日期换算（"下周""三天后"） | 人确认 | 模型算日期不可靠，且用户看不到它的推理；原话进 `date_phrase`，卡片里让人选 |
| 保质期 → 到期日 | 代码 `addMonths` | 日历加法必须月末夹取（1-31 + 1 月 = 2-28），"30×N 天"会错 |
| 位置 id 匹配 | 代码 | 模型没有位置表；只给 `location_hint` 原话，代码做完全/包含/别名匹配 |
| 物品是否已存在 | 代码 | 模型没有库上下文 |
| 数量/单位合法性 | 代码 | 白名单 22 个单位，`0 < qty ≤ 999` |
| 重复入库判断 | 代码 | 需要查 "同物品+同位置+同到期日" 的现有批次 |
| 写库 | 代码（事务） | 模型输出只是草稿，confirm 才写业务表 |

**可能追问**：

- *边界画错的代价？* 如果让模型算日期，错误率会涨且用户无法察觉（看起来是个合法日期）。
  现在的设计里每个模型不确定的点都会在卡片上标红让人确认。
- *为什么不用 function calling / tool use？* 这里只需要一次结构化输出，
  JSON 模式 + 严格 prompt 足够，还省一轮往返（1.1 s vs 2 轮 2 s+）。
- *模型输出不合法怎么办？* `parseJsonLoose` 剥 ```json 围栏再解析；失败重试 1 次；
  再失败就 `{failed:true}` 退回手动表单（字段清空，但原话保留）。

---

## 5. 抽取失败率多少？失败集中在哪类表达？怎么改的？

**一句话**：20 条测试集上 90%（18 入库 + 2 正确拒绝），失败集中在**位置指代**和**重名物品**，
这两类都是"代码侧语义没对齐"，不是模型抽错。

**数据**（`docs/metrics.md` 可复算）：`confirmed 37 / (37 + 0 failed + 4 rejected) = 90.2%`，
模型往返中位 1.12 s。

**真实踩过的坑（按发现顺序）**：

1. **位置匹配 miss**：用例写"储物间"，库里位置叫"储藏室"，且 `location` 表没有别名字段 →
   匹配为空。改法：用例与种子数据对齐；产品上应该给 `location` 加 `aliases`（P2，现在没做，
   因为自用只需 9 个位置）。
2. **同名物品被拆成两个**：「酸奶 100g」和「酸奶」并存，因为唯一键含 `spec` 而匹配只看名字。
   改成方案 A：匹配时**名字相等即复用**，规格只在多条同名里挑最接近的一条。
3. **单位白名单太窄**："三提纸巾""一箱 12 瓶"被判非法。从 16 个单位扩到 22 个
   （加 箱/提/卷/条/块/碗）。
4. **JSON 列静默失效**（最隐蔽的一个）：mysql2 已经把 JSON 列反序列化成 JS 值，
   代码里再 `JSON.parse` 会抛错、被 `try/catch` 吞掉变成 `[]` ——
   表现是「提醒规则改了不生效，一直在用默认 `[30,7,1,0]`」。
   抽了 `server/src/lib/json.js`（`jsonArray`/`jsonValue`）统一处理，修了 4 处。
5. **"只有年月"** 用例：模型填 `expire_at=null` + `date_phrase="2026年3月"` 是对的，
   但早期实现没让代码取月末 → 改成"该月最后一天，同时 date_phrase 保留原话"。

**怎么保证不再退化**：`server/scripts/eval-extract.js` 是**可复跑的**（会真写库再清理、
退出码按 80% 阈值给 0/1），`--write` 重新生成 `docs/extract-eval.md`；
`normalize.js` 有 23 条单测覆盖日期/月末/位置/物品/重复/数量。

**可能追问**：

- *20 条够吗？* 不够，只能证明主链路。方言、口音、超长句、多物品 5+ 条都没覆盖。
  再往上应该做：真实语音转写语料 100 条、按失败类型分桶统计。
- *怎么知道线上变差了？* `extraction_log` 存了原文、模型原始输出、最终草稿、状态、耗时
  ——每次失败都能倒查是哪一步。

---

## 6. 离线队列怎么保证不重复写入？

**一句话**：客户端生成一次性的 `client_op_id`，服务端 `stock_log.client_op_id` 是唯一键，
重放时先查后插、撞唯一键就返回上次的结果——**幂等落在数据库上，不依赖客户端内存**。

**机制**：

- 每条写操作入队时就固化 `clientOpId = crypto.randomUUID()`（`.cache` 里的脚本也用时间戳兜底）。
- `inventory.js` 的 `runWrite(tenantId, clientOpId, fn)`：
  1. 先 `replayIfDuplicate()` 查 `stock_log` 里有没有这个 `client_op_id` 的记录，有就直接返回
     上次的结果（`idempotent: true`）；
  2. 没有则开事务执行；如果撞 `ER_DUP_ENTRY`（并发重放），再查一次返回。
- `flushQueue()`：**串行**按 `createdAt` 重放（两个改同一批次的操作不能乱序）；
  网络错 → 停住保留下次再试；**业务 4xx → 出队**（再做也不会成功，留着会卡住后面所有操作）。
- 触发点四个：`online` 事件、`visibilitychange`、页面加载、30 s 定时
  （安卓切后台会挂起定时器，所以事件必须都挂）。

**可能追问**：

- *`client_op_id` 会不会被伪造/复用？* 单用户自用；要防的话加 `member_id` 维度 + 过期时间。
- *同一批次离线改两次数量呢？* 两条队列项、两个不同 `client_op_id`，按序执行两次
  `adjust`，最终值就是最后一条——语义正确（因为是两次不同意图的操作）。
- *离线期间另一台设备把批次扣光了？* 重放时事务里 `qty > before` → 400，
  按业务错误出队并提示，不会静默改坏。

---

## 7. 这套表结构怎么长成企业版？

**一句话**：`tenant_id` 已经贯穿所有业务表、`member` 表已经有 `role`，
所以缺的是**权限、审计、并发版本、异步化**这四块，不是重做表。

| 要加的东西 | 怎么做 | 现状 |
|---|---|---|
| 权限体系 | `permission(member_id, scope, resource_id)`：谁能看/改哪个位置（如"保姆只能动厨房"） | 现在只有 `member.role ∈ {owner, member}`，没有校验 |
| 审计日志 | `audit_log(tenant_id, member_id, entity, entity_id, action, before JSON, after JSON, at)`；写接口统一埋点 | `stock_log` 已经是库存的审计，其它实体没有 |
| 并发控制升级 | `batch.version` 做乐观锁 + 业务层重试；或引入事件溯源 | 现在是 `FOR UPDATE` + LWW，单用户够用 |
| 抽取异步化 | `extraction_job` 表 + 队列（BullMQ/Redis），前端轮询/推送；避免 HTTP 超时 | 同步 15 s 超时 |
| 提醒订阅 | `reminder_subscription(member_id, channel, quiet_hours)` + 推送通道（APNs/FCM/邮件） | 只有早 8 点 cron，站内提醒 |
| 多家庭 | 已有 `tenant`，加 `member_tenant` 关系与 owner 转让 | 单人单租户 |
| 归档 | `batch.archived_at` + 分区（按 `expire_at` 年分区） | 现在靠 `status='active'` 过滤 |

**可能追问**：

- *最不该省的是哪块？* 审计。库存这种"谁在什么时候扣了什么"的领域，出问题必须能追；
  现在只有库存有流水，其他实体改了就改了。
- *为什么现在不做权限？* 自用，加了只会让自己多一步校验；但 `tenant_id` 和 `role`
  已经埋好，加的时候不用改表。

---

## 附：面试官可能顺手问的

| 问题 | 答法要点 |
|---|---|
| 为什么不用 TypeScript？ | 后端 JS + ESM 省掉构建；边界用 zod 和显式映射函数守。要是团队做，会换 TS |
| 为什么前端不用 UI 库？ | 6 组件 8 页面，自己写 CSS 更快（styles.css 一套变量、一个 768px 断点）；引 UI 库要跟它的主题系统打架 |
| 状态管理为什么不用 Pinia？ | 一个 `reactive` 对象（token/member/locations/toasts/online/pending）就够，跨页面共享的只有这些 |
| 到期日差一天怎么解决的？ | 日期一律 `DATE` + 连接 `dateStrings: true` + `timezone '+08:00'`；"今天"用 `Date.UTC` 拼纯日期串算差，不碰 `new Date()` 的本地时区 |
| 为什么提醒不会重复弹？ | `alert(batch_id, type, due_date)` 唯一键 + 扫描用 `INSERT IGNORE`，扫 100 次和 1 次结果一样 |
| 演示数据怎么造？ | `.cache/demo.mjs` 走真实 HTTP 接口（幂等），不直接 INSERT——顺便当接口回归 |
