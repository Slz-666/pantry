/**
 * 元数据：单位白名单 + 分类（按租户可自定义）。
 *
 * 为什么要有这个接口：白名单的唯一来源在后端，前端下拉框如果自己抄一份，
 * 迟早和校验逻辑不一致，用户会遇到「下拉里有但保存被拒」。
 * 所以前端启动读一次，下拉只展示后端认的值。
 * 分类从 category 表来（F-5.2），拿不到时用默认 8 类兜底（见 services/categories.js）。
 */
import { UNIT_LIST } from '../services/normalize.js';
import { listCategories } from '../services/categories.js';

export default async function metaRoutes(app) {
  app.get('/meta', async (req) => {
    const cats = await listCategories(req.user.tenantId);
    return {
      units: UNIT_LIST,
      // 只给名字，够下拉框用
      categories: cats.map((c) => c.name),
      // 带 id/顺序的完整列表：设置页的「分类管理」要改名/拖动排序
      categoryList: cats,
    };
  });
}
