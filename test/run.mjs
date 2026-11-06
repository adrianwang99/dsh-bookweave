#!/usr/bin/env node
/**
 * BookWeave（书脉）— verification harness for the pure plugin core.
 *
 * Loads `client/client.js` the same way the DSH Web client does — through a
 * `window.__ModuleLoader__` stub — and exercises the `plugin.core` seam in Node
 * (no DOM, no React, no browser). See test/README.md for the full contract.
 *
 * Assertion groups:
 *   1. module seam: one registration (`dsh-bookweave`), `{ inject, core, apply }`,
 *      and a core that exposes the documented pure functions
 *   2. every fixture in test/fixtures/expected.json: parse succeeds, meta,
 *      chapter count, and the exact 《》 book counts (missing, extra and
 *      miscounted titles all fail)
 *   3. zh-basic invariants: 人民日报 / 测试之书 excluded, 〈原道〉 not extracted,
 *      exactly one 红楼梦↔百年孤独 edge with weight 1, all mentions high
 *      confidence, every book has a context snippet containing its title
 *   4. chapter-title / TOC getters (no-toc.epub falls back to <h1>)
 *   5. markdown export through core.toMarkdown
 *   6. invalid-input robustness: random bytes, empty input, truncated EPUB and a
 *      valid ZIP without META-INF/container.xml
 *   7. smoke test of the two real EPUBs listed in REAL.md (skipped if missing)
 *
 * Exit code is 0 iff every assertion passes. Runnable from any working
 * directory (all paths are resolved relative to this file):
 *
 *   node dsh-bookweave/test/run.mjs
 *
 * Only Node stdlib is used — no npm installs, no fixture generation.
 */

import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Paths, budgets and frozen ground truth
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const FIXTURES_DIR = path.join(HERE, 'fixtures');
const EXPECTED_JSON = path.join(FIXTURES_DIR, 'expected.json');
const CLIENT_JS = path.join(PLUGIN_ROOT, 'client', 'client.js');

const SEAM_MODULE_ID = 'dsh-bookweave';

/**
 * Generous per-step budgets. The whole suite normally runs in ~1–2 s; these
 * limits exist to turn a regression into a failure instead of a hang. A
 * synchronous infinite loop cannot be interrupted from the same thread — run
 * the harness under a shell/CI timeout as a backstop (see README).
 */
const LIMITS = Object.freeze({
  fixtureParseMs: 10_000,
  fixtureExtractMs: 5_000,
  negativeMs: 5_000,
  realParseMs: 20_000,
  realExtractMs: 10_000,
  watchdogMs: 40_000,
});

/**
 * Chapter titles documented in test/fixtures/EXPECTED.md §3–§7 (the <h1> text
 * of each chapter document; identical to the TOC labels for the four fixtures
 * that ship a TOC). Pinned so a regression in the TOC/heading getters is caught.
 */
const DOCUMENTED_CHAPTER_TITLES = Object.freeze({
  'zh-basic.epub': Object.freeze(['第一章 旧书架', '第二章 灯下对读', '第三章 读书会', '第四章 注疏与闲读', '第五章 自述']),
  'gbk-encoded.epub': Object.freeze(['第一章 灯下读经', '第二章 抄书']),
  'no-toc.epub': Object.freeze(['第一章 开篇', '第二章 夜读']),
  'stored-entries.epub': Object.freeze(['第一章 床头', '第二章 页边']),
  'percent-href.epub': Object.freeze(['第一章 车上', '第二章 雨天', '第三章 多年以后']),
});

/**
 * The two real-world EPUBs referenced by REAL.md. They live outside this
 * repository and are read-only smoke references: no exact counts are asserted
 * on them, and the group is skipped gracefully when a file is absent.
 */
const REAL_BOOKS = Object.freeze([
  Object.freeze({
    label: 'real-zh',
    description: '人生进阶指南 — Chinese, 83 spine documents, 《》 self-references',
    path: process.env.BOOKWEAVE_SMOKE_ZH || '',
    forbidMarkSources: false,
  }),
  Object.freeze({
    label: 'real-en',
    description: 'The Penguin Jazz Guide — English negative control, zero 《》 marks',
    path: process.env.BOOKWEAVE_SMOKE_EN || '',
    forbidMarkSources: true,
  }),
]);

/** Minimal React stand-in: importing the client must not pull in real React. */
const REACT_STUB = Object.freeze({
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useRef: () => ({}),
  Fragment: 'Fragment',
  createContext: () => ({}),
});

const HARNESS_STARTED_AT = performance.now();

// ---------------------------------------------------------------------------
// Tiny sequential runner (TAP-flavoured output, no dependencies)
// ---------------------------------------------------------------------------

const results = { passed: 0, failed: 0, skipped: 0, total: 0 };
const failures = [];

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.max(1, Math.round(ms))}ms`;
}

async function test(name, fn) {
  const id = ++results.total;
  const started = performance.now();
  try {
    await fn();
    results.passed++;
    console.log(`ok ${id} - ${name} (${fmtMs(performance.now() - started)})`);
  } catch (error) {
    results.failed++;
    failures.push({ id, name, error });
    console.log(`not ok ${id} - ${name} (${fmtMs(performance.now() - started)})`);
    const detail = error && error.stack ? error.stack : String(error);
    for (const line of String(detail).split('\n').slice(0, 10)) console.log(`  ${line}`);
  }
}

function skip(name, reason) {
  const id = ++results.total;
  results.skipped++;
  console.log(`ok ${id} - ${name} # SKIP ${reason}`);
}

// ---------------------------------------------------------------------------
// Timing / error helpers
// ---------------------------------------------------------------------------

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Run `fn` and reject with a TimeoutError if it has not settled within `ms`.
 * This catches pending promises (e.g. a stalled DecompressionStream); a purely
 * synchronous infinite loop would block the thread and needs an external
 * timeout, which the README documents.
 */
async function runWithin(label, ms, fn) {
  const started = performance.now();
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label}: still pending after ${ms}ms (hang guard)`)), ms);
      }),
    ]);
    return { value, elapsed: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Assert that `fn` throws, and that it does so without hanging. */
async function expectThrow(label, fn, ms) {
  const started = performance.now();
  try {
    await runWithin(label, ms, fn);
  } catch (error) {
    if (error instanceof TimeoutError) throw error;
    return { error, elapsed: performance.now() - started };
  }
  assert.fail(`${label}: expected parseEpub to throw for invalid input, but it resolved successfully`);
}

/** The core's user-facing errors are Chinese strings (see client.js). */
function assertChineseError(label, error) {
  assert.ok(
    error instanceof Error,
    `${label}: thrown value must be an Error instance (got ${Object.prototype.toString.call(error)})`,
  );
  assert.equal(typeof error.message, 'string', `${label}: Error.message must be a string`);
  assert.ok(error.message.trim().length > 0, `${label}: Error must carry a message`);
  assert.match(
    error.message,
    /[\u3400-\u4DBF\u4E00-\u9FFF]/,
    `${label}: message must be Chinese (user-facing), got ${JSON.stringify(error.message)}`,
  );
}

async function fileExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + needle.length;
  }
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer — used only for the "valid ZIP, no container.xml" case
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a small, genuinely valid ZIP archive with all entries stored
 * (compression method 0). Only used to prove that a ZIP which merely lacks
 * `META-INF/container.xml` is rejected as an EPUB, not as a broken ZIP.
 */
function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method: stored
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return new Uint8Array(Buffer.concat([...localParts, centralDirectory, eocd]));
}

// ---------------------------------------------------------------------------
// Module loader stub — exactly how the DSH Web client hosts this plugin
// ---------------------------------------------------------------------------

async function loadCore() {
  const captured = [];
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (module) => captured.push(module) } };
  try {
    await import(pathToFileURL(CLIENT_JS).href);
  } finally {
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
  }

  assert.equal(captured.length, 1, 'client.js must call window.__ModuleLoader__.load exactly once (got ' + captured.length + ')');
  const registration = captured[0];
  assert.equal(typeof registration, 'object', 'the registration must be an object');
  assert.equal(registration.id, SEAM_MODULE_ID, `the loader module id must be ${SEAM_MODULE_ID}`);
  assert.equal(typeof registration.factory, 'function', 'the registration must expose factory(require)');

  const requireStub = (name) => {
    if (name === 'react') return REACT_STUB;
    throw new Error(`client.js factory() required an unexpected module: ${name}`);
  };
  const plugin = registration.factory(requireStub);
  assert.equal(typeof plugin, 'object', 'factory(require) must return the plugin object');
  return { plugin, registration };
}

// ---------------------------------------------------------------------------
// Fixture loading (shared by the per-fixture assertion groups)
// ---------------------------------------------------------------------------

let core = null;
const fixtures = new Map();

async function loadFixture(name, contract) {
  const record = {
    name,
    contract,
    bytes: null,
    book: null,
    mentions: null,
    parseMs: 0,
    extractMs: 0,
    error: null,
  };
  try {
    record.bytes = await readFile(path.join(FIXTURES_DIR, name));
    const parsed = await runWithin(`parseEpub(${name})`, LIMITS.fixtureParseMs, () => core.parseEpub(record.bytes));
    record.book = parsed.value;
    record.parseMs = parsed.elapsed;
    const extracted = await runWithin(`extractMentions(${name})`, LIMITS.fixtureExtractMs, () =>
      core.extractMentions(record.book),
    );
    record.mentions = extracted.value;
    record.extractMs = extracted.elapsed;
  } catch (error) {
    record.error = error;
  }
  fixtures.set(name, record);
  return record;
}

function fixtureOrThrow(name) {
  const record = fixtures.get(name);
  if (!record) throw new Error(`harness bug: fixture ${name} was never loaded`);
  if (record.error) throw record.error;
  return record;
}

// ---------------------------------------------------------------------------
// 1. Contract file
// ---------------------------------------------------------------------------

async function registerContractTests(coreApi) {
  await test('contract: expected.json is well-formed and every listed fixture exists', async () => {
    const expected = await readExpectedJson();
    const names = Object.keys(expected);
    assert.ok(names.length > 0, 'expected.json must list at least one fixture');
    const onDisk = (await readdir(FIXTURES_DIR)).filter((file) => file.toLowerCase().endsWith('.epub')).sort();
    for (const name of names) {
      const contract = expected[name];
      assert.equal(typeof contract, 'object', `${name}: contract must be an object`);
      assert.ok(Number.isInteger(contract.chapters) && contract.chapters > 0, `${name}: chapters must be a positive integer`);
      assert.equal(typeof contract.title, 'string', `${name}: title must be a string`);
      assert.ok(contract.title.length > 0, `${name}: title must not be empty`);
      assert.equal(typeof contract.author, 'string', `${name}: author must be a string`);
      assert.ok(contract.author.length > 0, `${name}: author must not be empty`);
      assert.equal(typeof contract.expectedBooks, 'object', `${name}: expectedBooks must be an object`);
      assert.ok(!Array.isArray(contract.expectedBooks), `${name}: expectedBooks must be a title→count map`);
      const titles = Object.keys(contract.expectedBooks);
      assert.ok(titles.length > 0, `${name}: expectedBooks must not be empty`);
      for (const title of titles) {
        const count = contract.expectedBooks[title];
        assert.ok(Number.isInteger(count) && count > 0, `${name}: expectedBooks["${title}"] must be a positive integer`);
      }
      assert.equal(await fileExists(path.join(FIXTURES_DIR, name)), true, `${name}: fixture file is missing from test/fixtures/`);
    }
    const unlisted = onDisk.filter((file) => !names.includes(file));
    if (unlisted.length) console.log(`# note: fixture files not covered by expected.json (not asserted): ${unlisted.join(', ')}`);
  });

  await test('contract: core exposed by client.js has the documented pure API', () => {
    assert.equal(typeof coreApi, 'object', 'plugin.core must be an object');
    for (const fn of ['openZip', 'parseEpub', 'extractMentions', 'toMarkdown']) {
      assert.equal(typeof coreApi[fn], 'function', `plugin.core.${fn} must be a function`);
    }
    assert.equal(typeof coreApi.version, 'number', 'plugin.core.version must be a number');
  });
}

async function readExpectedJson() {
  const raw = await readFile(EXPECTED_JSON, 'utf8');
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// 2–5. Per-fixture assertions (expected.json contract + getters + markdown)
// ---------------------------------------------------------------------------

async function registerFixtureTests(name, contract) {
  await test(`fixture ${name}: parse shape (version, chapters, stats, blocks)`, () => {
    const { book } = fixtureOrThrow(name);
    assert.equal(typeof book.version, 'number', 'parseEpub result must carry a version');
    assert.ok(Array.isArray(book.chapters), 'book.chapters must be an array');
    assert.equal(book.chapters.length, contract.chapters, 'chapter count must match expected.json');
    assert.ok(Array.isArray(book.toc), 'book.toc must be an array');
    assert.equal(typeof book.stats, 'object', 'book.stats must be an object');
    assert.equal(book.stats.chapters, book.chapters.length, 'stats.chapters must equal chapters.length');

    let blocks = 0;
    let chars = 0;
    book.chapters.forEach((chapter, index) => {
      assert.equal(chapter.index, index, 'chapter.index must be its reading-order position');
      assert.equal(typeof chapter.path, 'string', `chapter ${index}: path must be a string`);
      assert.ok(chapter.path.length > 0, `chapter ${index}: path must be the resolved archive entry`);
      assert.ok(Array.isArray(chapter.blocks) && chapter.blocks.length > 0, `chapter ${index} has no text blocks`);
      for (const block of chapter.blocks) {
        assert.equal(typeof block.type, 'string', `chapter ${index}: block.type must be a string`);
        assert.equal(typeof block.text, 'string', `chapter ${index}: block.text must be a string`);
        assert.ok(block.text.length > 0, `chapter ${index}: block.text must not be empty`);
        blocks++;
        chars += block.text.length;
      }
    });
    assert.equal(book.stats.blocks, blocks, 'stats.blocks must equal the total block count');
    assert.equal(book.stats.chars, chars, 'stats.chars must equal the total text length');
  });

  await test(`fixture ${name}: meta title/author match expected.json`, () => {
    const { book, mentions } = fixtureOrThrow(name);
    assert.equal(book.meta.title, contract.title, 'meta.title must match expected.json');
    assert.equal(book.meta.author, contract.author, 'meta.author must match expected.json');
    assert.equal(mentions.self.title, contract.title, 'extraction must carry the book identity');
    assert.equal(mentions.self.author, contract.author, 'extraction must carry the book author');
  });

  await test(`fixture ${name}: exact book counts — missing, extra or miscounted titles all fail`, () => {
    const { mentions } = fixtureOrThrow(name);
    assert.ok(Array.isArray(mentions.books), 'mentions.books must be an array');
    assert.ok(Array.isArray(mentions.edges), 'mentions.edges must be an array');

    const titles = mentions.books.map((item) => item.title);
    assert.equal(new Set(titles).size, titles.length, 'each extracted title must appear at most once');
    const counts = {};
    for (const item of mentions.books) {
      assert.equal(typeof item.title, 'string', 'book.title must be a string');
      assert.ok(item.title.length > 0, 'book.title must not be empty');
      counts[item.title] = item.count;
    }

    const expectedTitles = Object.keys(contract.expectedBooks);
    const missing = expectedTitles.filter((title) => !(title in counts));
    const extra = titles.filter((title) => !expectedTitles.includes(title));
    assert.deepEqual(missing, [], `missing expected title(s): ${missing.join('、') || '(none)'}`);
    assert.deepEqual(extra, [], `unexpected extra title(s) (fail on extra too): ${extra.join('、') || '(none)'}`);
    assert.deepEqual(counts, contract.expectedBooks, 'occurrence counts must match expected.json exactly');
  });

  await test(`fixture ${name}: mention bookkeeping is internally consistent`, () => {
    const { mentions } = fixtureOrThrow(name);
    // Pin only that a schema version exists — the client may evolve it (1 → 2 → …).
    assert.equal(typeof mentions.version, 'number', 'extractMentions result must carry a numeric schema version');
    assert.equal(typeof mentions.stats, 'object', 'mentions.stats must be an object');
    assert.equal(mentions.stats.chapters, contract.chapters, 'extraction must scan every chapter');

    let occurrences = 0;
    const bookKeys = new Set();
    for (const item of mentions.books) {
      assert.ok(item.count > 0, `${item.title}: count must be positive`);
      assert.ok(['high', 'medium', 'low'].includes(item.confidence), `${item.title}: confidence must be high/medium/low`);
      let perSource = 0;
      for (const value of Object.values(item.sources || {})) perSource += value;
      assert.equal(perSource, item.count, `${item.title}: sources must sum to count`);
      occurrences += item.count;

      assert.equal(item.chapterIndexes.length, item.chapterTitles.length, `${item.title}: chapterIndexes/chapterTitles must stay in sync`);
      assert.ok(item.chapterIndexes.length >= 1, `${item.title}: must be located in at least one chapter`);
      for (const index of item.chapterIndexes) {
        assert.ok(Number.isInteger(index) && index >= 0 && index < contract.chapters, `${item.title}: chapterIndexes out of range`);
      }
      assert.ok(Array.isArray(item.contexts) && item.contexts.length >= 1, `${item.title}: must carry at least one context snippet`);
      assert.ok(item.contexts.length <= 4, `${item.title}: contexts are capped at 4 per book`);
      for (const context of item.contexts) {
        assert.equal(typeof context.snippet, 'string', `${item.title}: context.snippet must be a string`);
        assert.ok(context.snippet.length > 0, `${item.title}: context.snippet must not be empty`);
        assert.ok(Number.isInteger(context.chapterIndex) && context.chapterIndex >= 0 && context.chapterIndex < contract.chapters, `${item.title}: context.chapterIndex out of range`);
        assert.equal(typeof context.chapterTitle, 'string', `${item.title}: context.chapterTitle must be a string`);
        assert.ok(context.chapterTitle.length > 0, `${item.title}: context.chapterTitle must not be empty`);
      }
      assert.ok(item.first && Number.isInteger(item.first.chapterIndex) && Number.isInteger(item.first.blockIndex), `${item.title}: first occurrence must be recorded`);
      assert.ok(Number.isInteger(item.first.start) && Number.isInteger(item.first.end) && item.first.end > item.first.start, `${item.title}: first offsets must be a valid range`);
      bookKeys.add(item.key);
    }
    assert.equal(mentions.stats.occurrences, occurrences, 'stats.occurrences must equal the sum of book counts');

    const assertEdgeShape = (edge, label) => {
      assert.equal(typeof edge.source, 'string', `${label}: edge.source must be a string`);
      assert.equal(typeof edge.target, 'string', `${label}: edge.target must be a string`);
      assert.notEqual(edge.source, edge.target, `${label}: an edge must connect two different books`);
      assert.ok(Number.isInteger(edge.weight) && edge.weight > 0, `${label}: edge.weight must be a positive integer`);
      assert.ok(bookKeys.has(edge.source) && bookKeys.has(edge.target), `${label}: edge endpoints must reference extracted books`);
    };
    for (const edge of mentions.edges) assertEdgeShape(edge, 'edges');
    // Newer core versions expose chapter-level weak edges. Validate them when
    // present, but do not require the field: it is not part of the fixture contract.
    if (Array.isArray(mentions.chapterEdges)) {
      for (const edge of mentions.chapterEdges) assertEdgeShape(edge, 'chapterEdges');
    }
  });

  await test(`fixture ${name}: chapter-title / TOC getters`, () => {
    const { book } = fixtureOrThrow(name);
    const titles = book.chapters.map((chapter) => chapter.title);
    for (const [index, title] of titles.entries()) {
      assert.equal(typeof title, 'string', `chapter ${index}: title must be a string`);
      assert.ok(title.trim().length > 0, `chapter ${index}: title must be non-empty`);
    }
    const documented = DOCUMENTED_CHAPTER_TITLES[name];
    assert.ok(Array.isArray(documented), `harness bug: no documented chapter titles for ${name}`);
    assert.deepEqual(titles, documented, 'chapter titles must match the headings documented in EXPECTED.md');

    if (name === 'no-toc.epub') {
      assert.equal(book.toc.length, 0, 'no-toc.epub has neither nav.xhtml nor toc.ncx, so toc must be empty');
      for (const title of titles) {
        assert.ok(!/^第 \d+ 章$/.test(title), 'no-toc chapter titles must come from <h1>, not the "第 N 章" fallback');
      }
    } else {
      assert.ok(book.toc.length > 0, `${name} ships a TOC, so the toc getter must not be empty`);
      for (const entry of book.toc) {
        assert.equal(typeof entry.label, 'string', 'TOC label must be a string');
        assert.ok(entry.label.length > 0, 'TOC label must not be empty');
        assert.ok(Number.isInteger(entry.chapterIndex) && entry.chapterIndex >= 0 && entry.chapterIndex < contract.chapters, 'TOC chapterIndex out of range');
        assert.equal(entry.label, titles[entry.chapterIndex], 'chapter titles must be taken from the TOC label');
      }
    }
  });

  await test(`fixture ${name}: toMarkdown exports '## 书单' and every extracted title`, () => {
    const { book, mentions } = fixtureOrThrow(name);
    const markdown = core.toMarkdown(book, mentions);
    assert.equal(typeof markdown, 'string', 'toMarkdown must return a string');
    assert.ok(markdown.includes('## 书单'), "markdown must contain the '## 书单' section heading");
    assert.ok(markdown.includes(`# 《${contract.title}》`), 'markdown must open with the book identity header');
    for (const item of mentions.books) {
      assert.ok(markdown.includes(item.title), `markdown must mention extracted title ${item.title}`);
    }
    assert.ok(markdown.includes(`提取到：${mentions.books.length} 本书`), 'markdown must state how many books were extracted');
  });
}

// ---------------------------------------------------------------------------
// 3. zh-basic-specific invariants (EXPECTED.md §3 and §8)
// ---------------------------------------------------------------------------

async function registerZhBasicTests() {
  const name = 'zh-basic.epub';
  // Resolve inside each test: a broken fixture load must show up as failing
  // assertions, never abort the rest of the suite.
  const zhBasic = () => fixtureOrThrow(name);
  const zhChapterText = () =>
    zhBasic()
      .book.chapters.map((chapter) => chapter.blocks.map((block) => block.text).join('\n'))
      .join('\n');

  await test('zh-basic: 《人民日报》/《测试之书》 exist in the source but are excluded', () => {
    const chapterText = zhChapterText();
    const { mentions } = zhBasic();
    assert.equal(countOccurrences(chapterText, '《人民日报》'), 2, 'EXPECTED.md pins 《人民日报》 at 2 source marks');
    assert.equal(countOccurrences(chapterText, '《测试之书》'), 1, 'EXPECTED.md pins the self-reference at 1 source mark');
    const titles = mentions.books.map((item) => item.title);
    assert.ok(!titles.includes('人民日报'), 'periodicals/newspapers must be excluded from the book list');
    assert.ok(!titles.includes('测试之书'), "the book's own title must be excluded as a self-reference");
  });

  await test('zh-basic: 〈原道〉 (U+3008/U+3009) is not extracted, its parent 《文心雕龙》 is', () => {
    const chapterText = zhChapterText();
    const { mentions } = zhBasic();
    assert.equal(countOccurrences(chapterText, '〈原道〉'), 1, 'the fixture must contain the single-angle-bracket chapter reference');
    assert.ok(!mentions.books.some((item) => item.title.includes('原道')), '〈原道〉 must never be reported as a 《》 title');
    const wenxin = mentions.books.find((item) => item.title === '文心雕龙');
    assert.ok(wenxin, '《文心雕龙》 must be extracted (marked with 《》, unlike 〈原道〉)');
    assert.equal(wenxin.count, 1, '《文心雕龙》 is expected at exactly 1 (EXPECTED.md §2)');
  });

  await test('zh-basic: exactly one co-occurrence edge 红楼梦↔百年孤独 with weight 1', () => {
    const { mentions } = zhBasic();
    assert.equal(mentions.edges.length, 1, 'exactly one paragraph mentions 红楼梦 and 百年孤独 together');
    const edge = mentions.edges[0];
    assert.deepEqual([edge.source, edge.target].slice().sort(), ['百年孤独', '红楼梦'], 'edge endpoints must be 红楼梦 and 百年孤独');
    assert.equal(edge.weight, 1, 'co-occurrence weight must be 1, not 2 (EXPECTED.md §3)');
  });

  await test("zh-basic: >=5 books, all 'high' confidence, every book has a context snippet containing its title", () => {
    const { mentions } = zhBasic();
    assert.ok(mentions.books.length >= 5, `expected at least five book titles, got ${mentions.books.length}`);
    for (const item of mentions.books) {
      assert.equal(item.confidence, 'high', `${item.title}: every zh-basic mention is 《》-marked, so confidence must be high`);
      const containing = item.contexts.filter((context) => context.snippet.includes(item.title));
      assert.ok(
        containing.length >= 1,
        `${item.title}: at least one context snippet must contain the title, got ${JSON.stringify(item.contexts.map((context) => context.snippet))}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// 6. Robustness / negative cases
// ---------------------------------------------------------------------------

async function registerRobustnessTests() {
  await test('robustness: random bytes throw a Chinese Error and settle fast (no hang)', async () => {
    const { error, elapsed } = await expectThrow('parseEpub(Buffer.from("not an epub"))', () => core.parseEpub(Buffer.from('not an epub')), LIMITS.negativeMs);
    assertChineseError('random bytes', error);
    assert.ok(elapsed < LIMITS.negativeMs, `invalid input must fail fast, settled in ${fmtMs(elapsed)}`);
  });

  await test('robustness: empty input throws a Chinese Error', async () => {
    const { error } = await expectThrow('parseEpub(new Uint8Array(0))', () => core.parseEpub(new Uint8Array(0)), LIMITS.negativeMs);
    assertChineseError('empty input', error);
  });

  await test('robustness: EPUB truncated to 60% throws instead of hanging', async () => {
    const full = fixtureOrThrow('zh-basic.epub').bytes;
    const truncated = full.subarray(0, Math.floor(full.length * 0.6));
    assert.ok(truncated.length > 32 && truncated.length < full.length, 'harness bug: truncation must cut the archive but stay above the minimum ZIP size');
    const { error, elapsed } = await expectThrow('parseEpub(zh-basic.epub[0:60%])', () => core.parseEpub(truncated), LIMITS.negativeMs);
    assertChineseError('truncated EPUB', error);
    assert.ok(elapsed < LIMITS.negativeMs, `truncated input must fail fast, settled in ${fmtMs(elapsed)}`);
  });

  await test('robustness: a valid ZIP without META-INF/container.xml throws the EPUB-specific Chinese error', async () => {
    const bytes = buildStoredZip([
      ['mimetype', 'application/epub+zip'],
      ['OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?><package><metadata><dc:title>x</dc:title></metadata></package>'],
    ]);
    // Prove the input is a structurally readable ZIP first, so the rejection is
    // about the missing EPUB container, not about a broken archive.
    const zip = core.openZip(bytes);
    assert.deepEqual(Array.from(zip.entries.keys()).sort(), ['OEBPS/content.opf', 'mimetype'], 'harness bug: synthetic ZIP must be readable');
    const { error } = await expectThrow('parseEpub(ZIP without META-INF/container.xml)', () => core.parseEpub(bytes), LIMITS.negativeMs);
    assertChineseError('ZIP without container.xml', error);
    assert.match(String(error.message), /container\.xml/, 'the error must name the missing META-INF/container.xml');
  });
}

// ---------------------------------------------------------------------------
// 7. Real-book smoke tests (REAL.md) — skipped when the files are absent
// ---------------------------------------------------------------------------

async function registerRealBookSmokeTests() {
  for (const spec of REAL_BOOKS) {
    if (!(await fileExists(spec.path))) {
      skip(`real book ${spec.label}: ${spec.description}`, `file missing: ${spec.path}`);
      continue;
    }

    await test(`real book ${spec.label}: parses <${LIMITS.realParseMs}ms, >10 chapters, extraction has arrays`, async () => {
      const bytes = await readFile(spec.path);
      const parsed = await runWithin(`parseEpub(${spec.label})`, LIMITS.realParseMs, () => core.parseEpub(bytes));
      const book = parsed.value;
      assert.ok(Array.isArray(book.chapters), 'chapters must be an array');
      assert.ok(book.chapters.length > 10, `real books must expose more than 10 chapters (got ${book.chapters.length})`);
      assert.ok(parsed.elapsed < LIMITS.realParseMs, `parse must finish within the smoke budget (${fmtMs(parsed.elapsed)})`);

      const extracted = await runWithin(`extractMentions(${spec.label})`, LIMITS.realExtractMs, () => core.extractMentions(book));
      const mentions = extracted.value;
      assert.ok(mentions && typeof mentions === 'object', 'extraction must return an object');
      assert.ok(Array.isArray(mentions.books), 'mentions.books must be an array');
      assert.ok(Array.isArray(mentions.edges), 'mentions.edges must be an array');
      assert.equal(typeof mentions.stats, 'object', 'mentions.stats must be an object');

      const markdown = core.toMarkdown(book, mentions);
      assert.equal(typeof markdown, 'string', 'toMarkdown must return a string for a real book');
      assert.ok(markdown.includes('## 书单'), "markdown must contain the '## 书单' heading");

      const markSourced = mentions.books.filter((item) => item.sources && item.sources.mark).length;
      const selfTitleReported = mentions.books.some((item) => item.title === book.meta.title);
      if (spec.forbidMarkSources) {
        // REAL.md negative control: zero 《》 marks in the source, so report nothing mark-sourced.
        assert.equal(markSourced, 0, 'REAL.md negative control: a book with zero 《》 marks must not report mark-sourced titles');
      }
      // Smoke-only: print timing and counts, but never assert exact counts on real books.
      console.log(
        `  # ${spec.label}: "${book.meta.title}" — ${book.chapters.length} chapters, ${book.stats.chars} chars | ` +
          `parse ${fmtMs(parsed.elapsed)}, extract ${fmtMs(extracted.elapsed)} | ` +
          `books ${mentions.books.length}, edges ${mentions.edges.length}, mark-sourced books ${markSourced} | self title reported: ${selfTitleReported}`,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`BookWeave core harness — Node ${process.version}`);
  console.log(`# client: ${CLIENT_JS}`);
  console.log(`# cwd: ${process.cwd()}`);
  console.log(
    `# budgets: fixture parse ${fmtMs(LIMITS.fixtureParseMs)}, negative ${fmtMs(LIMITS.negativeMs)}, ` +
      `real parse ${fmtMs(LIMITS.realParseMs)}, watchdog ${fmtMs(LIMITS.watchdogMs)}`,
  );

  const { plugin } = await loadCore();
  core = plugin.core;

  await test('seam: client.js registers the dsh-bookweave module and exposes { inject, core, apply }', () => {
    assert.ok(Array.isArray(plugin.inject), 'plugin.inject must be an array');
    assert.ok(plugin.inject.includes('slots'), "plugin.inject must request the 'slots' service");
    assert.equal(typeof plugin.apply, 'function', 'plugin.apply must be a function');
    assert.equal(typeof plugin.core, 'object', 'plugin.core must be the pure core object');
  });

  await test('thought ranges: original and translation anchors stay separate', () => {
    const fn = plugin.__test;
    assert.equal(typeof fn.thoughtRangesForBlock, 'function', 'thoughtRangesForBlock test seam');
    assert.equal(typeof fn.translationThoughtRangesForBlock, 'function', 'translation ranges test seam');
    const thoughts = [
      { id: 'orig', chapterIndex: 0, blockIndex: 0, startBlock: 0, startOffset: 2, endBlock: 0, endOffset: 6, target: 'original' },
      { id: 'trans', chapterIndex: 0, blockIndex: 0, startBlock: 0, startOffset: 1, endBlock: 0, endOffset: 4, target: 'translation' },
    ];
    assert.deepEqual(
      fn.thoughtRangesForBlock(thoughts, 0, 0, 10).map((range) => range.id),
      ['orig'],
      'original ranges must ignore translation-anchored thoughts'
    );
    assert.deepEqual(
      fn.translationThoughtRangesForBlock(thoughts, 0, 0, 5).map((range) => range.id),
      ['trans'],
      'translation ranges must only include translation-anchored thoughts'
    );
  });

  await registerContractTests(core);

  const expected = await readExpectedJson();
  const names = Object.keys(expected);
  console.log(`# loading ${names.length} fixtures from expected.json`);
  for (const name of names) {
    const record = await loadFixture(name, expected[name]);
    if (record.error) {
      console.log(`#   ${name}: LOAD FAILED — ${record.error.message}`);
    } else {
      console.log(
        `#   ${name}: parse ${fmtMs(record.parseMs)}, extract ${fmtMs(record.extractMs)} — ` +
          `${record.book.chapters.length} chapters, ${record.mentions.books.length} books, ` +
          `${record.mentions.edges.length} edges, ${record.bytes.length} bytes`,
      );
    }
  }

  for (const name of names) await registerFixtureTests(name, expected[name]);
  await registerZhBasicTests();
  await registerRobustnessTests();
  await registerRealBookSmokeTests();
}

function printSummary(fatal) {
  const wall = performance.now() - HARNESS_STARTED_AT;
  console.log('');
  if (fatal) {
    console.error('FAIL harness aborted before completing all assertions:');
    console.error(fatal && fatal.stack ? fatal.stack : String(fatal));
    console.log(`FAIL ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped, ${results.total} total — ${fmtMs(wall)}`);
    process.exitCode = 1;
    return;
  }
  if (failures.length) {
    console.log(`# failing assertions (${failures.length}):`);
    for (const failure of failures) console.log(`#   ${failure.id}. ${failure.name}`);
    console.log(`FAIL ${results.failed} failed, ${results.passed} passed, ${results.skipped} skipped, ${results.total} total — ${fmtMs(wall)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${results.passed} passed, 0 failed, ${results.skipped} skipped, ${results.total} total — ${fmtMs(wall)}`);
  process.exitCode = 0;
}

process.on('unhandledRejection', (reason) => {
  console.error('FAIL unhandled rejection: ' + (reason && reason.stack ? reason.stack : String(reason)));
  process.exitCode = 1;
});

const watchdog = setTimeout(() => {
  console.error(`\nFAIL watchdog: harness exceeded ${LIMITS.watchdogMs}ms (possible hang)`);
  process.exit(1);
}, LIMITS.watchdogMs);
watchdog.unref();

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = error;
}
clearTimeout(watchdog);
printSummary(fatal);
