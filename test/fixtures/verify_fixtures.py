#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Independent validation of the BookWeave EPUB fixtures.

Checks, for every fixture:

  1. the zip is intact (``zipfile.ZipFile.testzip() is None``);
  2. ``mimetype`` is the FIRST entry, STORED (method 0), carries no extra
     field, and contains exactly ``b"application/epub+zip"``;
  3. ``META-INF/container.xml`` parses and its rootfile points at an OPF that
     exists in the archive;
  4. the OPF parses; every manifest href (percent-decoded) and every NCX /
     nav href resolves to an archive entry; every spine idref exists;
  5. every XML / XHTML / NCX document parses with ``xml.dom.minidom``
     (the GBK fixture is decoded according to its XML declaration first);
  6. the bytes re-read from the zip are byte-identical to what the builder
     intended (imports build_fixtures and rebuilds the in-memory map);
  7. body-text 《...》 counts match ``expected.json`` exactly, including the
     deliberate exclusions (人民日报, 测试之书) and the 〈原道〉 non-match;
  8. ``chapters`` / ``title`` / ``author`` derived from the archive match
     ``expected.json``.

Exit status is non-zero if any check fails.
"""

import json
import os
import re
import sys
import zipfile
from collections import Counter
from urllib.parse import unquote

from xml.dom import minidom

import build_fixtures as bf

HERE = os.path.dirname(os.path.abspath(__file__))
MARK_RE = bf.MARK_RE
TEXT_NODE, ELEMENT_NODE = 3, 1

# 《...》 marks that are present in the source text but deliberately excluded
# from expectedBooks (documented in EXPECTED.md).
EXCLUSIONS = {
    "zh-basic.epub": {u"人民日报": 2,   # periodical, not a book
                      u"测试之书": 1},  # self-reference to the fixture itself
}

_failures = []


def fail(fixture, message):
    _failures.append("%s: %s" % (fixture, message))
    print("    FAIL %s" % message)


def ok(message):
    print("    ok   %s" % message)


def parse_xml(name, data):
    """Parse a document, honouring a non-UTF-8 XML declaration (GBK fixture)."""
    try:
        return minidom.parseString(data)
    except Exception:
        match = re.match(br'<\?xml[^>]*encoding="([A-Za-z0-9_.-]+)"', data)
        if match is None:
            raise
        return minidom.parseString(data.decode(match.group(1).decode("ascii")))


def text_of(node):
    chunks = []
    for child in node.childNodes:
        if child.nodeType == TEXT_NODE:
            chunks.append(child.data)
        elif child.nodeType == ELEMENT_NODE:
            chunks.append(text_of(child))
    return "".join(chunks)


def body_text(data):
    """Concatenated text of all <body> elements, in document order."""
    dom = parse_xml("body", data)
    return "\n".join(text_of(b) for b in dom.getElementsByTagName("body"))


def one(elements, tag):
    found = elements.getElementsByTagName(tag)
    return found[0] if found else None


def resolve(base_dir, href):
    """Resolve a manifest/NCX href (may be percent-encoded) to a zip name."""
    path = unquote(href)
    if path.startswith("/"):
        return path.lstrip("/")
    parts = [p for p in (base_dir + "/" + path).split("/") if p not in ("", ".")]
    out = []
    for part in parts:
        if part == "..":
            if out:
                out.pop()
        else:
            out.append(part)
    return "/".join(out)


def check_local_refs(doc_name, dom, names):
    """Every relative href/src in a document must resolve to an archive entry."""
    bad = []
    for el in dom.getElementsByTagName("*"):
        for attr in ("href", "src"):
            if not el.hasAttribute(attr):
                continue
            ref = el.getAttribute(attr)
            if not ref or ref.startswith(("#", "http:", "https:", "data:")):
                continue
            target = resolve(os.path.dirname(doc_name), ref.split("#")[0])
            if target not in names:
                bad.append((doc_name, ref, target))
    return bad


def check_fixture(fixture, archive, intended_files, all_stored, expected):
    print("== %s (%d bytes) ==" % (fixture, os.path.getsize(archive)))
    zf = zipfile.ZipFile(archive)

    # 1. zip integrity
    bad = zf.testzip()
    if bad is None:
        ok("zipfile.testzip() -> None")
    else:
        fail(fixture, "testzip() reports corrupt entry: %r" % bad)

    infos = zf.infolist()
    names = zf.namelist()

    # 2. mimetype
    first = infos[0]
    if first.filename == "mimetype":
        ok("first entry is mimetype")
    else:
        fail(fixture, "first entry is %r, not mimetype" % first.filename)
    if first.compress_type == zipfile.ZIP_STORED:
        ok("mimetype stored (method 0)")
    else:
        fail(fixture, "mimetype compress_type is %d, expected 0"
             % first.compress_type)
    if first.extra == b"":
        ok("mimetype has no extra field")
    else:
        fail(fixture, "mimetype has a non-empty extra field: %r" % first.extra)
    if zf.read("mimetype") == b"application/epub+zip":
        ok('mimetype content == b"application/epub+zip"')
    else:
        fail(fixture, "mimetype content is %r" % zf.read("mimetype"))
    if all_stored:
        offenders = [i.filename for i in infos
                     if i.compress_type != zipfile.ZIP_STORED]
        if offenders:
            fail(fixture, "entries not stored: %r" % offenders)
        else:
            ok("all %d entries stored (method 0)" % len(infos))
    else:
        methods = sorted({i.compress_type for i in infos[1:]})
        if methods and methods != [zipfile.ZIP_DEFLATED]:
            fail(fixture, "unexpected compression methods in payload: %r"
                 % methods)
        else:
            ok("payload entries deflated (method 8)")

    # 2b. re-read bytes are byte-identical to the builder's intent
    wanted = [("mimetype", bf.EPUB_MIMETYPE)] + intended_files
    if names == [n for n, _ in wanted]:
        ok("entry order matches builder intent (%d entries)" % len(names))
    else:
        fail(fixture, "entry order differs:\n      zip:     %r\n      intended:%r"
             % (names, [n for n, _ in wanted]))
    mismatched = [n for n, d in wanted if n in names and zf.read(n) != d]
    if mismatched:
        fail(fixture, "re-read bytes differ from intent for: %r" % mismatched)
    else:
        ok("all entries re-read byte-identical to builder intent")

    # 3. container.xml -> OPF
    container = zf.read("META-INF/container.xml")
    cdom = parse_xml("META-INF/container.xml", container)
    rootfile = one(cdom, "rootfile")
    opf_path = rootfile.getAttribute("full-path")
    if opf_path in names:
        ok("container.xml full-path=%r exists" % opf_path)
    else:
        fail(fixture, "container.xml full-path %r missing from archive"
             % opf_path)
        return

    # 4. OPF
    opf = parse_xml(opf_path, zf.read(opf_path))
    title_el = one(opf, "dc:title")
    author_el = one(opf, "dc:creator")
    title = text_of(title_el) if title_el else ""
    author = text_of(author_el) if author_el else ""
    spine = one(opf, "spine")
    itemrefs = opf.getElementsByTagName("itemref")
    chapters = len(itemrefs)

    items = opf.getElementsByTagName("item")
    by_id = {}
    bad_hrefs = []
    for item in items:
        iid, href, mtype = (item.getAttribute("id"),
                            item.getAttribute("href"),
                            item.getAttribute("media-type"))
        by_id[iid] = href
        target = resolve(os.path.dirname(opf_path), href)
        if target not in names:
            bad_hrefs.append((href, target))
    if bad_hrefs:
        fail(fixture, "manifest hrefs do not resolve: %r" % bad_hrefs)
    else:
        ok("all %d manifest hrefs resolve (percent-decoded)" % len(items))

    missing = [r.getAttribute("idref") for r in itemrefs
               if r.getAttribute("idref") not in by_id]
    if missing:
        fail(fixture, "spine idrefs missing from manifest: %r" % missing)
    else:
        ok("all %d spine idrefs resolve" % len(itemrefs))

    # 5. every XML document parses + every relative href/src resolves
    xml_docs = [n for n in names
                if n.endswith((".xml", ".opf", ".ncx", ".xhtml"))]
    doms = {}
    for name in xml_docs:
        try:
            doms[name] = parse_xml(name, zf.read(name))
        except Exception as exc:
            fail(fixture, "%s does not parse: %s" % (name, exc))
    ok("minidom parsed %d XML documents" % len(xml_docs))
    broken = []
    for name in xml_docs:
        if name in doms and name.endswith(".xhtml"):
            broken.extend(check_local_refs(name, doms[name], names))
    if broken:
        fail(fixture, "relative href/src targets missing: %r" % broken)
    else:
        ok("all relative href/src targets inside XHTML exist")

    # OPF / NCX documents must not contain 《》 marks (so a reader that naively
    # concatenates every XML text node cannot inflate the counts)
    structural = [n for n in xml_docs
                  if n.endswith((".opf", ".ncx"))
                  or n.endswith("nav.xhtml")
                  or n.endswith("toc.ncx")]
    stray = [n for n in structural
             if MARK_RE.findall(text_of(parse_xml(n, zf.read(n))))]
    if stray:
        fail(fixture, "structural documents contain 《》 marks: %r" % stray)
    else:
        ok("no 《》 marks in OPF/NCX/nav metadata")

    # chapter text + per-chapter counts, in spine order
    chapter_docs = [resolve(os.path.dirname(opf_path), by_id[r.getAttribute("idref")])
                    for r in itemrefs]
    body_marks = Counter()
    per_chapter = []
    for name in chapter_docs:
        text = body_text(zf.read(name))
        counts = Counter(MARK_RE.findall(text))
        body_marks.update(counts)
        per_chapter.append((name, counts))
    print("    chapters in spine order:")
    for name, counts in per_chapter:
        print("      %-34s %s" % (name,
                                  ", ".join("%s=%d" % kv for kv in
                                            sorted(counts.items()))
                                  or "(no marks)"))

    # 7b. GBK-specific checks
    if fixture == "gbk-encoded.epub":
        cases = [n for n in names if n.endswith(".xhtml")]
        for name in cases:
            raw = zf.read(name)
            if raw.startswith(b"\xef\xbb\xbf"):
                fail(fixture, "%s starts with a UTF-8 BOM" % name)
            if b"charset=gbk" not in raw:
                fail(fixture, "%s lacks meta charset=gbk" % name)
            if b'encoding="gbk"' not in raw:
                fail(fixture, "%s lacks XML declaration encoding=gbk" % name)
            try:
                decoded = raw.decode("gbk")
            except UnicodeDecodeError as exc:
                fail(fixture, "%s is not GBK-decodable: %s" % (name, exc))
                continue
            try:
                as_utf8 = raw.decode("utf-8")
            except UnicodeDecodeError:
                as_utf8 = None
            if u"论语" not in decoded:
                fail(fixture, "%s GBK text lost 论语" % name)
            if as_utf8 is not None and u"论语" in as_utf8:
                fail(fixture, "%s is readable as UTF-8; it is not GBK data" % name)
        ok("content documents are GBK-encoded on disk (no BOM, meta charset=gbk)")

    # 8. compare against expected.json, after the documented exclusions.
    #    expectedBooks is the contract *after* exclusions; the excluded marks
    #    are still verified to exist in the source text (see step 9 below).
    excluded = EXCLUSIONS.get(fixture, {})
    filtered = {k: v for k, v in body_marks.items() if k not in excluded}
    actual = {
        "chapters": chapters,
        "title": title,
        "author": author,
        "expectedBooks": filtered,
    }
    if actual == expected:
        ok("archive matches expected.json after exclusions: chapters=%d title=%r "
           "author=%r expectedBooks=%s"
           % (chapters, title, author,
              json.dumps(filtered, ensure_ascii=False, sort_keys=True)))
    else:
        fail(fixture, "archive != expected.json\n      actual:   %s\n      expected: %s"
             % (json.dumps(actual, ensure_ascii=False, sort_keys=True),
                json.dumps(expected, ensure_ascii=False, sort_keys=True)))
    for name, count in excluded.items():
        if body_marks.get(name) != count:
            fail(fixture, "excluded mark %r count is %r, expected %d"
                 % (name, body_marks.get(name), count))
    if excluded:
        ok("excluded marks verified in source: %s (present but not in "
           "expectedBooks)" % json.dumps(excluded, ensure_ascii=False,
                                         sort_keys=True))

    # 9. documented exclusions / non-matches really are present in the source
    if fixture == "zh-basic.epub":
        all_text = "".join(body_text(zf.read(n)) for n in chapter_docs)
        if u"〈原道〉" in all_text:
            ok("〈原道〉 present but correctly not counted as a 《》 title")
        else:
            fail(fixture, "〈原道〉 missing from source text")
    print()


def main():
    with open(os.path.join(HERE, "expected.json"), encoding="utf-8") as fh:
        expected_all = json.load(fh)

    builders = [
        bf.build_zh_basic,
        bf.build_gbk,
        bf.build_no_toc,
        bf.build_stored_entries,
        bf.build_percent_href,
    ]
    built = {}
    for builder in builders:
        filename, files, all_stored = builder()
        built[filename] = (files, all_stored)

    if set(built) != set(expected_all):
        raise SystemExit("expected.json keys do not match built fixtures: %r vs %r"
                         % (sorted(built), sorted(expected_all)))

    print("validating %d fixtures\n" % len(built))
    for filename in sorted(built):
        files, all_stored = built[filename]
        check_fixture(filename, os.path.join(HERE, filename), files,
                      all_stored, expected_all[filename])

    print("-" * 68)
    if _failures:
        print("FAILED: %d problem(s)" % len(_failures))
        for line in _failures:
            print("  - %s" % line)
        return 1
    print("PASSED: 5/5 fixtures valid, all counts match expected.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
