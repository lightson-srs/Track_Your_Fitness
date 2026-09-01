const Monthly = (function () {
  'use strict';

  function esc(s) {
    return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
  }
  function getTodayISO() { return new Date().toISOString().split('T')[0]; }

  function init() {
    var dateInput    = document.getElementById('monthly-ref-date');
    var searchInput  = document.getElementById('monthly-search');
    var unpaidFilter = document.getElementById('monthly-filter-unpaid');
    var confirmBtn   = document.getElementById('monthly-confirm-btn');
    var cancelBtn    = document.getElementById('monthly-cancel-btn');

    if (dateInput)    { if (!dateInput.value) { dateInput.value = getTodayISO(); syncDatePicker('monthly-ref-date'); } dateInput.addEventListener('change', renderMonthlyList); }
    if (searchInput)  searchInput.addEventListener('input', renderMonthlyList);
    if (unpaidFilter) unpaidFilter.addEventListener('change', renderMonthlyList);
    if (confirmBtn)   confirmBtn.addEventListener('click', handleConfirmPayment);
    if (cancelBtn)    cancelBtn.addEventListener('click', hidePaymentModal);

    renderMonthlyList();
  }

  // ─── Period boundary for a contribution + reference date ───
  // Returns { start, end, label } for the billing period that contains refDate.
  function getPeriodForDate(refDate, contrib) {
    var anchorDay = contrib.dueDay || 1;
    if (anchorDay < 1) anchorDay = 1;
    if (anchorDay > 28) anchorDay = 28;

    var refD = new Date(refDate + 'T00:00:00');
    // Period start = anchorDay of a month that is <= refDate
    var periodStart = new Date(refD.getFullYear(), refD.getMonth(), anchorDay);
    if (periodStart > refD) {
      periodStart = new Date(refD.getFullYear(), refD.getMonth() - 1, anchorDay);
    }
    var periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, anchorDay - 1);

    return {
      start: periodStart.toISOString().split('T')[0],
      end:   periodEnd.toISOString().split('T')[0],
      label: periodStart.toLocaleString('default', { month: 'short', year: 'numeric' })
    };
  }

  // ─── Calculate cumulative balance for a member/contribution up to refDate ───
  // Uses actual monthly_fee_records (charges) vs monthly payments (credits).
  // This ensures balance reflects real fee applications, not theoretical period counting.
  // balance > 0 → amount owed; balance < 0 → advance credit.
  async function calcMemberBalance(member, contrib, refDate) {
    if (!contrib || !contrib.activationDate) return { totalOwed: 0, totalPaid: 0, balance: 0, periods: [], currentPeriod: null };

    var currentPeriod = getPeriodForDate(refDate, contrib);

    // Sum all monthly payments up to refDate
    var payments = await DB.getPaymentsByMember(member.id);
    var monthlyPaid = payments.filter(function (p) {
                                return p.type === 'monthly' && p.date <= refDate;
                              })
                              .reduce(function (s, p) { return s + (p.amount || 0); }, 0);

    // Sum all monthly fee records up to refDate (actual charges applied)
    var feeRecords = await DB.getMonthlyFeeRecordsByMember(member.id);
    var applicableFees = feeRecords.filter(function (r) { return r.date <= refDate; });
    var totalOwed = applicableFees.reduce(function (s, r) { return s + (r.fee || 0); }, 0);

    // If no fee records exist yet, fall back to period-counting so balance
    // still shows for members enrolled before fee-records were introduced.
    if (applicableFees.length === 0) {
      var actDate = new Date(contrib.activationDate + 'T00:00:00');
      var refD    = new Date(refDate + 'T00:00:00');
      if (actDate > refD) return { totalOwed: 0, totalPaid: monthlyPaid, balance: -monthlyPaid, periods: [], currentPeriod: currentPeriod };

      var anchorDay = contrib.dueDay || 1;
      if (anchorDay > 28) anchorDay = 28;

      var cursor = new Date(actDate.getFullYear(), actDate.getMonth(), anchorDay);
      if (cursor > actDate) cursor = new Date(actDate.getFullYear(), actDate.getMonth() - 1, anchorDay);

      var periods = [];
      var maxIter = 120;
      for (var iter = 0; iter < maxIter; iter++) {
        var pStart = cursor.toISOString().split('T')[0];
        if (pStart > currentPeriod.start) break;
        var pEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, anchorDay - 1).toISOString().split('T')[0];
        periods.push({ start: pStart, end: pEnd, label: cursor.toLocaleString('default', { month: 'short', year: 'numeric' }) });
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, anchorDay);
      }

      totalOwed = periods.length * (contrib.monthlyFee || 0);
      var balance = totalOwed - monthlyPaid;
      return { totalOwed, totalPaid: monthlyPaid, balance, periods, currentPeriod };
    }

    // Build periods list from actual fee records for display
    var periods = applicableFees.map(function (r) {
      return { start: r.date, end: r.date, label: r.period ? fmtPeriod(r.period) : r.date };
    });

    var balance = totalOwed - monthlyPaid;
    return { totalOwed, totalPaid: monthlyPaid, balance, periods, currentPeriod };
  }

  // ─── Check if a member's monthly fee is fully paid for the period containing date ───
  // Used by Sessions to hide already-paid monthly members.
  async function isMonthlyPaidForPeriod(member, refDate) {
    var contrib = await DB.getContributionByMember(member.id);
    if (!contrib) return false;
    var bal = await calcMemberBalance(member, contrib, refDate);
    return bal.balance <= 0;
  }

  async function renderMonthlyList() {
    var container    = document.getElementById('monthly-list');
    if (!container) return;
    var dateInput    = document.getElementById('monthly-ref-date');
    var searchInput  = document.getElementById('monthly-search');
    var unpaidFilter = document.getElementById('monthly-filter-unpaid');
    var refDate      = dateInput    ? dateInput.value    : getTodayISO();
    var searchTerm   = searchInput  ? searchInput.value.trim().toLowerCase() : '';
    var showUnpaid   = unpaidFilter ? unpaidFilter.checked : false;

    container.innerHTML = '<p class="empty-message">Loading…</p>';

    try {
      var members  = await DB.getAllMembers();
      var contribs = await DB.getAllContributions();
      var contribMap = {};
      contribs.forEach(function (c) { contribMap[c.memberId] = c; });

      // Only active members with a contribution enrolled
      members = members.filter(function (m) {
        return m.status !== 'inactive' && contribMap[m.id];
      });
      if (searchTerm) members = members.filter(function (m) { return m.name.toLowerCase().indexOf(searchTerm) !== -1 || (m.memberType && m.memberType.toLowerCase().indexOf(searchTerm) !== -1) || (m.notes && m.notes.toLowerCase().indexOf(searchTerm) !== -1); });
      members.sort(function (a, b) { return a.name.localeCompare(b.name); });

      var items = [];
      for (var i = 0; i < members.length; i++) {
        var m = members[i];
        var c = contribMap[m.id];
        var bal = await calcMemberBalance(m, c, refDate);
        items.push({ member: m, contrib: c, bal: bal });
      }

      if (showUnpaid) items = items.filter(function (it) { return it.bal.balance > 0; });

      if (items.length === 0) { container.innerHTML = '<p class="empty-message">No members to show.</p>'; return; }

      var html = '';
      items.forEach(function (it) {
        var m = it.member, c = it.contrib, bal = it.bal;
        var statusClass = bal.balance <= 0 ? ' paid-row' : '';
        var balLabel = bal.balance > 0
          ? '<span class="amount-due">₹' + bal.balance.toFixed(2) + ' due</span>'
          : '<span class="amount-paid">₹' + Math.abs(bal.balance).toFixed(2) + ' advance</span>';

        html += '<div class="client-card' + statusClass + '">';
        html += '<div class="client-header">';
        html += '<div class="client-info">';
        html += '<div class="client-name">' + esc(m.name) + '</div>';
        html += '<div class="client-mobile">' + esc(m.mobile) + '</div>';
        html += '<div class="loan-item-info">';
        html += '<span class="loan-type-badge badge-monthly">₹' + (c.monthlyFee||0).toFixed(0) + '/mo</span> ';
        html += balLabel;
        if (bal.currentPeriod) html += ' <span class="loan-notes">Period: ' + esc(bal.currentPeriod.label) + '</span>';
        html += '</div></div>';
        html += '<div class="client-actions">';
        html += '<button class="btn btn-collect btn-collect-monthly" data-id="' + m.id + '" data-fee="' + (c.monthlyFee||0) + '" data-balance="' + bal.balance + '" data-name="' + esc(m.name) + '">Collect</button>';
        if (bal.balance > 0) {
          html += '<button class="btn btn-sm btn-whatsapp btn-remind-monthly" data-mobile="' + esc(m.mobile) + '" data-name="' + esc(m.name) + '" data-balance="' + bal.balance + '" data-fee="' + (c.monthlyFee||0) + '">📱</button>';
        }
        html += '</div></div></div>';
      });

      container.innerHTML = html;
      container.querySelectorAll('.btn-collect-monthly').forEach(function (btn) {
        btn.addEventListener('click', function () {
          showPaymentModal(btn.dataset.id, parseFloat(btn.dataset.fee), parseFloat(btn.dataset.balance), btn.dataset.name);
        });
      });
      container.querySelectorAll('.btn-remind-monthly').forEach(function (btn) {
        btn.addEventListener('click', function () {
          WhatsApp.sendMonthlyReminder(btn.dataset.mobile, btn.dataset.name, parseFloat(btn.dataset.balance), parseFloat(btn.dataset.fee));
        });
      });
    } catch (e) {
      container.innerHTML = '<p class="empty-message">Could not load data.</p>';
      console.error(e);
    }
  }

  // ─── Payment modal ───
  var _pendingMemberId = null;

  function showPaymentModal(memberId, fee, balance, memberName) {
    _pendingMemberId = memberId;
    var modal      = document.getElementById('monthly-payment-modal');
    var titleEl    = document.getElementById('monthly-modal-member');
    var amountInput= document.getElementById('monthly-payment-amount');
    var balanceEl  = document.getElementById('monthly-modal-balance');
    var qrContainer= document.getElementById('monthly-qr-container');

    if (titleEl)     titleEl.textContent = memberName;
    if (amountInput) amountInput.value   = balance > 0 ? balance.toFixed(2) : fee.toFixed(2);
    if (balanceEl) {
      if (balance > 0) { balanceEl.textContent = '₹' + balance.toFixed(2) + ' outstanding'; balanceEl.className = 'amount-due'; }
      else             { balanceEl.textContent = '₹' + Math.abs(balance).toFixed(2) + ' advance credit'; balanceEl.className = 'amount-paid'; }
    }
    if (qrContainer) _renderQR(qrContainer, balance > 0 ? balance : fee, memberName);
    if (modal) modal.removeAttribute('hidden');
  }

  function _renderQR(container, amount, memberName) {
    container.innerHTML = '';
    var upiId = Settings.getUpiId();
    if (!upiId) { container.innerHTML = '<p class="empty-message">Set UPI ID in Settings to show QR.</p>'; return; }
    if (typeof QRCode === 'undefined') { container.innerHTML = '<p class="empty-message">QR library not loaded.</p>'; return; }
    var upiUrl = 'upi://pay?pa=' + encodeURIComponent(upiId) +
      '&pn=' + encodeURIComponent(Settings.getAppName()) +
      '&am=' + amount.toFixed(2) + '&cu=INR' +
      '&tn=' + encodeURIComponent('Monthly - ' + memberName);
    var div = document.createElement('div');
    container.appendChild(div);
    try { new QRCode(div, { text: upiUrl, width: 160, height: 160, correctLevel: QRCode.CorrectLevel.M }); }
    catch (e) { container.innerHTML = '<p class="empty-message">QR generation failed.</p>'; console.error(e); }
  }

  async function handleConfirmPayment() {
    if (!_pendingMemberId) return;
    var amountInput = document.getElementById('monthly-payment-amount');
    var amount = parseFloat(amountInput ? amountInput.value : 0);
    if (isNaN(amount) || amount <= 0) { alert('Enter a valid amount.'); return; }

    // License limit — uses inline global defined in index.html (always available)
    var _mFeeErr = window._checkMonthlyFee ? window._checkMonthlyFee(amount) : null;
    if (_mFeeErr) { alert(_mFeeErr); return; }

    var dateInput = document.getElementById('monthly-ref-date');
    var refDate   = dateInput ? dateInput.value : getTodayISO();
    var payment   = { id: DB.generateId(), memberId: _pendingMemberId, date: refDate, amount: amount, type: 'monthly', createdAt: new Date().toISOString() };

    try {
      await DB.addPayment(payment);

      // Fee records are NOT marked collected — outstanding is always derived as
      // sum(fee records ≤ date) - sum(payments ≤ date), same as Sessions logic.
      var member  = await DB.getMember(_pendingMemberId);
      var contrib = await DB.getContributionByMember(_pendingMemberId);

      // Update member's validTill to end of the paid billing period
      if (member && contrib) {
        var period = getPeriodForDate(refDate, contrib);
        if (period && period.end) {
          member.validTill = period.end;
          await DB.updateMember(member);
        }
      }

      hidePaymentModal();
      renderMonthlyList();

      if (member && WhatsApp.shouldConfirmMonthly()) {
        var bal = await calcMemberBalance(member, contrib, refDate);
        WhatsApp.sendMonthlyConfirmation(member.mobile, member.name, amount, refDate, Math.max(0, bal.balance));
      }
    } catch (e) { alert('Could not save payment: ' + e.message); }
  }

  function hidePaymentModal() {
    var modal = document.getElementById('monthly-payment-modal');
    if (modal) modal.setAttribute('hidden', '');
    _pendingMemberId = null;
  }

  return { init, renderMonthlyList, getPeriodForDate, calcMemberBalance, isMonthlyPaidForPeriod };
})();
