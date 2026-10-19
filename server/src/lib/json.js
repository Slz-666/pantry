/**
 * MySQL JSON 列的读取 helper。
 *
 * 为什么需要它：mysql2 默认会把 JSON 列反序列化成 JS 值（数组/对象），
 * 这时再 JSON.parse 会抛 "Unexpected token o"，而包在 try/catch 里就会
 * 静默变成空数组——规则、别名这类字段就悄悄失效了（踩过一次真 bug）。
 * 但换成 JSON_EXTRACT / 字符串列时给的又是字符串，所以两种情况都要兼容。
 */

/** 读一个 JSON 数组列：null/坏数据一律回 [] */
export function jsonArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 读一个 JSON 值列（对象/数组/标量都行）：null/坏数据返回 null */
export function jsonValue(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
