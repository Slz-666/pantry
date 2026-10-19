/**
 * 元数据：单位与分类白名单。
 *
 * 为什么要有这个接口：白名单的唯一来源在后端 normalize.js（校验用），
 * 前端下拉框如果自己抄一份，迟早和校验逻辑不一致，用户会遇到「下拉里有但保存被拒」。
 * 所以前端启动读一次，下拉只展示后端认的值。
 */
import { UNIT_LIST, CATEGORY_LIST } from '../services/normalize.js';

export default async function metaRoutes(app) {
  app.get('/meta', async () => ({
    units: UNIT_LIST,
    categories: CATEGORY_LIST,
  }));
}
