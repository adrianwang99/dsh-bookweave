# BookWeave test harness

Permanent, dependency-free verification of the pure part of the BookWeave DSH plugin: EPUB parsing, book-title extraction, markdown export, the chapter-structure heuristic and the Host-side AI route.

Run everything from the repository root:

```sh
npm test        # or: node test/run.mjs && node test/parse-archives.mjs && node test/structure.mjs && node test/host.mjs
npm run check   # syntax-check client/client.js and index.js
```

Requires Node.js ≥ 20 (uses `Blob`, `Response`, `DecompressionStream`, `TextDecoder`, top-level `await` and dynamic `import()` of the browser module). Only the Node standard library is used — there is nothing to install.

## What the suites cover

| Suite | Covers |
| --- | --- |
| `run.mjs` | `openZip` / `parseEpub` on five synthetic fixtures, chapter/block shape, quote extraction (《》 + English cues + lexicon), markdown export, archive tolerance. |
| `parse-archives.mjs` | Archive recovery and cover extraction on malformed / unusual archives. |
| `toc.mjs` | TOC-driven chapter building on Calibre-style split EPUBs: NCX boundaries, part flags, non-TOC spine pages merged into the previous chapter. |
| `structure.mjs` | Chapter structure heuristic (claims / evidence all carry valid paragraph positions), AI input compression budget, optional real-book smoke. |
| `host.mjs` | Host AI route with a fake LLM stream: prompt budget, `maxTokens`, lowest reasoning effort, block-index validation, 403/502/503 branches. |

Output is TAP-flavoured; the process exits non-zero on any failure.

## Fixtures

`test/fixtures/*.epub` are tiny synthetic books produced by `test/fixtures/build_fixtures.py`. `verify_fixtures.py` checks their integrity and expected chapter counts; CI runs both.

## Optional real-book smoke tests

The real-book checks are skipped unless you provide EPUBs:

```sh
BOOKWEAVE_SMOKE_ZH=/path/to/chinese.epub \
BOOKWEAVE_SMOKE_EN=/path/to/english.epub \
npm test
```

Nothing in the repository contains personal library data; the smoke tests are read-only and optional.
