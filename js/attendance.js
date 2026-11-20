const Attendance = (function () {
  'use strict';

  var _scannerInstance = null;
  var _html5QrcodeLoaded = false;
  var _attendanceFilter = 'absent';

  // In-memory draft of unsaved checkbox toggles for the CURRENT date:
  // { memberId: 'present' | 'absent' }. Captured from the DOM before each
  // re-render so switching tabs / searching preserves un-saved changes instead
  // of reloading from the DB. Keyed by date so changing the date clears it.
  var _attDraft = {};
  var _attDraftDate = null;
  // What the DB held for the current date at the last render { memberId: status }.
  var _attBaseline = {};

  // Snapshot the live checkbox states from the DOM into _attDraft, so a
  // subsequent renderAttendance() can re-apply them (tab switch, search, etc.).
  // ONLY boxes that differ from the last-rendered DB state are real unsaved
  // edits. Recording untouched boxes would freeze a stale view: e.g. a render
  // that ran before a sync arrived would store "absent" for everyone and then
  // keep overriding the freshly synced "present" rows on every later redraw.
  function captureDraft() {
    var boxes = document.querySelectorAll('.att-checkbox');
    boxes.forEach(function (cb) {
      var id = cb.dataset.memberId;
      if (!id) return;
      var wasPresent = _attBaseline[id] === 'present';
      if (cb.checked !== wasPresent) _attDraft[id] = cb.checked ? 'present' : 'absent';
      else delete _attDraft[id];   // matches the DB again → not an edit
    });
  }

  function esc(s) {
    return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
  }
  function getTodayISO() { return new Date().toISOString().split('T')[0]; }

  function init() {
    var dateInput      = document.getElementById('att-date');
    var searchInput    = document.getElementById('att-search');
    var selectAllCb    = document.getElementById('att-select-all');
    var includeInactiveCb = document.getElementById('att-include-inactive');
    var copyYesterday  = document.getElementById('att-copy-yesterday-btn');
    var scanQrBtn      = document.getElementById('att-scan-qr-btn');
    var saveBtn        = document.getElementById('att-save-btn');

    if (dateInput) {
      if (!dateInput.value) { dateInput.value = getTodayISO(); syncDatePicker('att-date'); }
      dateInput.addEventListener('change', renderAttendance);
    }
    if (searchInput) searchInput.addEventListener('input', renderAttendance);
    if (includeInactiveCb) includeInactiveCb.addEventListener('change', renderAttendance);
    if (selectAllCb) selectAllCb.addEventListener('change', function () { toggleSelectAll(selectAllCb.checked); });
    if (copyYesterday) copyYesterday.addEventListener('click', showCopyDateModal);
    if (scanQrBtn) scanQrBtn.addEventListener('click', openScanner);
    // Scanner modal: explicit Close button (no tap-outside-to-close, so a stray tap
    // can't interrupt a scanning session). The camera is also released when the app
    // is backgrounded/closed and on Escape.
    var scanCloseBtn = document.getElementById('att-scan-close-btn');
    if (scanCloseBtn) scanCloseBtn.addEventListener('click', closeScanner);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeScanner(); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') closeScanner(); });
    window.addEventListener('pagehide', closeScanner);
    if (saveBtn) saveBtn.addEventListener('click', handleSaveAttendance);
    var cancelBtn = document.getElementById('att-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', handleCancelAttendance);

    // Copy date modal buttons
    var copyConfirmBtn = document.getElementById('att-copy-confirm-btn');
    var copyCancelBtn  = document.getElementById('att-copy-cancel-btn');
    if (copyConfirmBtn) copyConfirmBtn.addEventListener('click', handleCopyFromDate);
    if (copyCancelBtn)  copyCancelBtn.addEventListener('click', hideCopyDateModal);

    // Attendance filter buttons
    document.querySelectorAll('.att-filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _attendanceFilter = btn.dataset.filter;
        document.querySelectorAll('.att-filter-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        renderAttendance();
      });
    });

    // Render only if attendance screen is currently visible
    var attScreen = document.getElementById('attendance-screen');
    if (attScreen && !attScreen.hasAttribute('hidden')) {
      renderAttendance();
    }
  }

  // --- Copy from date modal ---
  function showCopyDateModal() {
    var modal = document.getElementById('att-copy-date-modal');
    if (!modal) return;

    // Default source date = yesterday relative to currently selected attendance date
    var dateInput = document.getElementById('att-date');
    var date = dateInput ? dateInput.value : getTodayISO();
    var d = new Date(date + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    var yesterday = d.toISOString().split('T')[0];

    var sourceInput = document.getElementById('att-copy-source-date');
    if (sourceInput) { sourceInput.value = yesterday; syncDatePicker('att-copy-source-date'); }

    modal.removeAttribute('hidden');
  }

  function hideCopyDateModal() {
    var modal = document.getElementById('att-copy-date-modal');
    if (modal) modal.setAttribute('hidden', '');
  }

  async function handleCopyFromDate() {
    var sourceInput = document.getElementById('att-copy-source-date');
    var sourceDate = sourceInput ? sourceInput.value : '';
    if (!sourceDate) { alert('Please select a source date.'); return; }

    var dateInput = document.getElementById('att-date');
    var targetDate = dateInput ? dateInput.value : getTodayISO();

    try {
      var records = await DB.getAttendanceByDate(sourceDate);
      var presentMembers = records.filter(function (r) { return r.status === 'present'; });

      if (presentMembers.length === 0) {
        alert('No attendance records found for ' + sourceDate + '. Save attendance for that day first.');
        return;
      }

      for (var i = 0; i < presentMembers.length; i++) {
        await DB.saveAttendance(presentMembers[i].memberId, targetDate, 'present');
      }

      hideCopyDateModal();
      alert('Copied ' + presentMembers.length + ' member(s) from ' + sourceDate + '.');
      renderAttendance();
    } catch (e) {
      alert('Could not copy attendance: ' + e.message);
    }
  }

  var _renderTimer = null;
  async function renderAttendance() {
    // Debounce: if called multiple times rapidly, only execute the last call
    if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }

    var container = document.getElementById('att-member-list');
    if (!container) return;

    var dateInput   = document.getElementById('att-date');
    var searchInput = document.getElementById('att-search');

    // Ensure date has a value
    if (dateInput && !dateInput.value) {
      dateInput.value = getTodayISO();
      syncDatePicker('att-date');
    }

    var date        = dateInput ? dateInput.value : getTodayISO();
    var searchTerm  = searchInput ? searchInput.value.trim().toLowerCase() : '';
    var includeInactiveCb = document.getElementById('att-include-inactive');
    var includeInactive = includeInactiveCb ? includeInactiveCb.checked : false;

    // Preserve unsaved toggles across re-renders (tab switch / search). If the
    // date changed, the draft belongs to a different day — discard it.
    if (_attDraftDate !== date) { _attDraft = {}; _attBaseline = {}; _attDraftDate = date; }
    else { captureDraft(); }

    container.innerHTML = '<p class="empty-message">Loading…</p>';

    try {
      var members = await DB.getAllMembers();
      // By default only active members. When "Include deactivated members" is
      // checked, inactive members are listed and searchable too — marking them
      // present (manually or via QR) auto-reactivates them.
      if (!includeInactive) members = members.filter(function (m) { return m.status !== 'inactive'; });

      if (searchTerm) {
        members = members.filter(function (m) {
          return m.name.toLowerCase().indexOf(searchTerm) !== -1 ||
            (m.memberType && m.memberType.toLowerCase().indexOf(searchTerm) !== -1);
        });
      }
      members.sort(function (a, b) { return a.name.localeCompare(b.name); });

      if (members.length === 0) {
        container.innerHTML = '<p class="empty-message">No active members.</p>';
        updatePresentCount(0);
        return;
      }

      // Load existing attendance for selected date (the saved baseline).
      var attendanceRecords = await DB.getAttendanceByDate(date);
      var attMap = {};
      attendanceRecords.forEach(function (r) { attMap[r.memberId] = r.status; });
      _attBaseline = Object.assign({}, attMap);   // saved state, before the unsaved-draft overlay

      // Overlay the unsaved draft so a toggle made on one tab is reflected on
      // the others (and in the All tab) until the user Saves or Cancels.
      for (var draftId in _attDraft) {
        if (_attDraft.hasOwnProperty(draftId)) attMap[draftId] = _attDraft[draftId];
      }

      var presentCount = 0;
      var html = '';
      members.forEach(function (m) {
        var isPresent = attMap[m.id] === 'present';
        if (isPresent) presentCount++;
        var isInactive = m.status === 'inactive';

        html += '<div class="att-member-row' + (isPresent ? ' att-present' : '') + (isInactive ? ' member-inactive' : '') + '">';
        html += '<label class="att-member-label">';
        html += '<input type="checkbox" class="att-checkbox" data-member-id="' + m.id + '"' + (isPresent ? ' checked' : '') + '>';
        html += '<span class="att-member-name">' + esc(m.name) + '</span>';
        if (m.memberType && m.memberType !== 'Regular') {
          html += ' <span class="loan-type-badge badge-monthly" style="font-size:0.7rem;">' + esc(m.memberType) + '</span>';
        }
        if (isInactive) {
          html += ' <span class="loan-type-badge badge-guest" style="font-size:0.68rem;">deactivated</span>';
        }
        html += '</label>';
        html += '<span class="att-status-label ' + (isPresent ? 'att-status-present' : 'att-status-absent') + '">' + (isPresent ? '✅ Present' : '') + '</span>';
        html += '</div>';
      });

      container.innerHTML = html;
      updatePresentCount(presentCount);

      // Apply attendance filter (absent/present/all)
      var rows = container.querySelectorAll('.att-member-row');
      rows.forEach(function (row) {
        var cb = row.querySelector('.att-checkbox');
        var isChecked = cb && cb.checked;
        if (_attendanceFilter === 'absent') {
          row.style.display = isChecked ? 'none' : '';
        } else if (_attendanceFilter === 'present') {
          row.style.display = isChecked ? '' : 'none';
        } else {
          row.style.display = '';
        }
      });

      // Bind checkbox change to update UI (not DB yet — save button does that)
      container.querySelectorAll('.att-checkbox').forEach(function (cb) {
        cb.addEventListener('change', function () {
          // Record the toggle in the draft so it persists across tab switches.
          if (cb.dataset.memberId) _attDraft[cb.dataset.memberId] = cb.checked ? 'present' : 'absent';
          var row = cb.closest('.att-member-row');
          var label = row ? row.querySelector('.att-status-label') : null;
          if (cb.checked) {
            if (row) row.classList.add('att-present');
            if (label) { label.textContent = '✅ Present'; label.className = 'att-status-label att-status-present'; }
          } else {
            if (row) row.classList.remove('att-present');
            if (label) { label.textContent = ''; label.className = 'att-status-label att-status-absent'; }
          }
          // Re-apply filter: hide/show row based on current filter
          if (row) {
            if (_attendanceFilter === 'absent') {
              row.style.display = cb.checked ? 'none' : '';
            } else if (_attendanceFilter === 'present') {
              row.style.display = cb.checked ? '' : 'none';
            }
          }
          // Update count
          var checked = document.querySelectorAll('.att-checkbox:checked');
          updatePresentCount(checked.length);
        });
      });
    } catch (e) {
      container.innerHTML = '<p class="empty-message">Could not load members.</p>';
      console.error('Attendance render error:', e);
    }
  }

  function updatePresentCount(count) {
    var el = document.getElementById('att-present-count');
    if (el) el.textContent = count + ' present';
  }

  function toggleSelectAll(checked) {
    var checkboxes = document.querySelectorAll('.att-checkbox');
    checkboxes.forEach(function (cb) {
      cb.checked = checked;
      var row = cb.closest('.att-member-row');
      var label = row ? row.querySelector('.att-status-label') : null;
      if (checked) {
        if (row) row.classList.add('att-present');
        if (label) { label.textContent = '✅ Present'; label.className = 'att-status-label att-status-present'; }
      } else {
        if (row) row.classList.remove('att-present');
        if (label) { label.textContent = ''; label.className = 'att-status-label att-status-absent'; }
      }
    });
    updatePresentCount(checked ? checkboxes.length : 0);
  }

  // --- Cancel button: discard unsaved changes ---
  // Re-renders the list from the last SAVED state for the selected date,
  // dropping any unsaved checkbox toggles. Stays on the attendance screen.
  function handleCancelAttendance() {
    var anyChecked = document.querySelectorAll('.att-checkbox:checked').length;
    var msg = anyChecked
      ? 'Discard unsaved attendance changes and reload the saved state?'
      : 'Reload the saved attendance for this date?';
    if (!confirm(msg)) return;
    // Discard the unsaved draft, then reload the saved state.
    _attDraft = {}; _attDraftDate = null;
    renderAttendance();
  }

  // --- Save Attendance button ---
  async function handleSaveAttendance() {
    var dateInput = document.getElementById('att-date');
    var date = dateInput ? dateInput.value : getTodayISO();
    var saveBtn = document.getElementById('att-save-btn');
    var msgEl = document.getElementById('att-save-msg');

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    var checkboxes = document.querySelectorAll('.att-checkbox');
    var saved = 0, errors = 0, reactivated = 0;

    for (var i = 0; i < checkboxes.length; i++) {
      var cb = checkboxes[i];
      var memberId = cb.dataset.memberId;
      var status = cb.checked ? 'present' : 'absent';
      try {
        // Same routine as a QR scan: marking a deactivated member present
        // reactivates them, then the record is saved.
        var result = await recordAttendance(memberId, date, status);
        if (result.reactivated) reactivated++;
        saved++;
      } catch (e) {
        errors++;
        console.error('Failed to save attendance for', memberId, e);
      }
    }

    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save Attendance'; }

    if (errors > 0) {
      alert('Saved ' + saved + ' records' + (reactivated > 0 ? ', ' + reactivated + ' reactivated' : '') + '. ' + errors + ' failed.');
    } else if (reactivated > 0) {
      alert('Saved ' + saved + ' records. ' + reactivated + ' deactivated member(s) reactivated.');
    } else {
      if (msgEl) { msgEl.removeAttribute('hidden'); setTimeout(function () { msgEl.setAttribute('hidden', ''); }, 2500); }
    }

    if (typeof Audit !== 'undefined') {
      var presentNow = document.querySelectorAll('.att-checkbox:checked').length;
      Audit.writeAudit('AT', { date: fmtDate(date), present: presentNow });
    }

    // Draft is now persisted — clear it so the re-render reflects the saved DB
    // state (not the stale overlay).
    _attDraft = {}; _attDraftDate = null;

    // Re-render to confirm saved state
    renderAttendance();
  }

  // --- Shared "mark attendance" routine ---
  // The Save Attendance button and a QR scan MUST follow the same routine, so both
  // call this: marking someone PRESENT first reactivates a deactivated member, then
  // the record is written through DB.saveAttendance (deterministic id, skips an
  // unchanged row, queues the change for sync). Callers keep their own audit entry
  // and messages. `preloaded` lets a caller that already fetched the member avoid
  // a second read.
  async function recordAttendance(memberId, date, status, preloaded) {
    var member = null;
    var reactivated = false;
    if (status === 'present') {
      member = preloaded || await DB.getMember(memberId);
      if (member && member.status === 'inactive') {
        member.status = 'active';
        try { await DB.updateMember(member); reactivated = true; }
        catch (e) { console.error('Could not reactivate member', memberId, e); }
      }
    }
    await DB.saveAttendance(memberId, date, status);
    return { member: member, reactivated: reactivated };
  }

  // --- QR Scanner (opens in a modal window) ---

  var _scanToken = 0;   // bumps on every open/close, so a late async step can tell it is stale
  var _scanCount = 0;   // members marked during the current scanner session

  function setScanCount(n) {
    var el = document.getElementById('att-scan-count');
    if (el) el.textContent = String(n);
  }

  function setScanMessage(text) {
    var el = document.getElementById('att-scan-modal-msg');
    if (!el) return;
    if (text) { el.textContent = text; el.removeAttribute('hidden'); }
    else { el.textContent = ''; el.setAttribute('hidden', ''); }
  }

  function openScanner() {
    var modal = document.getElementById('att-scan-modal');
    if (!modal) return;
    if (!modal.hasAttribute('hidden') && _scannerInstance) return;   // already open and running

    _lastScanId = null; _lastScanAt = 0; _scanCount = 0;
    var token = ++_scanToken;

    // Scans mark the date chosen in the date picker, which the modal covers — so
    // show that date in the modal.
    var dateInput = document.getElementById('att-date');
    var attDate = (dateInput && dateInput.value) ? dateInput.value : getTodayISO();
    var dateEl = document.getElementById('att-scan-modal-date');
    if (dateEl) dateEl.textContent = 'Marking present for ' + fmtDate(attDate);
    setScanCount(0);
    setScanMessage('');

    modal.removeAttribute('hidden');   // must be visible BEFORE the camera starts (it needs a sized container)
    startQRScanner(token);             // still inside the tap handler's call chain (iOS camera prompt)
  }

  async function startQRScanner(token) {
    setScanMessage('Loading scanner…');
    var inst = null;   // THIS attempt's camera — always released through this reference, never through whatever is current
    try {
      if (typeof Html5Qrcode === 'undefined') {
        await loadScript('https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js');
      }
      if (token !== _scanToken) return;               // closed while the library was loading
      setScanMessage('');

      inst = new Html5Qrcode('att-qr-reader');
      _scannerInstance = inst;
      await inst.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: function (w, h) { var s = Math.max(150, Math.min(250, Math.floor(Math.min(w, h) * 0.7))); return { width: s, height: s }; } },
        handleQRScanSuccess,
        function () {}
      );
      // Closed while the camera was still starting: close could not stop it yet, so
      // release it now that it is actually running.
      if (token !== _scanToken) await releaseCamera(inst);
    } catch (e) {
      await releaseCamera(inst);
      if (token !== _scanToken) return;
      var msg = 'Could not start QR scanner.';
      if (e && e.message && e.message.toLowerCase().indexOf('permission') !== -1) {
        msg = 'Camera access is required for QR scanning.';
      } else if (e && e.message && e.message.indexOf('load') !== -1) {
        msg = 'QR scanner could not be loaded. Check your internet connection.';
      }
      setScanMessage(msg);
    }
  }

  // Close the modal AND release the camera. Safe to call any time (idempotent).
  async function closeScanner() {
    var modal = document.getElementById('att-scan-modal');
    var isOpen = (modal && !modal.hasAttribute('hidden')) || !!_scannerInstance;
    if (!isOpen) return;
    _scanToken++;                                      // invalidates any start still in flight
    if (modal) modal.setAttribute('hidden', '');
    await stopQRScanner();
  }

  var _lastScanId = null;
  var _lastScanAt = 0;

  async function handleQRScanSuccess(decodedText) {
    if (!_scannerInstance) return;   // scanner already closed — ignore late callbacks

    // Debounce duplicate reads: html5-qrcode fires the same code many times per second.
    var now = Date.now();
    if (decodedText === _lastScanId && (now - _lastScanAt) < 3000) { return; }
    _lastScanId = decodedText;
    _lastScanAt = now;

    if (_scannerInstance) {
      try { await _scannerInstance.pause(true); } catch (e) {}
    }

    try {
      // QR encodes the member id → direct ID lookup finds the member regardless
      // of status. If the member is deactivated, reactivate and mark present.
      var member = await DB.getMember(decodedText);
      if (!member) {
        showScanToast('error', 'Member not recognised', 'Unknown QR code. Try scanning again.');
        resumeScannerAfterDelay();
        return;
      }

      // Mark attendance for the DATE SELECTED in the attendance screen's date
      // picker (consistent with the manual Save path), falling back to today
      // only if the picker is empty.
      var dateInput = document.getElementById('att-date');
      var attDate = (dateInput && dateInput.value) ? dateInput.value : getTodayISO();

      // Same routine as the Save Attendance button (reactivate if needed, then save).
      var result = await recordAttendance(member.id, attDate, 'present', member);
      var reactivated = result.reactivated;
      if (typeof Audit !== 'undefined') Audit.writeAudit('AQ', { name: member.name, date: fmtDate(attDate) });

      _scanCount++;
      setScanCount(_scanCount);

      var dueText = '';
      if (typeof Monthly !== 'undefined' && typeof Monthly.calcMemberBalance === 'function') {
        try {
          var contrib = await DB.getContributionByMember(member.id);
          if (contrib) {
            var bal = await Monthly.calcMemberBalance(member, contrib, attDate);
            dueText = bal.balance > 0
              ? 'Pending due: ₹' + bal.balance.toFixed(2)
              : 'No pending due ✓';
          }
        } catch (e) { /* balance is best-effort — never block the mark */ }
      }

      var typeLabel = (member.memberType && member.memberType !== 'Regular') ? ' (' + member.memberType + ')' : '';
      var markedMsg = reactivated ? ' — reactivated & marked present!' : ' — marked present on ' + fmtDate(attDate) + '!';
      showScanToast('success', member.name + typeLabel + markedMsg, dueText);

      renderAttendance();
      resumeScannerAfterDelay();
    } catch (e) {
      showScanToast('error', 'Could not mark attendance', e && e.message ? e.message : '');
      resumeScannerAfterDelay();
    }
  }

  // Prominent centered toast shown on every scan. Auto-dismisses.
  var _scanToastTimer = null;
  function showScanToast(kind, title, subtitle) {
    var toast = document.getElementById('att-scan-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'att-scan-toast';
      document.body.appendChild(toast);
    }
    toast.className = 'att-scan-toast att-scan-toast-' + (kind === 'error' ? 'error' : 'success');
    var icon = kind === 'error' ? '❌' : '✅';
    toast.innerHTML =
      '<div class="att-scan-toast-icon">' + icon + '</div>' +
      '<div class="att-scan-toast-title">' + esc(title) + '</div>' +
      (subtitle ? '<div class="att-scan-toast-sub">' + esc(subtitle) + '</div>' : '');
    // Force reflow so the fade-in transition runs each time.
    toast.classList.remove('att-scan-toast-show');
    void toast.offsetWidth;
    toast.classList.add('att-scan-toast-show');

    beep(kind === 'error');

    if (_scanToastTimer) clearTimeout(_scanToastTimer);
    _scanToastTimer = setTimeout(function () {
      toast.classList.remove('att-scan-toast-show');
    }, 2600);
  }

  // Short audio cue so the operator doesn't have to watch the screen.
  var _audioCtx = null;
  function beep(isError) {
    try {
      if (!_audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        _audioCtx = new AC();
      }
      var osc = _audioCtx.createOscillator();
      var gain = _audioCtx.createGain();
      osc.connect(gain);
      gain.connect(_audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = isError ? 220 : 880;
      gain.gain.setValueAtTime(0.15, _audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.2);
      osc.start();
      osc.stop(_audioCtx.currentTime + 0.2);
    } catch (e) { /* audio is optional */ }
  }

  function resumeScannerAfterDelay() {
    setTimeout(function () {
      if (_scannerInstance) { try { _scannerInstance.resume(); } catch (e) {} }
    }, 1500);
  }

  // Release one specific camera. If it is still the current scanner it is
  // un-registered FIRST so any late scan callback is ignored; a newer scanner
  // (opened after this one) is never touched.
  async function releaseCamera(inst) {
    if (!inst) return;
    if (_scannerInstance === inst) _scannerInstance = null;
    try { await inst.stop(); } catch (e) {}
    try { inst.clear(); } catch (e) {}
  }

  function stopQRScanner() { return releaseCamera(_scannerInstance); }

  // One load per URL, shared by every caller; a failed/timed-out tag is removed so a
  // retry (e.g. after reconnecting) really tries again instead of reporting success.
  var _scriptLoads = {};
  function loadScript(src) {
    if (_scriptLoads[src]) return _scriptLoads[src];
    var p = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = function () {
        delete _scriptLoads[src];
        if (script.parentNode) script.parentNode.removeChild(script);
        reject(new Error('Failed to load: ' + src));
      };
      document.head.appendChild(script);
    });
    _scriptLoads[src] = p;
    return p;
  }

  return { init: init, renderAttendance: renderAttendance, openScanner: openScanner, closeScanner: closeScanner, recordAttendance: recordAttendance };

})();