---
name: track-your-fitness-learnings
description: Key technical learnings and patterns from building the Track Your Fitness PWA
---

# Track Your Fitness — Technical Learnings

## QR Code Library (qrcode-lib.js)

- The library renders QR codes as **SVG** elements (not canvas, not table, not img)
- `el.innerHTML = qr.createSvgTag(cell, margin)` is how it outputs
- To capture QR as an image: serialize SVG → load as `<img>` with `data:image/svg+xml` URL → draw onto canvas
- Never use `querySelector('canvas')` or `querySelector('table')` to find the QR — it won't be there
- `html2canvas` cannot capture SVG QR codes correctly — always renders partial (1/4)

## Sharing Images (Web Share API)

- `navigator.share({ files: [...] })` requires a **user gesture context** — too many `await` calls between the click and the share breaks it
- SVG foreignObject approach fails because CSS styles aren't inherited and images cause "tainted canvas" errors
- **Best approach**: Draw the entire shareable card on a `<canvas>` manually using Canvas 2D API, then export as PNG blob
- For QR in shared images: render SVG → serialize → load as img → `ctx.drawImage()` onto the card canvas
- Pre-load libraries when the card opens (not on share click) to minimize async gap

## Service Worker

- **Never auto-reload** on SW update — `window.location.reload()` in `controllerchange` or `SW_UPDATED` handlers causes infinite reload loops (6-7 times)
- Use `skipWaiting()` + `clients.claim()` but DON'T broadcast reload messages
- Updates load silently on next visit — this is the safest approach
- Bump `CACHE_NAME` version on every deploy to invalidate old cache

## Screen Navigation & Rendering Loops

- `.screen` elements should NOT have `tabindex="0"` or receive `.focus()` — this triggers `change` events on date inputs inside the screen, causing infinite render loops
- Each module's `init()` calls its own render. `navigateToScreen()` should NOT call `refreshScreenData()` on startup — only when user explicitly navigates
- `initDatePickers()` should only run once at app startup, not on every navigation
- Date inputs with `addEventListener('change', renderFunction)` + programmatic `.value` setting = infinite loop risk

## Firestore Sync (Sync V2 — version history)

- **No real-time listeners** (`onSnapshot`) — they cause feedback loops: write → notify → push → snapshot → write again
- `_suppressNotify` flag: set it `true` while applying remote data to prevent `notifyChange()` from queuing those writes back to Firestore
- Debounce the `tyf-sync-update` event listener so 7 store pulls don't trigger 7 screen refreshes
- Sync happens: on app startup / refresh (quick check) + header 🔄 button + Settings "Full sync from DB"

### Version model (two distinct "versions")
- **Per-record** `updatedAt` (ms) + `version`, stamped at the DB write layer (`db.js stampRecord`). Travels with the record.
- **Global** `/sync/meta` doc holds `{ generation, revision }`. Layout: `<collection>_sync/meta` + change stream `<collection>_sync/meta/changes/rev_<zeropad12>` with `{ rev, generation, store, docId, op, ts }`.
- Local cursor persisted in localStorage: `tyf_sync_generation` / `tyf_sync_revision`.
- **Offline, the global revision does NOT advance** — only per-record `updatedAt`/`version` bump. The revision is allocated at push time (one per change envelope), inside a Firestore `runTransaction` (atomic allocator — the Firestore equivalent of ETag/If-Match).

### Pull: cache-first, incremental, with full-merge fallback
- Read `/sync/meta`. If local cursor == remote head → **cache-first, download nothing**.
- If behind within `CHANGE_WINDOW` (500) → replay only missing change envelopes in order, applying each affected doc **by id**; advance cursor only after each success.
- Fall back to **full merge** when: no `/sync/meta`, generation mismatch, local ahead, gap > window, missing revision, or any read/apply error.

### Sync triggers & controls (decided UX)
- **Page load / refresh → quick Sync V2 check** automatically (`app.js init → SyncEngine.init → sync → cache-first/incremental pull`). This is the lightweight path; it must NOT do a full merge unless the cursor forces fallback.
- **Header 🔄 button** (banner) → quick sync (`flushQueue → sync`). Keep it; it is NOT the full sync.
- **"Full sync from DB" button → Settings tab ONLY** (`#sync-fullsync-btn`, Cloud Sync section). It is the explicit authoritative pull (`push` + unconditional `fullMerge` + adopt head). Never put full sync in the header/banner.
- **Full sync does NOT bump `generation`** (option B). Bumping generation would force every other device into a full merge on their next load, defeating cache-first incremental sync. Generation bumps are reserved for a true baseline reset, never for a routine manual sync.

### Service-worker cache lag (why a new button "isn't there")
- After deploying new HTML/JS, users keep seeing the OLD UI because the cache-first SW serves the cached `index.html`/JS. A missing just-added button is almost always this, not a code bug.
- Always **bump `CACHE_NAME`** on deploy. Even so, SW updates typically need a **second reload** to activate (first load installs the new SW in the background). Verify the deployed file over `raw.githubusercontent.com` to confirm the code shipped before debugging the UI.

### CRITICAL: pulls must be NON-DESTRUCTIVE (data-loss lesson)
- **Never delete a local record just because it is absent from the remote.** "Absent" is ambiguous — it usually means "created locally, not yet pushed" (first sync / empty remote). The original `fullMerge` deleted local-only records → a member added then refreshed got WIPED when the remote was empty.
- Deletions propagate **only** via explicit `delete` change envelopes in `incrementalPull → applyRemoteDoc(store, id, 'delete')`. Full merge is **upsert-only**.
- Tradeoff accepted: a record deleted directly in the Firestore console (no change envelope) won't be removed from local by a pull. A true "mirror remote" wipe must be a deliberate, separate action.

### Append-only vs upsert by store
- **Money/event records** (`payments`, `guest_sessions`, `monthly_fee_records`) → treat as append-only; each has its own `id`, only ever created. Two devices collecting offline create two distinct rows — keep both. Balance is derived as `sum(fees) − sum(payments)`.
- **Mutable state** (`members`, `contributions`) → upsert by `id`.

## Optimistic Concurrency (reject-and-flag)

For two PWAs that go offline, both edit, then reconnect:
- **Base token** `_baseUpdatedAt` = the server `updatedAt` the record was last synced from. `stampRecord` captures it on the first local edit and preserves it across repeated offline edits; a brand-new record has none (a create cannot conflict). `DB.markSynced(record)` sets it when a record is written from/to the server.
- **Push**: inside the transaction, also `tx.get` the remote doc. For an update to an existing doc, if `remote.updatedAt !== base` → someone edited it elsewhere → **reject ONLY that record** (throw a tagged `_tyfConflict`, flag it, drop from queue), and continue pushing the rest. Accepted writes refresh the local base.
- **Full merge**: per record — remote-only → add; local clean → accept remote; local dirty + remote unchanged since base → keep local; local dirty + remote moved → **conflict** (flag, keep local, don't overwrite).
- **Reject only the specific record, never abort the batch.** This is last-base-wins-with-flagging, not auto-merge: first pusher wins, loser is flagged to re-apply.
- Conflicts registry in localStorage (`tyf_sync_conflicts`), surfaced in Settings as a conflict panel + activity-log entries; `tyf-sync-conflict` event keeps the panel live.
- Adds never conflict (distinct ids). Append-only records never conflict (create-only).

## Sync Debugging — on-screen activity log

- The silent "Test connection does nothing" class of bug is usually: (a) **stale service worker** serving old JS (bump `CACHE_NAME`!), or (b) the **Firebase SDK blocked** from `gstatic.com` (extension/network), leaving `await loadFirebaseSDK()` hung.
- Mitigations that make failures visible instead of silent: wrap the test in a `Promise.race` **timeout** (~20s) and give `loadScript` its own per-script timeout (~15s) so a stalled CDN rejects.
- Add a persisted **activity log** (last 40, localStorage `tyf_sync_log`, newest-first) rendered in Settings — `logActivity(status,msg)` + `renderLog()`. Instrument each sync step (clicked → config read → SDK load → connect → read → result) so you can see exactly where it stalls. Mirrors the Lights On project's log pattern.
- Verify the backend independently of the browser SDK with a **REST probe**: `GET https://firestore.googleapis.com/v1/projects/<proj>/databases/(default)/documents/<collection>_members?key=<apiKey>&pageSize=1`. HTTP 200 `{}` = credentials valid, rules allow read, collection just empty.
- Firestore **creates collections/documents implicitly on first write** — never pre-create them.
- API key + project ID are **not secrets** in Firebase's model (they ship in every client; access is controlled by security rules).

## iOS / Mobile Fixes

- iOS Safari blocks `window.open()` after async gaps — use `<a>` click for synchronous user gestures, toast with tappable link for post-async
- `<datalist>` doesn't work reliably on mobile — use `<select>` with an "Other" option + hidden text input
- `overflow: hidden` on screens prevents scrolling on mobile — use `overflow-y: auto`
- Bottom nav bar: use `position: fixed; bottom: 0` not `position: sticky` (sticky breaks when banner/content pushes it down)
- PWA home screen icons don't auto-update — user must delete and re-install

## Print

- `@media print` must override: `overflow: visible`, `height: auto`, `flex: none` on all screen containers
- Report tables need `page-break-inside: auto` on table, `page-break-inside: avoid` on rows
- Hide: nav bar, header, filters, buttons in print
- Body needs: `display: block`, `max-width: none`, `box-shadow: none`

## IndexedDB

- Composite indexes: declare with `{ unique: true }` to prevent duplicates (e.g., member+date for attendance/fees)
- `index.get()` on non-unique composite index only returns first match — use cursor if multiple possible
- Run deduplication cleanup on app startup for stores that may have accumulated duplicates
- DB version must be bumped for schema changes — `onupgradeneeded` handles migrations
- Synced records carry sync fields stamped at the write layer: `updatedAt` (ms), `version`, and `_baseUpdatedAt` (optimistic-concurrency base token). `db.js` has `setSuppressStamp(on)` so the sync engine's writes of remote records don't re-stamp them, and `markSynced(record)` to set the base token after a server write.
- **Unique composite index caveat under offline multi-device**: a `{ unique: true }` index like `memberDate` on fee records prevents duplicates, but two devices applying the same member+date offline can throw a `ConstraintError` on the second write. Decide per store whether "overwrite one" (keep unique) or "allow two" (drop unique) is correct.

## License System

- Date-restricted licenses: `{ n: name, f: fromDate, t: toDate, h: HMAC(name+from+to, secret) }`
- HMAC-SHA256 via Web Crypto API for verification
- Block screen on expiry: full-screen overlay with license input, no access to app
- 15-day warning before expiry
- Reject perpetual keys if app requires date-restricted only
- **Hard-lock, consistent across layers**: the inline gate in `index.html` and `license.js` must agree. No free tier — unlicensed/expired/perpetual = app blocked and every data-entry action refused with the same message (`_checkMonthlyFee`/`_checkGuestFee`/`_checkMemberLimit` and `License.check*` all return "valid license required" when unlicensed; `getMax*` return 0). Backup restore and CSV import refuse when unlicensed rather than clamping to a cap. Pitfall to avoid: two layers disagreeing (inline gate allowing a capped free tier while `license.js` locks out).

## ID Card

- QR library renders SVG — use `XMLSerializer` to serialize, then load as img for canvas drawing
- Member photo: compress to 200x200 JPEG at 0.5 quality (~30-50KB), store as base64 data URL in member record
- Card view uses HTML/CSS (pretty). Share uses pure canvas drawing (reliable).
- `drawCardOnCanvas()` draws text/photo/QR manually — no html2canvas dependency

## Attendance

- Filter buttons (Absent/Present/All): re-apply filter after checkbox toggle to hide/show rows immediately
- Save button pattern: checkboxes update UI only, "Save Attendance" commits to DB
- `DB.saveAttendance(memberId, date, status)` is an upsert — uses unique composite index
- Copy from date: modal with date picker, queries source date's present records, applies to target date
- **Auto-reactivate deactivated members**: QR scan does a direct `DB.getMember(id)` (finds any status); if inactive → set `status:'active'` + persist, then mark present. Marking an inactive member present on manual Save also reactivates.
- **"Include deactivated members" checkbox** (default off): when off, list filters `status !== 'inactive'`; when on, inactive members are listed/searchable (badged "deactivated"). Keep this filter in the manual list only — the QR path is a direct ID lookup and needs no checkbox.

## Dues model — fee records are the source of truth

- Monthly dues are derived from `monthly_fee_records` (charges) minus monthly `payments`, NOT from the `contributions` (enrollment) row. A member can owe money without a contribution.
- Monthly tab + Outstanding report must include members who have **either** a contribution **or** any fee record (union), not just enrolled members. Gating only on `contribMap[m.id]` hides real dues when enrollment didn't persist.
- `calcMemberBalance` must not early-return `balance:0` when the contribution is missing — compute from fee records; only return zero when there are neither fee records nor a usable contribution.
- Fee record `status` ('pending') is cosmetic for the balance — balance is purely `sum(fees ≤ date) − sum(payments ≤ date)`.
- When bulk-applying fees, write the fee record in its OWN try/catch separate from the contribution write, so a contribution failure doesn't skip the fee record (the actual due). Surface per-item failures instead of swallowing them.

## Reports — filters & totals

- Populate filter dropdowns (member type, expense category) dynamically from the data present, preserving the current selection, falling back to "all" if the selection disappears.
- When a filter is applied, the header/grand total AND the per-column totals footer must reflect the **filtered** set, not all records in range — otherwise totals mismatch the visible rows.
- Column totals: use a `<tfoot>` with a `.report-total-row`; scope the "last row loses bottom border" rule to `tbody` so the footer keeps its separator.
- Fee Collection report is collections-only (sums payments received) — unpaid members legitimately don't appear there; dues live in the Outstanding report.

## Session Persistence

- Save `currentScreen` to `sessionStorage` on navigation
- On page load, read from `sessionStorage` to restore last screen
- `setupTabNavigation()` shows the screen without re-rendering (modules already rendered in their init)