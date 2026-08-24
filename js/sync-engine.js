const SyncEngine = (function () {
  'use strict';

  const SYNCED_STORES = ['members', 'contributions', 'payments', 'expenses', 'guest_sessions', 'monthly_fee_records'];
  const QUEUE_KEY = 'tyf_sync_queue';
  const DEVICE_ID_KEY = 'tyf_device_id';
  const RETRY_INITIAL_MS = 1000;
  const RETRY_MAX_MS = 60000;

  let firebaseApp = null;
  let firestoreDb = null;
  let listeners = [];
  let status = 'disabled';
  let retryTimer = null;
  let flushInProgress = false;
  let pullPaused = true; // pause pull until first flush completes

  var STORE_METHOD_MAP = {
    members: { getAll: 'getAllMembers', update: 'updateMember', delete: 'deleteMember' },
    contributions: { getAll: 'getAllContributions', update: 'updateContribution', delete: 'deleteContribution' },
    payments: { getAll: 'getAllPayments', update: 'updatePayment', delete: 'deletePayment' },
    expenses: { getAll: 'getAllExpenses', update: 'updateExpense', delete: 'deleteExpense' },
    guest_sessions: { getAll: 'getAllGuestSessions', update: 'updateGuestSession', delete: 'deleteGuestSession' },
    monthly_fee_records: { getAll: 'getAllMonthlyFeeRecords', update: 'updateMonthlyFeeRecord', delete: 'deleteMonthlyFeeRecord' }
  };

  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function getDeviceId() {
    var id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = generateUUID();
      try { localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) {}
    }
    return id;
  }

  // --- Firebase SDK Dynamic Loading ---

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Failed to load: ' + src)); };
      document.head.appendChild(script);
    });
  }

  async function loadFirebaseSDK() {
    if (window.firebase) return;
    try {
      await loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js');
    } catch (e) {
      console.error('SyncEngine: Firebase SDK load failed.', e);
      status = 'disabled';
      throw e;
    }
  }

  // --- Sync Queue Management ---

  function getQueue() {
    try {
      var raw = localStorage.getItem(QUEUE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function saveQueue(queue) {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014) {
        console.warn('SyncEngine: localStorage quota exceeded. Dropping oldest.');
        var reduced = queue.slice(Math.floor(queue.length / 2));
        try { localStorage.setItem(QUEUE_KEY, JSON.stringify(reduced)); } catch (e2) {}
      }
    }
  }

  function getQueueSize() { return getQueue().length; }

  function notifyChange(storeName, record, opType) {
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

    queue = queue.filter(function (entry) {
      return !(entry.storeName === storeName && entry.docId === docId);
    });

    queue.push({
      id: generateUUID(),
      storeName: storeName,
      docId: docId,
      operation: opType === 'delete' ? 'delete' : 'put',
      data: data,
      timestamp: now,
      retryCount: 0
    });

    saveQueue(queue);

    // If connected and pull is not paused, attempt immediate flush
    if (status === 'connected' && !flushInProgress && !pullPaused) {
      flushQueue();
    }
  }

  // --- Local-to-Remote Sync (Push) ---

  function getCollectionRef(storeName) {
    if (!firestoreDb) return null;
    var collectionName = FirestoreConfig.getCollectionName();
    if (!collectionName) return null;
    return firestoreDb.collection(collectionName + '_' + storeName);
  }

  /**
   * Push all queued local changes to Firestore.
   * Returns true if queue is fully flushed, false if items remain.
   */
  async function flushQueue() {
    if (flushInProgress) return false;
    if (status !== 'connected' || !firestoreDb) return false;
    flushInProgress = true;

    try {
      var queue = getQueue();
      if (queue.length === 0) { flushInProgress = false; return true; }

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
          if (err.code === 'permission-denied') {
            console.error('SyncEngine: Permission denied for', entry.storeName, entry.docId);
            continue;
          }
          entry.retryCount = (entry.retryCount || 0) + 1;
          remaining.push(entry);
        }
      }
      saveQueue(remaining);
      if (remaining.length > 0) { scheduleRetry(remaining[0].retryCount || 1); }
      flushInProgress = false;
      return remaining.length === 0;
    } catch (e) {
      console.error('SyncEngine: flushQueue error.', e);
      flushInProgress = false;
      return false;
    }
  }

  function scheduleRetry(retryCount) {
    if (retryTimer) clearTimeout(retryTimer);
    var delay = Math.min(RETRY_INITIAL_MS * Math.pow(2, retryCount - 1), RETRY_MAX_MS);
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (status === 'connected') { flushQueue(); }
    }, delay);
  }

  function onOnline() {
    if (status === 'disconnected' && FirestoreConfig.isSyncEnabled() && FirestoreConfig.hasConfig()) {
      init();
    } else if (status === 'connected') {
      // Push first, then pull will happen via listener
      flushQueue();
    }
  }

  // --- Remote-to-Local Sync (Pull) ---
  // Strategy: Firestore = source of truth.
  // On snapshot, replace local store entirely with Firestore data.
  // BUT only after initial flush is done (so offline edits reach Firestore first).

  function attachListeners() {
    if (!firestoreDb) return;
    var collectionName = FirestoreConfig.getCollectionName();
    if (!collectionName) return;

    for (var i = 0; i < SYNCED_STORES.length; i++) {
      (function (storeName) {
        var colRef = firestoreDb.collection(collectionName + '_' + storeName);
        var unsubscribe = colRef.onSnapshot(function (snapshot) {
          // Only process pull if not paused (i.e., initial flush is done)
          if (!pullPaused) {
            replaceLocalStore(storeName, snapshot);
          }
        }, function (error) {
          console.error('SyncEngine: Listener error for ' + storeName, error);
          status = 'disconnected';
        });
        listeners.push(unsubscribe);
      })(SYNCED_STORES[i]);
    }
  }

  /**
   * Replace entire local IndexedDB store with Firestore snapshot.
   * Firestore = single source of truth.
   */
  async function replaceLocalStore(storeName, snapshot) {
    if (!snapshot) return;
    var methods = STORE_METHOD_MAP[storeName];
    if (!methods) return;

    try {
      // Build map of all remote docs
      var remoteDocs = {};
      snapshot.forEach(function (doc) {
        remoteDocs[doc.id] = doc.data();
      });

      // Get all local records
      var localRecords = await DB[methods.getAll]();
      var localMap = {};
      localRecords.forEach(function (r) { if (r.id) localMap[r.id] = r; });

      // Delete local records not in Firestore
      for (var localId in localMap) {
        if (!remoteDocs[localId]) {
          try { await DB[methods.delete](localId); } catch (e) {}
        }
      }

      // Add/overwrite all remote records locally
      for (var remoteId in remoteDocs) {
        try {
          await DB[methods.update](remoteDocs[remoteId]);
        } catch (e) {
          console.error('SyncEngine: Error writing remote record', storeName, remoteId, e);
        }
      }

      // Notify UI to refresh
      document.dispatchEvent(new CustomEvent('tyf-sync-update', { detail: { store: storeName } }));
    } catch (e) {
      console.error('SyncEngine: replaceLocalStore error for ' + storeName, e);
    }
  }

  /**
   * Perform a one-time full pull for all stores.
   * Called after initial flush completes to get the full Firestore state.
   */
  async function fullPull() {
    if (!firestoreDb) return;
    var collectionName = FirestoreConfig.getCollectionName();
    if (!collectionName) return;

    for (var i = 0; i < SYNCED_STORES.length; i++) {
      var storeName = SYNCED_STORES[i];
      try {
        var colRef = firestoreDb.collection(collectionName + '_' + storeName);
        var snapshot = await colRef.get();
        await replaceLocalStore(storeName, snapshot);
      } catch (e) {
        console.error('SyncEngine: fullPull error for ' + storeName, e);
      }
    }
  }

  // --- Lifecycle Methods ---

  async function init() {
    if (typeof FirestoreConfig === 'undefined') { status = 'disabled'; return; }
    if (!FirestoreConfig.isSyncEnabled() || !FirestoreConfig.hasConfig()) { status = 'disabled'; return; }

    try {
      getDeviceId();
      await loadFirebaseSDK();
      if (!window.firebase) { status = 'disabled'; return; }

      var config = FirestoreConfig.getConfig();
      if (!config) { status = 'disabled'; return; }

      var firebaseConfig = {};
      if (config.apiKey) firebaseConfig.apiKey = config.apiKey;
      if (config.authDomain) firebaseConfig.authDomain = config.authDomain;
      if (config.projectId) firebaseConfig.projectId = config.projectId;
      if (config.storageBucket) firebaseConfig.storageBucket = config.storageBucket;
      if (config.messagingSenderId) firebaseConfig.messagingSenderId = config.messagingSenderId;
      if (config.appId) firebaseConfig.appId = config.appId;

      if (!firebaseApp) {
        if (firebase.apps && firebase.apps.length > 0) {
          firebaseApp = firebase.apps[0];
        } else {
          firebaseApp = firebase.initializeApp(firebaseConfig);
        }
      }

      firestoreDb = firebase.firestore();
      status = 'connected';

      // Step 1: Push all offline/queued changes to Firestore FIRST
      pullPaused = true;
      await flushQueue();

      // Step 2: Full pull — replace local DB with Firestore (now includes our offline edits)
      await fullPull();

      // Step 3: Unpause and attach real-time listeners for ongoing changes
      pullPaused = false;
      attachListeners();

      window.addEventListener('online', onOnline);
    } catch (e) {
      console.error('SyncEngine: init failed.', e);
      status = 'disabled';
    }
  }

  async function reinitialize() { disconnect(); await init(); }

  function disconnect() {
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) {} }
    listeners = [];
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    firebaseApp = null;
    firestoreDb = null;
    flushInProgress = false;
    pullPaused = true;
    status = 'disconnected';
    window.removeEventListener('online', onOnline);
  }

  function getStatus() { return status; }

  return {
    init: init,
    reinitialize: reinitialize,
    disconnect: disconnect,
    notifyChange: notifyChange,
    getStatus: getStatus,
    flushQueue: flushQueue,
    getQueueSize: getQueueSize
  };
})();