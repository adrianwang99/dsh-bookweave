/**
 * 搜索地址模板测试：可配置、默认 Open Library、无占位符时自动追加 q=。
 * 运行：node dsh-bookweave/test/search.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client', 'client.js');
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
  if (condition) console.log('ok   ' + name);
  else {
    failures++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

check('默认模板是 Open Library', core.DEFAULT_SEARCH_TEMPLATE === 'https://openlibrary.org/search?q={query}');
check('默认地址会编码书名', core.buildSearchUrl('红楼梦') === 'https://openlibrary.org/search?q=%E7%BA%A2%E6%A5%BC%E6%A2%A6', core.buildSearchUrl('红楼梦'));
check('自定义模板替换 {query}', core.buildSearchUrl('a b', 'https://example.com/s?q={query}') === 'https://example.com/s?q=a%20b');
check('无占位符时自动追加 q=', core.buildSearchUrl('abc', 'https://example.com/find') === 'https://example.com/find?q=abc');
check('已有查询串时追加 &q=', core.buildSearchUrl('abc', 'https://example.com/find?lang=zh') === 'https://example.com/find?lang=zh&q=abc');
check('非法地址被拒绝', core.isValidSearchTemplate('ftp://example.com') === false && core.isValidSearchTemplate('not a url') === false);
check('合法地址被接受', core.isValidSearchTemplate('https://example.com/search?q={query}') === true);
check('空书名只替换占位符', core.buildSearchUrl('', 'https://example.com/s?q={query}') === 'https://example.com/s?q=');

if (failures) {
  console.log('\nFAIL ' + failures + ' search case(s)');
  process.exit(1);
}
console.log('\nPASS 搜索地址模板 8/8');
