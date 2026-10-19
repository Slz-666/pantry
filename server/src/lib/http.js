/**
 * HTTP 小工具：统一错误返回结构 { code, message }。
 * 业务代码里所有 4xx 都走 fail()，保证响应格式一致，前端只写一套错误处理。
 */
export function fail(reply, status, code, message) {
  return reply.code(status).send({ code, message });
}
