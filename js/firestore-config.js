const FirestoreConfig = (function () {
  'use strict';

  const PREFIX = 'tyf_firestore_';
  const FIELDS = ['apiKey', 'authDomain', 'projectId', 'storageBucket',
                  'messagingSenderId', 'appId'];
  const MANDATORY_FIELDS = ['apiKey', 'projectId', 'appId'];
  const COLLECTION_KEY = PREFIX + 'collection';
  const SYNC_ENABLED_KEY = PREFIX + 'sync_enabled';
  const WIZARD_SKIPPED_KEY = PREFIX + 'wizard_skipped';

  const COLLECTION_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;

  // --- localStorage helpers ---

  function _get(key) {
    try {
      var v = localStorage.getItem(key);
      return (v !== null && v !== '') ? v : null;
    } catch (e) { return null; }
  }

  function _set(key, val) {
    try { localStorage.setItem(key, val); } catch (e) {}
  }

  function _remove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  // --- Public API ---

  /**
   * Retrieve the stored Firestore config object.
   * Returns null if no mandatory fields are present.
   */
  function getConfig() {
    var config = {};
    var hasAny = false;
    for (var i = 0; i < FIELDS.length; i++) {
      var val = _get(PREFIX + FIELDS[i]);
      if (val) {
        config[FIELDS[i]] = val;
        hasAny = true;
      } else {
        config[FIELDS[i]] = '';
      }
    }
    return hasAny ? config : null;
  }

  /**
   * Store a Firestore config object to localStorage.
   * Only known FIELDS are persisted.
   */
  function setConfig(configObj) {
    if (!configObj) return;
    for (var i = 0; i < FIELDS.length; i++) {
      var field = FIELDS[i];
      var val = configObj[field];
      if (val !== undefined && val !== null && val !== '') {
        _set(PREFIX + field, String(val));
      } else {
        _remove(PREFIX + field);
      }
    }
  }

  /**
   * Get the stored collection name.
   * Returns the collection name string or null if not set.
   */
  function getCollectionName() {
    return _get(COLLECTION_KEY);
  }

  /**
   * Store the collection name.
   */
  function setCollectionName(name) {
    if (name !== undefined && name !== null && name !== '') {
      _set(COLLECTION_KEY, String(name));
    } else {
      _remove(COLLECTION_KEY);
    }
  }

  /**
   * Check whether sync is enabled.
   */
  function isSyncEnabled() {
    return _get(SYNC_ENABLED_KEY) === 'true';
  }

  /**
   * Enable or disable sync.
   */
  function setSyncEnabled(bool) {
    _set(SYNC_ENABLED_KEY, bool ? 'true' : 'false');
  }

  /**
   * Check if the setup wizard was previously skipped.
   */
  function isWizardSkipped() {
    return _get(WIZARD_SKIPPED_KEY) === 'true';
  }

  /**
   * Set the wizard-skipped flag.
   */
  function setWizardSkipped(bool) {
    _set(WIZARD_SKIPPED_KEY, bool ? 'true' : 'false');
  }

  /**
   * Returns true if all mandatory config fields are present in localStorage.
   */
  function hasConfig() {
    for (var i = 0; i < MANDATORY_FIELDS.length; i++) {
      if (!_get(PREFIX + MANDATORY_FIELDS[i])) return false;
    }
    return true;
  }

  /**
   * Validate a config object and collection name.
   * Returns { valid: boolean, errors: string[] }
   */
  function validate(configObj, collectionName) {
    var errors = [];

    // Validate collection name
    if (collectionName === undefined || collectionName === null || collectionName === '') {
      errors.push('Collection name is required.');
    } else if (!COLLECTION_REGEX.test(String(collectionName))) {
      errors.push('Collection name must be 1–50 characters: letters, numbers, hyphens, underscores.');
    }

    // Validate mandatory fields
    if (!configObj || typeof configObj !== 'object') {
      errors.push('Configuration object is required.');
    } else {
      for (var i = 0; i < MANDATORY_FIELDS.length; i++) {
        var field = MANDATORY_FIELDS[i];
        var val = configObj[field];
        if (val === undefined || val === null || String(val).trim() === '') {
          errors.push(field + ' is required.');
        }
      }
    }

    return { valid: errors.length === 0, errors: errors };
  }

  /**
   * Remove all Firestore-related keys from localStorage.
   */
  function clear() {
    // Remove known field keys
    for (var i = 0; i < FIELDS.length; i++) {
      _remove(PREFIX + FIELDS[i]);
    }
    _remove(COLLECTION_KEY);
    _remove(SYNC_ENABLED_KEY);
    _remove(WIZARD_SKIPPED_KEY);
  }

  return {
    getConfig: getConfig,
    setConfig: setConfig,
    getCollectionName: getCollectionName,
    setCollectionName: setCollectionName,
    isSyncEnabled: isSyncEnabled,
    setSyncEnabled: setSyncEnabled,
    isWizardSkipped: isWizardSkipped,
    setWizardSkipped: setWizardSkipped,
    hasConfig: hasConfig,
    validate: validate,
    clear: clear
  };
})();
