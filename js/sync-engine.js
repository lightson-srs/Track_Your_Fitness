const SyncEngine = (function () {
  'use strict';

  const SYNCED_STORES = ['members', 'contributions', 'payments', 'expenses', 'guest_sessions', 'monthly_fee_records', 'attendance', 'audit'];
  const QUEUE_KEY = 'tyf_sync_queue';
  const DEVICE_ID_KEY = 'tyf_device_id';

  // ─── Sync V2 cursor (version history) ───
  // The PWA persists where it is in the remote version history. `generation`
  // scopes the revision space; if the server generation changes, the local
  // revision is meaningless and we must do a full reconciliation.
  const CURSOR_GEN_KEY = 'tyf_sync_generation';
  const CURSOR_REV_KEY = 'tyf_sync_revision';

  // How many change envelopes we retain on the server. If the PWA's local
  // revision is older than (remoteRevision - WINDOW) it is no longer in the
  // DB's version list, so we fall back to a full merge.
  const CHANGE_WINDOW = 500;

  let firebaseApp = null;
  let firestoreDb = null;
  let status = 'disabled';

  var STORE_METHOD_MAP = {
    members: { getAll: 'getAllMembers', update: 'updateMember', delete: 'deleteMember', get: 'getMember' },
    contributions: { getAll: 'getAllContributions', update: 'updateContribution', delete: 'deleteContribution', get: 'getContribution' },
    payments: { getAll: 'getAllPayments', update: 'updatePayment', delete: 'deletePayment', get: 'getPayment' },
    expenses: { getAll: 'getAllExpenses', update: 'updateExpense', delete: 'deleteExpense', get: 'getExpense' },
    guest_sessions: { getAll: 'getAllGuestSessions', update: 'updateGuestSession', delete: 'deleteGuestSession', get: 'getGuestSession' },
    monthly_fee_records: { getAll: 'getAllMonthlyFeeRecords', update: 'updateMonthlyFeeRecord', delete: 'deleteMonthlyFeeRecord', get: 'getMonthlyFeeRecord' },
    attendance: { getAll: 'getAllAttendance', update: 'updateAttendance', delete: 'deleteAttendance', get: 'getAttendance' },
    audit: { getAll: 'getAllAuditRecords', update: 'updateAuditRecord', delete: 'deleteAuditRecord', get: 'getAudit' }
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

  // ─── Local cursor helpers ───

  function getLocalCursor() {
    var gen = parseInt(localStorage.getItem(CURSOR_GEN_KEY), 10);
    var rev = parseInt(localStorage.getItem(CURSOR_REV_KEY), 10);
    return {
      generation: isNaN(gen) ? null : gen,
      revision: isNaN(rev) ? null : rev
    };
  }

  function setLocalCursor(generation, revision) {
    try {
      localStorage.setItem(CURSOR_GEN_KEY, String(generation));
      localStorage.setItem(CURSOR_REV_KEY, String(revision));
    } catch (e) {}
  }

  function clearLocalCursor() {
    try {
      localStorage.removeItem(CURSOR_GEN_KEY);
      localStorage.removeItem(CURSOR_REV_KEY);
    } catch (e) {}
  }

  // Safe bridge to the Settings activity log (no-op if Settings isn't loaded).
  function slog(status, msg) {
    try { if (typeof Settings !== 'undefined' && Settings.logActivity) Settings.logActivity(status, msg); }
    catch (e) {}
  }

  // --- Firebase SDK Loading ---

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
      var settled = false;
      var script = document.createElement('script');
      script.src = src;
      // Guard: never leave the promise pending if the network stalls.
      var to = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('Timed out loading: ' + src));
      }, 15000);
      script.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        resolve();
      };
      script.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        reject(new Error('Failed to load: ' + src));
      };
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

  // ─── Conflicts registry (optimistic concurrency: reject-and-flag) ───
  // When a record was changed on another device since our local edit's base,
  // we reject only that record and record it here (never block the batch).
  var CONFLICTS_KEY = 'tyf_sync_conflicts';

  function getConflicts() {
    try { var raw = localStorage.getItem(CONFLICTS_KEY); return raw ? JSON.parse(raw) : []; }
    catch (e) { return []; }
  }
  function _saveConflicts(arr) {
    try { localStorage.setItem(CONFLICTS_KEY, JSON.stringify(arr.slice(0, 100))); } catch (e) {}
  }
  function flagConflict(storeName, docId, reason) {
    var arr = getConflicts();
    // One entry per store+doc (latest wins).
    arr = arr.filter(function (c) { return !(c.store === storeName && c.docId === String(docId)); });
    arr.unshift({ store: storeName, docId: String(docId), reason: reason || 'changed on another device', at: Date.now() });
    _saveConflicts(arr);
    slog('err', 'Conflict: ' + storeName + ' ' + docId + ' — ' + (reason || 'changed on another device') + ' (not synced)');
    document.dispatchEvent(new CustomEvent('tyf-sync-conflict'));
  }
  function clearConflicts() { _saveConflicts([]); document.dispatchEvent(new CustomEvent('tyf-sync-conflict')); }
  function getConflictCount() { return getConflicts().length; }

  // Changes are always identified by their stable record `id` (docId), never by
  // array position. Dedup keeps a single pending op per store+doc.
  function notifyChange(storeName, record, opType) {
    if (_suppressNotify) return;
    if (SYNCED_STORES.indexOf(storeName) === -1) return;
    if (!record || !record.id) return;

    var queue = getQueue();
    var docId = String(record.id);
    var now = Date.now();

    var data = null;
    if (opType !== 'delete') {
      data = Object.assign({}, record);
      // Ensure a timestamp/version exist even for records written before the
      // DB-layer stamping existed, so conflict resolution always has a basis.
      if (typeof data.updatedAt !== 'number') data.updatedAt = now;
      if (typeof data.version !== 'number') data.version = 1;
      data._lastModified = new Date(now).toISOString();
      data._deviceId = getDeviceId();
    }

    // Dedup: remove older entry for same store+doc
    queue = queue.filter(function (e) { return !(e.storeName === storeName && e.docId === docId); });
    queue.push({ storeName: storeName, docId: docId, operation: opType === 'delete' ? 'delete' : 'put', data: data });
    saveQueue(queue);
  }

  // ─── Firestore references ───

  function getCollectionRef(storeName) {
    if (!firestoreDb) return null;
    var collectionName = FirestoreConfig.getCollectionName();
    if (!collectionName) return null;
    return firestoreDb.collection(collectionName + '_' + storeName);
  }

  // Sync V2 meta document: holds { generation, revision }.
  function getMetaDocRef() {
    if (!firestoreDb) return null;
    var collectionName = FirestoreConfig.getCollectionName();
    if (!collectionName) return null;
    return firestoreDb.collection(collectionName + '_sync').doc('meta');
  }

  // Sync V2 change stream: one doc per revision, id = zero-padded revision.
  function getChangesColRef() {
    if (!firestoreDb) return null;
    var collectionName = FirestoreConfig.getCollectionName();
    if (!collectionName) return null;
    return firestoreDb.collection(collectionName + '_sync').doc('meta').collection('changes');
  }

  function revisionDocId(rev) {
    // Zero-pad so lexical and numeric ordering agree (supports up to 1e12 revisions).
    var s = String(rev);
    while (s.length < 12) s = '0' + s;
    return 'rev_' + s;
  }

  // ─── Push: atomic, version-history-aware ───
  // Each queued change is committed in a Firestore transaction that:
  //   1. reads /sync/meta,
  //   2. allocates revision+1,
  //   3. writes the data doc (by id),
  //   4. writes the change envelope at the new revision,
  //   5. advances /sync/meta.revision.
  // The transaction retries automatically on contention, giving us an atomic
  // allocator (equivalent to the ETag/If-Match flow but using Firestore).

  async function push() {
    if (!firestoreDb) return;
    var queue = getQueue();
    if (queue.length === 0) return;
    console.log('[SYNC] Pushing', queue.length, 'queued changes');

    var collectionName = FirestoreConfig.getCollectionName();
    if (!collectionName) return;

    var metaRef = getMetaDocRef();
    var changesRef = getChangesColRef();
    if (!metaRef || !changesRef) return;

    var remaining = [];

    for (var i = 0; i < queue.length; i++) {
      var entry = queue[i];
      try {
        var dataColRef = getCollectionRef(entry.storeName);
        if (!dataColRef) { remaining.push(entry); continue; }
        var dataDocRef = dataColRef.doc(entry.docId);

        await firestoreDb.runTransaction(async function (tx) {
          // Read meta AND the current remote data doc for optimistic-concurrency.
          var metaSnap = await tx.get(metaRef);
          var remoteSnap = await tx.get(dataDocRef);

          // ─── Optimistic concurrency check (reject-and-flag) ───
          // Only meaningful for updates to an existing remote doc. A delete, or
          // a create (remote missing), cannot conflict here.
          if (entry.operation !== 'delete' && remoteSnap.exists) {
            var remoteData = remoteSnap.data() || {};
            var base = (entry.data && typeof entry.data._baseUpdatedAt === 'number')
              ? entry.data._baseUpdatedAt : undefined;
            var remoteTs = (typeof remoteData.updatedAt === 'number') ? remoteData.updatedAt : undefined;
            // If we have a base and the remote moved past it → someone else edited
            // this record while we were offline. Reject ONLY this record.
            if (base !== undefined && remoteTs !== undefined && remoteTs !== base) {
              var conflictErr = new Error('conflict');
              conflictErr._tyfConflict = true;
              throw conflictErr;
            }
          }

          var meta = metaSnap.exists ? (metaSnap.data() || {}) : {};
          var generation = (typeof meta.generation === 'number') ? meta.generation : 1;
          var revision = (typeof meta.revision === 'number') ? meta.revision : 0;
          var nextRev = revision + 1;

          // 1. Write/delete the data document (always keyed by stable id).
          if (entry.operation === 'delete') {
            tx.delete(dataDocRef);
          } else {
            // Accepted: this record is now in sync, so its base token equals its
            // own updatedAt. Persist that on the uploaded doc too.
            if (entry.data && typeof entry.data.updatedAt === 'number') {
              entry.data._baseUpdatedAt = entry.data.updatedAt;
            }
            tx.set(dataDocRef, entry.data);
          }

          // 2. Write the change envelope at the new revision.
          var changeDocRef = changesRef.doc(revisionDocId(nextRev));
          tx.set(changeDocRef, {
            rev: nextRev,
            generation: generation,
            store: entry.storeName,
            docId: entry.docId,
            op: entry.operation,
            ts: Date.now()
          });

          // 3. Advance meta.
          tx.set(metaRef, { generation: generation, revision: nextRev }, { merge: true });
        });

        // Accepted write — reflect the new base token in the local record so a
        // later edit measures against the value we just uploaded.
        if (entry.operation !== 'delete' && entry.data && entry.data.id) {
          try { await _writeBackLocalBase(entry.storeName, entry.data); } catch (e) {}
        }
      } catch (err) {
        if (err && err._tyfConflict) {
          // Reject ONLY this record: flag it, drop from the queue (do not retry
          // forever), and continue pushing the rest.
          flagConflict(entry.storeName, entry.docId, 'edited on another device since your change');
          // entry intentionally NOT added to `remaining`.
        } else if (err && err.code === 'permission-denied') {
          // Rules blocked write — drop silently so we don't loop forever.
        } else {
          remaining.push(entry);
        }
      }
    }

    saveQueue(remaining);
    if (remaining.length > 0) console.log('[SYNC] Push incomplete,', remaining.length, 'items remaining');
  }

  // After an accepted push, update the local record's _baseUpdatedAt so the next
  // local edit is measured against the value we just uploaded (not an older base).
  async function _writeBackLocalBase(storeName, data) {
    var methods = STORE_METHOD_MAP[storeName];
    if (!methods || !methods.get || !methods.update) return;
    var _prevSuppress = _suppressNotify;
    _suppressNotify = true;
    DB.setSuppressStamp(true);
    try {
      var local = await DB[methods.get](data.id);
      if (local && typeof data.updatedAt === 'number') {
        // Only write back if the local record hasn't been edited again since.
        if (local.updatedAt === data.updatedAt) {
          local._baseUpdatedAt = data.updatedAt;
          await DB[methods.update](local);
        }
      }
    } catch (e) {} finally {
      DB.setSuppressStamp(false);
      _suppressNotify = _prevSuppress;
    }
  }

  // ─── Read remote meta ───

  async function readRemoteMeta() {
    var metaRef = getMetaDocRef();
    if (!metaRef) return null;
    try {
      var snap = await metaRef.get();
      if (!snap.exists) return null;
      var m = snap.data() || {};
      if (typeof m.generation !== 'number' || typeof m.revision !== 'number') return null;
      return { generation: m.generation, revision: m.revision };
    } catch (e) {
      console.error('[SYNC] readRemoteMeta failed:', e);
      return null;
    }
  }

  // ─── Apply a single remote doc by id ───
  // DB stamping is suppressed so we don't bump the version of an authoritative
  // remote record. Records are located/written by id, never by index.

  async function applyRemoteDoc(storeName, docId, op) {
    var methods = STORE_METHOD_MAP[storeName];
    if (!methods) return;

    if (op === 'delete') {
      try { await DB[methods.delete](docId); } catch (e) {}
      return;
    }

    var dataColRef = getCollectionRef(storeName);
    if (!dataColRef) return;
    try {
      var snap = await dataColRef.doc(docId).get();
      if (!snap.exists) {
        // Envelope says put but doc is gone — treat as delete for convergence.
        try { await DB[methods.delete](docId); } catch (e) {}
        return;
      }
      var remote = snap.data();
      if (!remote || !remote.id) remote = Object.assign({ id: docId }, remote || {});
      // This record now reflects the server; set its base token so a later local
      // edit is measured against this value for optimistic-concurrency checks.
      DB.markSynced(remote);
      await DB[methods.update](remote);
    } catch (e) {
      // Re-throw so the caller does NOT advance the cursor past a failed apply.
      throw e;
    }
  }

  // ─── Incremental pull: replay version history from local cursor ───
  // Returns true if it fully reconciled via the change stream, false if the
  // caller should fall back to a full merge.

  async function incrementalPull(remoteMeta) {
    var local = getLocalCursor();

    // No usable local cursor, or a different generation → cannot replay history.
    if (local.generation === null || local.revision === null) return false;
    if (local.generation !== remoteMeta.generation) return false;

    // Already up to date for this generation.
    if (local.revision === remoteMeta.revision) return true;

    // Local is somehow ahead of remote → inconsistent, force full merge.
    if (local.revision > remoteMeta.revision) return false;

    // Local revision is older than the retained change window → the needed
    // envelopes have been trimmed, so it is no longer in the DB's version list.
    if (remoteMeta.revision - local.revision > CHANGE_WINDOW) return false;

    var changesRef = getChangesColRef();
    if (!changesRef) return false;

    _suppressNotify = true;
    DB.setSuppressStamp(true);
    try {
      // Process revisions strictly in order: local+1, local+2, …, remote.
      for (var rev = local.revision + 1; rev <= remoteMeta.revision; rev++) {
        var changeSnap;
        try {
          changeSnap = await changesRef.doc(revisionDocId(rev)).get();
        } catch (e) {
          console.error('[SYNC] change read failed at rev', rev, e);
          return false; // network/read error — fall back, keep cursor
        }

        if (!changeSnap.exists) {
          // A revision is missing from the stream — cannot safely skip it.
          console.warn('[SYNC] missing revision', rev, '→ full reconciliation');
          return false;
        }

        var change = changeSnap.data() || {};
        if (change.generation !== remoteMeta.generation) {
          // Envelope belongs to a different generation — history is inconsistent.
          return false;
        }

        try {
          await applyRemoteDoc(change.store, change.docId, change.op);
        } catch (e) {
          console.error('[SYNC] apply failed at rev', rev, '→ keep cursor, fall back', e);
          return false; // do NOT advance cursor past a failed apply
        }

        // Persist the cursor only after this revision applied successfully.
        setLocalCursor(remoteMeta.generation, rev);
      }
      return true;
    } finally {
      _suppressNotify = false;
      DB.setSuppressStamp(false);
    }
  }

  // ─── Full merge (authoritative reconciliation / regular merge) ───
  // Used on first sync, when there is no version info in the DB, when the local
  // cursor is not in the DB's version list, or when incremental replay fails.
  // Records are matched by id. Conflicts resolve by newest updatedAt.

  async function fullMerge() {
    if (!firestoreDb) return;
    var collectionName = FirestoreConfig.getCollectionName();
    if (!collectionName) return;

    console.log('[SYNC] Full merge (regular merge / authoritative reconciliation)');
    _suppressNotify = true;
    DB.setSuppressStamp(true);

    try {
      for (var i = 0; i < SYNCED_STORES.length; i++) {
        var storeName = SYNCED_STORES[i];
        var methods = STORE_METHOD_MAP[storeName];
        if (!methods) continue;

        var colRef = firestoreDb.collection(collectionName + '_' + storeName);
        var snapshot = await colRef.get();

        // Build remote map keyed by id.
        var remoteDocs = {};
        snapshot.forEach(function (doc) { remoteDocs[doc.id] = doc.data(); });

        // Local map keyed by id.
        var localRecords = await DB[methods.getAll]();
        var localMap = {};
        localRecords.forEach(function (r) { if (r.id) localMap[r.id] = r; });

        // NON-DESTRUCTIVE MERGE: never delete a local record just because it is
        // absent from the remote. "Absent" is ambiguous — it can mean "created
        // locally, not yet pushed" (common on first sync / empty remote), and
        // deleting it would destroy brand-new data. Record deletions propagate
        // ONLY through explicit change-stream delete envelopes in
        // incrementalPull() → applyRemoteDoc(store, id, 'delete'). Full merge is
        // upsert-only; any local-only record is kept and uploaded by the next push().

        // Merge remote → local with OPTIMISTIC CONCURRENCY (reject-and-flag).
        // For each record present on both sides we compare the local record's
        // base token (the server value it was last synced from) against the
        // current remote value to decide: accept remote / keep local / conflict.
        for (var remoteId in remoteDocs) {
          var remote = remoteDocs[remoteId];
          if (!remote || !remote.id) remote = Object.assign({ id: remoteId }, remote || {});
          var localRec = localMap[remoteId];

          if (!localRec) {
            // Remote-only record → add it locally (now in sync).
            DB.markSynced(remote);
            try { await DB[methods.update](remote); } catch (e) {}
            continue;
          }

          var rTs    = (typeof remote.updatedAt === 'number') ? remote.updatedAt : 0;
          var lTs    = (typeof localRec.updatedAt === 'number') ? localRec.updatedAt : 0;
          var lBase  = (typeof localRec._baseUpdatedAt === 'number') ? localRec._baseUpdatedAt : undefined;
          var localDirty = (lBase === undefined) ? (lTs > 0 && rTs === 0) : (lTs !== lBase);

          if (!localDirty) {
            // Local has no un-pushed edit → accept the remote value.
            if (rTs !== lTs) { DB.markSynced(remote); try { await DB[methods.update](remote); } catch (e) {} }
            continue;
          }

          // Local IS dirty. Did the remote move past our base?
          var remoteMatchesBase = (lBase !== undefined) && (rTs === lBase);
          if (remoteMatchesBase) {
            // Remote unchanged since our base → keep local; it uploads next push.
            continue;
          }

          // Both the local record and the remote changed independently → CONFLICT.
          // Reject (keep local untouched, do NOT overwrite) and flag this record.
          flagConflict(storeName, remoteId, 'changed on another device and locally');
        }
      }
    } catch (e) {
      console.error('[SYNC] Full merge failed:', e);
      throw e;
    } finally {
      _suppressNotify = false;
      DB.setSuppressStamp(false);
    }
  }

  // ─── Pull: choose incremental vs full merge based on version history ───

  async function pull() {
    if (!firestoreDb) return;
    var collectionName = FirestoreConfig.getCollectionName();
    if (!collectionName) return;

    var remoteMeta = await readRemoteMeta();

    if (!remoteMeta) {
      // No version info in the DB → regular merge, then seed meta on next push.
      slog('ok', 'No version info in DB → full merge');
      await fullMerge();
      return;
    }

    var local = getLocalCursor();
    // Cache-first: if our cursor already matches the remote head, there is
    // nothing to download beyond the /sync/meta read we just did.
    if (local.generation === remoteMeta.generation && local.revision === remoteMeta.revision) {
      slog('ok', 'Up to date (rev ' + remoteMeta.revision + ') — cache-first, no download');
      return;
    }

    // Try incremental replay from the local cursor.
    var ok = false;
    try {
      ok = await incrementalPull(remoteMeta);
    } catch (e) {
      console.error('[SYNC] incrementalPull threw:', e);
      ok = false;
    }

    if (ok) {
      slog('ok', 'Incremental sync → rev ' + remoteMeta.revision);
    } else {
      // Local version not in the DB's history (or replay failed) → regular merge,
      // then adopt the remote cursor as our new baseline.
      slog('ok', 'Cursor not in history → full merge, adopt rev ' + remoteMeta.revision);
      await fullMerge();
      setLocalCursor(remoteMeta.generation, remoteMeta.revision);
    }
  }

  // --- Sync: push then pull (the only entry point) ---

  async function sync() {
    if (status !== 'connected') {
      var connected = await connect();
      if (!connected) { slog('err', 'Quick sync: not connected'); return; }
    }
    slog('ok', 'Quick sync: push + Sync V2 check');
    await push();
    await pull();
    // After a push that created new revisions, align our cursor to the head so
    // the next reload is cache-first and doesn't re-apply our own changes.
    var afterMeta = await readRemoteMeta();
    if (afterMeta) setLocalCursor(afterMeta.generation, afterMeta.revision);
    // Refresh UI once after sync
    document.dispatchEvent(new CustomEvent('tyf-sync-update'));
  }

  // --- Full sync: explicit, authoritative reconciliation from the DB ---
  // Triggered by the Settings "Full sync from DB" button. Unlike the lightweight
  // sync() (which is cache-first and incremental via the version cursor), this
  // always pushes dirty local changes and then performs a full merge against
  // every collection regardless of the cursor, then adopts the remote head.
  // Still non-destructive: full merge never deletes local-only records.
  async function fullSync() {
    if (status !== 'connected') {
      var connected = await connect();
      if (!connected) { slog('err', 'Full sync: not connected'); return false; }
    }
    slog('ok', 'Full sync from DB: starting (push + full merge)…');
    try {
      await push();
      await fullMerge();
      var afterMeta = await readRemoteMeta();
      if (afterMeta) {
        setLocalCursor(afterMeta.generation, afterMeta.revision);
        slog('ok', 'Full sync complete → rev ' + afterMeta.revision);
      } else {
        slog('ok', 'Full sync complete (no version meta yet)');
      }
      document.dispatchEvent(new CustomEvent('tyf-sync-update'));
      return true;
    } catch (e) {
      slog('err', 'Full sync failed: ' + ((e && e.message) ? e.message : 'unknown'));
      return false;
    }
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
      slog('ok', 'Loading Firebase SDK from gstatic.com…');
      await loadFirebaseSDK();
      if (!window.firebase) {
        slog('err', 'Firebase SDK not available after load');
        return { ok: false, message: 'Firebase SDK could not be loaded. Check your internet connection.' };
      }
      slog('ok', 'Firebase SDK loaded; initializing app…');

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
      slog('ok', 'Reading ' + colName + '_members (limit 1)…');
      await testDb.collection(colName + '_members').limit(1).get();

      slog('ok', 'Read succeeded');
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

  // flushQueue is now just sync (for backward compat with sync button)
  async function flushQueue() { await sync(); }

  return {
    init: init,
    reinitialize: reinitialize,
    disconnect: disconnect,
    notifyChange: notifyChange,
    getStatus: getStatus,
    flushQueue: flushQueue,
    fullSync: fullSync,
    getQueueSize: getQueueSize,
    getConflicts: getConflicts,
    getConflictCount: getConflictCount,
    clearConflicts: clearConflicts,
    testConnection: testConnection
  };
})();
