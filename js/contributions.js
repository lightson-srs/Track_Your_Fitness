const Contributions = (function () {
  'use strict';

  // ─── Enroll/edit modal state ───
  var _enrollMemberId  = null;
  var _enrollContribId = null;

  // ─── Bulk apply state: { memberId → true } ───
  var _bulkSelected = {};

  function esc(s) {
    return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
  }
  function getTodayISO() { return new Date().toISOString().split('T')[0]; }

  function init() {
    // Enroll form buttons
    var enrollCancel = document.getElementById('enroll-cancel-btn');
    var enrollSave   = document.getElementById('enroll-save-btn');
    if (enrollCancel) enrollCancel.addEventListener('click', hideEnrollForm);
    if (enrollSave)   enrollSave.addEventListener('click', handleEnrollSave);

    // Member list search
    var searchInput = document.getElementById('contrib-search');
    if (searchInput) searchInput.addEventListener('input', renderContribList);

    // Bulk apply section
    var bulkSearch  = document.getElementById('bulk-member-search');
    var bulkApply   = document.getElementById('bulk-apply-btn');
    var bulkSelectAll = document.getElementById('bulk-select-all');
    if (bulkSearch)    bulkSearch.addEventListener('input', renderBulkMemberList);
    if (bulkApply)     bulkApply.addEventListener('click', handleBulkApply);
    if (bulkSelectAll) bulkSelectAll.addEventListener('change', toggleSelectAll);

    // Set default activation date to today
    var bulkDate = document.getElementById('bulk-activation-date');
    if (bulkDate && !bulkDate.value) { bulkDate.value = getTodayISO(); syncDatePicker('bulk-activation-date'); }

    renderContribList();
    renderBulkMemberList();
  }

  // ─── Main enrollment list ─────────────────────────────
  async function renderContribList() {
    var container  = document.getElementById('contrib-list');
    var searchInput= document.getElementById('contrib-search');
    if (!container) return;

    var searchTerm = searchInput ? searchInput.value.trim().toLowerCase() : '';
    container.innerHTML = '<p class="empty-message">Loading…</p>';

    try {
      var members  = await DB.getAllMembers();
      var contribs = await DB.getAllContributions();
      var contribMap = {};
      contribs.forEach(function (c) { contribMap[c.memberId] = c; });

      members = members.filter(function (m) { return m.status !== 'inactive'; });
      if (searchTerm) {
        members = members.filter(function (m) { return m.name.toLowerCase().indexOf(searchTerm) !== -1; });
      }
      members.sort(function (a, b) { return a.name.localeCompare(b.name); });

      if (members.length === 0) { container.innerHTML = '<p class="empty-message">No active members.</p>'; return; }

      var enrolled = members.filter(function (m) { return contribMap[m.id]; }).length;
      var html = '<div class="history-summary" style="margin-bottom:4px;">' +
        enrolled + ' of ' + members.length + ' active member(s) enrolled</div>';

      members.forEach(function (m) {
        var c = contribMap[m.id];
        html += '<div class="client-card">';
        html += '<div class="client-header">';
        html += '<div class="client-info">';
        html += '<div class="client-name">' + esc(m.name) + '</div>';
        html += '<div class="client-mobile">' + esc(m.mobile) + '</div>';
        if (c) {
          html += '<div class="member-meta">';
          html += '<span class="loan-type-badge badge-monthly">₹' + (c.monthlyFee||0).toFixed(0) + '/mo</span>';
          html += ' <span class="member-fee">from ' + fmtDate(c.activationDate||'') + '</span>';
          if (c.dueDay) html += ' <span class="member-fee">· due ' + esc(String(c.dueDay)) + '</span>';
          if (c.guestFee) html += ' <span class="loan-type-badge badge-guest">Guest ₹' + (c.guestFee).toFixed(0) + '</span>';
          html += '</div>';
        } else {
          html += '<div class="member-meta"><span class="loan-type-badge badge-guest">Not enrolled</span></div>';
        }
        html += '</div>';
        html += '<div class="client-actions">';
        if (c) {
          html += '<button class="btn btn-sm btn-secondary btn-edit-contrib" data-member-id="' + m.id + '" data-contrib-id="' + c.id + '">Edit</button>';
          html += '<button class="btn-icon btn-delete-contrib" data-contrib-id="' + c.id + '" title="Remove">🗑️</button>';
        } else {
          html += '<button class="btn btn-sm btn-primary btn-enroll" data-member-id="' + m.id + '" data-member-name="' + esc(m.name) + '">Enroll</button>';
        }
        html += '</div></div></div>';
      });

      container.innerHTML = html;

      container.querySelectorAll('.btn-enroll').forEach(function (btn) {
        btn.addEventListener('click', function () { showEnrollForm(btn.dataset.memberId, btn.dataset.memberName, null); });
      });
      container.querySelectorAll('.btn-edit-contrib').forEach(function (btn) {
        btn.addEventListener('click', function () { openEditContrib(btn.dataset.memberId, btn.dataset.contribId); });
      });
      container.querySelectorAll('.btn-delete-contrib').forEach(function (btn) {
        btn.addEventListener('click', function () { deleteContrib(btn.dataset.contribId); });
      });
    } catch (e) {
      container.innerHTML = '<p class="empty-message">Could not load data.</p>';
      console.error(e);
    }
  }

  // ─── Bulk apply: member checkbox list ────────────────
  async function renderBulkMemberList() {
    var container  = document.getElementById('bulk-member-list');
    var searchInput= document.getElementById('bulk-member-search');
    if (!container) return;

    var searchTerm = searchInput ? searchInput.value.trim().toLowerCase() : '';

    try {
      var members  = await DB.getAllMembers();
      var contribs = await DB.getAllContributions();
      var contribMap = {};
      contribs.forEach(function (c) { contribMap[c.memberId] = c; });

      members = members.filter(function (m) { return m.status !== 'inactive'; });
      if (searchTerm) {
        members = members.filter(function (m) { return m.name.toLowerCase().indexOf(searchTerm) !== -1; });
      }
      members.sort(function (a, b) { return a.name.localeCompare(b.name); });

      if (members.length === 0) { container.innerHTML = '<p class="empty-message">No active members.</p>'; return; }

      var html = '';
      members.forEach(function (m) {
        var c = contribMap[m.id];
        var checked = _bulkSelected[m.id] ? ' checked' : '';
        var currentFee = c ? ' <span class="member-fee">currently ₹' + (c.monthlyFee||0).toFixed(0) + '/mo</span>' : ' <span class="loan-type-badge badge-guest" style="font-size:0.68rem;">not enrolled</span>';
        html += '<label class="bulk-member-row">';
        html += '<input type="checkbox" class="bulk-member-check" data-id="' + m.id + '"' + checked + '>';
        html += '<span class="bulk-member-name">' + esc(m.name) + currentFee + '</span>';
        html += '</label>';
      });
      container.innerHTML = html;

      container.querySelectorAll('.bulk-member-check').forEach(function (cb) {
        cb.addEventListener('change', function () {
          if (cb.checked) _bulkSelected[cb.dataset.id] = true;
          else delete _bulkSelected[cb.dataset.id];
          updateBulkCount();
        });
      });

      updateBulkCount();
    } catch (e) {
      container.innerHTML = '<p class="empty-message">Could not load members.</p>';
    }
  }

  function toggleSelectAll(e) {
    var checks = document.querySelectorAll('.bulk-member-check');
    checks.forEach(function (cb) {
      cb.checked = e.target.checked;
      if (e.target.checked) _bulkSelected[cb.dataset.id] = true;
      else delete _bulkSelected[cb.dataset.id];
    });
    updateBulkCount();
  }

  function updateBulkCount() {
    var countEl = document.getElementById('bulk-selected-count');
    var count   = Object.keys(_bulkSelected).length;
    if (countEl) countEl.textContent = count > 0 ? count + ' member(s) selected' : 'No members selected';
  }

  async function handleBulkApply() {
    var dateInput = document.getElementById('bulk-activation-date');
    var feeInput  = document.getElementById('bulk-fee-amount');
    var dueDayInput = document.getElementById('bulk-due-day');
    var errEl     = document.getElementById('bulk-error');
    var msgEl     = document.getElementById('bulk-success-msg');
    if (errEl) errEl.textContent = '';
    if (msgEl) msgEl.setAttribute('hidden', '');

    var date    = dateInput  ? dateInput.value.trim()  : '';
    var fee     = parseFloat(feeInput  ? feeInput.value   : 0);
    var dueDay  = parseInt(dueDayInput ? dueDayInput.value : 1, 10) || 1;
    var selected = Object.keys(_bulkSelected);

    if (!date)                          { if (errEl) errEl.textContent = 'Activation date is required.'; return; }
    if (isNaN(fee) || fee <= 0)         { if (errEl) errEl.textContent = 'Fee must be greater than zero.'; return; }
    if (dueDay < 1 || dueDay > 28)      { if (errEl) errEl.textContent = 'Due day must be between 1 and 28.'; return; }
    if (selected.length === 0)          { if (errEl) errEl.textContent = 'Select at least one member.'; return; }

    // License fee limit check
    var bulkFeeLimit = License.checkMonthlyFee(fee);
    if (bulkFeeLimit) { if (errEl) errEl.textContent = bulkFeeLimit; return; }

    if (!confirm('Update monthly fee to ₹' + fee.toFixed(2) + ' for ' + selected.length + ' member(s) from ' + date + '?')) return;

    // Derive period string (YYYY-MM) from the activation date
    var period = date.substring(0, 7); // e.g. '2026-06'

    var updated = 0, enrolled = 0, feeCreated = 0, failed = 0;
    for (var i = 0; i < selected.length; i++) {
      var memberId = selected[i];
      try {
        var existing = await DB.getContributionByMember(memberId);
        if (existing) {
          existing.monthlyFee     = fee;
          existing.activationDate = date;
          existing.dueDay         = dueDay;
          await DB.updateContribution(existing);
          updated++;
        } else {
          var newContrib = {
            id:             DB.generateId(),
            memberId:       memberId,
            monthlyFee:     fee,
            guestFee:       Settings.getDefaultGuestFee(),
            activationDate: date,
            dueDay:         dueDay,
            notes:          '',
            status:         'active',
            createdAt:      new Date().toISOString()
          };
          await DB.addContribution(newContrib);
          enrolled++;
        }

        // Create or overwrite monthly fee record for this member+date
        var existingFeeRecord = await DB.getMonthlyFeeRecordByMemberDate(memberId, date);
        if (existingFeeRecord) {
          // Same member + same date → overwrite fee amount
          existingFeeRecord.fee    = fee;
          existingFeeRecord.period = period;
          // Only update if still pending (don't touch collected records)
          if (existingFeeRecord.status === 'pending') {
            await DB.updateMonthlyFeeRecord(existingFeeRecord);
          }
        } else {
          // New record — different date (even same month) → new entry
          var feeRecord = {
            id:        DB.generateId(),
            memberId:  memberId,
            date:      date,
            fee:       fee,
            period:    period,
            status:    'pending',
            createdAt: new Date().toISOString()
          };
          await DB.addMonthlyFeeRecord(feeRecord);
          feeCreated++;
        }
      } catch (e) { failed++; console.error(e); }
    }

    // Clear selection
    _bulkSelected = {};
    var allCb = document.getElementById('bulk-select-all');
    if (allCb) allCb.checked = false;

    var resultParts = [];
    if (updated > 0)     resultParts.push(updated + ' updated');
    if (enrolled > 0)    resultParts.push(enrolled + ' newly enrolled');
    if (feeCreated > 0)  resultParts.push(feeCreated + ' fee record(s) created');
    if (failed > 0)      resultParts.push(failed + ' failed');

    if (msgEl) {
      msgEl.textContent = '✓ ' + resultParts.join(', ');
      msgEl.removeAttribute('hidden');
      setTimeout(function () { msgEl.setAttribute('hidden', ''); }, 4000);
    }

    renderContribList();
    renderBulkMemberList();
  }

  // ─── Enroll / Edit form ──────────────────────────────
  function showEnrollForm(memberId, memberName, existingContrib) {
    _enrollMemberId  = memberId;
    _enrollContribId = existingContrib ? existingContrib.id : null;

    var container  = document.getElementById('enroll-form-container');
    var titleEl    = document.getElementById('enroll-form-title');
    var nameEl     = document.getElementById('enroll-member-name');
    var feeInput   = document.getElementById('enroll-monthly-fee');
    var guestInput = document.getElementById('enroll-guest-fee');
    var actInput   = document.getElementById('enroll-activation-date');
    var dueInput   = document.getElementById('enroll-due-day');
    var notesInput = document.getElementById('enroll-notes');
    var errEl      = document.getElementById('enroll-error');

    if (titleEl) titleEl.textContent = existingContrib ? 'Edit contribution' : 'Enroll in monthly';
    if (nameEl)  nameEl.textContent  = memberName || '';
    if (errEl)   errEl.textContent   = '';

    if (existingContrib) {
      if (feeInput)   feeInput.value   = existingContrib.monthlyFee    || '';
      if (guestInput) guestInput.value = existingContrib.guestFee      || Settings.getDefaultGuestFee();
      if (actInput)   { actInput.value   = existingContrib.activationDate|| ''; syncDatePicker('enroll-activation-date'); }
      if (dueInput)   dueInput.value   = existingContrib.dueDay        || 1;
      if (notesInput) notesInput.value = existingContrib.notes         || '';
    } else {
      if (feeInput)   feeInput.value   = '';
      if (guestInput) guestInput.value = Settings.getDefaultGuestFee();  // pre-fill from settings
      if (actInput)   { actInput.value   = getTodayISO(); syncDatePicker('enroll-activation-date'); }
      if (dueInput)   dueInput.value   = '1';
      if (notesInput) notesInput.value = '';
    }

    if (container) container.removeAttribute('hidden');
    if (feeInput)  feeInput.focus();
  }

  async function openEditContrib(memberId, contribId) {
    var c = await DB.getContribution(contribId);
    var m = await DB.getMember(memberId);
    if (!c || !m) { alert('Record not found.'); return; }
    showEnrollForm(memberId, m.name, c);
  }

  async function handleEnrollSave() {
    var feeInput   = document.getElementById('enroll-monthly-fee');
    var guestInput = document.getElementById('enroll-guest-fee');
    var actInput   = document.getElementById('enroll-activation-date');
    var dueInput   = document.getElementById('enroll-due-day');
    var notesInput = document.getElementById('enroll-notes');
    var errEl      = document.getElementById('enroll-error');
    if (errEl) errEl.textContent = '';

    var fee        = parseFloat(feeInput   ? feeInput.value   : 0);
    var guestFee   = parseFloat(guestInput ? guestInput.value : 0) || 0;
    var activation = (actInput  ? actInput.value  : '').trim();
    var dueDay     = parseInt(dueInput ? dueInput.value : 1, 10);
    var notes      = (notesInput ? notesInput.value : '').trim();

    if (isNaN(fee) || fee <= 0)               { if (errEl) errEl.textContent = 'Monthly fee must be greater than zero.'; return; }
    if (!activation)                           { if (errEl) errEl.textContent = 'Activation date is required.'; return; }
    if (isNaN(dueDay) || dueDay < 1 || dueDay > 28) { if (errEl) errEl.textContent = 'Due day must be 1–28.'; return; }

    // License limit checks
    var feeLimit  = License.checkMonthlyFee(fee);
    if (feeLimit)  { if (errEl) errEl.textContent = feeLimit; return; }
    var guestLimit = guestFee > 0 ? License.checkGuestFee(guestFee) : null;
    if (guestLimit) { if (errEl) errEl.textContent = guestLimit; return; }

    var contrib = {
      id:             _enrollContribId || DB.generateId(),
      memberId:       _enrollMemberId,
      monthlyFee:     fee,
      guestFee:       guestFee > 0 ? guestFee : Settings.getDefaultGuestFee(),
      activationDate: activation,
      dueDay:         dueDay,
      notes:          notes,
      status:         'active',
      createdAt:      _enrollContribId ? undefined : new Date().toISOString()
    };

    try {
      if (_enrollContribId) {
        var existing = await DB.getContribution(_enrollContribId);
        if (existing) contrib.createdAt = existing.createdAt;
        await DB.updateContribution(contrib);
      } else {
        await DB.addContribution(contrib);
      }
      hideEnrollForm();
      renderContribList();
    } catch (e) {
      if (errEl) errEl.textContent = 'Could not save: ' + e.message;
    }
  }

  async function deleteContrib(contribId) {
    if (!confirm('Remove monthly contribution for this member?')) return;
    try { await DB.deleteContribution(contribId); renderContribList(); }
    catch (e) { alert('Could not remove: ' + e.message); }
  }

  function hideEnrollForm() {
    var container = document.getElementById('enroll-form-container');
    if (container) container.setAttribute('hidden', '');
    _enrollMemberId  = null;
    _enrollContribId = null;
  }

  return { init, renderContribList };
})();
