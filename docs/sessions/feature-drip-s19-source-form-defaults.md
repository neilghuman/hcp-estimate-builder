# feature/drip-s19-source-form-defaults

## Request
On the per-source pages, default the "new" forms to that page's source.

## Change (front-end only)
`public/followup.js`: when `PAGE.mode === 'source'`, prefill —
- New sequence form `.ns-source` → the page's source
- Add-mapping `#taxSource` → the page's source
- New template `.fu-nt-group` → the source's group prefix (e.g. `autoreply_lsa_`)

## Verify (dev)
LSA page: group input prefilled `autoreply_lsa_`, taxonomy source `google_lsa` selected. `node --check`
clean; 215 tests.
