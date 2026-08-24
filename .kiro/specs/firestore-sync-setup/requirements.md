# Requirements Document

## Introduction

This feature adds configurable Firestore cloud sync to the Track Your Fitness PWA. The local IndexedDB remains the primary data store for offline-first operation, while Firestore acts as a sync backend enabling real-time multi-device access. On first launch (when no configuration exists), the app presents a setup wizard to collect the database name and Firestore project credentials. These settings are editable later from the Settings page.

## Glossary

- **App**: The Track Your Fitness progressive web application
- **Setup_Wizard**: A modal dialog shown on first launch to collect Firestore configuration from the user
- **Firestore_Config**: The set of Firebase project credentials (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId) required to connect to a Firestore instance
- **Collection_Name**: A user-defined string that acts as the top-level Firestore collection prefix, allowing multiple clubs to share a single Firebase project
- **Sync_Engine**: The module responsible for bidirectional synchronization between local IndexedDB and remote Firestore
- **Local_Store**: The IndexedDB database used as the primary offline data store
- **Settings_Page**: The existing Settings screen in the app where Firestore configuration can be viewed and edited

## Requirements

### Requirement 1: First-Launch Setup Wizard

**User Story:** As a club administrator, I want to be prompted for Firestore configuration on first launch, so that I can set up cloud sync without navigating through settings manually.

#### Acceptance Criteria

1. WHEN the App launches and no Firestore_Config is found in localStorage, THE Setup_Wizard SHALL display a modal dialog requesting Collection_Name and Firestore_Config fields.
2. WHILE the Setup_Wizard is displayed, THE App SHALL prevent navigation to any other screen until the wizard is completed or explicitly skipped.
3. THE Setup_Wizard SHALL require the user to provide a Collection_Name of 1 to 50 alphanumeric characters (including hyphens and underscores).
4. THE Setup_Wizard SHALL require the user to provide apiKey, projectId, and appId as mandatory Firestore_Config fields.
5. WHEN the user submits valid Firestore_Config and Collection_Name, THE Setup_Wizard SHALL store the configuration in localStorage and dismiss the dialog.
6. WHEN the user chooses to skip the Setup_Wizard, THE App SHALL proceed to normal operation with sync disabled and store a flag indicating the wizard was skipped.
7. IF the user submits invalid or incomplete Firestore_Config, THEN THE Setup_Wizard SHALL display a descriptive validation error and remain open.

### Requirement 2: Firestore Configuration Storage

**User Story:** As a club administrator, I want my Firestore settings persisted locally, so that the app can reconnect to the same Firestore project across sessions without re-entering credentials.

#### Acceptance Criteria

1. THE App SHALL store Firestore_Config and Collection_Name in localStorage using the key prefix `tyf_firestore_`.
2. THE App SHALL store each Firestore_Config field individually (tyf_firestore_apiKey, tyf_firestore_projectId, tyf_firestore_appId, tyf_firestore_authDomain, tyf_firestore_storageBucket, tyf_firestore_messagingSenderId).
3. THE App SHALL store the Collection_Name under the key `tyf_firestore_collection`.
4. WHEN Firestore_Config is updated, THE App SHALL reinitialize the Sync_Engine with the new configuration without requiring an app restart.

### Requirement 3: Settings Page Integration

**User Story:** As a club administrator, I want to view and edit Firestore configuration from the Settings page, so that I can update credentials or change the collection name after initial setup.

#### Acceptance Criteria

1. THE Settings_Page SHALL display a "Cloud Sync" section containing input fields for Collection_Name and all Firestore_Config fields.
2. THE Settings_Page SHALL pre-populate the Cloud Sync fields with the currently stored Firestore_Config and Collection_Name values.
3. WHEN the user saves updated Firestore_Config from the Settings_Page, THE App SHALL validate the fields using the same rules as the Setup_Wizard.
4. WHEN valid Firestore_Config is saved from the Settings_Page, THE App SHALL update localStorage and reinitialize the Sync_Engine.
5. THE Settings_Page SHALL display a sync status indicator showing whether the Sync_Engine is connected, disconnected, or disabled.
6. THE Settings_Page SHALL provide a toggle to enable or disable cloud sync without deleting the stored Firestore_Config.

### Requirement 4: Sync Engine — Local-to-Remote Synchronization

**User Story:** As a club administrator, I want local data changes to sync to Firestore automatically, so that other devices see up-to-date information.

#### Acceptance Criteria

1. WHEN a record is created, updated, or deleted in the Local_Store, THE Sync_Engine SHALL write the corresponding change to Firestore within the configured Collection_Name.
2. THE Sync_Engine SHALL use the IndexedDB record `id` field as the Firestore document ID to ensure consistent identity across devices.
3. THE Sync_Engine SHALL sync all six object stores: members, contributions, payments, expenses, guest_sessions, and monthly_fee_records.
4. WHILE the device is offline, THE Sync_Engine SHALL queue pending changes locally and flush the queue when connectivity resumes.
5. IF a Firestore write fails due to a network error, THEN THE Sync_Engine SHALL retain the change in the queue and retry with exponential backoff (initial delay 1 second, maximum delay 60 seconds).
6. THE Sync_Engine SHALL attach a `_lastModified` timestamp (ISO 8601 UTC) to every document written to Firestore.

### Requirement 5: Sync Engine — Remote-to-Local Synchronization

**User Story:** As a club administrator using multiple devices, I want changes made on other devices to appear on my device in real-time, so that all devices stay consistent.

#### Acceptance Criteria

1. WHILE the Sync_Engine is connected to Firestore, THE Sync_Engine SHALL listen for real-time document changes across all six synced collections.
2. WHEN a remote document change is received, THE Sync_Engine SHALL apply the change to the Local_Store if the remote `_lastModified` timestamp is newer than the local record's timestamp.
3. WHEN a remote document deletion is received, THE Sync_Engine SHALL delete the corresponding record from the Local_Store.
4. IF a conflict occurs where both local and remote records were modified since last sync, THEN THE Sync_Engine SHALL resolve the conflict using a last-writer-wins strategy based on `_lastModified`.
5. WHEN remote changes are applied to the Local_Store, THE Sync_Engine SHALL trigger a UI refresh of the currently active screen.

### Requirement 6: Offline-First Operation

**User Story:** As a club administrator, I want the app to work fully offline even when Firestore sync is configured, so that connectivity issues do not prevent normal usage.

#### Acceptance Criteria

1. THE App SHALL use the Local_Store as the primary data source for all read operations regardless of sync status.
2. WHILE the device is offline, THE App SHALL operate with full functionality using only the Local_Store.
3. WHEN connectivity is restored after an offline period, THE Sync_Engine SHALL automatically synchronize all queued local changes to Firestore.
4. THE Sync_Engine SHALL NOT block or delay any local IndexedDB operations while waiting for Firestore responses.

### Requirement 7: Multi-Device Data Isolation

**User Story:** As a club administrator, I want to use a unique collection name per club, so that multiple clubs sharing the same Firebase project do not see each other's data.

#### Acceptance Criteria

1. THE Sync_Engine SHALL prefix all Firestore collection paths with the configured Collection_Name (e.g., `{Collection_Name}/members`, `{Collection_Name}/payments`).
2. THE Sync_Engine SHALL only read and write documents within the configured Collection_Name scope.
3. WHEN Collection_Name is changed in settings, THE Sync_Engine SHALL detach listeners from the previous collection and attach to the new collection.
4. WHEN Collection_Name is changed, THE App SHALL prompt the user to confirm, warning that local data will not be automatically migrated to the new collection.

### Requirement 8: Firebase SDK Loading

**User Story:** As a developer, I want the Firebase SDK loaded dynamically only when sync is enabled, so that the app bundle size is not impacted when sync is unused.

#### Acceptance Criteria

1. THE App SHALL NOT include the Firebase SDK in the initial page load.
2. WHEN sync is enabled and Firestore_Config is present, THE App SHALL dynamically import the Firebase SDK modules (firebase-app, firebase-firestore) from a CDN.
3. IF the Firebase SDK fails to load (network error or CDN unavailability), THEN THE App SHALL display a non-blocking notification and continue operating with sync disabled.
4. WHEN the Firebase SDK is loaded successfully, THE Sync_Engine SHALL initialize a Firestore instance using the stored Firestore_Config.
