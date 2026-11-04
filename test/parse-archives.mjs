/**
 * 归档与封面回归测试：普通 ZIP / ZIP 里套 EPUB / 整本书多套一层文件夹 / 封面提取。
 *
 * 运行：node dsh-bookweave/test/parse-archives.mjs
 * 只依赖 Node 标准库；用最小 ZIP 写入器构造用例，不引入第三方包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client', 'client.js');
const fixture = path.join(here, 'fixtures', 'zh-basic.epub');

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

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 只写 stored（不压缩）条目的最小 ZIP 写入器。 */
function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, centralBuffer, eocd]);
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('ok   ' + name);
  } else {
    failures++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

const epubBytes = fs.readFileSync(fixture);

// 1) 真实 EPUB 仍然正常
{
  const book = await core.parseEpub(new Uint8Array(epubBytes));
  const mentions = core.extractMentions(book);
  check('正常 EPUB 解析', book.meta.title === '测试之书' && book.chapters.length === 5 && mentions.books.length === 5, 'title=' + book.meta.title);
}

// 2) 普通 ZIP：必须报“普通 ZIP”，并且带上包内文件诊断
{
  const plain = buildZip([
    { name: 'readme.txt', data: Buffer.from('not an ebook') },
    { name: 'images/a.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);
  let message = '';
  try {
    await core.parseEpub(new Uint8Array(plain));
  } catch (error) {
    message = String(error.message || error);
  }
  check('普通 ZIP 报错并说明原因', message.includes('普通 ZIP') && message.includes('readme.txt'), message);
}

// 3) ZIP 里套着真正的 EPUB：自动解出内层并解析
{
  const wrapped = buildZip([{ name: 'books/zh-basic.epub', data: epubBytes }]);
  const book = await core.parseEpub(new Uint8Array(wrapped));
  const mentions = core.extractMentions(book);
  check('ZIP 内嵌 EPUB 自动解析', book.meta.title === '测试之书' && mentions.books.length === 5, 'title=' + book.meta.title);
}

// 4) 整本 EPUB 多套一层文件夹：仍能找到 META-INF/container.xml
{
  const zip = core.openZip(new Uint8Array(epubBytes));
  const entries = [];
  for (const name of zip.entries.keys()) {
    entries.push({ name: 'book/' + name, data: Buffer.from(await zip.read(name)) });
  }
  const wrapped = buildZip(entries);
  const book = await core.parseEpub(new Uint8Array(wrapped));
  const mentions = core.extractMentions(book);
  check('多层文件夹内的 EPUB 可解析', book.meta.title === '测试之书' && mentions.books.length === 5, 'title=' + book.meta.title);
}

// 5) 封面提取：EPUB2 <meta name="cover"> 指向的图片应变成 data URL
{
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const png = Buffer.from(pngBase64, 'base64');
  const container =
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  const opf =
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>封面测试</dc:title><dc:creator>测试作者</dc:creator><meta name="cover" content="cover-img"/></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="cover-img" href="images/cover.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/></spine></package>';
  const chapter =
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章</h1><p>他读《红楼梦》。</p></body></html>';
  const epub = buildZip([
    { name: 'mimetype', data: Buffer.from('application/epub+zip') },
    { name: 'META-INF/container.xml', data: Buffer.from(container) },
    { name: 'content.opf', data: Buffer.from(opf) },
    { name: 'c1.xhtml', data: Buffer.from(chapter) },
    { name: 'images/cover.png', data: png },
  ]);
  const book = await core.parseEpub(new Uint8Array(epub));
  const mentions = core.extractMentions(book);
  const prefix = 'data:image/png;base64,';
  const okCover =
    typeof book.cover === 'string' && book.cover.startsWith(prefix) && Buffer.from(book.cover.slice(prefix.length), 'base64').equals(png);
  check('封面图片被提取为 data URL', okCover, 'cover=' + String(book.cover).slice(0, 40));
  check('封面测试书仍能提取书名', mentions.books.some((item) => item.title === '红楼梦'));
}

if (failures) {
  console.log('\nFAIL ' + failures + ' archive/cover case(s)');
  process.exit(1);
}
console.log('\nPASS 归档与封面 5/5');
