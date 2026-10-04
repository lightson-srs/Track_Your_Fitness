const Settings = (function () {
  'use strict';
  const KEYS = {
    APP_NAME:          'tyf_app_name',
    UPI_ID:            'tyf_upi_id',
    THEME:             'tyf_theme',
    BACKUP_FREQ:       'tyf_backup_freq',
    LAST_BACKUP:       'tyf_last_backup',
    DEFAULT_GUEST_FEE: 'tyf_default_guest_fee'
  };
  const DEFAULTS = {
    APP_NAME:          'Track Your Fitness',
    THEME:             'dark',  // 'dark' | 'light' | 'forest' | 'sunset'
    BACKUP_FREQ:       7,
    DEFAULT_GUEST_FEE: 50
  };

  function get(key, def) {
    try { var v = localStorage.getItem(key); return (v !== null && v !== '') ? v : def; }
    catch (e) { return def; }
  }
  function set(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }

  // ═══ Activity log (Cloud Sync) ═══════════════════════════════
  // Mirrors the Lights On project: a small, persisted, newest-first log of the
  // last 40 sync/test-connection activities, rendered into #sync-log-list.
  var LOG_KEY = 'tyf_sync_log';
  var LOG_MAX = 40;

  function _loadLog() {
    try { var raw = localStorage.getItem(LOG_KEY); return raw ? JSON.parse(raw) : []; }
    catch (e) { return []; }
  }
  function _saveLog(arr) {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  // status: 'ok' | 'err'. msg: short description.
  function logActivity(status, msg) {
    var now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var arr = _loadLog();
    arr.unshift({ time: now, msg: String(msg), status: (status === 'ok' ? 'ok' : 'err') });
    if (arr.length > LOG_MAX) arr = arr.slice(0, LOG_MAX);
    _saveLog(arr);
    renderLog();
    // Mirror to console for deeper debugging.
    try { console.log('[SYNC-LOG]', status, msg); } catch (e) {}
  }

  function clearLog() {
    _saveLog([]);
    renderLog();
  }

  function esc(s) {
    return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
  }

  function renderLog() {
    var el = document.getElementById('sync-log-list');
    if (!el) return;
    var arr = _loadLog();
    if (!arr.length) { el.innerHTML = '<div class="log-empty">No activity yet</div>'; return; }
    el.innerHTML = arr.map(function (l) {
      return '<div class="log-entry">' +
        '<span class="log-time">' + esc(l.time) + '</span>' +
        '<span class="log-cmd">' + esc(l.msg) + '</span>' +
        '<span class="log-status ' + (l.status === 'ok' ? 'ok' : 'err') + '">' + (l.status === 'ok' ? '✓' : '✗') + '</span>' +
        '</div>';
    }).join('');
  }

  // ─── Sync conflicts (optimistic concurrency: reject-and-flag) ───
  var _storeLabels = {
    members: 'Member', contributions: 'Contribution', payments: 'Payment',
    expenses: 'Expense', guest_sessions: 'Guest', monthly_fee_records: 'Fee record',
    attendance: 'Attendance'
  };

  function renderConflicts() {
    var wrap = document.getElementById('sync-conflicts-wrap');
    var list = document.getElementById('sync-conflicts-list');
    if (!wrap || !list) return;
    var conflicts = (typeof SyncEngine !== 'undefined' && SyncEngine.getConflicts) ? SyncEngine.getConflicts() : [];
    if (!conflicts.length) { wrap.setAttribute('hidden', ''); list.innerHTML = ''; return; }
    wrap.removeAttribute('hidden');
    list.innerHTML = conflicts.map(function (c) {
      var label = _storeLabels[c.store] || c.store;
      var when = c.at ? new Date(c.at).toLocaleString() : '';
      return '<div class="sync-conflict-entry"><strong>' + esc(label) + '</strong> ' +
        esc((c.docId || '').slice(0, 8)) + '… — ' + esc(c.reason || 'changed on another device') +
        (when ? ' <span class="loan-notes">(' + esc(when) + ')</span>' : '') + '</div>';
    }).join('');
  }

  function getAppName()            { return get(KEYS.APP_NAME, DEFAULTS.APP_NAME); }
  function setAppName(v)           { set(KEYS.APP_NAME, (v || '').trim() || DEFAULTS.APP_NAME); }
  function getUpiId()              { return get(KEYS.UPI_ID, ''); }
  function setUpiId(v)             { set(KEYS.UPI_ID, (v || '').trim()); }
  function getTheme()              { return get(KEYS.THEME, DEFAULTS.THEME); }
  function setTheme(v)             { set(KEYS.THEME, v); applyTheme(v); }
  function getBackupFrequency()    { return parseInt(get(KEYS.BACKUP_FREQ, DEFAULTS.BACKUP_FREQ), 10) || 0; }
  function setBackupFrequency(v)   { set(KEYS.BACKUP_FREQ, String(v)); }
  function getLastBackup()         { return get(KEYS.LAST_BACKUP, ''); }
  function setLastBackup(v)        { set(KEYS.LAST_BACKUP, v); }
  function getDefaultGuestFee()    { return parseFloat(get(KEYS.DEFAULT_GUEST_FEE, DEFAULTS.DEFAULT_GUEST_FEE)) || 50; }
  function setDefaultGuestFee(v)   { set(KEYS.DEFAULT_GUEST_FEE, String(parseFloat(v) || 50)); }

  var _themeColors = {
    dark:   '#1e1e1e',
    light:  '#1565c0',
    forest: '#1b5e3a',
    sunset: '#b85e0e'
  };

  function applyTheme(theme) {
    if (!theme) theme = getTheme();
    if (theme === 'dark') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', _themeColors[theme] || '#1e1e1e');
  }

  function getAllSettings() {
    var result = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.startsWith('tyf_')) result[key] = localStorage.getItem(key);
      }
    } catch (e) {}
    return result;
  }

  function restoreSettings(obj) {
    if (!obj) return;
    for (var key in obj) {
      if (obj.hasOwnProperty(key)) { try { localStorage.setItem(key, obj[key]); } catch (e) {} }
    }
  }

  function init() {
    applyTheme();
    var appNameInput    = document.getElementById('settings-app-name');
    var upiIdInput      = document.getElementById('settings-upi-id');
    var guestFeeInput   = document.getElementById('settings-default-guest-fee');
    var themeToggle     = document.getElementById('theme-toggle');
    var freqSelect      = document.getElementById('backup-frequency');
    var saveBtn         = document.getElementById('settings-save-btn');

    if (appNameInput)  appNameInput.value  = getAppName();
    if (upiIdInput)    upiIdInput.value    = getUpiId();
    if (guestFeeInput) guestFeeInput.value = getDefaultGuestFee();
    // themeToggle is now a <select> with id="theme-select"
    var themeSelect = document.getElementById('theme-select');
    if (themeSelect) {
      themeSelect.value = getTheme();
      themeSelect.addEventListener('change', function () { setTheme(themeSelect.value); });
    }
    // keep legacy toggle support if it exists
    if (themeToggle) {
      themeToggle.checked = getTheme() === 'dark';
      themeToggle.addEventListener('change', function () { setTheme(themeToggle.checked ? 'dark' : 'light'); });
    }
    if (freqSelect) {
      freqSelect.value = String(getBackupFrequency());
      freqSelect.addEventListener('change', function () { setBackupFrequency(parseInt(freqSelect.value, 10)); });
    }
    if (saveBtn) saveBtn.addEventListener('click', function (e) { e.preventDefault(); save(); });
    updateAppNameDisplay();

    // Initialize Cloud Sync settings
    initSyncSettings();
  }

  function save() {
    var appNameInput  = document.getElementById('settings-app-name');
    var upiIdInput    = document.getElementById('settings-upi-id');
    var guestFeeInput = document.getElementById('settings-default-guest-fee');
    var errorEl       = document.getElementById('settings-error');
    var msgEl         = document.getElementById('settings-save-msg');
    if (errorEl) errorEl.textContent = '';

    // UPI ID is optional. Payment QR codes just won't be shown if it's blank.
    var upiVal = upiIdInput ? upiIdInput.value.trim() : '';
    if (upiVal.length > 45) { if (errorEl) errorEl.textContent = 'UPI ID must be 45 characters or less.'; return; }

    var appVal = appNameInput ? appNameInput.value.trim() : '';
    if (appVal.length > 50) { if (errorEl) errorEl.textContent = 'App name must be 50 characters or less.'; return; }

    var guestFeeVal = parseFloat(guestFeeInput ? guestFeeInput.value : 50) || 50;
    if (guestFeeVal <= 0)   { if (errorEl) errorEl.textContent = 'Default guest fee must be greater than zero.'; return; }
    var guestFeeLimit = typeof License !== 'undefined' ? License.checkGuestFee(guestFeeVal) : null;
    if (guestFeeLimit) { if (errorEl) errorEl.textContent = guestFeeLimit; return; }

    setAppName(appVal);
    setUpiId(upiVal);
    setDefaultGuestFee(guestFeeVal);
    updateAppNameDisplay();

    if (msgEl) { msgEl.removeAttribute('hidden'); setTimeout(function () { msgEl.setAttribute('hidden', ''); }, 3000); }
  }

  function updateAppNameDisplay() {
    var header = document.getElementById('app-name-header');
    if (header) header.textContent = getAppName();
    document.title = getAppName();
  }

  // ═══ Cloud Sync Settings ═══════════════════════════════

  var _previousCollectionName = null;
  var _syncSettingsBound = false;

  /**
   * Initialize Cloud Sync settings section.
   * Populates fields from FirestoreConfig and binds event listeners.
   * Safe to call again (e.g. after a restore) — listeners bind only once.
   */
  function initSyncSettings() {
    if (typeof FirestoreConfig === 'undefined') return;

    var syncToggle = document.getElementById('sync-toggle');
    var syncSaveBtn = document.getElementById('sync-settings-save-btn');
    var syncTestBtn = document.getElementById('sync-test-btn');
    var syncFullBtn = document.getElementById('sync-fullsync-btn');
    var syncLogClear = document.getElementById('sync-log-clear');
    var syncConflictsClear = document.getElementById('sync-conflicts-clear');

    // Populate fields
    populateSyncFields();

    // Reflect current sync-enabled state on the toggle every time.
    if (syncToggle) syncToggle.checked = FirestoreConfig.isSyncEnabled();

    // Bind listeners once only.
    if (!_syncSettingsBound) {
      if (syncToggle)  syncToggle.addEventListener('change', handleSyncToggle);
      if (syncSaveBtn) syncSaveBtn.addEventListener('click', handleSyncSave);
      if (syncTestBtn) syncTestBtn.addEventListener('click', handleSyncTest);
      if (syncFullBtn) syncFullBtn.addEventListener('click', handleFullSync);
      if (syncLogClear) syncLogClear.addEventListener('click', clearLog);
      if (syncConflictsClear && typeof SyncEngine !== 'undefined' && SyncEngine.clearConflicts) {
        syncConflictsClear.addEventListener('click', function () { SyncEngine.clearConflicts(); renderConflicts(); });
      }
      // Keep the conflict panel live as conflicts are flagged during sync.
      document.addEventListener('tyf-sync-conflict', renderConflicts);
      // Refresh the sync status whenever a sync/connect completes, so the label
      // reflects the real connected/disconnected outcome (not a stale pre-connect read).
      document.addEventListener('tyf-sync-update', updateSyncStatus);
      _syncSettingsBound = true;
    }

    // Render the activity log, conflicts, and update status display.
    renderLog();
    renderConflicts();
    updateSyncStatus();
  }

  /**
   * Populate the Cloud Sync settings fields with stored values.
   */
  function populateSyncFields() {
    var config = FirestoreConfig.getConfig();
    var collectionName = FirestoreConfig.getCollectionName();

    _previousCollectionName = collectionName;

    var collEl = document.getElementById('settings-collection-name');
    var apiKeyEl = document.getElementById('settings-fs-api-key');
    var projectIdEl = document.getElementById('settings-fs-project-id');
    var appIdEl = document.getElementById('settings-fs-app-id');
    var authDomainEl = document.getElementById('settings-fs-auth-domain');
    var storageBucketEl = document.getElementById('settings-fs-storage-bucket');
    var senderIdEl = document.getElementById('settings-fs-sender-id');

    if (collEl) collEl.value = collectionName || '';
    if (config) {
      if (apiKeyEl) apiKeyEl.value = config.apiKey || '';
      if (projectIdEl) projectIdEl.value = config.projectId || '';
      if (appIdEl) appIdEl.value = config.appId || '';
      if (authDomainEl) authDomainEl.value = config.authDomain || '';
      if (storageBucketEl) storageBucketEl.value = config.storageBucket || '';
      if (senderIdEl) senderIdEl.value = config.messagingSenderId || '';
    }
  }

  /**
   * Handle the sync enable/disable toggle.
   * Enables or disables sync without deleting the stored config.
   */
  async function handleSyncToggle() {
    var syncToggle = document.getElementById('sync-toggle');
    if (!syncToggle) return;

    var enabled = syncToggle.checked;
    FirestoreConfig.setSyncEnabled(enabled);

    if (enabled) {
      // Show a transient "Connecting…" while the async init/connect runs, then
      // refresh the status with the REAL outcome. Reading status synchronously
      // right after init() is wrong — init() loads the SDK and connects async,
      // so the status would be read before it finishes (shows "Disconnected").
      _setSyncStatusText('Connecting…');
      if (typeof SyncEngine !== 'undefined' && SyncEngine.init) {
        try { await SyncEngine.init(); } catch (e) {}
      }
    } else {
      // Disconnect sync
      if (typeof SyncEngine !== 'undefined' && SyncEngine.disconnect) {
        try { SyncEngine.disconnect(); } catch (e) {}
      }
    }

    updateSyncStatus();
  }

  /**
   * Handle the Save sync settings button.
   * Validates, stores config, and reinitializes SyncEngine.
   */
  /**
   * Read the current values from the Cloud Sync form fields.
   * Returns { collectionName, config }.
   */
  function gatherSyncFields() {
    function val(id) { var el = document.getElementById(id); return el ? (el.value || '').trim() : ''; }
    return {
      collectionName: val('settings-collection-name'),
      config: {
        apiKey:            val('settings-fs-api-key'),
        projectId:         val('settings-fs-project-id'),
        appId:             val('settings-fs-app-id'),
        authDomain:        val('settings-fs-auth-domain'),
        storageBucket:     val('settings-fs-storage-bucket'),
        messagingSenderId: val('settings-fs-sender-id')
      }
    };
  }

  /**
   * Handle the Test connection button.
   * Validates entered fields, connects with a throwaway Firebase app,
   * and reports pass/fail — without saving or disturbing the live connection.
   */
  async function handleSyncTest(e) {
    if (e) e.preventDefault();

    var testBtn  = document.getElementById('sync-test-btn');
    var errorEl  = document.getElementById('sync-settings-error');
    var resultEl = document.getElementById('sync-test-result');
    if (errorEl) errorEl.textContent = '';

    logActivity('ok', 'Test connection: clicked');

    var fields = gatherSyncFields();
    logActivity('ok', 'Config read: collection="' + (fields.collectionName || '(empty)') +
      '", project="' + (fields.config.projectId || '(empty)') + '"');

    // Validate before attempting a connection.
    var result = FirestoreConfig.validate(fields.config, fields.collectionName);
    if (!result.valid) {
      if (errorEl) errorEl.textContent = result.errors.join(' ');
      logActivity('err', 'Validation failed: ' + result.errors.join(' '));
      return;
    }

    if (typeof SyncEngine === 'undefined' || !SyncEngine.testConnection) {
      if (errorEl) errorEl.textContent = 'Sync engine unavailable.';
      logActivity('err', 'SyncEngine unavailable (script not loaded?)');
      return;
    }

    // Show in-progress state.
    if (testBtn) { testBtn.disabled = true; testBtn.textContent = 'Testing…'; }
    if (resultEl) {
      resultEl.className = 'sync-test-result sync-test-pending';
      resultEl.textContent = 'Connecting to Firestore…';
      resultEl.removeAttribute('hidden');
    }
    logActivity('ok', 'Connecting to Firestore (loading SDK)…');

    var res;
    try {
      // Guard against a hung connection (e.g. SDK CDN blocked / offline) so the
      // UI never gets stuck on "Testing…" with no result.
      var timeoutMs = 20000;
      var timeoutPromise = new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error('Timed out after ' + (timeoutMs / 1000) + 's. Check your internet connection and Firebase config.'));
        }, timeoutMs);
      });
      res = await Promise.race([
        SyncEngine.testConnection(fields.config, fields.collectionName),
        timeoutPromise
      ]);
    } catch (err) {
      res = { ok: false, message: (err && err.message) ? err.message : 'Connection test failed.' };
    }

    if (testBtn) { testBtn.disabled = false; testBtn.textContent = 'Test connection'; }
    if (resultEl) {
      resultEl.className = 'sync-test-result ' + (res.ok ? 'sync-test-ok' : 'sync-test-fail');
      resultEl.textContent = (res.ok ? '✅ ' : '❌ ') + res.message;
      resultEl.removeAttribute('hidden');
    }
    logActivity(res.ok ? 'ok' : 'err', 'Result: ' + res.message);
  }

  /**
   * Handle the "Full sync from DB" button — an explicit authoritative sync:
   * push dirty local changes, then pull everything from Firestore.
   */
  async function handleFullSync(e) {
    if (e) e.preventDefault();

    var fullBtn = document.getElementById('sync-fullsync-btn');
    var errorEl = document.getElementById('sync-settings-error');
    if (errorEl) errorEl.textContent = '';

    if (!FirestoreConfig.isSyncEnabled() || !FirestoreConfig.hasConfig()) {
      if (errorEl) errorEl.textContent = 'Enable cloud sync and save your Firebase settings first.';
      logActivity('err', 'Full sync: sync not enabled / config missing');
      return;
    }
    if (typeof SyncEngine === 'undefined' || !SyncEngine.fullSync) {
      if (errorEl) errorEl.textContent = 'Sync engine unavailable.';
      logActivity('err', 'Full sync: SyncEngine unavailable');
      return;
    }

    var originalText = fullBtn ? fullBtn.textContent : '';
    if (fullBtn) { fullBtn.disabled = true; fullBtn.textContent = 'Syncing…'; }
    logActivity('ok', 'Full sync from DB: requested');

    var ok = false;
    try {
      ok = await SyncEngine.fullSync();
    } catch (err) {
      logActivity('err', 'Full sync error: ' + ((err && err.message) ? err.message : 'unknown'));
    }

    if (fullBtn) { fullBtn.disabled = false; fullBtn.textContent = originalText || '⬇️ Full sync from DB'; }
    updateSyncStatus();
    if (!ok && errorEl && !errorEl.textContent) {
      errorEl.textContent = 'Full sync did not complete. See the activity log.';
    }
  }

  function handleSyncSave(e) {
    if (e) e.preventDefault();

    var errorEl = document.getElementById('sync-settings-error');
    var msgEl = document.getElementById('sync-settings-save-msg');
    if (errorEl) errorEl.textContent = '';

    // Gather values
    var fields = gatherSyncFields();
    var collectionName = fields.collectionName;
    var configObj = fields.config;

    // Validate
    var result = FirestoreConfig.validate(configObj, collectionName);
    if (!result.valid) {
      if (errorEl) errorEl.textContent = result.errors.join(' ');
      return;
    }

    // Check if collection name changed — confirm with user
    if (_previousCollectionName && _previousCollectionName !== collectionName) {
      var confirmed = confirm(
        'Changing the collection name will switch to a different data set. ' +
        'Local data will not be migrated to the new collection. Continue?'
      );
      if (!confirmed) return;
    }

    // Store config
    FirestoreConfig.setConfig(configObj);
    FirestoreConfig.setCollectionName(collectionName);
    _previousCollectionName = collectionName;

    // Reinitialize SyncEngine with new config
    if (typeof SyncEngine !== 'undefined' && SyncEngine.reinitialize) {
      try { SyncEngine.reinitialize(); } catch (e) {}
    }

    updateSyncStatus();

    // Show success message
    if (msgEl) {
      msgEl.removeAttribute('hidden');
      setTimeout(function () { msgEl.setAttribute('hidden', ''); }, 3000);
    }
  }

  /**
   * Update the sync status display text.
   * Checks SyncEngine.getStatus() if available.
   */
  function _setSyncStatusText(text) {
    var statusEl = document.getElementById('sync-status-text');
    if (statusEl) statusEl.textContent = text;
  }

  function updateSyncStatus() {
    var statusEl = document.getElementById('sync-status-text');
    if (!statusEl) return;

    var status = 'Disabled';
    if (typeof FirestoreConfig !== 'undefined' && FirestoreConfig.isSyncEnabled()) {
      if (typeof SyncEngine !== 'undefined' && SyncEngine.getStatus) {
        try {
          status = SyncEngine.getStatus();
          // Capitalize first letter
          status = status.charAt(0).toUpperCase() + status.slice(1);
        } catch (e) {
          status = 'Disconnected';
        }
      } else {
        status = 'Disconnected';
      }
    }

    statusEl.textContent = status;
  }

  return {
    init, save,
    getAppName, setAppName,
    getUpiId, setUpiId,
    getTheme, setTheme,
    getBackupFrequency, setBackupFrequency,
    getLastBackup, setLastBackup,
    getDefaultGuestFee, setDefaultGuestFee,
    applyTheme, updateAppNameDisplay,
    getAllSettings, restoreSettings,
    initSyncSettings, updateSyncStatus,
    logActivity, renderLog, clearLog
  };
})();
