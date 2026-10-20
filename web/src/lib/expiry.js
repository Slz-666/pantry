/**
 * 到期判断（T3.10）。只算「日期」不比「时刻」，避免时区把日子算偏一天。
 * 后端 DATE 列以 dateStrings 返回 'YYYY-MM-DD'，这里按年月日构件 UTC 零点做差。
 *
 * 「今天是哪天」必须按 Asia/Shanghai 算，不能用设备本地时区：
 * 手机时区设成 UTC-5 时，`new Date()` 的本地日期会比北京晚一天，
 * 「今天到期」会显示成「明天到期」。服务端固定 +08:00，前端跟着它走。
 */
const CN_OFFSET_MS = 8 * 3600 * 1000;

/** 北京时间今天（UTC 零点的时间戳，只用于做日期减法） */
export function todayCN() {
  const now = new Date(Date.now() + CN_OFFSET_MS);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  if (!m) return null;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((target - todayCN()) / 86400000);
}

/** ok(>7天) / warn(3-7天) / soon(≤2天) / late(已过期) / none(无保质期) */
export function expiryLevel(dateStr) {
  const d = daysUntil(dateStr);
  if (d == null) return 'none';
  if (d < 0) return 'late';
  if (d <= 2) return 'soon';
  if (d <= 7) return 'warn';
  return 'ok';
}

export function expiryText(dateStr) {
  const d = daysUntil(dateStr);
  if (d == null) return '无保质期';
  if (d < 0) return `已过期 ${-d} 天`;
  if (d === 0) return '今天到期';
  if (d === 1) return '明天到期';
  return `${d} 天后到期`;
}

/** 色条 class：exp--late / exp--soon / exp--warn / exp--ok */
export function expiryClass(dateStr) {
  const level = expiryLevel(dateStr);
  return `exp exp--${level}`;
}
