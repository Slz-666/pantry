-- 006_category.sql｜分类可自定义（PRD F-5.2）
--
-- 原来分类是 normalize.js 里的硬编码白名单（8 个），用户加不了「酒类」「母婴」这类自己的分类。
-- 现在分类落库按租户存，新建租户时用默认 8 个兜底初始化；
-- normalize.js 里的 CATEGORY_LIST 降级为「默认值/兜底名单」，不再作为唯一事实源。
--
-- 为什么不复用 setting 键值表：分类要有顺序、要能改名、要能校验「还有物品在用不能删」，
-- 键值表存 JSON 数组做这些事全靠代码，不如一张三列表干净。

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS category (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(32)     NOT NULL,
  sort_order INT             NOT NULL DEFAULT 0,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_category_tenant_name (tenant_id, name),
  KEY idx_category_tenant_sort (tenant_id, sort_order),
  CONSTRAINT fk_category_tenant FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 给已有租户补默认分类（重复跑不会重复插入：INSERT IGNORE + 唯一键）
INSERT IGNORE INTO category (tenant_id, name, sort_order)
SELECT t.id, d.name, d.sort_order
  FROM tenant t
  JOIN (
          SELECT '食品' AS name, 1 AS sort_order
    UNION ALL SELECT '日用品', 2
    UNION ALL SELECT '药品', 3
    UNION ALL SELECT '护肤品', 4
    UNION ALL SELECT '清洁用品', 5
    UNION ALL SELECT '宠物用品', 6
    UNION ALL SELECT '工具', 7
    UNION ALL SELECT '其他', 8
  ) d
 ORDER BY t.id, d.sort_order;
