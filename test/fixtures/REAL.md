# Optional real-book smoke references

The synthetic fixtures in this folder are self-contained and always run. Two extra
"real book" smoke tests exist but are **skipped by default** because they need big
third-party EPUBs that are not redistributed here.

Point the environment variables at your own copies:

```sh
BOOKWEAVE_SMOKE_ZH=/path/to/chinese.epub \
BOOKWEAVE_SMOKE_EN=/path/to/english.epub \
npm test
```

- `BOOKWEAVE_SMOKE_ZH` — a Chinese EPUB whose text uses 《》 book-title marks (exercises
  self-reference detection and the Chinese quote rules). The assertions only check
  structural invariants and loose ranges, never exact counts.
- `BOOKWEAVE_SMOKE_EN` — an English EPUB with no 《》 marks, used as a negative control
  (the extractor must not invent Chinese quote marks).

No personal library data is committed to this repository. Keep your own EPUBs out of
git (`*.epub` in a local folder, or an ignored directory).
