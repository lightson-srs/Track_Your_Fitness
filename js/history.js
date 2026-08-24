const PaymentHistory = (function () {
  'use strict';

  // ─── Edit modal state ───
  var _editType   = null; // 'payment' | 'session'
  var _editId     = null;
  var _editRecord = null;

  function esc(s) {
    return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
  }
  function getTodayISO() { return new Date().toISOString().split('T')[0]; }

  function init() {
    var today      = getTodayISO();
    var monthStart = today.substring(0, 8) + '01';

    var startInput  = document.getElementById('history-start');
    var endInput    = document.getElementById('history-end');
    var searchInput = document.getElementById('history-search');
    var typeFilter  = document.getElementById('history-type-filter');
    var editCancel  = document.getElementById('history-edit-cancel');
    var editSave    = document.getElementById('history-edit-save');

    if (startInput && !startInput.value)  { startInput.value  = monthStart; syncDatePicker('history-start'); }
    if (endInput   && !endInput.value)    { endInput.value    = today;       syncDatePicker('history-end');   }

    if (startInput)  startInput.addEventListener('change', renderHistory);
    if (endInput)    endInput.addEventListener('change', renderHistory);
    if (searchInput) searchInput.addEventListener('input', renderHistory);
    if (typeFilter)  typeFilter.addEventListener('change', renderHistory);
    if (editCancel)  editCancel.addEventListener('click', hideEditModal);
    if (editSave)    editSave.addEventListener('click', handleEditSave);

    renderHistory();
  }

  async function renderHistory() {
    var container  = document.getElementById('history-list');
    if (!container) return;

    var startInput  = document.getElementById('history-start');
    var endInput    = document.getElementById('history-end');
    var searchInput = document.getElementById('history-search');
    var typeFilter  = document.getElementById('history-type-filter');

    var start      = startInput  ? startInput.value              : '';
    var end        = endInput    ? endInput.value                : '';
    var searchTerm = searchInput ? searchInput.value.trim().toLowerCase() : '';
    var typeVal    = typeFilter  ? typeFilter.value              : 'all';

    container.innerHTML = '<p class="empty-message">Loading…</p>';

    try {
      // ── Load all data ──
      var members  = await DB.getAllMembers();
      var memberMap = {};
      members.forEach(function (m) { memberMap[m.id] = m; });

      var payments = start && end
        ? await DB.getPaymentsByDateRange(start, end)
        : await DB.getAllPayments();

      var allSessions = await DB.getAllGuestSessions();
      var sessions = allSessions.filter(function (s) {
        if (start && s.date < start) return false;
        if (end   && s.date > end)   return false;
        return true;
      });

      var allFeeRecords = await DB.getAllMonthlyFeeRecords();
      var feeRecords = allFeeRecords.filter(function (r) {
        if (start && r.date < start) return false;
        if (end   && r.date > end)   return false;
        return true;
      });

      // ── Build unified timeline entries ──
      // kinds: 'monthly_fee', 'monthly_payment', 'guest_payment', 'guest_session'
      var entries = [];

      feeRecords.forEach(function (r) {
        var m = memberMap[r.memberId];
        var memberName = m ? m.name : 'Unknown';
        if (searchTerm && memberName.toLowerCase().indexOf(searchTerm) === -1) return;
        entries.push({
          kind:       'monthly_fee',
          date:       r.date,
          memberId:   r.memberId,
          memberName: memberName,
          record:     r
        });
      });

      payments.forEach(function (p) {
        var m = memberMap[p.memberId];
        var memberName = m ? m.name : 'Unknown';
        if (searchTerm && memberName.toLowerCase().indexOf(searchTerm) === -1) return;
        entries.push({
          kind:       p.type === 'monthly' ? 'monthly_payment' : 'guest_payment',
          date:       p.date,
          memberId:   p.memberId,
          memberName: memberName,
          record:     p
        });
      });

      sessions.forEach(function (s) {
        var m = memberMap[s.memberId];
        var memberName = m ? m.name : 'Unknown';
        if (searchTerm && memberName.toLowerCase().indexOf(searchTerm) === -1) return;
        entries.push({
          kind:       'guest_session',
          date:       s.date,
          memberId:   s.memberId,
          memberName: memberName,
          record:     s
        });
      });

      // ── Apply type filter ──
      if (typeVal !== 'all') {
        entries = entries.filter(function (e) { return e.kind === typeVal; });
      }

      // ── Sort by date desc, then by kind within same date ──
      var kindOrder = { monthly_fee: 0, monthly_payment: 1, guest_session: 2, guest_payment: 3 };
      entries.sort(function (a, b) {
        if (b.date !== a.date) return b.date.localeCompare(a.date);
        return (kindOrder[a.kind] || 0) - (kindOrder[b.kind] || 0);
      });

      // ── Pre-compute per-member monthly coverage (fees - payments, cumulative by date asc) ──
      // For each monthly_fee record, mark isCovered=true if cumulative payments >= cumulative fees at that date.
      var memberMonthlyEntries = {};
      entries.forEach(function (e) {
        if (e.kind !== 'monthly_fee' && e.kind !== 'monthly_payment') return;
        if (!memberMonthlyEntries[e.memberId]) memberMonthlyEntries[e.memberId] = [];
        memberMonthlyEntries[e.memberId].push(e);
      });
      Object.keys(memberMonthlyEntries).forEach(function (mid) {
        var mEntries = memberMonthlyEntries[mid].slice()
          .sort(function (a, b) { return a.date.localeCompare(b.date) || kindOrder[a.kind] - kindOrder[b.kind]; });
        var runningFees = 0, runningPaid = 0;
        mEntries.forEach(function (e) {
          if (e.kind === 'monthly_fee')     runningFees += e.record.fee    || 0;
          if (e.kind === 'monthly_payment') runningPaid += e.record.amount || 0;
          if (e.kind === 'monthly_fee') {
            e._isCovered = runningPaid >= runningFees;
            e._runningBalance = runningFees - runningPaid;
          }
        });
      });

      if (entries.length === 0) {
        container.innerHTML = '<p class="empty-message">No records found.</p>';
        return;
      }

      // ── Summary ──
      var totalPaid         = entries.filter(function (e) { return e.kind === 'monthly_payment' || e.kind === 'guest_payment'; })
                                    .reduce(function (s, e) { return s + (e.record.amount || 0); }, 0);
      // Guest outstanding = total session fees - total guest payments (within filtered range)
      var totalGuestFees    = entries.filter(function (e) { return e.kind === 'guest_session'; })
                                    .reduce(function (s, e) { return s + (e.record.fee || 0); }, 0);
      var totalGuestPaid    = entries.filter(function (e) { return e.kind === 'guest_payment'; })
                                    .reduce(function (s, e) { return s + (e.record.amount || 0); }, 0);
      var pendingGuestAmt   = Math.max(0, totalGuestFees - totalGuestPaid);
      // Monthly outstanding = total fee records - total monthly payments (within filtered range)
      var totalMonthlyFees  = entries.filter(function (e) { return e.kind === 'monthly_fee'; })
                                    .reduce(function (s, e) { return s + (e.record.fee || 0); }, 0);
      var totalMonthlyPaid2 = entries.filter(function (e) { return e.kind === 'monthly_payment'; })
                                    .reduce(function (s, e) { return s + (e.record.amount || 0); }, 0);
      var pendingMonthlyAmt = Math.max(0, totalMonthlyFees - totalMonthlyPaid2);

      var html = '<div class="history-summary">';
      html += entries.length + ' record(s) · Collected: <strong>₹' + totalPaid.toFixed(2) + '</strong>';
      if (pendingMonthlyAmt > 0) html += ' · Monthly pending: <strong class="amount-due">₹' + pendingMonthlyAmt.toFixed(2) + '</strong>';
      if (pendingGuestAmt   > 0) html += ' · Guest pending: <strong class="amount-due">₹'   + pendingGuestAmt.toFixed(2)   + '</strong>';
      html += '</div>';

      // ── Group by date ──
      var byDate = {};
      var dateOrder = [];
      entries.forEach(function (e) {
        if (!byDate[e.date]) { byDate[e.date] = []; dateOrder.push(e.date); }
        byDate[e.date].push(e);
      });
      // deduplicate dateOrder (sort already done)
      dateOrder = dateOrder.filter(function (d, i) { return dateOrder.indexOf(d) === i; });

      dateOrder.forEach(function (date) {
        html += '<div class="history-date-group">';
        html += '<div class="history-date-header">' + fmtDate(date) + '</div>';

        byDate[date].forEach(function (entry) {
          var r = entry.record;

          // ── Config per kind ──
          var badgeClass, badgeLabel, amountHtml, statusHtml = '', extraHtml = '';

          if (entry.kind === 'monthly_fee') {
            var isCovered = entry._isCovered;
            badgeClass  = isCovered ? 'badge-monthly' : 'badge-expense';
            badgeLabel  = 'Monthly fee';
            amountHtml  = isCovered
              ? '<span class="amount-paid">₹' + (r.fee || 0).toFixed(2) + ' covered</span>'
              : '<span class="amount-due">₹' + (r.fee || 0).toFixed(2) + ' pending</span>';
            if (r.period) extraHtml = '<span class="loan-notes">Period: ' + fmtPeriod(r.period) + '</span>';

          } else if (entry.kind === 'monthly_payment') {
            badgeClass  = 'badge-monthly';
            badgeLabel  = 'Monthly payment';
            amountHtml  = '<strong class="amount-paid">₹' + (r.amount || 0).toFixed(2) + '</strong>';

          } else if (entry.kind === 'guest_payment') {
            badgeClass  = 'badge-guest';
            badgeLabel  = 'Guest payment';
            amountHtml  = '<strong class="amount-paid">₹' + (r.amount || 0).toFixed(2) + '</strong>';

          } else { // guest_session
            badgeClass = 'badge-guest';
            badgeLabel = 'Guest session';
            amountHtml = '<span class="amount-due">₹' + (r.fee || 0).toFixed(2) + ' fee</span>';
          }

          html += '<div class="client-card history-entry-card">';
          html += '<div class="client-header">';
          html += '<div class="client-info">';
          html += '<div class="client-name">' + esc(entry.memberName) + '</div>';
          html += '<div class="loan-item-info">';
          html += '<span class="loan-type-badge ' + badgeClass + '">' + badgeLabel + '</span> ';
          html += amountHtml;
          if (extraHtml) html += ' ' + extraHtml;
          if (r.notes) html += ' <span class="loan-notes">' + esc(r.notes) + '</span>';
          html += '</div></div>';

          // Action buttons
          html += '<div class="client-actions">';
          // Edit buttons
          if (entry.kind === 'monthly_payment' || entry.kind === 'guest_payment') {
            html += '<button class="btn-icon btn-edit-history" data-type="payment" data-id="' + r.id + '" title="Edit">✏️</button>';
          } else if (entry.kind === 'guest_session' && r.status === 'pending') {
            html += '<button class="btn-icon btn-edit-history" data-type="session" data-id="' + r.id + '" title="Edit">✏️</button>';
          } else if (entry.kind === 'monthly_fee') {
            html += '<button class="btn-icon btn-edit-history" data-type="monthly_fee" data-id="' + r.id + '" title="Edit">✏️</button>';
          }
          // Delete buttons
          if (entry.kind === 'monthly_payment' || entry.kind === 'guest_payment') {
            html += '<button class="btn-icon btn-delete-history" data-type="payment" data-id="' + r.id + '" title="Delete">🗑️</button>';
          } else if (entry.kind === 'guest_session') {
            html += '<button class="btn-icon btn-delete-history" data-type="session" data-id="' + r.id + '" title="Delete">🗑️</button>';
          } else if (entry.kind === 'monthly_fee') {
            html += '<button class="btn-icon btn-delete-history" data-type="monthly_fee" data-id="' + r.id + '" title="Delete">🗑️</button>';
          }
          html += '</div></div></div>';
        });

        html += '</div>'; // history-date-group
      });

      container.innerHTML = html;

      container.querySelectorAll('.btn-edit-history').forEach(function (btn) {
        btn.addEventListener('click', function () { openEditModal(btn.dataset.type, btn.dataset.id); });
      });
      container.querySelectorAll('.btn-delete-history').forEach(function (btn) {
        btn.addEventListener('click', function () { deleteRecord(btn.dataset.type, btn.dataset.id); });
      });

    } catch (e) {
      container.innerHTML = '<p class="empty-message">Could not load history.</p>';
      console.error(e);
    }
  }

  // ─── Edit modal ──────────────────────────────────────
  async function openEditModal(type, id) {
    var record;
    if (type === 'payment') {
      record = await DB.getPayment(id);
    } else if (type === 'session') {
      record = await DB.getGuestSession(id);
    } else {
      record = await DB.getMonthlyFeeRecord(id);
    }
    if (!record) { alert('Record not found.'); return; }

    _editType   = type;
    _editId     = id;
    _editRecord = record;

    var modal      = document.getElementById('history-edit-modal');
    var titleEl    = document.getElementById('history-edit-title');
    var dateInput  = document.getElementById('history-edit-date');
    var amountWrap = document.getElementById('history-edit-amount-wrap');
    var amountInput= document.getElementById('history-edit-amount');
    var feeWrap    = document.getElementById('history-edit-fee-wrap');
    var feeInput   = document.getElementById('history-edit-fee');
    var notesInput = document.getElementById('history-edit-notes');
    var errEl      = document.getElementById('history-edit-error');

    if (errEl) errEl.textContent = '';

    if (type === 'payment') {
      if (titleEl)     titleEl.textContent  = record.type === 'monthly' ? 'Edit monthly payment' : 'Edit guest payment';
      if (dateInput)   { dateInput.value      = record.date   || ''; syncDatePicker('history-edit-date'); }
      if (amountInput) amountInput.value    = record.amount || '';
      if (notesInput)  notesInput.value     = record.notes  || '';
      if (amountWrap)  amountWrap.removeAttribute('hidden');
      if (feeWrap)     feeWrap.setAttribute('hidden', '');
    } else if (type === 'monthly_fee') {
      if (titleEl)    titleEl.textContent   = 'Edit monthly fee record';
      if (dateInput)  { dateInput.value       = record.date   || ''; syncDatePicker('history-edit-date'); }
      if (feeInput)   feeInput.value        = record.fee    || '';
      if (notesInput) notesInput.value      = record.notes  || '';
      if (amountWrap) amountWrap.setAttribute('hidden', '');
      if (feeWrap)    feeWrap.removeAttribute('hidden');
    } else {
      if (titleEl)    titleEl.textContent   = 'Edit guest session';
      if (dateInput)  { dateInput.value       = record.date   || ''; syncDatePicker('history-edit-date'); }
      if (feeInput)   feeInput.value        = record.fee    || '';
      if (notesInput) notesInput.value      = record.notes  || '';
      if (amountWrap) amountWrap.setAttribute('hidden', '');
      if (feeWrap)    feeWrap.removeAttribute('hidden');
    }

    if (modal) modal.removeAttribute('hidden');
  }

  async function handleEditSave() {
    var dateInput   = document.getElementById('history-edit-date');
    var amountInput = document.getElementById('history-edit-amount');
    var feeInput    = document.getElementById('history-edit-fee');
    var notesInput  = document.getElementById('history-edit-notes');
    var errEl       = document.getElementById('history-edit-error');
    if (errEl) errEl.textContent = '';

    var date  = dateInput  ? dateInput.value.trim()  : '';
    var notes = notesInput ? notesInput.value.trim()  : '';

    if (!date) { if (errEl) errEl.textContent = 'Date is required.'; return; }

    try {
      if (_editType === 'payment') {
        var amount = parseFloat(amountInput ? amountInput.value : 0);
        if (isNaN(amount) || amount <= 0) { if (errEl) errEl.textContent = 'Amount must be greater than zero.'; return; }
        _editRecord.date   = date;
        _editRecord.amount = amount;
        _editRecord.notes  = notes;
        await DB.updatePayment(_editRecord);
      } else if (_editType === 'monthly_fee') {
        var fee = parseFloat(feeInput ? feeInput.value : 0);
        if (isNaN(fee) || fee <= 0) { if (errEl) errEl.textContent = 'Fee must be greater than zero.'; return; }
        _editRecord.date   = date;
        _editRecord.fee    = fee;
        _editRecord.period = date.substring(0, 7);
        _editRecord.notes  = notes;
        await DB.updateMonthlyFeeRecord(_editRecord);
      } else {
        var fee = parseFloat(feeInput ? feeInput.value : 0);
        if (isNaN(fee) || fee <= 0) { if (errEl) errEl.textContent = 'Fee must be greater than zero.'; return; }
        _editRecord.date  = date;
        _editRecord.fee   = fee;
        _editRecord.notes = notes;
        await DB.updateGuestSession(_editRecord);
      }
      hideEditModal();
      renderHistory();
    } catch (e) {
      if (errEl) errEl.textContent = 'Could not save: ' + e.message;
    }
  }

  function hideEditModal() {
    var modal = document.getElementById('history-edit-modal');
    if (modal) modal.setAttribute('hidden', '');
    _editType = null; _editId = null; _editRecord = null;
  }

  // ─── Delete ──────────────────────────────────────────
  async function deleteRecord(type, id) {
    var label = type === 'payment' ? 'payment record' : 'guest session record';
    if (!confirm('Delete this ' + label + '?')) return;
    try {
      if (type === 'payment') {
        await DB.deletePayment(id);
      } else if (type === 'monthly_fee') {
        if (!confirm('Delete this monthly fee record? This will affect outstanding balance calculations.')) return;
        await DB.deleteMonthlyFeeRecord(id);
      } else {
        var s = await DB.getGuestSession(id);
        if (s && s.status === 'collected') {
          if (!confirm('This session has already been collected. Deleting it will NOT reverse the payment. Continue?')) return;
        }
        await DB.deleteGuestSession(id);
      }
      renderHistory();
    } catch (e) {
      alert('Could not delete: ' + e.message);
    }
  }

  return { init, renderHistory };
})();
