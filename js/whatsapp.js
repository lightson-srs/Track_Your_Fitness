const WhatsApp = (function () {
  'use strict';

  var KEYS = {
    TPL_MONTHLY_CONFIRM: 'tyf_wa_tpl_monthly_confirm',
    TPL_MONTHLY_REMINDER: 'tyf_wa_tpl_monthly_reminder',
    TPL_GUEST_CONFIRM: 'tyf_wa_tpl_guest_confirm',
    TOGGLE_MONTHLY: 'tyf_wa_toggle_monthly',
    TOGGLE_GUEST: 'tyf_wa_toggle_guest',
    REMINDER_COUNTS: 'tyf_wa_reminder_counts'
  };

  var DEFAULTS = {
    TPL_MONTHLY_CONFIRM: 'Hi {memberName}, your monthly contribution of ₹{amount} received on {date}. Balance: ₹{balance}. Thank you!',
    TPL_MONTHLY_REMINDER: 'Hi {memberName}, this is a reminder for your monthly fitness contribution of ₹{fee}. Outstanding: ₹{balance}. Please pay at the earliest.',
    TPL_GUEST_CONFIRM: 'Hi {memberName}, your session fee of ₹{amount} for {date} has been recorded. See you at the gym!',
    TOGGLE_MONTHLY: '0',
    TOGGLE_GUEST: '0'
  };

  function lsGet(key, def) { try { return localStorage.getItem(key) || def; } catch (e) { return def; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }

  function processTemplate(template, vars) {
    if (!template) return '';
    return template.replace(/\{(\w+)\}/g, function (match, key) {
      return vars.hasOwnProperty(key) ? String(vars[key]) : match;
    });
  }

  function formatDate(iso) {
    if (!iso || typeof iso !== 'string') return iso || '';
    var parts = iso.split('-');
    if (parts.length !== 3) return iso;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var d = parseInt(parts[2], 10), m = parseInt(parts[1], 10) - 1, y = parts[0];
    if (isNaN(d) || isNaN(m) || m < 0 || m > 11) return iso;
    return d + ' ' + months[m] + ' ' + y;
  }

  function openWA(mobile, message, fromUserGesture) {
    var phone = '91' + mobile.replace(/\D/g, '');
    var url = 'https://api.whatsapp.com/send?phone=' + phone + '&text=' + encodeURIComponent(message);

    // When called directly from a synchronous user gesture (button tap with no async
    // gap), we can navigate immediately — iOS Safari allows it.
    if (fromUserGesture) {
      // Use a temporary <a> click to open WhatsApp — works reliably on iOS standalone PWA
      var tempLink = document.createElement('a');
      tempLink.href = url;
      tempLink.target = '_blank';
      tempLink.rel = 'noopener noreferrer';
      tempLink.style.display = 'none';
      document.body.appendChild(tempLink);
      tempLink.click();
      setTimeout(function () { document.body.removeChild(tempLink); }, 100);
      return;
    }

    // iOS Safari blocks programmatic navigation after any async gap (await/IndexedDB).
    // The only reliable fix is a real user tap — show a tappable toast instead.
    var existing = document.getElementById('_wa_toast');
    if (existing) existing.parentNode.removeChild(existing);

    var toast = document.createElement('div');
    toast.id = '_wa_toast';
    toast.style.cssText = [
      'position:fixed',
      'bottom:80px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:99999',
      'background:#25D366',
      'color:#fff',
      'border-radius:14px',
      'padding:13px 18px',
      'font-size:1rem',
      'font-weight:600',
      'box-shadow:0 4px 20px rgba(0,0,0,0.35)',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'white-space:nowrap',
      'max-width:90vw'
    ].join(';');

    var link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '📲 Send WhatsApp';
    link.style.cssText = 'color:#fff;text-decoration:none;flex:1;';
    link.addEventListener('click', function () {
      setTimeout(function () { toast.parentNode && toast.parentNode.removeChild(toast); }, 300);
    });

    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:1rem;cursor:pointer;padding:0;line-height:1;';
    closeBtn.addEventListener('click', function () {
      toast.parentNode && toast.parentNode.removeChild(toast);
    });

    toast.appendChild(link);
    toast.appendChild(closeBtn);
    document.body.appendChild(toast);

    // Auto-dismiss after 12 seconds
    setTimeout(function () { toast.parentNode && toast.parentNode.removeChild(toast); }, 12000);
  }

  function shouldConfirmMonthly() { return lsGet(KEYS.TOGGLE_MONTHLY, DEFAULTS.TOGGLE_MONTHLY) === '1'; }
  function shouldConfirmGuest() { return lsGet(KEYS.TOGGLE_GUEST, DEFAULTS.TOGGLE_GUEST) === '1'; }

  function sendMonthlyConfirmation(mobile, name, amount, date, balance) {
    var tpl = lsGet(KEYS.TPL_MONTHLY_CONFIRM, DEFAULTS.TPL_MONTHLY_CONFIRM);
    var msg = processTemplate(tpl, { memberName: name, amount: amount.toFixed(2), date: formatDate(date), balance: balance.toFixed(2) });
    openWA(mobile, msg);
  }

  function sendMonthlyReminder(mobile, name, balance, fee) {
    var tpl = lsGet(KEYS.TPL_MONTHLY_REMINDER, DEFAULTS.TPL_MONTHLY_REMINDER);
    var msg = processTemplate(tpl, { memberName: name, balance: balance.toFixed(2), fee: fee.toFixed(2) });
    openWA(mobile, msg, true);
  }

  function sendGuestConfirmation(mobile, name, amount, date) {
    var tpl = lsGet(KEYS.TPL_GUEST_CONFIRM, DEFAULTS.TPL_GUEST_CONFIRM);
    var msg = processTemplate(tpl, { memberName: name, amount: amount.toFixed(2), date: formatDate(date) });
    openWA(mobile, msg);
  }

  function init() {
    var toggleMonthly = document.getElementById('wa-toggle-monthly');
    var toggleGuest = document.getElementById('wa-toggle-guest');
    var tplMonthlyConfirm = document.getElementById('wa-tpl-monthly-confirm');
    var tplMonthlyRemind = document.getElementById('wa-tpl-monthly-reminder');
    var tplGuestConfirm = document.getElementById('wa-tpl-guest-confirm');
    var saveBtn = document.getElementById('wa-save-btn');

    if (toggleMonthly) toggleMonthly.checked = shouldConfirmMonthly();
    if (toggleGuest) toggleGuest.checked = shouldConfirmGuest();
    if (tplMonthlyConfirm) tplMonthlyConfirm.value = lsGet(KEYS.TPL_MONTHLY_CONFIRM, DEFAULTS.TPL_MONTHLY_CONFIRM);
    if (tplMonthlyRemind) tplMonthlyRemind.value = lsGet(KEYS.TPL_MONTHLY_REMINDER, DEFAULTS.TPL_MONTHLY_REMINDER);
    if (tplGuestConfirm) tplGuestConfirm.value = lsGet(KEYS.TPL_GUEST_CONFIRM, DEFAULTS.TPL_GUEST_CONFIRM);

    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        if (toggleMonthly) lsSet(KEYS.TOGGLE_MONTHLY, toggleMonthly.checked ? '1' : '0');
        if (toggleGuest) lsSet(KEYS.TOGGLE_GUEST, toggleGuest.checked ? '1' : '0');
        if (tplMonthlyConfirm && tplMonthlyConfirm.value.trim()) lsSet(KEYS.TPL_MONTHLY_CONFIRM, tplMonthlyConfirm.value.trim());
        if (tplMonthlyRemind && tplMonthlyRemind.value.trim()) lsSet(KEYS.TPL_MONTHLY_REMINDER, tplMonthlyRemind.value.trim());
        if (tplGuestConfirm && tplGuestConfirm.value.trim()) lsSet(KEYS.TPL_GUEST_CONFIRM, tplGuestConfirm.value.trim());
        var msg = document.getElementById('wa-save-msg');
        if (msg) { msg.removeAttribute('hidden'); setTimeout(function () { msg.setAttribute('hidden', ''); }, 3000); }
      });
    }
  }

  return {
    init,
    shouldConfirmMonthly, shouldConfirmGuest,
    sendMonthlyConfirmation, sendMonthlyReminder, sendGuestConfirmation
  };
})();
