# Chat Foundry — fix: campaign ignored tag filter

Branch: `fix/chat-foundry-campaign-tags`

## Bug
Creating a campaign targeted **every** conversation matching the status/inbox (e.g. all 35 open),
ignoring the tags the operator had selected. Root cause: the Campaign form had **no tag picker**,
and `createCampaign()` posted `name, body, status, inboxId, maxRecipients` but **no `tags`**, so the
campaign's stored filters had `tags: []`. The backend was already correct — `materializeRecipients`
runs the same `buildAudience` (tag AND-filter) as the Audience preview; it just never received tags.

## Fix (UI only)
- `public/chatfoundry.html` — added a **"Require tags (all)"** picker (`#kTags`) to the Campaign
  form, a hint, and a **"↑ Use Audience filters"** button that copies status/inbox/max/tags from the
  Audience section so the campaign targets exactly what you previewed.
- `public/chatfoundry.js` — `loadTags()` now also populates `#kTags`; `createCampaign()` includes
  `tags: selectedCampaignTags()`; added `selectedCampaignTags()` and `useAudienceFilters()`; the
  campaign summary now shows the **Targeting → status + tags** it actually used (transparency).
- `public/chatfoundry.css` — `.cf-count-sub` for the targeting line.

No backend/API/migration change. `npm test` → 70/70 pass.

## Verify
Tick e.g. `hot-lead` in the Campaign tag picker (or click **Use Audience filters** after filtering
Audience), create, then **Build recipient list** — the count drops from all-open to just the tagged
subset, and the summary shows `Targeting → status open · tags: hot-lead`.
