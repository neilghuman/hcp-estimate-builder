# feature/drip-s11-autoreply-category

## Request
"How do I tie the auto reply with its category key?" → tie the auto-reply templates to the
same canonical drip category taxonomy the drip sequences use, so the priced stump message is
selected by taxonomy (not a separate hard-coded `isStump` regex in n8n).

## Problem
The tree auto-reply's `stump` template and the drip's `stump_grinding` `category_key` were two
independent labels that only *happened* to both mean "stump". n8n's `Pick Message` decided the
priced message with its own `/stump grind/i` regex, disconnected from `drip_category_map`.

## Change
- **migration 030_drip_template_category.sql**: `drip_template.category_key TEXT` (nullable) +
  backfill `autoreply_tt_tree.stump` → `stump_grinding`. Idempotent.
- **src/drip.js**: pure `autoreplySource(group)` (group prefix → lead source) and
  `pickAutoreplyTemplate(rows, categoryKey, {fallbackSub='generic'})` (category match wins, else
  the group's `generic` sub).
- **src/drip_runtime.js**: `resolveAutoreply(pool, group, rawCategory)` resolves the raw category
  via the SAME `drip_category_map` (reusing `resolveCategoryKey`) then picks the template by
  `category_key`, falling back to `generic`. `getTemplates` now returns `category_key`.
- **src/drip_routes.js**: open `GET /api/drip/autoreply/:group/resolve?category=<raw>` — n8n passes
  the raw lead category, gets back `{categoryKey, matched, subKey, label, body}`.
- **public/followup.{js,css}**: template card shows a `🏷️ <category_key>` badge when linked.
- **tests**: +2 (`autoreplySource`, `pickAutoreplyTemplate`). 213 pass.

## Verify (dev)
- Migration 030 applied; `category_key` column present.
- `resolve?category=Tree Stump Grinding and Removal` → `stump_grinding`, matched, priced body.
- `resolve?category=Tree Trimming and Removal` → `tree_trimming`, unmatched → `generic` body.

## Next (post-merge, no PR — like prior go-lives)
Rewire tree auto-reply `blv0vfr8G2JNP8ng` `Pick Message` to prefer the resolve endpoint's body
(taxonomy-driven) over the hard-coded `isStump` branch, keeping the current literals as fallback.
