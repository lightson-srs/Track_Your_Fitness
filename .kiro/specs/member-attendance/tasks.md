# Implementation Plan: Member Attendance

## Overview

This plan implements the Member Attendance feature for the Track Your Fitness PWA. It covers DB schema upgrade, member type classification, ID card generation with QR codes, daily attendance tracking (manual + QR scan), and attendance reporting. All code uses the existing IIFE module pattern with vanilla JavaScript — no build tools.

## Tasks

- [ ] 1. Database schema upgrade and attendance CRUD
  - [ ] 1.1 Upgrade IndexedDB to version 7 with attendance object store
    - In `js/db.js`, increment `DB_VERSION` to 7
    - Add `onupgradeneeded` logic: create `attendance` object store with keyPath `id`
    - Create indexes: `memberId` (non-unique), `date` (non-unique), `memberDate` composite `['memberId', 'date']` (unique)
    - Add `memberType` default logic: when creating a new member, set `memberType: memberType || 'Regular'`
    - _Requirements: 4.1, 4.2, 1.3_

  - [ ] 1.2 Implement attendance CRUD functions in db.js
    - Add `addAttendance(record)`, `getAttendance(id)`, `getAllAttendance()`, `updateAttendance(record)`, `deleteAttendance(id)`
    - Add `getAttendanceByMember(memberId)`, `getAttendanceByDate(date)`, `getAttendanceByMemberDate(memberId, date)`
    - Add `getAttendanceByDateRange(startDate, endDate)` using cursor on date index
    - Add `saveAttendance(memberId, date, status)` — upsert: get by memberDate index, update if exists, else create with `generateId()`
    - Add `deleteAttendanceByMember(memberId)` for cascade delete support
    - _Requirements: 4.3, 4.4_

  - [ ] 1.3 Add attendance cascade delete to member deletion
    - In `js/db.js`, update `deleteMemberCascade` (or equivalent member delete flow) to call `deleteAttendanceByMember(memberId)`
    - _Requirements: 4.3_

- [ ] 2. Checkpoint - Verify DB layer
  - Ensure the app opens without errors after schema upgrade, ask the user if questions arise.

- [ ] 3. Members screen updates (memberType field, search, Print ID)
  - [ ] 3.1 Add Member Type field to the Add/Edit form
    - In `index.html`, add a text input with `id="member-type"` between mobile and notes fields
    - Add a `<datalist>` with options: Regular, Coaching, Other for suggested values
    - In `js/members.js`, read the `member-type` input value on form submit and store as `member.memberType`
    - On edit, populate the `member-type` input with the existing `m.memberType` value
    - Default to `"Regular"` if empty on new member creation
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ] 3.2 Update Members screen search filter to include memberType
    - In `js/members.js`, update `renderMemberList` (or equivalent filter logic) to match search term against both `m.name` and `m.memberType` using case-insensitive substring
    - _Requirements: 2.1, 2.4_

  - [ ] 3.3 Add "Print ID" button to member list items
    - In `js/members.js`, add a "Print ID" button/icon in each member card's action area
    - On click, call `IdCard.generate(member)` (wired after id-card.js is created)
    - _Requirements: 3.1_

- [ ] 4. Monthly and Guest/Sessions search filter updates
  - [ ] 4.1 Update Monthly screen search to include memberType
    - In `js/monthly.js`, update the search filter in `renderMonthlyList` to also match against `m.memberType` using case-insensitive substring
    - _Requirements: 2.2, 2.4_

  - [ ] 4.2 Update Guest/Sessions screen search to include memberType
    - In `js/guestplay.js`, update the search filter in `renderGuestList` to also match against `m.memberType` using case-insensitive substring
    - _Requirements: 2.3, 2.4_

- [ ] 5. ID Card module and print overlay
  - [ ] 5.1 Create `js/id-card.js` module (IIFE pattern)
    - Implement `IdCard.generate(member)` — builds ID card HTML with member name, mobile, memberType, notes, member ID, and QR code
    - Implement `IdCard.renderQR(container, memberId)` — uses existing `qrcode-lib.js` QRCode constructor to encode member ID
    - Implement `IdCard.hide()` — hides the print overlay
    - Implement `IdCard.triggerPrint()` — calls `window.print()` after 300ms delay for QR rendering
    - _Requirements: 3.2, 3.3_

  - [ ] 5.2 Add ID Card print overlay HTML and CSS print styles
    - In `index.html`, add a hidden overlay `<div id="id-card-overlay">` with card layout structure
    - In `css/` (or inline `<style>`), add `@media print` rules to hide all content except `#id-card-overlay` when visible
    - Style the card with dimensions suitable for card stock printing
    - _Requirements: 3.4, 3.5_

- [ ] 6. Checkpoint - Verify member type and ID card
  - Ensure member type field works on add/edit, search filters work on all screens, and ID card generates correctly. Ask the user if questions arise.

- [ ] 7. Attendance screen HTML and JS module
  - [ ] 7.1 Add Attendance screen HTML to index.html
    - Add a new screen section `<div id="attendance-screen">` with: date picker (defaulting to today), member list with checkboxes, "Select All" toggle, "Copy from yesterday" button, "Scan QR" button
    - Add "Attendance" menu item to the More menu navigation
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 6.1, 7.1_

  - [ ] 7.2 Create `js/attendance.js` module (IIFE pattern) — core rendering
    - Implement `Attendance.init()` — binds date picker change, search input, Select All toggle, Copy from Yesterday, Scan QR button
    - Implement `Attendance.renderAttendance()` — loads active members from DB, loads existing attendance records for selected date, renders checkboxes with pre-checked state for members marked 'present'
    - _Requirements: 5.2, 5.3, 5.7_

  - [ ] 7.3 Implement attendance checkbox and Select All logic
    - Implement `handleCheckboxChange(memberId, checked)` — calls `DB.saveAttendance(memberId, date, checked ? 'present' : 'absent')`
    - Implement `handleSelectAll(checked)` — iterates all member checkboxes, sets state, saves records for each
    - _Requirements: 5.4, 5.5, 5.6_

  - [ ] 7.4 Implement "Copy from yesterday" functionality
    - Implement `handleCopyFromYesterday()` — calculates previous day relative to selected date, queries attendance records with status 'present' for that day
    - If records found, check those members' checkboxes and save 'present' records for selected date
    - If no records exist for previous day, display notification: "No attendance records found for the previous day"
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ] 8. QR Scanner integration for attendance
  - [ ] 8.1 Implement QR scanner with dynamic CDN loading
    - In `js/attendance.js`, implement `startQRScanner()` — dynamically loads html5-qrcode from CDN if not already loaded (following sync-engine.js pattern for lazy loading)
    - Create Html5QrcodeScanner instance, open camera viewfinder
    - Implement `stopQRScanner()` — stops and clears scanner instance
    - _Requirements: 7.1, 7.2_

  - [ ] 8.2 Implement QR scan success and error handling
    - Implement `handleQRScanSuccess(decodedText)` — looks up member by decoded ID in members store
    - If member found: save attendance record with status 'present' for today's date, display confirmation with member name, member type, and outstanding balance (via `Monthly.calcMemberBalance`)
    - If member not found: display error "Member not found"
    - Handle camera access denied: display "Camera access is required for QR scanning"
    - _Requirements: 7.3, 7.4, 7.5, 7.6, 7.7_

- [ ] 9. Checkpoint - Verify attendance screen and QR scanner
  - Ensure attendance marking, Select All, Copy from Yesterday, and QR scanning all work correctly. Ask the user if questions arise.

- [ ] 10. Attendance report tab
  - [ ] 10.1 Add Attendance tab to Reports screen
    - In `index.html`, add an "Attendance" tab button to the Reports screen tab bar
    - Add report content area with start date and end date pickers, member list area, and search field
    - _Requirements: 8.1, 8.2, 8.6_

  - [ ] 10.2 Implement attendance report rendering in reports.js
    - In `js/reports.js`, add `'attendance'` to tab switching logic
    - Implement `renderAttendanceReport()` — queries attendance by date range, aggregates per-member 'present' counts, sorts by count descending, renders expandable rows
    - On member row tap/click, expand to show specific dates marked 'present' within range
    - Add search filter for report by member name or memberType
    - _Requirements: 8.3, 8.4, 8.5, 8.6_

- [ ] 11. Sync engine and service worker updates
  - [ ] 11.1 Update sync engine for attendance store
    - In `js/sync-engine.js`, add `'attendance'` to the `SYNCED_STORES` array
    - Add `attendance` entry to `STORE_METHOD_MAP`: `{ getAll: 'getAllAttendance', update: 'updateAttendance', delete: 'deleteAttendance' }`
    - _Requirements: 4.1_

  - [ ] 11.2 Update service worker cache and add script tags
    - In `sw.js`, add `js/attendance.js` and `js/id-card.js` to the precache file list
    - In `index.html`, add `<script src="js/id-card.js"></script>` and `<script src="js/attendance.js"></script>` tags (before app.js)
    - In `js/app.js`, call `Attendance.init()` during app initialization
    - _Requirements: 5.1_

- [ ] 12. Final checkpoint - Full integration verification
  - Ensure all tests pass, all screens work together, navigation is correct, and sync includes attendance data. Ask the user if questions arise.

## Notes

- All modules use the existing IIFE pattern with vanilla JavaScript — no build tools
- The `qrcode-lib.js` already exists in the project for QR generation; `html5-qrcode` is loaded dynamically from CDN for scanning
- Property-based tests are skipped for faster MVP delivery
- Existing member records without `memberType` are handled gracefully (treated as undefined/empty in search and UI)
- The attendance upsert pattern (get-then-put by composite index) ensures no duplicate records per member per day
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation throughout implementation

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "3.1", "4.1", "4.2"] },
    { "id": 3, "tasks": ["3.2", "3.3", "5.1"] },
    { "id": 4, "tasks": ["5.2", "7.1"] },
    { "id": 5, "tasks": ["7.2", "10.1"] },
    { "id": 6, "tasks": ["7.3", "7.4", "10.2"] },
    { "id": 7, "tasks": ["8.1"] },
    { "id": 8, "tasks": ["8.2", "11.1"] },
    { "id": 9, "tasks": ["11.2"] }
  ]
}
```
