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

  var _applied = 0;    // records written into the local DB by the current sync (drives UI refresh)
  var _silent = false;  // true while a background (auto) sync runs — keeps the activity log quiet

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
    if (_silent && status === 'ok' && !_applied) return;   // background "nothing new" noise
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

  // The queue lives in memory (loaded once) and is persisted to localStorage in
  // ONE debounced write per burst of changes. Previously every record change
  // parsed and re-stringified the whole queue, so saving 40+ records was O(n²)
  // on the main thread. It is also flushed when the app is hidden/closed, so an
  // iOS suspension doesn't lose pending changes. If storage rejects the write
  // (quota) the in-memory queue still holds everything for this session.
  var _q = null;
  var _persistTimer = null;

  function getQueue() {
    if (_q === null) {
      try { var raw = localStorage.getItem(QUEUE_KEY); _q = raw ? JSON.parse(raw) : []; }
      catch (e) { _q = []; }
    }
    return _q;
  }

  function _persistQueueNow() {
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    if (_q === null) return;
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(_q)); }
    catch (e) {
      slog('err', 'Sync queue could not be saved to storage (' + _q.length + ' pending) — kept in memory; sync soon');
    }
  }

  function saveQueue(queue) {
    _q = queue;
    if (!_persistTimer) _persistTimer = setTimeout(_persistQueueNow, 150);
  }

  // Flush before the page goes away / is backgrounded (iOS may kill it silently).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') _persistQueueNow();
  });
  window.addEventListener('pagehide', _persistQueueNow);

  // Remove a pushed entry from the CURRENT queue, but only if it hasn't been
  // re-edited since the push snapshot (a newer edit has a different updatedAt).
  function removeFromQueue(entry) {
    var upd = entry.data ? entry.data.updatedAt : undefined;
    var q = getQueue().filter(function (e) {
      if (e.storeName !== entry.storeName || e.docId !== entry.docId) return true;
      if (e.operation !== entry.operation) return true;
      return (e.data ? e.data.updatedAt : undefined) !== upd;
    });
    saveQueue(q);
  }

  function isQueued(storeName, docId) {
    var id = String(docId);
    return getQueue().some(function (e) { return e.storeName === storeName && e.docId === id; });
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
    _scheduleAutoSync();
  }

  // ─── Automatic background sync ───
  // Saving only QUEUES a change; nothing reached the DB until someone tapped 🔄
  // or relaunched, so other devices saw data "later". Now:
  //  • a save triggers a push (debounced) a few seconds later,
  //  • the app syncs when it comes back to the foreground / network returns,
  //  • and a light check (one tiny meta read) runs while the app is open.
  // No Firestore listeners are used (avoids the old feedback loops).
  var AUTO_PUSH_DELAY = 4000;
  var POLL_INTERVAL = 45000;
  var MIN_GAP = 15000;
  var _autoTimer = null, _pollTimer = null, _lastSyncAt = 0, _bgStarted = false;

  function _syncEnabled() {
    return typeof FirestoreConfig !== 'undefined' && FirestoreConfig.isSyncEnabled() && FirestoreConfig.hasConfig();
  }
  function _online() { return typeof navigator === 'undefined' || navigator.onLine !== false; }

  function _scheduleAutoSync() {
    if (!_bgStarted || !_syncEnabled()) return;
    if (_autoTimer) clearTimeout(_autoTimer);
    _autoTimer = setTimeout(function () {
      _autoTimer = null;
      if (_online()) syncBackground().catch(function () {});
    }, AUTO_PUSH_DELAY);
  }

  function _startBackground() {
    if (_bgStarted) return;
    _bgStarted = true;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        if (Date.now() - _lastSyncAt > MIN_GAP && _online()) syncBackground().catch(function () {});
      } else if (getQueue().length > 0 && _online()) {
        syncBackground().catch(function () {});   // best effort before iOS suspends us
      }
    });
    window.addEventListener('online', function () { syncBackground().catch(function () {}); });
    _pollTimer = setInterval(function () {
      if (document.visibilityState === 'visible' && _online() && Date.now() - _lastSyncAt > MIN_GAP) {
        syncBackground().catch(function () {});
      }
    }, POLL_INTERVAL);
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

    var remainingCount = 0;

    // Entries whose collection can't be resolved stay queued.
    queue = queue.filter(function (e) {
      if (getCollectionRef(e.storeName)) return true;
      remainingCount++;
      return false;
    });

    // ONE transaction per batch (instead of one per record): 1 meta read + the
    // remote docs read in parallel + a single commit. Revisions are allocated as
    // a contiguous range, one change envelope per revision (same format as
    // before, so devices on older code still replay correctly).
    for (var start = 0; start < queue.length; start += PUSH_BATCH) {
      var batch = queue.slice(start, start + PUSH_BATCH);
      var res;
      try {
        res = await _pushBatch(batch, metaRef, changesRef);
      } catch (err) {
        if (err && err.code === 'permission-denied') {
          // Firestore rules blocked the write. NEVER drop the changes: they stay
          // queued (and are retried) so they upload once the rules/config are
          // fixed. Make it visible instead of failing silently — but at most once
          // every 10 minutes, since the background sync retries regularly.
          remainingCount += batch.length;
          if (Date.now() - _lastPermLog > 600000) {
            _lastPermLog = Date.now();
            slog('err', 'Upload blocked by Firestore rules (permission-denied) — ' + queue.length + ' change(s) kept and will retry. Check security rules / config.');
          }
          continue;
        }
        // Network / contention failure: keep this and the rest queued for the next sync.
        remainingCount += queue.length - start;
        console.error('[SYNC] Push batch failed:', err);
        break;
      }

      // Accepted writes — reflect the new base token in the local record so a
      // later edit measures against the value we just uploaded.
      for (var a = 0; a < res.accepted.length; a++) {
        var ok = res.accepted[a];
        if (ok.operation !== 'delete' && ok.data && ok.data.id) {
          try { await _writeBackLocalBase(ok.storeName, ok.data); } catch (e) {}
        }
        // Drop just this entry (never rewrite the whole queue, which would erase
        // changes the user saved while this push was running).
        removeFromQueue(ok);
      }

      // Rejected records: TAKE THEIRS — another device changed the record since
      // our base. Overwrite local with the remote version (re-baseline), log the
      // lost local edit, flag it, and drop the queue entry. Only these records are
      // rejected; the rest of the batch was committed.
      for (var c = 0; c < res.conflicts.length; c++) {
        var cf = res.conflicts[c];
        try { await _resolveConflictTakeTheirs(cf.entry.storeName, cf.entry.docId, cf.remote, cf.entry.data); } catch (e2) {}
        flagConflict(cf.entry.storeName, cf.entry.docId, 'your change was overwritten by another device (saved to activity log)');
        removeFromQueue(cf.entry);
      }
    }

    if (remainingCount > 0) console.log('[SYNC] Push incomplete,', remainingCount, 'items remaining');
  }

  var _lastPermLog = 0;
  var PUSH_BATCH = 100;  // 2 writes per change + 1 meta write << Firestore's 500-op limit

  async function _pushBatch(batch, metaRef, changesRef) {
    return firestoreDb.runTransaction(async function (tx) {
      // Reads first (Firestore requires all reads before any write). The body may
      // re-run on contention, so all accumulators are local to this attempt.
      var metaSnap = await tx.get(metaRef);
      var remoteSnaps = await Promise.all(batch.map(function (entry) {
        return entry.operation === 'delete' ? null : tx.get(getCollectionRef(entry.storeName).doc(entry.docId));
      }));

      var meta = metaSnap.exists ? (metaSnap.data() || {}) : {};
      var generation = (typeof meta.generation === 'number') ? meta.generation : 1;
      var revision = (typeof meta.revision === 'number') ? meta.revision : 0;

      var accepted = [], conflicts = [];
      var now = Date.now(), dev = getDeviceId();

      batch.forEach(function (entry, i) {
        var remoteSnap = remoteSnaps[i];
        // Optimistic concurrency check (reject-and-flag): only meaningful for
        // updates to an existing remote doc. A delete, or a create (remote
        // missing), cannot conflict.
        if (entry.operation !== 'delete' && remoteSnap && remoteSnap.exists) {
          var remoteData = remoteSnap.data() || {};
          var base = (entry.data && typeof entry.data._baseUpdatedAt === 'number') ? entry.data._baseUpdatedAt : undefined;
          var remoteTs = (typeof remoteData.updatedAt === 'number') ? remoteData.updatedAt : undefined;
          if (base !== undefined && remoteTs !== undefined && remoteTs !== base) {
            conflicts.push({ entry: entry, remote: remoteData });
            return;
          }
        }

        revision++;
        var dataDocRef = getCollectionRef(entry.storeName).doc(entry.docId);
        if (entry.operation === 'delete') {
          tx.delete(dataDocRef);
        } else {
          // Accepted: base token equals its own updatedAt on the uploaded doc too.
          if (entry.data && typeof entry.data.updatedAt === 'number') entry.data._baseUpdatedAt = entry.data.updatedAt;
          tx.set(dataDocRef, entry.data);
        }
        tx.set(changesRef.doc(revisionDocId(revision)), {
          rev: revision, generation: generation, store: entry.storeName, docId: entry.docId,
          op: entry.operation, dev: dev, ts: now
        });
        accepted.push(entry);
      });

      if (accepted.length) tx.set(metaRef, { generation: generation, revision: revision }, { merge: true });
      return { accepted: accepted, conflicts: conflicts };
    });
  }

  // After an accepted push, update the local record's _baseUpdatedAt so the next
  // local edit is measured against the value we just uploaded (not an older base).
  async function _writeBackLocalBase(storeName, data) {
    var methods = STORE_METHOD_MAP[storeName];
    if (!methods || !methods.get || !methods.update) return;
    try {
      var local = await DB[methods.get](data.id);
      if (local && typeof data.updatedAt === 'number') {
        // Only write back if the local record hasn't been edited again since.
        if (local.updatedAt === data.updatedAt) {
          local._baseUpdatedAt = data.updatedAt;
          DB.markNoSync(local);   // this record only — user saves elsewhere stay queued
          await DB[methods.update](local);
        }
      }
    } catch (e) {}
  }

  // Build a short, human summary of the LOST local edit for the activity log:
  // the fields where the discarded local value differs from the remote we kept.
  // Ignores internal/sync fields. Returns '' if nothing meaningful to show.
  function _lostEditDetail(localData, remoteData) {
    try {
      if (!localData) return '';
      var skip = { id: 1, updatedAt: 1, version: 1, _baseUpdatedAt: 1, _lastModified: 1, _deviceId: 1 };
      var parts = [];
      Object.keys(localData).forEach(function (k) {
        if (skip[k]) return;
        var lv = localData[k], rv = remoteData ? remoteData[k] : undefined;
        if (String(lv) !== String(rv)) {
          parts.push(k + '=' + (lv === undefined || lv === null ? '' : String(lv)));
        }
      });
      if (!parts.length) return '';
      var s = parts.join(', ');
      if (s.length > 160) s = s.slice(0, 157) + '…';
      return ' · your value: ' + s;
    } catch (e) { return ''; }
  }

  // Resolve a push conflict as TAKE-THEIRS: overwrite the local record with the
  // remote version (re-baselined so it is no longer "dirty"), and record the
  // lost local edit in the activity log. Writes are suppressed so they do not
  // re-queue to the sync queue or re-stamp the record.
  async function _resolveConflictTakeTheirs(storeName, docId, remoteData, lostLocalData) {
    var methods = STORE_METHOD_MAP[storeName];
    if (!methods) return;

    // 1. Log the lost local edit (fire-and-forget audit; synced, append-only).
    try {
      if (typeof Audit !== 'undefined' && Audit.writeAudit) {
        Audit.writeAudit('CF', { store: storeName, id: String(docId).slice(0, 8), detail: _lostEditDetail(lostLocalData, remoteData) });
      }
    } catch (e) {}

    // 2. Overwrite local with remote (take-theirs) and re-baseline, suppressed.
    try {
      if (remoteData && (remoteData.id || docId)) {
        var remote = Object.assign({}, remoteData);
        if (!remote.id) remote.id = docId;
        DB.markSynced(remote);
        DB.markNoSync(remote);
        await DB[methods.update](remote);
        _applied++;
      } else {
        // Remote has no usable body — delete the stale local record so it stops
        // conflicting (its edit is already preserved in the activity log).
        try { await DB.deleteLocalOnly(storeName, DB[methods.delete], docId); } catch (e) {}
      }
    } catch (e) {}
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
    if (!STORE_METHOD_MAP[storeName]) return;
    var snap = null;
    if (op !== 'delete') {
      var dataColRef = getCollectionRef(storeName);
      if (!dataColRef) return;
      snap = await dataColRef.doc(docId).get();
    }
    await _applyFetched(storeName, docId, op, snap);
  }

  // Apply one remote change given its already-fetched data doc (null for deletes).
  async function _applyFetched(storeName, docId, op, snap) {
    var methods = STORE_METHOD_MAP[storeName];
    if (!methods) return;

    if (op === 'delete') {
      try { await DB.deleteLocalOnly(storeName, DB[methods.delete], docId); _applied++; } catch (e) {}
      return;
    }

    if (!snap || !snap.exists) {
      // Envelope says put but doc is gone — treat as delete for convergence.
      try { await DB.deleteLocalOnly(storeName, DB[methods.delete], docId); _applied++; } catch (e) {}
      return;
    }
    var remote = snap.data();
    if (!remote || !remote.id) remote = Object.assign({ id: docId }, remote || {});
    // A local edit still waiting to push must not be clobbered by replaying an
    // older remote version; push() will reconcile it via the concurrency check.
    if (isQueued(storeName, docId)) return;
    // Throws on failure so the caller does NOT advance the cursor past it.
    await putRemoteRecord(storeName, remote);
  }

  // Write a record that came FROM the server (stamping already suppressed by the
  // caller). Marks it synced. Attendance has a unique member+date index, so two
  // devices that created rows for the same member+date with different ids are
  // reconciled deterministically here instead of failing with ConstraintError:
  // the newer updatedAt wins (tie → larger id), and every device picks the same
  // winner. Returns true if the remote record was stored.
  async function putRemoteRecord(storeName, remote) {
    var methods = STORE_METHOD_MAP[storeName];
    // Both stores have a unique member+date index (see db.js).
    var twinLookup = storeName === 'attendance' ? DB.getAttendanceByMemberDate
                   : storeName === 'monthly_fee_records' ? DB.getMonthlyFeeRecordByMemberDate : null;
    if (twinLookup && remote.memberId && remote.date) {
      var twin = await twinLookup(remote.memberId, remote.date);
      if (twin && twin.id !== remote.id) {
        var tTs = (typeof twin.updatedAt === 'number') ? twin.updatedAt : 0;
        var rTs = (typeof remote.updatedAt === 'number') ? remote.updatedAt : 0;
        var remoteWins = rTs > tTs || (rTs === tTs && String(remote.id) > String(twin.id));
        if (!remoteWins) return false;
        await DB.deleteLocalOnly(storeName, DB[methods.delete], twin.id);   // loser: local only
      }
    }
    DB.markSynced(remote);
    DB.markNoSync(remote);   // applied FROM the server: never re-stamp or re-queue it
    await DB[methods.update](remote);
    _applied++;
    return true;
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

    // ONE range query for all missing envelopes (was 2 sequential reads per
    // revision). Needs only the automatic single-field index on `rev`.
    var snap;
    try {
      snap = await changesRef.where('rev', '>', local.revision).where('rev', '<=', remoteMeta.revision).orderBy('rev').get();
    } catch (e) {
      console.error('[SYNC] change range read failed', e);
      return false; // network/read error — fall back, keep cursor
    }

    // The stream must be complete and contiguous: local+1 … remote. Any gap
    // means we cannot safely skip a revision → full reconciliation.
    var expected = remoteMeta.revision - local.revision;
    var changes = snap.docs.map(function (d) { return d.data() || {}; });
    if (changes.length !== expected) {
      console.warn('[SYNC] change stream has', changes.length, 'of', expected, 'revisions → full reconciliation');
      return false;
    }
    var myDev = getDeviceId();
    var last = {};   // store|docId → latest change (revision order)
    for (var i = 0; i < changes.length; i++) {
      var ch = changes[i];
      if (ch.rev !== local.revision + 1 + i || ch.generation !== remoteMeta.generation) return false;
      // Our own pushed change is already applied locally — skip re-reading it.
      if (ch.dev && ch.dev === myDev) continue;
      last[ch.store + '|' + ch.docId] = ch;
    }
    var todo = Object.keys(last).map(function (k) { return last[k]; })
      .sort(function (a, b) { return a.rev - b.rev; });

    try {
      // Fetch every changed doc with bounded parallelism (deletes need no read).
      var fetched = new Array(todo.length);
      var next = 0;
      async function worker() {
        while (next < todo.length) {
          var idx = next++;
          var t = todo[idx];
          if (t.op === 'delete') continue;
          fetched[idx] = await getCollectionRef(t.store).doc(t.docId).get();
        }
      }
      var workers = [];
      for (var w = 0; w < PULL_CONCURRENCY; w++) workers.push(worker());
      try { await Promise.all(workers); }
      catch (e) { console.error('[SYNC] doc fetch failed → fall back', e); return false; }

      // Apply in revision order, by id. Cursor advances only after ALL applied.
      for (var j = 0; j < todo.length; j++) {
        try { await _applyFetched(todo[j].store, todo[j].docId, todo[j].op, fetched[j]); }
        catch (e) {
          console.error('[SYNC] apply failed at rev', todo[j].rev, '→ keep cursor, fall back', e);
          return false; // do NOT advance cursor past a failed apply
        }
      }
      setLocalCursor(remoteMeta.generation, remoteMeta.revision);
      return true;
    } catch (e) {
      console.error('[SYNC] incremental pull failed', e);
      return false;
    }
  }

  var PULL_CONCURRENCY = 8;

  // ─── Full merge (authoritative reconciliation / regular merge) ───
  // Used on first sync, when there is no version info in the DB, when the local
  // cursor is not in the DB's version list, or when incremental replay fails.
  // Records are matched by id. Conflicts resolve by newest updatedAt.

  async function fullMerge() {
    if (!firestoreDb) return;
    var collectionName = FirestoreConfig.getCollectionName();
    if (!collectionName) return;

    console.log('[SYNC] Full merge (regular merge / authoritative reconciliation)');
    var mergeFailed = 0;   // records that could not be stored — caller must not adopt the head cursor

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
            try { await putRemoteRecord(storeName, remote); } catch (e) { mergeFailed++; slog('err', 'Merge: could not store ' + storeName + ' ' + String(remoteId).slice(0, 8) + ' — ' + (e && e.message)); }
            continue;
          }

          var rTs    = (typeof remote.updatedAt === 'number') ? remote.updatedAt : 0;
          var lTs    = (typeof localRec.updatedAt === 'number') ? localRec.updatedAt : 0;
          var lBase  = (typeof localRec._baseUpdatedAt === 'number') ? localRec._baseUpdatedAt : undefined;
          var localDirty = (lBase === undefined) ? (lTs > 0 && rTs === 0) : (lTs !== lBase);

          if (!localDirty) {
            // Local has no un-pushed edit → accept the remote value. (Re-check the
            // live queue: the user may have saved this record since our snapshot.)
            if (isQueued(storeName, remoteId)) continue;
            if (rTs !== lTs) { try { await putRemoteRecord(storeName, remote); } catch (e) { mergeFailed++; slog('err', 'Merge: could not update ' + storeName + ' ' + String(remoteId).slice(0, 8) + ' — ' + (e && e.message)); } }
            continue;
          }

          // Local IS dirty. Did the remote move past our base?
          var remoteMatchesBase = (lBase !== undefined) && (rTs === lBase);
          if (remoteMatchesBase) {
            // Remote unchanged since our base → keep local; it uploads next push.
            continue;
          }

          // Both the local record and the remote changed independently → CONFLICT.
          // TAKE THEIRS: log the lost local edit to the activity log, then
          // overwrite local with remote and re-baseline so it is no longer
          // dirty (self-heals — no repeated conflict). The CF audit record is a
          // normal write, so it queues for sync (append-only).
          try {
            if (typeof Audit !== 'undefined' && Audit.writeAudit) {
              Audit.writeAudit('CF', { store: storeName, id: String(remoteId).slice(0, 8), detail: _lostEditDetail(localRec, remote) });
            }
          } catch (e) {}
          try { await putRemoteRecord(storeName, remote); } catch (e) { mergeFailed++; slog('err', 'Merge: could not apply ' + storeName + ' ' + String(remoteId).slice(0, 8) + ' — ' + (e && e.message)); }
          flagConflict(storeName, remoteId, 'your change was overwritten by another device (saved to activity log)');
        }
      }
    } catch (e) {
      console.error('[SYNC] Full merge failed:', e);
      throw e;
    }
    return mergeFailed;
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
      return (await fullMerge()) === 0;
    }

    var local = getLocalCursor();
    // Cache-first: if our cursor already matches the remote head, there is
    // nothing to download beyond the /sync/meta read we just did.
    if (local.generation === remoteMeta.generation && local.revision === remoteMeta.revision) {
      slog('ok', 'Up to date (rev ' + remoteMeta.revision + ') — cache-first, no download');
      return true;
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
      var failed = await fullMerge();
      // Adopt the head we read BEFORE merging (anything newer is replayed next
      // time) — and only if every record was stored, so nothing is skipped.
      if (failed === 0) setLocalCursor(remoteMeta.generation, remoteMeta.revision);
      else slog('err', 'Full merge: ' + failed + ' record(s) failed — cursor not advanced, will retry');
      return failed === 0;
    }
    return true;
  }

  // Local-only housekeeping (orphan / duplicate cleanup). Runs ONLY after a sync
  // that fully reconciled and left nothing queued, i.e. when "this member isn't
  // on this device" really does mean "this member no longer exists". These
  // deletes are never pushed (see DB.deleteLocalOnly).
  async function _housekeeping() {
    try {
      if (getQueue().length > 0) return;
      await DB.deduplicateFeeRecords();
      var removed = await DB.cleanupOrphans();
      if (removed > 0) slog('ok', 'Cleaned up ' + removed + ' orphaned local record(s)');
    } catch (e) {}
  }

  // --- Sync: push then pull (the only entry point) ---

  // Serialize all sync work (startup, 🔄 button, Full sync) so two runs never
  // interleave. Calls made while one is merely *waiting* share that waiting run.
  var _lock = Promise.resolve();
  var _syncWaiting = null;
  function _exclusive(fn) {
    var run = _lock.then(fn);
    _lock = run.catch(function () {});
    return run;
  }

  function sync() {
    if (_syncWaiting) return _syncWaiting;
    _syncWaiting = _exclusive(function () { _syncWaiting = null; return _syncOnce(); });
    return _syncWaiting;
  }

  // Background (auto) sync: same work, but quiet — it only asks the UI to redraw
  // when it actually changed local data, so it never disturbs what the user is doing.
  var _bgWaiting = null;
  function syncBackground() {
    if (!_syncEnabled()) return Promise.resolve();
    if (_bgWaiting) return _bgWaiting;
    _bgWaiting = _exclusive(function () { _bgWaiting = null; return _syncOnce(true); });
    return _bgWaiting;
  }

  async function _syncOnce(silent) {
    _silent = !!silent;
    _applied = 0;
    try {
      if (status !== 'connected') {
        var connected = await connect();
        if (!connected) { slog('err', 'Quick sync: not connected'); return; }
      }
      slog('ok', 'Quick sync: push + Sync V2 check');
      await push();
      // pull() advances the cursor only to what it actually applied. We must NOT
      // jump to a freshly-read head here: revisions other devices pushed while we
      // were pulling would be skipped forever.
      var reconciled = await pull();
      if (reconciled) await _housekeeping();
      _lastSyncAt = Date.now();
      // Tell the UI once after sync, and how much local data actually changed.
      document.dispatchEvent(new CustomEvent('tyf-sync-update', { detail: { changed: _applied, silent: !!silent } }));
    } finally {
      _silent = false;
    }
  }

  // --- Full sync: explicit, authoritative reconciliation from the DB ---
  // Triggered by the Settings "Full sync from DB" button. Unlike the lightweight
  // sync() (which is cache-first and incremental via the version cursor), this
  // always pushes dirty local changes and then performs a full merge against
  // every collection regardless of the cursor, then adopts the remote head.
  // Still non-destructive: full merge never deletes local-only records.
  function fullSync() { return _exclusive(_fullSyncOnce); }

  async function _fullSyncOnce() {
    if (status !== 'connected') {
      var connected = await connect();
      if (!connected) { slog('err', 'Full sync: not connected'); return false; }
    }
    slog('ok', 'Full sync from DB: starting (push + full merge)…');
    try {
      await push();
      // Read the head BEFORE merging: changes pushed meanwhile get replayed next sync.
      var beforeMeta = await readRemoteMeta();
      var failed = await fullMerge();
      if (failed > 0) {
        slog('err', 'Full sync: ' + failed + ' record(s) could not be stored — cursor not advanced');
        document.dispatchEvent(new CustomEvent('tyf-sync-update'));
        return false;
      }
      if (beforeMeta) {
        setLocalCursor(beforeMeta.generation, beforeMeta.revision);
        slog('ok', 'Full sync complete → rev ' + beforeMeta.revision);
      } else {
        slog('ok', 'Full sync complete (no version meta yet)');
      }
      await _housekeeping();
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
    // Connect and do one sync on startup, then keep syncing in the background.
    _startBackground();
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
    syncBackground: syncBackground,
    fullSync: fullSync,
    getQueueSize: getQueueSize,
    getConflicts: getConflicts,
    getConflictCount: getConflictCount,
    clearConflicts: clearConflicts,
    testConnection: testConnection
  };
})();
