# 数据模型（阶段 1 定稿）

详细字段与索引见 `server/migrations/001_init.sql`，本文只记关系与"为什么"。

## 关系图（文字版）

```
tenant（租户，现在只有"我家"）
 ├─ member        登录账号（owner/member 两种角色）
 ├─ location      位置树：冰箱 → 冷藏/冷冻/冷冻室；厨房、储藏室、阳台…
 ├─ item          物品档案：名字 + 规格 + 单位 + 分类 + 别名
 │    └─ batch    批次：某一次买入/开封的实体。位置、数量、效期都挂在批次上
 │         ├─ stock_log   库存流水（只增不改，数量变化唯一的解释来源）
 │         └─ alert       到期/开封/缺货提醒实例（扫描任务生成）
 ├─ shopping_item 购物清单（手动加 / 低库存一键加）
 ├─ reminder_rule 提醒规则：分类 → 提前几天提醒、开封后几天吃完
 ├─ extraction_log 每次 LLM 抽取的日志（算成功率、回看误抽）
 └─ setting       键值设置

schema_migrations 记录哪些迁移文件已经跑过（不属于业务表，所以表数 = 11 + 1）
```

## 关键决策与理由

| 决策 | 理由 |
| --- | --- |
| item 和 batch 拆两张表 | 同一物品多盒、位置/效期各不同；库存必须能回答"哪盒先过期、在哪" |
| qty 用 `DECIMAL(10,2)` | 0.5 斤 / 1.5 升要精确对账，浮点会漂 |
| `stock_log.client_op_id` 唯一 | 弱网重试同一个操作只落一次；幂等由数据库兜底，不只靠应用层 |
| `batch.qty` 上有 CHECK ≥ 0 | 数据库层兜住，服务层再在事务里 `FOR UPDATE` 判一次（双保险） |
| location 的 `parent_key` 生成列 | MySQL 唯一键里 NULL 不冲突，根节点（parent_id IS NULL）不加生成列就挡不住重名 |
| item 的 `name_key` 生成列 | spec 为 NULL 时 `UNIQUE(tenant_id,name,spec)` 会漏，用 `IFNULL(spec,'')` 拼成键 |
| item 软删（`deleted_at`） | 历史流水引用不能断，物理行不删 |
| location/batch 用 `ON DELETE RESTRICT` | 位置下有物品 / 批次被引用时禁止删，先挪走或清空再删，避免悬空 |
| 日期 DATE，时刻 DATETIME | 到期日是"哪一天"，带时间会差一天；配合连接 `dateStrings: true` + 时区 `+08:00` |
| 所有表带 `tenant_id` | 硬规则：所有查询必须按租户过滤 |

## 数据目录

- 本机: `D:\vibecoding\data\mysql`（`server/scripts/db.cmd` 启动，port 3307，.gitignore 已排除）
- 迁移: `node server/scripts/migrate.js`（重复执行 = `nothing to migrate`）
- 种子: `node server/scripts/seed.js`（幂等；创建 租户/管理员/9 个位置/3 条提醒规则）
- 默认管理员: `admin / pantry123`（本地演示用，上线前必改）
