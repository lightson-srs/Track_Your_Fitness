const DB = (function () {
  'use strict';
  const DB_NAME = 'TrackYourFitness';
  const DB_VERSION = 8;
  let db = null;

  function generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function init() {
    return new Promise((resolve, reject) => {
      if (db) { resolve(db); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = (e) => reject(new Error('Failed to open database: ' + (e.target.error?.message || 'Unknown')));
      request.onsuccess = (e) => { db = e.target.result; resolve(db); };
      request.onupgradeneeded = (e) => {
        const database = e.target.result;

        if (!database.objectStoreNames.contains('members')) {
          const ms = database.createObjectStore('members', { keyPath: 'id' });
          ms.createIndex('name', 'name', { unique: true });
          ms.createIndex('status', 'status', { unique: false });
        }
        if (!database.objectStoreNames.contains('contributions')) {
          const cs = database.createObjectStore('contributions', { keyPath: 'id' });
          cs.createIndex('memberId', 'memberId', { unique: true });
          cs.createIndex('status', 'status', { unique: false });
        }
        if (!database.objectStoreNames.contains('payments')) {
          const ps = database.createObjectStore('payments', { keyPath: 'id' });
          ps.createIndex('memberId', 'memberId', { unique: false });
          ps.createIndex('date', 'date', { unique: false });
          ps.createIndex('type', 'type', { unique: false });
        }
        if (!database.objectStoreNames.contains('expenses')) {
          const es = database.createObjectStore('expenses', { keyPath: 'id' });
          es.createIndex('date', 'date', { unique: false });
          es.createIndex('category', 'category', { unique: false });
        }
        // v4: guest_sessions — one record per member per day they played
        if (!database.objectStoreNames.contains('guest_sessions')) {
          const gs = database.createObjectStore('guest_sessions', { keyPath: 'id' });
          gs.createIndex('memberId', 'memberId', { unique: false });
          gs.createIndex('date', 'date', { unique: false });
          gs.createIndex('status', 'status', { unique: false });
        }
        // v5: monthly_fee_records — one record per member per apply action
        // same member+date → overwrite; same member+different date same month → both kept
        if (!database.objectStoreNames.contains('monthly_fee_records')) {
          const mf = database.createObjectStore('monthly_fee_records', { keyPath: 'id' });
          mf.createIndex('memberId', 'memberId', { unique: false });
          mf.createIndex('date', 'date', { unique: false });
          mf.createIndex('period', 'period', { unique: false });
          mf.createIndex('status', 'status', { unique: false });
          // composite: memberId+date for overwrite lookup
          mf.createIndex('memberDate', ['memberId','date'], { unique: false });
        }

        // v6: Make memberDate index unique to prevent duplicate fee records per member+date
        if (e.oldVersion < 6 && database.objectStoreNames.contains('monthly_fee_records')) {
          var mfStore = e.target.transaction.objectStore('monthly_fee_records');
          if (mfStore.indexNames.contains('memberDate')) {
            mfStore.deleteIndex('memberDate');
          }
          mfStore.createIndex('memberDate', ['memberId','date'], { unique: true });
        }

        // v7: attendance store
        if (!database.objectStoreNames.contains('attendance')) {
          const as = database.createObjectStore('attendance', { keyPath: 'id' });
          as.createIndex('memberId', 'memberId', { unique: false });
          as.createIndex('date', 'date', { unique: false });
          as.createIndex('memberDate', ['memberId', 'date'], { unique: true });
        }

        // v8: audit store — append-only activity log (synced cross-device).
        // Record: { id, t: epoch-ms, c: short code, p: params, day: 'YYYY-MM-DD' }
        if (!database.objectStoreNames.contains('audit')) {
          const au = database.createObjectStore('audit', { keyPath: 'id' });
          au.createIndex('day', 'day', { unique: false });
          au.createIndex('t', 't', { unique: false });
        }
      };
    });
  }

  function getStore(name, mode) {
    if (!db) throw new Error('Database not initialized');
    return db.transaction(name, mode).objectStore(name);
  }
  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(new Error(e.target.error?.message || 'DB operation failed'));
    });
  }
  function cursorCollect(store, indexName, keyRange) {
    return new Promise((resolve, reject) => {
      const results = [];
      const source = indexName ? store.index(indexName) : store;
      const req = keyRange ? source.openCursor(keyRange) : source.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { results.push(cursor.value); cursor.continue(); }
        else resolve(results);
      };
      req.onerror = (e) => reject(new Error(e.target.error?.message || 'Cursor failed'));
    });
  }

  // ─── Sync notification hook ───
  // Writes that must NOT be queued for upload — records applied FROM the server
  // by the sync engine, and local-only housekeeping deletes (a delete made
  // because "the member isn't on this device yet" must never propagate to the
  // shared DB). This is decided PER RECORD (not by a global on/off switch), so a
  // user's own save that happens while a sync is running is always queued and
  // stamped.
  var _noSync = new WeakSet();      // record objects (put)
  var _noSyncDel = {};              // 'store|id' → true (delete)
  function markNoSync(record) { if (record && typeof record === 'object') _noSync.add(record); return record; }
  function markNoSyncDelete(storeName, id) { _noSyncDel[storeName + '|' + id] = true; }
  function clearNoSyncDelete(storeName, id) { delete _noSyncDel[storeName + '|' + id]; }
  // Convenience: delete a record locally without notifying sync.
  async function deleteLocalOnly(storeName, deleteFn, id) {
    markNoSyncDelete(storeName, id);
    try { return await deleteFn(id); } finally { clearNoSyncDelete(storeName, id); }
  }

  function notifySyncIfAvailable(storeName, record, opType) {
    if (opType === 'delete') { if (record && _noSyncDel[storeName + '|' + record.id]) return; }
    else if (record && _noSync.has(record)) return;
    if (typeof SyncEngine !== 'undefined' && SyncEngine.notifyChange) {
      try { SyncEngine.notifyChange(storeName, record, opType); } catch (e) {}
    }
  }

  // ─── Sync V2 record stamping ───
  // Every synced record is identified by its stable `id` and carries its own
  // version/timestamp so sync can resolve conflicts and build version history
  // without relying on array position. Mutates and returns the record.
  //
  // When the sync engine writes records it pulled from the server, it must NOT
  // re-stamp them (that would bump the version and corrupt the authoritative
  // remote value). The sync engine marks those records with markNoSync().

  // Optimistic concurrency token:
  //   _baseUpdatedAt = the server `updatedAt` this record was last synced from.
  // On a LOCAL edit we bump `updatedAt`/`version` but PRESERVE _baseUpdatedAt as
  // the baseline the edit was made from, so push/merge can detect whether the
  // remote changed underneath us since then. A brand-new local record has no
  // _baseUpdatedAt (it's a create, cannot conflict).
  function stampRecord(record) {
    if (!record || typeof record !== 'object') return record;
    if (_noSync.has(record)) return record;
    // Capture the pre-edit value as the base the first time we edit a record
    // that already had a server-synced updatedAt and no base recorded yet.
    if (record._baseUpdatedAt === undefined && typeof record.updatedAt === 'number') {
      record._baseUpdatedAt = record.updatedAt;
    }
    record.updatedAt = Date.now();
    record.version = (typeof record.version === 'number' ? record.version : 0) + 1;
    return record;
  }

  // Called by the sync engine after a record is written FROM the server (pull /
  // full merge) or confirmed written TO the server (accepted push): the record
  // is now in sync, so its base token equals its current server updatedAt.
  function markSynced(record) {
    if (!record || typeof record !== 'object') return record;
    record._baseUpdatedAt = (typeof record.updatedAt === 'number') ? record.updatedAt : Date.now();
    return record;
  }

  // ─── Members ───
  function addMember(m)    { stampRecord(m); return reqToPromise(getStore('members','readwrite').add(m)).then(function(r) { notifySyncIfAvailable('members', m, 'put'); return r; }); }
  function getMember(id)   { return reqToPromise(getStore('members','readonly').get(id)); }
  function getAllMembers()  { return reqToPromise(getStore('members','readonly').getAll()); }
  // `name` is a unique index, so at most one member matches.
  function getMemberByName(name) { return reqToPromise(getStore('members','readonly').index('name').get(name)).then(function (r) { return r || null; }); }

  // Build an edited record from the STORED one plus the changed fields, so the
  // sync bookkeeping (updatedAt/version/_baseUpdatedAt, which drive conflict
  // detection) and any fields the form doesn't know about are preserved. Saving a
  // brand-new object built from a form would drop them and make the next upload
  // silently overwrite another device's edit. `undefined` edits are ignored.
  function mergeEdit(existing, edits) {
    var out = Object.assign({}, existing);
    Object.keys(edits || {}).forEach(function (k) { if (edits[k] !== undefined) out[k] = edits[k]; });
    return out;
  }
  function updateMember(m) { stampRecord(m); return reqToPromise(getStore('members','readwrite').put(m)).then(function(r) { notifySyncIfAvailable('members', m, 'put'); return r; }); }
  function deleteMember(id){ return reqToPromise(getStore('members','readwrite').delete(id)).then(function(r) { notifySyncIfAvailable('members', {id:id}, 'delete'); return r; }); }

  // ─── Contributions ───
  function addContribution(c)    { stampRecord(c); return reqToPromise(getStore('contributions','readwrite').add(c)).then(function(r) { notifySyncIfAvailable('contributions', c, 'put'); return r; }); }
  function getContribution(id)   { return reqToPromise(getStore('contributions','readonly').get(id)); }
  function getAllContributions()  { return reqToPromise(getStore('contributions','readonly').getAll()); }
  function updateContribution(c) { stampRecord(c); return reqToPromise(getStore('contributions','readwrite').put(c)).then(function(r) { notifySyncIfAvailable('contributions', c, 'put'); return r; }); }
  function deleteContribution(id){ return reqToPromise(getStore('contributions','readwrite').delete(id)).then(function(r) { notifySyncIfAvailable('contributions', {id:id}, 'delete'); return r; }); }
  function getContributionByMember(memberId) {
    return new Promise((resolve, reject) => {
      const req = getStore('contributions','readonly').index('memberId').get(memberId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(new Error(e.target.error?.message || 'DB error'));
    });
  }

  // ─── Payments ───
  function addPayment(p)    { stampRecord(p); return reqToPromise(getStore('payments','readwrite').add(p)).then(function(r) { notifySyncIfAvailable('payments', p, 'put'); return r; }); }
  function getPayment(id)   { return reqToPromise(getStore('payments','readonly').get(id)); }
  function getAllPayments()  { return reqToPromise(getStore('payments','readonly').getAll()); }
  function updatePayment(p) { stampRecord(p); return reqToPromise(getStore('payments','readwrite').put(p)).then(function(r) { notifySyncIfAvailable('payments', p, 'put'); return r; }); }
  function deletePayment(id){ return reqToPromise(getStore('payments','readwrite').delete(id)).then(function(r) { notifySyncIfAvailable('payments', {id:id}, 'delete'); return r; }); }
  function getPaymentsByMember(memberId) {
    return cursorCollect(getStore('payments','readonly'), 'memberId', IDBKeyRange.only(memberId));
  }
  function getPaymentsByDateRange(start, end) {
    return cursorCollect(getStore('payments','readonly'), 'date', IDBKeyRange.bound(start, end));
  }
  function deletePaymentsByMember(memberId) {
    return new Promise((resolve, reject) => {
      const req = getStore('payments','readwrite').index('memberId').openCursor(IDBKeyRange.only(memberId));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { var _id = cursor.value && cursor.value.id; cursor.delete(); if (_id) notifySyncIfAvailable('payments', {id:_id}, 'delete'); cursor.continue(); } else resolve();
      };
      req.onerror = (e) => reject(new Error(e.target.error?.message || 'Delete failed'));
    });
  }

  // ─── Expenses ───
  function addExpense(ex)    { stampRecord(ex); return reqToPromise(getStore('expenses','readwrite').add(ex)).then(function(r) { notifySyncIfAvailable('expenses', ex, 'put'); return r; }); }
  function getExpense(id)    { return reqToPromise(getStore('expenses','readonly').get(id)); }
  function getAllExpenses()   { return reqToPromise(getStore('expenses','readonly').getAll()); }
  function updateExpense(ex) { stampRecord(ex); return reqToPromise(getStore('expenses','readwrite').put(ex)).then(function(r) { notifySyncIfAvailable('expenses', ex, 'put'); return r; }); }
  function deleteExpense(id) { return reqToPromise(getStore('expenses','readwrite').delete(id)).then(function(r) { notifySyncIfAvailable('expenses', {id:id}, 'delete'); return r; }); }
  function getExpensesByDateRange(start, end) {
    return cursorCollect(getStore('expenses','readonly'), 'date', IDBKeyRange.bound(start, end));
  }

  // ─── Monthly Fee Records ───
  function addMonthlyFeeRecord(r)    { stampRecord(r); return reqToPromise(getStore('monthly_fee_records','readwrite').add(r)).then(function(res) { notifySyncIfAvailable('monthly_fee_records', r, 'put'); return res; }); }
  function getMonthlyFeeRecord(id)   { return reqToPromise(getStore('monthly_fee_records','readonly').get(id)); }
  function getAllMonthlyFeeRecords()  { return reqToPromise(getStore('monthly_fee_records','readonly').getAll()); }
  function updateMonthlyFeeRecord(r) { stampRecord(r); return reqToPromise(getStore('monthly_fee_records','readwrite').put(r)).then(function(res) { notifySyncIfAvailable('monthly_fee_records', r, 'put'); return res; }); }
  function deleteMonthlyFeeRecord(id){ return reqToPromise(getStore('monthly_fee_records','readwrite').delete(id)).then(function(res) { notifySyncIfAvailable('monthly_fee_records', {id:id}, 'delete'); return res; }); }
  function getMonthlyFeeRecordsByMember(memberId) {
    return cursorCollect(getStore('monthly_fee_records','readonly'), 'memberId', IDBKeyRange.only(memberId));
  }
  function getMonthlyFeeRecordsByDateRange(start, end) {
    return cursorCollect(getStore('monthly_fee_records','readonly'), 'date', IDBKeyRange.bound(start, end));
  }
  // Find existing record for same member+date (for overwrite logic)
  function getMonthlyFeeRecordByMemberDate(memberId, date) {
    return new Promise((resolve, reject) => {
      const req = getStore('monthly_fee_records','readonly').index('memberDate').get([memberId, date]);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror  = (e) => reject(new Error(e.target.error?.message || 'DB error'));
    });
  }
  function deleteMonthlyFeeRecordsByMember(memberId) {
    return new Promise((resolve, reject) => {
      const req = getStore('monthly_fee_records','readwrite').index('memberId').openCursor(IDBKeyRange.only(memberId));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { var _id = cursor.value && cursor.value.id; cursor.delete(); if (_id) notifySyncIfAvailable('monthly_fee_records', {id:_id}, 'delete'); cursor.continue(); } else resolve();
      };
      req.onerror = (e) => reject(new Error(e.target.error?.message || 'Delete failed'));
    });
  }

  // ─── Guest Sessions ───
  function addGuestSession(s)    { stampRecord(s); return reqToPromise(getStore('guest_sessions','readwrite').add(s)).then(function(r) { notifySyncIfAvailable('guest_sessions', s, 'put'); return r; }); }
  function getGuestSession(id)   { return reqToPromise(getStore('guest_sessions','readonly').get(id)); }
  function getAllGuestSessions()  { return reqToPromise(getStore('guest_sessions','readonly').getAll()); }
  function updateGuestSession(s) { stampRecord(s); return reqToPromise(getStore('guest_sessions','readwrite').put(s)).then(function(r) { notifySyncIfAvailable('guest_sessions', s, 'put'); return r; }); }
  function deleteGuestSession(id){ return reqToPromise(getStore('guest_sessions','readwrite').delete(id)).then(function(r) { notifySyncIfAvailable('guest_sessions', {id:id}, 'delete'); return r; }); }
  function getGuestSessionsByMember(memberId) {
    return cursorCollect(getStore('guest_sessions','readonly'), 'memberId', IDBKeyRange.only(memberId));
  }
  function getGuestSessionsByDate(date) {
    return cursorCollect(getStore('guest_sessions','readonly'), 'date', IDBKeyRange.only(date));
  }
  function deleteGuestSessionsByMember(memberId) {
    return new Promise((resolve, reject) => {
      const req = getStore('guest_sessions','readwrite').index('memberId').openCursor(IDBKeyRange.only(memberId));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { var _id = cursor.value && cursor.value.id; cursor.delete(); if (_id) notifySyncIfAvailable('guest_sessions', {id:_id}, 'delete'); cursor.continue(); } else resolve();
      };
      req.onerror = (e) => reject(new Error(e.target.error?.message || 'Delete failed'));
    });
  }

  // ─── Attendance ───
  function addAttendance(record)    { stampRecord(record); return reqToPromise(getStore('attendance','readwrite').add(record)).then(function(r) { notifySyncIfAvailable('attendance', record, 'put'); return r; }); }
  function getAttendance(id)        { return reqToPromise(getStore('attendance','readonly').get(id)); }
  function getAllAttendance()        { return reqToPromise(getStore('attendance','readonly').getAll()); }
  function updateAttendance(record)  { stampRecord(record); return reqToPromise(getStore('attendance','readwrite').put(record)).then(function(r) { notifySyncIfAvailable('attendance', record, 'put'); return r; }); }
  function deleteAttendance(id)      { return reqToPromise(getStore('attendance','readwrite').delete(id)).then(function(r) { notifySyncIfAvailable('attendance', {id:id}, 'delete'); return r; }); }
  function getAttendanceByMember(memberId) {
    return cursorCollect(getStore('attendance','readonly'), 'memberId', IDBKeyRange.only(memberId));
  }
  function getAttendanceByDate(date) {
    return cursorCollect(getStore('attendance','readonly'), 'date', IDBKeyRange.only(date));
  }
  function getAttendanceByMemberDate(memberId, date) {
    return new Promise((resolve, reject) => {
      const req = getStore('attendance','readonly').index('memberDate').get([memberId, date]);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(new Error(e.target.error?.message || 'DB error'));
    });
  }
  function getAttendanceByDateRange(startDate, endDate) {
    return cursorCollect(getStore('attendance','readonly'), 'date', IDBKeyRange.bound(startDate, endDate));
  }
  async function saveAttendance(memberId, date, status) {
    var existing = await getAttendanceByMemberDate(memberId, date);
    if (existing) {
      // Unchanged → no write, so a blanket Save doesn't bump versions or
      // overwrite another device's newer value for this member+date.
      if (existing.status === status) return existing.id;
      existing.status = status;
      return updateAttendance(existing);
    } else {
      // No row means "not present"; don't create 'absent' rows nobody asked for.
      if (status === 'absent') return null;
      // Deterministic id: two devices marking the same member+date converge on
      // ONE document instead of colliding on the unique memberDate index.
      var record = { id: memberId + '_' + date, memberId: memberId, date: date, status: status };
      return addAttendance(record);
    }
  }
  function deleteAttendanceByMember(memberId) {
    return new Promise((resolve, reject) => {
      const req = getStore('attendance','readwrite').index('memberId').openCursor(IDBKeyRange.only(memberId));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { var _id = cursor.value && cursor.value.id; cursor.delete(); if (_id) notifySyncIfAvailable('attendance', {id:_id}, 'delete'); cursor.continue(); } else resolve();
      };
      req.onerror = (e) => reject(new Error(e.target.error?.message || 'Delete failed'));
    });
  }

  // ─── Audit (append-only activity log) ───
  function addAuditRecord(a)        { stampRecord(a); return reqToPromise(getStore('audit','readwrite').add(a)).then(function(r) { notifySyncIfAvailable('audit', a, 'put'); return r; }); }
  function getAudit(id)             { return reqToPromise(getStore('audit','readonly').get(id)); }
  function getAllAuditRecords()      { return reqToPromise(getStore('audit','readonly').getAll()); }
  // Sync engine applies remote audit records via "update" — audit is append-only
  // so put() by id is a safe idempotent upsert.
  function updateAuditRecord(a)     { stampRecord(a); return reqToPromise(getStore('audit','readwrite').put(a)).then(function(r) { notifySyncIfAvailable('audit', a, 'put'); return r; }); }
  function deleteAuditRecord(id)    { return reqToPromise(getStore('audit','readwrite').delete(id)).then(function(r) { notifySyncIfAvailable('audit', {id:id}, 'delete'); return r; }); }
  function getAuditByDateRange(startDay, endDay) {
    // startDay/endDay are 'YYYY-MM-DD' day keys (inclusive).
    return cursorCollect(getStore('audit','readonly'), 'day', IDBKeyRange.bound(startDay, endDay));
  }

  // ─── Orphan cleanup ───
  // Removes child records whose memberId no longer matches any member. These
  // arise from pre-fix member deletions where cascade deletes weren't synced:
  // the member doc delete propagated but the child records survived in the DB
  // and got re-synced back, showing as "Unknown" in reports. The single-record
  // delete* functions used here ARE sync-aware, so these deletions propagate.
  async function cleanupOrphans() {
    try {
      var members = await getAllMembers();
      // No members at all = this device simply hasn't received them. Never treat
      // every child record as an orphan in that state.
      if (!members.length) return 0;
      var valid = {};
      members.forEach(function (m) { if (m && m.id) valid[m.id] = true; });

      var removed = 0;
      async function sweep(storeName, getAll, del) {
        var all = await getAll();
        for (var i = 0; i < all.length; i++) {
          var r = all[i];
          if (r && r.memberId && !valid[r.memberId]) {
            try { await deleteLocalOnly(storeName, del, r.id); removed++; } catch (e) {}
          }
        }
      }
      await sweep('payments',            getAllPayments,           deletePayment);
      await sweep('guest_sessions',      getAllGuestSessions,      deleteGuestSession);
      await sweep('monthly_fee_records', getAllMonthlyFeeRecords,  deleteMonthlyFeeRecord);
      await sweep('attendance',          getAllAttendance,         deleteAttendance);
      // Contributions are keyed per member too.
      var contribs = await getAllContributions();
      for (var j = 0; j < contribs.length; j++) {
        if (contribs[j] && contribs[j].memberId && !valid[contribs[j].memberId]) {
          try { await deleteLocalOnly('contributions', deleteContribution, contribs[j].id); removed++; } catch (e) {}
        }
      }
      if (removed > 0) console.log('DB: cleaned up ' + removed + ' orphaned record(s).');
      return removed;
    } catch (e) {
      console.error('DB: cleanupOrphans error', e);
      return 0;
    }
  }

  // ─── Cascade delete ───
  async function deleteMemberCascade(memberId) {
    await deletePaymentsByMember(memberId);
    await deleteGuestSessionsByMember(memberId);
    await deleteMonthlyFeeRecordsByMember(memberId);
    await deleteAttendanceByMember(memberId);
    const contrib = await getContributionByMember(memberId);
    if (contrib) await deleteContribution(contrib.id);
    await deleteMember(memberId);
  }

  // ─── Deduplicate monthly fee records (cleanup for existing data) ───
  // Keeps only the latest record (by createdAt) per member+date.
  async function deduplicateFeeRecords() {
    try {
      var allRecords = await getAllMonthlyFeeRecords();
      // Group by memberId+date
      var groups = {};
      allRecords.forEach(function (r) {
        var key = (r.memberId || '') + '_' + (r.date || '');
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
      });
      // For each group with >1 record, keep the latest, delete the rest
      var deleted = 0;
      for (var key in groups) {
        var recs = groups[key];
        if (recs.length <= 1) continue;
        // Sort by createdAt desc — keep first (latest)
        recs.sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
        for (var i = 1; i < recs.length; i++) {
          await deleteLocalOnly('monthly_fee_records', deleteMonthlyFeeRecord, recs[i].id);
          deleted++;
        }
      }
      if (deleted > 0) console.log('DB: Deduplicated ' + deleted + ' duplicate fee record(s).');
    } catch (e) {
      console.error('DB: deduplicateFeeRecords error', e);
    }
  }

  return {
    init, generateId, markSynced, markNoSync, deleteLocalOnly, mergeEdit, getMemberByName,
    addMember, getMember, getAllMembers, updateMember, deleteMember,
    addContribution, getContribution, getAllContributions, updateContribution,
    deleteContribution, getContributionByMember,
    addPayment, getPayment, getAllPayments, updatePayment, deletePayment,
    getPaymentsByMember, getPaymentsByDateRange, deletePaymentsByMember,
    addExpense, getExpense, getAllExpenses, updateExpense, deleteExpense, getExpensesByDateRange,
    addGuestSession, getGuestSession, getAllGuestSessions, updateGuestSession,
    deleteGuestSession, getGuestSessionsByMember, getGuestSessionsByDate,
    deleteGuestSessionsByMember,
    addMonthlyFeeRecord, getMonthlyFeeRecord, getAllMonthlyFeeRecords, updateMonthlyFeeRecord,
    deleteMonthlyFeeRecord, getMonthlyFeeRecordsByMember, getMonthlyFeeRecordsByDateRange,
    getMonthlyFeeRecordByMemberDate, deleteMonthlyFeeRecordsByMember,
    addAttendance, getAttendance, getAllAttendance, updateAttendance, deleteAttendance,
    getAttendanceByMember, getAttendanceByDate, getAttendanceByMemberDate,
    getAttendanceByDateRange, saveAttendance, deleteAttendanceByMember,
    addAuditRecord, getAudit, getAllAuditRecords, updateAuditRecord, deleteAuditRecord, getAuditByDateRange,
    deduplicateFeeRecords, cleanupOrphans,
    deleteMemberCascade
  };
})();
