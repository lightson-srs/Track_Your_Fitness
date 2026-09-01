const Reports = (function () {
  'use strict';

  var _activeTab = 'daywise';

  function esc(s) {
    return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
  }

  function init() {
    var today      = new Date().toISOString().split('T')[0];
    var monthStart = today.substring(0, 8) + '01';

    // Set default date ranges
    ['report-start','report-start-mw','report-start-balance','report-start-att'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && !el.value) { el.value = monthStart; syncDatePicker(id); }
    });
    ['report-end','report-end-mw','report-end-balance','report-outstanding-date','report-end-att'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && !el.value) { el.value = today; syncDatePicker(id); }
    });

    // Tab buttons
    document.querySelectorAll('.report-tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
    });

    // Change listeners — one per filter element, all panels
    ['report-start','report-end',
     'report-start-mw','report-end-mw',
     'report-start-balance','report-end-balance',
     'report-outstanding-date',
     'report-start-att','report-end-att'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', renderActiveReport);
    });
    // Attendance report filter inputs
    var attOperator = document.getElementById('report-att-operator');
    var attDays = document.getElementById('report-att-days');
    if (attOperator) attOperator.addEventListener('change', renderActiveReport);
    if (attDays) attDays.addEventListener('input', renderActiveReport);
    ['report-search','report-search-mw','report-search-os','report-search-att'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', renderActiveReport);
    });

    var printBtn = document.getElementById('report-print-btn');
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

    switchTab('daywise');
  }

  function switchTab(tab) {
    _activeTab = tab;

    // Update tab button states
    document.querySelectorAll('.report-tab-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    // Show/hide tab panels
    document.querySelectorAll('.report-tab-panel').forEach(function (panel) {
      if (panel.dataset.tab === tab) {
        panel.removeAttribute('hidden');
      } else {
        panel.setAttribute('hidden', '');
      }
    });

    renderActiveReport();
  }

  function renderActiveReport() {
    // Scroll the active panel to top before rendering new content
    var activePanel = document.querySelector('.report-tab-panel:not([hidden])');
    if (activePanel) activePanel.scrollTop = 0;
    switch (_activeTab) {
      case 'daywise':     renderDaywise();     break;
      case 'memberwise':  renderMemberwise();  break;
      case 'outstanding': renderOutstanding(); break;
      case 'balance':     renderBalance();     break;
      case 'attendance':  renderAttendanceReport(); break;
    }
  }

  // ── Shared helpers ──────────────────────────────────
  function getDateRange(startId, endId) {
    var s = document.getElementById(startId);
    var e = document.getElementById(endId);
    return { start: s ? s.value : '', end: e ? e.value : '' };
  }
  function getSearch(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim().toLowerCase() : '';
  }

  // ── Day-wise ────────────────────────────────────────
  async function renderDaywise() {
    var container = document.getElementById('report-output-daywise');
    if (!container) return;
    var { start, end } = getDateRange('report-start', 'report-end');
    var searchTerm = getSearch('report-search');
    container.innerHTML = '<p class="empty-message">Loading…</p>';

    try {
      var payments = start && end ? await DB.getPaymentsByDateRange(start, end) : await DB.getAllPayments();
      var members  = await DB.getAllMembers();
      var memberMap = {};
      members.forEach(function (m) { memberMap[m.id] = m; });

      if (searchTerm) {
        payments = payments.filter(function (p) {
          var m = memberMap[p.memberId]; return m && m.name.toLowerCase().indexOf(searchTerm) !== -1;
        });
      }

      var byDate = {};
      payments.forEach(function (p) {
        if (!byDate[p.date]) byDate[p.date] = { monthly: 0, guest_play: 0, total: 0 };
        byDate[p.date][p.type] = (byDate[p.date][p.type] || 0) + (p.amount || 0);
        byDate[p.date].total  += p.amount || 0;
      });

      var dates = Object.keys(byDate).sort().reverse();
      if (!dates.length) { container.innerHTML = '<p class="empty-message">No data.</p>'; return; }

      var grand = payments.reduce(function (s, p) { return s + (p.amount || 0); }, 0);
      var html  = '<div class="history-summary">Grand total: <strong>₹' + grand.toFixed(2) + '</strong></div>';
      html += '<table class="report-table"><thead><tr><th>Date</th><th>Monthly</th><th>Sessions</th><th>Total</th></tr></thead><tbody>';
      dates.forEach(function (d) {
        var row = byDate[d];
        html += '<tr><td>' + fmtDate(d) + '</td><td>₹' + (row.monthly||0).toFixed(2) + '</td><td>₹' + (row.guest_play||0).toFixed(2) + '</td><td><strong>₹' + row.total.toFixed(2) + '</strong></td></tr>';
      });
      html += '</tbody></table>';
      container.innerHTML = html;
    } catch (e) { container.innerHTML = '<p class="empty-message">Error loading report.</p>'; console.error(e); }
  }

  // ── Member-wise ─────────────────────────────────────
  async function renderMemberwise() {
    var container = document.getElementById('report-output-memberwise');
    if (!container) return;
    var { start, end } = getDateRange('report-start-mw', 'report-end-mw');
    var searchTerm = getSearch('report-search-mw');
    container.innerHTML = '<p class="empty-message">Loading…</p>';

    try {
      var payments = start && end ? await DB.getPaymentsByDateRange(start, end) : await DB.getAllPayments();
      var members  = await DB.getAllMembers();

      if (searchTerm) members = members.filter(function (m) { return m.name.toLowerCase().indexOf(searchTerm) !== -1; });

      var byMember = {};
      payments.forEach(function (p) {
        if (!byMember[p.memberId]) byMember[p.memberId] = { monthly: 0, guest_play: 0, total: 0 };
        byMember[p.memberId][p.type] = (byMember[p.memberId][p.type] || 0) + (p.amount || 0);
        byMember[p.memberId].total  += p.amount || 0;
      });

      members.sort(function (a, b) { return a.name.localeCompare(b.name); });
      var grand = payments.reduce(function (s, p) { return s + (p.amount || 0); }, 0);
      var html  = '<div class="history-summary">Grand total: <strong>₹' + grand.toFixed(2) + '</strong></div>';
      html += '<table class="report-table"><thead><tr><th>Member</th><th>Monthly</th><th>Sessions</th><th>Total</th></tr></thead><tbody>';
      members.forEach(function (m) {
        var row = byMember[m.id] || { monthly: 0, guest_play: 0, total: 0 };
        html += '<tr><td>' + esc(m.name) + '</td><td>₹' + row.monthly.toFixed(2) + '</td><td>₹' + row.guest_play.toFixed(2) + '</td><td><strong>₹' + row.total.toFixed(2) + '</strong></td></tr>';
      });
      html += '</tbody></table>';
      container.innerHTML = html;
    } catch (e) { container.innerHTML = '<p class="empty-message">Error loading report.</p>'; console.error(e); }
  }

  // ── Outstanding ─────────────────────────────────────
  async function renderOutstanding() {
    var container = document.getElementById('report-output-outstanding');
    if (!container) return;
    var searchTerm  = getSearch('report-search-os');
    var refDateEl   = document.getElementById('report-outstanding-date');
    var refDate     = refDateEl && refDateEl.value ? refDateEl.value : new Date().toISOString().split('T')[0];
    container.innerHTML = '<p class="empty-message">Loading…</p>';

    try {
      var members  = await DB.getAllMembers();
      var contribs = await DB.getAllContributions();
      var contribMap = {};
      contribs.forEach(function (c) { contribMap[c.memberId] = c; });

      var enrolled = members.filter(function (m) { return m.status !== 'inactive' && contribMap[m.id]; });
      if (searchTerm) enrolled = enrolled.filter(function (m) { return m.name.toLowerCase().indexOf(searchTerm) !== -1; });
      enrolled.sort(function (a, b) { return a.name.localeCompare(b.name); });

      var html = '<div class="history-summary" style="margin-bottom:4px;">Outstanding as of <strong>' + refDate + '</strong></div>';
      html += '<table class="report-table"><thead><tr><th>Member</th><th>Paid</th><th>Balance</th></tr></thead><tbody>';
      var totalOutstanding = 0;

      for (var i = 0; i < enrolled.length; i++) {
        var m   = enrolled[i];
        var c   = contribMap[m.id];
        var bal = await Monthly.calcMemberBalance(m, c, refDate);
        if (bal.balance > 0) totalOutstanding += bal.balance;
        var balClass = bal.balance > 0 ? 'amount-due' : 'amount-paid';
        var balText  = bal.balance > 0
          ? '₹' + bal.balance.toFixed(2)
          : bal.balance < 0 ? '₹' + Math.abs(bal.balance).toFixed(2) + ' adv' : '✓ Clear';
        html += '<tr><td>' + esc(m.name) + '</td><td>₹' + bal.totalPaid.toFixed(2) + '</td><td class="' + balClass + '">' + balText + '</td></tr>';
      }
      html += '</tbody></table>';
      html += '<div class="history-summary">Total outstanding: <strong class="amount-due">₹' + totalOutstanding.toFixed(2) + '</strong></div>';
      container.innerHTML = html;
    } catch (e) { container.innerHTML = '<p class="empty-message">Error loading report.</p>'; console.error(e); }
  }

  // ── Balance summary ─────────────────────────────────
  async function renderBalance() {
    var container = document.getElementById('report-output-balance');
    if (!container) return;
    var { start, end } = getDateRange('report-start-balance', 'report-end-balance');
    container.innerHTML = '<p class="empty-message">Loading…</p>';

    try {
      var today   = new Date().toISOString().split('T')[0];
      var refDate = end || today;

      // ── Collections in selected period ──
      var payments  = start && end ? await DB.getPaymentsByDateRange(start, end) : await DB.getAllPayments();
      var expenses  = start && end ? await DB.getExpensesByDateRange(start, end)  : await DB.getAllExpenses();

      var totalMonthly = 0, totalGuest = 0, totalCollection = 0;
      payments.forEach(function (p) {
        if (p.type === 'monthly')    totalMonthly += p.amount || 0;
        if (p.type === 'guest_play') totalGuest   += p.amount || 0;
        totalCollection += p.amount || 0;
      });
      var totalExpenses = expenses.reduce(function (s, ex) { return s + (ex.amount || 0); }, 0);
      var netBalance    = totalCollection - totalExpenses;
      var balClass      = netBalance >= 0 ? 'amount-paid' : 'amount-due';

      // ── Cumulative outstanding as of END date — uses same logic as Outstanding report ──
      var allMembers = await DB.getAllMembers();
      var allContribs = await DB.getAllContributions();
      var contribMap2 = {};
      allContribs.forEach(function (c) { contribMap2[c.memberId] = c; });

      var cumMonthlyOutstanding = 0;
      var enrolledMembers = allMembers.filter(function (m) { return m.status !== 'inactive' && contribMap2[m.id]; });
      for (var bi = 0; bi < enrolledMembers.length; bi++) {
        var bm = enrolledMembers[bi];
        var bc = contribMap2[bm.id];
        if (typeof Monthly !== 'undefined' && Monthly.calcMemberBalance) {
          var bBal = await Monthly.calcMemberBalance(bm, bc, refDate);
          if (bBal.balance > 0) cumMonthlyOutstanding += bBal.balance;
        }
      }

      // Guest outstanding
      var allSessions     = await DB.getAllGuestSessions();
      var allPayments2    = await DB.getAllPayments();
      var cumGuestFees    = allSessions.filter(function (s) { return s.date <= refDate; })
                                       .reduce(function (sum, s) { return sum + (s.fee || 0); }, 0);
      var cumGuestPaid    = allPayments2.filter(function (p) { return p.type === 'guest_play' && p.date <= refDate; })
                                       .reduce(function (sum, p) { return sum + (p.amount || 0); }, 0);
      var cumGuestOutstanding = Math.max(0, cumGuestFees - cumGuestPaid);

      // Date range label
      var rangeLabel = (start && end)
        ? fmtDate(start) + ' – ' + fmtDate(end)
        : 'All time (up to ' + fmtDate(today) + ')';

      var html = '<div class="history-summary" style="margin-bottom:8px;">Period: <strong>' + rangeLabel + '</strong></div>';

      // Summary cards
      html += '<div class="balance-cards">';
      html += '<div class="balance-card balance-card-green"><div class="balance-card-label">Collected in period</div><div class="balance-card-value">₹' + totalCollection.toFixed(2) + '</div></div>';
      html += '<div class="balance-card balance-card-red"><div class="balance-card-label">Expenses in period</div><div class="balance-card-value">₹' + totalExpenses.toFixed(2) + '</div></div>';
      html += '<div class="balance-card balance-card-' + (netBalance >= 0 ? 'blue' : 'red') + ' balance-card-large"><div class="balance-card-label">Net (period)</div><div class="balance-card-value ' + balClass + '">₹' + Math.abs(netBalance).toFixed(2) + (netBalance < 0 ? ' deficit' : '') + '</div></div>';
      if (cumMonthlyOutstanding > 0) {
        html += '<div class="balance-card balance-card-red"><div class="balance-card-label">Monthly dues (as of ' + fmtDate(refDate) + ')</div><div class="balance-card-value amount-due">₹' + cumMonthlyOutstanding.toFixed(2) + '</div></div>';
      }
      if (cumGuestOutstanding > 0) {
        html += '<div class="balance-card balance-card-red"><div class="balance-card-label">Guest dues (as of ' + fmtDate(refDate) + ')</div><div class="balance-card-value amount-due">₹' + cumGuestOutstanding.toFixed(2) + '</div></div>';
      }
      html += '</div>';

      // Collection breakdown table
      html += '<div class="report-section-title">Collection breakdown</div>';
      html += '<table class="report-table"><thead><tr><th>Type</th><th>Amount</th></tr></thead><tbody>';
      html += '<tr><td>Monthly contributions</td><td>₹' + totalMonthly.toFixed(2) + '</td></tr>';
      html += '<tr><td>session fees</td><td>₹' + totalGuest.toFixed(2) + '</td></tr>';
      html += '<tr><td><strong>Total</strong></td><td><strong>₹' + totalCollection.toFixed(2) + '</strong></td></tr>';
      html += '</tbody></table>';

      // Individual collections
      if (payments.length > 0) {
        var members   = await DB.getAllMembers();
        var memberMap = {};
        members.forEach(function (m) { memberMap[m.id] = m; });

        var sorted = payments.slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
        html += '<div class="report-section-title">All collections (' + payments.length + ')</div>';
        html += '<table class="report-table"><thead><tr><th>Date</th><th>Member</th><th>Type</th><th>Amount</th></tr></thead><tbody>';
        sorted.forEach(function (p) {
          var mName    = memberMap[p.memberId] ? memberMap[p.memberId].name : 'Unknown';
          var typeLabel= p.type === 'monthly' ? 'Monthly' : 'Guest';
          html += '<tr><td>' + fmtDate(p.date) + '</td><td>' + esc(mName) + '</td><td>' + typeLabel + '</td><td>₹' + (p.amount||0).toFixed(2) + '</td></tr>';
        });
        html += '</tbody></table>';
      }

      // Individual expenses
      if (expenses.length > 0) {
        var sortedExp = expenses.slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
        html += '<div class="report-section-title">All expenses (' + expenses.length + ')</div>';
        html += '<table class="report-table"><thead><tr><th>Date</th><th>Category</th><th>Notes</th><th>Amount</th></tr></thead><tbody>';
        sortedExp.forEach(function (ex) {
          html += '<tr><td>' + fmtDate(ex.date) + '</td><td>' + esc(ex.category||'—') + '</td><td>' + esc(ex.notes||'—') + '</td><td class="amount-due">₹' + (ex.amount||0).toFixed(2) + '</td></tr>';
        });
        html += '</tbody></table>';
      } else {
        html += '<div class="report-section-title">Expenses</div><p class="empty-message" style="padding:12px 0;">No expenses in this period.</p>';
      }

      container.innerHTML = html;
    } catch (e) { container.innerHTML = '<p class="empty-message">Error loading report.</p>'; console.error(e); }
  }

  // ── Attendance report ─────────────────────────────────
  async function renderAttendanceReport() {
    var container = document.getElementById('report-output-attendance');
    if (!container) return;
    var { start, end } = getDateRange('report-start-att', 'report-end-att');
    var searchTerm = getSearch('report-search-att');
    var operatorEl = document.getElementById('report-att-operator');
    var daysEl = document.getElementById('report-att-days');
    var operator = operatorEl ? operatorEl.value : 'all';
    var daysFilter = daysEl ? parseInt(daysEl.value, 10) : NaN;
    container.innerHTML = '<p class="empty-message">Loading…</p>';

    try {
      if (!start || !end) { container.innerHTML = '<p class="empty-message">Select a date range.</p>'; return; }

      var records = await DB.getAttendanceByDateRange(start, end);
      var members = await DB.getAllMembers();
      var memberMap = {};
      members.forEach(function (m) { memberMap[m.id] = m; });

      // Only count 'present' records
      var presentRecords = records.filter(function (r) { return r.status === 'present'; });

      // Aggregate per-member
      var countMap = {};   // memberId → count
      var datesMap = {};   // memberId → [dates]
      presentRecords.forEach(function (r) {
        if (!countMap[r.memberId]) { countMap[r.memberId] = 0; datesMap[r.memberId] = []; }
        countMap[r.memberId]++;
        datesMap[r.memberId].push(r.date);
      });

      // Build list of memberIds
      var memberIds = Object.keys(countMap);

      // Filter by search term (name or memberType)
      if (searchTerm) {
        memberIds = memberIds.filter(function (id) {
          var m = memberMap[id];
          if (!m) return false;
          return m.name.toLowerCase().indexOf(searchTerm) !== -1 ||
            (m.memberType && m.memberType.toLowerCase().indexOf(searchTerm) !== -1);
        });
      }

      // Filter by days operator
      if (operator !== 'all' && !isNaN(daysFilter)) {
        memberIds = memberIds.filter(function (id) {
          var count = countMap[id] || 0;
          if (operator === 'gte') return count >= daysFilter;
          if (operator === 'lte') return count <= daysFilter;
          if (operator === 'eq') return count === daysFilter;
          return true;
        });
      }

      if (memberIds.length === 0) { container.innerHTML = '<p class="empty-message">No attendance data matching your filters.</p>'; return; }

      // Sort by count descending
      memberIds.sort(function (a, b) { return countMap[b] - countMap[a]; });

      var totalDays = 0;
      memberIds.forEach(function (id) { totalDays += countMap[id]; });

      var html = '<div class="history-summary">Period: ' + fmtDate(start) + ' – ' + fmtDate(end) + ' · ' + memberIds.length + ' member(s) · ' + totalDays + ' total present-days</div>';
      html += '<table class="report-table"><thead><tr><th>Member</th><th>Type</th><th>Days</th></tr></thead><tbody>';
      memberIds.forEach(function (id) {
        var m = memberMap[id];
        var name = m ? esc(m.name) : 'Unknown';
        var type = m && m.memberType ? esc(m.memberType) : '';
        var dates = datesMap[id].slice().sort();
        html += '<tr class="att-report-row" data-member-id="' + id + '" style="cursor:pointer;">';
        html += '<td>' + name + '</td><td>' + type + '</td><td><strong>' + countMap[id] + '</strong></td></tr>';
        html += '<tr class="att-report-detail" data-member-id="' + id + '" hidden><td colspan="3" style="padding:4px 12px;font-size:0.8rem;color:var(--text2);">';
        html += dates.map(function (d) { return fmtDate(d); }).join(', ');
        html += '</td></tr>';
      });
      html += '</tbody></table>';

      container.innerHTML = html;

      // Toggle detail rows on click
      container.querySelectorAll('.att-report-row').forEach(function (row) {
        row.addEventListener('click', function () {
          var memberId = row.dataset.memberId;
          var detail = container.querySelector('.att-report-detail[data-member-id="' + memberId + '"]');
          if (detail) {
            if (detail.hasAttribute('hidden')) detail.removeAttribute('hidden');
            else detail.setAttribute('hidden', '');
          }
        });
      });
    } catch (e) {
      container.innerHTML = '<p class="empty-message">Error loading attendance report.</p>';
      console.error(e);
    }
  }

  return { init, renderActiveReport };
})();
