/**
 * Host 半的语义提炼接口测试（不联网、不花钱：用假 LLM 流）。
 *
 * 运行：node dsh-bookweave/test/host.mjs
 */
import { EventEmitter } from 'node:events';
import { __test } from '../index.js';

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log('ok   ' + name);
  else {
    failures++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk || '';
    },
  };
}

function makeReq(body, headers) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = headers || {};
  req.destroy = () => {};
  return { req: req, body: body };
}

function makeLlm(output, extra) {
  const calls = [];
  return {
    calls: calls,
    listProviders: () => [{ id: 'fake' }],
    listModels: async () => [{ id: 'fake-1' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'off' }] } }),
    stream: async function* (options) {
      calls.push(options);
      yield { type: 'text-delta', text: output };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      if (extra && extra.after) yield extra.after;
    },
  };
}

function makeCtx(llm) {
  return {
    get(name) {
      if (name === 'llm') return llm;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-1', reasoningEffort: 'high' }) };
      return undefined;
    },
  };
}

async function callHandler(handler, payload, headers) {
  const req = makeReq(JSON.stringify(payload), headers || { 'x-dsh-bookweave': '1' });
  const res = makeRes();
  const promise = handler(req.req, res);
  req.req.emit('data', Buffer.from(req.body));
  req.req.emit('end');
  await promise;
  return res;
}

// 1. prompt 带编号 + 省 token 约束
const prompt = __test.buildPrompt({
  bookTitle: '测试书',
  author: '作者',
  chapterTitle: '第一章',
  truncated: false,
  blocks: [{ i: 0, text: '开头' }, { i: 5, text: '中间' }, { i: 9, text: '结尾' }],
});
check('prompt 包含段落编号', prompt.includes('[#0]') && prompt.includes('[#5]') && prompt.includes('[#9]'));
check('prompt 要求严格 JSON', prompt.includes('只输出二选一的严格 JSON'));

// 2. 输出收敛：非法 block 被丢弃
const allowed = new Set([0, 5, 9]);
const fiction = __test.normalizeInsight(
  { mode: 'fiction', summary: '概括', beats: [{ text: '节点', block: 5 }, { text: '越界', block: 99 }, { text: '', block: 0 }] },
  allowed
);
check('fiction 输出只保留合法编号', fiction.mode === 'fiction' && fiction.beats.length === 1 && fiction.beats[0].block === 5, JSON.stringify(fiction));
const nonfiction = __test.normalizeInsight(
  { mode: 'nonfiction', claims: [{ text: '观点', block: 0, evidence: [{ text: '证据', block: 9 }, { text: '无效', block: 12 }] }] },
  allowed
);
check('nonfiction 只保留合法论据', nonfiction.claims.length === 1 && nonfiction.claims[0].evidence.length === 1, JSON.stringify(nonfiction));
check('无法解析的输出返回 null', __test.normalizeInsight({ mode: 'other' }, allowed) === null && __test.normalizeInsight(null, allowed) === null);

const withRelation = __test.normalizeInsight(
  { mode: 'nonfiction', claims: [{ text: '观点', block: 0, evidence: [{ text: '证据', block: 9, relation: 'data', link: '数据显示' }] }] },
  allowed
);
check('论据关系被保留', withRelation.claims[0].evidence[0].relation === 'data' && withRelation.claims[0].evidence[0].link === '数据显示', JSON.stringify(withRelation));
const badRelation = __test.normalizeInsight(
  { mode: 'nonfiction', claims: [{ text: '观点', block: 0, evidence: [{ text: '证据', block: 9, relation: 'made-up' }] }] },
  allowed
);
check('非法关系被丢弃', badRelation.claims[0].evidence[0].relation === '', JSON.stringify(badRelation));


// 3. 最低 reasoning 档
check('reasoning 取最低档', __test.lowestEffort({ reasoning: { efforts: [{ id: 'max' }, { id: 'off' }, { id: 'high' }] } }) === 'off');

// 4. handler：正常返回 + 省 token 参数
{
  const llm = makeLlm(JSON.stringify({ mode: 'fiction', summary: '本章讲了一件事。', beats: [{ text: '他走进房间。', block: 5 }] }));
  const handler = __test.createHandler(makeCtx(llm));
  const res = await callHandler(handler, {
    bookTitle: '测试书',
    author: '作者',
    chapterTitle: '第一章',
    blocks: [{ i: 0, text: '开头' }, { i: 5, text: '中间' }, { i: 9, text: '结尾' }],
  });
  const payload = JSON.parse(res.body);
  check('handler 返回 200', res.statusCode === 200, res.body);
  check('handler 输出 fiction 结构', payload.ok === true && payload.mode === 'fiction' && payload.beats.length === 1);
  check('输出 token 上限 700', llm.calls[0].maxTokens === 700);
  check('使用最低 reasoning 档', llm.calls[0].reasoningEffort === 'off');
  check('model 回传', payload.model === 'fake-1' && payload.provider === 'fake');
  check('usage 回传', payload.usage && payload.usage.totalTokens === 30);
  const promptChars = llm.calls[0].messages[0].content[0].text.length;
  check('prompt 长度受控（≤ 8000 字符 + 提示词开销）', promptChars <= __test.MAX_PROMPT_CHARS + 800, promptChars);
}

// 5. 缺少自定义头 → 403
{
  const llm = makeLlm('{}');
  const handler = __test.createHandler(makeCtx(llm));
  const res = await callHandler(handler, { blocks: [{ i: 0, text: 'x' }] }, {});
  check('缺少请求头返回 403', res.statusCode === 403 && llm.calls.length === 0);
}

// 6. 模型输出不是 JSON → 502
{
  const llm = makeLlm('抱歉，我无法总结。');
  const handler = __test.createHandler(makeCtx(llm));
  const res = await callHandler(handler, { blocks: [{ i: 0, text: '正文' }] });
  check('模型输出异常返回 502', res.statusCode === 502 && JSON.parse(res.body).error === 'bad-model-output');
}

// 7. 没有 LLM → 503
{
  const handler = __test.createHandler({ get: () => undefined });
  const res = await callHandler(handler, { blocks: [{ i: 0, text: '正文' }] });
  check('没有 LLM 返回 503', res.statusCode === 503 && JSON.parse(res.body).error === 'llm-unavailable');
}


// 8. 翻译接口
{
  const translatePrompt = __test.buildTranslatePrompt({ targetLang: 'en', blocks: [{ i: 0, text: '你好' }] });
  check('翻译 prompt 指定目标语言', translatePrompt.includes('English') && translatePrompt.includes('[#0]'), translatePrompt.slice(0, 120));
  const normalized = __test.normalizeTranslation(
    { blocks: [{ i: 0, text: 'Hello' }, { i: 9, text: '越界' }, { i: 0, text: '' }] },
    new Set([0])
  );
  check('翻译结果只保留合法编号', normalized.blocks.length === 1 && normalized.blocks[0].text === 'Hello', JSON.stringify(normalized));
  const translateLlm = makeLlm(JSON.stringify({ blocks: [{ i: 0, text: 'Hello' }] }));
  const translateHandler = __test.createTranslateHandler(makeCtx(translateLlm));
  const translateRes = await callHandler(translateHandler, { targetLang: 'en', blocks: [{ i: 0, text: '你好' }] });
  const translatePayload = JSON.parse(translateRes.body);
  check('翻译 handler 返回 200', translateRes.statusCode === 200, translateRes.body);
  check('翻译输出可渲染', translatePayload.ok === true && translatePayload.blocks.length === 1 && translatePayload.blocks[0].text === 'Hello');
  check('翻译 token 上限', translateLlm.calls[0].maxTokens === 3600);
  check('翻译 prompt 使用目标语言', String(translateLlm.calls[0].messages[0].content[0].text).includes('English'));
}

if (failures) {
  console.log('\nFAIL ' + failures + ' host case(s)');
  process.exit(1);
}
console.log('\nPASS Host 语义提炼 7 组用例');
