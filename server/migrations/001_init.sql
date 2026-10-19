-- 001_init.sql｜家里有什么 首版表结构
-- 设计依据：PRD §8 数据模型、HANDOFF §6 数据模型约束。
--
-- 为什么看起来"多一张 batch 表"：
--   物品(item)和批次(batch)是两回事。同一盒牛奶和另一盒牛奶，位置/效期/开封时间可能全不同，
--   库存问题的正确答案是"哪一盒先过期、在哪"，不是"牛奶一共几盒"。没有批次表，这个项目最核心的
--   "先吃哪盒"就答不出来（HANDOFF 决策 #2）。
--
-- 为什么数量用 DECIMAL 而不是 FLOAT/INT：
--   数量要精确累加对账（0.5 斤、1.5 升），浮点 0.1+0.2 会出现误差，最后和流水对不上。
--
-- 为什么每张表都带 tenant_id：
--   所有查询都必须按 tenant_id 过滤（HANDOFF §10 硬规则 1），现在留好位置，以后加人不用改表结构。

SET NAMES utf8mb4;

-- 租户：现在只有"我家"一个，但表结构从一开始就按多租户写。
CREATE TABLE IF NOT EXISTS tenant (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(64)  NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 成员：登录账号。密码只存 bcrypt 哈希，不存明文（HANDOFF 硬规则 + 安全底线）。
CREATE TABLE IF NOT EXISTS member (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  username      VARCHAR(32)  NOT NULL,
  password_hash VARCHAR(60)  NOT NULL,
  display_name  VARCHAR(32)  NOT NULL,
  role          ENUM('owner','member') NOT NULL DEFAULT 'member',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_member_tenant_username (tenant_id, username),
  CONSTRAINT fk_member_tenant FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 位置：树形（冰箱 → 冷藏/冷冻/冷冻室）。parent_id 为 NULL 表示根节点。
-- 为什么加 parent_key 生成列：MySQL 唯一键里 NULL 不参与冲突，根节点的 parent_id 都是 NULL，
--   若直接 UNIQUE(tenant_id, parent_id, name)，同一层可以插出两个"厨房"。COALESCE(parent_id,0)
--   把 NULL 变成 0 参与唯一键，根层重名就被数据库挡住了。
-- ON DELETE RESTRICT：位置下还有物品时不允许删，必须先把物品挪走或删掉，防止悬挂引用。
CREATE TABLE IF NOT EXISTS location (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  parent_id  BIGINT UNSIGNED NULL,
  parent_key BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(parent_id, 0)) STORED,
  name       VARCHAR(64)  NOT NULL,
  sort_order INT          NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_location_tenant_parent_name (tenant_id, parent_key, name),
  KEY idx_location_tenant_parent (tenant_id, parent_id),
  CONSTRAINT fk_location_tenant FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE,
  CONSTRAINT fk_location_parent FOREIGN KEY (parent_id) REFERENCES location (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 物品：单品档案（名字、规格、单位、分类、别名、条形码）。同一物品的不同"盒/袋"是 batch。
-- name_key 生成列：把 name+spec 拼成唯一键。spec 为 NULL 时若直接 UNIQUE(tenant_id,name,spec)，
--   NULL 会让"白砂糖 500g"和"白砂糖 500g"都可能被插入；用 IFNULL 兜住。
-- deleted_at 软删：物品被删后，历史流水仍要能解释来源，所以物理行保底不删。
CREATE TABLE IF NOT EXISTS item (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id           BIGINT UNSIGNED NOT NULL,
  name                VARCHAR(64)  NOT NULL,
  spec                VARCHAR(64)  NULL,
  name_key            VARCHAR(130) GENERATED ALWAYS AS (CONCAT(name, '|', IFNULL(spec, ''))) STORED,
  category            VARCHAR(32)  NULL,
  unit                VARCHAR(8)   NOT NULL DEFAULT '个',
  aliases             JSON         NULL,
  barcode             VARCHAR(64)  NULL,
  default_location_id BIGINT UNSIGNED NULL,
  note                VARCHAR(255) NULL,
  deleted_at          DATETIME     NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_item_tenant_name (tenant_id, name_key),
  UNIQUE KEY uk_item_tenant_barcode (tenant_id, barcode),
  KEY idx_item_tenant_name (tenant_id, name),
  KEY idx_item_tenant_location (tenant_id, default_location_id),
  CONSTRAINT fk_item_tenant FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE,
  CONSTRAINT fk_item_location FOREIGN KEY (default_location_id) REFERENCES location (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 批次：一次买入/开封的一组同规格物品。库存 quantity 跟着批次走。
-- qty 的 CHECK：数据库层保证不为负，服务层还有事务 + FOR UPDATE 再判一次（双保险）。
-- location 用 RESTRICT：批次所在位置不能直接删掉，避免"物品在哪"变成悬空。
-- expire_at 用 DATE 而不是 DATETIME：到期日是"哪一天"，时间部分只会造成"当天差一天"的 bug
--   （连接串 dateStrings: true 配合，见 PRD §14 经验 1）。
CREATE TABLE IF NOT EXISTS batch (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  item_id     BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NOT NULL,
  qty         DECIMAL(10,2) NOT NULL DEFAULT 0,
  produced_at DATE          NULL,
  expire_at   DATE          NULL,
  opened_at   DATETIME      NULL,
  status      ENUM('active','finished','discarded') NOT NULL DEFAULT 'active',
  note        VARCHAR(255)  NULL,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- 查"N 天内到期"的索引：到期提醒的核心查询
  KEY idx_batch_tenant_expire (tenant_id, expire_at),
  -- 查"某位置有什么"的索引：位置详情页
  KEY idx_batch_tenant_location (tenant_id, location_id),
  -- 查"某物品的批次"：物品详情页按到期日排序
  KEY idx_batch_tenant_item (tenant_id, item_id, status),
  CONSTRAINT fk_batch_tenant FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE,
  CONSTRAINT fk_batch_item FOREIGN KEY (item_id) REFERENCES item (id) ON DELETE RESTRICT,
  CONSTRAINT fk_batch_location FOREIGN KEY (location_id) REFERENCES location (id) ON DELETE RESTRICT,
  CONSTRAINT chk_batch_qty CHECK (qty >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 库存流水：所有数量的变化都必须能在这里找到原因（HANDOFF 硬规则 12）。
-- 只增不改：没有 UPDATE/DELETE 的接口，冲销靠追加一条反向流水。
-- client_op_id 唯一：弱网重试时同一个操作只落一次，幂等靠数据库唯一键兜底（硬规则 2）。
-- qty_before / qty_after：审计和对账用，任何一笔都能还原当时的数量。
CREATE TABLE IF NOT EXISTS stock_log (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id         BIGINT UNSIGNED NOT NULL,
  batch_id          BIGINT UNSIGNED NOT NULL,
  item_id           BIGINT UNSIGNED NOT NULL,
  location_id       BIGINT UNSIGNED NOT NULL,
  type              ENUM('in','consume','discard','adjust','move','extract_in') NOT NULL,
  qty_delta         DECIMAL(10,2) NOT NULL,
  qty_before        DECIMAL(10,2) NOT NULL,
  qty_after         DECIMAL(10,2) NOT NULL,
  reason            VARCHAR(64)   NULL,
  client_op_id      VARCHAR(64)   NOT NULL,
  operator_member_id BIGINT UNSIGNED NULL,
  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_stock_op (client_op_id),
  KEY idx_stock_tenant_batch (tenant_id, batch_id, created_at),
  KEY idx_stock_tenant_item (tenant_id, item_id, created_at),
  KEY idx_stock_tenant_location (tenant_id, location_id, created_at),
  KEY idx_stock_tenant_created (tenant_id, created_at),
  CONSTRAINT fk_stock_tenant FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE,
  CONSTRAINT fk_stock_batch FOREIGN KEY (batch_id) REFERENCES batch (id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_item FOREIGN KEY (item_id) REFERENCES item (id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_location FOREIGN KEY (location_id) REFERENCES location (id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_member FOREIGN KEY (operator_member_id) REFERENCES member (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 购物清单：可以手动加，也可以从"库存明显不够"提醒一键加。
-- item_id 为空表示还没对应的物品档案（比如新想买的品牌）。
-- status 三态：pending（待买）/ bought（已买）/ cancelled（不买了）。
CREATE TABLE IF NOT EXISTS shopping_item (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  item_id    BIGINT UNSIGNED NULL,
  name       VARCHAR(64)  NOT NULL,
  qty        DECIMAL(10,2) NOT NULL DEFAULT 1,
  unit       VARCHAR(8)   NOT NULL DEFAULT '个',
  status     ENUM('pending','bought','cancelled') NOT NULL DEFAULT 'pending',
  source     ENUM('manual','low_stock','alert') NOT NULL DEFAULT 'manual',
  note       VARCHAR(255) NULL,
  done_at    DATETIME     NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_shopping_tenant_status (tenant_id, status, created_at),
  CONSTRAINT fk_shopping_tenant FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE,
  CONSTRAINT fk_shopping_item FOREIGN KEY (item_id) REFERENCES item (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 提醒规则：分类 → 提前几天提醒、开封后多少天内吃完。
-- days_before 用 JSON 存 [30,7,1,0]：提醒节点是"提前 X 天"，不同货架期物品需要的节点不同，
--   用 JSON 一个字段就能表达，不用为每个节点建行。
CREATE TABLE IF NOT EXISTS reminder_rule (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  category    VARCHAR(32) NOT NULL,
  days_before JSON        NOT NULL,
  opened_days INT         NULL,
  enabled     TINYINT(1)  NOT NULL DEFAULT 1,
  created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_rule_tenant_category (tenant_id, category),
  CONSTRAINT fk_rule_tenant FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 提醒实例：由扫描任务从规则 + 批次算出来。同批次同类型同日期只生成一条，靠唯一键防重复。
-- 为什么 due_date 进唯一键：同一批次 30 天前和 7 天前应是两条不同的提醒，日期区分它们。
CREATE TABLE IF NOT EXISTS alert (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  batch_id   BIGINT UNSIGNED NOT NULL,
  type       ENUM('expire','opened_expire','low_stock') NOT NULL,
  due_date   DATE          NOT NULL,
  status     ENUM('pending','done','discarded','ignored') NOT NULL DEFAULT 'pending',
  handled_at DATETIME      NULL,
  created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_alert_batch_type_due (batch_id, type, due_date),
  KEY idx_alert_tenant_status (tenant_id, status, due_date),
  CONSTRAINT fk_alert_tenant FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE,
  CONSTRAINT fk_alert_batch FOREIGN KEY (batch_id) REFERENCES batch (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 抽取日志：每次 LLM 抽取都留一条（即使 draft 被丢弃），用于算成功率、回看误抽原因。
-- raw_response 存模型的原始输出：出问题时能复盘"模型当时到底说了什么"。
-- draft / confirmed 分开记录：确认后的最终数据在 item/batch 里，这里只存"用户当时看到的草稿"。
CREATE TABLE IF NOT EXISTS extraction_log (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id         BIGINT UNSIGNED NOT NULL,
  member_id         BIGINT UNSIGNED NOT NULL,
  input_text        TEXT         NOT NULL,
  channel           ENUM('text','voice') NOT NULL DEFAULT 'text',
  raw_response      JSON         NULL,
  draft             JSON         NULL,
  status            ENUM('draft','confirmed','rejected','failed') NOT NULL DEFAULT 'draft',
  error             VARCHAR(255) NULL,
  latency_ms        INT          NULL,
  prompt_tokens     INT          NULL,
  completion_tokens INT          NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_extract_tenant_created (tenant_id, created_at, status),
  CONSTRAINT fk_extract_tenant FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE,
  CONSTRAINT fk_extract_member FOREIGN KEY (member_id) REFERENCES member (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 设置：租户级键值对（默认位置、默认单位、提醒总开关等）。值用 TEXT 存，读的代码自己维护类型。
CREATE TABLE IF NOT EXISTS setting (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  k          VARCHAR(64) NOT NULL,
  v          TEXT        NULL,
  updated_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_setting_tenant_key (tenant_id, k),
  CONSTRAINT fk_setting_tenant FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
