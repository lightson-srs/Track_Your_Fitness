const Attendance = (function () {
  'use strict';

  var _scannerInstance = null;
  var _html5QrcodeLoaded = false;
  var _attendanceFilter = 'absent';

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
    if (scanQrBtn) scanQrBtn.addEventListener('click', toggleQRScanner);
    if (saveBtn) saveBtn.addEventListener('click', handleSaveAttendance);

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

      // Load existing attendance for selected date
      var attendanceRecords = await DB.getAttendanceByDate(date);
      var attMap = {};
      attendanceRecords.forEach(function (r) { attMap[r.memberId] = r.status; });

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
        // Marking a deactivated member present reactivates them automatically.
        if (status === 'present') {
          var member = await DB.getMember(memberId);
          if (member && member.status === 'inactive') {
            member.status = 'active';
            try { await DB.updateMember(member); reactivated++; }
            catch (e) { console.error('Could not reactivate member', memberId, e); }
          }
        }
        await DB.saveAttendance(memberId, date, status);
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

    // Re-render to confirm saved state
    renderAttendance();
  }

  // --- QR Scanner ---

  function toggleQRScanner() {
    var container = document.getElementById('att-qr-scanner-container');
    if (!container) return;
    if (_scannerInstance) { stopQRScanner(); }
    else { startQRScanner(); }
  }

  async function startQRScanner() {
    var container = document.getElementById('att-qr-scanner-container');
    if (!container) return;

    container.removeAttribute('hidden');
    container.innerHTML = '<p class="empty-message">Loading scanner…</p>';

    try {
      if (!_html5QrcodeLoaded && typeof Html5Qrcode === 'undefined') {
        await loadScript('https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js');
        _html5QrcodeLoaded = true;
      }

      container.innerHTML = '<div id="att-qr-reader" style="width:100%;max-width:400px;margin:0 auto;"></div>' +
        '<button class="btn btn-secondary btn-sm" id="att-stop-scan-btn" style="margin-top:8px;width:100%;">Stop scanner</button>';

      var stopBtn = document.getElementById('att-stop-scan-btn');
      if (stopBtn) stopBtn.addEventListener('click', stopQRScanner);

      _scannerInstance = new Html5Qrcode('att-qr-reader');
      await _scannerInstance.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        handleQRScanSuccess,
        function () {}
      );
    } catch (e) {
      var msg = 'Could not start QR scanner.';
      if (e && e.message && e.message.toLowerCase().indexOf('permission') !== -1) {
        msg = 'Camera access is required for QR scanning.';
      } else if (e && e.message && e.message.indexOf('load') !== -1) {
        msg = 'QR scanner could not be loaded. Check your internet connection.';
      }
      container.innerHTML = '<p class="empty-message">' + msg + '</p>' +
        '<button class="btn btn-secondary btn-sm" onclick="document.getElementById(\'att-qr-scanner-container\').setAttribute(\'hidden\',\'\');" style="margin-top:8px;">Close</button>';
      _scannerInstance = null;
    }
  }

  var _lastScanId = null;
  var _lastScanAt = 0;

  async function handleQRScanSuccess(decodedText) {
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

      // Scanning a deactivated member reactivates them automatically.
      var reactivated = false;
      if (member.status === 'inactive') {
        member.status = 'active';
        try { await DB.updateMember(member); reactivated = true; }
        catch (e) { console.error('Could not reactivate member on scan', member.id, e); }
      }

      await DB.saveAttendance(member.id, attDate, 'present');

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

  async function stopQRScanner() {
    var container = document.getElementById('att-qr-scanner-container');
    if (_scannerInstance) { try { await _scannerInstance.stop(); } catch (e) {} _scannerInstance = null; }
    if (container) { container.setAttribute('hidden', ''); container.innerHTML = ''; }
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
      var script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Failed to load: ' + src)); };
      document.head.appendChild(script);
    });
  }

  return { init: init, renderAttendance: renderAttendance };
})();