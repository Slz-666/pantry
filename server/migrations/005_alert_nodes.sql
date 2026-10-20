-- 005_alert_nodes.sql｜提醒支持「多节点提前量」和「零库存物品」
--
-- 两个问题（2026-10-20 验收测试发现的）：
-- 1) 原实现取 max(days_before) 只生成一条提醒，PRD 的「药 T-30/T-7」多节点语义没实现。
--    修法是每个节点一条 alert，靠唯一键 (batch_id, type, due_date, days_before) 去重。
--    due_date 仍然存「到期日」而不是「节点日」：界面上「7 天后到期」才是人看得懂的信息，
--    节点只用于区分「这是提前 30 天那条还是提前 7 天那条」。
-- 2) 零库存（用完/没买过）的物品也要提醒补货，但这时没有 active 批次可挂。
--    原表 batch_id NOT NULL 只能跳过，导致「提醒」和「购物建议」两处口径不一致。
--    修法：batch_id 允许 NULL，另加 item_id 指向物品档案。
--
-- 为什么 batch_id 允许 NULL 后还要 item_id：
--   没有批次的提醒仍然要知道「是哪样东西」，否则列表页只能显示空行；
--   有批次的提醒也写 item_id，列表查询就能统一 COALESCE(b.item_id, a.item_id)。

SET NAMES utf8mb4;

ALTER TABLE alert
  MODIFY batch_id BIGINT UNSIGNED NULL,
  ADD COLUMN item_id BIGINT UNSIGNED NULL AFTER batch_id,
  ADD COLUMN days_before INT NOT NULL DEFAULT 0 AFTER due_date,
  -- 低库存提醒按 item 查（补货后自动关掉这类提醒时要用）
  ADD KEY idx_alert_tenant_item (tenant_id, item_id, type, status),
  ADD CONSTRAINT fk_alert_item FOREIGN KEY (item_id) REFERENCES item (id) ON DELETE CASCADE;

-- 唯一键加 days_before：同一批次同一次到期可以有 T-30/T-7/T-1/T-0 四条
ALTER TABLE alert
  DROP INDEX uk_alert_batch_type_due,
  ADD UNIQUE KEY uk_alert_batch_type_due (batch_id, type, due_date, days_before);

-- 存量数据：旧提醒都是「取最大提前量」口径，days_before 默认 0 即可（不区分节点）
UPDATE alert a
  JOIN batch b ON b.id = a.batch_id
   SET a.item_id = b.item_id
 WHERE a.item_id IS NULL;
