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

    var upiVal = upiIdInput ? upiIdInput.value.trim() : '';
    if (!upiVal)            { if (errorEl) errorEl.textContent = 'UPI ID is required.'; return; }
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

    // Populate fields
    populateSyncFields();

    // Reflect current sync-enabled state on the toggle every time.
    if (syncToggle) syncToggle.checked = FirestoreConfig.isSyncEnabled();

    // Bind listeners once only.
    if (!_syncSettingsBound) {
      if (syncToggle)  syncToggle.addEventListener('change', handleSyncToggle);
      if (syncSaveBtn) syncSaveBtn.addEventListener('click', handleSyncSave);
      if (syncTestBtn) syncTestBtn.addEventListener('click', handleSyncTest);
      _syncSettingsBound = true;
    }

    // Update status display
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
  function handleSyncToggle() {
    var syncToggle = document.getElementById('sync-toggle');
    if (!syncToggle) return;

    var enabled = syncToggle.checked;
    FirestoreConfig.setSyncEnabled(enabled);

    if (enabled) {
      // Reinitialize sync if SyncEngine is available
      if (typeof SyncEngine !== 'undefined' && SyncEngine.init) {
        try { SyncEngine.init(); } catch (e) {}
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

    var fields = gatherSyncFields();

    // Validate before attempting a connection.
    var result = FirestoreConfig.validate(fields.config, fields.collectionName);
    if (!result.valid) {
      if (errorEl) errorEl.textContent = result.errors.join(' ');
      return;
    }

    if (typeof SyncEngine === 'undefined' || !SyncEngine.testConnection) {
      if (errorEl) errorEl.textContent = 'Sync engine unavailable.';
      return;
    }

    // Show in-progress state.
    if (testBtn) { testBtn.disabled = true; testBtn.textContent = 'Testing…'; }
    if (resultEl) {
      resultEl.className = 'sync-test-result sync-test-pending';
      resultEl.textContent = 'Connecting to Firestore…';
      resultEl.removeAttribute('hidden');
    }

    var res;
    try {
      res = await SyncEngine.testConnection(fields.config, fields.collectionName);
    } catch (err) {
      res = { ok: false, message: (err && err.message) ? err.message : 'Connection test failed.' };
    }

    if (testBtn) { testBtn.disabled = false; testBtn.textContent = 'Test connection'; }
    if (resultEl) {
      resultEl.className = 'sync-test-result ' + (res.ok ? 'sync-test-ok' : 'sync-test-fail');
      resultEl.textContent = (res.ok ? '✅ ' : '❌ ') + res.message;
      resultEl.removeAttribute('hidden');
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
    initSyncSettings, updateSyncStatus
  };
})();
