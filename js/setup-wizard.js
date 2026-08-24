/**
 * SetupWizard Module
 * Manages the first-launch Firestore configuration wizard.
 */
const SetupWizard = (function () {
  'use strict';

  var modalEl = null;
  var errorEl = null;

  /**
   * Check if wizard should display and show it if needed.
   * Launch condition: no config AND wizard not previously skipped.
   */
  function init() {
    modalEl = document.getElementById('setup-wizard-modal');
    errorEl = document.getElementById('wizard-error');
    if (!modalEl) return;

    // Bind event listeners
    var saveBtn = document.getElementById('wizard-save-btn');
    var skipBtn = document.getElementById('wizard-skip-btn');
    if (saveBtn) saveBtn.addEventListener('click', handleSubmit);
    if (skipBtn) skipBtn.addEventListener('click', handleSkip);

    // Check launch condition
    if (typeof FirestoreConfig !== 'undefined' &&
        !FirestoreConfig.hasConfig() &&
        !FirestoreConfig.isWizardSkipped()) {
      show();
    }
  }

  /**
   * Display the setup wizard modal.
   */
  function show() {
    if (modalEl) {
      modalEl.removeAttribute('hidden');
    }
  }

  /**
   * Dismiss the setup wizard modal.
   */
  function hide() {
    if (modalEl) {
      modalEl.setAttribute('hidden', '');
    }
    if (errorEl) {
      errorEl.textContent = '';
    }
  }

  /**
   * Handle the Connect button click.
   * Validates input, stores config, enables sync, and dismisses.
   */
  function handleSubmit(e) {
    if (e) e.preventDefault();
    if (errorEl) errorEl.textContent = '';

    // Gather field values
    var collectionName = (document.getElementById('wizard-collection-name').value || '').trim();
    var apiKey = (document.getElementById('wizard-api-key').value || '').trim();
    var projectId = (document.getElementById('wizard-project-id').value || '').trim();
    var appId = (document.getElementById('wizard-app-id').value || '').trim();
    var authDomain = (document.getElementById('wizard-auth-domain').value || '').trim();
    var storageBucket = (document.getElementById('wizard-storage-bucket').value || '').trim();
    var senderId = (document.getElementById('wizard-sender-id').value || '').trim();

    var configObj = {
      apiKey: apiKey,
      projectId: projectId,
      appId: appId,
      authDomain: authDomain,
      storageBucket: storageBucket,
      messagingSenderId: senderId
    };

    // Validate via FirestoreConfig
    var result = FirestoreConfig.validate(configObj, collectionName);
    if (!result.valid) {
      if (errorEl) errorEl.textContent = result.errors.join(' ');
      return;
    }

    // Store configuration
    FirestoreConfig.setConfig(configObj);
    FirestoreConfig.setCollectionName(collectionName);
    FirestoreConfig.setSyncEnabled(true);

    hide();
  }

  /**
   * Handle the Skip button click.
   * Sets the wizard-skipped flag and dismisses.
   */
  function handleSkip(e) {
    if (e) e.preventDefault();
    FirestoreConfig.setWizardSkipped(true);
    hide();
  }

  return {
    init: init,
    show: show,
    hide: hide
  };
})();
