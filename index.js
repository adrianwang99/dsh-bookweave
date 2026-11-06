/**
 * 书脉 BookWeave 的 Host 半：AI 语义提炼接口（省 token 版）。
 *
 * 客户端把「一章的压缩摘录（带段落编号）」POST 到 /api/dsh-bookweave/analyze，
 * 这里只调用一次当前默认模型，并把输出收敛成带合法段落编号的结构。
 *
 * 省 token 的设计：
 * - 输入上限 8k 字符（客户端先压缩，这里再兜底截断）；
 * - 输出上限 700 tokens，强制短 JSON；
 * - reasoningEffort 取模型支持的最低档（off → low → …），不做多轮/重试；
 * - 结果由客户端按「书 + 章 + 内容指纹」缓存，重复打开不再消耗；
 * - 只有用户点「AI 提炼本章」才会走到这里，绝不在打开书时自动分析。
 */

const ROUTE_PATH = '/api/dsh-bookweave/analyze';
const TRANSLATE_ROUTE_PATH = '/api/dsh-bookweave/translate';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PROMPT_CHARS = 8000;
const MAX_OUTPUT_TOKENS = 700;
const REQUEST_TIMEOUT_MS = 90000;
const MAX_TRANSLATE_CHARS = 8000;
const MAX_TRANSLATE_TOKENS = 3600;

const TARGET_LANGUAGES = {
  zh: 'Simplified Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
};

const RELATIONS = new Set(['reason', 'example', 'data', 'authority', 'contrast', 'definition']);

const SYSTEM_PROMPT = [
  '你是「书脉」的阅读结构分析助手。',
  '只输出一个 JSON 对象，不要 Markdown 围栏、不要解释、不要前后缀。',
  'JSON 必须能被 JSON.parse 直接解析。',
  '所有 block 字段必须是用户给出的段落编号，禁止编造。',
  '文字要短：概括不超过 120 字，每条不超过 60 字。',
].join('\n');

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
  } catch (error) {
    /* 头部已发送时忽略 */
  }
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body-too-large'));
        if (typeof req.destroy === 'function') req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clip(value, limit) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

function blockNumber(value, allowed) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number)) return null;
  return allowed.has(number) ? number : null;
}

/** 把模型输出收敛成客户端可渲染、且每个节点都有合法段落编号的结构。 */
function normalizeInsight(raw, allowed) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = raw.mode === 'fiction' ? 'fiction' : raw.mode === 'nonfiction' ? 'nonfiction' : null;
  if (!mode) return null;
  const summary = clip(raw.summary, 400);
  if (mode === 'fiction') {
    const beats = (Array.isArray(raw.beats) ? raw.beats : [])
      .map((item) => {
        const block = blockNumber(item && item.block, allowed);
        const text = clip(item && item.text, 100);
        return block === null || !text ? null : { text, block };
      })
      .filter(Boolean)
      .slice(0, 6);
    if (!summary && !beats.length) return null;
    return { mode, summary: summary, beats };
  }
  const claims = (Array.isArray(raw.claims) ? raw.claims : [])
    .map((claim) => {
      const block = blockNumber(claim && claim.block, allowed);
      const text = clip(claim && claim.text, 100);
      if (block === null || !text) return null;
      const evidence = (Array.isArray(claim.evidence) ? claim.evidence : [])
        .map((item) => {
          const evidenceBlock = blockNumber(item && item.block, allowed);
          const evidenceText = clip(item && item.text, 120);
          if (evidenceBlock === null || !evidenceText) return null;
          const relation = item && RELATIONS.has(item.relation) ? item.relation : '';
          const link = clip(item && item.link, 24);
          return { text: evidenceText, block: evidenceBlock, relation, link };
        })
        .filter(Boolean)
        .slice(0, 2);
      return { text, block, evidence };
    })
    .filter(Boolean)
    .slice(0, 5);
  if (!claims.length && !summary) return null;
  return { mode, summary: summary, claims };
}

function buildPrompt(input) {
  const lines = input.blocks.map((block) => '[#' + block.i + '] ' + block.text);
  return [
    '书籍：《' + input.bookTitle + '》' + (input.author ? '（' + input.author + '）' : ''),
    '章节：' + (input.chapterTitle || '未命名章节'),
    input.truncated ? '说明：下面只是本章节选（原文过长），请基于节选概括。' : '',
    '下面是本章按段落编号的原文（编号用于回指，不要修改或编造编号）：',
    lines.join('\n'),
    '',
    '任务：',
    '1. 判断本章是叙事类（小说/传记/故事）还是论述类（非虚构/学术/方法）。',
    '2. 叙事类：用与原书一致的叙述人称、时态和语感（保留原文用词，不要评论口吻）写 2–4 句情节概括；给出 3–5 个情节节点，每个一句话并标注段落编号。',
    '3. 论述类：先用 2–3 句概括本章在讲什么（summary），再提炼 3–5 个核心观点，每个观点 1–2 条论据，都必须标注段落编号；论据尽量用原文里的例子、事实或数据。',
    '   每条论据必须带 relation 字段，取值只能是 reason（原因/因为）、example（例子/例如）、data（数据/统计）、authority（研究/权威）、contrast（反例/对比）、definition（定义/解释）之一；可用 link 给一个不超过 12 字的连接词（如“因为”“例如”“数据显示”）。',
    '只输出二选一的严格 JSON：',
    '{"mode":"fiction","summary":"…","beats":[{"text":"…","block":12}]}',
    '{"mode":"nonfiction","summary":"…","claims":[{"text":"…","block":3,"evidence":[{"text":"…","block":5,"relation":"reason","link":"因为"}]}]}',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function lowestEffort(modelInfo) {
  const efforts = (modelInfo && modelInfo.reasoning && modelInfo.reasoning.efforts) || [];
  if (!efforts.length) return undefined;
  const order = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh'];
  let best = efforts[0];
  let bestRank = order.indexOf(String(best.id).toLowerCase());
  if (bestRank < 0) bestRank = order.length;
  for (const effort of efforts) {
    const rank = order.indexOf(String(effort.id).toLowerCase());
    if (rank >= 0 && rank < bestRank) {
      best = effort;
      bestRank = rank;
    }
  }
  return best && best.id;
}

function envModelOverride() {
  const raw = typeof process !== 'undefined' && process.env ? process.env.DSH_BOOKWEAVE_MODEL : '';
  if (!raw) return null;
  const index = String(raw).indexOf('/');
  if (index <= 0) return null;
  return { provider: String(raw).slice(0, index), model: String(raw).slice(index + 1) };
}

async function resolveTarget(ctx, llm) {
  let provider = '';
  let model = '';
  const override = envModelOverride();
  if (override) {
    provider = override.provider;
    model = override.model;
  }
  if (!provider || !model) {
    try {
      const selection = ctx.get && ctx.get('agentDefaultModel');
      const current = selection && typeof selection.currentSelection === 'function' ? selection.currentSelection() : null;
      if (current && current.provider && current.model) {
        provider = String(current.provider);
        model = String(current.model);
      }
    } catch (error) {
      /* 回退到第一个可用 provider */
    }
  }
  if (!provider || !model) {
    try {
      const providers = llm.listProviders();
      for (const candidate of providers) {
        try {
          const models = await llm.listModels(candidate.id);
          if (models && models.length) {
            provider = candidate.id;
            model = models[0].id;
            break;
          }
        } catch (error) {
          /* 试下一个 */
        }
      }
    } catch (error) {
      /* 没有可用 provider */
    }
  }
  if (!provider || !model) return null;
  let effort;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    effort = lowestEffort(info);
  } catch (error) {
    effort = undefined;
  }
  return { provider, model, reasoningEffort: effort };
}

function createHandler(ctx) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      if (req.headers['x-dsh-bookweave'] !== '1') {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req, MAX_BODY_BYTES));
      } catch (error) {
        sendJson(res, error && error.message === 'body-too-large' ? 413 : 400, { error: 'bad-body' });
        return;
      }

      const blocks = [];
      const allowed = new Set();
      let totalChars = 0;
      let truncated = false;
      for (const item of Array.isArray(payload && payload.blocks) ? payload.blocks : []) {
        const index = Number(item && item.i);
        const text = typeof (item && item.text) === 'string' ? item.text : '';
        if (!Number.isInteger(index) || !text) continue;
        if (totalChars + text.length > MAX_PROMPT_CHARS) {
          truncated = true;
          break;
        }
        blocks.push({ i: index, text });
        allowed.add(index);
        totalChars += text.length;
      }
      if (!blocks.length) {
        sendJson(res, 400, { error: 'no-blocks' });
        return;
      }

      const llm = ctx.get && ctx.get('llm');
      if (!llm || typeof llm.stream !== 'function') {
        sendJson(res, 503, { error: 'llm-unavailable' });
        return;
      }
      const target = await resolveTarget(ctx, llm);
      if (!target) {
        sendJson(res, 503, { error: 'no-model' });
        return;
      }

      const prompt = buildPrompt({
        bookTitle: clip(payload.bookTitle, 120) || '未命名书籍',
        author: clip(payload.author, 80),
        chapterTitle: clip(payload.chapterTitle, 160),
        truncated,
        blocks,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let text = '';
      let usage = null;
      try {
        const options = {
          provider: target.provider,
          model: target.model,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          temperature: 0.3,
          maxTokens: MAX_OUTPUT_TOKENS,
          signal: controller.signal,
        };
        if (target.reasoningEffort) options.reasoningEffort = target.reasoningEffort;
        for await (const chunk of llm.stream(options)) {
          if (!chunk) continue;
          if (chunk.type === 'text-delta') text += chunk.text || '';
          else if (chunk.type === 'usage') usage = chunk.usage;
          else if (chunk.type === 'finish') {
            const kind = chunk.reason && chunk.reason.kind;
            if (kind === 'error' || kind === 'aborted') {
              const code = chunk.reason && chunk.reason.failure && chunk.reason.failure.code;
              throw new Error(kind === 'aborted' ? 'model-aborted' : 'model-failed:' + (code || 'error'));
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }

      const insight = normalizeInsight(parseJsonLoose(text), allowed);
      if (!insight) {
        sendJson(res, 502, { error: 'bad-model-output', raw: clip(text, 400) });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        mode: insight.mode,
        summary: insight.summary || '',
        beats: insight.beats || [],
        claims: insight.claims || [],
        provider: target.provider,
        model: target.model,
        usage,
        truncated,
        inputChars: totalChars,
      });
    } catch (error) {
      const message = String((error && error.message) || error || 'analyze-failed');
      const status = message === 'body-too-large' ? 413 : message === 'model-aborted' ? 504 : 500;
      sendJson(res, status, { error: 'analyze-failed', message });
    }
  };
}

function buildTranslatePrompt(input) {
  const target = TARGET_LANGUAGES[input.targetLang] || TARGET_LANGUAGES.en;
  return [
    '把下面按编号的原文翻译成' + target + '。',
    '逐段翻译，编号一致，不合并段落；保留数字、注释编号和专有名词。',
    '只输出 JSON：{"blocks":[{"i":0,"text":"译文"}]}',
    '',
    '原文：',
    input.blocks.map((block) => '[#' + block.i + '] ' + block.text).join('\n'),
  ].join('\n');
}

function normalizeTranslation(raw, allowed) {
  if (!raw || !Array.isArray(raw.blocks)) return null;
  const blocks = raw.blocks
    .map((item) => {
      const index = Number(item && item.i);
      const text = clip(item && item.text, 2000);
      if (!Number.isInteger(index) || !allowed.has(index) || !text) return null;
      return { i: index, text };
    })
    .filter(Boolean);
  if (!blocks.length) return null;
  return { blocks };
}

function createTranslateHandler(ctx) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      if (req.headers['x-dsh-bookweave'] !== '1') {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req, MAX_BODY_BYTES));
      } catch (error) {
        sendJson(res, 400, { error: 'bad-body' });
        return;
      }
      const targetLang = TARGET_LANGUAGES[payload && payload.targetLang] ? payload.targetLang : 'en';
      const blocks = [];
      const allowed = new Set();
      let totalChars = 0;
      for (const item of Array.isArray(payload && payload.blocks) ? payload.blocks : []) {
        const index = Number(item && item.i);
        const text = typeof (item && item.text) === 'string' ? item.text : '';
        if (!Number.isInteger(index) || !text.trim()) continue;
        if (totalChars + text.length > MAX_TRANSLATE_CHARS) break;
        blocks.push({ i: index, text });
        allowed.add(index);
        totalChars += text.length;
      }
      if (!blocks.length) {
        sendJson(res, 400, { error: 'no-blocks' });
        return;
      }
      const llm = ctx.get && ctx.get('llm');
      if (!llm || typeof llm.stream !== 'function') {
        sendJson(res, 503, { error: 'llm-unavailable' });
        return;
      }
      const target = await resolveTarget(ctx, llm);
      if (!target) {
        sendJson(res, 503, { error: 'no-model' });
        return;
      }
      const prompt = buildTranslatePrompt({ targetLang, blocks });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let text = '';
      let usage = null;
      try {
        const options = {
          provider: target.provider,
          model: target.model,
          system: '你是专业书籍翻译。只输出严格 JSON，不要 Markdown 围栏，不要解释。',
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          temperature: 0.2,
          maxTokens: MAX_TRANSLATE_TOKENS,
          signal: controller.signal,
        };
        if (target.reasoningEffort) options.reasoningEffort = target.reasoningEffort;
        for await (const chunk of llm.stream(options)) {
          if (!chunk) continue;
          if (chunk.type === 'text-delta') text += chunk.text || '';
          else if (chunk.type === 'usage') usage = chunk.usage;
          else if (chunk.type === 'finish') {
            const kind = chunk.reason && chunk.reason.kind;
            if (kind === 'error' || kind === 'aborted') {
              const code = chunk.reason && chunk.reason.failure && chunk.reason.failure.code;
              throw new Error(kind === 'aborted' ? 'model-aborted' : 'model-failed:' + (code || 'error'));
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }
      const parsed = normalizeTranslation(parseJsonLoose(text), allowed);
      if (!parsed) {
        sendJson(res, 502, { error: 'bad-model-output', raw: clip(text, 400) });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        blocks: parsed.blocks,
        targetLang,
        provider: target.provider,
        model: target.model,
        usage,
        inputChars: totalChars,
      });
    } catch (error) {
      const message = String((error && error.message) || error || 'translate-failed');
      const status = message === 'body-too-large' ? 413 : message === 'model-aborted' ? 504 : 500;
      sendJson(res, status, { error: 'translate-failed', message });
    }
  };
}

export function apply(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return;
  ctx.inject(['webServer'], (scoped) => {
    if (!scoped.webServer || typeof scoped.webServer.register !== 'function') return;
    scoped.effect(
      () => scoped.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: createHandler(ctx) }),
      'dsh-bookweave: analyze route'
    );
    scoped.effect(
      () => scoped.webServer.register({ kind: 'exact', path: TRANSLATE_ROUTE_PATH, handler: createTranslateHandler(ctx) }),
      'dsh-bookweave: translate route'
    );
  });
}

// 测试接缝（Host 测试直接调用，不影响插件运行）
export const __test = {
  buildPrompt,
  normalizeInsight,
  parseJsonLoose,
  lowestEffort,
  createHandler,
  ROUTE_PATH,
  TRANSLATE_ROUTE_PATH,
  buildTranslatePrompt,
  normalizeTranslation,
  createTranslateHandler,
  MAX_PROMPT_CHARS,
  MAX_OUTPUT_TOKENS,
};
