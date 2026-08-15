# feature/drip-s12-template-crud

## Request
The auto-reply templates card was confusing: it only let you edit an existing body. Needed to
(1) add a new auto-reply template, (2) see/map what it connects to, and (3) link/edit/remove its
category taxonomy without friction.

## Change
Full template management on the dashboard "Auto-reply templates" card.

- **src/drip.js**: `validateTemplateCreate({group, sub, label, body, categoryKey})` — normalizes
  keys (lowercase snake), requires non-empty body, optional category.
- **src/drip_runtime.js**: `createTemplate` (INSERT, 409 on duplicate `template_key`),
  `setTemplateCategory` (set / re-link / unlink via null), `deleteTemplate` (removes history + row).
- **src/drip_routes.js** (gated `requireEdit`): `POST /api/drip/template` (422/409),
  `PUT /api/drip/template/:key/category`, `DELETE /api/drip/template/:key`.
- **public/followup.{js,css}**: per-template inline **category `<select>`** (options from the
  taxonomy keys, `(no category)` to unlink — saves on change) + **🗑 Delete**; a **➕ New template**
  form (group datalist, sub key, label, category, body). Taxonomy now loads before templates so the
  dropdown is populated on first paint.
- **tests**: +1 (`validateTemplateCreate`). 214 pass.

## Verify (dev)
- create → 201; duplicate → 409; set category null (unlink) / re-link → 200; delete → 200; delete
  again → 404. UI renders per-row category select + delete + the new-template form.
