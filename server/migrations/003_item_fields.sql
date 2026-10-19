-- 003_item_fields.sql
-- 阶段 3：物品档案需要「保质期参考天数」和「低库存阈值」两列。
-- HANDOFF §6 的 item 设计里有这两个字段，001 建档时漏了，按迁移纪律新增编号文件补上。
ALTER TABLE item
  ADD COLUMN shelf_life_days INT NULL COMMENT '参考保质期天数（可空）' AFTER unit,
  ADD COLUMN low_stock_threshold DECIMAL(10,2) NULL COMMENT '低于此数量算缺货（可空）' AFTER shelf_life_days;
