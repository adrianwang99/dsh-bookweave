#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Deterministic builder for the BookWeave EPUB test fixtures.

Python 3.9 standard library only (zipfile, re, os, sys, collections, minidom).
Every EPUB is assembled in memory, cross-checked against the ground-truth
mention plan *before* it is zipped, and then written so that:

  * ``mimetype`` is the first archive entry, STORED (compression method 0),
    carries no extra field, and contains exactly ``b"application/epub+zip"``;
  * every XML / XHTML / NCX document is well formed (asserted with
    ``xml.dom.minidom`` before writing and again on re-read);
  * entry timestamps and permission bits are fixed, so rebuilds are byte
    stable.

Run:

    python3 build_fixtures.py     # writes the five .epub files next to itself
    python3 verify_fixtures.py    # independent validation + expected.json check
"""

import os
import re
import sys
import zipfile
from collections import Counter
from xml.dom import minidom

HERE = os.path.dirname(os.path.abspath(__file__))
FIXED_DATE = (2024, 1, 1, 0, 0, 0)  # deterministic zip timestamps
EPUB_MIMETYPE = b"application/epub+zip"
ZIP_FILE_MODE = 0o100644 << 16

# 《...》 marks.  〈...〉 (single angle bracket, used for chapter titles inside a
# book) deliberately does NOT match -- that is one of the behaviours under test.
MARK_RE = re.compile(u"\u300a([^\u300a\u300b]+)\u300b")  # 《([^《》]+)》


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def xml_escape(text):
    return (text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;"))


def marks_in(text):
    """All 《...》 titles in a string, in order, as a Counter."""
    return Counter(MARK_RE.findall(text))


def assert_well_formed(name, data):
    """Parse an XML/XHTML/NCX document with minidom; raise on malformed.

    pyexpat cannot parse non-UTF-8 byte streams by itself, so a document whose
    XML declaration names another encoding (the GBK fixture) is decoded first
    and then parsed from text.
    """
    try:
        minidom.parseString(data)
        return
    except Exception as first_error:
        match = re.match(br'<\?xml[^>]*encoding="([A-Za-z0-9_.-]+)"', data)
        if match is None:
            raise SystemExit("FAIL: %s is not well-formed XML: %s"
                             % (name, first_error))
        encoding = match.group(1).decode("ascii")
        try:
            minidom.parseString(data.decode(encoding))
        except Exception as exc:  # pragma: no cover - build-time guard
            raise SystemExit("FAIL: %s is not well-formed XML (%s): %s"
                             % (name, encoding, exc))


def entry(name, compress_type):
    zi = zipfile.ZipInfo(name, date_time=FIXED_DATE)
    zi.compress_type = compress_type
    zi.external_attr = ZIP_FILE_MODE
    return zi


def write_epub(path, files, all_stored=False):
    """Write an EPUB: mimetype first (stored), then ``files`` in given order."""
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(entry("mimetype", zipfile.ZIP_STORED), EPUB_MIMETYPE)
        for name, data in files:
            comp = zipfile.ZIP_STORED if all_stored else zipfile.ZIP_DEFLATED
            zf.writestr(entry(name, comp), data)


# --------------------------------------------------------------------------- #
# XML document templates
# --------------------------------------------------------------------------- #
def container_xml(opf_path):
    return u"""<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="%s" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
""" % opf_path


_XHTML3 = u"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="%(lang)s" lang="%(lang)s">
  <head>
    <meta charset="utf-8"/>
    <title>%(title)s</title>
    <link rel="stylesheet" type="text/css" href="%(css)s"/>
  </head>
  <body>
    <section epub:type="chapter">
      <h1>%(heading)s</h1>
%(body)s
    </section>
  </body>
</html>
"""


def xhtml3(title, heading, paragraphs, lang=u"zh-CN", css=u"styles/style.css"):
    body = u"\n".join(u"      <p>%s</p>" % xml_escape(p) for p in paragraphs)
    return _XHTML3 % {
        "lang": lang,
        "title": xml_escape(title),
        "heading": xml_escape(heading),
        "css": css,
        "body": body,
    }


_XHTML2_UTF8 = u"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
    <title>%(title)s</title>
  </head>
  <body>
    <h1>%(heading)s</h1>
%(body)s
  </body>
</html>
"""

_XHTML2_GBK = u"""<?xml version="1.0" encoding="gbk"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=gbk"/>
    <title>%(title)s</title>
  </head>
  <body>
    <h1>%(heading)s</h1>
%(body)s
  </body>
</html>
"""


def xhtml2(title, heading, paragraphs, encoding=u"utf-8"):
    body = u"\n".join(u"    <p>%s</p>" % xml_escape(p) for p in paragraphs)
    tmpl = _XHTML2_GBK if encoding.lower() == u"gbk" else _XHTML2_UTF8
    return tmpl % {
        "title": xml_escape(title),
        "heading": xml_escape(heading),
        "body": body,
    }


def ncx(title, uid, navpoints, lang=u"zh-CN"):
    points = []
    for i, (label, src) in enumerate(navpoints, 1):
        points.append(
            u'    <navPoint id="navPoint-%d" playOrder="%d">\n'
            u"      <navLabel><text>%s</text></navLabel>\n"
            u'      <content src="%s"/>\n'
            u"    </navPoint>" % (i, i, xml_escape(label), src))
    return u"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="%(lang)s">
  <head>
    <meta name="dtb:uid" content="%(uid)s"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>%(title)s</text></docTitle>
  <navMap>
%(points)s
  </navMap>
</ncx>
""" % {"lang": lang, "uid": uid, "title": xml_escape(title),
       "points": u"\n".join(points)}


def opf3(uid, title, author, manifest_items, spine_idrefs, lang=u"zh-CN"):
    manifest = u"\n".join(
        u'    <item id="%s" href="%s" media-type="%s"%s/>'
        % (i, h, m, (u' properties="%s"' % p) if p else u"")
        for (i, h, m, p) in manifest_items)
    spine = u"\n".join(u'    <itemref idref="%s"/>' % r for r in spine_idrefs)
    return u"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="%(lang)s">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">%(uid)s</dc:identifier>
    <dc:title>%(title)s</dc:title>
    <dc:creator id="creator">%(author)s</dc:creator>
    <dc:language>%(lang)s</dc:language>
    <dc:date>2024-01-01</dc:date>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
%(manifest)s
  </manifest>
  <spine toc="ncx">
%(spine)s
  </spine>
</package>
""" % {"lang": lang, "uid": uid, "title": xml_escape(title),
       "author": xml_escape(author), "manifest": manifest, "spine": spine}


def opf2(uid, title, author, manifest_items, spine_idrefs,
         ncx_href=None, lang=u"zh-CN"):
    manifest = u"\n".join(
        u'    <item id="%s" href="%s" media-type="%s"/>' % (i, h, m)
        for (i, h, m) in manifest_items)
    spine = u"\n".join(u'    <itemref idref="%s"/>' % r for r in spine_idrefs)
    toc_attr = u' toc="ncx"' if ncx_href else u""
    return u"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>%(title)s</dc:title>
    <dc:creator opf:role="aut">%(author)s</dc:creator>
    <dc:identifier id="bookid">%(uid)s</dc:identifier>
    <dc:language>%(lang)s</dc:language>
    <dc:date>2024-01-01</dc:date>
  </metadata>
  <manifest>
%(manifest)s
  </manifest>
  <spine%(toc)s>
%(spine)s
  </spine>
</package>
""" % {"title": xml_escape(title), "author": xml_escape(author), "uid": uid,
       "lang": lang, "manifest": manifest, "toc": toc_attr, "spine": spine}


def nav3(title, toc_entries, lang=u"zh-CN"):
    items = u"\n".join(
        u'      <li><a href="%s">%s</a></li>' % (src, xml_escape(label))
        for (label, src) in toc_entries)
    return u"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="%(lang)s" lang="%(lang)s">
  <head>
    <meta charset="utf-8"/>
    <title>%(title)s</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>%(title)s</h1>
      <ol>
%(items)s
      </ol>
    </nav>
  </body>
</html>
""" % {"lang": lang, "title": xml_escape(title), "items": items}


# --------------------------------------------------------------------------- #
# fixture content
# --------------------------------------------------------------------------- #
CSS = u"""body { font-family: serif; line-height: 1.8; margin: 2em; }
p { text-indent: 2em; }
h1 { font-size: 1.2em; margin-bottom: 1em; }
"""

# ---- zh-basic.epub (EPUB 3) -------------------------------------------------
ZH_BASIC_TITLE = u"测试之书"
ZH_BASIC_AUTHOR = u"测试作者"
ZH_BASIC_UID = u"urn:uuid:6f6c2c1e-0001-4a11-9a01-000000000001"
ZH_BASIC_HEADS = [
    u"第一章 旧书架",
    u"第二章 灯下对读",
    u"第三章 读书会",
    u"第四章 注疏与闲读",
    u"第五章 自述",
]
ZH_BASIC_CHAPTERS = [
    [
        u"书房的窗子朝北，光线一年四季都软。他把旧书从纸箱里一本一本拣出来，指腹沿着书脊来回摩挲，像在给人把脉。",
        u"最先被他抽出来的是《红楼梦》，那套书扉页上还留着十年前的借书章；他随手翻到第三回，忽然发现《红楼梦》里写的那些吃食，如今反而更让他惦记。",
        u"旁边那本《人类简史》是朋友落下的，夹着一张旧车票，书页折在讲农业的那一章。他想了想，还是没有替人合上。",
    ],
    [
        u"夜里停电，他点了蜡烛，干脆把两本书并排摊在桌上：一边是《红楼梦》，一边是《百年孤独》，两本书的开头都在写一场回望。",
        u"烛火一晃，他想起白天在《人民日报》上读到的一篇书评，文章说经典重译的意义，大约是让旧话重新变成新话。",
        u"后来他把这一晚的感想写在卡片上，夹进笔记本里，卡片背面写着日期和天气。",
    ],
    [
        u"读书会那天来了七个人。有人带了《百年孤独》，说这本书他读过三次，每次都在同一页停下来。",
        u"轮到他发言，他讲《人类简史》里那个说法，又顺带提起自己正在整理的这本《测试之书》，算是自嘲。",
        u"散场时雨已经停了，路灯把水洼照得很亮，大家各自散去。",
    ],
    [
        u"案头那本《文心雕龙》里的〈原道〉篇，他前后抄过三遍，每次抄到文之为德也大矣一句，都要停一停。",
        u"午后困倦，他把《活着》垫在手边，其实一页也没有翻，只是看着封面上那个瘦长的字发呆。",
        u"窗外的树影慢慢爬上桌沿，他把抄好的纸叠起来，压进抽屉。",
    ],
    [
        u"有人问他，为什么愿意为几本旧书写这么长的札记。他说自己早年当过几年记者，习惯把见闻写下来，后来不写了，手却停不住。",
        u"他提到从前在《人民日报》共事的一位同事，说那人临走前留给他一支钢笔，笔尖早就磨秃了。",
        u"这篇自述写到这里就断了，末页只剩一个没有落款的日期。",
    ],
]
# Ground truth BEFORE exclusions: every 《...》 mark that appears in body text.
ZH_BASIC_ALL_MARKS = Counter({
    u"红楼梦": 3,
    u"百年孤独": 2,
    u"人类简史": 2,
    u"活着": 1,
    u"文心雕龙": 1,
    u"人民日报": 2,   # periodical -> excluded by spec
    u"测试之书": 1,   # self-reference -> excluded by spec
})
ZH_BASIC_EXCLUDED = Counter({u"人民日报": 2, u"测试之书": 1})


def build_zh_basic():
    opf_path = "OEBPS/content.opf"
    ch_paths = ["OEBPS/text/chapter%d.xhtml" % (i + 1)
                for i in range(len(ZH_BASIC_CHAPTERS))]
    manifest = [
        ("nav", "nav.xhtml", "application/xhtml+xml", "nav"),
        ("ncx", "toc.ncx", "application/x-dtbncx+xml", None),
        ("css", "styles/style.css", "text/css", None),
    ] + [("ch%d" % (i + 1), "text/chapter%d.xhtml" % (i + 1),
          "application/xhtml+xml", None) for i in range(len(ZH_BASIC_CHAPTERS))]
    spine = ["ch%d" % (i + 1) for i in range(len(ZH_BASIC_CHAPTERS))]
    files = [
        ("META-INF/container.xml", container_xml(opf_path)),
        (opf_path, opf3(ZH_BASIC_UID, ZH_BASIC_TITLE, ZH_BASIC_AUTHOR,
                        manifest, spine)),
        ("OEBPS/nav.xhtml", nav3(u"目录",
                                 list(zip(ZH_BASIC_HEADS,
                                          ["text/chapter%d.xhtml" % (i + 1)
                                           for i in range(len(ZH_BASIC_HEADS))])))),
        ("OEBPS/toc.ncx", ncx(ZH_BASIC_TITLE, ZH_BASIC_UID,
                              list(zip(ZH_BASIC_HEADS,
                                       ["text/chapter%d.xhtml" % (i + 1)
                                        for i in range(len(ZH_BASIC_HEADS))])))),
        ("OEBPS/styles/style.css", CSS),
    ] + [("OEBPS/text/chapter%d.xhtml" % (i + 1),
          xhtml3(ZH_BASIC_TITLE, ZH_BASIC_HEADS[i], ZH_BASIC_CHAPTERS[i],
                 css="../styles/style.css"))
         for i in range(len(ZH_BASIC_CHAPTERS))]
    files = [(n, d if isinstance(d, bytes) else d.encode("utf-8"))
             for n, d in files]
    return "zh-basic.epub", files, False


# ---- gbk-encoded.epub (EPUB 2, content docs GBK) ----------------------------
GBK_TITLE = u"国学札记"
GBK_AUTHOR = u"测试作者"
GBK_UID = u"urn:uuid:6f6c2c1e-0002-4a11-9a02-000000000002"
GBK_HEADS = [u"第一章 灯下读经", u"第二章 抄书"]
GBK_CHAPTERS = [
    [
        u"他读书没有章法，往往从《论语》翻起，翻到哪句算哪句。",
        u"同一张桌子上还摊着《道德经》，两本书隔着一段空白，像两位不爱争论的老先生。",
        u"夜深了，他把书签夹好，关了灯。",
    ],
    [
        u"第二天他接着抄书，抄到《论语》开头那几句时，忽然觉得这句子太熟，熟到几乎听不见它的意思。",
        u"抄满一页，他数了数字数，觉得比昨天多些，便合上本子。",
    ],
]
GBK_ALL_MARKS = Counter({u"论语": 2, u"道德经": 1})
GBK_EXCLUDED = Counter()


def build_gbk():
    opf_path = "OEBPS/content.opf"
    manifest = [
        ("ncx", "toc.ncx", "application/x-dtbncx+xml"),
    ] + [("ch%d" % (i + 1), "text/chapter%d.xhtml" % (i + 1),
          "application/xhtml+xml") for i in range(len(GBK_CHAPTERS))]
    spine = ["ch%d" % (i + 1) for i in range(len(GBK_CHAPTERS))]
    files = [
        ("META-INF/container.xml", container_xml(opf_path)),
        (opf_path, opf2(GBK_UID, GBK_TITLE, GBK_AUTHOR, manifest, spine,
                        ncx_href="toc.ncx")),
        ("OEBPS/toc.ncx", ncx(GBK_TITLE, GBK_UID,
                              list(zip(GBK_HEADS,
                                       ["text/chapter%d.xhtml" % (i + 1)
                                        for i in range(len(GBK_HEADS))])))),
    ]
    for i, paras in enumerate(GBK_CHAPTERS):
        doc = xhtml2(GBK_TITLE, GBK_HEADS[i], paras, encoding=u"gbk")
        data = doc.encode("gbk")  # raises if a character is not GBK-encodable
        assert data.startswith(b"<?xml version=\"1.0\" encoding=\"gbk\"?>")
        assert not data.startswith(b"\xef\xbb\xbf")  # no BOM
        assert b'charset=gbk' in data
        files.append(("OEBPS/text/chapter%d.xhtml" % (i + 1), data))
    files = [(n, d if isinstance(d, bytes) else d.encode("utf-8"))
             for n, d in files]
    return "gbk-encoded.epub", files, False


# ---- no-toc.epub (EPUB 2, spine only) --------------------------------------
NOTOC_TITLE = u"读史札记"
NOTOC_AUTHOR = u"测试作者"
NOTOC_UID = u"urn:uuid:6f6c2c1e-0003-4a11-9a03-000000000003"
NOTOC_HEADS = [u"第一章 开篇", u"第二章 夜读"]
NOTOC_CHAPTERS = [
    [
        u"祖父留下的书不多，最厚的一本讲的是《史记》里的人物，纸页都发黄了。",
        u"他小时候不认得繁体字，只把这本书当画册翻。",
    ],
    [
        u"如今他重读《史记》，才发现那些列传写得那样克制，几乎不替人辩解。",
        u"合上书，窗外已经泛白，鸡叫了第二遍。",
    ],
]
NOTOC_ALL_MARKS = Counter({u"史记": 2})
NOTOC_EXCLUDED = Counter()


def build_no_toc():
    opf_path = "OEBPS/content.opf"
    manifest = [("ch%d" % (i + 1), "text/chapter%d.xhtml" % (i + 1),
                 "application/xhtml+xml") for i in range(len(NOTOC_CHAPTERS))]
    spine = ["ch%d" % (i + 1) for i in range(len(NOTOC_CHAPTERS))]
    files = [
        ("META-INF/container.xml", container_xml(opf_path)),
        (opf_path, opf2(NOTOC_UID, NOTOC_TITLE, NOTOC_AUTHOR, manifest, spine,
                        ncx_href=None)),  # no toc.ncx, no spine@toc
    ]
    for i, paras in enumerate(NOTOC_CHAPTERS):
        files.append(("OEBPS/text/chapter%d.xhtml" % (i + 1),
                      xhtml2(NOTOC_TITLE, NOTOC_HEADS[i], paras)))
    files = [(n, d if isinstance(d, bytes) else d.encode("utf-8"))
             for n, d in files]
    return "no-toc.epub", files, False


# ---- stored-entries.epub (EPUB 2, every entry method 0) --------------------
STORED_TITLE = u"书斋随笔"
STORED_AUTHOR = u"测试作者"
STORED_UID = u"urn:uuid:6f6c2c1e-0004-4a11-9a04-000000000004"
STORED_HEADS = [u"第一章 床头", u"第二章 页边"]
STORED_CHAPTERS = [
    [
        u"他把《围城》放在床头，睡前读两页，读到方鸿渐说话就笑。",
        u"笑完又觉得心酸，索性关灯睡下。",
    ],
    [
        u"周末他又翻《围城》，在页边写下两行小字，写完自己看了半天。",
        u"然后他把书合上，压在一摞旧杂志底下。",
    ],
]
STORED_ALL_MARKS = Counter({u"围城": 2})
STORED_EXCLUDED = Counter()


def build_stored_entries():
    opf_path = "OEBPS/content.opf"
    manifest = [
        ("ncx", "toc.ncx", "application/x-dtbncx+xml"),
    ] + [("ch%d" % (i + 1), "text/chapter%d.xhtml" % (i + 1),
          "application/xhtml+xml") for i in range(len(STORED_CHAPTERS))]
    spine = ["ch%d" % (i + 1) for i in range(len(STORED_CHAPTERS))]
    files = [
        ("META-INF/container.xml", container_xml(opf_path)),
        (opf_path, opf2(STORED_UID, STORED_TITLE, STORED_AUTHOR, manifest,
                        spine, ncx_href="toc.ncx")),
        ("OEBPS/toc.ncx", ncx(STORED_TITLE, STORED_UID,
                              list(zip(STORED_HEADS,
                                       ["text/chapter%d.xhtml" % (i + 1)
                                        for i in range(len(STORED_HEADS))])))),
    ]
    for i, paras in enumerate(STORED_CHAPTERS):
        files.append(("OEBPS/text/chapter%d.xhtml" % (i + 1),
                      xhtml2(STORED_TITLE, STORED_HEADS[i], paras)))
    files = [(n, d if isinstance(d, bytes) else d.encode("utf-8"))
             for n, d in files]
    return "stored-entries.epub", files, True


# ---- percent-href.epub (nested OPF, %20 hrefs, 3 chapters) -----------------
PCT_TITLE = u"行旅小记"
PCT_AUTHOR = u"测试作者"
PCT_UID = u"urn:uuid:6f6c2c1e-0005-4a11-9a05-000000000005"
PCT_HEADS = [u"第一章 车上", u"第二章 雨天", u"第三章 多年以后"]
PCT_CHAPTERS = [
    [
        u"第一次读《边城》，是在长途汽车上，车窗外全是水田。",
        u"他记得书里那条河，也记得自己当时没有看完。",
    ],
    [
        u"这一章写得很短，说的是雨天和一间空屋子。",
        u"他把这一页折了个角，又抚平。",
    ],
    [
        u"多年以后他再读《边城》，才发现结局其实早就写在开头。",
        u"书合上了，车还在往前开。",
    ],
]
PCT_ALL_MARKS = Counter({u"边城": 2})
PCT_EXCLUDED = Counter()
PCT_CHAPTER_FILES = ["chapter 1.xhtml", "chapter 2.xhtml", "chapter 3.xhtml"]
PCT_CHAPTER_HREFS = ["chapter%201.xhtml", "chapter%202.xhtml",
                     "chapter%203.xhtml"]


def build_percent_href():
    opf_path = "OEBPS/content/book.opf"
    manifest = [
        ("ncx", "toc.ncx", "application/x-dtbncx+xml"),
    ] + [("ch%d" % (i + 1), PCT_CHAPTER_HREFS[i], "application/xhtml+xml")
         for i in range(len(PCT_CHAPTER_FILES))]
    spine = ["ch%d" % (i + 1) for i in range(len(PCT_CHAPTER_FILES))]
    files = [
        ("META-INF/container.xml", container_xml(opf_path)),
        (opf_path, opf2(PCT_UID, PCT_TITLE, PCT_AUTHOR, manifest, spine,
                        ncx_href="toc.ncx")),
        ("OEBPS/content/toc.ncx", ncx(PCT_TITLE, PCT_UID,
                                      list(zip(PCT_HEADS, PCT_CHAPTER_HREFS)))),
    ]
    for i, paras in enumerate(PCT_CHAPTERS):
        files.append(("OEBPS/content/" + PCT_CHAPTER_FILES[i],
                      xhtml2(PCT_TITLE, PCT_HEADS[i], paras)))
    files = [(n, d if isinstance(d, bytes) else d.encode("utf-8"))
             for n, d in files]
    return "percent-href.epub", files, False


# --------------------------------------------------------------------------- #
# build + pre-zip assertions
# --------------------------------------------------------------------------- #
BUILDERS = [
    build_zh_basic,
    build_gbk,
    build_no_toc,
    build_stored_entries,
    build_percent_href,
]


def xml_text_marks(files):
    """Count 《...》 marks in every XML document that will go into the zip.

    The extractor is expected to read *body text*; this is the stronger
    invariant that nav/ncx/OPF metadata contribute zero marks, so a sloppy
    reader that concatenates every XML document cannot inflate the counts.
    """
    total = Counter()
    per_doc = {}
    for name, data in files:
        if name == "OEBPS/styles/style.css" or not (name.endswith(".xhtml")
                                                   or name.endswith(".opf")
                                                   or name.endswith(".ncx")
                                                   or name.endswith(".xml")):
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("gbk")
        per_doc[name] = marks_in(text)
        total.update(marks_in(text))
    return total, per_doc


def check_fixture(filename, files, all_stored, expected_all, excluded):
    """Assert the generated documents match the ground-truth plan, pre-zip."""
    # 1. every XML document is well formed
    for name, data in files:
        if name == "OEBPS/styles/style.css":
            continue
        if name.endswith((".xhtml", ".opf", ".ncx", ".xml")):
            assert_well_formed(name, data)

    # 2. total 《...》 marks across all XML == planned body marks
    total, per_doc = xml_text_marks(files)
    assert total == expected_all, (
        "MARK MISMATCH in %s:\n  computed: %s\n  planned : %s\n  per-doc: %s"
        % (filename, dict(total), dict(expected_all), per_doc))

    # 3. every excluded mention is present exactly as documented
    for title, n in excluded.items():
        assert total[title] == n, (title, total[title], n)

    # 4. all-stored fixture: every entry method 0 (checked on re-read too)
    if all_stored:
        pass  # write_epub(all_stored=True) guarantees it; verify_fixtures rechecks

    # 5. print the per-chapter breakdown that will be quoted in EXPECTED.md
    chapters = [n for n in sorted(per_doc)
                if n.startswith("OEBPS/text/chapter")
                or n.startswith("OEBPS/content/chapter")]
    print("  %s" % filename)
    print("    xml docs: %d" % len([n for n, _ in files
                                   if n.endswith((".xhtml", ".opf", ".ncx",
                                                  ".xml"))]))
    print("    pre-zip marks: %s" % ", ".join(
        "%s=%d" % (k, v) for k, v in sorted(total.items())))
    for n in chapters:
        if per_doc[n]:
            print("    %-32s %s" % (n, ", ".join(
                "%s=%d" % (k, v) for k, v in sorted(per_doc[n].items()))))
        else:
            print("    %-32s (no marks)" % n)


def check_zh_basic_paragraph_shapes():
    """Paragraph-level invariants required by the extractor harness.

    * exactly ONE paragraph contains both 《红楼梦》 and 《百年孤独》
      (co-occurrence edge weight 1, not 2);
    * exactly ONE *different* paragraph contains 《红楼梦》 twice.
    """
    cooccur, double_hong = 0, 0
    for ci, paras in enumerate(ZH_BASIC_CHAPTERS, 1):
        for pi, para in enumerate(paras, 1):
            m = marks_in(para)
            if m[u"红楼梦"] and m[u"百年孤独"]:
                cooccur += 1
                assert m[u"红楼梦"] == 1 and m[u"百年孤独"] == 1, (
                    "co-occurrence paragraph %d/%d has extra marks: %s"
                    % (ci, pi, dict(m)))
            if m[u"红楼梦"] == 2:
                double_hong += 1
                assert not m[u"百年孤独"], (
                    "the double-红楼梦 paragraph must not also mention "
                    "百年孤独 (chapter %d paragraph %d)" % (ci, pi))
    assert cooccur == 1, "expected exactly 1 co-occurrence paragraph, got %d" % cooccur
    assert double_hong == 1, "expected exactly 1 double-红楼梦 paragraph, got %d" % double_hong
    print("    zh-basic paragraph shapes: co-occurrence(红楼梦+百年孤独)=%d, "
          "double-红楼梦 paragraph=%d" % (cooccur, double_hong))


def main():
    print("building fixtures in %s" % HERE)
    check_zh_basic_paragraph_shapes()
    written = []
    for builder in BUILDERS:
        filename, files, all_stored = builder()
        expected_all, excluded = {
            "zh-basic.epub": (ZH_BASIC_ALL_MARKS, ZH_BASIC_EXCLUDED),
            "gbk-encoded.epub": (GBK_ALL_MARKS, GBK_EXCLUDED),
            "no-toc.epub": (NOTOC_ALL_MARKS, NOTOC_EXCLUDED),
            "stored-entries.epub": (STORED_ALL_MARKS, STORED_EXCLUDED),
            "percent-href.epub": (PCT_ALL_MARKS, PCT_EXCLUDED),
        }[filename]
        check_fixture(filename, files, all_stored, expected_all, excluded)
        path = os.path.join(HERE, filename)
        write_epub(path, files, all_stored=all_stored)
        written.append((filename, os.path.getsize(path), len(files) + 1))
    print("\nwrote:")
    for name, size, entries in written:
        print("  %-22s %6d bytes  %2d entries" % (name, size, entries))
    return 0


if __name__ == "__main__":
    sys.exit(main())
