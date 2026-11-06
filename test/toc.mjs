/**
 * 目录结构回归测试：模拟 Calibre 风格「一章拆成多个 spine 文件」的 EPUB，
 * 验证章节以 NCX 目录边界为准（而不是每个 spine 文件一章），以及分部/合并。
 * 运行：node dsh-bookweave/test/toc.mjs
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client', 'client.js');

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log('ok   ' + name);
  else {
    failures++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

// ---- 极简 ZIP 写入（仅存储，不压缩；测试内自包含，无依赖）------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zipFiles(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, data);
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function xhtml(title, body) {
  return '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + title + '</title></head><body>' + body + '</body></html>';
}

const files = [
  ['mimetype', 'application/epub+zip'],
  ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
  ['OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>拆分测试书</dc:title><dc:creator>测试作者</dc:creator></metadata><manifest>'
    + '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
    + '<item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>'
    + '<item id="part" href="Text/part.xhtml" media-type="application/xhtml+xml"/>'
    + '<item id="c1a" href="Text/c1a.xhtml" media-type="application/xhtml+xml"/>'
    + '<item id="c1b" href="Text/c1b.xhtml" media-type="application/xhtml+xml"/>'
    + '<item id="c2" href="Text/c2.xhtml" media-type="application/xhtml+xml"/>'
    + '</manifest><spine toc="ncx">'
    + '<itemref idref="cover"/><itemref idref="part"/><itemref idref="c1a"/><itemref idref="c1b"/><itemref idref="c2"/>'
    + '</spine></package>'],
  ['OEBPS/toc.ncx', '<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>'
    + '<navPoint id="n1" playOrder="1"><navLabel><text>开始</text></navLabel><content src="Text/cover.xhtml"/></navPoint>'
    + '<navPoint id="n2" playOrder="2"><navLabel><text>第一部分 测试</text></navLabel><content src="Text/part.xhtml"/>'
    + '<navPoint id="n3" playOrder="3"><navLabel><text>第一章 开篇</text></navLabel><content src="Text/c1a.xhtml"/></navPoint>'
    + '<navPoint id="n4" playOrder="4"><navLabel><text>第二章 收尾</text></navLabel><content src="Text/c2.xhtml"/></navPoint>'
    + '</navPoint></navMap></ncx>'],
  ['OEBPS/Text/cover.xhtml', xhtml('开始', '<h1>开始</h1><p>封面后的开场文字。</p>')],
  ['OEBPS/Text/part.xhtml', xhtml('第一部分 测试', '<h1>第一部分 测试</h1>')],
  ['OEBPS/Text/c1a.xhtml', xhtml('第一章 开篇', '<h1>第一章 开篇</h1><p>第一章的前段文字。</p>')],
  ['OEBPS/Text/c1b.xhtml', xhtml('', '<p>中段文字：这一页不是目录条目，应该并入第一章。</p>')],
  ['OEBPS/Text/c2.xhtml', xhtml('第二章 收尾', '<h1>第二章 收尾</h1><p>第二章正文。</p>')],
];

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

const book = await core.parseEpub(new Uint8Array(zipFiles(files)));
const titles = book.chapters.map((chapter) => chapter.title);
check('目录按 NCX 边界生成章节（不是每页一章）', book.chapters.length === 4, JSON.stringify(titles));
check('章节标题来自 NCX 标签', JSON.stringify(titles) === JSON.stringify(['开始', '第一部分 测试', '第一章 开篇', '第二章 收尾']), JSON.stringify(titles));
check('分部被标记为 part', book.chapters[1].part === true && book.chapters[0].part === false);
check('未在目录中的 spine 文件并入前一章', book.chapters[2].blocks.some((block) => block.text.includes('中段文字')), JSON.stringify(book.chapters[2].blocks));
check('toc 回传结构正确', book.toc.length === 4 && book.toc[2].chapterIndex === 2 && book.toc[3].chapterIndex === 3, JSON.stringify(book.toc));

if (failures) {
  console.log('\nFAIL ' + failures + ' toc case(s)');
  process.exit(1);
}
console.log('\nPASS 目录结构 5/5');
