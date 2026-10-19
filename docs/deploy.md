# 部署与真机（阶段 7）

> 目标：手机装上 PWA、语音能录、断网能用，电脑上看到同一份数据。
> 先跑步通局域网这一步（7a），再决定要不要暴露到公网（7b）。

## 0. 现在的形态

```
手机/电脑浏览器
   │  https://192.168.0.101:8443
   ▼
Fastify (server/src/index.js)
   ├── /api/*        → 业务接口（JWT + 租户隔离）
   ├── /sw.js        → Service Worker
   ├── /manifest.json、/icons/*
   └── /assets/*、/  → web/dist 构建产物（@fastify/static，SPA 深链接回落 index.html）
   │
   ▼
 MySQL 8.0.46（本机独立实例，数据目录 data/mysql，端口 3307）
```

一个进程同时托管前端与 API：同源，所以不需要 nginx 反代、不需要配 CORS、SW 缓存壳也不会跨源。
（`docker-compose.yml` 里的 mysql 服务是备选方案，镜像源修好后可以切回。）

## 1. 构建 + 启动

```bash
# 前端产物
npm run build --workspace web

# .env 里打开 HTTPS（证书见第 2 节）
#   HTTPS_CERT=certs/server.crt
#   HTTPS_KEY=certs/server.key
#   HTTPS_PORT=8443

# 数据库（如果没跑着）
server/scripts/db.cmd

# 起服务
node server/src/index.js
# → Server listening at https://0.0.0.0:8443
# → serving web build  {"webDist":"...\\web\\dist"}
```

本机自检：

```bash
curl -k https://127.0.0.1:8443/api/health          # {"ok":true}
curl -k -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8443/   # 200
```

## 2. 证书（手机要 HTTPS 才给麦克风和 PWA）

用 Git 自带的 openssl 生成，一条命令：

```bash
bash server/scripts/make-cert.sh 192.168.0.101
```

产物（`certs/` 已被 gitignore，绝不入库）：

| 文件 | 用途 |
|---|---|
| `certs/ca.crt` | 根证书，**要装到手机上** |
| `certs/server.crt` / `certs/server.key` | 服务端证书，填进 .env |

SAN 里同时包含 `localhost`、`127.0.0.1` 和你的局域网 IP，所以电脑上用 `https://localhost:8443` 也能过。
IP 变了（换 WiFi / DHCP 重新分配）就重跑一次脚本。

Windows 上 curl 验证时会报 `schannel: the revocation status is unknown`——那是 Windows 的吊销检查不认自签证书，
不是证书错。加 `--ssl-no-revoke` 即可：

```bash
curl --ssl-no-revoke --cacert certs/ca.crt https://192.168.0.101:8443/api/health
```

浏览器/安卓不因为"没有吊销列表"而拒绝，所以不影响真机。

## 3. 手机准备（安卓机 / Android）

1. **同一 WiFi**：手机和电脑连同一个路由。
2. **防火墙放行 8443**（管理员 PowerShell，只需一次）：
   ```powershell
   netsh advfirewall firewall add rule name="pantry-8443" dir=in action=allow protocol=TCP localport=8443
   ```
3. **装 CA**：把 `certs/ca.crt` 传到手机（微信文件传输 / 数据线 / 局域网临时静态服务都行），然后
   设置 → 密码与安全 → 系统安全 → 加密与凭据 → 安装证书 → **CA 证书** → 仍然安装 → 选文件。
   提示"数据可能被监控"属正常，这是自签 CA 的标准告警。
   > Android 14 的菜单路径可能是：设置 → 安全 → 更多安全设置 → 加密与凭据 → 安装证书。
4. 手机 Chrome 打开 `https://192.168.0.101:8443` → 地址栏应显示锁标志（无红色警告）。
   若仍报 `NET::ERR_CERT_AUTHORITY_INVALID`：CA 没装上，或装到了"用户证书"以外的位置（要装 CA 不是 VPN/应用证书）。

## 4. 装 PWA

Chrome 打开站点 → 右上角 ⋮ → **添加到主屏幕** → 安装。
装好后从桌面图标打开是全屏（`display: standalone`），地址栏消失。

判断是否真的成了 PWA（而不是书签）：
- 桌面图标打开后没有浏览器地址栏；
- Chrome 里访问 `chrome://webapks` 能看到这个包；
- 断网后从图标打开，还能看到上次的数据（Service Worker 生效）。

## 5. 真机自测清单（CHECKPOINT 7 的验收内容）

| # | 操作 | 期望 |
|---|---|---|
| T7.5 | 点「记一笔」→ 🎤 说「牛奶6盒放冰箱中层25号到期」 | 确认卡片填出 牛奶 / 6 / 盒 / 冰箱 > 中层 / 10-25，点确认后进物品详情，流水 +6 |
| T7.6 | 飞行模式 → 提醒页点「用掉 1 个」 | 顶部出现「离线 · 待同步 1 条」；关飞行模式后自动同步，流水只多 1 条、数量只减 1 |
| T7.7 | 电脑打开同一地址 | 看到手机上刚录的这批货（同一份数据） |
| 提醒 | 第二天早 8:00 后打开 | 到期提醒出现在「提醒」页，点「用掉」后消失、库存 -1 |

语音相关的已知边界：
- 只支持安卓 Chrome（`webkitSpeechRecognition`），iOS Safari 不支持 —— 这是 HANDOFF 锁定决策 #10。
- 首次点 🎤 会请求麦克风权限，**必须 https**，http 下（局域网 IP）按钮点了没反应且不报错。
- 识别结果是系统给的，口音/方言会影响准确率，草稿卡片可以手改。

## 6. 出公网（7b，可选）

自用场景局域网就够。要出门在外也能用，两条路（都不需要自己买 VPS）：

| 方案 | 前提 | 做法 |
|---|---|---|
| Cloudflare Tunnel | 有域名、装在 Cloudflare | `cloudflared tunnel create pantry` → `cloudflared tunnel route dns pantry pantry.example.com` → `cloudflared tunnel run --url https://localhost:8443 pantry` |
| Tailscale Funnel | 无域名也行 | `tailscale funnel 8443`，得到一个 `*.ts.net` 域名，自带证书 |

两条路都自动带合法证书，手机不用再装 CA。注意公网暴露后要确认 `JWT_SECRET` 已改成随机串、
数据库端口不对外、`.env` 没有入 git。

## 7. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 手机打开显示 `ERR_CONNECTION_REFUSED` | 服务只监听 127.0.0.1，或防火墙拦了 | 确认 `HOST=0.0.0.0`；放行 8443 |
| 证书警告点不过去 | CA 未安装 / IP 变了 | 重装 `ca.crt`；重跑 make-cert.sh |
| 🎤 点了没反应 | 不是 https 上下文 | 换 https 地址；iOS 不支持 |
| 加了主屏幕但还是浏览器界面 | Chrome 判定不满足安装条件 | 检查 manifest 的 `start_url`、图标 192/512、SW 是否注册成功 |
| 断网刷新白屏 | SW 没注册（dev 模式故意不注册） | 用构建产物（8443）访问，别用 5173 |
| 改了代码手机看不到新版本 | SW 缓存了旧壳 | 改 `web/public/sw.js` 里的 `VERSION`，重新构建 |

## 8. 真机验收记录（2026-10-19，安卓机 / ROM，安卓 15）

如实记录这次真机联调踩到的三件事，**都是环境问题，不是代码问题**：

| 环节 | 结果 | 说明 |
|---|---|---|
| 走家里 WiFi（手机 192.168.0.100 / 电脑 192.168.0.101） | ✗ | 手机报 `ERR_ADDRESS_UNREACHABLE`；电脑侧 `0.0.0.0:8443` 监听、防火墙 `pantry` 规则已放行、本机自测 200。ARP 里能看到手机，二层可达但三层被隔离——路由器的客户端隔离（AP isolation）策略，属于网络侧限制 |
| 电脑开移动热点（手机 192.168.137.171 / 电脑 192.168.137.1） | ✓ | 直连同一网段，无 AP 隔离；`https://192.168.137.1:8443` 正常，`curl --cacert certs/ca.crt` 校验通过 |
| 手机装 CA | ✓ | 设置 → 密码与安全 → 系统安全 → 加密与凭据 → 安装证书 → **CA 证书** → 仍然安装 |
| 登录 + 首页 | ✓ | `admin` 登录，看板数字与电脑端一致（同一库） |
| **T7.5 语音录入** | ✓ | 说「牛奶6盒放冰箱中层25号到期」→ 确认卡片字段正确 → 入库成功 |
| **T7.6 离线** | ✓ | 飞行模式点「用掉 1 个」→ 顶部「离线 · 待同步 1 条」→ 关飞行模式自动同步，流水只多 1 条、数量只减 1 |
| T7.4 装 PWA（独立窗口） | △ | 菜单里出现「安装并创建快捷方式」，确认后桌面没有图标。国内 ROM 无 GMS，WebAPK 的安装服务（Chrome 通过 Play 服务落桌面图标）不可用，属已知 ROM 限制；`chrome://webapks` 也查不到。改走「添加到主屏幕」快捷方式，功能（语音/离线/SW）完全不受影响 |

> 结论：**PWA 的"可安装性"在桌面 Chrome / Edge 上已实证**（manifest + SW + `display: standalone`），
> 真机唯一缺的是 ROM 那一步落图标。这条限制写在这里，比假装装上了更诚实，也是面试可讲的真实排障过程。

