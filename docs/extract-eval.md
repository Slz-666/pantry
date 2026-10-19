# 抽取评测记录（阶段 4 / T4.12）

> 生成时间：2026-10-19 19:34:28（北京时间）
> 模型：deepseek-chat　20 条测试集来自 DEV-PLAN 阶段 4

**结果：confirmed=18 / failed=0 / rejected=2，抽取成功率 90.0%（目标 ≥80%）**

| # | 输入 | 结果 | 耗时 | 说明 |
|---|---|---|---|---|
| 1 | 牛奶6盒放冰箱中层，25号到期 | confirmed | 1376ms | — |
| 2 | 买了三提纸巾，储藏室 | confirmed | 1086ms | — |
| 3 | 鸡蛋一板30个，冷藏，保质期30天 | confirmed | 1014ms | — |
| 4 | 布洛芬一盒放药箱，明年3月过期 | confirmed | 1199ms | — |
| 5 | 酸奶8杯，冷藏，下周三过期 | confirmed | 878ms | — |
| 6 | 买了牛奶 | confirmed | 1090ms | — |
| 7 | 两瓶生抽，厨房柜，保质期18个月 | confirmed | 1085ms | — |
| 8 | 维生素C一瓶，药箱，已经开封了 | confirmed | 1111ms | — |
| 9 | 冷冻了5斤猪肉 | confirmed | 1235ms | — |
| 10 | 上次那个牛奶又买了6盒 | confirmed | 1010ms | — |
| 11 | 冰箱里的牛奶还剩几盒 | refused(正确) | 907ms | — |
| 12 | 大米10斤，储藏室，2027年5月到期 | confirmed | 967ms | — |
| 13 | 牙膏三支，卫生间，保质期两年 | confirmed | 1061ms | — |
| 14 | 速冻饺子2袋放冷冻，60天保质期 | confirmed | 989ms | — |
| 15 | 口罩一盒50个，储藏室 | confirmed | 1048ms | — |
| 16 | 啤酒一箱12瓶，阳台，明年1月到期 | confirmed | 1275ms | — |
| 17 | 纸巾和洗衣液各买一份，储藏室 | confirmed | 1343ms | — |
| 18 | 面包两个，明天到期 | confirmed | 1218ms | — |
| 19 | 把冰箱的牛奶改成4盒 | refused(正确) | 992ms | — |
| 20 | 洗面奶一瓶，卫生间，开封后6个月内用完 | confirmed | 1127ms | — |

## 口径

- `confirmed`：抽取后走完 `/extract/:id/confirm`，真的写进了 batch + stock_log。
- `rejected`：模型判定「不是录入场景」，走 `/extract/:id/reject`（测试集 11、19）。
- `failed`：抽取失败（模型超时/JSON 非法）或确认失败。
- 缺字段的用例（2/5/6/18）按「用户在确认卡片补一个字段后确认」计入 confirmed——这就是真实使用路径。
- 抽取成功率的定义来自 PRD 11：`confirmed / (confirmed + failed + rejected)`。

## 每条失败都能复查

每次抽取（含失败）都会写一行 `extraction_log`：原话、模型原始 JSON、归一化后的草稿、耗时、token 数、状态。
排查用：`SELECT id, status, error, latency_ms, input_text FROM extraction_log ORDER BY id DESC LIMIT 30;`
