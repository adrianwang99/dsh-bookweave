/**
 * 书籍结构提取回归测试：核心观点 / 论据是否完整、并且每个节点都能定位到正文。
 *
 * 运行：node dsh-bookweave/test/structure.mjs
 * 只依赖 Node 标准库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client', 'client.js');
const fixtures = ['zh-basic.epub', 'gbk-encoded.epub', 'no-toc.epub', 'stored-entries.epub', 'percent-href.epub'];

const captured = [];
globalThis.window = { __ModuleLoader__: { load: (mod) => captured.push(mod) } };
await import(clientPath);
const reactStub = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
  Fragment: 'Fragment',
  createContext: () => ({}),
};
const core = captured[0].factory((name) => {
  if (name === 'react') return reactStub;
  throw new Error('unexpected require: ' + name);
}).core;

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('ok   ' + name);
  } else {
    failures++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

for (const name of fixtures) {
  const book = await core.parseEpub(new Uint8Array(fs.readFileSync(path.join(here, 'fixtures', name))));
  const structure = core.buildStructure(book);
  const chapters = structure.chapters;
  let claims = 0;
  let evidence = 0;
  let positionsValid = true;
  for (const chapter of chapters) {
    const blocks = (book.chapters[chapter.index] || {}).blocks || [];
    claims += chapter.claims.length;
    check(name + ' 第 ' + (chapter.index + 1) + ' 章至少一个观点', chapter.claims.length >= 1, 'claims=' + chapter.claims.length);
    for (const claim of chapter.claims) {
      if (!claim.text || claim.text.length < 2) positionsValid = false;
      if (!(claim.blockIndex >= 0 && claim.blockIndex < Math.max(1, blocks.length))) positionsValid = false;
      evidence += claim.evidence.length;
      for (const item of claim.evidence) {
        if (!item.text || item.text.length < 2) positionsValid = false;
        if (!(item.blockIndex >= 0 && item.blockIndex < Math.max(1, blocks.length))) positionsValid = false;
      }
    }
  }
  check(name + ' 观点与论据都带合法正文位置', positionsValid);
  check(name + ' 统计一致', structure.totals.chapters === chapters.length && structure.totals.claims === claims && structure.totals.evidence === evidence,
    JSON.stringify({ totals: structure.totals, claims, evidence }));
}

// AI 输入压缩：长章节必须被压到预算内，且段落编号保持合法
{
  const book = await core.parseEpub(new Uint8Array(fs.readFileSync(path.join(here, 'fixtures', 'zh-basic.epub'))));
  const chapter = book.chapters[0];
  const longChapter = { blocks: Array.from({ length: 12 }, (_, index) => ({ type: 'p', text: '段落' + index + '：' + '内容'.repeat(120) })) };
  const full = core.buildAiBlocks(chapter, { budget: 100000 });
  const small = core.buildAiBlocks(longChapter, { budget: 1200 });
  const blocks = chapter.blocks || [];
  const validIndex = (item) => item.i >= 0 && item.i < blocks.length;
  const validSmallIndex = (item) => item.i >= 0 && item.i < longChapter.blocks.length;
  check('AI 预算充足时发送全文', full.truncated === false && full.blocks.length === blocks.length, JSON.stringify({ blocks: full.blocks.length, total: blocks.length }));
  check('AI 预算紧张时压缩到预算内', small.chars <= 1200 && small.blocks.length > 0 && small.truncated === true, JSON.stringify({ chars: small.chars, blocks: small.blocks.length }));
  check('AI 压缩后的段落编号仍然合法', small.blocks.every(validSmallIndex) && full.blocks.every(validIndex));
}

// 真实书冒烟（存在才跑，不校验具体数字）
const realBook = process.env.BOOKWEAVE_SMOKE_ZH || '';
if (realBook && fs.existsSync(realBook)) {
  const book = await core.parseEpub(new Uint8Array(fs.readFileSync(realBook)));
  const started = Date.now();
  const structure = core.buildStructure(book);
  const elapsed = Date.now() - started;
  check('真实书：结构提取 < 2s', elapsed < 2000, elapsed + 'ms');
  check('真实书：章节视角与观点数合理', structure.totals.chapters > 10 && structure.totals.claims > 10, JSON.stringify(structure.totals));
  const sample = structure.chapters[1] && structure.chapters[1].claims[0];
  check('真实书：观点可定位正文', Boolean(sample && sample.blockIndex >= 0 && sample.text.length > 2), JSON.stringify(sample));
}

if (failures) {
  console.log('\nFAIL ' + failures + ' structure case(s)');
  process.exit(1);
}
console.log('\nPASS 书籍结构 5/5 夹具 + 真实书冒烟');
