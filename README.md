<div align="center">
  <img src="icon.svg" width="72" height="72" alt="BookWeave icon" />
  <h1>BookWeave · 书脉</h1>
  <p><strong>Read EPUBs inside DSH, discover every book they cite, and let an AI guide you through the chapters.</strong></p>
  <p>
    <a href="https://github.com/adrianwang99/dsh-bookweave/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green" /></a>
    <img alt="Version" src="https://img.shields.io/badge/version-0.18.4-blue" />
    <img alt="Platform" src="https://img.shields.io/badge/platform-DSH%20Web-7c5cff" />
    <img alt="Tests" src="https://img.shields.io/badge/tests-node--only-success" />
  </p>
  <p>English | <a href="README.zh-CN.md">中文</a></p>
</div>

BookWeave is a [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) **Web client plugin**. It turns the sidebar into an EPUB reading workspace: a shelf, a distraction-free reader, excerpts, a network of every book mentioned in the text, and an AI-assisted **book guide** that summarises a chapter and turns its claims and evidence into clickable cards backed by the original paragraphs.

> Everything is local-first: EPUBs, excerpts, reading progress and AI results live in your browser's IndexedDB. The only network call is the optional "Analyze chapter" request to your configured model provider.

## Features

| | |
| --- | --- |
| **Shelf & folder import** | Left category sidebar (create / rename / delete), per-book category picker on every cover, and one-click **Import folder**: recursively imports every EPUB under the chosen folder (duplicates skipped) into the active category. Both normal `.epub` files and **extracted `.epub` folders** (with `META-INF/container.xml`) are supported. |
| **Shelf** | Import `.epub` by click or drag & drop; 2:3 portrait covers extracted from the EPUB; book title, author and reading percentage only. |
| **Reader** | Serif prose, adjustable font size, TOC built from the book's NCX/nav boundaries (Calibre-style split files merge into their chapter; parts are marked), chapter navigation, remembered progress. No fixed header — the reading area and the right rail both start at the top of the window. |
| **Book list** | Extracts every book the current book mentions: 《》 titles, English “quoted title” cues and a curated lexicon, with noise filters (self-references, TOC, chapter headings, periodicals). Each entry links back to the paragraph where it appears. |
| **Excerpts & notes** | Select text → red underline + excerpt card with an optional note. Every entry (excerpt or note) renders as the same action card — badge, chapter/time, text, and always-visible Locate / Note (excerpts) / Edit (notes) / Delete. Adding a thought automatically lists its source passage here too (older notes fall back to the current paragraph text). Locate is a real button; list text uses the system font (handwriting stays in the margin). |
| **Margin notes** | The reading column is narrower; the freed right margin shows your thoughts in a **handwriting font**, anchored to the paragraph (or selection) they belong to. Pick one of six ink colors per note; the referenced text gets a **dashed underline in the same color** while notes are shown. Add from the selection toolbar or the “+” in the margin. The floating toolbar toggles notes with an animated collapse — when hidden, a colored vertical bar marks every annotated paragraph and expands them again on click. |
| **Book guide** | A right-rail tab, left of Excerpts: it opens on the chapter you are currently reading and follows TOC / prev-next / locate jumps. Chapter picker, AI-generated chapter summary, and cards **ordered by where they appear in the text**. Claims render as an **argument chain**: the conclusion at the top, an up-arrow labelled “because”, then the reasons/examples/data beneath, each tagged with its relation. Every node shows an “original” excerpt and highlights/flashes the source paragraph on hover/click. |
| **AI analysis** | One explicit button per chapter. Fiction → plot summary in the book's own voice + plot beats; nonfiction → claims + evidence. Input is compressed to ≤6–8k characters, output ≤700 tokens, lowest reasoning effort, cached per book/chapter, never re-billed unless you press “Analyze again”. |
| **Translation** | Floating “Translate” menu with 8 target languages; the translation appears **under each source paragraph**. Built for speed and cost: skips short/numeric/already-target-language blocks, dedupes repeated paragraphs, batches ~2.6k chars with up to 3 parallel requests (visible paragraphs first), uses the lowest reasoning effort, and caches per book/chapter/language/content fingerprint. |
| **Book search** | From a book-list entry, open an in-plugin browser panel pre-filled with a **configurable search URL** (default: Open Library). Edit the template under Book list → **Search source**; use `{query}` for the title, and any search provider works. |
| **Export** | Export the whole book list as Markdown. |
| **i18n** | Chinese and English UI. |

## Install

**Requirements** — a DeepSeek Harness build with the Web UI. The AI half additionally needs the Host `llm` service (any provider that DSH can already call); without it, reading, excerpts, book lists and the heuristic guide still work.

### From GitHub (available now)

```sh
dsh plugin add github:adrianwang99/dsh-bookweave
```

### From npm (after the first npm release)

```sh
dsh plugin add dsh-bookweave
```

### From source (for development)

```sh
git clone https://github.com/adrianwang99/dsh-bookweave.git
cd dsh-bookweave
dsh plugin add .
```

Or, if you manage the profile manually, symlink the checkout into the profile and add a `link:` dependency:

```sh
ln -s "$(pwd)" ~/.dsh/profiles/desktop/node_modules/dsh-bookweave
# then add "dsh-bookweave": "link:<absolute path>" to the profile package.json
```

Restart DSH (⌘Q on macOS) after installing or updating the **Host** half (`index.js`); client-only changes are picked up by a page refresh.

> The package declares the standard manifest:

```jsonc
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true }
  }
}
```

## Usage

1. Open **书脉** from the DSH sidebar.
2. Import an EPUB (click the shelf or drag the file onto the window).
3. Read: use the floating pills (← shelf, TOC, rail toggle, A−/A+, export) — they stay available while scrolling but take no layout space.
4. Open the right rail → **Guide** (default). Pick a chapter, optionally press **Analyze chapter**.
5. Hover a guide card to highlight the source paragraph in the text; click it to scroll and flash that paragraph.
6. Select text to create an excerpt (**Excerpts & notes** tab) or a thought (handwriting margin note); thoughts also appear in that tab with their source passage, and persist per book/chapter/paragraph.
8. Translate: floating **Translate** → pick a language; translations render under paragraphs and are cached. Turn it off from the same menu.
9. Book list → expand an entry to locate the mention or search the book in the built-in browser. The search URL is configurable (Book list → **Search source**, default Open Library).

> **TOC note** — chapters are now built from the EPUB's NCX/nav TOC boundaries, not from every spine file. Books imported **before v0.17** keep the structure parsed at import time; delete and re-import them once to pick up the corrected TOC.

## AI analysis & privacy

- **Opt-in only.** Opening a book, switching chapters or tabs never calls a model.
- **Small prompts.** One chapter's compressed excerpt (≤6,000 chars client-side, 8,000 host-side), concise JSON output (≤700 tokens), lowest reasoning effort the model advertises, no retries.
- **Cached.** Results are stored per book + chapter + content fingerprint in IndexedDB. Reopening a chapter shows “Cached” and costs nothing; “Analyze again” is the only way to spend tokens twice.
- **No telemetry.** The plugin makes exactly one kind of network request: `POST /api/dsh-bookweave/analyze` to its own DSH host, which forwards the prompt to your configured model provider.
- **Model override.** Set `DSH_BOOKWEAVE_MODEL=provider/model` before launching DSH to pin a cheaper model for analysis.

## Data storage

IndexedDB database `dsh-bookweave` (version 3): `books`, `index`, `excerpts`, `insights`.
Deleting a book removes its text, book list, excerpts and AI results. Nothing leaves the machine except the opt-in model request.

## Development

```sh
git clone https://github.com/adrianwang99/dsh-bookweave.git
cd dsh-bookweave
npm test          # core + archive + structure + host suites (Node only, no dependencies)
npm run check     # syntax check the client and host halves
```

The suites run in plain Node (≥20) without a browser, React or npm dependencies. They load `client/client.js` through the same `window.__ModuleLoader__` seam the DSH Web client uses, and exercise the `plugin.core` exports plus a fake host-side LLM for the AI route. See [`test/README.md`](test/README.md).

Optional real-book smoke tests are skipped unless you point at your own EPUBs:

```sh
BOOKWEAVE_SMOKE_ZH=/path/to/zh.epub BOOKWEAVE_SMOKE_EN=/path/to/en.epub npm test
```

### Project structure

```text
.
├── client/client.js        # everything UI + core (EPUB parsing, extraction, guide, AI client)
├── index.js                # Host half: /api/dsh-bookweave/analyze (LLM call, prompt, normalisation)
├── cordis.patch.yml        # bundle patch: registers the plugin row
├── locale/{zh,en}.json     # plugin metadata strings
├── icon.svg                # sidebar icon
├── plugin.json             # marketplace metadata (deepseek.stream upload)
├── test/                   # node-only suites + synthetic EPUB fixtures
├── docs/PUBLISHING.md      # npm / awesome-dsh-plugin / WhaleHub / deepseek.stream guide
└── marketplace/            # ready-to-submit community marketplace entries
```

## Known limitations

- EPUB parsing is a tolerant pure-JS implementation; malformed EPUBs fall back to a lighter archive discovery path, but DRM-protected files are not supported.
- Mention extraction is heuristic: it errs on the side of recall and can include the current book or chapter titles; the book-list UI marks them and the export keeps them out of the “found books” count.
- The AI guide is per chapter and capped for cost; it is not a full-book analysis.
- The built-in browser cannot inject text into a cross-origin page; it opens a search URL instead.
- AI results depend on the configured model; a weak model may produce a poor summary. Cached results are never silently replaced.

## License

[MIT](LICENSE) © 2025 adrianwang99
