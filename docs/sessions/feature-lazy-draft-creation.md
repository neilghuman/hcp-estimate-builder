# feature/lazy-draft-creation

Follow-up to the review of #2.

## Problem

#2 made `init()` call `startNew()` unconditionally on page load, so **every page load and every
refresh inserted a `customer_intakes` row**. Measured before the fix: 10 completely empty drafts out
of 43 rows, and the total moved 41 -> 43 purely from opening the page during a debugging session.

Besides the unbounded growth, the empty rows pollute the `intake_report` view added in S9 and make
the "Recent drafts" list mostly noise.

## Fix

The draft row is now created lazily, on the first real edit rather than on page load.

- `ensureDraft()` POSTs the draft only if one isn't already active, and coalesces concurrent callers
  through a `draftPending` promise. Without that, a burst of keystrokes would each fire a POST.
- `markFormDirty()` calls it, so the row appears the moment the user actually types something.
- `save()` and `saveDiscovery()` await it instead of bailing out with "Start an intake first",
  which is no longer reachable in the normal flow.
- `init()` enables the form and focuses the first field directly; `?t=<id>` still resumes a draft.
- `startNew()` is removed. Its button was deleted in #2, so the only caller was the page-load path.

Also moved `setupFormDirtyTracking()` out of `markActive()` into `init()`. `markActive()` runs on
every draft load, so the listeners were being re-attached to the same fields each time.

## Verification (browser-driven against the dev container)

| Check | Result |
| --- | --- |
| Several page loads | row count stayed at 43 |
| ~15 keystrokes across two fields | 43 -> 44, exactly one row |
| Save | `formDirty` false, badge `✓ Saved`, values persisted |
| `?t=<id>` resume | loaded the values, created no new row |
| Edit then Submit | blocked, `● Unsaved changes`, save button focused |

The test row was deleted afterwards; count back to 43.

## Not done

The 10 pre-existing empty drafts are left in place — cleaning them is a data decision, not a code
one.
