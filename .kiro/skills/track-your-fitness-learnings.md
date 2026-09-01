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

## Firestore Sync

- **No real-time listeners** (`onSnapshot`) — they cause feedback loops: write → notify → push → snapshot → write again
- Use simple **push + pull** on demand: flush queue → get all docs → replace local → done
- `_suppressNotify` flag: set it `true` while applying remote data to prevent `notifyChange()` from queuing those writes back to Firestore
- Debounce the `tyf-sync-update` event listener so 7 store pulls don't trigger 7 screen refreshes
- Sync only happens: on app startup (if configured) + when user taps 🔄 button

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

## License System

- Date-restricted licenses: `{ n: name, f: fromDate, t: toDate, h: HMAC(name+from+to, secret) }`
- HMAC-SHA256 via Web Crypto API for verification
- Block screen on expiry: full-screen overlay with license input, no access to app
- 15-day warning before expiry
- Reject perpetual keys if app requires date-restricted only

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

## Session Persistence

- Save `currentScreen` to `sessionStorage` on navigation
- On page load, read from `sessionStorage` to restore last screen
- `setupTabNavigation()` shows the screen without re-rendering (modules already rendered in their init)