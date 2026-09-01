const GuestPlay = (function () {
  'use strict';

  function esc(s) {
    return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
  }
  function getTodayISO() { return new Date().toISOString().split('T')[0]; }

  // ─── State ───
  var _pendingMemberId   = null;
  var _pendingMemberName = '';
  var _pendingSessions   = []; // pending sessions being collected

  function init() {
    var dateInput   = document.getElementById('guest-date');
    var searchInput = document.getElementById('guest-search');
    var confirmBtn  = document.getElementById('guest-confirm-btn');
    var cancelBtn   = document.getElementById('guest-cancel-btn');

    if (dateInput)   { if (!dateInput.value) { dateInput.value = getTodayISO(); syncDatePicker('guest-date'); } dateInput.addEventListener('change', renderGuestList); }
    if (searchInput) searchInput.addEventListener('input', renderGuestList);
    if (confirmBtn)  confirmBtn.addEventListener('click', handleConfirmPayment);
    if (cancelBtn)   cancelBtn.addEventListener('click', hidePaymentModal);

    renderGuestList();
  }

  async function renderGuestList() {
    var container   = document.getElementById('guest-list');
    if (!container) return;

    var dateInput   = document.getElementById('guest-date');
    var searchInput = document.getElementById('guest-search');
    var date        = dateInput   ? dateInput.value             : getTodayISO();
    var searchTerm  = searchInput ? searchInput.value.trim().toLowerCase() : '';

    container.innerHTML = '<p class="empty-message">Loading…</p>';

    try {
      var members  = await DB.getAllMembers();
      members = members.filter(function (m) { return m.status !== 'inactive'; });
      if (searchTerm) {
        members = members.filter(function (m) { return m.name.toLowerCase().indexOf(searchTerm) !== -1 || (m.memberType && m.memberType.toLowerCase().indexOf(searchTerm) !== -1) || (m.notes && m.notes.toLowerCase().indexOf(searchTerm) !== -1); });
      }
      members.sort(function (a, b) { return a.name.localeCompare(b.name); });

      if (members.length === 0) { container.innerHTML = '<p class="empty-message">No active members.</p>'; return; }

      // Load all guest sessions for all members
      var allSessions = await DB.getAllGuestSessions();
      var allPayments = await DB.getAllPayments();

      // Build map: memberId → sessions up to selected date
      var sessionsByMember = {};
      allSessions.forEach(function (s) {
        if (s.date > date) return; // future sessions excluded
        if (!sessionsByMember[s.memberId]) sessionsByMember[s.memberId] = [];
        sessionsByMember[s.memberId].push(s);
      });

      // Build map: memberId → total guest payments up to selected date
      var paidByMember = {};
      allPayments.forEach(function (p) {
        if (p.type !== 'guest_play') return;
        if (p.date > date) return;
        paidByMember[p.memberId] = (paidByMember[p.memberId] || 0) + (p.amount || 0);
      });

      // Check if enrolled on selected date (has a session for that date)
      var enrolledOnDate = {};
      allSessions.forEach(function (s) {
        if (s.date === date) {
          enrolledOnDate[s.memberId] = enrolledOnDate[s.memberId] || [];
          enrolledOnDate[s.memberId].push(s);
        }
      });

      var defaultFee = Settings.getDefaultGuestFee();
      var html = '';
      var totalPending = 0;

      members.forEach(function (m) {
        var sessions      = sessionsByMember[m.id] || [];
        var totalFees     = sessions.reduce(function (sum, s) { return sum + (s.fee || 0); }, 0);
        var totalPaid     = paidByMember[m.id] || 0;
        var pendingAmt    = Math.max(0, totalFees - totalPaid);
        var todaySess     = enrolledOnDate[m.id] || [];
        var enrolledToday = todaySess.length > 0;

        totalPending += pendingAmt;

        html += '<div class="client-card' + (pendingAmt > 0 ? '' : ' member-inactive') + '">';
        html += '<div class="client-header">';
        html += '<div class="client-info">';
        html += '<div class="client-name">' + esc(m.name) + '</div>';

        // Pending sessions summary
        if (sessions.length > 0) {
          html += '<div class="member-meta">';
          html += '<span class="loan-type-badge badge-guest">' + sessions.length + ' session' + (sessions.length > 1 ? 's' : '') + '</span>';
          if (pendingAmt > 0) {
            html += ' <span class="amount-due">₹' + pendingAmt.toFixed(2) + ' due</span>';
          } else {
            html += ' <span class="amount-paid">Fully paid</span>';
          }
          if (totalPaid > 0) html += ' <span class="loan-notes">paid ₹' + totalPaid.toFixed(2) + '</span>';
          html += '</div>';
          // List each session (all, not just pending)
          html += '<div class="guest-session-list">';
          sessions.slice().sort(function (a, b) { return a.date.localeCompare(b.date); }).forEach(function (s) {
            html += '<span class="guest-session-chip">' + fmtDate(s.date) + ' ₹' + (s.fee||0).toFixed(0);
            html += ' <button class="btn-session-remove" data-session-id="' + s.id + '" title="Remove">×</button></span>';
          });
          html += '</div>';
        } else {
          html += '<div class="member-meta"><span class="loan-notes">No sessions</span></div>';
        }
        html += '</div>'; // client-info

        // Actions
        html += '<div class="client-actions" style="flex-direction:column;align-items:flex-end;gap:4px;">';

        // Enroll button — if already enrolled today, show as disabled
        if (enrolledToday) {
          html += '<button class="btn btn-sm btn-secondary" disabled title="Already enrolled for ' + fmtDate(date) + '">✓ ' + fmtDate(date) + '</button>';
        } else {
          html += '<button class="btn btn-sm btn-primary btn-enroll-guest" data-id="' + m.id + '" data-name="' + esc(m.name) + '" data-date="' + date + '" data-fee="' + defaultFee + '">+ Enroll</button>';
        }

        // Collect button — only if there are outstanding dues
        if (pendingAmt > 0) {
          html += '<button class="btn btn-collect btn-collect-guest" data-id="' + m.id + '" data-name="' + esc(m.name) + '" data-amount="' + pendingAmt.toFixed(2) + '">Collect ₹' + pendingAmt.toFixed(2) + '</button>';
        }

        html += '</div>'; // client-actions
        html += '</div>'; // client-header
        html += '</div>'; // client-card
      });

      // Banner
      var pendingMembers = members.filter(function (m) {
        var sess   = sessionsByMember[m.id] || [];
        var fees   = sess.reduce(function (sum, s) { return sum + (s.fee || 0); }, 0);
        var paid   = paidByMember[m.id] || 0;
        return fees > paid;
      }).length;
      var banner = '<div class="history-summary" style="margin-bottom:4px;">' +
        pendingMembers + ' member(s) with pending dues · Total outstanding: <strong class="amount-due">₹' + totalPending.toFixed(2) + '</strong></div>';

      container.innerHTML = banner + html;

      // Attach enroll handlers
      container.querySelectorAll('.btn-enroll-guest').forEach(function (btn) {
        btn.addEventListener('click', function () {
          enrollSession(btn.dataset.id, btn.dataset.name, btn.dataset.date, parseFloat(btn.dataset.fee));
        });
      });

      // Attach collect handlers
      container.querySelectorAll('.btn-collect-guest').forEach(function (btn) {
        btn.addEventListener('click', function () {
          showPaymentModal(btn.dataset.id, btn.dataset.name, parseFloat(btn.dataset.amount));
        });
      });

      // Attach remove session handlers
      container.querySelectorAll('.btn-session-remove').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          removeSession(btn.dataset.sessionId);
        });
      });

    } catch (e) {
      container.innerHTML = '<p class="empty-message">Could not load data.</p>';
      console.error(e);
    }
  }

  // ─── Enroll: create one guest_session for the date ───
  async function enrollSession(memberId, memberName, date, fee) {
    var _gFeeErr1 = window._checkGuestFee ? window._checkGuestFee(fee) : null;
    if (_gFeeErr1) { alert(_gFeeErr1); return; }
    try {
      var session = {
        id:        DB.generateId(),
        memberId:  memberId,
        date:      date,
        fee:       fee,
        status:    'pending',
        createdAt: new Date().toISOString()
      };
      await DB.addGuestSession(session);
      renderGuestList();
    } catch (e) {
      alert('Could not enroll: ' + e.message);
    }
  }

  // ─── Remove a pending session ───
  async function removeSession(sessionId) {
    if (!confirm('Remove this fitness session?')) return;
    try {
      var s = await DB.getGuestSession(sessionId);
      if (s && s.status === 'collected') { alert('Cannot remove a collected session.'); return; }
      await DB.deleteGuestSession(sessionId);
      renderGuestList();
    } catch (e) {
      alert('Could not remove session: ' + e.message);
    }
  }

  // ─── Payment modal ───
  function showPaymentModal(memberId, memberName, pendingAmount) {
    _pendingMemberId   = memberId;
    _pendingMemberName = memberName;

    var modal       = document.getElementById('guest-payment-modal');
    var titleEl     = document.getElementById('guest-modal-member');
    var amountInput = document.getElementById('guest-payment-amount');
    var qrContainer = document.getElementById('guest-qr-container');
    var hintEl      = document.getElementById('guest-fee-hint');

    if (titleEl)     titleEl.textContent = memberName;
    if (amountInput) { amountInput.value = pendingAmount.toFixed(2); }
    if (hintEl)      hintEl.textContent  = 'Total pending: ₹' + pendingAmount.toFixed(2);

    if (qrContainer) _renderQR(qrContainer, pendingAmount, memberName);

    if (amountInput) {
      amountInput.oninput = function () {
        var amt = parseFloat(amountInput.value) || 0;
        if (amt > 0 && qrContainer) _renderQR(qrContainer, amt, memberName);
        else if (qrContainer) qrContainer.innerHTML = '';
      };
    }

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
      '&tn=' + encodeURIComponent('Sessions - ' + memberName);
    var div = document.createElement('div');
    container.appendChild(div);
    try { new QRCode(div, { text: upiUrl, width: 160, height: 160, correctLevel: QRCode.CorrectLevel.M }); }
    catch (e) { container.innerHTML = '<p class="empty-message">QR generation failed.</p>'; }
  }

  async function handleConfirmPayment() {
    if (!_pendingMemberId) return;
    var amountInput = document.getElementById('guest-payment-amount');
    var amount      = parseFloat(amountInput ? amountInput.value : 0);
    if (isNaN(amount) || amount <= 0) { alert('Enter a valid amount.'); return; }

    var dateInput = document.getElementById('guest-date');
    var date      = dateInput ? dateInput.value : getTodayISO();

    try {
      // Create payment record
      var paymentId = DB.generateId();
      var payment = {
        id:        paymentId,
        memberId:  _pendingMemberId,
        date:      date,
        amount:    amount,
        type:      'guest_play',
        createdAt: new Date().toISOString()
      };
      await DB.addPayment(payment);

      // Sessions are NOT marked collected — outstanding is always derived as
      // sum(session fees ≤ date) - sum(guest payments ≤ date), so partial payments
      // are handled correctly without touching session records.
      var member = await DB.getMember(_pendingMemberId);
      hidePaymentModal();
      renderGuestList();

      if (member && WhatsApp.shouldConfirmGuest()) {
        WhatsApp.sendGuestConfirmation(member.mobile, member.name, amount, date);
      }
    } catch (e) {
      alert('Could not save payment: ' + e.message);
    }
  }

  function hidePaymentModal() {
    var modal = document.getElementById('guest-payment-modal');
    if (modal) modal.setAttribute('hidden', '');
    _pendingMemberId   = null;
    _pendingMemberName = '';
    _pendingSessions   = [];
  }

  return { init, renderGuestList };
})();
