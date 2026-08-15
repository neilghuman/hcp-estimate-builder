# feature/drip-s17-per-source-pages

## Request
The single Follow-up Drip page was too long/confusing; split by source (Thumbtack vs Google LSA),
future-proof for Yelp/Angi.

## Design (agreed)
Separate pages per source + Overview hub + Global, one shared script, exact per-source stats,
shared `any` taxonomy read-only on source pages / editable on Global, Suppression on Global only.

## Change (front-end only; backend `bySource` shipped in S16)
- **public/followup.js** made page-aware: `window.FU_PAGE = { mode, source }` (`overview` | `source`
  | `global` | `all`). `SOURCES` registry (google_lsa, thumbtack, yelp, angi + group prefixes).
  Every top-level listener is null-safe and `load()` renders only the sections a page contains
  (`has(id)`), so one script drives every page. Added `renderNav`, `renderBySource` (overview cards),
  `renderSrcStats` (per-source strip). Source filtering in `renderSequences` / `renderTemplates`
  (group prefix) / `renderTaxonomy` (`any` shown read-only in source mode) / active-enrollment fetch
  (`?source=`).
- **public/followup.html** rewritten as the **Overview** hub (nav + per-source cards + system status +
  global enrollments/outcomes).
- **New pages**: `followup-lsa.html`, `followup-thumbtack.html` (source pages: at-a-glance stats,
  sequences, auto-replies, taxonomy, active enrollments), `followup-global.html` (suppression + pause +
  all taxonomy). Each is a thin shell setting `FU_PAGE` and loading `followup.js`.
- **public/followup.css**: nav + source-card styles.
- Adding Yelp/Angi later = one `SOURCES` line + a 6-line HTML shell.

## Verify (dev)
All four pages 200. Overview shows nav + Google LSA source card + system status. LSA page filtered to
google_lsa sequences + taxonomy (Thumbtack excluded); `any` note shown. `node --check` clean; 215 tests.
