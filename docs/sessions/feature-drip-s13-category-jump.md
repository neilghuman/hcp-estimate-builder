# feature/drip-s13-category-jump

## Request
"When I click on a category key, I want the screen to scroll where it is connected to."

## Change (UI only)
Category keys are now clickable jump-links that reveal their connection:
- **Template 🏷️ badge** → scrolls to the matching **Category taxonomy** row(s) and flashes them.
- **Category-taxonomy key** → scrolls to the **template(s)** linked to that key and flashes them.

Files: `public/followup.js` (badge + taxonomy key rendered as buttons with `data-cat`; `revealElements`
flash-and-scroll helper; `revealTaxonomyForCategory` / `revealTemplatesForCategory`; click handlers on
`#templates` and `#taxBody`), `public/followup.css` (`.fu-linkkey`, `.fu-tax-key`, `.fu-flash` keyframe).
If nothing is linked yet, a friendly note is shown instead. No backend/API change; 214 tests still pass.
