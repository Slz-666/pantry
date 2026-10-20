#!/usr/bin/env bash
# 服务端冒烟测试：健康检查 + 登录鉴权 + 位置/物品 CRUD 两条硬约束。
# 跑法（Git Bash 或 WSL）：bash server/scripts/smoke.sh
#   若 node 不在 PATH：NODE=/c/Users/<你>/.workbuddy/binaries/node/versions/24.14.0/node.exe bash server/scripts/smoke.sh
# 前置：8443 服务在跑（.env 里开了 HTTPS_CERT/HTTPS_KEY）、3307 数据库可用、admin/pantry123 能登录
#      想跑 HTTP 实例就显式覆盖：BASE=http://127.0.0.1:8787 bash server/scripts/smoke.sh
# 注意：所有 JSON body 走临时文件传（--data-binary @file），避免 shell 引号/编码问题
set -uo pipefail

# 生产形态是 HTTPS（手机要 8443），自签证书 curl 不认，统一给 curl 加 -k
curl() { command curl -k "$@"; }

BASE="${BASE:-https://127.0.0.1:8443}"
NODE="${NODE:-node}"
FAILED=0

ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ $*"; FAILED=1; }
expect() { # expect <实际> <期望> <描述>
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got $1, want $2)"; fi
}
# 从 stdin 的 JSON 里按点路径取标量（jq 可能没装，统一用 node）
jget() {
  "$NODE" -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  try{const o=JSON.parse(d);const v=eval("o"+process.argv[1]);console.log(v==null?"":String(v))}
  catch(e){console.log("")}
});' "$1"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

json() { printf '%s' "$1" > "$TMP/body.json"; }
# post_json <url> <json> → 打印状态码，响应体落在 $TMP/resp.json
post_json() {
  json "$2"
  curl -s -o "$TMP/resp.json" -w '%{http_code}' -X POST "$1" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
    --data-binary "@$TMP/body.json"
}
# 状态码简写
code_of() { curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$@"; }

echo "== 1. 健康检查 =="
expect "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")" 200 "GET /api/health"

echo "== 2. 登录 / 鉴权 =="
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' --data-binary '{"username":"admin","password":"pantry123"}')
TOKEN=$(printf '%s' "$LOGIN" | jget ".token")
[ -n "$TOKEN" ] && ok "admin 登录拿到 token" || bad "登录失败: $LOGIN"
expect "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/items")" 401 "无 token 访问 /api/items 被拒（401）"
expect "$(code_of "$BASE/api/items")" 200 "带 token 访问 /api/items 正常"

echo "== 3. 位置 CRUD =="
NAME="冒烟测试柜-$$"
expect "$(post_json "$BASE/api/locations" "{\"name\":\"$NAME\"}")" 201 "创建位置 $NAME"
LOC_ID=$(jget ".id" < "$TMP/resp.json")
[ -n "$LOC_ID" ] && ok "位置 id=$LOC_ID" || bad "拿不到位置 id"
expect "$(post_json "$BASE/api/locations" "{\"name\":\"$NAME\"}")" 409 "同级重名 -> 409"
expect "$(code_of -X PATCH -H 'Content-Type: application/json' --data-binary "{\"name\":\"$NAME-改名\"}" "$BASE/api/locations/$LOC_ID")" 200 "位置改名"
expect "$(code_of -X DELETE "$BASE/api/locations/$LOC_ID")" 200 "删除空位置"

echo "== 4. 物品 CRUD =="
ITEM_NAME="冒烟测试酸奶-$$"
expect "$(post_json "$BASE/api/items" "{\"name\":\"$ITEM_NAME\",\"category\":\"食品\",\"unit\":\"盒\",\"aliases\":[\"酸奶\"]}")" 201 "创建物品 $ITEM_NAME"
ITEM_ID=$(jget ".id" < "$TMP/resp.json")
expect "$(post_json "$BASE/api/items" "{\"name\":\"$ITEM_NAME\",\"category\":\"食品\",\"unit\":\"盒\"}")" 409 "同名同规格 -> 409"
expect "$(post_json "$BASE/api/items" "{\"name\":\"缺单位的物品-$$\",\"category\":\"食品\"}")" 400 "缺 unit -> 400"
# 中文/特殊字符要走 URL 编码，否则 curl 可能发不出请求（实测语法被吞）
Q=$(printf '%s' "$ITEM_NAME" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(encodeURIComponent(d.trim())))')
FOUND=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/items?q=$Q" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);console.log(a.length)})')
expect "$FOUND" 1 "搜索 q 命中 1 条"
expect "$(code_of -X PATCH -H 'Content-Type: application/json' --data-binary '{"lowStockThreshold":2}' "$BASE/api/items/$ITEM_ID")" 200 "修改物品"
expect "$(code_of -X DELETE "$BASE/api/items/$ITEM_ID")" 200 "删除无库存物品"

echo "== 5. 批次与库存流水（两条硬断言）=="
expect "$(post_json "$BASE/api/locations" "{\"name\":\"冒烟测试冷藏-$$\"}")" 201 "创建位置（批次用）"
LOC2_ID=$(jget ".id" < "$TMP/resp.json")
expect "$(post_json "$BASE/api/locations" "{\"name\":\"冒烟测试冷冻-$$\"}")" 201 "创建第二个位置（挪位置用）"
LOC3_ID=$(jget ".id" < "$TMP/resp.json")
post_json "$BASE/api/items" "{\"name\":\"冒烟测试鸡蛋-$$\",\"category\":\"食品\",\"unit\":\"盒\"}" > /dev/null
ITEM_ID=$(jget ".id" < "$TMP/resp.json")
[ -n "$ITEM_ID" ] && ok "创建物品（批次用）id=$ITEM_ID" || bad "创建批次用物品失败"

count_logs() { curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/stock-logs?batchId=$1" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log(JSON.parse(d).length)})'; }
qty_of() { curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/batches/$1" | jget ".qty"; }
patch_batch() {
  printf '%s' "$2" > "$TMP/body.json"
  curl -s -o "$TMP/resp.json" -w '%{http_code}' -X PATCH "$BASE/api/batches/$1" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" --data-binary "@$TMP/body.json"
}

expect "$(post_json "$BASE/api/batches" "{\"itemId\":$ITEM_ID,\"locationId\":$LOC2_ID,\"qty\":10,\"expireAt\":\"2026-12-31\",\"clientOpId\":\"in-$$-$(date +%s)\"}")" 201 "入库 10 盒（建批次）"
BATCH_ID=$(jget ".batchId" < "$TMP/resp.json")
[ -n "$BATCH_ID" ] && ok "批次 id=$BATCH_ID" || bad "入库没返回 batchId"
expect "$(count_logs "$BATCH_ID")" 1 "入库后流水 1 条"
expect "$(qty_of "$BATCH_ID")" 10 "批次数量 10"

CONSUME_ID="consume-$$-$(date +%s)"
expect "$(post_json "$BASE/api/batches/$BATCH_ID/consume" "{\"qty\":4,\"reason\":\"早餐\",\"clientOpId\":\"$CONSUME_ID\"}")" 200 "消耗 4"
expect "$(count_logs "$BATCH_ID")" 2 "消耗后流水 2 条"
expect "$(qty_of "$BATCH_ID")" 6 "消耗后数量 6"

# 硬断言 1：同一个 client_op_id 连发 2 次，stock_log 只多 1 条
expect "$(post_json "$BASE/api/batches/$BATCH_ID/consume" "{\"qty\":4,\"reason\":\"早餐\",\"clientOpId\":\"$CONSUME_ID\"}")" 200 "重放同一 client_op_id → 200"
expect "$(count_logs "$BATCH_ID")" 2 "重放后流水仍是 2 条（幂等）"
expect "$(qty_of "$BATCH_ID")" 6 "重放后数量仍是 6（没重复扣）"

# 硬断言 2：数量不足 → 400 且数量不变
expect "$(post_json "$BASE/api/batches/$BATCH_ID/consume" "{\"qty\":100,\"clientOpId\":\"over-$$\"}")" 400 "消耗超过剩余 → 400"
expect "$(qty_of "$BATCH_ID")" 6 "失败后数量仍为 6"

expect "$(post_json "$BASE/api/batches/$BATCH_ID/consume" "{\"qty\":6,\"clientOpId\":\"drain-$$\"}")" 200 "消耗剩余 6"
expect "$(qty_of "$BATCH_ID")" 0 "批次数量归零"
expect "$(post_json "$BASE/api/batches/$BATCH_ID/consume" "{\"qty\":1,\"clientOpId\":\"after-$$\"}")" 409 "已结束批次再消耗 → 409"

# 验收原文的那条：qty=3 的批次消耗 4 → 400 且数量不变
post_json "$BASE/api/batches" "{\"itemId\":$ITEM_ID,\"locationId\":$LOC2_ID,\"qty\":3,\"clientOpId\":\"in2-$$-$(date +%s)\"}" > /dev/null
B3=$(jget ".batchId" < "$TMP/resp.json")
expect "$(post_json "$BASE/api/batches/$B3/consume" "{\"qty\":4,\"clientOpId\":\"over3-$$\"}")" 400 "qty=3 批次消耗 4 → 400"
expect "$(qty_of "$B3")" 3 "失败后数量仍为 3"

# 调账 / 挪位置 / 改日期 / 丢弃
expect "$(patch_batch "$B3" "{\"qty\":2,\"clientOpId\":\"adj-$$\"}")" 200 "调账到 2"
expect "$(qty_of "$B3")" 2 "调账后数量 2"
expect "$(patch_batch "$B3" "{\"locationId\":$LOC3_ID,\"clientOpId\":\"mv-$$\"}")" 200 "挪位置到另一个柜子"
expect "$(patch_batch "$B3" "{\"expireAt\":\"2027-01-31\",\"clientOpId\":\"dt-$$\"}")" 200 "改到期日"
expect "$(post_json "$BASE/api/batches/$B3/discard" "{\"clientOpId\":\"dis-$$\",\"reason\":\"摔了\"}")" 200 "丢弃剩余 2"
expect "$(qty_of "$B3")" 0 "丢弃后数量 0"
expect "$(count_logs "$B3")" 4 "该批次共 4 条流水（in/adjust/move/discard）"

echo "== 6. 购物清单与提醒 =="
count_alerts() { curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/alerts?status=pending" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log(JSON.parse(d).length)})'; }
has_alert() { curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/alerts?status=pending" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);console.log(a.some(x=>x.id===Number(process.argv[1]))?"yes":"no")})' "$1"; }
has_shopping() { curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/shopping?status=$1" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);console.log(a.some(x=>x.id===Number(process.argv[1]))?"yes":"no")})' "$2"; }

post_json "$BASE/api/items" "{\"name\":\"冒烟测试牛奶-$$\",\"category\":\"食品\",\"unit\":\"盒\"}" > /dev/null
MILK_ID=$(jget ".id" < "$TMP/resp.json")

SHOP_OP="shop-$$-$(date +%s)"
expect "$(post_json "$BASE/api/shopping" "{\"name\":\"冒烟测试面包-$$\",\"qty\":2,\"unit\":\"袋\",\"clientOpId\":\"$SHOP_OP\"}")" 201 "加购物清单项"
SHOP_ID=$(jget ".id" < "$TMP/resp.json")
expect "$(post_json "$BASE/api/shopping" "{\"name\":\"冒烟测试面包-$$\",\"qty\":2,\"unit\":\"袋\",\"clientOpId\":\"$SHOP_OP\"}")" 200 "同一 client_op_id 重放清单项 → 200（幂等）"

expect "$(post_json "$BASE/api/shopping/$SHOP_ID/stock" "{\"locationId\":$LOC2_ID,\"clientOpId\":\"shopstock-$$-$(date +%s)\"}")" 201 "清单项买回来入库（建批次+流水+关清单）"
expect "$(has_shopping bought "$SHOP_ID")" yes "清单项状态变成 bought"

# 造一个已过期批次，触发到期提醒
post_json "$BASE/api/batches" "{\"itemId\":$MILK_ID,\"locationId\":$LOC2_ID,\"qty\":5,\"expireAt\":\"2020-01-01\",\"clientOpId\":\"exp-$$-$(date +%s)\"}" > /dev/null
EXP_BATCH=$(jget ".batchId" < "$TMP/resp.json")
A0=$(count_alerts)
post_json "$BASE/api/jobs/scan" '{}' > /dev/null
A1=$(count_alerts)
[ "$A1" -gt "$A0" ] && ok "扫描生成新提醒（$A0 → $A1 条）" || bad "扫描没有生成提醒"
post_json "$BASE/api/jobs/scan" '{}' > /dev/null
expect "$(count_alerts)" "$A1" "重复扫描不重复生成（唯一键去重）"

ALERT_ID=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/alerts?status=pending" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);const h=a.find(x=>x.batchId===Number(process.argv[1]));console.log(h?h.id:"")})' "$EXP_BATCH")
[ -n "$ALERT_ID" ] && ok "过期批次有提醒 id=$ALERT_ID" || bad "没找到该批次的提醒"

expect "$(qty_of "$EXP_BATCH")" 5 "提醒前批次数量 5"
expect "$(post_json "$BASE/api/alerts/$ALERT_ID/handle" "{\"action\":\"done\",\"clientOpId\":\"hdone-$$-$(date +%s)\"}")" 200 "处理提醒：用掉 1 个"
expect "$(qty_of "$EXP_BATCH")" 4 "处理后批次数量 4"
expect "$(has_alert "$ALERT_ID")" no "提醒已从 pending 列表消失"
expect "$(post_json "$BASE/api/alerts/$ALERT_ID/handle" "{\"action\":\"done\",\"clientOpId\":\"hagain-$$\"}")" 200 "重复处理同一提醒 → 200（幂等）"
expect "$(qty_of "$EXP_BATCH")" 4 "重复处理不再扣库存（仍 4）"

# 阶段 5：补货建议（T5.6）——建议是实时算出来的，不自动写进清单
SUG_IS_ARRAY=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/shopping/suggestions" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(Array.isArray(JSON.parse(d))?"yes":"no")}catch(e){console.log("no")}})')
expect "${SUG_IS_ARRAY:-no}" yes "GET /shopping/suggestions 返回数组"
expect "$(post_json "$BASE/api/shopping" "{\"name\":\"冒烟测试来源-$-\",\"qty\":1,\"unit\":\"个\",\"source\":\"bad_source\",\"clientOpId\":\"badsrc-$$-$(date +%s)\"}")" 400 "清单项来源非白名单 → 400"

# 阶段 5 补：提醒规则（只读列表 + 非法入参不改真实数据）
expect "$(code_of "$BASE/api/reminder-rules")" 200 "GET /api/reminder-rules 返回规则列表"
RULE_ID=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/reminder-rules" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d);console.log(a[0]?.id??"")}catch(e){console.log("")}})')
[ -n "$RULE_ID" ] && ok "读到规则 id=$RULE_ID" || bad "规则列表为空"
RULE_BAD=$(curl -s -o "$TMP/rule.json" -w '%{http_code}' -X PATCH "$BASE/api/reminder-rules/$RULE_ID" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" --data-binary '{"daysBefore":[-1]}')
expect "$RULE_BAD" 400 "提醒规则非法节点 → 400（不改动真实规则）"

echo
echo "== 7. 录入 Agent（一句话抽草稿 / 非录入被拒） =="
expect "$(code_of "$BASE/api/meta")" 200 "GET /api/meta 返回单位/分类白名单"
expect "$(post_json "$BASE/api/extract" "{\"text\":\"冒烟测试酸奶 三杯放冰箱冷藏，2027年1月到期\",\"channel\":\"text\"}")" 200 "一句话抽成草稿（真调 DeepSeek）"
DRAFT_N=$(jget ".draft.items.length" < "$TMP/resp.json")
[ "${DRAFT_N:-0}" -ge 1 ] && ok "草稿里有 ${DRAFT_N} 条物品" || bad "草稿没有物品"
expect "$(jget ".draft.items[0].qty" < "$TMP/resp.json")" 3 "数量抽对（三 → 3）"
expect "$(jget ".draft.items[0].expireAt" < "$TMP/resp.json")" 2027-01-31 "只说月份 → 取月末（2027-01-31）"
expect "$(jget ".draft.items[0].locationName" < "$TMP/resp.json")" 冷藏 "位置原话「冰箱冷藏」匹配到「冷藏」"

expect "$(post_json "$BASE/api/extract" '{"text":"冰箱里的牛奶还剩几盒","channel":"text"}')" 200 "查询句不让接口报错"
expect "$(jget ".draft.refused" < "$TMP/resp.json")" true "查询句被判成「不是录入」（refused）"
expect "$(post_json "$BASE/api/extract" '{"text":"把冰箱的牛奶改成4盒","channel":"text"}')" 200 "修改句不让接口报错"
expect "$(jget ".draft.refused" < "$TMP/resp.json")" true "修改句被判成「不是录入」（refused）"

echo
if [ "$FAILED" = "0" ]; then echo "全部通过"; else echo "存在失败项"; fi
exit "$FAILED"
