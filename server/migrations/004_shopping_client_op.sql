-- 004：购物清单加幂等键
--
-- 为什么：购物清单也会在离线状态下被创建（手机上没网时先记下来，恢复后重放），
-- 重放必须只入账一次，所以和库存流水一样要一个 client_op_id 幂等键。
-- 用 (tenant_id, client_op_id) 唯一：NULL 不参与去重，手工加的清单项写成 NULL 不受影响。
ALTER TABLE shopping_item
  ADD COLUMN client_op_id VARCHAR(64) NULL AFTER source;

ALTER TABLE shopping_item
  ADD UNIQUE KEY uk_shopping_client_op (tenant_id, client_op_id);
