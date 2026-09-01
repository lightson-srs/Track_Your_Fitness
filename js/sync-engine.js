const SyncEngine = (function () {
  'use strict';

  const SYNCED_STORES = ['members', 'contributions', 'payments', 'expenses', 'guest_sessions', 'monthly_fee_records', 'attendance'];
  const QUEUE_KEY = 'tyf_sync_queue';
  const DEVICE_ID_KEY = 'tyf_device_id';

  let firebaseApp = null;
  let firestoreDb = null;
  let status = 'disabled';

  var STORE_METHOD_MAP = {
    members: { getAll: 'getAllMembers', update: 'updateMember', delete: 'deleteMember' },
    contributions: { getAll: 'getAllContributions', update: 'updateContribution', delete: 'deleteContribution' },
    payments: { getAll: 'getAllPayments', update: 'updatePayment', delete: 'deletePayment' },
    expenses: { getAll: 'getAllExpenses', update: 'updateExpense', delete: 'deleteExpense' },
    guest_sessions: { getAll: 'getAllGuestSessions', update: 'updateGuestSession', delete: 'deleteGuestSession' },
    monthly_fee_records: { getAll: 'getAllMonthlyFeeRecords', update: 'updateMonthlyFeeRecord', delete: 'deleteMonthlyFeeRecord' },
    attendance: { getAll: 'getAllAttendance', update: 'updateAttendance', delete: 'deleteAttendance' }
  };

  var _suppressNotify = false;

  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function getDeviceId() {
    var id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) { id = generateUUID(); try { localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) {} }
    return id;
  }

  // --- Firebase SDK Loading ---

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
      var script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Failed to load: ' + src)); };
      document.head.appendChild(script);
    });
  }

  async function loadFirebaseSDK() {
    if (window.firebase) return;
    await loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
    await loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js');
  }

  // --- Sync Queue ---

  function getQueue() {
    try { var raw = localStorage.getItem(QUEUE_KEY); return raw ? JSON.parse(raw) : []; }
    catch (e) { return []; }
  }

  function saveQueue(queue) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); }
    catch (e) { /* quota exceeded - trim */ try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-50))); } catch(e2){} }
  }

  function getQueueSize() { return getQueue().length; }

  function notifyChange(storeName, record, opType) {
    if (_suppressNotify) return;
    if (SYNCED_STORES.indexOf(storeName) === -1) return;
    if (!record || !record.id) return;

    var queue = getQueue();
    var docId = String(record.id);
    var now = new Date().toISOString();

    var data = null;
    if (opType !== 'delete') {
      data = Object.assign({}, record);
      data._lastModified = now;
      data._deviceId = getDeviceId();
    }

    // Dedup: remove older entry for same store+doc
    queue = queue.filter(function (e) { return !(e.storeName === storeName && e.docId === docId); });
    queue.push({ storeName: storeName, docId: docId, operation: opType === 'delete' ? 'delete' : 'put', data: data });
    saveQueue(queue);
  }

  // --- Push: send queued changes to Firestore ---

  function getCollectionRef(storeName) {
    if (!firestoreDb) return null;
    var collectionName = FirestoreConfig.getCollectionName();
    if (!collectionName) return null;
    return firestoreDb.collection(collectionName + '_' + storeName);
  }

  async function push() {
    if (!firestoreDb) return;
    var queue = getQueue();
    if (queue.length === 0) return;
    console.log('[SYNC] Pushing', queue.length, 'queued changes');

    var remaining = [];
    for (var i = 0; i < queue.length; i++) {
      var entry = queue[i];
      try {
        var colRef = getCollectionRef(entry.storeName);
        if (!colRef) { remaining.push(entry); continue; }
        var docRef = colRef.doc(entry.docId);
        if (entry.operation === 'delete') { await docRef.delete(); }
        else { await docRef.set(entry.data); }
      } catch (err) {
        if (err.code !== 'permission-denied') { remaining.push(entry); }
      }
    }
    saveQueue(remaining);
    if (remaining.length > 0) console.log('[SYNC] Push incomplete,', remaining.length, 'items remaining');
  }

  // --- Pull: replace local DB with Firestore data (one-time, no listener) ---

  async function pull() {
    if (!firestoreDb) return;
    var collectionName = FirestoreConfig.getCollectionName();
    if (!collectionName) return;

    console.log('[SYNC] Pulling full data from Firestore');
    _suppressNotify = true;

    try {
      for (var i = 0; i < SYNCED_STORES.length; i++) {
        var storeName = SYNCED_STORES[i];
        var methods = STORE_METHOD_MAP[storeName];
        if (!methods) continue;

        var colRef = firestoreDb.collection(collectionName + '_' + storeName);
        var snapshot = await colRef.get();

        // Build remote data map
        var remoteDocs = {};
        snapshot.forEach(function (doc) { remoteDocs[doc.id] = doc.data(); });

        // Get local records
        var localRecords = await DB[methods.getAll]();
        var localMap = {};
        localRecords.forEach(function (r) { if (r.id) localMap[r.id] = r; });

        // Delete local records not in Firestore
        for (var localId in localMap) {
          if (!remoteDocs[localId]) {
            try { await DB[methods.delete](localId); } catch (e) {}
          }
        }

        // Overwrite local with remote
        for (var remoteId in remoteDocs) {
          try { await DB[methods.update](remoteDocs[remoteId]); } catch (e) {}
        }
      }
    } catch (e) {
      console.error('[SYNC] Pull failed:', e);
    }

    _suppressNotify = false;
    console.log('[SYNC] Pull complete');
  }

  // --- Sync: push then pull (the only entry point) ---

  async function sync() {
    if (status !== 'connected') {
      var connected = await connect();
      if (!connected) return;
    }
    await push();
    await pull();
    // Refresh UI once after sync
    document.dispatchEvent(new CustomEvent('tyf-sync-update'));
  }

  // --- Connect to Firestore (no listeners) ---

  async function connect() {
    if (typeof FirestoreConfig === 'undefined') { status = 'disabled'; return false; }
    if (!FirestoreConfig.isSyncEnabled() || !FirestoreConfig.hasConfig()) { status = 'disabled'; return false; }

    try {
      getDeviceId();
      await loadFirebaseSDK();
      if (!window.firebase) { status = 'disabled'; return false; }

      var config = FirestoreConfig.getConfig();
      if (!config) { status = 'disabled'; return false; }

      var firebaseConfig = {};
      if (config.apiKey) firebaseConfig.apiKey = config.apiKey;
      if (config.authDomain) firebaseConfig.authDomain = config.authDomain;
      if (config.projectId) firebaseConfig.projectId = config.projectId;
      if (config.storageBucket) firebaseConfig.storageBucket = config.storageBucket;
      if (config.messagingSenderId) firebaseConfig.messagingSenderId = config.messagingSenderId;
      if (config.appId) firebaseConfig.appId = config.appId;

      if (!firebaseApp) {
        if (firebase.apps && firebase.apps.length > 0) { firebaseApp = firebase.apps[0]; }
        else { firebaseApp = firebase.initializeApp(firebaseConfig); }
      }

      firestoreDb = firebase.firestore();
      status = 'connected';
      return true;
    } catch (e) {
      console.error('[SYNC] Connect failed:', e);
      status = 'disabled';
      return false;
    }
  }

  // --- Test connection (does NOT touch the live sync app/connection) ---
  // Initializes a throwaway secondary Firebase app with the supplied config,
  // performs a lightweight read against the configured collection, then tears
  // the app down. Returns { ok: boolean, message: string }.
  async function testConnection(configObj, collectionName) {
    if (!configObj) return { ok: false, message: 'No configuration provided.' };

    // Reuse the shared validation for mandatory fields + collection name.
    if (typeof FirestoreConfig !== 'undefined' && FirestoreConfig.validate) {
      var v = FirestoreConfig.validate(configObj, collectionName);
      if (!v.valid) return { ok: false, message: v.errors.join(' ') };
    }

    var testApp = null;
    try {
      await loadFirebaseSDK();
      if (!window.firebase) {
        return { ok: false, message: 'Firebase SDK could not be loaded. Check your internet connection.' };
      }

      var firebaseConfig = {};
      if (configObj.apiKey) firebaseConfig.apiKey = configObj.apiKey;
      if (configObj.authDomain) firebaseConfig.authDomain = configObj.authDomain;
      if (configObj.projectId) firebaseConfig.projectId = configObj.projectId;
      if (configObj.storageBucket) firebaseConfig.storageBucket = configObj.storageBucket;
      if (configObj.messagingSenderId) firebaseConfig.messagingSenderId = configObj.messagingSenderId;
      if (configObj.appId) firebaseConfig.appId = configObj.appId;

      // Use a uniquely-named secondary app so we never collide with the live one.
      var testAppName = '_tyf_test_' + Date.now();
      testApp = firebase.initializeApp(firebaseConfig, testAppName);

      var testDb = firebase.firestore(testApp);
      // Lightweight read: limit(1) on the members collection under this prefix.
      var colName = (collectionName || FirestoreConfig.getCollectionName() || 'test');
      await testDb.collection(colName + '_members').limit(1).get();

      return { ok: true, message: 'Connected successfully to project "' + (configObj.projectId || '') + '".' };
    } catch (e) {
      var msg = (e && e.message) ? e.message : 'Unknown error';
      var code = e && e.code ? e.code : '';
      if (code === 'permission-denied' || /permission/i.test(msg)) {
        // Reached Firestore but rules blocked the read — credentials are valid.
        return { ok: true, message: 'Connected, but Firestore rules denied the test read. Credentials are valid; check your security rules for access.' };
      }
      if (code === 'unavailable' || /network|offline|failed to get/i.test(msg)) {
        return { ok: false, message: 'Could not reach Firestore. Check your network and project settings.' };
      }
      if (/invalid|api-key|api key|not-found|project/i.test(msg + ' ' + code)) {
        return { ok: false, message: 'Connection failed — check API key / project ID / app ID. (' + msg + ')' };
      }
      return { ok: false, message: 'Connection failed: ' + msg };
    } finally {
      if (testApp) { try { await testApp.delete(); } catch (e) {} }
    }
  }

  // --- Lifecycle ---

  async function init() {
    if (typeof FirestoreConfig === 'undefined') { status = 'disabled'; return; }
    if (!FirestoreConfig.isSyncEnabled() || !FirestoreConfig.hasConfig()) { status = 'disabled'; return; }
    // Connect and do one sync on startup
    await sync();
  }

  async function reinitialize() { disconnect(); await init(); }

  function disconnect() {
    firebaseApp = null;
    firestoreDb = null;
    status = 'disconnected';
  }

  function getStatus() { return status; }

  // flushQueue is now just push (for backward compat with sync button)
  async function flushQueue() { await sync(); }

  return {
    init: init,
    reinitialize: reinitialize,
    disconnect: disconnect,
    notifyChange: notifyChange,
    getStatus: getStatus,
    flushQueue: flushQueue,
    getQueueSize: getQueueSize,
    testConnection: testConnection
  };
})();