/**
 * BookWeave / 书脉 — EPUB 阅读与引书图谱
 *
 * DSH Web Client 半：左侧栏入口 + 主面板。
 * 纯浏览器端解析（ZIP + XHTML + 书名提取），书籍数据保存在本机 IndexedDB，不上传。
 *
 * 结构：
 *   1. Core：无 React、无 DOM 依赖的纯函数（EPUB 解析 / 书名提取 / 书单导出），
 *      在 Node 中可直接测试（test/run.mjs 通过 module loader 桩加载）。
 *   2. UI：React 组件，仅在浏览器渲染。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bookweave',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-bookweave';
    const PANEL_ID = 'dsh-bookweave';
    const CLIENT_VERSION = '0.9.0';

    // =====================================================================
    // 1. Core — pure, testable in Node
    // =====================================================================
    const Core = (() => {
      const decoderUtf8 = new TextDecoder('utf-8');
      const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
      const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

      function latin1(bytes) {
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
        return out;
      }

      function safeDecode(value) {
        try {
          return decodeURIComponent(value);
        } catch (error) {
          return value;
        }
      }

      function bytesToBase64(bytes) {
        let binary = '';
        const chunk = 0x8000;
        for (let index = 0; index < bytes.length; index += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
        }
        return btoa(binary);
      }

      function decodeUtf8Loose(bytes) {
        const out = decoderUtf8.decode(bytes);
        return out.indexOf('\uFFFD') >= 0 ? latin1(bytes) : out;
      }

      const ENTITIES = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
        thinsp: ' ', zwnj: '', zwj: '', shy: '', hellip: '…', mdash: '—', ndash: '–',
        lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
        middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', deg: '°',
        times: '×', divide: '÷', laquo: '«', raquo: '»', sect: '§', para: '¶',
        dagger: '†', Dagger: '‡', prime: '′', Prime: '″', frac12: '½', frac14: '¼',
        frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', plusmn: '±', ne: '≠',
        le: '≤', ge: '≥', infin: '∞', asymp: '≈', euro: '€', pound: '£', yen: '¥',
        cent: '¢', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π',
        sigma: 'σ', omega: 'ω', Omega: 'Ω', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
      };

      function decodeEntities(text) {
        if (!text || text.indexOf('&') < 0) return text || '';
        return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
          if (body.charAt(0) === '#') {
            const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
            const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (Number.isFinite(code) && code > 0 && code < 0x110000) {
              try {
                return String.fromCodePoint(code);
              } catch (error) {
                return whole;
              }
            }
            return whole;
          }
          return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : whole;
        });
      }

      /** 扫描文件头部声明的字符集（GBK/UTF-16 等老电子书很常见）。 */
      function sniffCharset(bytes) {
        const head = latin1(bytes.subarray(0, 512));
        const match = /(?:encoding|charset)\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
        if (!match) return '';
        const label = match[1].toLowerCase();
        if (label === 'gb2312' || label === 'gbk') return 'gbk';
        if (label === 'gb18030') return 'gb18030';
        if (label === 'big5') return 'big5';
        if (label === 'utf-16' || label === 'utf-16le' || label === 'utf-16be') return label;
        if (label === 'utf-8' || label === 'utf8') return 'utf-8';
        if (label === 'iso-8859-1' || label === 'latin1' || label === 'us-ascii') return 'utf-8';
        return '';
      }

      function decodeBytes(bytes) {
        if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
          return decoderUtf8.decode(bytes.subarray(3));
        }
        if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
          try {
            return new TextDecoder('utf-16le').decode(bytes.subarray(2));
          } catch (error) {
            /* ignore */
          }
        }
        if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
          try {
            return new TextDecoder('utf-16be').decode(bytes.subarray(2));
          } catch (error) {
            /* ignore */
          }
        }
        const declared = sniffCharset(bytes);
        if (declared && declared !== 'utf-8') {
          try {
            return new TextDecoder(declared).decode(bytes);
          } catch (error) {
            /* fall through */
          }
        }
        const out = decoderUtf8.decode(bytes);
        if (out.indexOf('\uFFFD') >= 0) {
          try {
            const alt = new TextDecoder('gbk').decode(bytes);
            if (alt.indexOf('\uFFFD') < 0) return alt;
          } catch (error) {
            /* ignore */
          }
        }
        return out;
      }

      async function inflateRaw(bytes) {
        if (typeof DecompressionStream === 'undefined') {
          throw new Error('当前环境不支持解压 EPUB（缺少 DecompressionStream）');
        }
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }

      function openZip(bytes) {
        const length = bytes.length;
        if (length < 32) throw new Error('文件太小，不是有效的 EPUB');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let eocd = -1;
        const stop = Math.max(0, length - 22 - 65535);
        for (let i = length - 22; i >= stop; i--) {
          if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
          }
        }
        if (eocd < 0) throw new Error('不是有效的 EPUB（找不到 ZIP 目录）');
        const total = view.getUint16(eocd + 10, true);
        const cdOffset = view.getUint32(eocd + 16, true);
        if (cdOffset === 0xffffffff) throw new Error('暂不支持 ZIP64 格式的 EPUB');
        if (cdOffset >= length) throw new Error('EPUB 文件已损坏（目录偏移越界）');
        const entries = new Map();
        let pointer = cdOffset;
        for (let i = 0; i < total; i++) {
          if (pointer + 46 > length || view.getUint32(pointer, true) !== 0x02014b50) break;
          const method = view.getUint16(pointer + 10, true);
          const compSize = view.getUint32(pointer + 20, true);
          const size = view.getUint32(pointer + 24, true);
          const nameLen = view.getUint16(pointer + 28, true);
          const extraLen = view.getUint16(pointer + 30, true);
          const commentLen = view.getUint16(pointer + 32, true);
          const localOffset = view.getUint32(pointer + 42, true);
          const name = decodeUtf8Loose(bytes.subarray(pointer + 46, pointer + 46 + nameLen));
          entries.set(name, { name, method, compSize, size, localOffset });
          pointer += 46 + nameLen + extraLen + commentLen;
        }
        if (!entries.size) throw new Error('EPUB 文件已损坏（ZIP 目录为空）');

        function lookup(name) {
          const candidates = [name, safeDecode(name), encodeURI(name), safeDecode(encodeURI(name))];
          for (const candidate of candidates) {
            if (entries.has(candidate)) return entries.get(candidate);
          }
          const normalize = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
          const wanted = normalize(name);
          for (const [key, value] of entries) {
            if (normalize(key) === wanted) return value;
          }
          return null;
        }

        async function read(name) {
          const entry = lookup(name);
          if (!entry) throw new Error('EPUB 缺少文件：' + name);
          if (entry.compSize === 0xffffffff) throw new Error('暂不支持 ZIP64 格式的 EPUB');
          const offset = entry.localOffset;
          if (offset + 30 > length || view.getUint32(offset, true) !== 0x04034b50) {
            throw new Error('EPUB 文件已损坏（本地文件头无效）：' + name);
          }
          const nameLen = view.getUint16(offset + 26, true);
          const extraLen = view.getUint16(offset + 28, true);
          const start = offset + 30 + nameLen + extraLen;
          const compressed = bytes.subarray(start, start + entry.compSize);
          if (entry.method === 0) return compressed;
          if (entry.method === 8) return await inflateRaw(compressed);
          throw new Error('EPUB 使用了不支持的压缩方式：' + entry.method);
        }

        function has(name) {
          return Boolean(lookup(name));
        }

        return { entries, read, has };
      }

      function dirOf(path) {
        const index = String(path).lastIndexOf('/');
        return index < 0 ? '' : String(path).slice(0, index);
      }

      function resolvePath(baseDir, href) {
        const clean = String(href || '').split('#')[0];
        const decoded = safeDecode(clean);
        const joined = (baseDir ? baseDir + '/' : '') + decoded;
        const parts = joined.split('/');
        const output = [];
        for (const part of parts) {
          if (!part || part === '.') continue;
          if (part === '..') output.pop();
          else output.push(part);
        }
        return output.join('/');
      }

      function parseAttrs(tag) {
        const attrs = {};
        const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        let match;
        while ((match = re.exec(tag))) {
          attrs[match[1]] = decodeEntities(match[3] !== undefined ? match[3] : match[4]);
        }
        return attrs;
      }

      function getAttr(tag, name) {
        const attrs = parseAttrs(tag);
        return attrs[name] !== undefined ? attrs[name] : '';
      }

      function stripTags(html) {
        return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
      }

      function firstInner(text, re) {
        const match = re.exec(text);
        return match ? match[1] : '';
      }

      function cleanMetaText(value) {
        const text = stripTags(value || '');
        return text.length > 200 ? text.slice(0, 200) : text;
      }

      // ---- XHTML → blocks -------------------------------------------------
      const SKIP_TAGS = new Set(['script', 'style', 'head', 'svg', 'math', 'template', 'noscript', 'audio', 'video']);
      const HEADING_TAGS = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4' };
      const BLOCK_TAGS = new Set([
        'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav',
        'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'figure', 'figcaption',
        'table', 'tr', 'td', 'th', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body', 'html',
      ]);
      const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[a-zA-Z][^>]*>/g;

      function normalizeInline(text) {
        return String(text || '')
          .replace(/[\u200b-\u200f\ufeff]/g, '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t\r\n\f]+/g, ' ')
          .trim();
      }

      function htmlToBlocks(html) {
        const blocks = [];
        let buffer = '';
        let skipDepth = 0;
        let pendingType = 'p';
        let title = '';

        const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
        if (titleMatch) title = stripTags(titleMatch[1]);

        function flush() {
          const text = normalizeInline(buffer);
          if (text) blocks.push({ type: pendingType, text });
          buffer = '';
        }

        function handleText(raw) {
          if (skipDepth > 0) return;
          buffer += decodeEntities(raw);
        }

        TOKEN_RE.lastIndex = 0;
        let lastIndex = 0;
        let match;
        while ((match = TOKEN_RE.exec(html))) {
          if (match.index > lastIndex) handleText(html.slice(lastIndex, match.index));
          const token = match[0];
          lastIndex = TOKEN_RE.lastIndex;
          if (token.startsWith('<!--') || token.startsWith('<![CDATA[') || token.startsWith('<?') || token.startsWith('<!')) continue;
          const nameMatch = /^<\/?([a-zA-Z][\w:.-]*)/.exec(token);
          if (!nameMatch) continue;
          const tag = nameMatch[1].toLowerCase();
          const closing = token.charAt(1) === '/';
          const selfClosing = /\/>$/.test(token);
          if (SKIP_TAGS.has(tag)) {
            if (selfClosing) continue;
            if (closing) {
              if (skipDepth > 0) skipDepth--;
            } else {
              skipDepth++;
            }
            continue;
          }
          if (tag === 'br') {
            flush();
            continue;
          }
          if (HEADING_TAGS[tag]) {
            if (closing) {
              flush();
            } else {
              flush();
              pendingType = HEADING_TAGS[tag];
            }
            continue;
          }
          if (BLOCK_TAGS.has(tag)) {
            flush();
            if (!closing && tag === 'li') pendingType = 'li';
            else if (!closing && tag === 'blockquote') pendingType = 'quote';
            else if (!closing && tag === 'pre') pendingType = 'pre';
            else pendingType = 'p';
            continue;
          }
        }
        if (lastIndex < html.length) handleText(html.slice(lastIndex));
        flush();
        return { blocks, title };
      }

      // ---- TOC -------------------------------------------------------------
      function parseNavDocument(html, navPath) {
        const navBase = dirOf(navPath);
        let scope = html;
        const navMatch = /<nav\b[^>]*(?:epub:type|role)\s*=\s*["'][^"']*toc[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(html);
        if (navMatch) scope = navMatch[1];
        const entries = [];
        const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = anchorRe.exec(scope))) {
          const href = getAttr('<x ' + match[1] + '>', 'href');
          if (!href) continue;
          const label = stripTags(match[2]);
          if (!label) continue;
          const resolved = resolvePath(navBase, href);
          entries.push({ label, path: resolved.split('#')[0], fragment: href.split('#')[1] || '', rawHref: href });
        }
        return entries;
      }

      function parseNcx(xml, ncxPath) {
        const base = dirOf(ncxPath);
        const entries = [];
        let label = '';
        const tokenRe = /<(text|content)\b([^>]*)>([\s\S]*?)<\/\1>|<content\b([^>]*?)\/?>/gi;
        let match;
        while ((match = tokenRe.exec(xml))) {
          if (match[1] === 'text') {
            label = stripTags(match[3]);
          } else {
            const tag = '<x ' + (match[1] === 'content' ? match[2] : match[4]) + '>';
            const src = getAttr(tag, 'src');
            if (!src) continue;
            entries.push({
              label: label || '',
              path: resolvePath(base, src).split('#')[0],
              fragment: src.split('#')[1] || '',
              rawHref: src,
            });
            label = '';
          }
        }
        return entries.filter((entry) => entry.path);
      }

      // ---- EPUB ------------------------------------------------------------
      function normalizeZipName(name) {
        return String(name || '').replace(/\\/g, '/').replace(/^\.?\//, '');
      }

      /** 扫描压缩包：container.xml 可能在子目录里（整本书被套了一层文件夹）。 */
      function scanArchive(zip) {
        let containerName = '';
        let encryptionName = '';
        const epubNames = [];
        for (const name of zip.entries.keys()) {
          const normalized = normalizeZipName(name);
          const lower = normalized.toLowerCase();
          if (!containerName && (lower === 'meta-inf/container.xml' || lower.endsWith('/meta-inf/container.xml'))) containerName = name;
          if (!encryptionName && (lower === 'meta-inf/encryption.xml' || lower.endsWith('/meta-inf/encryption.xml'))) encryptionName = name;
          if (/\.epub$/i.test(normalized)) epubNames.push(name);
        }
        let prefix = '';
        if (containerName) {
          const normalized = normalizeZipName(containerName);
          const marker = 'meta-inf/container.xml';
          const index = normalized.toLowerCase().lastIndexOf(marker);
          if (index > 0) prefix = normalized.slice(0, index);
        }
        return { containerName, encryptionName, epubNames, prefix };
      }

      async function describeArchive(zip) {
        const names = Array.from(zip.entries.keys());
        let mimetype = '';
        try {
          const raw = await zip.read('mimetype');
          if (raw && raw.length) mimetype = decodeBytes(raw).trim();
        } catch (error) {
          /* ignore */
        }
        const sampleNames = names.slice(0, 5).map((name) => normalizeZipName(name));
        return {
          count: names.length,
          mimetype,
          sample: sampleNames.join('、') + (names.length > sampleNames.length ? ' 等 ' + names.length + ' 个文件' : ''),
        };
      }

      function joinZipPath(prefix, relative) {
        const base = prefix ? prefix.replace(/\/+$/, '') : '';
        const path = String(relative || '').replace(/^\.?\//, '');
        return base ? base + '/' + path : path;
      }

      async function parseEpub(bytes, options) {
        const opts = options || {};
        const depth = typeof opts.depth === 'number' ? opts.depth : 0;
        const onStage = typeof opts.onStage === 'function' ? opts.onStage : function () {};
        onStage('unzip', 0);
        const zip = openZip(bytes);
        const scan = scanArchive(zip);

        if (scan.encryptionName) {
          throw new Error('这本书带有 DRM 加密，无法解析。请使用未加密的 EPUB。');
        }

        if (!scan.containerName) {
          // 常见情况：用户下载到的是一个 ZIP，里面还套着真正的 .epub
          if (depth < 2 && scan.epubNames.length) {
            onStage('chapters', 0.05);
            const inner = await zip.read(scan.epubNames[0]);
            return await parseEpub(inner, { onStage: onStage, depth: depth + 1 });
          }
          const info = await describeArchive(zip);
          const details = [];
          details.push(info.mimetype ? '压缩包的 mimetype 是「' + info.mimetype.slice(0, 40) + '」' : '压缩包里没有 mimetype 文件');
          if (info.sample) details.push('包内文件：' + info.sample);
          throw new Error(
            '这个文件是普通 ZIP，不是 EPUB：缺少 META-INF/container.xml（' +
              details.join('；') +
              '）。如果原书是 PDF / MOBI / TXT，请先用 Calibre 转成 EPUB 再导入。'
          );
        }

        const containerXml = decodeBytes(await zip.read(scan.containerName));
        const rootTag = /<rootfile\b[^>]*>/i.exec(containerXml);
        if (!rootTag) throw new Error('EPUB 的 container.xml 缺少 rootfile');
        const declaredPath = getAttr(rootTag[0], 'full-path');
        if (!declaredPath) throw new Error('EPUB 的 container.xml 缺少 full-path');
        let opfPath = joinZipPath(scan.prefix, safeDecode(declaredPath));
        let opfText = '';
        try {
          opfText = decodeBytes(await zip.read(opfPath));
        } catch (error) {
          // 非标准打包：按包内实际的 .opf 文件回退
          const target = normalizeZipName(safeDecode(declaredPath)).toLowerCase();
          const targetName = target.split('/').pop();
          let fallback = '';
          for (const name of zip.entries.keys()) {
            const normalized = normalizeZipName(name);
            if (!/\.opf$/i.test(normalized)) continue;
            if (normalized.toLowerCase() === target || normalized.toLowerCase().endsWith('/' + targetName)) {
              fallback = name;
              break;
            }
          }
          if (!fallback) {
            for (const name of zip.entries.keys()) {
              if (/\.opf$/i.test(normalizeZipName(name))) {
                fallback = name;
                break;
              }
            }
          }
          if (!fallback) throw new Error('EPUB 里找不到 OPF 文件（container.xml 指向 ' + declaredPath + '）');
          opfPath = normalizeZipName(fallback);
          opfText = decodeBytes(await zip.read(opfPath));
        }
        const opfDir = dirOf(opfPath);

        onStage('manifest', 0.1);
        const manifest = new Map();
        const itemRe = /<item\b[^>]*>/gi;
        let itemMatch;
        while ((itemMatch = itemRe.exec(opfText))) {
          const attrs = parseAttrs(itemMatch[0]);
          if (!attrs.id || !attrs.href) continue;
          manifest.set(attrs.id, {
            id: attrs.id,
            href: attrs.href,
            mediaType: attrs['media-type'] || '',
            properties: attrs.properties || '',
          });
        }
        const spineIds = [];
        const refRe = /<itemref\b[^>]*>/gi;
        let refMatch;
        while ((refMatch = refRe.exec(opfText))) {
          const attrs = parseAttrs(refMatch[0]);
          if (attrs.idref) spineIds.push(attrs.idref);
        }

        const meta = {
          title: cleanMetaText(firstInner(opfText, /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)) || '未命名书籍',
          author: cleanMetaText(firstInner(opfText, /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)),
          language: cleanMetaText(firstInner(opfText, /<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i)),
          publisher: cleanMetaText(firstInner(opfText, /<dc:publisher[^>]*>([\s\S]*?)<\/dc:publisher>/i)),
          identifier: cleanMetaText(firstInner(opfText, /<dc:identifier[^>]*>([\s\S]*?)<\/dc:identifier>/i)),
        };
        const creatorMatches = opfText.match(/<dc:creator\b[^>]*>[\s\S]*?<\/dc:creator>/gi) || [];
        if (creatorMatches.length > 1 && meta.author) {
          const all = creatorMatches.map((tag) => cleanMetaText(tag)).filter(Boolean);
          if (all.length > 1) meta.author = all.join(' / ');
        }

        // 封面：EPUB3 properties="cover-image" / EPUB2 <meta name="cover" content="id">
        let cover = '';
        try {
          let coverItem = null;
          const coverMeta = /<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i.exec(opfText);
          if (coverMeta) {
            const coverId = getAttr(coverMeta[0], 'content');
            if (coverId && manifest.has(coverId)) coverItem = manifest.get(coverId);
          }
          if (!coverItem) {
            coverItem = Array.from(manifest.values()).find((item) => /(^|\s)cover-image(\s|$)/.test(item.properties || '')) || null;
          }
          if (!coverItem) {
            coverItem =
              Array.from(manifest.values()).find((item) => /^image\//i.test(item.mediaType || '') && /cover/i.test(item.href || '')) || null;
          }
          if (coverItem && coverItem.href) {
            const coverPath = resolvePath(opfDir, coverItem.href);
            const data = await zip.read(coverPath);
            if (data && data.length && data.length <= 3 * 1024 * 1024) {
              const type = coverItem.mediaType || (/\.svg$/i.test(coverItem.href) ? 'image/svg+xml' : 'image/jpeg');
              cover = 'data:' + type + ';base64,' + bytesToBase64(data);
            }
          }
        } catch (error) {
          cover = '';
        }

        const spineItems = [];
        for (const idref of spineIds) {
          const item = manifest.get(idref);
          if (!item) continue;
          const path = resolvePath(opfDir, item.href);
          const type = (item.mediaType || '').toLowerCase();
          const isDoc = type.indexOf('xhtml') >= 0 || type.indexOf('html') >= 0 || type === 'text/xml' || /\.x?html?$/i.test(path);
          if (!isDoc) continue;
          spineItems.push({ idref, path, href: item.href });
        }
        if (!spineItems.length) {
          for (const item of manifest.values()) {
            if (/\.x?html?$/i.test(item.href)) {
              spineItems.push({ idref: item.id, path: resolvePath(opfDir, item.href), href: item.href });
            }
          }
        }
        if (!spineItems.length) throw new Error('这本 EPUB 里没有可阅读的正文文件');

        onStage('chapters', 0.15);
        const chapters = [];
        for (let index = 0; index < spineItems.length; index++) {
          const item = spineItems[index];
          let html = '';
          try {
            html = decodeBytes(await zip.read(item.path));
          } catch (error) {
            continue;
          }
          const parsed = htmlToBlocks(html);
          if (!parsed.blocks.length) continue;
          chapters.push({
            index: chapters.length,
            path: item.path,
            href: item.href,
            title: '',
            docTitle: parsed.title,
            blocks: parsed.blocks,
            chars: parsed.blocks.reduce((sum, block) => sum + block.text.length, 0),
          });
          if (index % 8 === 0) onStage('chapters', 0.15 + 0.35 * (index / spineItems.length));
        }
        if (!chapters.length) throw new Error('这本 EPUB 的正文为空');

        // TOC：EPUB3 nav → NCX → 章节标题 → 章节序号
        let toc = [];
        const navItem = Array.from(manifest.values()).find((item) => /(^|\s)nav(\s|$)/.test(item.properties || ''));
        const ncxItem = Array.from(manifest.values()).find(
          (item) => /dtbncx/.test(item.mediaType || '') || /\.ncx$/i.test(item.href)
        );
        try {
          if (navItem) {
            const navPath = resolvePath(opfDir, navItem.href);
            toc = parseNavDocument(decodeBytes(await zip.read(navPath)), navPath);
          }
        } catch (error) {
          toc = [];
        }
        if (!toc.length && ncxItem) {
          try {
            const ncxPath = resolvePath(opfDir, ncxItem.href);
            toc = parseNcx(decodeBytes(await zip.read(ncxPath)), ncxPath);
          } catch (error) {
            toc = [];
          }
        }
        const chapterByPath = new Map();
        for (const chapter of chapters) chapterByPath.set(chapter.path, chapter);
        const tocEntries = [];
        for (const entry of toc) {
          const chapter = chapterByPath.get(entry.path);
          if (!chapter) continue;
          tocEntries.push({
            label: entry.label || chapter.docTitle || '',
            chapterIndex: chapter.index,
            fragment: entry.fragment || '',
          });
        }
        for (const entry of tocEntries) {
          const chapter = chapters[entry.chapterIndex];
          if (!entry.label) continue;
          if (!chapter.title || chapter.title === chapter.docTitle) chapter.title = entry.label;
        }
        for (const chapter of chapters) {
          if (!chapter.title) {
            const docTitle = (chapter.docTitle || '').trim();
            const usableDoc = docTitle && docTitle !== meta.title && !/^(untitled|unknown|无标题|未命名)$/i.test(docTitle);
            if (usableDoc) chapter.title = docTitle;
          }
          if (!chapter.title) {
            const heading = chapter.blocks.find((block) => block.type.startsWith('h')) || null;
            if (heading && heading.text.length <= 60) chapter.title = heading.text;
          }
          if (!chapter.title) chapter.title = '第 ' + (chapter.index + 1) + ' 章';
          delete chapter.docTitle;
        }

        onStage('done', 0.5);
        const chars = chapters.reduce((sum, chapter) => sum + chapter.chars, 0);
        return {
          version: 1,
          meta,
          cover,
          chapters,
          toc: tocEntries,
          stats: { chapters: chapters.length, chars, blocks: chapters.reduce((sum, c) => sum + c.blocks.length, 0) },
        };
      }

      // ---- 书名提取 --------------------------------------------------------
      const PERIODICAL_TAIL = /(?:日报|晚报|时报|周报|周刊|月刊|季刊|年刊|学报|画报|杂志|期刊|晨报|商报|日报社)$/;
      const CHAPTER_REF = /第[0-9〇零一二三四五六七八九十百千万两]+[回章节卷篇部集]/;
      const BOUNDARY_CHARS = '。！？!?；;\n\r';
      const MARK_RE = /《([^《》\n\r]{1,60})》/g;
      const POINTED_RE = /〈([^〈〉\n\r]{1,60})〉/g;

      /** 常见且不易与普通词语混淆的经典书名，用于补充没有书名号的提及。 */
      const LEXICON = [
        '红楼梦', '西游记', '水浒传', '三国演义', '金瓶梅', '儒林外史', '聊斋志异', '牡丹亭',
        '西厢记', '桃花扇', '长生殿', '世说新语', '文心雕龙', '昭明文选', '古文观止', '唐诗三百首',
        '宋词三百首', '人间词话', '论语', '道德经', '诗经', '楚辞', '离骚', '天工开物',
        '梦溪笔谈', '本草纲目', '徐霞客游记', '曾国藩家书', '资治通鉴', '史记', '汉书', '三国志',
        '汉书艺文志', '万历十五年', '乡土中国', '美的历程', '文化苦旅', '山居笔记', '中国大历史',
        '枪炮病菌与钢铁', '人类简史', '未来简史', '今日简史', '时间简史', '物种起源', '国富论',
        '资本论', '乌合之众', '娱乐至死', '技术垄断', '童年的消逝', '第三次浪潮', '数字化生存',
        '失控', '创新者的窘境', '精益创业', '穷查理宝典', '高效能人士的七个习惯', '金字塔原理',
        '刻意练习', '非暴力沟通', '被讨厌的勇气', '少有人走的路', '心流', '思考快与慢',
        '影响力', '原则', '从零到一', '长尾理论', '免费', '世界是平的', '文明的冲突',
        '历史的终结', '枪炮钢铁与病菌', '伟大的博弈', '漫步华尔街', '聪明的投资者', '穷爸爸富爸爸',
        '黑天鹅', '反脆弱', '随机漫步的傻瓜', '三体', '球状闪电', '流浪地球', '百年孤独',
        '霍乱时期的爱情', '老人与海', '了不起的盖茨比', '麦田里的守望者', '喧哗与骚动', '追忆似水年华',
        '尤利西斯', '变形记', '城堡', '审判', '局外人', '鼠疫', '西西弗神话', '存在与虚无',
        '查拉图斯特拉如是说', '悲剧的诞生', '作为意志和表象的世界', '纯粹理性批判', '精神现象学',
        '社会契约论', '论法的精神', '君主论', '理想国', '政治学', '形而上学', '沉思录', '忏悔录',
        '瓦尔登湖', '战争与和平', '安娜卡列尼娜', '复活', '罪与罚', '卡拉马佐夫兄弟', '白痴',
        '静静的顿河', '悲惨世界', '巴黎圣母院', '红与黑', '高老头', '欧也妮葛朗台', '包法利夫人',
        '约翰克利斯朵夫', '傲慢与偏见', '简爱', '呼啸山庄', '双城记', '雾都孤儿', '德伯家的苔丝',
        '白鹿原', '平凡的世界', '围城', '边城', '骆驼祥子', '四世同堂', '朝花夕拾', '呐喊', '彷徨',
        '故事新编', '茶馆', '雷雨', '活着', '许三观卖血记', '丰乳肥臀', '红高粱', '生死疲劳',
        '尘埃落定', '长恨歌', '穆斯林的葬礼', '兄弟', '秦腔', '推拿', '受活', '一句顶一万句',
        '饥饿的女儿', '野火集', '目送', '亲爱的安德烈', '看见', '日光流年', '人世间', '北上',
      ];

      /** 补充：英文书的书名通常不用书名号，这里只做带明确线索的低置信度补充。 */
      const EN_LEXICON = [
        'The Great Gatsby', 'Pride and Prejudice', 'Jane Eyre', 'Wuthering Heights', 'Moby-Dick',
        'Moby Dick', 'War and Peace', 'Anna Karenina', 'Crime and Punishment', 'The Brothers Karamazov',
        'Don Quixote', 'Ulysses', 'In Search of Lost Time', 'The Odyssey', 'The Iliad', 'Hamlet',
        'Macbeth', 'King Lear', 'Othello', 'The Divine Comedy', 'The Canterbury Tales', 'Paradise Lost',
        'The Republic', 'The Prince', 'The Wealth of Nations', 'The Origin of Species', 'A Tale of Two Cities',
        'Oliver Twist', 'David Copperfield', 'Great Expectations', 'Bleak House', 'Middlemarch',
        'The Scarlet Letter', 'The Adventures of Huckleberry Finn', 'The Call of the Wild', 'The Old Man and the Sea',
        'The Sun Also Rises', 'A Farewell to Arms', 'For Whom the Bell Tolls', 'The Sound and the Fury',
        'To Kill a Mockingbird', 'The Catcher in the Rye', 'Nineteen Eighty-Four', '1984', 'Animal Farm',
        'Brave New World', 'Fahrenheit 451', 'The Lord of the Rings', 'The Hobbit', 'Dune', 'Foundation',
        'Beloved', 'One Hundred Years of Solitude', 'Love in the Time of Cholera', 'The Metamorphosis',
        'The Trial', 'The Stranger', 'The Plague', 'Being and Nothingness', 'Thus Spoke Zarathustra',
        'The World as Will and Representation', 'Critique of Pure Reason', 'The Phenomenology of Spirit',
        'The Social Contract', 'The Spirit of the Laws', 'Meditations', 'Walden', 'The Interpretation of Dreams',
        'The Structure of Scientific Revolutions', 'The Selfish Gene', 'A Brief History of Time', 'Sapiens',
        'Thinking, Fast and Slow', 'The Black Swan', 'The Lean Startup', 'Zero to One',
        'The Innovator\'s Dilemma', 'The 7 Habits of Highly Effective People', 'The Art of War',
        'The Analects', 'Tao Te Ching', 'Leviathan', 'The Second Sex', 'Silent Spring',
      ];

      function normalizeKey(text) {
        return String(text || '')
          .replace(/[\s《》〈〉「」『』“”‘’"'·・:：，,。.!！?？、；;（）()【】\[\]\-—–_/\\|]/g, '')
          .toLowerCase();
      }

      function cleanTitle(raw) {
        let text = String(raw || '')
          .replace(/[\u200b-\u200f\ufeff]/g, '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t\r\n\f]+/g, ' ')
          .trim();
        text = text.replace(/\s*([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\s*/g, '$1');
        text = text.replace(/^[「『“"‘'\s]+/, '').replace(/[」』”"’'\s]+$/, '');
        text = text.replace(/[，,。.；;：:、!！?？]+$/, '').trim();
        return text;
      }

      function isExcludedTitle(title) {
        if (!title) return true;
        if (title.length > 48) return true;
        if (/[。！？；\n\r]/.test(title)) return true;
        if (PERIODICAL_TAIL.test(title)) return true;
        if (CHAPTER_REF.test(title)) return true;
        if (/^(?:https?:|www\.)/i.test(title)) return true;
        return false;
      }

      function sentenceAround(text, start, end) {
        let from = start;
        while (from > 0 && BOUNDARY_CHARS.indexOf(text[from - 1]) < 0 && start - from < 90) from--;
        let to = end;
        while (to < text.length && BOUNDARY_CHARS.indexOf(text[to]) < 0 && to - end < 90) to++;
        if (to < text.length) to++;
        let snippet = text.slice(from, to).trim();
        if (snippet.length > 200) {
          const anchor = start - from;
          const half = 90;
          const left = Math.max(0, anchor - half);
          snippet = (left > 0 ? '…' : '') + snippet.slice(left, left + half * 2) + (left + half * 2 < snippet.length ? '…' : '');
        }
        return snippet;
      }

      const EN_TITLE_WORDS = new Set([
        'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with',
        'as', 'is', 'it', 'its', 'into', 'over', 'under', 'after', 'before', 'between',
      ]);

      function looksLikeEnglishTitle(text) {
        const words = text.trim().split(/\s+/);
        if (words.length < 2 || words.length > 12) return false;
        if (text.length < 4 || text.length > 80) return false;
        if (/[。！？；，、]/.test(text)) return false;
        let capitalized = 0;
        let plain = 0;
        for (const word of words) {
          const bare = word.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
          if (!bare) return false;
          if (/^[A-Z]/.test(bare) || EN_TITLE_WORDS.has(bare.toLowerCase())) {
            if (/^[A-Z]/.test(bare)) capitalized++;
          } else if (/^[a-z]/.test(bare)) {
            plain++;
          } else {
            return false;
          }
        }
        return capitalized >= 2 && plain <= capitalized;
      }

      function isLatinTitleCased(fragment) {
        const text = String(fragment || '').trim();
        if (!text) return false;
        if (/^\d/.test(text)) return true; // 1984 这类数字书名
        const words = text.split(/\s+/).filter(Boolean);
        if (!words.length) return false;
        const first = words[0].replace(/^[^A-Za-z]+/, '');
        if (!/^[A-Z]/.test(first)) return false;
        let capitalized = 0;
        for (const word of words) {
          const bare = word.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
          if (bare && /^[A-Z]/.test(bare)) capitalized++;
        }
        return capitalized >= Math.max(1, Math.ceil(words.length / 2));
      }

      // 报道 / 访谈 / 专栏 / 论文标题常年也用书名号，用相邻的发布动作或后缀把它们分出来。
      const MEDIA_BEFORE = /(?:发布|刊发|发表|刊出|转载|转发|出品|推出|上线|报道|采访|节目|视频|播客|栏目|专题)\s*[：:，,]?\s*$/;
      const ARTICLE_AFTER = /^\s*(?:一文|这篇文章|该文|文章|报道|采访|视频|节目|播客|专栏|课程|演讲|讲座|论文|研究报告|白皮书)/;

      function looksLikeArticle(title, text, start, end) {
        if (MEDIA_BEFORE.test(text.slice(Math.max(0, start - 34), start))) return true;
        if (ARTICLE_AFTER.test(text.slice(end, end + 26))) return true;
        return false;
      }

      function guessAuthor(text, start) {
        const before = text.slice(Math.max(0, start - 28), start);
        const after = text.slice(start, Math.min(text.length, start + 48));
        let match = /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,4})著\s*$/.exec(before);
        if (match) return match[1];
        match = /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,4})\s*(?:写|编|译|撰)\s*的?\s*$/.exec(before);
        if (match) return match[1];
        match = /((?:[A-Z][A-Za-z.'-]+)(?:\s+(?:[A-Z][A-Za-z.'-]+)){0,2})(?:['’]s|\s+wrote|\s+by)\s*$/i.exec(before);
        if (match) return match[1];
        match = /^\s*[，,]?\s*([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,4})\s*著/.exec(after);
        if (match) return match[1];
        match = /^\s*[（(]\s*([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,4})\s*[著编撰译]/.exec(after);
        if (match) return match[1];
        match = /^\s*(?:by)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})/.exec(after);
        if (match) return match[1];
        // “曹雪芹的《红楼梦》”：只在作者名形制可靠且位于句读边界后时采用
        match = /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,4})的\s*$/.exec(before);
        if (match && !/^[的了是在和与把被从对向为以就都也还又很更最不没这那我你他她它个些种样成转译有著编撰写读看讲谈说]/.test(match[1])) {
          const preceding = before.charAt(before.length - match[0].length - 1);
          if (!preceding || /[\s，。；：、！？""''《》()（）·—]/.test(preceding)) return match[1];
        }
        return '';
      }

      // 经典书名补充匹配：必须有紧邻的“阅读/引用”线索，否则像“历史记录”里的“史记”会被误判。
      const ZH_LEX_BEFORE = /(?:读|读过|读着|细读|重读|翻阅|翻开|翻过|看过|引用|引用过|提到|提到过|著有|撰写|写成|翻译|出版|再版|推荐|选编|收录|整理|校注|评注|评点|研究|讲解|解读|一书|这本书|那本书|名著|经典|诗云|子曰)$/;
      const ZH_LEX_AFTER = /^(?:一书|这本书|那本书|书中|里说|中说|里写道|中写道|所著|的作者|的读者|出版|新版|旧版|译本|导读|序言|读后感|讲解|研究|精读|选读|摘录|里提到|中提到|提到过|中提出|里所说|所说|有言|云|曰|记载|所言)/;
      const EN_LEX_BEFORE = /(?:\b(?:read|reading|reads|wrote|written|writing|book|novel|memoir|biography|autobiography|titled|called|entitled|published|author|translated|edition|essay|poem|play|by)\b\s*["'“‘(]*|[A-Z][\w.'-]*['’]s\s+)$/i;

      /** 在 block 文本里找出某个书名的所有位置。拉丁书名需要词边界。 */
      function collectLexiconHits(text, needle, latin) {
        const hits = [];
        if (!needle) return hits;
        if (!latin) {
          let from = 0;
          for (;;) {
            const at = text.indexOf(needle, from);
            if (at < 0) break;
            hits.push({ start: at, end: at + needle.length });
            from = at + needle.length;
          }
          return hits;
        }
        const haystack = text.toLowerCase();
        const target = needle.toLowerCase();
        let from = 0;
        for (;;) {
          const at = haystack.indexOf(target, from);
          if (at < 0) break;
          const before = at > 0 ? text.charAt(at - 1) : '';
          const after = text.charAt(at + needle.length);
          if (!/[A-Za-z0-9']/.test(before) && !/[A-Za-z0-9']/.test(after)) {
            hits.push({ start: at, end: at + needle.length });
          }
          from = at + Math.max(1, needle.length);
        }
        return hits;
      }

      function extractMentions(book, options) {
        const opts = options || {};
        const lexicon = Array.isArray(opts.lexicon) ? opts.lexicon : LEXICON;
        const selfKey = normalizeKey(book && book.meta ? book.meta.title : '');
        const byKey = new Map();
        const edges = new Map();
        const chapterEdges = new Map();
        const stats = { chapters: 0, blocks: 0, chars: 0, marks: 0, english: 0, lexicon: 0, occurrences: 0 };
        let order = 0;

        // 本书自身的章节 / 目录标题：书名号里出现这些，多半是书内文章互引，不算“别的书”
        const internalKeys = new Set();
        for (const chapter of book.chapters || []) {
          if (chapter.title) internalKeys.add(normalizeKey(chapter.title));
        }
        for (const entry of book.toc || []) {
          if (entry.label) internalKeys.add(normalizeKey(entry.label));
        }
        // 只有足够长、足够特殊的书名才做“无书名号”补充匹配：
        // 原则 / 免费 / 心流 这类两字词在普通行文里太容易误伤，只保留书名号来源。
        const lexiconEntries = [];
        for (const title of lexicon) {
          const latin = /^[\x20-\x7e]+$/.test(title);
          if (latin ? title.length < 4 : title.length < 3) continue;
          lexiconEntries.push({ title, latin });
        }
        for (const title of EN_LEXICON) {
          if (title.length < 4) continue;
          lexiconEntries.push({ title, latin: true });
        }

        function ensureBook(title) {
          const key = normalizeKey(title);
          if (!key) return null;
          if (selfKey && key === selfKey) return null;
          if (internalKeys.has(key)) return null;
          let record = byKey.get(key);
          if (!record) {
            record = {
              key,
              title,
              kind: '',
              author: '',
              count: 0,
              confidence: 'low',
              chapterIndexes: [],
              chapterTitles: [],
              first: null,
              contexts: [],
              sources: {},
              order: order++,
            };
            byKey.set(key, record);
          }
          return record;
        }

        function addOccurrence(record, source, confidence, chapter, block, text, start, end) {
          if (!record) return;
          record.count++;
          record.sources[source] = (record.sources[source] || 0) + 1;
          stats.occurrences++;
          const rank = { high: 3, medium: 2, low: 1 };
          if (record.count === 1 || rank[confidence] > rank[record.confidence]) record.confidence = confidence;
          if (!record.kind) {
            record.kind = source === 'lexicon' ? 'book' : looksLikeArticle(record.title, text, start, end) ? 'article' : 'book';
          }
          if (record.chapterIndexes.indexOf(chapter.index) < 0) {
            record.chapterIndexes.push(chapter.index);
            record.chapterTitles.push(chapter.title);
          }
          if (!record.first) {
            record.first = { chapterIndex: chapter.index, blockIndex: block.index, start, end };
          }
          if (!record.author) {
            const author = guessAuthor(text, start);
            if (author) record.author = author;
          }
          if (record.contexts.length < 4) {
            record.contexts.push({
              chapterIndex: chapter.index,
              chapterTitle: chapter.title,
              snippet: sentenceAround(text, start, end),
            });
          }
        }

        for (const chapter of book.chapters) {
          stats.chapters++;
          const chapterBooks = new Set();
          for (let blockIndex = 0; blockIndex < chapter.blocks.length; blockIndex++) {
            const block = { index: blockIndex, type: chapter.blocks[blockIndex].type, text: chapter.blocks[blockIndex].text };
            const text = block.text;
            stats.blocks++;
            stats.chars += text.length;
            const claimed = [];
            const inBlock = new Set();

            function overlaps(start, end) {
              for (const range of claimed) {
                if (start < range.end && end > range.start) return true;
              }
              return false;
            }

            // 1) 《书名》 —— 最高置信度
            MARK_RE.lastIndex = 0;
            let match;
            while ((match = MARK_RE.exec(text))) {
              const raw = match[1];
              const title = cleanTitle(raw);
              if (isExcludedTitle(title)) continue;
              const start = match.index;
              const end = match.index + match[0].length;
              claimed.push({ start, end });
              const record = ensureBook(title);
              if (!record) continue;
              stats.marks++;
              addOccurrence(record, 'mark', 'high', chapter, block, text, start, end);
              inBlock.add(record.key);
            }

            // 2) 英文书名：只在“book/novel… + 引号标题”这类明确写法里取，避免抓到歌名/曲名/普通引语
            const quotedRe = /(?:book|novel|memoir|biography|autobiography)\s+(?::\s*)?["“'‘]([^"”'’\n\r]{2,80})["”'’]/gi;
            while ((match = quotedRe.exec(text))) {
              const candidate = cleanTitle(match[1]);
              if (!looksLikeEnglishTitle(candidate)) continue;
              if (overlaps(match.index, match.index + match[0].length)) continue;
              const record = ensureBook(candidate);
              if (!record) continue;
              const start = match.index;
              const end = match.index + match[0].length;
              claimed.push({ start, end });
              stats.english++;
              addOccurrence(record, 'english', 'medium', chapter, block, text, start, end);
              inBlock.add(record.key);
            }
            // “titled/called ‘…’” 只有在同段前文确实提到 book/novel 等才采用
            const secondaryRe = /(?:titled|entitled|called)\s+(?::\s*)?["“'‘]([^"”'’\n\r]{2,80})["”'’]/gi;
            while ((match = secondaryRe.exec(text))) {
              const prefix = text.slice(Math.max(0, match.index - 90), match.index);
              if (!/\b(?:book|novel|memoir|biography|autobiography)\b/i.test(prefix)) continue;
              const candidate = cleanTitle(match[1]);
              if (!looksLikeEnglishTitle(candidate)) continue;
              if (overlaps(match.index, match.index + match[0].length)) continue;
              const record = ensureBook(candidate);
              if (!record) continue;
              const start = match.index;
              const end = match.index + match[0].length;
              claimed.push({ start, end });
              stats.english++;
              addOccurrence(record, 'english', 'medium', chapter, block, text, start, end);
              inBlock.add(record.key);
            }

            // 3) 经典书名补充匹配（低置信度，必须有紧邻线索；避免“历史记录”里的“史记”）
            for (const entry of lexiconEntries) {
              const hits = collectLexiconHits(text, entry.title, entry.latin);
              for (const hit of hits) {
                if (overlaps(hit.start, hit.end)) continue;
                const before = text.slice(Math.max(0, hit.start - 18), hit.start);
                const after = text.slice(hit.end, hit.end + 18);
                const cued = entry.latin ? EN_LEX_BEFORE.test(before) : ZH_LEX_BEFORE.test(before) || ZH_LEX_AFTER.test(after);
                if (!cued) continue;
                if (entry.latin && !isLatinTitleCased(text.slice(hit.start, hit.end))) continue;
                const record = ensureBook(entry.title);
                if (!record) continue;
                claimed.push({ start: hit.start, end: hit.end });
                stats.lexicon++;
                addOccurrence(record, 'lexicon', 'low', chapter, block, text, hit.start, hit.end);
                inBlock.add(record.key);
              }
            }

            // 同段共现 → 关系边（限制单段/全局规模，避免参考文献式段落产生平方级边）
            if (inBlock.size > 1 && edges.size < 4000) {
              const keys = Array.from(inBlock).sort().slice(0, 20);
              for (let i = 0; i < keys.length; i++) {
                for (let j = i + 1; j < keys.length; j++) {
                  if (edges.size >= 4000) break;
                  const edgeKey = keys[i] + '\u0000' + keys[j];
                  edges.set(edgeKey, (edges.get(edgeKey) || 0) + 1);
                }
              }
            }
            for (const key of inBlock) chapterBooks.add(key);
          }
          // 同章共现 → 弱关系边；每章最多取提及最多的 24 本，全局最多 4000 条
          if (chapterBooks.size > 1 && chapterEdges.size < 4000) {
            const keys = Array.from(chapterBooks)
              .map((key) => byKey.get(key))
              .filter(Boolean)
              .sort((a, b) => b.count - a.count)
              .slice(0, 24)
              .map((record) => record.key)
              .sort();
            for (let i = 0; i < keys.length; i++) {
              for (let j = i + 1; j < keys.length; j++) {
                if (chapterEdges.size >= 4000) break;
                const edgeKey = keys[i] + '\u0000' + keys[j];
                chapterEdges.set(edgeKey, (chapterEdges.get(edgeKey) || 0) + 1);
              }
            }
          }
        }

        const books = Array.from(byKey.values())
          .filter((record) => record.count > 0)
          .sort((a, b) => b.count - a.count || a.order - b.order);
        const edgeList = [];
        for (const [key, weight] of edges) {
          const parts = key.split('\u0000');
          edgeList.push({ source: parts[0], target: parts[1], weight });
        }
        edgeList.sort((a, b) => b.weight - a.weight);
        const chapterEdgeList = [];
        for (const [key, weight] of chapterEdges) {
          if (edges.has(key)) continue;
          const parts = key.split('\u0000');
          chapterEdgeList.push({ source: parts[0], target: parts[1], weight });
        }
        chapterEdgeList.sort((a, b) => b.weight - a.weight);
        return {
          version: 2,
          generatedAt: Date.now(),
          self: { title: book.meta.title, author: book.meta.author || '' },
          books,
          edges: edgeList,
          chapterEdges: chapterEdgeList,
          stats,
        };
      }



      /** 把一章压缩成「带编号的节选」给模型：短章全文，长章按段落前缀 + 隔段采样，默认 6000 字符。 */
      function buildAiBlocks(chapter, options) {
        const budget = Math.max(800, (options && options.budget) || 6000);
        const blocks = (chapter && chapter.blocks) || [];
        const entries = blocks.map((block, index) => ({ i: index, type: block.type, text: String(block.text || '') }));
        const total = entries.reduce((sum, item) => sum + item.text.length, 0);
        if (total <= budget) return { blocks: entries.map((item) => ({ i: item.i, text: item.text })), chars: total, truncated: false };
        let step = 1;
        let selected = [];
        let chars = 0;
        let shortened = false;
        for (let attempt = 0; attempt < 6; attempt++) {
          selected = [];
          chars = 0;
          shortened = false;
          for (let index = 0; index < entries.length; index += step) {
            const entry = entries[index];
            const heading = typeof entry.type === 'string' && entry.type.charAt(0) === 'h';
            const limit = heading ? 120 : 90;
            let text = entry.text;
            if (text.length > limit) {
              text = text.slice(0, limit) + '…';
              shortened = true;
            }
            if (chars + text.length > budget) {
              shortened = true;
              continue;
            }
            selected.push({ i: entry.i, text });
            chars += text.length;
          }
          if (chars <= budget) break;
          step *= 2;
        }
        return { blocks: selected, chars, truncated: shortened || selected.length < entries.length };
      }

      // ---- 书籍结构（核心观点 / 论据）--------------------------------------
      const STRUCTURE_CLAIM_RE = /(因此|所以|可见|这说明|这意味着|这表明|我认为|作者认为|核心|关键|本质|重要的是|总之|总结|结论|首要|首先|其次|第一|第二|原因在于|问题在于|我们要|必须|应该)/;
      const STRUCTURE_EVIDENCE_RE = /(例如|比如|譬如|举例|比方说|研究表明|研究显示|数据显示|据统计|数据表明|实验|调查|案例|例子|引用|正如|事实上|事实证明|根据|回忆|有一次|曾经|以.*为例)/;

      function trimSentence(text, limit) {
        const max = limit || 110;
        const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return '';
        const match = /^[\s\S]*?[。！？!?；;]/.exec(cleaned);
        let sentence = match ? match[0] : cleaned;
        if (sentence.length > max) sentence = sentence.slice(0, max) + '…';
        return sentence.trim();
      }

      function isHeadingBlock(block) {
        return Boolean(block && typeof block.type === 'string' && block.type.charAt(0) === 'h');
      }

      function isSubstantiveBlock(block) {
        return Boolean(block && block.text && String(block.text).replace(/\s+/g, '').length >= 16);
      }

      /**
       * 从篇章结构中提取「核心观点 → 分论点 → 论据」，全部带正文位置（章节 + 块号），
       * 供结构视图点击跳转。纯启发式：小标题优先，其次段落中的论证线索。
       */
      function buildStructure(book) {
        const chapters = [];
        let totalClaims = 0;
        let totalEvidence = 0;
        for (const chapter of (book && book.chapters) || []) {
          const blocks = chapter.blocks || [];
          const titleKey = normalizeKey(chapter.title);
          const headings = [];
          for (let index = 0; index < blocks.length; index++) {
            const block = blocks[index];
            if (!isHeadingBlock(block)) continue;
            if (index === 0 && normalizeKey(block.text) === titleKey) continue;
            headings.push({ index: index, text: block.text });
          }
          let claims = [];
          if (headings.length) {
            claims = headings.slice(0, 12).map((heading, order) => {
              const nextIndex = order + 1 < headings.length ? headings[order + 1].index : blocks.length;
              const evidence = [];
              for (let index = heading.index + 1; index < nextIndex && evidence.length < 3; index++) {
                const block = blocks[index];
                if (!isHeadingBlock(block) || !isSubstantiveBlock(block)) {
                  if (!isSubstantiveBlock(block) || isHeadingBlock(block)) continue;
                }
                const cue = STRUCTURE_EVIDENCE_RE.test(block.text);
                if (cue || evidence.length === 0) evidence.push({ text: trimSentence(block.text, 120), blockIndex: index, cue: cue });
              }
              return {
                kind: 'claim',
                text: trimSentence(heading.text, 90) || heading.text.slice(0, 90),
                blockIndex: heading.index,
                source: 'heading',
                evidence: evidence,
              };
            });
          } else {
            const candidates = [];
            for (let index = 0; index < blocks.length; index++) {
              const block = blocks[index];
              if (isHeadingBlock(block) || !isSubstantiveBlock(block)) continue;
              if (STRUCTURE_CLAIM_RE.test(block.text) || candidates.length === 0) candidates.push({ index: index, text: block.text });
              if (candidates.length >= 4) break;
            }
            claims = candidates.map((candidate, order) => {
              const nextIndex = order + 1 < candidates.length ? candidates[order + 1].index : blocks.length;
              const evidence = [];
              for (let index = candidate.index + 1; index < nextIndex && evidence.length < 3; index++) {
                const block = blocks[index];
                if (isHeadingBlock(block) || !isSubstantiveBlock(block)) continue;
                const cue = STRUCTURE_EVIDENCE_RE.test(block.text);
                if (cue || evidence.length === 0) evidence.push({ text: trimSentence(block.text, 120), blockIndex: index, cue: cue });
              }
              return {
                kind: 'claim',
                text: trimSentence(candidate.text, 90),
                blockIndex: candidate.index,
                source: 'paragraph',
                evidence: evidence,
              };
            });
          }
          if (!claims.length) {
            for (let index = 0; index < blocks.length; index++) {
              if (!isSubstantiveBlock(blocks[index])) continue;
              claims.push({ kind: 'claim', text: trimSentence(blocks[index].text, 90), blockIndex: index, source: 'lead', evidence: [] });
              break;
            }
          }
          if (!claims.length) {
            claims.push({ kind: 'claim', text: trimSentence(chapter.title, 90) || chapter.title, blockIndex: 0, source: 'title', evidence: [] });
          }
          const evidenceCount = claims.reduce((sum, claim) => sum + claim.evidence.length, 0);
          totalClaims += claims.length;
          totalEvidence += evidenceCount;
          chapters.push({
            index: chapter.index,
            title: chapter.title,
            claims: claims,
            totals: { claims: claims.length, evidence: evidenceCount },
          });
        }
        return {
          version: 1,
          chapters: chapters,
          totals: { chapters: chapters.length, claims: totalClaims, evidence: totalEvidence },
        };
      }

      // ---- 阅读器高亮 ------------------------------------------------------
      function escapeRegExp(text) {
        return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }

      function buildHighlightRegex(mentions, options) {
        const opts = options || {};
        const minConfidence = opts.minConfidence || 'medium';
        const rank = { high: 3, medium: 2, low: 1 };
        const titles = [];
        const seen = new Set();
        for (const item of (mentions && mentions.books) || []) {
          if (rank[item.confidence] < rank[minConfidence]) continue;
          if (item.title.length < 2 && !CJK_RE.test(item.title)) continue;
          if (seen.has(item.title)) continue;
          seen.add(item.title);
          titles.push(item.title);
        }
        if (!titles.length) return null;
        titles.sort((a, b) => b.length - a.length);
        return new RegExp('(' + titles.map(escapeRegExp).join('|') + ')', 'g');
      }

      function splitHighlight(text, regex) {
        if (!regex) return [{ text, hit: false }];
        regex.lastIndex = 0;
        const pieces = [];
        let last = 0;
        let match;
        while ((match = regex.exec(text))) {
          if (match.index > last) pieces.push({ text: text.slice(last, match.index), hit: false });
          pieces.push({ text: match[0], hit: true });
          last = match.index + match[0].length;
        }
        if (last < text.length) pieces.push({ text: text.slice(last), hit: false });
        return pieces;
      }

      // ---- 导出 ------------------------------------------------------------
      function pad(value) {
        return value < 10 ? '0' + value : String(value);
      }

      function toMarkdown(book, mentions) {
        const meta = (book && book.meta) || {};
        const date = new Date();
        const stamp = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
        const lines = [];
        lines.push('# 《' + (meta.title || '未命名') + '》引书书单');
        lines.push('');
        if (meta.author) lines.push('- 作者：' + meta.author);
        lines.push('- 提取到：' + mentions.books.length + ' 本书');
        lines.push('- 生成时间：' + stamp);
        lines.push('- 工具：书脉 BookWeave · DSH 插件');
        lines.push('');
        lines.push('## 书单（按提及次数）');
        lines.push('');
        mentions.books.forEach((item, index) => {
          const confidence = item.confidence === 'low' ? '（疑似）' : '';
          const author = item.author ? ' · ' + item.author : '';
          const chapters = item.chapterTitles.length ? ' · 见于' + item.chapterTitles.slice(0, 3).map((title) => '《' + title + '》').join('') : '';
          lines.push(index + 1 + '. **《' + item.title + '》**' + confidence + author + ' · 提及 ' + item.count + ' 次' + chapters);
          for (const context of item.contexts.slice(0, 2)) {
            lines.push('   > ' + context.snippet);
          }
        });
        const titleByKey = new Map(mentions.books.map((item) => [item.key, item.title]));
        if (mentions.edges.length) {
          lines.push('');
          lines.push('## 同段共现');
          lines.push('');
          for (const edge of mentions.edges.slice(0, 40)) {
            const source = titleByKey.get(edge.source);
            const target = titleByKey.get(edge.target);
            if (!source || !target) continue;
            lines.push('- 《' + source + '》 ↔ 《' + target + '》 · 共现 ' + edge.weight + ' 次');
          }
        }
        if (Array.isArray(mentions.chapterEdges) && mentions.chapterEdges.length) {
          lines.push('');
          lines.push('## 同章讨论');
          lines.push('');
          for (const edge of mentions.chapterEdges.slice(0, 20)) {
            const source = titleByKey.get(edge.source);
            const target = titleByKey.get(edge.target);
            if (!source || !target) continue;
            lines.push('- 《' + source + '》 ↔ 《' + target + '》 · 同章 ' + edge.weight + ' 章');
          }
        }
        lines.push('');
        return lines.join('\n');
      }

      return {
        version: 1,
        openZip,
        parseEpub,
        extractMentions,
        buildStructure,
        buildAiBlocks,
        toMarkdown,
        buildHighlightRegex,
        splitHighlight,
        sentenceAround,
        normalizeKey,
        cleanTitle,
        isExcludedTitle,
        decodeBytes,
        htmlToBlocks,
        sniffCharset,
        LEXICON,
      };
    })();

    // =====================================================================
    // 2. UI
    // =====================================================================

    // ===== UI START =====

    // ---- 本机存储（IndexedDB：books 存正文，index 存书架摘要）--------------
    const DB_NAME = 'dsh-bookweave';
    const DB_VERSION = 3;
    let dbPromise = null;
    // IndexedDB 不可用时的会话内兜底：书签式存储失败仍然能读，只是刷新后需要重新导入。
    const memoryBooks = new Map();
    const memoryIndex = new Map();
    const memoryExcerpts = new Map();
    const memoryInsights = new Map();
    let idbDown = false;

    function memoryList() {
      return Array.from(memoryIndex.values()).sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
    }

    function markIdbDown() {
      idbDown = true;
      dbPromise = null;
    }

    function openDatabase() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          markIdbDown();
          reject(new Error('NO_IDB'));
          return;
        }
        let request;
        try {
          request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (error) {
          markIdbDown();
          reject(error);
          return;
        }
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('index')) db.createObjectStore('index', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('excerpts')) db.createObjectStore('excerpts', { keyPath: 'bookId' });
          if (!db.objectStoreNames.contains('insights')) db.createObjectStore('insights', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          markIdbDown();
          reject(request.error || new Error('IndexedDB 打开失败'));
        };
      });
      return dbPromise;
    }

    function idbRequest(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('存储操作失败'));
      });
    }

    function runTransaction(db, stores, mode, run) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        run(tx);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('保存失败'));
        tx.onabort = () => reject(tx.error || new Error('保存被中断'));
      });
    }

    async function dbList() {
      if (idbDown) return memoryList();
      try {
        const db = await openDatabase();
        const tx = db.transaction('index', 'readonly');
        const items = await idbRequest(tx.objectStore('index').getAll());
        return (items || []).sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
      } catch (error) {
        markIdbDown();
        return memoryList();
      }
    }

    async function dbGet(id) {
      if (idbDown) return memoryBooks.get(id) || null;
      try {
        const db = await openDatabase();
        const tx = db.transaction('books', 'readonly');
        return await idbRequest(tx.objectStore('books').get(id));
      } catch (error) {
        markIdbDown();
        return memoryBooks.get(id) || null;
      }
    }

    /** 返回是否成功写入本机数据库；false 表示只保存在本次会话的内存里。 */
    async function dbPut(record, summary) {
      if (idbDown) {
        memoryBooks.set(record.id, record);
        memoryIndex.set(record.id, summary);
        return false;
      }
      try {
        const db = await openDatabase();
        await runTransaction(db, ['books', 'index'], 'readwrite', (tx) => {
          tx.objectStore('books').put(record);
          tx.objectStore('index').put(summary);
        });
        return true;
      } catch (error) {
        markIdbDown();
        memoryBooks.set(record.id, record);
        memoryIndex.set(record.id, summary);
        return false;
      }
    }

    async function dbDelete(id) {
      memoryBooks.delete(id);
      memoryIndex.delete(id);
      memoryExcerpts.delete(id);
      if (idbDown) return false;
      try {
        const db = await openDatabase();
        await runTransaction(db, ['books', 'index', 'excerpts'], 'readwrite', (tx) => {
          tx.objectStore('books').delete(id);
          tx.objectStore('index').delete(id);
          tx.objectStore('excerpts').delete(id);
        });
        return true;
      } catch (error) {
        markIdbDown();
        return false;
      }
    }

    async function dbSaveSummary(id, patch) {
      const current = memoryIndex.get(id);
      if (current) memoryIndex.set(id, Object.assign({}, current, patch));
      if (idbDown) return false;
      try {
        const db = await openDatabase();
        await runTransaction(db, 'index', 'readwrite', (tx) => {
          const store = tx.objectStore('index');
          const read = store.get(id);
          read.onsuccess = () => {
            const value = read.result;
            if (value) store.put(Object.assign({}, value, patch));
          };
        });
        return true;
      } catch (error) {
        markIdbDown();
        return false;
      }
    }

    async function dbGetExcerpts(bookId) {
      const local = memoryExcerpts.get(bookId);
      if (idbDown) return local || [];
      try {
        const db = await openDatabase();
        const tx = db.transaction('excerpts', 'readonly');
        const record = await idbRequest(tx.objectStore('excerpts').get(bookId));
        return record && Array.isArray(record.items) ? record.items : [];
      } catch (error) {
        markIdbDown();
        return local || [];
      }
    }

    async function dbSaveExcerpts(bookId, items) {
      memoryExcerpts.set(bookId, items);
      if (idbDown) return false;
      try {
        const db = await openDatabase();
        await runTransaction(db, 'excerpts', 'readwrite', (tx) => {
          tx.objectStore('excerpts').put({ bookId, items, updatedAt: Date.now() });
        });
        return true;
      } catch (error) {
        markIdbDown();
        return false;
      }
    }

    async function dbGetInsight(key) {
      const local = memoryInsights.get(key);
      if (idbDown) return local || null;
      try {
        const db = await openDatabase();
        const tx = db.transaction('insights', 'readonly');
        const record = await idbRequest(tx.objectStore('insights').get(key));
        return record || local || null;
      } catch (error) {
        markIdbDown();
        return local || null;
      }
    }

    async function dbSaveInsight(record) {
      memoryInsights.set(record.key, record);
      if (idbDown) return false;
      try {
        const db = await openDatabase();
        await runTransaction(db, 'insights', 'readwrite', (tx) => {
          tx.objectStore('insights').put(record);
        });
        return true;
      } catch (error) {
        markIdbDown();
        return false;
      }
    }

    // ---- 小工具 -----------------------------------------------------------
    function hashBytes(bytes) {
      let hash = 0x811c9dc5;
      const step = bytes.length > 3000000 ? 7 : 1;
      for (let index = 0; index < bytes.length; index += step) {
        hash ^= bytes[index];
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return hash.toString(16) + '-' + bytes.length.toString(36);
    }

    function formatBytes(size) {
      if (!size) return '0 B';
      if (size < 1024) return size + ' B';
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
      return (size / 1024 / 1024).toFixed(1) + ' MB';
    }

    function cx() {
      const names = [];
      for (let index = 0; index < arguments.length; index++) {
        if (arguments[index]) names.push(arguments[index]);
      }
      return names.join(' ');
    }

    function coverColor(title) {
      let hash = 0;
      for (let index = 0; index < title.length; index++) hash = (hash * 31 + title.charCodeAt(index)) % 360;
      return hash;
    }

    const ZLIBRARY_HOME = 'https://z-library.sk/?ts=1216';

    /** Z-Library 只接受路径式搜索：/s/<query>。站点是跨域的，无法直接注入它的搜索框，
        所以用它的搜索 URL 让书名直接成为查询词（保留用户的 ts 参数）。 */
    function zLibrarySearchUrl(title) {
      const query = encodeURIComponent(String(title || '').trim()).replace(/%20/g, '+');
      if (!query) return ZLIBRARY_HOME;
      return 'https://z-library.sk/s/' + query + '?ts=1216';
    }

    function toSummary(record) {
      return {
        id: record.id,
        name: record.name,
        cover: record.cover || '',
        size: record.size,
        addedAt: record.addedAt,
        lastOpenedAt: record.lastOpenedAt,
        title: record.meta.title,
        author: record.meta.author,
        chapterCount: record.chapters.length,
        bookCount: record.mentions.books.filter((item) => item.kind !== 'article').length,
        articleCount: record.mentions.books.filter((item) => item.kind === 'article').length,
        mentionCount: record.mentions.stats.occurrences,
        progress: record.progress,
      };
    }

    function downloadText(filename, text) {
      try {
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.rel = 'noopener';
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
        return true;
      } catch (error) {
        return false;
      }
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (error) {
        /* ignore */
      }
      return false;
    }

    function friendlyError(error, t) {
      const message = String((error && error.message) || error || '');
      if (message === 'NO_IDB') return t('idbError');
      if (/Memory|memory|quota|Quota/.test(message)) return t('memoryError');
      return message || t('errorTitle');
    }

    // ---- 样式（只用 --dsw-alias-* 主题令牌）-------------------------------
    const STYLE = [
      '.bw-root{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;padding-top:calc(18px + var(--dsh-frame-top-clearance,0px));',
      '.bw-root--reader{padding-top:0}',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-family:inherit;position:relative;container-type:inline-size;overflow:hidden}',
      '.bw-root *,.bw-root *::before,.bw-root *::after{box-sizing:border-box}',
      '.bw-header{flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:0 20px 12px;min-height:40px}',
      '.bw-brand{display:flex;align-items:center;gap:10px;min-width:0}',
      '.bw-brand__mark{width:30px;height:30px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary)}',
      '.bw-brand__text{display:flex;flex-direction:column;min-width:0;line-height:1.25}',
      '.bw-brand__title{font-size:15px;font-weight:650}',
      '.bw-brand__sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52vw}',
      '.bw-header__spacer{flex:1 1 auto}',
      '.bw-spacer{flex:1 1 auto;min-width:0}',
      '.bw-btn{font:inherit;font-size:13px;line-height:18px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;text-decoration:none}',
      '.bw-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.bw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.bw-btn[disabled]{opacity:.5;cursor:default}',
      '.bw-btn--primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.bw-btn--primary:hover{background:var(--dsw-alias-brand-primary);filter:brightness(1.07)}',
      '.bw-btn--ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}',
      '.bw-btn--ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.bw-btn--sm{height:26px;padding:0 8px;font-size:12px}',
      '.bw-btn--icon{width:30px;padding:0;justify-content:center}',
      '.bw-actions{display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:6px;flex:none}',
      '.bw-main{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;padding:0 20px 14px}',
      '.bw-hero{border:1.5px dashed var(--dsw-alias-border-l2);border-radius:14px;padding:26px 20px;text-align:center;background:var(--dsw-alias-bg-layer-1);transition:border-color .15s,background .15s}',
      '.bw-hero--drag{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.bw-hero__title{font-size:15px;font-weight:650;margin:0 0 6px}',
      '.bw-hero__desc{font-size:12.5px;color:var(--dsw-alias-label-secondary);margin:0 auto 16px;line-height:1.75;max-width:560px}',
      '.bw-hero__hint{margin-top:12px;font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.7}',
      '.bw-features{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;justify-content:center}',
      '.bw-feature{flex:1 1 170px;max-width:230px;text-align:left;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-base)}',
      '.bw-feature__title{font-size:12.5px;font-weight:600;margin-bottom:3px}',
      '.bw-feature__text{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.65}',
      '.bw-version{flex:none;padding:6px 2px 0;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.75}',
      '.bw-section-head{display:flex;align-items:center;gap:8px;margin:20px 0 10px}',
      '.bw-section-head h2{font-size:13.5px;font-weight:650;margin:0;line-height:1.4}',
      '.bw-section-head span{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.bw-library{flex:1 1 auto;min-height:0;overflow:auto;padding-right:2px}',
      '.bw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,168px));gap:12px;padding-bottom:10px}',
      '.bw-card{position:relative;display:flex;flex-direction:column;gap:6px;text-align:left;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);',
      'border-radius:12px;padding:10px;cursor:pointer;font:inherit;color:inherit;transition:border-color .15s,transform .15s}',
      '.bw-card:hover{border-color:var(--dsw-alias-border-l2);transform:translateY(-1px)}',
      '.bw-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.bw-card__cover{aspect-ratio:2 / 3;border-radius:8px;padding:12px 14px 14px;display:flex;flex-direction:column;justify-content:flex-end;color:#fff;overflow:hidden;position:relative;background:var(--dsw-alias-bg-layer-2);box-shadow:inset 5px 0 0 rgba(0,0,0,.18), inset 0 0 0 1px rgba(255,255,255,.05)}',
      '.bw-card__cover--image{padding:0}',
      '.bw-card__cover-img{width:100%;height:100%;object-fit:cover;display:block}',
      '.bw-card__cover-title{font-size:15px;font-weight:650;line-height:1.35;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.bw-card__author{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bw-card__progress{font-size:11px;color:var(--dsw-alias-brand-primary);line-height:1.5;font-variant-numeric:tabular-nums}',
      '.bw-card__title{font-size:13px;font-weight:600;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.bw-card__meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6;display:flex;flex-wrap:wrap;gap:4px 8px}',
      '.bw-card__bar{height:3px;border-radius:99px;background:var(--dsw-alias-border-l1);overflow:hidden}',
      '.bw-card__bar i{display:block;height:100%;background:var(--dsw-alias-brand-primary);border-radius:99px}',
      '.bw-card__del{position:absolute;top:6px;right:6px;height:22px;padding:0 7px;font-size:11px;border-radius:6px;border:0;cursor:pointer;',
      'background:rgba(15,17,21,.55);color:#fff;opacity:0;transition:opacity .15s}',
      '.bw-card:hover .bw-card__del,.bw-card__del:focus-visible{opacity:1}',
      '.bw-reader{flex:1 1 auto;min-height:0;display:flex;gap:12px;position:relative}',
      '.bw-toc{flex:0 0 208px;min-height:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.bw-toc__head{padding:10px 12px;font-size:11.5px;font-weight:650;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);letter-spacing:.02em}',
      '.bw-toc__list{flex:1 1 auto;overflow:auto;padding:6px}',
      '.bw-toc__item{width:100%;text-align:left;font:inherit;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);background:transparent;border:0;border-radius:7px;padding:7px 8px;display:flex;gap:6px;align-items:flex-start;cursor:pointer}',
      '.bw-toc__item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.bw-toc__item--active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);font-weight:650}',
      '.bw-toc__item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.bw-toc__label{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.bw-toc__dot{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;padding-top:1px}',
      '.bw-center{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;position:relative}',
      '.bw-center__scroll{flex:1 1 auto;overflow:auto;padding:14px 34px 36px;scroll-behavior:smooth}',
      '.bw-center__foot{flex:none;display:flex;align-items:center;gap:8px;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.bw-prose{max-width:720px;margin:0 auto;font-family:"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,"Times New Roman",serif;font-size:calc(16px * var(--bw-scale,1));line-height:1.95;word-break:break-word}',
      '.bw-prose p{margin:0 0 14px}.bw-prose p.bw-prose__cjk{text-indent:2em}',
      '.bw-prose h1,.bw-prose h2,.bw-prose h3,.bw-prose h4{margin:26px 0 14px;line-height:1.4;font-family:inherit}',
      '.bw-prose h1{font-size:1.5em}.bw-prose h2{font-size:1.28em}.bw-prose h3{font-size:1.12em}.bw-prose h4{font-size:1em}',
      '.bw-prose blockquote{margin:0 0 14px;padding:2px 0 2px 14px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.bw-prose li{margin:0 0 6px;list-style:none}',
      '.bw-prose pre{white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88em;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px 12px;margin:0 0 14px;overflow-x:auto}',
      '.bw-hit{font:inherit;color:inherit;background:transparent;border:0;padding:0;margin:0;cursor:pointer;border-bottom:1.5px dotted var(--dsw-alias-brand-primary);line-height:inherit}',
      '.bw-hit:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);border-radius:3px}',
      '.bw-hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-radius:3px}',
      '.bw-rail{flex:0 0 326px;min-height:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.bw-rail__head{padding:10px 12px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.bw-rail__title{font-size:13px;font-weight:650;line-height:1.45}',
      '.bw-rail__meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;line-height:1.6}',
      '.bw-tabs{display:flex;gap:4px;padding:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.bw-tab{flex:1;font:inherit;font-size:12.5px;height:28px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.bw-tab:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.bw-tab--active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:650}',
      '.bw-rail__body{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px 14px}',
      '.bw-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px}',
      '.bw-toolbar--search .bw-search{width:100%;flex:1 1 100%}',
      '.bw-toolbar--search{margin-bottom:6px}',
      '.bw-search{flex:1 1 110px;min-width:0;height:28px;font:inherit;font-size:12px;padding:0 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.bw-search:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.bw-chip{font:inherit;font-size:11.5px;height:24px;padding:0 8px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.bw-chip:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.bw-chip--on{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.bw-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}',
      '.bw-item{border-radius:9px;border:1px solid transparent;padding:7px 8px;cursor:pointer;transition:background .12s,border-color .12s}',
      '.bw-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.bw-item--active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}',
      '.bw-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.bw-item__head{display:flex;gap:7px;align-items:baseline;min-width:0}',
      '.bw-item__index{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;width:16px}',
      '.bw-item__main{min-width:0;flex:1}',
      '.bw-item__title{font-size:12.5px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary);display:block;word-break:break-word}',
      '.bw-item__meta{display:flex;flex-wrap:wrap;gap:3px 7px;margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.55}',
      '.bw-count{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.bw-badge{display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:4px;font-size:10px;font-weight:650;line-height:16px;vertical-align:1px}',
      '.bw-badge--warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.bw-badge--muted{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.bw-detail{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1)}',
      '.bw-context{margin:0 0 6px;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);word-break:break-word;white-space:pre-wrap}',
      '.bw-context strong{color:var(--dsw-alias-label-primary);font-weight:650}',
      '.bw-detail__actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}',
      '.bw-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:40px 18px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.7}',
      '.bw-empty__title{font-size:13.5px;font-weight:650;color:var(--dsw-alias-label-primary)}',
      '.bw-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-bg-base) 72%,transparent);backdrop-filter:blur(1.5px);z-index:20}',
      '.bw-busy{min-width:270px;max-width:min(420px,86%);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:18px 20px;box-shadow:0 8px 28px rgba(0,0,0,.18)}',
      '.bw-busy__title{font-size:13.5px;font-weight:650;margin-bottom:8px;word-break:break-word}',
      '.bw-busy__stage{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:10px}',
      '.bw-busy__bar{height:4px;border-radius:99px;background:var(--dsw-alias-border-l1);overflow:hidden}',
      '.bw-busy__bar i{display:block;height:100%;background:var(--dsw-alias-brand-primary);border-radius:99px;transition:width .25s}',
      '.bw-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);',
      'border-radius:9px;padding:8px 14px;font-size:12.5px;box-shadow:0 6px 20px rgba(0,0,0,.18);z-index:30;max-width:80%;text-align:center}',
      '.bw-error{display:flex;align-items:flex-start;gap:10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:10px 12px;margin-bottom:10px;',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.65}',
      '.bw-error__body{flex:1;min-width:0;word-break:break-word}',
      '.bw-error__title{font-weight:650;color:var(--dsw-alias-state-error-primary);margin-bottom:2px}',
      '.bw-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
      '@container (max-width:900px){.bw-toc{position:absolute;left:0;top:0;bottom:0;width:232px;z-index:6;box-shadow:8px 0 22px rgba(0,0,0,.14)}}',
      '@container (max-width:980px){.bw-rail{position:absolute;right:0;top:0;bottom:0;width:min(92%,340px);z-index:6;box-shadow:-8px 0 22px rgba(0,0,0,.14)}}',
      '@container (max-width:640px){.bw-main{padding:0 12px 12px}.bw-center__scroll{padding:18px 14px 32px}.bw-brand__sub{display:none}}',
      '.bw-selbar{display:flex;gap:6px;padding:5px;border-radius:9px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 20px rgba(0,0,0,.18)}',
      '.bw-browser{position:absolute;inset:0;z-index:50;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);padding:calc(12px + var(--dsh-frame-top-clearance,0px)) 16px 12px}',
      '.bw-browser__bar{flex:none;display:flex;align-items:center;gap:6px;padding-bottom:8px}',
      '.bw-browser__url{flex:1 1 auto;min-width:0;height:30px;font:inherit;font-size:12.5px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.bw-browser__url:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.bw-browser__hintrow{flex:none;display:flex;align-items:center;gap:10px;padding:0 2px 8px;flex-wrap:wrap}',
      '.bw-browser__hint{flex:1 1 320px;font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.bw-browser__hintactions{display:flex;gap:6px;flex-wrap:wrap}',
      '.bw-browser__frame{flex:1 1 auto;min-height:0;width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.bw-excerpt-mark{background:transparent;color:inherit;border:0;padding:0;cursor:pointer;border-radius:0;text-decoration:underline;text-decoration-color:var(--dsw-alias-state-error-primary);text-decoration-thickness:2px;text-underline-offset:3px}',
      '.bw-excerpt-mark:hover{color:var(--dsw-alias-state-error-primary);text-decoration-thickness:3px;background:transparent}',
      '.bw-excerpt-mark:focus-visible{outline:2px solid var(--dsw-alias-state-error-primary);outline-offset:2px}',
      '.bw-excerpt__text{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-weight:500}',
      '.bw-note{width:100%;min-height:56px;margin:2px 0 6px;font:inherit;font-size:12px;line-height:1.6;padding:6px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);resize:vertical}',
      '.bw-note:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.bw-mode{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;flex:none}',
      '.bw-mode__btn{font:inherit;font-size:12px;height:28px;padding:0 10px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}',
      '.bw-mode__btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.bw-mode__btn--on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:650}',
      '.bw-mode__btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.bw-structure{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.bw-structure__head{flex:none;padding:12px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.bw-structure__title{font-size:14px;font-weight:650;line-height:1.4}',
      '.bw-structure__meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.bw-structure__hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px;line-height:1.6}',
      '.bw-structure__body{flex:1 1 auto;min-height:0;display:flex}',
      '.bw-structure__chapters{flex:0 0 208px;min-height:0;overflow:auto;padding:8px;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}',
      '.bw-structure__chapterbtn{display:flex;align-items:flex-start;gap:8px;width:100%;text-align:left;font:inherit;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);background:transparent;border:0;border-radius:8px;padding:7px 8px;cursor:pointer}',
      '.bw-structure__chapterbtn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.bw-structure__chapterbtn--active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);font-weight:650}',
      '.bw-structure__chapterbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.bw-structure__chapternum{flex:none;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;display:flex;align-items:center;justify-content:center;margin-top:1px}',
      '.bw-structure__chapterbtn--active .bw-structure__chapternum{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}',
      '.bw-structure__chaptertitle{flex:1 1 auto;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.bw-structure__chaptercount{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;margin-top:2px}',
      '.bw-structure__canvas{flex:1 1 auto;min-width:0;overflow:auto;padding:20px 24px 40px;background:var(--dsw-alias-bg-layer-1)}',
      '.bw-structure__book{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 14px;background:var(--dsw-alias-bg-layer-2);margin-bottom:16px}',
      '.bw-structure__booklabel{font-size:10.5px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary)}',
      '.bw-structure__booktitle{font-size:17px;font-weight:650;line-height:1.4;margin-top:2px;word-break:break-word}',
      '.bw-structure__bookmeta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}',
      '.bw-structure__chapter{position:relative;border-left:3px solid var(--dsw-alias-brand-primary);border-radius:10px;background:var(--dsw-alias-bg-base);border-top:1px solid var(--dsw-alias-border-l1);border-right:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);padding:10px 14px;margin-bottom:18px}',
      '.bw-structure__chapterlabel{font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.bw-structure__chaptertitlelink{font:inherit;font-size:14px;font-weight:650;line-height:1.45;text-align:left;background:none;border:0;padding:0;margin-top:2px;color:var(--dsw-alias-label-primary);cursor:pointer;word-break:break-word}',
      '.bw-structure__chaptertitlelink:hover{color:var(--dsw-alias-brand-primary)}',
      '.bw-structure__chaptermeta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px}',
      '.bw-structure__claims{position:relative;padding-left:22px}',
      '.bw-structure__claims::before{content:"";position:absolute;left:8px;top:2px;bottom:10px;width:2px;border-radius:2px;background:var(--dsw-alias-border-l2)}',
      '.bw-claim{position:relative;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;margin-bottom:12px}',
      '.bw-claim::before{content:"";position:absolute;left:-17px;top:18px;width:12px;height:2px;background:var(--dsw-alias-border-l2)}',
      '.bw-claim__head{display:flex;flex-direction:column;gap:4px}',
      '.bw-claim__badge{align-self:flex-start;display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-size:10px;font-weight:650}',
      '.bw-claim__text{font:inherit;font-size:13px;font-weight:600;line-height:1.55;text-align:left;background:none;border:0;padding:0;color:var(--dsw-alias-label-primary);cursor:pointer;word-break:break-word}',
      '.bw-claim__text:hover{color:var(--dsw-alias-brand-primary)}',
      '.bw-claim__text:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.bw-claim__loc{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.bw-claim__evidence{list-style:none;margin:8px 0 0;padding:0 0 0 12px;border-left:1px dashed var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:6px}',
      '.bw-evidence{display:flex;align-items:flex-start;gap:8px;width:100%;text-align:left;font:inherit;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;cursor:pointer}',
      '.bw-evidence:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.bw-evidence:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.bw-evidence__badge{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:650}',
      '.bw-evidence__text{flex:1 1 auto;min-width:0;word-break:break-word}',
      '.bw-claim__noevidence{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:6px}',
      '.bw-structure__ai{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}',
      '.bw-structure__aialt{font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.bw-structure__sectionlabel{font-size:11px;color:var(--dsw-alias-label-secondary);margin:18px 0 8px;letter-spacing:.02em}',
      '.bw-ai{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base);padding:12px 14px;margin-bottom:16px}',
      '.bw-ai--state{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.bw-ai--error{color:var(--dsw-alias-state-error-primary);justify-content:space-between}',
      '.bw-ai__spinner{width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;display:inline-block;animation:bw-spin .8s linear infinite}',
      '@keyframes bw-spin{to{transform:rotate(360deg)}}',
      '.bw-ai__head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
      '.bw-ai__badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-size:10px;font-weight:650}',
      '.bw-ai__meta{font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.bw-ai__truncated{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}',
      '.bw-ai__summary{margin:0 0 10px;font-size:13px;line-height:1.85;color:var(--dsw-alias-label-primary)}',
      '.bw-ai__label{font-size:11px;color:var(--dsw-alias-label-secondary);margin:8px 0 6px}',
      '.bw-ai__beats{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.bw-beat{width:100%;text-align:left;font:inherit;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;cursor:pointer}',
      '.bw-beat:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.bw-beat:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.bw-ai__claims .bw-claim{margin-bottom:8px}',
      '.bw-guide{display:flex;flex-direction:column;gap:10px}',
      '.bw-guide__chapterbar{display:flex;align-items:center;gap:6px}',
      '.bw-guide__select{flex:1 1 auto;min-width:0;height:28px;font:inherit;font-size:12px;padding:0 6px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.bw-guide__select:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.bw-guide__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.bw-guide__cost{font-size:10.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.bw-guide__retry{align-self:flex-start;font:inherit;font-size:11px;background:none;border:0;padding:0;color:var(--dsw-alias-state-error-primary);cursor:pointer;text-decoration:underline}',
      '.bw-guide__summary{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);padding:10px 12px}',
      '.bw-guide__summarylabel{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}',
      '.bw-guide__summary p{margin:0;font-size:12.5px;line-height:1.8;color:var(--dsw-alias-label-primary)}',
      '.bw-guide__hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.bw-guide__cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
      '.bw-gcard{display:flex;flex-direction:column;gap:4px;width:100%;text-align:left;font:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:9px;padding:8px 10px;cursor:pointer}',
      '.bw-gcard:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.bw-gcard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.bw-gcard__badge{align-self:flex-start;display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:650}',
      '.bw-gcard__text{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.bw-gcard__loc{font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.bw-gcard__evidence{display:flex;flex-direction:column;gap:4px;padding:4px 0 0 8px;margin-left:12px;border-left:1px dashed var(--dsw-alias-border-l2)}',
      '.bw-block{margin:0 -6px;padding:0 6px;border-radius:8px;transition:background .12s,box-shadow .12s}',
      '.bw-block--focus{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}',
      '.bw-block--flash{animation:bw-flash 1.6s ease}',
      '@keyframes bw-flash{0%{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}70%{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}100%{background:transparent}}',
      '.bw-arg{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);padding:10px;display:flex;flex-direction:column;gap:6px}',
      '.bw-arg__claim{display:flex;flex-direction:column;gap:4px}',
      '.bw-arg__badge{align-self:flex-start;display:inline-flex;align-items:center;height:17px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-size:10px;font-weight:650}',
      '.bw-arg__text{font:inherit;font-size:12.5px;font-weight:600;line-height:1.6;text-align:left;background:none;border:0;padding:0;color:var(--dsw-alias-label-primary);cursor:pointer;word-break:break-word}',
      '.bw-arg__text:hover{color:var(--dsw-alias-brand-primary)}',
      '.bw-arg__text:focus-visible,.bw-arg__ev:focus-visible,.bw-chain__text:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.bw-arg__link{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:10.5px;padding-left:6px}',
      '.bw-arg__arrow{width:0;height:0;border:5px solid transparent;border-bottom-color:var(--dsw-alias-brand-primary);margin-bottom:2px}',
      '.bw-arg__evidence{list-style:none;margin:0;padding:0 0 0 14px;position:relative;display:flex;flex-direction:column;gap:6px}',
      '.bw-arg__evidence::before{content:"";position:absolute;left:4px;top:0;bottom:8px;width:2px;border-radius:2px;background:var(--dsw-alias-border-l2)}',
      '.bw-arg__ev{position:relative;display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;font:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;cursor:pointer}',
      '.bw-arg__ev::before{content:"";position:absolute;left:-12px;top:16px;width:10px;height:2px;background:var(--dsw-alias-border-l2)}',
      '.bw-arg__ev:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.bw-arg__evbadge{align-self:flex-start;display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:650}',
      '.bw-arg__evtext{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.bw-arg__noevidence{font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.bw-chain{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}',
      '.bw-chain__item{position:relative;display:flex;gap:8px;padding-bottom:12px}',
      '.bw-chain__item:last-child{padding-bottom:0}',
      '.bw-chain__item::before{content:"";position:absolute;left:8px;top:20px;bottom:0;width:2px;border-radius:2px;background:var(--dsw-alias-border-l2)}',
      '.bw-chain__item:last-child::before{display:none}',
      '.bw-chain__node{flex:none;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-size:10px;display:flex;align-items:center;justify-content:center;margin-top:2px;z-index:1}',
      '.bw-chain__body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.bw-chain__text{font:inherit;font-size:12px;line-height:1.65;text-align:left;background:none;border:0;padding:0;color:var(--dsw-alias-label-primary);cursor:pointer;word-break:break-word}',
      '.bw-chain__text:hover{color:var(--dsw-alias-brand-primary)}',
      '.bw-gcard__quote{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.bw-gcard__quote--evidence{font-size:10.5px;margin-top:2px;flex-basis:100%}',
      '.bw-evidence{flex-wrap:wrap}',
      '.bw-guide__row{display:flex;align-items:center;gap:8px}',
      '.bw-guide__picker{position:relative;flex:1 1 auto;min-width:0}',
      '.bw-guide__chapterbtn{display:flex;align-items:center;gap:6px;width:100%;height:30px;padding:0 8px;font:inherit;font-size:12px;text-align:left;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.bw-guide__chapterbtn:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.bw-guide__chapterbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.bw-guide__chaptertext{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bw-guide__caret{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary)}',
      '.bw-guide__menu::before{content:"";position:absolute;left:0;right:0;top:-4px;height:4px}',
      '.bw-guide__menu{position:absolute;z-index:40;left:0;right:0;top:100%;max-height:300px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px;display:flex;flex-direction:column;gap:2px}',
      '.bw-guide__item{display:flex;align-items:center;gap:6px;width:100%;text-align:left;font:inherit;font-size:12px;background:transparent;border:0;border-radius:6px;padding:6px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.bw-guide__item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.bw-guide__item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.bw-guide__item--active{color:var(--dsw-alias-brand-primary);font-weight:650}',
      '.bw-guide__itemnum{flex:none;width:16px;font-size:10px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.bw-guide__itemtitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bw-guide__itemcount{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.bw-guide__status{font-size:10.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.bw-float{position:absolute;top:6px;z-index:25;display:flex;align-items:center;gap:2px;padding:3px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,transparent);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 4px 16px rgba(0,0,0,.12);backdrop-filter:blur(8px)}',
      '.bw-float--left{left:12px}',
      '.bw-float--right{right:12px}',
      '.bw-float__btn{font:inherit;font-size:11.5px;height:26px;padding:0 8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;cursor:pointer;white-space:nowrap}',
      '.bw-float__btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.bw-float__btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.bw-float__btn--primary{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.bw-masthead{padding:26px 0 10px}',
      '.bw-masthead__title{font-size:20px;font-weight:700;line-height:1.4;color:var(--dsw-alias-label-primary);letter-spacing:.01em}',
      '.bw-masthead__meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:5px}',
      '@media (hover:none){.bw-card__del{opacity:1}}',
    ].join('');

    function normalizeBrowserUrl(input) {
      const raw = String(input || '').trim();
      if (!raw) return '';
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
      return 'https://' + raw.replace(/^\/+/, '');
    }

    /** 插件内置浏览器：地址栏 + 历史 + iframe。跨域站点无法注入它的输入框，所以用 URL 表达搜索词。 */
    function BrowserPanel(props) {
      const t = props.t;
      const initial = normalizeBrowserUrl(props.initialUrl);
      const [history, setHistory] = React.useState([initial]);
      const [index, setIndex] = React.useState(0);
      const [draft, setDraft] = React.useState(initial);
      const [frameKey, setFrameKey] = React.useState(0);
      const [storageState, setStorageState] = React.useState('');
      const current = history[index] || initial;

      function go(delta) {
        const next = index + delta;
        if (next < 0 || next >= history.length) return;
        setIndex(next);
        setDraft(history[next]);
        setFrameKey((value) => value + 1);
      }

      function navigate(value) {
        const url = normalizeBrowserUrl(value);
        if (!url) return;
        const nextHistory = history.slice(0, index + 1).concat(url);
        setHistory(nextHistory);
        setIndex(nextHistory.length - 1);
        setDraft(url);
        setFrameKey((value) => value + 1);
      }

      React.useEffect(() => {
        function onKeyDown(event) {
          if (event.key === 'Escape') props.onClose();
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [props]);

      /** 嵌在三方 iframe 里的站点默认拿不到 Cookie；尝试 Storage Access API 授权。 */
      async function grantStorageAccess() {
        let origin = '';
        try {
          origin = new URL(current).origin;
        } catch (error) {
          origin = '';
        }
        try {
          if (origin && /^https:/i.test(origin) && typeof document !== 'undefined' && typeof document.requestStorageAccessFor === 'function') {
            await document.requestStorageAccessFor(origin);
            setStorageState('granted');
            setFrameKey((value) => value + 1);
            return;
          }
          setStorageState('unsupported');
        } catch (error) {
          setStorageState('denied');
        }
      }

      /** 独立顶层窗口不受第三方 Cookie 限制，登录/反爬最可靠。 */
      function openStandalone() {
        try {
          window.open(current, '_blank', 'noopener,noreferrer,popup=yes,width=1280,height=900');
        } catch (error) {
          /* ignore */
        }
      }

      return h(
        'section',
        { className: 'bw-browser', role: 'dialog', 'aria-label': t('browserTitle') },
        h(
          'header',
          { className: 'bw-browser__bar' },
          h('button', { type: 'button', className: 'bw-btn bw-btn--sm bw-btn--ghost bw-btn--icon', onClick: () => go(-1), disabled: index <= 0, 'aria-label': t('browserBack') }, '←'),
          h('button', { type: 'button', className: 'bw-btn bw-btn--sm bw-btn--ghost bw-btn--icon', onClick: () => go(1), disabled: index >= history.length - 1, 'aria-label': t('browserForward') }, '→'),
          h('button', { type: 'button', className: 'bw-btn bw-btn--sm bw-btn--ghost bw-btn--icon', onClick: () => setFrameKey((value) => value + 1), 'aria-label': t('browserReload') }, '⟳'),
          h('input', {
            className: 'bw-browser__url',
            type: 'text',
            value: draft,
            spellCheck: false,
            'aria-label': t('browserAddress'),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                navigate(draft);
              }
            },
          }),
          h('a', { className: 'bw-btn bw-btn--sm', href: current, target: '_blank', rel: 'noopener noreferrer' }, t('browserExternal')),
          h('button', { type: 'button', className: 'bw-btn bw-btn--sm bw-btn--ghost', onClick: props.onClose }, t('browserClose'))
        ),
        h(
          'div',
          { className: 'bw-browser__hintrow' },
          h(
            'span',
            { className: 'bw-browser__hint' },
            storageState === 'granted'
              ? t('browserCookiesGranted')
              : storageState === 'denied'
                ? t('browserCookiesDenied')
                : storageState === 'unsupported'
                  ? t('browserCookiesUnsupported')
                  : t('browserHint')
          ),
          h(
            'div',
            { className: 'bw-browser__hintactions' },
            h(
              'button',
              { type: 'button', className: 'bw-btn bw-btn--sm', onClick: grantStorageAccess, disabled: storageState === 'granted' },
              t('browserCookies')
            ),
            h('button', { type: 'button', className: 'bw-btn bw-btn--sm bw-btn--primary', onClick: openStandalone }, t('browserStandalone'))
          )
        ),
        h('iframe', {
          key: frameKey,
          className: 'bw-browser__frame',
          src: current,
          title: t('browserTitle'),
          referrerPolicy: 'no-referrer',
          sandbox:
            'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-downloads allow-storage-access-by-user-activation',
          allow: 'storage-access; clipboard-read; clipboard-write',
        })
      );
    }

    function formatExcerptTime(stamp) {
      try {
        const date = new Date(stamp);
        const pad = (value) => (value < 10 ? '0' + value : String(value));
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
      } catch (error) {
        return '';
      }
    }

    function ExcerptsPanel(props) {
      const t = props.t;
      const excerpts = props.excerpts || [];
      if (!excerpts.length) {
        return h(
          'div',
          { className: 'bw-empty' },
          h('div', { className: 'bw-empty__title' }, t('excerptEmptyTitle')),
          h('div', null, t('excerptEmptyText'))
        );
      }
      return h(
        'div',
        null,
        h('div', { className: 'bw-rail__meta' }, t('excerptMeta').replace('{count}', String(excerpts.length))),
        h(
          'ul',
          { className: 'bw-list' },
          excerpts.map((item, index) => {
            const selected = props.selectedId === item.id;
            return h(
              'li',
              {
                key: item.id,
                className: cx('bw-item', selected && 'bw-item--active'),
                role: 'button',
                tabIndex: 0,
                'aria-expanded': selected ? 'true' : 'false',
                onClick: () => props.onSelect(item.id),
                onKeyDown: (event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    props.onSelect(item.id);
                  }
                },
              },
              h(
                'div',
                { className: 'bw-item__head' },
                h('span', { className: 'bw-item__index' }, String(index + 1)),
                h(
                  'div',
                  { className: 'bw-item__main' },
                  h('span', { className: 'bw-item__title bw-excerpt__text' }, item.text),
                  h(
                    'span',
                    { className: 'bw-item__meta' },
                    item.chapterTitle ? h('span', null, item.chapterTitle) : null,
                    h('span', null, formatExcerptTime(item.createdAt)),
                    item.note ? h('span', null, t('excerptHasNote')) : null
                  )
                )
              ),
              selected
                ? h(
                    'div',
                    { className: 'bw-detail' },
                    h('textarea', {
                      className: 'bw-note',
                      value: item.note || '',
                      placeholder: t('excerptNotePlaceholder'),
                      'aria-label': t('excerptNote'),
                      onClick: (event) => event.stopPropagation(),
                      onChange: (event) => props.onNote(item.id, event.target.value),
                    }),
                    h(
                      'div',
                      { className: 'bw-detail__actions' },
                      h(
                        'button',
                        { type: 'button', className: 'bw-btn bw-btn--sm', onClick: (event) => { event.stopPropagation(); props.onLocate(item); } },
                        t('locate')
                      ),
                      h(
                        'button',
                        { type: 'button', className: 'bw-btn bw-btn--sm bw-btn--ghost', onClick: (event) => { event.stopPropagation(); props.onDelete(item.id); } },
                        t('delete')
                      )
                    )
                  )
                : null
            );
          })
        )
      );
    }

    function closestBlockElement(node) {
      let element = node && node.nodeType === 1 ? node : node && node.parentElement;
      while (element) {
        if (element.dataset && element.dataset.block !== undefined) return element;
        element = element.parentElement;
      }
      return null;
    }

    function selectionOffsetWithin(container, node, offset) {
      try {
        const range = document.createRange();
        range.selectNodeContents(container);
        if (node === container) {
          range.setEnd(container, Math.max(0, Math.min(offset, container.childNodes.length)));
        } else {
          range.setEnd(node, offset);
        }
        return range.toString().length;
      } catch (error) {
        return 0;
      }
    }

    function excerptRangesForBlock(excerpts, chapterIndex, blockIndex, textLength) {
      const ranges = [];
      for (const item of excerpts || []) {
        if (item.chapterIndex !== chapterIndex) continue;
        if (blockIndex < item.startBlock || blockIndex > item.endBlock) continue;
        const start = blockIndex === item.startBlock ? Math.max(0, Math.min(textLength, item.startOffset)) : 0;
        const end = blockIndex === item.endBlock ? Math.max(0, Math.min(textLength, item.endOffset)) : textLength;
        if (end > start) ranges.push({ start: start, end: end, id: item.id });
      }
      return ranges;
    }

    function renderBlockContent(text, highlight, excerptRanges, onMention, onExcerpt) {
      const bookHits = [];
      if (highlight) {
        highlight.lastIndex = 0;
        let match;
        while ((match = highlight.exec(text))) {
          if (!match[0]) break;
          bookHits.push({ start: match.index, end: match.index + match[0].length, title: match[0] });
        }
      }
      const ranges = [];
      for (const range of excerptRanges) ranges.push({ start: range.start, end: range.end, kind: 'excerpt', id: range.id });
      for (const hit of bookHits) {
        const inside = excerptRanges.some((range) => hit.start >= range.start && hit.end <= range.end);
        if (!inside) ranges.push({ start: hit.start, end: hit.end, kind: 'book', title: hit.title });
      }
      ranges.sort((a, b) => a.start - b.start || a.end - b.end);
      const nodes = [];
      let cursor = 0;
      let key = 0;
      for (const range of ranges) {
        if (range.start < cursor) continue;
        if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
        const slice = text.slice(range.start, range.end);
        if (range.kind === 'excerpt') {
          nodes.push(
            h(
              'mark',
              {
                key: 'x' + key++,
                className: 'bw-excerpt-mark',
                role: 'button',
                tabIndex: 0,
                title: slice,
                onClick: () => onExcerpt(range.id),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onExcerpt(range.id);
                  }
                },
              },
              slice
            )
          );
        } else {
          nodes.push(h('button', { key: 'b' + key++, type: 'button', className: 'bw-hit', onClick: () => onMention(range.title), title: range.title }, slice));
        }
        cursor = range.end;
      }
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes;
    }

    function StyleTag() {
      return h('style', null, STYLE);
    }

    // ---- 侧栏图标（16×16，1px 描边，跟随 currentColor）--------------------
    function SidebarIcon(props) {
      const size = (props && props.size) || 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: 'M8 3.4C6.9 2.5 5.5 2.1 4 2.1c-.4 0-.7.3-.7.7v7.5c0 .4.3.7.7.7 1.5 0 2.9.4 4 1.3' }),
        h('path', { d: 'M8 3.4c1.1-.9 2.5-1.3 4-1.3.4 0 .7.3.7.7v7.5c0 .4-.3.7-.7.7-1.5 0-2.9.4-4 1.3' }),
        h('path', { d: 'M8 3.6v8.7' }),
        h('circle', { cx: 4.6, cy: 5.9, r: 0.75, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 11.4, cy: 5.9, r: 0.75, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M5.35 5.9h5.3' })
      );
    }

    // ---- 主组件 -----------------------------------------------------------
    function App(props) {
      const t = props.t;
      const [library, setLibrary] = React.useState([]);
      const [ready, setReady] = React.useState(false);
      const [view, setView] = React.useState('library');
      const [record, setRecord] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState('');
      const [drag, setDrag] = React.useState(false);
      const [toast, setToast] = React.useState('');
      const [openingId, setOpeningId] = React.useState('');
      const [deleteId, setDeleteId] = React.useState('');
      const inputRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const progressRef = React.useRef(null);
      const progressTimerRef = React.useRef(null);
      const toastTimerRef = React.useRef(null);
      const deleteTimerRef = React.useRef(null);
      const aliveRef = React.useRef(true);
      const dragDepthRef = React.useRef(0);

      function notify(message) {
        setToast(message);
        if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(() => {
          toastTimerRef.current = null;
          if (aliveRef.current) setToast('');
        }, 2600);
      }

      function flushProgress() {
        if (progressTimerRef.current) {
          window.clearTimeout(progressTimerRef.current);
          progressTimerRef.current = null;
        }
        const pending = progressRef.current;
        progressRef.current = null;
        if (!pending) return;
        dbSaveSummary(pending.id, { progress: pending.progress, lastOpenedAt: Date.now() }).catch(() => {});
      }

      React.useEffect(() => {
        aliveRef.current = true;
        dbList()
          .then((items) => {
            if (!aliveRef.current) return;
            setLibrary(items);
            setReady(true);
          })
          .catch((cause) => {
            if (!aliveRef.current) return;
            setReady(true);
            setError(friendlyError(cause, t));
          });
        return () => {
          aliveRef.current = false;
          flushProgress();
          if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
          if (deleteTimerRef.current) window.clearTimeout(deleteTimerRef.current);
        };
        // eslint-disable-next-line
      }, []);

      function queueProgress(id, progress) {
        if (!id) return;
        progressRef.current = { id, progress };
        if (progressTimerRef.current) return;
        progressTimerRef.current = window.setTimeout(() => {
          progressTimerRef.current = null;
          const pending = progressRef.current;
          progressRef.current = null;
          if (pending) dbSaveSummary(pending.id, { progress: pending.progress, lastOpenedAt: Date.now() }).catch(() => {});
        }, 700);
      }

      async function openBook(id) {
        if (openingId) return;
        setError('');
        setOpeningId(id);
        try {
          const summary = library.find((item) => item.id === id);
          const stored = await dbGet(id);
          if (!stored) {
            dbDelete(id).catch(() => {});
            setOpeningId('');
            setError(t('openMissing'));
            setLibrary((current) => current.filter((item) => item.id !== id));
            return;
          }
          const progress = (summary && summary.progress) || stored.progress || { chapterIndex: 0, ratio: 0 };
          setRecord(Object.assign({}, stored, { progress }));
          setView('reader');
          if (summary) setLibrary((current) => current.map((item) => (item.id === id ? Object.assign({}, item, { lastOpenedAt: Date.now() }) : item)));
          dbSaveSummary(id, { lastOpenedAt: Date.now() }).catch(() => {});
        } catch (cause) {
          setError(friendlyError(cause, t));
        } finally {
          if (aliveRef.current) setOpeningId('');
        }
      }

      async function importFiles(fileList) {
        if (busy) return;
        const files = Array.prototype.slice.call(fileList || []).filter(Boolean);
        if (!files.length) {
          setError(t('notEpub'));
          notify(t('notEpub'));
          return;
        }
        const file = files[0];
        // 不再按扩展名先拒：让解析器给出真实原因（不是 EPUB / 损坏 / DRM 都有明确提示）
        const looksEpub = /\.epub$/i.test(file.name || '') || /epub/i.test(file.type || '');
        if (!looksEpub && typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-bookweave] selecting a non-.epub file, will try to parse anyway:', file.name, file.type);
        }
        if (file.size > 220 * 1024 * 1024) {
          setError(t('fileTooBig'));
          notify(t('fileTooBig'));
          return;
        }
        setError('');
        setBusy({ title: file.name, stage: t('stageUnzip'), ratio: 0.02 });
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const id = hashBytes(bytes);
          const existing = library.find((item) => item.id === id);
          if (existing && existing.cover) {
            setBusy(null);
            notify(t('alreadyImported'));
            await openBook(id);
            return;
          }
          const parsed = await Core.parseEpub(bytes, {
            onStage: (stage, ratio) => {
              if (!aliveRef.current) return;
              const label = stage === 'unzip' ? t('stageUnzip') : stage === 'manifest' ? t('stageManifest') : t('stageChapters');
              setBusy({ title: file.name, stage: label, ratio: 0.05 + ratio * 0.6 });
            },
          });
          const cover = parsed.cover || '';
          if (existing) {
            // 重新选择同一本书：只补封面，不动已存书单与阅读进度
            if (cover) {
              await dbSaveSummary(id, { cover: cover });
              if (aliveRef.current) {
                setLibrary((current) => current.map((item) => (item.id === id ? Object.assign({}, item, { cover: cover }) : item)));
                notify(t('coverUpdated'));
              }
            } else {
              notify(t('alreadyImported'));
            }
            setBusy(null);
            await openBook(id);
            return;
          }
          setBusy({ title: file.name, stage: t('stageExtract'), ratio: 0.72 });
          await new Promise((resolve) => window.setTimeout(resolve, 0));
          const mentions = Core.extractMentions(parsed);
          const now = Date.now();
          const nextRecord = {
            version: 1,
            id,
            name: file.name,
            size: bytes.length,
            addedAt: now,
            lastOpenedAt: now,
            meta: parsed.meta,
            toc: parsed.toc,
            chapters: parsed.chapters,
            mentions,
            stats: parsed.stats,
            progress: { chapterIndex: 0, ratio: 0 },
          };
          setBusy({ title: file.name, stage: t('stageSave'), ratio: 0.92 });
          const summary = toSummary(Object.assign({}, nextRecord, { cover: cover }));
          const persisted = await dbPut(nextRecord, summary);
          if (!aliveRef.current) return;
          setLibrary((current) => [summary].concat(current.filter((item) => item.id !== id)));
          setRecord(nextRecord);
          setView('reader');
          setBusy(null);
          if (!persisted) notify(t('idbError'));
          else {
            const found = mentions.books.filter((item) => item.kind !== 'article').length;
            notify(t('importDone').replace('{count}', String(found)));
          }
        } catch (cause) {
          if (!aliveRef.current) return;
          setBusy(null);
          const message = friendlyError(cause, t);
          setError(message);
          notify(message);
          if (typeof console !== 'undefined' && console.error) console.error('[dsh-bookweave] import failed', cause);
        }
      }

      function pickFile() {
        if (inputRef.current) inputRef.current.click();
      }

      async function removeBook(id) {
        if (deleteId !== id) {
          setDeleteId(id);
          if (deleteTimerRef.current) window.clearTimeout(deleteTimerRef.current);
          deleteTimerRef.current = window.setTimeout(() => {
            if (aliveRef.current) setDeleteId('');
          }, 3200);
          return;
        }
        if (deleteTimerRef.current) window.clearTimeout(deleteTimerRef.current);
        setDeleteId('');
        try {
          await dbDelete(id);
          setLibrary((current) => current.filter((item) => item.id !== id));
          notify(t('deleted'));
        } catch (cause) {
          setError(friendlyError(cause, t));
        }
      }

      function backToLibrary() {
        flushProgress();
        setView('library');
        setRecord(null);
        dbList()
          .then((items) => {
            if (aliveRef.current) setLibrary(items);
          })
          .catch(() => {});
      }

      function handleDrop(event) {
        event.preventDefault();
        dragDepthRef.current = 0;
        setDrag(false);
        if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) importFiles(event.dataTransfer.files);
      }

      function handleDragEnter(event) {
        event.preventDefault();
        dragDepthRef.current++;
        setDrag(true);
      }

      function handleDragLeave(event) {
        event.preventDefault();
        if (!event.relatedTarget) {
          dragDepthRef.current = 0;
          setDrag(false);
          return;
        }
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setDrag(false);
      }

      function handleDragOver(event) {
        event.preventDefault();
      }

      function exportBook() {
        if (!record) return;
        const markdown = Core.toMarkdown(record, record.mentions);
        const safeName = String(record.meta.title || 'book').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60);
        const filename = safeName + '-引书书单.md';
        if (downloadText(filename, markdown)) notify(t('exportDone').replace('{name}', filename));
        else copyText(markdown).then((ok) => notify(ok ? t('copied') : t('exportFailed')));
      }

      React.useEffect(() => {
        const node = rootRef.current;
        if (!node) return undefined;
        if (view !== 'reader') return undefined;
        let container = null;
        let originalPadding = null;
        function findContainer() {
          let parent = node.parentElement;
          while (parent && parent !== document.body && parent !== document.documentElement) {
            const style = window.getComputedStyle(parent);
            const pad = parseFloat(style.paddingTop || '0');
            const rect = parent.getBoundingClientRect();
            if (pad > 0 && rect.width > 240 && rect.height > 240) return parent;
            parent = parent.parentElement;
          }
          return null;
        }
        function clearFallback() {
          node.style.marginTop = '';
          node.style.height = '';
        }
        function measure() {
          const rect = node.getBoundingClientRect();
          const bottomGap = Math.max(0, window.innerHeight - rect.bottom);
          if (typeof console !== 'undefined' && console.info) {
            console.info('[dsh-bookweave] top gap:', Math.round(bottomGap), container ? String(container.className) : 'fallback');
          }
          if (!container) {
            container = findContainer();
            if (container) originalPadding = container.style.paddingTop;
          }
          if (container) {
            clearFallback();
            container.style.paddingTop = Math.max(0, Math.min(80, Math.round(bottomGap))) + 'px';
            return;
          }
          const current = parseFloat(node.style.marginTop) || 0;
          const pull = Math.max(0, Math.min(80, Math.round(rect.top - current - bottomGap)));
          node.style.marginTop = pull > 0 ? '-' + pull + 'px' : '';
          node.style.height = pull > 0 ? 'calc(100% + ' + pull + 'px)' : '';
        }
        measure();
        window.addEventListener('resize', measure);
        return () => {
          window.removeEventListener('resize', measure);
          if (container) container.style.paddingTop = originalPadding || '';
          clearFallback();
        };
      }, [view]);

      const reader =
        view === 'reader' && record
          ? h(ReaderView, {
              key: record.id,
              t: t,
              record: record,
              onBack: backToLibrary,
              onProgress: (progress) => queueProgress(record.id, progress),
              onNotify: notify,
              onExport: exportBook,
            })
          : null;

      return h(
        'div',
        {
          ref: rootRef,
          className: cx('bw-root', view === 'reader' && 'bw-root--reader'),
          onDrop: handleDrop,
          onDragEnter: handleDragEnter,
          onDragLeave: handleDragLeave,
          onDragOver: handleDragOver,
        },
        h(StyleTag),
        h(
          'input',
          {
            ref: inputRef,
            type: 'file',
            accept: '.epub,application/epub+zip',
            className: 'bw-sr',
            tabIndex: -1,
            'aria-hidden': 'true',
            onChange: (event) => {
              // 必须先快照：清空 input.value 会把 FileList 一起清空
              const picked = event.target.files ? Array.prototype.slice.call(event.target.files) : [];
              event.target.value = '';
              if (typeof console !== 'undefined' && console.info) {
                console.info('[dsh-bookweave] picked:', picked.map((file) => ({ name: file.name, type: file.type, size: file.size })));
              }
              if (!picked.length) {
                setError(t('notEpub'));
                notify(t('notEpub'));
                return;
              }
              importFiles(picked);
            },
          }
        ),
        error
          ? h('div', { style: { padding: '0 20px 8px' } }, h(ErrorBanner, { t: t, message: error, onDismiss: () => setError('') }))
          : null,
        reader ||
          h(
            React.Fragment,
            null,
            h(
              'header',
              { className: 'bw-header' },
              h(
                'div',
                { className: 'bw-brand' },
                h('div', { className: 'bw-brand__mark' }, h(SidebarIcon, { size: 22 })),
                h(
                  'div',
                  { className: 'bw-brand__text' },
                  h('span', { className: 'bw-brand__title' }, t('title')),
                  h('span', { className: 'bw-brand__sub' }, t('subtitle'))
                )
              ),
              h('div', { className: 'bw-spacer' }),
              h(
                'div',
                { className: 'bw-actions' },
                h(
                  'button',
                  { type: 'button', className: 'bw-btn bw-btn--primary', onClick: pickFile, disabled: Boolean(busy) },
                  h('span', { 'aria-hidden': 'true' }, '＋'),
                  t('import')
                )
              )
            ),
            h(
              'main',
              { className: 'bw-main' },
              library.length === 0
                ? h(
                    'section',
                    { className: cx('bw-hero', drag && 'bw-hero--drag') },
                    h('h1', { className: 'bw-hero__title' }, t('heroTitle')),
                    h('p', { className: 'bw-hero__desc' }, t('heroDesc')),
                    h(
                      'button',
                      { type: 'button', className: 'bw-btn bw-btn--primary', onClick: pickFile, disabled: Boolean(busy) },
                      t('chooseFile')
                    ),
                    h('div', { className: 'bw-hero__hint' }, t('privacy')),
                h('div', { className: 'bw-hero__hint' }, t('formatHint')),
                    h(
                      'div',
                      { className: 'bw-features' },
                      h('div', { className: 'bw-feature' }, h('div', { className: 'bw-feature__title' }, t('feature1Title')), h('div', { className: 'bw-feature__text' }, t('feature1Text'))),
                      h('div', { className: 'bw-feature' }, h('div', { className: 'bw-feature__title' }, t('feature2Title')), h('div', { className: 'bw-feature__text' }, t('feature2Text'))),
                      h('div', { className: 'bw-feature' }, h('div', { className: 'bw-feature__title' }, t('feature3Title')), h('div', { className: 'bw-feature__text' }, t('feature3Text')))
                    )
                  )
                : null,
              h(
                'div',
                { className: 'bw-section-head', style: library.length === 0 ? { marginTop: 12 } : undefined },
                h('h2', null, t('library')),
                h('span', null, ready ? t('libraryMeta').replace('{books}', String(library.length)).replace('{mentions}', String(library.reduce((sum, item) => sum + (item.mentionCount || 0), 0))) : t('loading'))
              ),
              h(
                'div',
                { className: 'bw-library' },
                library.length
                  ? h(
                      'div',
                      { className: 'bw-grid' },
                      library.map((item) =>
                        h(BookCard, {
                          key: item.id,
                          t: t,
                          item: item,
                          opening: openingId === item.id,
                          deleting: deleteId === item.id,
                          onOpen: () => openBook(item.id),
                          onDelete: (event) => {
                            event.stopPropagation();
                            removeBook(item.id);
                          },
                        })
                      )
                    )
                  : h('div', { className: 'bw-empty' }, h('div', { className: 'bw-empty__title' }, t('libraryEmptyTitle')), h('div', null, t('libraryEmptyText')))
              ),
              h('div', { className: 'bw-version' }, '书脉 BookWeave v' + CLIENT_VERSION)
            )
          ),
        busy
          ? h(
              'div',
              { className: 'bw-overlay' },
              h(
                'div',
                { className: 'bw-busy', role: 'status', 'aria-live': 'polite' },
                h('div', { className: 'bw-busy__title' }, busy.title),
                h('div', { className: 'bw-busy__stage' }, busy.stage),
                h('div', { className: 'bw-busy__bar' }, h('i', { style: { width: Math.round((busy.ratio || 0) * 100) + '%' } }))
              )
            )
          : null,
        toast ? h('div', { className: 'bw-toast', role: 'status', 'aria-live': 'polite' }, toast) : null
      );
    }

    function ErrorBanner(props) {
      return h(
        'div',
        { className: 'bw-error', role: 'alert' },
        h(
          'div',
          { className: 'bw-error__body' },
          h('div', { className: 'bw-error__title' }, props.t('errorTitle')),
          h('div', null, props.message)
        ),
        h('button', { type: 'button', className: 'bw-btn bw-btn--sm bw-btn--ghost', onClick: props.onDismiss }, props.t('dismiss'))
      );
    }

    function BookCard(props) {
      const t = props.t;
      const item = props.item;
      const color = coverColor(item.title || item.name || '');
      const percent = item.progress && item.chapterCount
        ? Math.max(0, Math.min(100, Math.round((((item.progress.chapterIndex || 0) + (item.progress.ratio || 0)) / Math.max(1, item.chapterCount)) * 100)))
        : 0;
      return h(
        'div',
        {
          className: 'bw-card',
          role: 'button',
          tabIndex: 0,
          'aria-disabled': props.opening ? 'true' : undefined,
          'aria-label': t('openBook').replace('{title}', item.title || item.name),
          onClick: props.opening ? undefined : props.onOpen,
          onKeyDown: (event) => {
            if (props.opening) return;
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              props.onOpen();
            }
          },
        },
        h(
          'div',
          {
            className: cx('bw-card__cover', item.cover && 'bw-card__cover--image'),
            style: item.cover ? undefined : { background: 'linear-gradient(135deg,hsl(' + color + ' 46% 46%),hsl(' + ((color + 42) % 360) + ' 52% 32%))' },
          },
          item.cover
            ? h('img', { className: 'bw-card__cover-img', src: item.cover, alt: '', loading: 'lazy' })
            : h('div', { className: 'bw-card__cover-title' }, item.title || t('untitled'))
        ),
        h('div', { className: 'bw-card__title' }, item.title || t('untitled')),
        h('div', { className: 'bw-card__author' }, item.author || t('unknownAuthor')),
        h('div', { className: 'bw-card__progress' }, t('progressMeta').replace('{percent}', String(percent))),
        h(
          'button',
          {
            type: 'button',
            className: 'bw-card__del',
            'aria-label': props.deleting ? t('confirmDelete') : t('delete') + ' ' + (item.title || ''),
            onClick: props.onDelete,
          },
          props.deleting ? t('confirmDelete') : t('delete')
        )
      );
    }

    function ReaderView(props) {
      const t = props.t;
      const record = props.record;
      const mentions = record.mentions;
      const chapters = record.chapters;
      const initial = record.progress || { chapterIndex: 0, ratio: 0 };
      const [chapterIndex, setChapterIndex] = React.useState(() => Math.min(Math.max(0, initial.chapterIndex | 0), Math.max(0, chapters.length - 1)));
      const [showToc, setShowToc] = React.useState(false);
      const [showRail, setShowRail] = React.useState(true);
      const [structureChapter, setStructureChapter] = React.useState(0);
      const [insight, setInsight] = React.useState(null);
      const [sourceFocus, setSourceFocus] = React.useState(null);
      const [flashBlock, setFlashBlock] = React.useState(null);
      const flashTimerRef = React.useRef(null);
      const structureChapterRef = React.useRef(0);
      const [tab, setTab] = React.useState('guide');
      const [selectedKey, setSelectedKey] = React.useState('');
      const [scale, setScale] = React.useState(1);
      const [excerpts, setExcerpts] = React.useState([]);
      const [selectedExcerptId, setSelectedExcerptId] = React.useState('');
      const [pendingSelection, setPendingSelection] = React.useState(null);
      const [browserUrl, setBrowserUrl] = React.useState('');
      const scrollRef = React.useRef(null);
      const pendingRatioRef = React.useRef(initial.ratio || 0);
      const pendingBlockRef = React.useRef(-1);
      const chapter = chapters[chapterIndex] || chapters[0];
      const highlight = React.useMemo(() => Core.buildHighlightRegex(mentions, { minConfidence: 'medium' }), [record.id]);
      const byTitle = React.useMemo(() => {
        const map = new Map();
        for (const item of mentions.books) map.set(item.title, item);
        return map;
      }, [record.id]);
      const chapterMentions = React.useMemo(() => {
        const map = new Map();
        for (const item of mentions.books) {
          for (const index of item.chapterIndexes) map.set(index, (map.get(index) || 0) + 1);
        }
        return map;
      }, [record.id]);
      const structure = React.useMemo(() => Core.buildStructure(record), [record.id]);
      structureChapterRef.current = structureChapter;
      const aiChapter = chapters.find((item) => item.index === structureChapter) || chapters[0];
      const aiPreview = React.useMemo(
        () => (aiChapter ? Core.buildAiBlocks(aiChapter, { budget: 6000 }) : { blocks: [], chars: 0, truncated: false }),
        [aiChapter]
      );
      // 章节标题已经单独渲染，若首块是同一标题的 <h1> 就跳过，避免重复
      const visibleBlocks = React.useMemo(() => {
        const blocks = chapter.blocks || [];
        if (!blocks.length) return blocks;
        const first = blocks[0];
        if (first.type.charAt(0) === 'h' && Core.normalizeKey(first.text) === Core.normalizeKey(chapter.title)) {
          return blocks.slice(1);
        }
        return blocks;
      }, [chapter]);
      const blockOffset = (chapter.blocks || []).length - visibleBlocks.length;

      React.useEffect(() => {
        const node = scrollRef.current;
        if (!node) return undefined;
        const ratio = pendingRatioRef.current;
        const blockIndex = pendingBlockRef.current;
        pendingRatioRef.current = 0;
        pendingBlockRef.current = -1;
        const frame = window.requestAnimationFrame(() => {
          if (blockIndex >= 0) {
            const target = node.querySelector('[data-block="' + blockIndex + '"]');
            if (target && target.scrollIntoView) {
              target.scrollIntoView({ block: 'center' });
              return;
            }
          }
          const top = ratio > 0 ? Math.round(ratio * Math.max(0, node.scrollHeight - node.clientHeight)) : 0;
          try {
            node.scrollTo({ top: top, behavior: 'instant' });
          } catch (error) {
            node.scrollTop = top;
          }
        });
        return () => window.cancelAnimationFrame(frame);
      }, [chapterIndex]);

      React.useEffect(() => {
        if (tab !== 'guide') return undefined;
        let alive = true;
        const chapter = chapters[structureChapter] || chapters[0];
        if (!chapter) return undefined;
        const preview = Core.buildAiBlocks(chapter, { budget: 6000 });
        const signature = insightSignature(preview.blocks);
        setInsight((current) => (current && current.chapterIndex === structureChapter && current.signature === signature ? current : null));
        dbGetInsight(record.id + '|' + structureChapter)
          .then((cached) => {
            if (!alive || !cached || cached.signature !== signature) return;
            setInsight({
              chapterIndex: structureChapter,
              status: 'done',
              data: cached.result,
              model: cached.model || '',
              usage: cached.usage || null,
              chars: cached.chars || preview.chars,
              truncated: Boolean(cached.truncated),
              signature: signature,
              cached: true,
            });
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [tab, structureChapter, record.id]);

      React.useEffect(
        () => () => {
          if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
        },
        []
      );

      React.useEffect(() => {
        let alive = true;
        dbGetExcerpts(record.id)
          .then((items) => {
            if (alive && Array.isArray(items)) setExcerpts(items);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [record.id]);

      function handleScroll(event) {
        const node = event.currentTarget;
        const max = Math.max(1, node.scrollHeight - node.clientHeight);
        const ratio = Math.min(1, Math.max(0, node.scrollTop / max));
        props.onProgress({ chapterIndex: chapterIndex, ratio: ratio });
      }

      function commitExcerpts(next) {
        setExcerpts(next);
        dbSaveExcerpts(record.id, next).catch(() => {});
      }

      function clearSelection() {
        setPendingSelection(null);
        try {
          const selection = window.getSelection();
          if (selection) selection.removeAllRanges();
        } catch (error) {
          /* ignore */
        }
      }

      function handleSelection() {
        try {
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            setPendingSelection(null);
            return;
          }
          const range = selection.getRangeAt(0);
          const container = scrollRef.current;
          if (!container || !container.contains(range.commonAncestorContainer)) {
            setPendingSelection(null);
            return;
          }
          const startElement = closestBlockElement(range.startContainer);
          const endElement = closestBlockElement(range.endContainer);
          if (!startElement || !endElement) {
            setPendingSelection(null);
            return;
          }
          const text = String(selection.toString() || '').trim();
          if (text.length < 2) {
            setPendingSelection(null);
            return;
          }
          let rect = { top: 0, bottom: 0, left: 0, width: 0 };
          try {
            const measured = range.getBoundingClientRect();
            if (measured) rect = { top: measured.top, bottom: measured.bottom, left: measured.left, width: measured.width };
          } catch (error) {
            /* 某些环境（如 jsdom）没有 Range 布局信息 */
          }
          setPendingSelection({
            chapterIndex: chapterIndex,
            startBlock: Number(startElement.getAttribute('data-block')),
            startOffset: selectionOffsetWithin(startElement, range.startContainer, range.startOffset),
            endBlock: Number(endElement.getAttribute('data-block')),
            endOffset: selectionOffsetWithin(endElement, range.endContainer, range.endOffset),
            text: text,
            rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
          });
        } catch (error) {
          setPendingSelection(null);
        }
      }

      function saveSelectionAsExcerpt() {
        if (!pendingSelection) return;
        const excerpt = {
          id: 'ex-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          chapterIndex: pendingSelection.chapterIndex,
          chapterTitle: chapter.title,
          startBlock: pendingSelection.startBlock,
          startOffset: pendingSelection.startOffset,
          endBlock: pendingSelection.endBlock,
          endOffset: pendingSelection.endOffset,
          text: pendingSelection.text,
          note: '',
          createdAt: Date.now(),
        };
        commitExcerpts([excerpt].concat(excerpts));
        setSelectedExcerptId(excerpt.id);
        setTab('excerpts');
        setShowRail(true);
        clearSelection();
        if (props.onNotify) props.onNotify(t('excerptSaved'));
      }

      function deleteExcerpt(id) {
        commitExcerpts(excerpts.filter((item) => item.id !== id));
        if (selectedExcerptId === id) setSelectedExcerptId('');
      }

      function updateExcerptNote(id, note) {
        commitExcerpts(excerpts.map((item) => (item.id === id ? Object.assign({}, item, { note: note }) : item)));
      }

      function locateExcerpt(item) {
        if (!item) return;
        setSelectedExcerptId(item.id);
        setTab('excerpts');
        if (item.chapterIndex === chapterIndex) {
          const node = scrollRef.current;
          const target = node && node.querySelector('[data-block="' + item.startBlock + '"]');
          if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else {
          pendingRatioRef.current = 0;
          pendingBlockRef.current = item.startBlock;
          setChapterIndex(item.chapterIndex);
          props.onProgress({ chapterIndex: item.chapterIndex, ratio: 0 });
        }
      }

      function openSearch(title) {
        setBrowserUrl(zLibrarySearchUrl(title));
      }

      async function analyzeChapter() {
        const chapter = aiChapter;
        if (!chapter) return;
        if (insight && insight.status === 'loading' && insight.chapterIndex === structureChapter) return;
        const preview = Core.buildAiBlocks(chapter, { budget: 6000 });
        const signature = insightSignature(preview.blocks);
        const requestChapter = structureChapter;
        setInsight({ chapterIndex: requestChapter, status: 'loading', chars: preview.chars, truncated: preview.truncated, signature });
        try {
          const response = await fetch('/api/dsh-bookweave/analyze', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-bookweave': '1' },
            body: JSON.stringify({
              bookTitle: record.meta.title || '',
              author: record.meta.author || '',
              chapterTitle: chapter.title || '',
              blocks: preview.blocks,
            }),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok || !payload || payload.ok !== true) {
            const code = payload && payload.error;
            const message =
              code === 'llm-unavailable' || code === 'no-model'
                ? t('aiUnavailable')
                : code === 'bad-model-output'
                  ? t('aiBadOutput')
                  : (payload && payload.message) || t('aiError');
            if (structureChapterRef.current === requestChapter) {
              setInsight({ chapterIndex: requestChapter, status: 'error', error: message, chars: preview.chars, signature });
            }
            return;
          }
          const result = { mode: payload.mode, summary: payload.summary || '', beats: payload.beats || [], claims: payload.claims || [] };
          const record2 = {
            key: record.id + '|' + requestChapter,
            bookId: record.id,
            chapterIndex: requestChapter,
            signature: signature,
            result: result,
            model: payload.model || '',
            usage: payload.usage || null,
            chars: preview.chars,
            truncated: Boolean(payload.truncated),
            createdAt: Date.now(),
          };
          dbSaveInsight(record2).catch(() => {});
          if (structureChapterRef.current !== requestChapter) return;
          setInsight({
            chapterIndex: requestChapter,
            status: 'done',
            data: result,
            model: payload.model || '',
            usage: payload.usage || null,
            chars: preview.chars,
            truncated: Boolean(payload.truncated),
            signature: signature,
            cached: false,
          });
        } catch (error) {
          if (structureChapterRef.current === requestChapter) {
            setInsight({ chapterIndex: requestChapter, status: 'error', error: t('aiError'), chars: preview.chars, signature });
          }
        }
      }

      function flashSource(targetChapter, blockIndex) {
        setFlashBlock({ chapterIndex: targetChapter, blockIndex: blockIndex });
        if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = window.setTimeout(() => {
          flashTimerRef.current = null;
          setFlashBlock(null);
        }, 1800);
      }

      function jumpToBlock(targetChapter, blockIndex) {
        setSourceFocus(null);
        flashSource(targetChapter, blockIndex);
        if (targetChapter === chapterIndex) {
          const node = scrollRef.current;
          const target = node && node.querySelector('[data-block="' + blockIndex + '"]');
          if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return;
        }
        pendingRatioRef.current = 0;
        pendingBlockRef.current = blockIndex;
        setChapterIndex(targetChapter);
        props.onProgress({ chapterIndex: targetChapter, ratio: 0 });
      }

      function focusSource(next) {
        setSourceFocus(next);
      }

      function goChapter(next) {
        const target = Math.min(Math.max(0, next), chapters.length - 1);
        if (target === chapterIndex) return;
        pendingRatioRef.current = 0;
        pendingBlockRef.current = -1;
        setChapterIndex(target);
        setStructureChapter(target);
        props.onProgress({ chapterIndex: target, ratio: 0 });
      }

      function locate(item) {
        if (!item) return;
        setSelectedKey(item.key);
        setTab('list');
        const first = item.first;
        if (!first) return;
        if (first.chapterIndex === chapterIndex) {
          const node = scrollRef.current;
          const target = node && node.querySelector('[data-block="' + first.blockIndex + '"]');
          if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else {
          pendingRatioRef.current = 0;
          pendingBlockRef.current = first.blockIndex;
          setChapterIndex(first.chapterIndex);
          props.onProgress({ chapterIndex: first.chapterIndex, ratio: 0 });
        }
      }

      function onMention(label) {
        const item = byTitle.get(label);
        if (item) locate(item);
      }

      const foundBooks = mentions.books.filter((item) => item.kind !== 'article');
      return h(
        React.Fragment,
        null,
        h(
          'main',
          { className: 'bw-main', style: { paddingTop: 0 } },
          h(
            'div',
            { className: 'bw-reader' },
            showToc ? h(TocRail, { t: t, chapters: chapters, chapterIndex: chapterIndex, chapterMentions: chapterMentions, onSelect: goChapter }) : null,
            h(
              'section',
              { className: 'bw-center', style: { '--bw-scale': String(scale) } },
              h(
                'div',
                { className: 'bw-float bw-float--left' },
                h('button', { type: 'button', className: 'bw-float__btn', onClick: props.onBack }, '← ' + t('back'))
              ),
              h(
                'div',
                { className: 'bw-float bw-float--right' },
                h('button', { type: 'button', className: 'bw-float__btn', onClick: () => setShowToc((value) => !value), 'aria-pressed': showToc }, t('toc')),
                h('button', { type: 'button', className: 'bw-float__btn', onClick: () => setShowRail((value) => !value), 'aria-pressed': showRail }, t('insights')),
                h('button', { type: 'button', className: 'bw-float__btn', onClick: () => setScale((value) => Math.max(0.85, Math.round((value - 0.08) * 100) / 100)), 'aria-label': t('fontSmaller') }, 'A−'),
                h('button', { type: 'button', className: 'bw-float__btn', onClick: () => setScale((value) => Math.min(1.4, Math.round((value + 0.08) * 100) / 100)), 'aria-label': t('fontLarger') }, 'A＋'),
                h('button', { type: 'button', className: 'bw-float__btn bw-float__btn--primary', onClick: props.onExport }, t('export'))
              ),
              h(
                'div',
                { className: 'bw-center__scroll', ref: scrollRef, onScroll: handleScroll, onMouseUp: handleSelection, onMouseDown: () => { if (pendingSelection) setPendingSelection(null); }, tabIndex: 0, role: 'region', 'aria-label': record.meta.title || t('untitled') },
                h(
                  'div',
                  { className: 'bw-prose' },
                  h(
                    'div',
                    { className: 'bw-masthead' },
                    h('div', { className: 'bw-masthead__title' }, record.meta.title || t('untitled')),
                    h('div', { className: 'bw-masthead__meta' }, t('chapterPosition').replace('{current}', String(chapterIndex + 1)).replace('{total}', String(chapters.length)))
                  ),
                  h('h1', { style: { marginTop: 0 } }, chapter.title),
                  visibleBlocks.map((block, index) => {
                    const blockIndex = index + blockOffset;
                    const focused = sourceFocus && sourceFocus.chapterIndex === chapterIndex && sourceFocus.blockIndex === blockIndex;
                    const flashed = flashBlock && flashBlock.chapterIndex === chapterIndex && flashBlock.blockIndex === blockIndex;
                    return h(
                      'div',
                      { key: blockIndex, 'data-block': blockIndex, className: cx('bw-block', focused && 'bw-block--focus', flashed && 'bw-block--flash') },
                      h(ProseBlock, {
                        block: block,
                        blockIndex: blockIndex,
                        chapterIndex: chapterIndex,
                        excerpts: excerpts,
                        highlight: highlight,
                        onMention: onMention,
                        onExcerpt: (id) => {
                          setSelectedExcerptId(id);
                          setTab('excerpts');
                          setShowRail(true);
                        },
                      })
                    );
                  })
                )
              ),
              h(
                'div',
                { className: 'bw-center__foot' },
                h('button', { type: 'button', className: 'bw-btn bw-btn--sm', onClick: () => goChapter(chapterIndex - 1), disabled: chapterIndex <= 0 }, '‹ ' + t('prevChapter')),
                h('div', { className: 'bw-spacer' }),
                h('span', { className: 'bw-count' }, t('chapterPosition').replace('{current}', String(chapterIndex + 1)).replace('{total}', String(chapters.length))),
                h('div', { className: 'bw-spacer' }),
                h('button', { type: 'button', className: 'bw-btn bw-btn--sm', onClick: () => goChapter(chapterIndex + 1), disabled: chapterIndex >= chapters.length - 1 }, t('nextChapter') + ' ›')
              )
            ),
            showRail
              ? h(InsightsRail, {
                  t: t,
                  record: record,
                  mentions: mentions,
                  tab: tab,
                  setTab: setTab,
                  selectedKey: selectedKey,
                  onSelect: (key) => setSelectedKey((current) => (current === key ? '' : key)),
                  onLocate: locate,
                  onNotify: props.onNotify,
                  foundBooks: foundBooks,
                  excerpts: excerpts,
                  selectedExcerptId: selectedExcerptId,
                  onExcerptSelect: (id) => setSelectedExcerptId((current) => (current === id ? '' : id)),
                  onExcerptLocate: locateExcerpt,
                  onExcerptDelete: deleteExcerpt,
                  onExcerptNote: updateExcerptNote,
                  onSearch: openSearch,
                  structure: structure,
                  structureChapter: structureChapter,
                  onSelectChapter: (index) => {
                    setStructureChapter(index);
                    goChapter(index);
                  },
                  insight: insight,
                  onAnalyze: analyzeChapter,
                  aiChars: aiPreview.chars,
                  onGuideJump: jumpToBlock,
                  onFocusSource: focusSource,
                })
              : null
          )
        ),
        browserUrl ? h(BrowserPanel, { t: t, initialUrl: browserUrl, onClose: () => setBrowserUrl('') }) : null,
        pendingSelection
          ? h(
              'div',
              {
                className: 'bw-selbar',
                style: {
                  position: 'fixed',
                  left: Math.max(8, Math.min((typeof window !== 'undefined' ? window.innerWidth : 800) - 150, pendingSelection.rect.left)),
                  top: pendingSelection.rect.top > 56 ? pendingSelection.rect.top - 42 : pendingSelection.rect.bottom + 10,
                  zIndex: 70,
                },
                role: 'toolbar',
              },
              h(
                'button',
                { type: 'button', className: 'bw-btn bw-btn--sm bw-btn--primary', onMouseDown: (event) => event.preventDefault(), onClick: saveSelectionAsExcerpt },
                t('saveExcerpt')
              ),
              h(
                'button',
                { type: 'button', className: 'bw-btn bw-btn--sm bw-btn--ghost', onMouseDown: (event) => event.preventDefault(), onClick: clearSelection },
                t('cancel')
              )
            )
          : null
      );
    }

    function insightSignature(blocks) {
      let hash = 0x811c9dc5;
      for (const item of blocks) {
        const text = '#' + item.i + ':' + item.text;
        for (let index = 0; index < text.length; index++) {
          hash ^= text.charCodeAt(index);
          hash = Math.imul(hash, 0x01000193) >>> 0;
        }
      }
      return hash.toString(16) + '-' + blocks.length;
    }

    function GuidePanel(props) {
      const t = props.t;
      const structure = props.structure;
      const chapters = (structure && structure.chapters) || [];
      const [menuOpen, setMenuOpen] = React.useState(false);
      const pickerRef = React.useRef(null);
      const menuTimerRef = React.useRef(null);
      React.useEffect(() => {
        if (!menuOpen) return undefined;
        function onDocDown(event) {
          const node = pickerRef.current;
          if (node && !node.contains(event.target)) setMenuOpen(false);
        }
        document.addEventListener('mousedown', onDocDown);
        return () => document.removeEventListener('mousedown', onDocDown);
      }, [menuOpen]);
      React.useEffect(
        () => () => {
          if (menuTimerRef.current) window.clearTimeout(menuTimerRef.current);
        },
        []
      );
      if (!chapters.length) {
        return h(
          'div',
          { className: 'bw-empty' },
          h('div', { className: 'bw-empty__title' }, t('guideEmptyTitle')),
          h('div', null, t('guideEmptyText'))
        );
      }
      function openMenu() {
        if (menuTimerRef.current) {
          window.clearTimeout(menuTimerRef.current);
          menuTimerRef.current = null;
        }
        setMenuOpen(true);
      }
      function closeMenuSoon() {
        if (menuTimerRef.current) window.clearTimeout(menuTimerRef.current);
        menuTimerRef.current = window.setTimeout(() => {
          menuTimerRef.current = null;
          setMenuOpen(false);
        }, 450);
      }
      function closeMenuNow() {
        if (menuTimerRef.current) {
          window.clearTimeout(menuTimerRef.current);
          menuTimerRef.current = null;
        }
        setMenuOpen(false);
      }
      const current = chapters.find((item) => item.index === props.chapterIndex) || chapters[0];
      const chapterData = (props.record && (props.record.chapters || []).find((item) => item.index === current.index)) || null;
      const sourceBlocks = (chapterData && chapterData.blocks) || [];
      function sourceQuote(blockIndex) {
        const block = sourceBlocks[blockIndex];
        if (!block) return '';
        const text = String(block.text || '').replace(/\s+/g, ' ').trim();
        if (!text) return '';
        return text.length > 96 ? text.slice(0, 96) + '…' : text;
      }
      function focusSource(blockIndex) {
        if (typeof props.onFocusSource === 'function') props.onFocusSource(blockIndex === null ? null : { chapterIndex: current.index, blockIndex: blockIndex });
      }
      const ai = props.insight && props.insight.chapterIndex === current.index ? props.insight : null;
      const aiDone = ai && ai.status === 'done' && ai.data ? ai : null;
      const aiMode = aiDone && aiDone.data.mode;
      const summary = aiDone ? aiDone.data.summary || '' : '';
      const loading = Boolean(ai && ai.status === 'loading');
      const error = ai && ai.status === 'error' ? ai.error || t('aiError') : '';

      let cards = [];
      if (aiDone) {
        if (aiMode === 'fiction') {
          cards = (aiDone.data.beats || []).map((beat) => ({ kind: 'beat', text: beat.text, block: beat.block, evidence: [] }));
        } else {
          cards = (aiDone.data.claims || []).map((claim) => ({ kind: 'claim', text: claim.text, block: claim.block, evidence: claim.evidence || [] }));
        }
      }
      if (!cards.length) {
        cards = (current.claims || []).map((claim) => ({
          kind: 'claim',
          text: claim.text,
          block: claim.blockIndex,
          evidence: (claim.evidence || []).map((evidence) => ({ text: evidence.text, block: evidence.blockIndex })),
        }));
      }
      cards = cards.slice().sort((a, b) => a.block - b.block);

      function relationKey(relation) {
        if (relation === 'example') return 'relationExample';
        if (relation === 'data') return 'relationData';
        if (relation === 'authority') return 'relationAuthority';
        if (relation === 'contrast') return 'relationContrast';
        if (relation === 'definition') return 'relationDefinition';
        return 'relationReason';
      }
      function inferRelation(text) {
        const value = String(text || '');
        if (/例如|比如|譬如|举例|such as|for example/i.test(value)) return 'example';
        if (/数据显示|统计|数字|百分比|\d+%|survey|percent/i.test(value)) return 'data';
        if (/研究表明|研究显示|专家|学者|调查|study|research/i.test(value)) return 'authority';
        if (/相反|然而|但是|反例|however|in contrast/i.test(value)) return 'contrast';
        if (/是指|定义|意味着|defined|refers to/i.test(value)) return 'definition';
        if (/因为|由于|原因|because|since|due to/i.test(value)) return 'reason';
        return 'reason';
      }
      function relationLabel(evidence) {
        if (evidence && evidence.link) return String(evidence.link).slice(0, 24);
        return t(relationKey((evidence && evidence.relation) || inferRelation(evidence && evidence.text)));
      }

      return h(
        'section',
        { className: 'bw-guide', 'aria-label': t('guideTitle') },
        h(
          'div',
          { className: 'bw-guide__row' },
          h(
            'div',
            {
              className: 'bw-guide__picker',
              ref: pickerRef,
              onMouseEnter: openMenu,
              onMouseLeave: closeMenuSoon,
              onBlur: (event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) closeMenuSoon();
              },
            },
            h(
              'button',
              {
                type: 'button',
                className: 'bw-guide__chapterbtn',
                'aria-haspopup': 'listbox',
                'aria-expanded': menuOpen ? 'true' : 'false',
                'aria-label': t('guideChapter'),
                onClick: openMenu,
                onFocus: openMenu,
                onKeyDown: (event) => {
                  if (event.key === 'Escape') closeMenuNow();
                },
              },
              h('span', { className: 'bw-guide__chaptertext' }, '第 ' + (current.index + 1) + ' 章 · ' + (current.title || t('chapterFallback'))),
              h('span', { className: 'bw-guide__caret', 'aria-hidden': 'true' }, '▾')
            ),
            menuOpen
              ? h(
                  'div',
                  { className: 'bw-guide__menu', role: 'listbox', 'aria-label': t('guideChapter'), onMouseEnter: openMenu },
                  chapters.map((chapter) =>
                    h(
                      'button',
                      {
                        key: chapter.index,
                        type: 'button',
                        role: 'option',
                        'aria-selected': chapter.index === current.index ? 'true' : 'false',
                        className: cx('bw-guide__item', chapter.index === current.index && 'bw-guide__item--active'),
                        onClick: () => {
                          props.onSelectChapter(chapter.index);
                          closeMenuNow();
                        },
                      },
                      h('span', { className: 'bw-guide__itemnum' }, String(chapter.index + 1)),
                      h('span', { className: 'bw-guide__itemtitle' }, chapter.title || t('chapterFallback')),
                      h('span', { className: 'bw-guide__itemcount' }, String(chapter.totals.claims))
                    )
                  )
                )
              : null
          ),
          h('button', { type: 'button', className: 'bw-btn bw-btn--sm', onClick: props.onAnalyze, disabled: loading }, aiDone ? t('aiRerun') : t('aiRun'))
        ),
        h(
          'div',
          { className: 'bw-guide__status' },
          loading ? t('aiLoading') : error ? error : aiDone && ai.cached ? t('aiCached') : t('aiCost').replace('{chars}', String(props.aiChars || 0))
        ),
        h('div', { className: 'bw-guide__hint' }, t('guideSourceHint')),
        error ? h('button', { type: 'button', className: 'bw-guide__retry', onClick: props.onAnalyze }, t('aiRetry')) : null,
        summary
          ? h('div', { className: 'bw-guide__summary' }, h('div', { className: 'bw-guide__summarylabel' }, t('guideSummary')), h('p', null, summary))
          : h('div', { className: 'bw-guide__hint' }, loading ? t('aiLoading') : t('guideNoSummary')),
        aiDone && aiDone.truncated ? h('div', { className: 'bw-guide__hint' }, t('aiTruncated')) : null,
        cards.length
          ? aiMode === 'fiction'
            ? h(
                'ol',
                { className: 'bw-chain', 'aria-label': t('guidePlotChain') },
                cards.map((card, index) =>
                  h(
                    'li',
                    { key: 'beat-' + index, className: 'bw-chain__item' },
                    h('span', { className: 'bw-chain__node' }, String(index + 1)),
                    h(
                      'div',
                      { className: 'bw-chain__body' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'bw-chain__text',
                          onClick: () => props.onJump(current.index, card.block),
                          onMouseEnter: () => focusSource(card.block),
                          onMouseLeave: () => focusSource(null),
                          onFocus: () => focusSource(card.block),
                          onBlur: () => focusSource(null),
                        },
                        card.text
                      ),
                      sourceQuote(card.block) ? h('span', { className: 'bw-gcard__quote' }, '「' + sourceQuote(card.block) + '」') : null,
                      h('span', { className: 'bw-gcard__loc' }, t('guideOriginal') + ' · ' + t('structureLoc').replace('{chapter}', String(current.index + 1)).replace('{block}', String(card.block + 1)))
                    )
                  )
                )
              )
            : h(
                'ul',
                { className: 'bw-guide__cards bw-guide__cards--args' },
                cards.map((card, index) =>
                  h(
                    'li',
                    { key: 'arg-' + index, className: 'bw-arg' },
                    h(
                      'div',
                      { className: 'bw-arg__claim' },
                      h('span', { className: 'bw-arg__badge' }, t('guideConclusion')),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'bw-arg__text',
                          onClick: () => props.onJump(current.index, card.block),
                          onMouseEnter: () => focusSource(card.block),
                          onMouseLeave: () => focusSource(null),
                          onFocus: () => focusSource(card.block),
                          onBlur: () => focusSource(null),
                        },
                        card.text
                      ),
                      sourceQuote(card.block) ? h('span', { className: 'bw-gcard__quote' }, '「' + sourceQuote(card.block) + '」') : null,
                      h('span', { className: 'bw-gcard__loc' }, t('guideOriginal') + ' · ' + t('structureLoc').replace('{chapter}', String(current.index + 1)).replace('{block}', String(card.block + 1)))
                    ),
                    card.evidence.length
                      ? h(
                          'div',
                          { className: 'bw-arg__link', 'aria-hidden': 'true' },
                          h('span', { className: 'bw-arg__arrow' }),
                          h('span', { className: 'bw-arg__linklabel' }, t('guideBecause'))
                        )
                      : null,
                    card.evidence.length
                      ? h(
                          'ul',
                          { className: 'bw-arg__evidence', 'aria-label': t('structureEvidence') },
                          card.evidence.map((evidence, evidenceIndex) =>
                            h(
                              'li',
                              { key: 'ev-' + evidenceIndex },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'bw-arg__ev',
                                  onClick: () => props.onJump(current.index, evidence.block),
                                  onMouseEnter: () => focusSource(evidence.block),
                                  onMouseLeave: () => focusSource(null),
                                  onFocus: () => focusSource(evidence.block),
                                  onBlur: () => focusSource(null),
                                },
                                h('span', { className: 'bw-arg__evbadge' }, relationLabel(evidence)),
                                h('span', { className: 'bw-arg__evtext' }, evidence.text),
                                sourceQuote(evidence.block) ? h('span', { className: 'bw-gcard__quote bw-gcard__quote--evidence' }, '「' + sourceQuote(evidence.block) + '」') : null
                              )
                            )
                          )
                        )
                      : h('div', { className: 'bw-arg__noevidence' }, t('guideNoEvidence'))
                  )
                )
              )
          : h('div', { className: 'bw-guide__hint' }, t('guideNoCards'))
      );
    }

    function TocRail(props) {
      const t = props.t;
      return h(
        'nav',
        { className: 'bw-toc', 'aria-label': t('toc') },
        h('div', { className: 'bw-toc__head' }, t('tocHead').replace('{count}', String(props.chapters.length))),
        h(
          'div',
          { className: 'bw-toc__list' },
          props.chapters.map((chapter, index) => {
            const count = props.chapterMentions.get(index) || 0;
            return h(
              'button',
              {
                key: index,
                type: 'button',
                className: cx('bw-toc__item', index === props.chapterIndex && 'bw-toc__item--active'),
                onClick: () => props.onSelect(index),
                'aria-current': index === props.chapterIndex ? 'true' : undefined,
              },
              h('span', { className: 'bw-toc__label' }, chapter.title || t('chapterFallback')),
              count ? h('span', { className: 'bw-toc__dot', title: t('tocDot').replace('{count}', String(count)) }, String(count)) : null
            );
          })
        )
      );
    }

    function ProseBlock(props) {
      const block = props.block;
      const ranges = excerptRangesForBlock(props.excerpts, props.chapterIndex, props.blockIndex, block.text.length);
      const children = renderBlockContent(block.text, props.highlight, ranges, props.onMention, props.onExcerpt);
      const map = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', li: 'li', quote: 'blockquote', pre: 'pre' };
      const tag = map[block.type] || 'p';
      const isCjk = /[\u3400-\u9fff]/.test(block.text);
      return h(tag, { className: tag === 'p' && isCjk ? 'bw-prose__cjk' : undefined }, children);
    }

    function InsightsRail(props) {
      const t = props.t;
      const mentions = props.mentions;
      const foundBooks = props.foundBooks;
      const articles = mentions.books.length - foundBooks.length;
      const excerptCount = (props.excerpts || []).length;
      const structureTotals = (props.structure && props.structure.totals) || { chapters: 0, claims: 0, evidence: 0 };
      const head =
        props.tab === 'guide'
          ? h(
              'div',
              { className: 'bw-rail__head' },
              h('div', { className: 'bw-rail__title' }, t('guideTitle')),
              h('div', { className: 'bw-rail__meta' }, t('guideMeta').replace('{chapters}', String(structureTotals.chapters)).replace('{claims}', String(structureTotals.claims)))
            )
          : props.tab === 'excerpts'
            ? h(
                'div',
                { className: 'bw-rail__head' },
                h('div', { className: 'bw-rail__title' }, t('excerptsTitle').replace('{count}', String(excerptCount))),
                h('div', { className: 'bw-rail__meta' }, t('excerptsMeta'))
              )
            : h(
                'div',
                { className: 'bw-rail__head' },
                h('div', { className: 'bw-rail__title' }, t('mentionsTitle').replace('{count}', String(foundBooks.length))),
                h(
                  'div',
                  { className: 'bw-rail__meta' },
                  articles ? t('mentionsMetaArticles').replace('{count}', String(articles)) : t('mentionsMeta').replace('{count}', String(mentions.stats.occurrences))
                )
              );
      return h(
        'aside',
        { className: 'bw-rail', 'aria-label': t('insights') },
        head,
        h(
          'div',
          { className: 'bw-tabs', role: 'tablist' },
          h(
            'button',
            { type: 'button', role: 'tab', 'aria-selected': props.tab === 'guide', className: cx('bw-tab', props.tab === 'guide' && 'bw-tab--active'), onClick: () => props.setTab('guide') },
            t('tabGuide')
          ),
          h(
            'button',
            { type: 'button', role: 'tab', 'aria-selected': props.tab === 'excerpts', className: cx('bw-tab', props.tab === 'excerpts' && 'bw-tab--active'), onClick: () => props.setTab('excerpts') },
            t('tabExcerpts') + (excerptCount ? ' ' + excerptCount : '')
          ),
          h(
            'button',
            { type: 'button', role: 'tab', 'aria-selected': props.tab === 'list', className: cx('bw-tab', props.tab === 'list' && 'bw-tab--active'), onClick: () => props.setTab('list') },
            t('tabList')
          )
        ),
        h(
          'div',
          { className: 'bw-rail__body' },
          props.tab === 'guide'
            ? h(GuidePanel, {
                t: t,
                record: props.record,
                structure: props.structure,
                chapterIndex: props.structureChapter,
                onSelectChapter: props.onSelectChapter,
                onJump: props.onGuideJump,
                insight: props.insight,
                onAnalyze: props.onAnalyze,
                aiChars: props.aiChars,
                onFocusSource: props.onFocusSource,
              })
            : props.tab === 'excerpts'
              ? h(ExcerptsPanel, {
                  t: t,
                  excerpts: props.excerpts,
                  selectedId: props.selectedExcerptId,
                  onSelect: props.onExcerptSelect,
                  onLocate: props.onExcerptLocate,
                  onDelete: props.onExcerptDelete,
                  onNote: props.onExcerptNote,
                })
              : h(BookList, {
                  t: t,
                  record: props.record,
                  mentions: mentions,
                  selectedKey: props.selectedKey,
                  onSelect: props.onSelect,
                  onLocate: props.onLocate,
                  onNotify: props.onNotify,
                  onSearch: props.onSearch,
                })
        )
      );
    }

    function BookList(props) {
      const t = props.t;
      const mentions = props.mentions;
      const [query, setQuery] = React.useState('');
      const [sort, setSort] = React.useState('count');
      const filtered = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        const list = mentions.books.filter((item) => {
          if (!needle) return true;
          return item.title.toLowerCase().indexOf(needle) >= 0 || (item.author || '').toLowerCase().indexOf(needle) >= 0;
        });
        if (sort === 'order') return list.slice().sort((a, b) => a.order - b.order);
        return list;
      }, [query, sort, props.record.id]);

      if (!mentions.books.length) {
        return h(
          'div',
          { className: 'bw-empty' },
          h('div', { className: 'bw-empty__title' }, t('noMentionsTitle')),
          h('div', null, t('noMentionsText'))
        );
      }

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'bw-toolbar bw-toolbar--search' },
          h('input', {
            className: 'bw-search',
            type: 'search',
            value: query,
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchPlaceholder'),
            onChange: (event) => setQuery(event.target.value),
          })
        ),
        h(
          'div',
          { className: 'bw-toolbar bw-toolbar--sort' },
          h('button', { type: 'button', className: cx('bw-chip', sort === 'count' && 'bw-chip--on'), onClick: () => setSort('count') }, t('sortCount')),
          h('button', { type: 'button', className: cx('bw-chip', sort === 'order' && 'bw-chip--on'), onClick: () => setSort('order') }, t('sortOrder'))
        ),
        filtered.length
          ? h(
              'ul',
              { className: 'bw-list' },
              filtered.map((item, index) =>
                h(BookItem, {
                  key: item.key,
                  t: t,
                  item: item,
                  index: index,
                  selected: props.selectedKey === item.key,
                  onSelect: () => props.onSelect(item.key),
                  onLocate: () => props.onLocate(item),
                  onNotify: props.onNotify,
                  onSearch: props.onSearch,
                })
              )
            )
          : h('div', { className: 'bw-empty' }, h('div', null, t('filterEmpty')))
      );
    }

    function BookItem(props) {
      const t = props.t;
      const item = props.item;
      const contexts = item.contexts || [];
      return h(
        'li',
        {
          className: cx('bw-item', props.selected && 'bw-item--active'),
          role: 'button',
          tabIndex: 0,
          'aria-expanded': props.selected ? 'true' : 'false',
          onClick: props.onSelect,
          onKeyDown: (event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              props.onSelect();
            }
          },
        },
        h(
          'div',
          { className: 'bw-item__head' },
          h('span', { className: 'bw-item__index' }, String(props.index + 1)),
          h(
            'div',
            { className: 'bw-item__main' },
            h(
              'span',
              { className: 'bw-item__title' },
              '《' + item.title + '》',
              item.kind === 'article' ? h('span', { className: 'bw-badge bw-badge--muted', style: { marginLeft: 5 } }, t('badgeArticle')) : null,
              item.confidence !== 'high' ? h('span', { className: 'bw-badge bw-badge--warn', style: { marginLeft: 5 } }, t('badgeSuspect')) : null
            ),
            h(
              'span',
              { className: 'bw-item__meta' },
              item.author ? h('span', null, item.author) : null,
              h('span', null, t('timesMeta').replace('{count}', String(item.count))),
              item.chapterTitles.length ? h('span', null, item.chapterTitles[0] + (item.chapterTitles.length > 1 ? ' ' + t('chaptersMore').replace('{count}', String(item.chapterTitles.length - 1)) : '')) : null
            )
          ),
          h('span', { className: 'bw-count' }, String(item.count))
        ),
        props.selected
          ? h(
              'div',
              { className: 'bw-detail' },
              contexts.length
                ? contexts.map((context, index) => h('p', { key: index, className: 'bw-context' }, renderContext(context.snippet, item.title)))
                : h('p', { className: 'bw-context' }, t('noContext')),
              h(
                'div',
                { className: 'bw-detail__actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'bw-btn bw-btn--sm',
                    onClick: (event) => {
                      event.stopPropagation();
                      props.onLocate();
                    },
                  },
                  t('locate')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'bw-btn bw-btn--sm bw-btn--ghost',
                    title: t('searchBookHint').replace('{title}', item.title),
                    onClick: (event) => {
                      event.stopPropagation();
                      if (props.onSearch) props.onSearch(item.title);
                    },
                  },
                  t('searchBook')
                )
              )
            )
          : null
      );
    }

    function renderContext(snippet, title) {
      if (!title || snippet.indexOf(title) < 0) return snippet;
      const pieces = snippet.split(title);
      const children = [];
      pieces.forEach((piece, index) => {
        if (index) children.push(h('strong', { key: 'h' + index }, title));
        if (piece) children.push(piece);
      });
      return children;
    }

    // ---- 力导向关系图 ------------------------------------------------------
    // ===== UI END =====

    // =====================================================================
    // 3. Plugin entry
    // =====================================================================
    const LOCALE = {
      zh: {
        nav: '书脉',
        title: '书脉',
        subtitle: '读 EPUB，梳理书中的引书网络',
        import: '导入 EPUB',
        chooseFile: '选择 EPUB 文件',
        heroTitle: '把一本书放进来，看看它引出了哪些书',
        heroDesc: '导入 EPUB 后，书脉会读取正文并把书中提到的书名汇成一份书单，再按同段共现画出知识网络。',
        privacy: '文件只在本机浏览器内解析，不会上传到任何服务器。',
        formatHint: '支持 EPUB 2 / EPUB 3（.epub）。PDF、MOBI、TXT 暂不支持。',
        feature1Title: '识别书名',
        feature1Text: '自动提取正文中用《》标出的书名，并补充常见的经典书名提及。',
        feature2Title: '生成书单',
        feature2Text: '按提及次数排序，保留原文摘录，可一键定位回原书位置。',
        feature3Title: '关系网络',
        feature3Text: '同一段落提到的书会被连成一本书的知识网络，可导出 Markdown 书单。',
        library: '我的书架',
        libraryMeta: '{books} 本书 · {mentions} 次提及',
        loading: '正在读取…',
        libraryEmptyTitle: '书架还是空的',
        libraryEmptyText: '导入第一本 EPUB，书脉会记住你的阅读进度和书单。',
        untitled: '未命名书籍',
        unknownAuthor: '未知作者',
        chaptersMeta: '{count} 章',
        booksMeta: '{count} 本书',
        progressMeta: '{percent}%',
        openBook: '打开《{title}》',
        delete: '删除',
        confirmDelete: '确认删除',
        deleted: '已删除',
        back: '书架',
        toc: '目录',
        tocHead: '目录 · {count} 章',
        tocDot: '本章提到 {count} 本书',
        chapterFallback: '正文',
        chapterPosition: '第 {current} / {total} 章',
        insights: '书单',
        fontSmaller: '缩小字号',
        fontLarger: '放大字号',
        export: '导出书单',
        exportDone: '已下载 {name}',
        exportFailed: '导出失败',
        copied: '已复制到剪贴板',
        copyFailed: '复制失败',
        prevChapter: '上一章',
        nextChapter: '下一章',
        mentionsTitle: '本书提到 {count} 本书',
        mentionsMeta: '共 {count} 次提及',
        mentionsMetaArticles: '另有 {count} 篇报道或文章',
        tabList: '书单',
        noMentionsTitle: '没有找到书名',
        noMentionsText: '中文书名通常写在《》里。这本书正文里没有识别到书名号，也可能使用的是英文书名或其他标记方式。',
        searchPlaceholder: '搜索书名或作者',
        filterAll: '全部',
        filterBooks: '只看书籍',
        filterHigh: '高置信',
        sortCount: '按次数',
        sortOrder: '按出现顺序',
        filterEmpty: '没有匹配的书',
        badgeArticle: '文章',
        badgeSuspect: '疑似',
        timesMeta: '{count} 次',
        chaptersMore: '等 {count} 章',
        noContext: '没有可展示的摘录',
        locate: '定位正文',
        copyTitle: '复制书名',
        searchBook: '搜索书籍',
        searchBookHint: '在 Z-Library 搜索《{title}》',
        coverUpdated: '封面已更新',
        importDone: '导入完成，识别到 {count} 本书',
        alreadyImported: '这本书已经在书架里了',
        notEpub: '没有读取到文件，请重新选择 .epub 电子书',
        fileTooBig: '文件太大（超过 220 MB），暂不支持',
        errorTitle: '处理失败',
        dismiss: '关闭',
        idbError: '本机存储不可用，导入的书只在本次会话里保留',
        memoryError: '浏览器内存不足，试试关闭一些页面后重试',
        openMissing: '这本书的数据已不在本机，请重新导入',
        stageUnzip: '正在解压文件…',
        stageManifest: '正在读取书籍结构…',
        stageChapters: '正在解析正文…',
        stageExtract: '正在扫描书名…',
        stageSave: '正在保存到本机…',
        cancel: '取消',
        modeGroup: '阅读模式切换',
        modeReading: '阅读',
        modeStructure: '书籍结构',
        structureTitle: '书籍结构',
        structureMeta: '{chapters} 章 · {claims} 个观点 · {evidence} 条论据',
        structureHint: '由标题层级与段落中的论证线索自动提取；点击任一观点或论据可跳回原文。',
        structureChapters: '章节结构',
        structureBook: '本书',
        structureCore: '核心观点 · 第 {index} 章',
        structureCounts: '{claims} 个观点 · {evidence} 条论据',
        structureClaim: '分论点',
        structureEvidence: '论据',
        structureLoc: '第 {chapter} 章 · 第 {block} 段',
        structureNoEvidence: '这一节没有提取到论据',
        structureEmptyTitle: '暂无可用的结构',
        structureEmptyText: '这本书没有可提取的小标题或论证段落。',
        tabGuide: '导览',
        guideTitle: '书籍导览',
        guideMeta: '{chapters} 章 · {claims} 个观点',
        guideChapter: '章节',
        guideSummary: '本章总结',
        guideNoSummary: '点「AI 提炼本章」生成本章总结与导览卡片',
        guideNoCards: '本章暂无可导览卡片',
        guideCardClaim: '观点',
        guideCardBeat: '情节',
        guideConclusion: '结论',
        guideBecause: '因为',
        guideNoEvidence: '这一观点未提取到论据',
        guidePlotChain: '情节链',
        relationReason: '因为',
        relationExample: '例如',
        relationData: '数据',
        relationAuthority: '研究',
        relationContrast: '反例',
        relationDefinition: '定义',

        guideOriginal: '原文',
        guideSourceHint: '卡片里附原文摘要；悬停可在正文里高亮来源，点击定位并闪烁标出。',
        guideEmptyTitle: '暂无可导览的章节',
        guideEmptyText: '这本书没有可提取的章节结构。',
        aiTitle: 'AI 语义提炼',
        aiRun: 'AI 提炼本章',
        aiRerun: '重新提炼',
        aiLoading: '正在提炼本章…',
        aiError: '提炼失败，请稍后再试',
        aiUnavailable: '当前环境没有可用的模型服务',
        aiBadOutput: '模型返回的格式不符合要求，可重试',
        aiCached: '已缓存',
        aiCost: '将发送约 {chars} 字（最多 700 tokens）',
        aiSummary: '本章情节概括',
        aiBeats: '情节节点',
        aiClaims: 'AI 提炼的观点',
        aiTruncated: '原文过长，已按段落采样',
        aiRetry: '重试',
        aiHeuristic: '结构线索（启发式）',


        tabExcerpts: '摘录',
        excerptsTitle: '摘录 · {count} 条',
        excerptsMeta: '在正文里选中文字即可摘录',
        excerptMeta: '共 {count} 条摘录',
        excerptEmptyTitle: '还没有摘录',
        excerptEmptyText: '在正文里选中一段文字，点「摘录」保存；之后可以补笔记。',
        saveExcerpt: '摘录',
        excerptSaved: '已保存摘录',
        excerptNote: '笔记',
        excerptNotePlaceholder: '写点想法…',
        excerptHasNote: '有笔记',
        browserTitle: '内置浏览器',
        browserBack: '后退',
        browserForward: '前进',
        browserReload: '刷新',
        browserAddress: '地址',
        browserExternal: '在浏览器打开',
        browserClose: '关闭',
        browserHint: '搜索词已经填进地址栏并提交。嵌入的第三方站点默认拿不到 Cookie（会显示 Cookies are required）：先点「启用站点 Cookie」，不行再用「独立窗口打开」。',
        browserCookies: '启用站点 Cookie',
        browserCookiesGranted: '已授权站点 Cookie，正在重新载入…',
        browserCookiesDenied: '浏览器拒绝了 Cookie 授权；请用「独立窗口打开」。',
        browserCookiesUnsupported: '当前外壳不支持 Storage Access API；请用「独立窗口打开」。',
        browserStandalone: '独立窗口打开',

      },
      en: {
        nav: 'BookWeave',
        title: 'BookWeave',
        subtitle: 'Read EPUBs and map the books they cite',
        import: 'Import EPUB',
        chooseFile: 'Choose an EPUB file',
        heroTitle: 'Drop in a book, see the books inside it',
        heroDesc: 'BookWeave reads an EPUB, collects every book title mentioned in the text into a reading list, and draws a knowledge graph from co-mentions.',
        privacy: 'Files are parsed locally in this browser. Nothing is uploaded.',
        formatHint: 'Supports EPUB 2 / EPUB 3 (.epub). PDF, MOBI and TXT are not supported yet.',
        feature1Title: 'Detect titles',
        feature1Text: 'Extracts titles marked with 《》 and complements common classic titles.',
        feature2Title: 'Build a reading list',
        feature2Text: 'Sorted by mentions with original snippets and one-click jump back to the text.',
        feature3Title: 'See the network',
        feature3Text: 'Books mentioned in the same paragraph get linked; export the list as Markdown.',
        library: 'My shelf',
        libraryMeta: '{books} books · {mentions} mentions',
        loading: 'Loading…',
        libraryEmptyTitle: 'Your shelf is empty',
        libraryEmptyText: 'Import your first EPUB; progress and reading lists are kept on this device.',
        untitled: 'Untitled book',
        unknownAuthor: 'Unknown author',
        chaptersMeta: '{count} chapters',
        booksMeta: '{count} books',
        progressMeta: '{percent}%',
        openBook: 'Open {title}',
        delete: 'Delete',
        confirmDelete: 'Confirm',
        deleted: 'Deleted',
        back: 'Shelf',
        toc: 'Contents',
        tocHead: 'Contents · {count} chapters',
        tocDot: '{count} books in this chapter',
        chapterFallback: 'Text',
        chapterPosition: 'Chapter {current} / {total}',
        insights: 'Book list',
        fontSmaller: 'Smaller text',
        fontLarger: 'Larger text',
        export: 'Export list',
        exportDone: 'Downloaded {name}',
        exportFailed: 'Export failed',
        copied: 'Copied to clipboard',
        copyFailed: 'Copy failed',
        prevChapter: 'Previous',
        nextChapter: 'Next',
        mentionsTitle: '{count} books mentioned',
        mentionsMeta: '{count} mentions',
        mentionsMetaArticles: 'Plus {count} articles or reports',
        tabList: 'List',
        noMentionsTitle: 'No book titles found',
        noMentionsText: 'Chinese titles are usually wrapped in 《》. This book has none, or uses English titles or another convention.',
        searchPlaceholder: 'Search title or author',
        filterAll: 'All',
        filterBooks: 'Books only',
        filterHigh: 'High confidence',
        sortCount: 'By mentions',
        sortOrder: 'By appearance',
        filterEmpty: 'No matching books',
        badgeArticle: 'Article',
        badgeSuspect: 'Possible',
        timesMeta: '{count}×',
        chaptersMore: '+{count} chapters',
        noContext: 'No snippet available',
        locate: 'Jump to text',
        copyTitle: 'Copy title',
        searchBook: 'Search book',
        searchBookHint: 'Search Z-Library for 《{title}》',
        coverUpdated: 'Cover updated',
        importDone: 'Imported: {count} books found',
        alreadyImported: 'This book is already on your shelf',
        notEpub: 'No file was received. Please choose an .epub file again',
        fileTooBig: 'File is too large (over 220 MB)',
        errorTitle: 'Something went wrong',
        dismiss: 'Dismiss',
        idbError: 'Local storage is unavailable; books last only for this session',
        memoryError: 'Out of browser memory. Close some tabs and retry',
        openMissing: 'This book is no longer stored locally. Please import it again',
        stageUnzip: 'Unpacking…',
        stageManifest: 'Reading book structure…',
        stageChapters: 'Parsing text…',
        stageExtract: 'Scanning book titles…',
        stageSave: 'Saving locally…',
        cancel: 'Cancel',
        modeGroup: 'Reading mode',
        modeReading: 'Reading',
        modeStructure: 'Structure',
        structureTitle: 'Book structure',
        structureMeta: '{chapters} chapters · {claims} claims · {evidence} evidence',
        structureHint: 'Extracted from heading levels and argument cues; click any claim or evidence to jump back to the text.',
        structureChapters: 'Chapter outline',
        structureBook: 'This book',
        structureCore: 'Core claim · Chapter {index}',
        structureCounts: '{claims} claims · {evidence} evidence',
        structureClaim: 'Claim',
        structureEvidence: 'Evidence',
        structureLoc: 'Chapter {chapter} · block {block}',
        structureNoEvidence: 'No evidence extracted for this section',
        structureEmptyTitle: 'No structure available',
        structureEmptyText: 'This book has no headings or argument paragraphs to extract.',
        tabGuide: 'Guide',
        guideTitle: 'Book guide',
        guideMeta: '{chapters} chapters · {claims} claims',
        guideChapter: 'Chapter',
        guideSummary: 'Chapter summary',
        guideNoSummary: 'Tap “Analyze chapter” to get a summary and guide cards',
        guideNoCards: 'No guide cards for this chapter yet',
        guideCardClaim: 'Claim',
        guideCardBeat: 'Plot',
        guideConclusion: 'Claim',
        guideBecause: 'Because',
        guideNoEvidence: 'No evidence extracted for this claim',
        guidePlotChain: 'Plot chain',
        relationReason: 'Because',
        relationExample: 'Example',
        relationData: 'Data',
        relationAuthority: 'Study',
        relationContrast: 'Contrast',
        relationDefinition: 'Definition',

        guideOriginal: 'Original',
        guideSourceHint: 'Cards include a source excerpt; hover to highlight it in the text, click to jump and flash.',
        guideEmptyTitle: 'Nothing to guide yet',
        guideEmptyText: 'This book has no extractable chapter structure.',
        aiTitle: 'AI analysis',
        aiRun: 'Analyze chapter',
        aiRerun: 'Analyze again',
        aiLoading: 'Analyzing this chapter…',
        aiError: 'Analysis failed, please retry',
        aiUnavailable: 'No model service is available in this environment',
        aiBadOutput: 'The model returned an unexpected format; try again',
        aiCached: 'Cached',
        aiCost: 'About {chars} chars sent (max 700 tokens)',
        aiSummary: 'Chapter summary',
        aiBeats: 'Plot beats',
        aiClaims: 'AI claims',
        aiTruncated: 'The chapter was long, so paragraphs were sampled',
        aiRetry: 'Retry',
        aiHeuristic: 'Structural cues (heuristic)',


        tabExcerpts: 'Excerpts',
        excerptsTitle: 'Excerpts · {count}',
        excerptsMeta: 'Select text in the book to save an excerpt',
        excerptMeta: '{count} excerpts',
        excerptEmptyTitle: 'No excerpts yet',
        excerptEmptyText: 'Select a passage in the reader and tap “Excerpt”; you can add notes later.',
        saveExcerpt: 'Excerpt',
        excerptSaved: 'Excerpt saved',
        excerptNote: 'Note',
        excerptNotePlaceholder: 'Add a note…',
        excerptHasNote: 'Has note',
        browserTitle: 'Built-in browser',
        browserBack: 'Back',
        browserForward: 'Forward',
        browserReload: 'Reload',
        browserAddress: 'Address',
        browserExternal: 'Open in browser',
        browserClose: 'Close',
        browserHint: 'The search term is already in the address bar and submitted. Embedded third-party sites usually cannot set cookies (you will see “Cookies are required”): try “Enable site cookies”, then “Open standalone window”.',
        browserCookies: 'Enable site cookies',
        browserCookiesGranted: 'Site cookies granted, reloading…',
        browserCookiesDenied: 'The browser refused cookie access; use “Open standalone window”.',
        browserCookiesUnsupported: 'This shell has no Storage Access API; use “Open standalone window”.',
        browserStandalone: 'Open standalone window',

      },
    };

    /** 宿主 locale 字典不可用时，按当前语言回退到内置字典，保证不显示原始 key。 */
    function createTranslator(locale) {
      const bound = locale && typeof locale.bind === 'function' ? locale.bind(NS) : null;
      function bundledDict() {
        try {
          const snapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : null;
          if (snapshot && typeof snapshot.active === 'string' && /^en/i.test(snapshot.active)) return LOCALE.en;
        } catch (error) {
          /* ignore */
        }
        return LOCALE.zh;
      }
      return function translate(key) {
        let value = '';
        if (bound) {
          try {
            value = bound(key);
          } catch (error) {
            value = '';
          }
        }
        if (!value || value === key) value = bundledDict()[key] || LOCALE.zh[key] || key;
        return value;
      };
    }

    return {
      // locale 是文案的硬依赖：和 dshmarket 一样在 inject 里声明，
      // 等 locale 服务就绪后再激活，否则 t() 只会拿到原始 key。
      inject: ['slots', 'locale'],
      core: Core,
      // 测试接缝：Node 测试直接渲染组件，UI 不依赖它。
      __test: {
        App: App,
        ReaderView: ReaderView,
        TocRail: TocRail,
        InsightsRail: InsightsRail,
        BookList: BookList,
        BookCard: BookCard,
        BookItem: BookItem,
        BrowserPanel: BrowserPanel,
        ExcerptsPanel: ExcerptsPanel,
        GuidePanel: GuidePanel,
        SidebarIcon: SidebarIcon,
      },
      apply(ctx) {
        if (typeof console !== 'undefined' && console.info) {
          console.info('[dsh-bookweave] client v' + CLIENT_VERSION + ' active');
        }
        const locale = ctx.locale;
        const t = createTranslator(locale);
        ctx.effect(() => {
          if (!locale || typeof locale.register !== 'function') return () => {};
          // 用当前语言表覆盖完整语言集合（zh* / en*），并始终补上内置的 zh、en，
          // 这样切换语言后也不会退回原始 key。
          let ids = ['zh', 'en'];
          try {
            const snapshot = typeof locale.getLocale === 'function' ? locale.getLocale() : null;
            if (snapshot && Array.isArray(snapshot.locales) && snapshot.locales.length) {
              ids = snapshot.locales.map((item) => item.id).filter(Boolean);
            }
          } catch (error) {
            /* 保守回退到内置语言 */
          }
          const disposers = [];
          const seen = new Set();
          for (const id of ids.concat(['zh', 'en'])) {
            if (seen.has(id)) continue;
            seen.add(id);
            const dict = /^zh/i.test(id) ? LOCALE.zh : /^en/i.test(id) ? LOCALE.en : null;
            if (!dict) continue;
            try {
              disposers.push(locale.register(NS, id, dict));
            } catch (error) {
              if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-bookweave] locale register failed for ' + id, error);
            }
          }
          if (typeof console !== 'undefined' && console.info) console.info('[dsh-bookweave] locale ready:', ids.join(','), '| registered:', disposers.length);
          return () => {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch (error) {
                /* ignore */
              }
            }
          };
        });
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t: t }) },
            function BookWeavePanel(props) {
              return h(App, Object.assign({}, props, { t: t }));
            }
          )
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('nav'), locale: NS },
            function BookWeaveIcon(owner) {
              return h(SidebarIcon, { size: (owner && owner.size) || 16 });
            }
          )
        );
      },
    };
  },
});
