-- 002_member_is_active.sql
-- 阶段 2 补漏：登录需要「禁用账号」能力，001 里漏了 is_active 列。
-- 迁移纪律：已执行的迁移文件不改，修结构必须新增编号文件。
ALTER TABLE member
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER role;
