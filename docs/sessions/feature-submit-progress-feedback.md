# feature/submit-progress-feedback

## Request

Clicking the final submit button gives no feedback for ~2 seconds, so the user is likely to keep
clicking. Show something immediately — recolour the button, or move to a submission screen with a
spinner and a summary of what is happening.

## Bug found while reading the code

`confirmSubmit()` disabled the wrong button:

```js
const btn = $('btnSubmit');   // the outer "Submit intake" button
btn.disabled = true;          // "prevent double-click double-submit"
```

The button actually clicked is the **"Confirm & submit"** button inside the plan panel, which was
never disabled. So the comment claimed a protection that did not exist, and the reported
double-click path was wide open. The server's claim guard (`status <> 'submitting'` -> 409) meant a
duplicate never corrupted anything, but the user would have seen a raw 409 error.

## Changes

**Submitting screen.** Clicking Confirm replaces the whole plan panel with a progress view, which
removes the confirm button from the DOM entirely — the strongest form of double-click protection.
The view shows a spinner, the list of work in progress, and "Please keep this page open".

Steps are derived from the dry-run plan already held in `lastPlan`, so the wording matches what the
user just agreed to (link vs create customer, reuse vs create estimate, real SMS recipients, and the
tag only when there is one).

When the response lands, each step is marked from the server's `steps[]`: the spinner and the note
are removed and the title becomes "✓ Intake submitted" or "✗ Submission failed". A partial failure
therefore shows exactly how far it got, which matches the resumable server behaviour — customer and
estimate ticked, notes and SMS crossed.

**Busy state on the dry run.** The first button now shows a small inline spinner and "Checking…"
while the preview loads, since that request has the same dead-air problem.

**`api()` now carries the error payload.** It discarded the response body on failure, so
`e.reasons` in `submitIntake` was dead code that could never fire, and `e.steps` would have been
undefined too. It now attaches `status`, `reasons` and `steps` to the thrown error.

**Guard.** `submitInFlight` blocks re-entry regardless of how the handler is reached.

## Verification

Driven in the browser against the dev container. The progress view was rendered directly rather
than by firing a real submit, because dev writes to the live Housecall Pro account.

- In-flight: spinner present with `animationName: spin`, five steps listed with the plan's wording.
- Success: all five ticked, spinner and note removed, title green.
- Partial failure: customer/tag/estimate ticked, notes/SMS crossed in red, title red.

`node --test`: 129 pass.

## Note

`prefers-reduced-motion` only slows the spinner rather than stopping it, since a still spinner would
read as a frozen UI.
