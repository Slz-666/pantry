/**
 * 抽取层：把一句中文口述变成结构化字段（只产草稿，绝不写业务表）。
 *
 * 边界（面试会问）：LLM 只做「话 → 字段」。
 * 日期换算、数量校验、位置/物品匹配、重复判断都在 normalize.js（确定性代码），
 * 所以模型编了字段也脏不了库——最坏情况是草稿里多一个错值，用户确认时改掉。
 *
 * 失败策略：超时 15s、重试 1 次；两次都失败就返回 failed:true，
 * 前端退到手动表单（保留用户原话），绝不把流程卡死。
 */
import '../env.js';

const API_URL = `${(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`;
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS || 15000);
const RETRY = Number(process.env.EXTRACT_RETRY || 1);

/**
 * system prompt 定稿。
 * 每条规则都对应 20 条测试集里的具体用例，改之前先看 server/scripts/eval-extract.js 的期望。
 */
export const SYSTEM_PROMPT = `你是一个家庭物资录入解析器。用户用中文口述「买了什么、多少、放哪、什么时候过期」，
你只把这句话转成 JSON 字段，不寒暄、不确认、不解释。

## 输出格式
只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：
{"items":[{"name":"","spec":null,"qty":null,"unit":null,"category":null,"location_hint":null,"expire_at":null,"date_phrase":null,"shelf_life_value":null,"shelf_life_unit":null,"opened":false}],"missing":[],"question":null}

多说一个物品就多一个 items 元素（「纸巾和洗衣液各买一份」→ 2 条）。

## 字段规则
1. 只输出 JSON，不解释。
2. 用户没说的字段填 null，不许编造。没提数量就是 null，不要默认 1。
3. 日期（今天是 user 消息里给的日期，用它推算）：
   - 有年有月有日、或只有月+日、或只有日号 → 填 expire_at（YYYY-MM-DD）。
     只说日号时取本月该日；该日已过则取下月该日。
   - 相对表达（明天/下周/下周三/三天后/月底）→ expire_at 置 null，原话放 date_phrase。
   - 只有年月没有日（「明年3月过期」）→ expire_at 填该月最后一天（如 2027-03-31），
     date_phrase 保留原话，供用户确认。
4. 只给保质期（「保质期18个月」「60天保质期」）→ 填 shelf_life_value / shelf_life_unit，
   不要自己算到期日，expire_at 置 null。
5. 开封：「已经开封了」→ opened=true；「开封后6个月内用完」→ opened=true，
   且 shelf_life_value/unit 填那个期限（6 / 月）。
6. 位置只放用户原话进 location_hint（如「冰箱中层」「厨房柜」），不许猜位置 id，
   不许改写成你觉得更规范的同义词。
7. 包装里的数量不算总数量：「一盒50个口罩」→ qty=1、unit=盒、spec=50个/盒；
   「两提纸巾，一提6包」→ qty=2、unit=提、spec=6包/提。
8. 中文数字转阿拉伯数字（三提→3、两瓶→2、一板→1）。
9. 单位用用户原话里的量词，没有量词就 null；不要自己换成「个」。
10. category 只在明显时填（食品/日用品/药品/护肤品/清洁用品/宠物用品/工具/其他），拿不准填 null。

## missing 与 question
关键字段有五个：name、qty、unit、location_hint、到期信息（expire_at 与 shelf_life_value 至少一个）。
- 有缺失 → missing 里列字段名，question 用一句中文自然追问，能合并就一次问全。
  例：「买了牛奶」→ missing=["qty","unit","location_hint","expire_at"]，
  question="买了多少（几盒/几瓶）？放哪儿了？什么时候过期？"
- 不缺失 → missing=[]，question=null。

## 不是录入场景
用户的话不是在说明「买了/收到什么」，而是查询、修改、删除、提问时，不要产出 items：
{"items":[],"missing":[],"question":"<一句中文引导>"}
- 「冰箱里的牛奶还剩几盒」→ question："这是在问库存，去首页或位置页看就行，不用录入。"
- 「把冰箱的牛奶改成4盒」→ question："改数量请到物品详情页编辑对应批次，录入只记新的入库。"`;

/** user 消息只带「今天」和原话：位置/物品清单不喂给模型，匹配交给 normalize。 */
export function buildUserMessage(text, today) {
  return `今天是 ${today}（Asia/Shanghai）。\n用户说：${text}`;
}

/**
 * 容错解析模型输出：
 * 即使开了 JSON 模式，模型也可能包一层 ```json 围栏或前后带一句话，
 * 这里先剥围栏、再取第一个 { 到最后一个 }，解析失败才算真失败。
 */
export function parseJsonLoose(content) {
  let s = String(content ?? '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

async function callOnce(messages, timeoutMs) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      // JSON 模式 + 温度 0：录入场景要的是稳定复现，不是发挥
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 1200,
      stream: false,
    }),
    // AbortSignal.timeout 到点直接断掉请求，不会让一个卡住的调用拖住整条链路
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 返回空内容');
  return { content, usage: data.usage || null };
}

/**
 * 调模型拿原始 JSON。超时或 5xx 才重试；4xx（比如 key 错）重试也没用。
 * @returns {{raw:object, usage:object|null, latencyMs:number, attempts:number}}
 */
export async function extractRaw({ text, today }) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage(text, today) },
  ];

  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY + 1; attempt++) {
    const startedAt = Date.now();
    try {
      const { content, usage } = await callOnce(messages, TIMEOUT_MS);
      const raw = parseJsonLoose(content);
      return { raw, usage, latencyMs: Date.now() - startedAt, attempts: attempt };
    } catch (err) {
      lastErr = err;
      const retryable = err.retryable || err.name === 'TimeoutError' || err.name === 'AbortError' || err instanceof SyntaxError;
      if (!retryable || attempt === RETRY + 1) break;
      // 模型偶发返回非法 JSON 时补一句「只输出 JSON」再试，比原样重发有效
      messages.push({ role: 'assistant', content: String(err.message || '').slice(0, 200) });
      messages.push({ role: 'user', content: '只输出 JSON 对象，不要任何其他文字。' });
    }
  }
  throw lastErr;
}
