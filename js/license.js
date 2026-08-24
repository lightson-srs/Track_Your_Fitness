const License = (function () {
  'use strict';

  const LIMITS = {
    MAX_MEMBERS:     20,
    MAX_MONTHLY_FEE: 1000,
    MAX_GUEST_FEE:   1000
  };

  // ── License validation ───────────────────────────────
  // Checks localStorage for a valid license key.
  // Key format: base64(JSON) with HMAC — validated against shared secret.
  // Until real key validation is wired up, any stored key is treated as
  // licensed ONLY if it passes the length + format check below.
  function isLicensed() {
    try {
      var raw = localStorage.getItem('tyf_license_key');
      if (!raw || raw.trim().length < 20) return false;
      // Strip any whitespace/newlines that iOS might have introduced
      raw = raw.replace(/[\s\r\n]+/g, '');
      // Must be valid base64 JSON containing { n, h } fields
      var decoded = JSON.parse(atob(raw));
      return !!(decoded && decoded.n && decoded.h && decoded.h.length === 64);
    } catch (e) {
      return false;
    }
  }

  function getMaxMembers()    { return isLicensed() ? Infinity : LIMITS.MAX_MEMBERS; }
  function getMaxMonthlyFee() { return isLicensed() ? Infinity : LIMITS.MAX_MONTHLY_FEE; }
  function getMaxGuestFee()   { return isLicensed() ? Infinity : LIMITS.MAX_GUEST_FEE; }

  // ── Banner ───────────────────────────────────────────
  function updateBanner() {
    var banner = document.getElementById('license-banner');
    if (!banner) return;
    if (isLicensed()) {
      banner.setAttribute('hidden', '');
    } else {
      banner.removeAttribute('hidden');
      var span = banner.querySelector('span');
      if (span) span.textContent =
        '⚠️ Unlicensed — max ' + LIMITS.MAX_MEMBERS + ' members · ' +
        'fee ≤ ₹' + LIMITS.MAX_MONTHLY_FEE + ' · guest fee ≤ ₹' + LIMITS.MAX_GUEST_FEE;
    }
  }

  // ── Limit checks ─────────────────────────────────────
  // Returns null if OK, error string if limit exceeded.

  async function checkMemberLimit() {
    if (isLicensed()) return null;
    var members = await DB.getAllMembers();
    var active  = members.filter(function (m) { return m.status !== 'inactive'; });
    if (active.length >= LIMITS.MAX_MEMBERS) {
      return 'Unlicensed limit reached: max ' + LIMITS.MAX_MEMBERS +
             ' active members. Activate a license to add more.';
    }
    return null;
  }

  // fee > MAX is blocked (MAX itself is allowed: ≤ MAX)
  function checkMonthlyFee(fee) {
    if (isLicensed()) return null;
    fee = parseFloat(fee) || 0;
    if (fee > LIMITS.MAX_MONTHLY_FEE) {
      return 'Unlicensed limit: monthly fee cannot exceed ₹' + LIMITS.MAX_MONTHLY_FEE +
             '. You entered ₹' + fee + '. Activate a license to remove this restriction.';
    }
    return null;
  }

  function checkGuestFee(fee) {
    if (isLicensed()) return null;
    fee = parseFloat(fee) || 0;
    if (fee > LIMITS.MAX_GUEST_FEE) {
      return 'Unlicensed limit: guest fee cannot exceed ₹' + LIMITS.MAX_GUEST_FEE +
             '. You entered ₹' + fee + '. Activate a license to remove this restriction.';
    }
    return null;
  }

  function init() {
    updateBanner();
    setupLicenseUI();
  }

  function setupLicenseUI() {
    var activateBtn   = document.getElementById('license-activate-btn');
    var deactivateBtn = document.getElementById('license-deactivate-btn');
    var keyInput      = document.getElementById('license-key-input');
    var statusText    = document.getElementById('license-status-text');
    var errorEl       = document.getElementById('license-error');
    var successEl     = document.getElementById('license-success-msg');

    // Show current state
    refreshLicenseUI();

    if (activateBtn) {
      activateBtn.addEventListener('click', function () {
        if (errorEl)   errorEl.textContent = '';
        if (successEl) successEl.setAttribute('hidden', '');

        var raw = keyInput ? keyInput.value.trim() : '';
        if (!raw) { if (errorEl) errorEl.textContent = 'Please paste a license key.'; return; }

        // iOS Safari can introduce newlines/spaces when pasting into textarea — strip them
        raw = raw.replace(/[\s\r\n]+/g, '');

        // Validate format: base64(JSON) with { n, h } where h is 64 hex chars
        var valid = false;
        try {
          var decoded = JSON.parse(atob(raw));
          valid = !!(decoded && decoded.n && decoded.h && typeof decoded.h === 'string' && decoded.h.length === 64);
        } catch (e) {
          valid = false;
        }

        if (!valid) {
          if (errorEl) errorEl.textContent = 'Invalid license key format. Please check and try again.';
          return;
        }

        // Store the key
        try {
          localStorage.setItem('tyf_license_key', raw);
        } catch (e) {
          if (errorEl) errorEl.textContent = 'Could not save license key: ' + e.message;
          return;
        }

        // Verify it took effect
        if (isLicensed()) {
          // Update the cached inline check too
          window._isLicensed = true;
          if (successEl) { successEl.textContent = '✓ License activated successfully!'; successEl.removeAttribute('hidden'); }
          if (keyInput) keyInput.value = '';
          updateBanner();
          refreshLicenseUI();
        } else {
          if (errorEl) errorEl.textContent = 'License key was saved but validation failed. Please try again.';
        }
      });
    }

    if (deactivateBtn) {
      deactivateBtn.addEventListener('click', function () {
        if (!confirm('Deactivate your license? Free-tier limits will apply.')) return;
        try { localStorage.removeItem('tyf_license_key'); } catch (e) {}
        window._isLicensed = false;
        if (errorEl)   errorEl.textContent = '';
        if (successEl) successEl.setAttribute('hidden', '');
        updateBanner();
        refreshLicenseUI();
      });
    }
  }

  function refreshLicenseUI() {
    var activateBtn   = document.getElementById('license-activate-btn');
    var deactivateBtn = document.getElementById('license-deactivate-btn');
    var keyInput      = document.getElementById('license-key-input');
    var statusText    = document.getElementById('license-status-text');

    if (isLicensed()) {
      if (statusText)    statusText.textContent = 'Status: ✓ Licensed';
      if (statusText)    statusText.style.color = 'var(--success, #4caf50)';
      if (activateBtn)   activateBtn.setAttribute('hidden', '');
      if (deactivateBtn) deactivateBtn.removeAttribute('hidden');
      if (keyInput)      keyInput.setAttribute('hidden', '');
      // Also hide the label
      var label = document.querySelector('label[for="license-key-input"]');
      if (label) label.setAttribute('hidden', '');
    } else {
      if (statusText)    statusText.textContent = 'Status: Unlicensed';
      if (statusText)    statusText.style.color = 'var(--text2)';
      if (activateBtn)   activateBtn.removeAttribute('hidden');
      if (deactivateBtn) deactivateBtn.setAttribute('hidden', '');
      if (keyInput)      keyInput.removeAttribute('hidden');
      var label = document.querySelector('label[for="license-key-input"]');
      if (label) label.removeAttribute('hidden');
    }
  }

  return {
    init, isLicensed, updateBanner,
    getMaxMembers, getMaxMonthlyFee, getMaxGuestFee,
    checkMemberLimit, checkMonthlyFee, checkGuestFee,
    LIMITS
  };
})();
