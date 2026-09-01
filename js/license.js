const License = (function () {
  'use strict';

  // Secret for HMAC verification (must match License Generator)
  // "TrackYourFitness2025"
  var SECRET_CODES = [84,114,97,99,107,89,111,117,114,70,105,116,110,101,115,115,50,48,50,53];

  var LIMITS = {
    MAX_MEMBERS:     20,
    MAX_MONTHLY_FEE: 1000,
    MAX_GUEST_FEE:   1000
  };

  var WARNING_DAYS = 15; // Show warning 15 days before expiry

  // --- HMAC-SHA256 verification ---
  function _getSecret() {
    return SECRET_CODES.map(function(c) { return String.fromCharCode(c); }).join('');
  }

  async function _hmacHex(message) {
    var secret = _getSecret();
    var enc = new TextEncoder();
    var keyData = enc.encode(secret);
    var msgData = enc.encode(message);
    var cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    var bytes = new Uint8Array(sig);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) { hex += ('0' + bytes[i].toString(16)).slice(-2); }
    return hex;
  }

  // --- License state ---

  function _getLicenseData() {
    try {
      var raw = localStorage.getItem('tyf_license_key');
      if (!raw || raw.trim().length < 20) return null;
      raw = raw.replace(/[\s\r\n]+/g, '');
      var decoded = JSON.parse(atob(raw));
      if (!decoded || !decoded.n || !decoded.h || decoded.h.length !== 64) return null;
      return decoded;
    } catch (e) { return null; }
  }

  function isLicensed() {
    var data = _getLicenseData();
    if (!data) return false;
    // REQUIRE date-restricted license (perpetual not accepted)
    if (!data.f || !data.t) return false;
    var today = new Date().toISOString().split('T')[0];
    if (today < data.f || today > data.t) return false;
    return true;
  }

  function isExpired() {
    var data = _getLicenseData();
    if (!data) return false; // no license = not expired (just unlicensed)
    // Perpetual keys are treated as invalid/expired
    if (!data.f || !data.t) return true;
    var today = new Date().toISOString().split('T')[0];
    return today > data.t;
  }

  function getDaysUntilExpiry() {
    var data = _getLicenseData();
    if (!data || !data.t) return 0; // no valid date = expired
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var expiry = new Date(data.t + 'T00:00:00');
    var diff = Math.ceil((expiry - today) / 86400000);
    return diff;
  }

  function isNearExpiry() {
    var days = getDaysUntilExpiry();
    return days <= WARNING_DAYS && days > 0;
  }

  // --- Verify HMAC (async) ---
  async function verifyLicense(data) {
    if (!data || !data.n || !data.h) return false;
    // Reject perpetual keys — must have from and to dates
    if (!data.f || !data.t) return false;
    var message = data.n + data.f + data.t;
    var expected = await _hmacHex(message);
    return expected === data.h;
  }

  // --- Block screen ---
  function showBlockScreen() {
    var existing = document.getElementById('license-block-overlay');
    if (existing) return; // already showing

    var overlay = document.createElement('div');
    overlay.id = 'license-block-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--bg,#121212);color:var(--text,#e0e0e0);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;';

    var data = _getLicenseData();
    var expiryText = data && data.t ? 'Expired on: ' + data.t : '';

    overlay.innerHTML = '<div style="max-width:360px;">' +
      '<div style="font-size:3rem;margin-bottom:16px;">🚫</div>' +
      '<h2 style="font-size:1.3rem;margin-bottom:8px;">License Expired</h2>' +
      '<p style="font-size:0.95rem;color:var(--text2,#aaa);margin-bottom:8px;">' + expiryText + '</p>' +
      '<p style="font-size:0.9rem;color:var(--text2,#aaa);margin-bottom:20px;">Please update your license key to continue using the app.</p>' +
      '<div style="width:100%;">' +
      '<textarea id="block-license-input" rows="3" placeholder="Paste new license key here…" style="width:100%;padding:12px;background:var(--bg2,#1e1e1e);border:1px solid var(--border,#3a3a3a);border-radius:8px;color:var(--text,#e0e0e0);font-size:0.95rem;margin-bottom:8px;resize:none;"></textarea>' +
      '<div id="block-license-error" style="font-size:0.85rem;color:var(--danger,#e53935);margin-bottom:8px;min-height:18px;"></div>' +
      '<button id="block-activate-btn" style="width:100%;padding:12px;background:var(--primary,#1976d2);color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;">Activate License</button>' +
      '</div></div>';

    document.body.appendChild(overlay);

    // Bind activate button
    var btn = document.getElementById('block-activate-btn');
    var input = document.getElementById('block-license-input');
    var errEl = document.getElementById('block-license-error');

    if (btn) {
      btn.addEventListener('click', async function () {
        if (errEl) errEl.textContent = '';
        var raw = input ? input.value.trim().replace(/[\s\r\n]+/g, '') : '';
        if (!raw) { if (errEl) errEl.textContent = 'Please paste a license key.'; return; }

        var valid = false;
        var decoded = null;
        try {
          decoded = JSON.parse(atob(raw));
          valid = !!(decoded && decoded.n && decoded.h && decoded.h.length === 64);
        } catch (e) { valid = false; }

        if (!valid) { if (errEl) errEl.textContent = 'Invalid license key format.'; return; }

        // Verify HMAC
        var hmacValid = await verifyLicense(decoded);
        if (!hmacValid) { if (errEl) errEl.textContent = 'License key verification failed. Invalid key.'; return; }

        // Must have date fields (perpetual not accepted)
        if (!decoded.f || !decoded.t) { if (errEl) errEl.textContent = 'Only date-restricted licenses are accepted.'; return; }
        var today = new Date().toISOString().split('T')[0];
        if (today < decoded.f) { if (errEl) errEl.textContent = 'This license is not yet active (starts ' + decoded.f + ').'; return; }
        if (today > decoded.t) { if (errEl) errEl.textContent = 'This license is already expired (' + decoded.t + ').'; return; }

        // Store and reload
        try { localStorage.setItem('tyf_license_key', raw); } catch (e) { if (errEl) errEl.textContent = 'Could not save: ' + e.message; return; }
        window._isLicensed = true;
        overlay.remove();
        window.location.reload();
      });
    }
  }

  function hideBlockScreen() {
    var overlay = document.getElementById('license-block-overlay');
    if (overlay) overlay.remove();
  }

  // --- Expiry warning banner ---
  function showExpiryWarning() {
    var days = getDaysUntilExpiry();
    var banner = document.getElementById('license-banner');
    if (!banner) return;
    banner.removeAttribute('hidden');
    var span = banner.querySelector('span');
    if (span) span.textContent = '⚠️ License expires in ' + days + ' day(s). Please renew soon.';
  }

  // --- Public API ---
  function getMaxMembers()    { return isLicensed() ? Infinity : LIMITS.MAX_MEMBERS; }
  function getMaxMonthlyFee() { return isLicensed() ? Infinity : LIMITS.MAX_MONTHLY_FEE; }
  function getMaxGuestFee()   { return isLicensed() ? Infinity : LIMITS.MAX_GUEST_FEE; }

  function updateBanner() {
    var banner = document.getElementById('license-banner');
    if (!banner) return;
    if (isExpired()) {
      banner.removeAttribute('hidden');
      var span = banner.querySelector('span');
      if (span) span.textContent = '🚫 License expired. App is locked.';
    } else if (isNearExpiry()) {
      showExpiryWarning();
    } else if (isLicensed()) {
      banner.setAttribute('hidden', '');
    } else {
      // No license at all — block
      banner.removeAttribute('hidden');
      var span2 = banner.querySelector('span');
      if (span2) span2.textContent = '🚫 No valid license. Please activate a license.';
    }
  }

  async function checkMemberLimit() {
    if (isLicensed()) return null;
    return 'License required to add members.';
  }

  function checkMonthlyFee(fee) {
    if (isLicensed()) return null;
    return 'License required.';
  }

  function checkGuestFee(fee) {
    if (isLicensed()) return null;
    return 'License required.';
  }

  function init() {
    // If expired or no license → block app completely
    if (isExpired() || !isLicensed()) {
      showBlockScreen();
      updateBanner();
      return;
    }
    // If near expiry → show warning
    if (isNearExpiry()) {
      showExpiryWarning();
    } else {
      updateBanner();
    }
    setupLicenseUI();
  }

  function setupLicenseUI() {
    var activateBtn   = document.getElementById('license-activate-btn');
    var deactivateBtn = document.getElementById('license-deactivate-btn');
    var keyInput      = document.getElementById('license-key-input');
    var statusText    = document.getElementById('license-status-text');
    var errorEl       = document.getElementById('license-error');
    var successEl     = document.getElementById('license-success-msg');

    refreshLicenseUI();

    if (activateBtn) {
      activateBtn.addEventListener('click', async function () {
        if (errorEl) errorEl.textContent = '';
        if (successEl) successEl.setAttribute('hidden', '');

        var raw = keyInput ? keyInput.value.trim().replace(/[\s\r\n]+/g, '') : '';
        if (!raw) { if (errorEl) errorEl.textContent = 'Please paste a license key.'; return; }

        var valid = false;
        var decoded = null;
        try {
          decoded = JSON.parse(atob(raw));
          valid = !!(decoded && decoded.n && decoded.h && decoded.h.length === 64);
        } catch (e) { valid = false; }
        if (!valid) { if (errorEl) errorEl.textContent = 'Invalid license key format.'; return; }

        // Verify HMAC
        var hmacValid = await verifyLicense(decoded);
        if (!hmacValid) { if (errorEl) errorEl.textContent = 'License key verification failed. Invalid key.'; return; }

        // Must have date fields (perpetual not accepted)
        if (!decoded.f || !decoded.t) { if (errorEl) errorEl.textContent = 'Only date-restricted licenses are accepted.'; return; }
        var today = new Date().toISOString().split('T')[0];
        if (today > decoded.t) { if (errorEl) errorEl.textContent = 'This license has expired (' + decoded.t + ').'; return; }
        if (today < decoded.f) { if (errorEl) errorEl.textContent = 'This license is not yet active (starts ' + decoded.f + ').'; return; }

        try { localStorage.setItem('tyf_license_key', raw); } catch (e) { if (errorEl) errorEl.textContent = 'Could not save: ' + e.message; return; }

        window._isLicensed = true;
        if (successEl) { successEl.textContent = '✓ License activated!'; successEl.removeAttribute('hidden'); }
        if (keyInput) keyInput.value = '';
        updateBanner();
        refreshLicenseUI();
        hideBlockScreen();
      });
    }

    if (deactivateBtn) {
      deactivateBtn.addEventListener('click', function () {
        if (!confirm('Deactivate your license? The app will be locked.')) return;
        try { localStorage.removeItem('tyf_license_key'); } catch (e) {}
        window._isLicensed = false;
        updateBanner();
        refreshLicenseUI();
        showBlockScreen();
      });
    }
  }

  function refreshLicenseUI() {
    var activateBtn   = document.getElementById('license-activate-btn');
    var deactivateBtn = document.getElementById('license-deactivate-btn');
    var keyInput      = document.getElementById('license-key-input');
    var statusText    = document.getElementById('license-status-text');

    var data = _getLicenseData();

    if (isLicensed()) {
      var statusMsg = 'Status: ✓ Licensed';
      if (data && data.f && data.t) {
        statusMsg += ' (Valid: ' + data.f + ' to ' + data.t + ')';
        var days = getDaysUntilExpiry();
        if (days <= WARNING_DAYS) statusMsg += ' — ⚠️ Expires in ' + days + ' day(s)';
      }
      if (statusText) { statusText.textContent = statusMsg; statusText.style.color = 'var(--success, #4caf50)'; }
      if (activateBtn) activateBtn.setAttribute('hidden', '');
      if (deactivateBtn) deactivateBtn.removeAttribute('hidden');
      if (keyInput) keyInput.setAttribute('hidden', '');
      var label = document.querySelector('label[for="license-key-input"]');
      if (label) label.setAttribute('hidden', '');
    } else {
      var expMsg = isExpired() ? 'Status: 🚫 License Expired' : 'Status: No License';
      if (statusText) { statusText.textContent = expMsg; statusText.style.color = 'var(--danger, #e53935)'; }
      if (activateBtn) activateBtn.removeAttribute('hidden');
      if (deactivateBtn) deactivateBtn.setAttribute('hidden', '');
      if (keyInput) keyInput.removeAttribute('hidden');
      var label2 = document.querySelector('label[for="license-key-input"]');
      if (label2) label2.removeAttribute('hidden');
    }
  }

  return {
    init: init, isLicensed: isLicensed, isExpired: isExpired,
    getDaysUntilExpiry: getDaysUntilExpiry, isNearExpiry: isNearExpiry,
    updateBanner: updateBanner, verifyLicense: verifyLicense,
    getMaxMembers: getMaxMembers, getMaxMonthlyFee: getMaxMonthlyFee, getMaxGuestFee: getMaxGuestFee,
    checkMemberLimit: checkMemberLimit, checkMonthlyFee: checkMonthlyFee, checkGuestFee: checkGuestFee,
    LIMITS: LIMITS
  };
})();