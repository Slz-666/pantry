<script setup>
/**
 * 录入页（T3 占位，阶段 4 填充核心链路）。
 * 这一页的设计目标是「一句话 → 确认卡片 → 入库」三步内完成，
 * 语音按钮、抽取结果、确认卡片在阶段 4 接上。这里先把入口和说明放好。
 */
</script>

<template>
  <div>
    <div class="card">
      <h2 class="page-title">说一句话就能记</h2>
      <p class="muted" style="margin-top: 8px">
        例：「牛奶两盒放冰箱冷藏，下周五过期」「洗衣液囤了两桶放储物间」。
      </p>
      <p class="muted">
        大模型只负责把这句话变成字段，日期换算、数量校验、重名判断都由确定性代码和你的确认完成。
      </p>
    </div>

    <div class="card">
      <div class="section-title"><span>当前状态</span></div>
      <p class="muted">
        阶段 4 上线录入 Agent：文字/语音输入 → 抽取草稿 → 确认卡片 → 入库。现在可以先在「位置」页查看已有物品。
      </p>
      <RouterLink to="/" class="btn btn--primary btn--block" style="margin-top: 12px">回首页看看</RouterLink>
    </div>
  </div>
</template>
