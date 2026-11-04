# Changelog

All notable changes to this project are documented here. Version numbers follow [SemVer](https://semver.org/).

## [Unreleased]

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
