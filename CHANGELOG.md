# Changelog

All notable changes to this project are documented here. Version numbers follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.18.0] - 2025-11-06

- Shelf categories: left sidebar with All / Uncategorized / custom categories, create, rename and delete; each book cover has a category picker; clicking a category filters the shelf.
- Folder import: **Import folder** picks a directory and imports every EPUB under it recursively (duplicates skipped), assigning new books to the active category when one is selected.
- Category storage uses the new `categories` IndexedDB store (DB v6); book summaries carry `categoryId`.

## [0.17.0] - 2025-11-06

- Fixed TOC parsing for Calibre-style EPUBs: chapters are now built from NCX/nav boundaries instead of one chapter per spine file. Spine files that are not TOC targets merge into the preceding chapter; part entries are flagged and styled in the TOC/guide.
- Titles come from the TOC labels, so generic “第 N 章” fallbacks no longer replace real chapter names.
- New `test/toc.mjs` regression suite (in-memory split EPUB).
- Note: books imported before this version keep their old parsed structure; delete and re-import to rebuild the TOC.

## [0.16.0] - 2025-11-06

- Added chapter translation: floating Translate menu (8 target languages),译文 rendered under each paragraph, cached per book/chapter/language.
- Speed/cost: skips short, numeric and already-target-language blocks; dedupes repeated paragraphs; batches ~2,600 chars with up to 3 parallel requests (visible paragraphs first); compact prompt; lowest reasoning effort; shared model/provider resolution.

## [0.15.1] - 2025-11-06

- Thought cards always show the original passage: stored `sourceText` is used, and older notes fall back to the current paragraph text.
- “Locate” in cards is now a real button; edit/delete stay as text actions.

## [0.15.0] - 2025-11-06

- “Excerpts & notes” entries now all use one action-card design: badge, chapter/time, text, and always-visible Locate / Note / Edit / Delete buttons.
- List entries use the system font; the handwriting font is reserved for the margin notes themselves.

## [0.14.0] - 2025-11-06

- Renamed the “Excerpts” tab to **Excerpts & notes**; it now merges manual excerpts and margin thoughts in reading order.
- Adding a thought automatically records its source passage and lists it in that tab (badge distinguishes excerpt vs note); locate/edit/delete work for both.
- Tab count and rail header count cover both kinds.

## [0.13.0] - 2025-11-06

- Thoughts no longer repeat the quoted text inside the card; instead the referenced text in the body gets a **dashed underline in the thought's color** while notes are expanded.
- Selection-created thoughts underline exactly the selected range (across paragraphs when needed); margin-created thoughts underline the whole paragraph.
- Underlines hide together with the margin when notes are collapsed; the colored margin bar still expands them.

## [0.12.1] - 2025-11-06

- Collapsed notes no longer reserve layout height (the hidden margin is removed from flow), so the colored marker bar matches its paragraph instead of stretching across an empty gap.
- Notes fade/slide in when expanded; the reading column still animates its width.

## [0.12.0] - 2025-11-06

- Thought text now supports six inks; each note stores its color and renders in it.
- The floating toolbar replaces “Export” with an animated **Show/Hide notes** toggle: collapsing widens the reading column, hiding the side margin; a vertical bar in the note's color marks every annotated paragraph and expands the margin on click.
- Export moved into the book-list toolbar so it is still one click away.

## [0.11.0] - 2025-11-06

- Narrower reading column; the freed right margin is now a **thought margin** (边注): notes render in a handwriting font, aligned with the paragraph or excerpt they belong to.
- Add a thought from the selection toolbar (“想法”) or the “+” in the margin; edit/delete inline; thoughts are stored per book in IndexedDB (`thoughts` store).
- On narrow containers the thoughts move below the paragraph instead of the side margin.

## [0.10.1] - 2025-11-04

- The right-rail guide now opens on the chapter you are currently reading (using saved progress) and follows TOC / prev-next / locate chapter changes.

## [0.10.0] - 2025-11-04

- Book search is now configurable: Book list → **Search source** edits a URL template (`{query}` = title). Default is Open Library; no hardcoded third-party book site remains.
- Reset-to-default and validation (http/https) included; the setting is stored in `localStorage` under `dsh-bookweave:search-template`.

## [0.9.0] - 2025-11-04

- Guide claims are now rendered as **argument chains**: conclusion on top, an upward "because" arrow, then evidence cards tagged by relation (`reason` / `example` / `data` / `authority` / `contrast` / `definition`).
- The Host prompt asks for an evidence relation and optional connector phrase; the client falls back to heuristics when a relation is missing.
- Fiction beats render as a numbered **plot chain** with connecting nodes.

## [0.8.1] - 2025-11-04

- The right rail now defaults to the **Guide** tab when a book is opened.

## [0.8.0] - 2025-11-04

- Chapter menu in the guide is now reliable: attached to the button, delayed close, menu hover keeps it open, outside click / Esc closes it.
- Selecting a guide chapter also jumps the reader to that chapter and saves progress; switching chapters from the TOC or prev/next keeps the guide in sync.

## [0.7.9] - 2025-11-04

- Fixed the chapter dropdown closing when the pointer moved into the list.

## [0.7.8] - 2025-11-04

- Reader top spacing is measured at runtime and the shell page padding is adjusted so the top gap matches the bottom gap.
- Reader root pulls itself up when no padded container is found.

## [0.7.6] - 2025-11-03

- Book list: removed the "all / books only / high confidence" filter chips; the search box is now full width. Sorting stays.

## [0.7.3] - 2025-11-03

- Shelf cards: smaller proportional covers; the card body now shows only title, author and reading percentage (no progress bar, chapter/book counts or file size).

## [0.7.0] - 2025-11-03

- Removed the fixed reader header: reading area and right rail now start at the top of the window.
- Book title / chapter position moved into a scrolling masthead; back, TOC, rail toggle, font size and export became floating pills.
- Left TOC is collapsed by default (v0.7.1).

## [0.6.0] - 2025-11-03

- Guide cards show an "original" excerpt plus chapter/paragraph location.
- Hovering a claim or evidence highlights the source paragraph; clicking scrolls to it and flashes it.

## [0.5.0] - 2025-11-03

- Moved the structure view out of the reading area into a right-rail **Guide** tab (left of Excerpts).
- Each chapter now has a summary paragraph at the top and cards ordered by their appearance in the text.
- AI analysis returns a summary for both fiction and nonfiction.

## [0.4.0] - 2025-11-03

- Added opt-in AI semantic analysis via the Host route `/api/dsh-bookweave/analyze`.
- Cost controls: compressed chapter input, 700-token output cap, lowest reasoning effort, per book/chapter content-fingerprint cache, explicit button only.
- `DSH_BOOKWEAVE_MODEL=provider/model` pins a cheaper model.

## [0.3.0] - 2025-11-03

- Added a book structure view: chapter outline, core claims, claims and evidence with click-to-jump positions; replaced the relationship graph tab.

## [0.2.x] - 2025-11-01 → 2025-11-03

- Reader, TOC, portrait covers, excerpt system with red underlines and notes, in-plugin browser panel for book search, archive-tolerant EPUB discovery (including GBK-encoded and non-standard archives), export to Markdown.

## [0.1.0] - 2025-10-31

- First working version: EPUB import, shelf, mention extraction (《》 + English cues + lexicon), book list, Markdown export.
