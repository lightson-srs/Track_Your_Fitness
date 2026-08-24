# Implementation Plan: Firestore Sync Setup

## Overview

This plan implements configurable Firestore cloud sync for the Track Your Fitness PWA. Three new IIFE modules are created (`firestore-config.js`, `sync-engine.js`, `setup-wizard.js`), existing modules are modified to hook into the sync layer, and the UI is extended with a setup wizard modal and a Cloud Sync settings section. Firebase compat SDK is loaded dynamically from CDN only when sync is enabled.

## Tasks

- [ ] 1. Create FirestoreConfig module
  - [ ] 1.1 Create `js/firestore-config.js` with config storage and validation logic
    - Implement IIFE module with localStorage get/set for all `tyf_firestore_` keys
    - Implement `validate(configObj, collectionName)` with regex `/^[a-zA-Z0-9_-]{1,50}$/` for collection name
    - Implement `hasConfig()` checking mandatory fields (apiKey, projectId, appId)
    - Implement `isSyncEnabled()`, `setSyncEnabled()`, `isWizardSkipped()`, `setWizardSkipped()`
    - Implement `clear()` to remove all firestore keys
    - _Requirements: 2.1, 2.2, 2.3, 1.3, 1.4_

  - [ ]* 1.2 Write property test for configuration round-trip (Property 1)
    - **Property 1: Configuration validation round-trip**
    - Generate random valid configs, store and retrieve, assert equality
    - **Validates: Requirements 2.1, 2.2, 2.3**

  - [ ]* 1.3 Write property test for invalid collection name rejection (Property 2)
    - **Property 2: Invalid collection names are rejected**
    - Generate strings not matching collection name regex, assert validation fails
    - **Validates: Requirements 1.3, 1.7**

  - [ ]* 1.4 Write property test for mandatory fields enforcement (Property 3)
    - **Property 3: Mandatory fields enforcement**
    - Generate config objects with random mandatory field removals, assert validation fails
    - **Validates: Requirements 1.4, 1.7**

- [ ] 2. Create Setup Wizard UI and module
  - [ ] 2.1 Add setup wizard modal HTML to `index.html`
    - Insert modal overlay markup before the closing `</body>` tag (before scripts)
    - Include fields: collection name, apiKey, projectId, appId, and optional fields in a `<details>` block
    - Include error message container and Connect/Skip buttons
    - _Requirements: 1.1, 1.3, 1.4_

  - [ ] 2.2 Create `js/setup-wizard.js` IIFE module
    - Implement `init()` to check wizard launch condition (no config AND not skipped)
    - Implement `show()` to display modal and block navigation
    - Implement `hide()` to dismiss modal
    - Implement submit handler: validate via `FirestoreConfig.validate()`, store via `setConfig()`/`setCollectionName()`, enable sync, dismiss
    - Implement skip handler: set wizard skipped flag, dismiss modal
    - Show inline validation errors on invalid submission
    - _Requirements: 1.1, 1.2, 1.5, 1.6, 1.7_

- [ ] 3. Add Cloud Sync section to Settings page
  - [ ] 3.1 Add Cloud Sync HTML section to settings screen in `index.html`
    - Insert new `settings-section` div before "Backup & restore" section
    - Include sync status indicator, enable/disable toggle, all config fields, save button
    - _Requirements: 3.1, 3.5, 3.6_

  - [ ] 3.2 Add Cloud Sync settings logic to `js/settings.js`
    - Implement `initSyncSettings()` to populate fields from `FirestoreConfig.getConfig()`
    - Implement save handler: validate, update localStorage, call `SyncEngine.reinitialize()`
    - Implement sync toggle: enable/disable sync without deleting config
    - Implement sync status display (connected/disconnected/disabled)
    - Implement collection name change confirmation dialog
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 7.3, 7.4_

- [ ] 4. Checkpoint - Validate config and UI modules
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Create SyncEngine module
  - [ ] 5.1 Implement Firebase SDK dynamic loading in `js/sync-engine.js`
    - Create `loadFirebaseSDK()` using script element injection from CDN
    - Use compat SDK URLs (firebase-app-compat.js, firebase-firestore-compat.js v10.12.2)
    - Handle load failures with non-blocking notification, set status to disabled
    - Generate and store `tyf_device_id` in localStorage if not present
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ] 5.2 Implement sync queue management in `js/sync-engine.js`
    - Implement queue storage in localStorage under key `tyf_sync_queue`
    - Implement `notifyChange(storeName, record, opType)` to enqueue changes with `_lastModified` timestamp
    - Implement queue deduplication (latest operation wins for same docId)
    - Implement `getQueueSize()` and localStorage quota exceeded handling
    - _Requirements: 4.4, 4.6_

  - [ ]* 5.3 Write property test for sync queue preservation (Property 4)
    - **Property 4: Sync queue preserves all pending changes**
    - Generate random sequences of write ops, assert queue contains correct final state
    - **Validates: Requirements 4.4, 4.5**

  - [ ]* 5.4 Write property test for queue deduplication (Property 8)
    - **Property 8: Queue deduplication — latest operation wins**
    - Generate multiple ops on same docId while offline, assert queue contains only latest
    - **Validates: Requirements 4.4**

  - [ ] 5.5 Implement local-to-remote sync (push) in `js/sync-engine.js`
    - Implement `flushQueue()` to write queued changes to Firestore
    - Use collection path `{collectionName}/{storeName}/{documentId}`
    - Implement exponential backoff retry (1s initial, 60s max) on network errors
    - Remove queue entries on successful write
    - Listen for `online` event to trigger flush
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 7.1, 7.2_

  - [ ]* 5.6 Write property test for collection path scoping (Property 6)
    - **Property 6: Collection path scoping**
    - Generate random collection names, store names, doc IDs, assert path format equals `{collectionName}/{storeName}/{documentId}`
    - **Validates: Requirements 7.1, 7.2**

  - [ ]* 5.7 Write property test for timestamp attachment (Property 7)
    - **Property 7: Timestamp attachment on write**
    - Generate sequences of writes to same doc, assert timestamps are monotonically non-decreasing and valid ISO 8601
    - **Validates: Requirements 4.6**

  - [ ] 5.8 Implement remote-to-local sync (pull) in `js/sync-engine.js`
    - Attach Firestore real-time snapshot listeners for all six synced stores
    - Compare remote `_lastModified` with local record timestamp (last-writer-wins)
    - Apply remote changes to IndexedDB when remote is newer
    - Handle remote deletions by deleting local records
    - Dispatch `tyf-sync-update` custom event on document after applying changes
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 5.9 Write property test for last-writer-wins resolution (Property 5)
    - **Property 5: Last-writer-wins conflict resolution**
    - Generate pairs of timestamps, assert higher timestamp record wins
    - **Validates: Requirements 5.2, 5.4**

  - [ ] 5.10 Implement `init()`, `reinitialize()`, `disconnect()`, and `getStatus()` in `js/sync-engine.js`
    - `init()`: load SDK if config present and sync enabled, connect to Firestore, attach listeners, flush queue
    - `reinitialize()`: disconnect existing listeners, re-init with new config
    - `disconnect()`: detach all listeners, clear state, cancel retry timers
    - `getStatus()`: return 'connected' | 'disconnected' | 'disabled'
    - _Requirements: 2.4, 6.4, 7.3_

- [ ] 6. Checkpoint - Validate SyncEngine module
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Integrate sync hooks into existing modules
  - [ ] 7.1 Add sync notification hook to `js/db.js`
    - Add `notifySyncIfAvailable(storeName, record, opType)` helper function
    - Call hook after every write operation (add/update/delete) for all six stores: members, contributions, payments, expenses, guest_sessions, monthly_fee_records
    - Ensure hook is fire-and-forget (wrapped in try/catch, non-blocking)
    - _Requirements: 4.1, 6.4_

  - [ ] 7.2 Update `js/app.js` to initialize wizard and sync engine
    - Add `SetupWizard.init()` call after `DB.init()` in `initApp()`
    - Add `SyncEngine.init()` call after setup wizard init
    - Add `tyf-sync-update` event listener to call `refreshScreenData(currentScreen)`
    - Export `refreshScreenData` from the App module for external access
    - _Requirements: 5.5, 1.1_

  - [ ] 7.3 Add script tags for new modules in `index.html`
    - Insert `<script src="js/firestore-config.js"></script>` after `settings.js`
    - Insert `<script src="js/sync-engine.js"></script>` after `firestore-config.js`
    - Insert `<script src="js/setup-wizard.js"></script>` after `sync-engine.js`
    - _Requirements: 8.1_

  - [ ] 7.4 Update `sw.js` to cache new files
    - Add `js/firestore-config.js`, `js/sync-engine.js`, `js/setup-wizard.js` to the service worker cache list
    - Bump the cache version to trigger update on existing installations
    - _Requirements: 6.1, 6.2_

- [ ] 8. Final checkpoint - Full integration verification
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using fast-check
- Unit tests validate specific examples and edge cases
- The Firebase compat SDK is loaded dynamically — no build tools required
- All new modules follow the existing IIFE pattern used throughout the project
- The sync engine is non-blocking: local IndexedDB operations are never delayed by Firestore responses

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1"] },
    { "id": 3, "tasks": ["3.2", "5.1"] },
    { "id": 4, "tasks": ["5.2"] },
    { "id": 5, "tasks": ["5.3", "5.4", "5.5"] },
    { "id": 6, "tasks": ["5.6", "5.7", "5.8"] },
    { "id": 7, "tasks": ["5.9", "5.10"] },
    { "id": 8, "tasks": ["7.1", "7.2", "7.3"] },
    { "id": 9, "tasks": ["7.4"] }
  ]
}
```
