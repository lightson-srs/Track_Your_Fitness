const DB = (function () {
  'use strict';
  const DB_NAME = 'TrackYourFitness';
  const DB_VERSION = 5;
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
  function notifySyncIfAvailable(storeName, record, opType) {
    if (typeof SyncEngine !== 'undefined' && SyncEngine.notifyChange) {
      try { SyncEngine.notifyChange(storeName, record, opType); } catch (e) {}
    }
  }

  // ─── Members ───
  function addMember(m)    { return reqToPromise(getStore('members','readwrite').add(m)).then(function(r) { notifySyncIfAvailable('members', m, 'put'); return r; }); }
  function getMember(id)   { return reqToPromise(getStore('members','readonly').get(id)); }
  function getAllMembers()  { return reqToPromise(getStore('members','readonly').getAll()); }
  function updateMember(m) { return reqToPromise(getStore('members','readwrite').put(m)).then(function(r) { notifySyncIfAvailable('members', m, 'put'); return r; }); }
  function deleteMember(id){ return reqToPromise(getStore('members','readwrite').delete(id)).then(function(r) { notifySyncIfAvailable('members', {id:id}, 'delete'); return r; }); }

  // ─── Contributions ───
  function addContribution(c)    { return reqToPromise(getStore('contributions','readwrite').add(c)).then(function(r) { notifySyncIfAvailable('contributions', c, 'put'); return r; }); }
  function getContribution(id)   { return reqToPromise(getStore('contributions','readonly').get(id)); }
  function getAllContributions()  { return reqToPromise(getStore('contributions','readonly').getAll()); }
  function updateContribution(c) { return reqToPromise(getStore('contributions','readwrite').put(c)).then(function(r) { notifySyncIfAvailable('contributions', c, 'put'); return r; }); }
  function deleteContribution(id){ return reqToPromise(getStore('contributions','readwrite').delete(id)).then(function(r) { notifySyncIfAvailable('contributions', {id:id}, 'delete'); return r; }); }
  function getContributionByMember(memberId) {
    return new Promise((resolve, reject) => {
      const req = getStore('contributions','readonly').index('memberId').get(memberId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(new Error(e.target.error?.message || 'DB error'));
    });
  }

  // ─── Payments ───
  function addPayment(p)    { return reqToPromise(getStore('payments','readwrite').add(p)).then(function(r) { notifySyncIfAvailable('payments', p, 'put'); return r; }); }
  function getPayment(id)   { return reqToPromise(getStore('payments','readonly').get(id)); }
  function getAllPayments()  { return reqToPromise(getStore('payments','readonly').getAll()); }
  function updatePayment(p) { return reqToPromise(getStore('payments','readwrite').put(p)).then(function(r) { notifySyncIfAvailable('payments', p, 'put'); return r; }); }
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
        if (cursor) { cursor.delete(); cursor.continue(); } else resolve();
      };
      req.onerror = (e) => reject(new Error(e.target.error?.message || 'Delete failed'));
    });
  }

  // ─── Expenses ───
  function addExpense(ex)    { return reqToPromise(getStore('expenses','readwrite').add(ex)).then(function(r) { notifySyncIfAvailable('expenses', ex, 'put'); return r; }); }
  function getExpense(id)    { return reqToPromise(getStore('expenses','readonly').get(id)); }
  function getAllExpenses()   { return reqToPromise(getStore('expenses','readonly').getAll()); }
  function updateExpense(ex) { return reqToPromise(getStore('expenses','readwrite').put(ex)).then(function(r) { notifySyncIfAvailable('expenses', ex, 'put'); return r; }); }
  function deleteExpense(id) { return reqToPromise(getStore('expenses','readwrite').delete(id)).then(function(r) { notifySyncIfAvailable('expenses', {id:id}, 'delete'); return r; }); }
  function getExpensesByDateRange(start, end) {
    return cursorCollect(getStore('expenses','readonly'), 'date', IDBKeyRange.bound(start, end));
  }

  // ─── Monthly Fee Records ───
  function addMonthlyFeeRecord(r)    { return reqToPromise(getStore('monthly_fee_records','readwrite').add(r)).then(function(res) { notifySyncIfAvailable('monthly_fee_records', r, 'put'); return res; }); }
  function getMonthlyFeeRecord(id)   { return reqToPromise(getStore('monthly_fee_records','readonly').get(id)); }
  function getAllMonthlyFeeRecords()  { return reqToPromise(getStore('monthly_fee_records','readonly').getAll()); }
  function updateMonthlyFeeRecord(r) { return reqToPromise(getStore('monthly_fee_records','readwrite').put(r)).then(function(res) { notifySyncIfAvailable('monthly_fee_records', r, 'put'); return res; }); }
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
        if (cursor) { cursor.delete(); cursor.continue(); } else resolve();
      };
      req.onerror = (e) => reject(new Error(e.target.error?.message || 'Delete failed'));
    });
  }

  // ─── Guest Sessions ───
  function addGuestSession(s)    { return reqToPromise(getStore('guest_sessions','readwrite').add(s)).then(function(r) { notifySyncIfAvailable('guest_sessions', s, 'put'); return r; }); }
  function getGuestSession(id)   { return reqToPromise(getStore('guest_sessions','readonly').get(id)); }
  function getAllGuestSessions()  { return reqToPromise(getStore('guest_sessions','readonly').getAll()); }
  function updateGuestSession(s) { return reqToPromise(getStore('guest_sessions','readwrite').put(s)).then(function(r) { notifySyncIfAvailable('guest_sessions', s, 'put'); return r; }); }
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
        if (cursor) { cursor.delete(); cursor.continue(); } else resolve();
      };
      req.onerror = (e) => reject(new Error(e.target.error?.message || 'Delete failed'));
    });
  }

  // ─── Cascade delete ───
  async function deleteMemberCascade(memberId) {
    await deletePaymentsByMember(memberId);
    await deleteGuestSessionsByMember(memberId);
    await deleteMonthlyFeeRecordsByMember(memberId);
    const contrib = await getContributionByMember(memberId);
    if (contrib) await deleteContribution(contrib.id);
    await deleteMember(memberId);
  }

  return {
    init, generateId,
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
    deleteMemberCascade
  };
})();
