/**
 * License Registry Module
 * 
 * Reports license usage to the app owner's Firebase project.
 * 
 * Behavior:
 * - Every app open: writes heartbeat to _license_registry/{docId}
 * - Checks _license_registry/_meta doc for the current tracking month
 * - If the month has changed (new month started), the FIRST device to detect it:
 *   1. Copies ALL docs from _license_registry to _license_history/{YYYY-MM}/{docId}
 *   2. Deletes all docs from _license_registry (clean slate for new month)
 *   3. Updates _meta.month to the current month
 *   4. Writes its own heartbeat as the first entry of the new month
 */
const LicenseRegistry = (function () {
  'use strict';

  var registryDb = null;
  var registryApp = null;

  function getMonthKey() {
    var now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  }

  async function report() {
    try {
      if (!window._isLicensed) return;
      if (typeof FirestoreConfig === 'undefined' || !FirestoreConfig.hasConfig()) return;
      if (typeof LICENSE_REGISTRY_CONFIG === 'undefined') return;

      var regConfig = LICENSE_REGISTRY_CONFIG;
      if (!regConfig.apiKey || regConfig.apiKey === 'YOUR_API_KEY_HERE') return;
      if (!regConfig.projectId || regConfig.projectId === 'YOUR_PROJECT_ID_HERE') return;

      // Ensure Firebase SDK is loaded
      if (!window.firebase) {
        await new Promise(function (r) { setTimeout(r, 3000); });
        if (!window.firebase) return;
      }

      // Initialize a separate Firebase app for the registry
      var appName = '__license_registry__';
      var existingApp = null;
      try { existingApp = firebase.app(appName); } catch (e) {}

      if (!existingApp) {
        registryApp = firebase.initializeApp({
          apiKey: regConfig.apiKey,
          authDomain: regConfig.authDomain || '',
          projectId: regConfig.projectId,
          storageBucket: regConfig.storageBucket || '',
          messagingSenderId: regConfig.messagingSenderId || '',
          appId: regConfig.appId || ''
        }, appName);
      } else {
        registryApp = existingApp;
      }

      registryDb = firebase.firestore(registryApp);

      var registryCol = regConfig.registryCollection || '_license_registry';
      var currentMonth = getMonthKey();

      // --- Check if month has rolled over ---
      var metaRef = registryDb.collection(registryCol).doc('_meta');
      var metaSnap = await metaRef.get();
      var storedMonth = metaSnap.exists ? (metaSnap.data().month || '') : '';

      if (storedMonth && storedMonth !== currentMonth) {
        // Month changed! Move all registry docs to history, then clear registry.
        await archiveAndReset(registryCol, storedMonth, currentMonth, metaRef);
      } else if (!storedMonth) {
        // First time ever — just set the meta month
        await metaRef.set({ month: currentMonth });
      }

      // --- Write heartbeat ---
      var licenseKey = '';
      try { licenseKey = (localStorage.getItem('tyf_license_key') || '').replace(/[\s\r\n]+/g, ''); } catch (e) {}

      var licenseData = {};
      try { licenseData = JSON.parse(atob(licenseKey)); } catch (e) {}

      var collectionName = FirestoreConfig.getCollectionName() || 'unknown';
      var customerProjectId = '';
      var config = FirestoreConfig.getConfig();
      if (config && config.projectId) customerProjectId = config.projectId;

      var deviceId = localStorage.getItem('tyf_device_id') || 'unknown';
      var licenseName = licenseData.n || 'unknown';
      var licenseHash = licenseData.h || 'unknown';
      var now = new Date().toISOString();

      var docId = licenseHash.substring(0, 16) + '_' + collectionName + '_' + deviceId.substring(0, 8);

      await registryDb.collection(registryCol).doc(docId).set({
        licenseName: licenseName,
        licenseHash: licenseHash,
        collectionName: collectionName,
        customerProjectId: customerProjectId,
        deviceId: deviceId,
        lastSeen: now,
        appVersion: window._APP_VERSION || 'unknown'
      }, { merge: true });

    } catch (e) {
      console.debug('LicenseRegistry: report failed (non-critical)', e);
    }
  }

  /**
   * Archive all current registry docs to _license_history/{month}/
   * then delete them from _license_registry, and update _meta.month.
   */
  async function archiveAndReset(registryCol, oldMonth, newMonth, metaRef) {
    try {
      var historyCol = '_license_history';

      // Read all docs from registry (except _meta)
      var snapshot = await registryDb.collection(registryCol).get();
      var batch = registryDb.batch();
      var docCount = 0;

      snapshot.forEach(function (doc) {
        if (doc.id === '_meta') return; // skip meta doc

        // Copy to history: _license_history/{oldMonth}_{docId}
        var historyDocId = oldMonth + '_' + doc.id;
        var historyRef = registryDb.collection(historyCol).doc(historyDocId);
        var data = doc.data();
        data.month = oldMonth;
        batch.set(historyRef, data);

        // Delete from registry
        batch.delete(doc.ref);
        docCount++;
      });

      if (docCount > 0) {
        // Firestore batch limit is 500 — should be fine for license tracking
        await batch.commit();
      }

      // Update meta to current month
      await metaRef.set({ month: newMonth });

    } catch (e) {
      console.debug('LicenseRegistry: archiveAndReset failed (non-critical)', e);
      // Still update meta so we don't retry the archive endlessly
      try { await metaRef.set({ month: newMonth }); } catch (e2) {}
    }
  }

  return { report: report };
})();