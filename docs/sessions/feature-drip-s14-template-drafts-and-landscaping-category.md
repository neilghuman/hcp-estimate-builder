# feature/drip-s14-template-drafts-and-landscaping-category

## Request
"Add an auto-reply for each category taxonomy." (All categories; placeholders I'll edit later.)

## Constraints found
- Thumbtack **tree** + Thumbtack **landscaping** leads carry `Category:` → category-detectable.
- **LSA landscaping** leads carry NO category (its enroll builder extracts none) → cannot be made
  category-aware; the google_lsa-only keys `garden_decor`/`paving` have no signal, so skipped.
- Placeholders must never be sent → need a draft/active gate.

## Change
- **migration 031_drip_template_active.sql**: `drip_template.is_active BOOLEAN NOT NULL DEFAULT true`.
- **src/drip.js**: `validateTemplateCreate` carries `isActive` (default true).
- **src/drip_runtime.js**: `createTemplate` honors `isActive`; `setTemplateActive`; `resolveAutoreply`
  and the n8n group map (`getTemplateGroup`) now only see `is_active = true` rows (drafts are invisible
  to n8n → auto-replies keep current copy until activated); `getTemplates` returns `is_active`.
- **src/drip_routes.js**: `PUT /api/drip/template/:key/active`; `POST` accepts `isActive`.
- **public/followup.{js,css}**: per-template `draft` badge + muted card + `▶ Activate`/`⏸ Deactivate`.
- **tests**: `validateTemplateCreate` covers `isActive`. 214 pass.

## Verify (dev)
Draft template → `resolve` returns `matched:false` (falls back to generic); after activate →
`matched:true`. Column present.

## Post-merge (no PR)
- Bulk-create DRAFT category templates: tree → `tree_trimming`; landscaping →
  `grading, land_clearing, lawn_care, sod, artificial_turf` (placeholders, `is_active=false`).
- Rewire Thumbtack landscaping auto-reply `xDFf8jXdBw6PRx1L` to be category-aware (like tree):
  `Resolve Category` node + prefer `R.body`, else the existing time-based copy. LSA left as-is.
- User writes real copy per category in the dashboard, then Activates each.
