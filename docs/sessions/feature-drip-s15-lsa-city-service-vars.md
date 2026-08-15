# feature/drip-s15-lsa-city-service-vars

## Request
"Add the city and the service into the LSA drip follow-ups." (Thumbtack handled separately.)

## Change (app)
- **migration 032_drip_enrollment_city.sql**: `drip_enrollment.city TEXT`.
- **src/drip_runtime.js**: `enrollLead` stores `lead.city`; `getDue` selects `city` + `category_raw`.
- **src/drip_sweep.js**: `renderVars` (now exported) adds `{city}` (fallback "your area") and improves
  `{service}` — humanized `category_key`, else humanized `category_raw`, else "your project".
- **tests**: +1 (`renderVars` city/service fallbacks). 215 pass.

## Follow-up (no PR)
- LSA enroll (n8n `Build Drip Enroll`) captures `Service:` (categoryRaw) + `Location:` (city).
- Fold `{city}` into the LSA drip message bodies (already use `{service}`).
