@echo off
REM 启动 pantry 自己的 MySQL 8.0 实例（监听 3307），不影响 3306 上已有的实例。
REM 数据目录在仓库内 data\mysql（已 gitignore），与 3306 的实例完全隔离。
REM 关掉这个窗口 = 停止数据库。迁移/种子脚本在另一个终端跑：
REM   node server/scripts/migrate.js
REM   node server/scripts/seed.js
"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqld.exe" --no-defaults --datadir="D:\vibecoding\data\mysql" --port=3307 --console
