// ─── Activity Audit log ───────────────────────────────────────
// A permanent, cross-device record of app activity for the Settings activity
// report. Byte-frugal (mirrors the Lights On design): each record stores only
// { id, t, c, p, day } — a short 2-char event code `c` plus the variable
// params `p`. The human-readable text lives ONCE in AUDIT_TEMPLATES and is
// expanded at render time, so long strings are never repeated across records.
//
// Records live in the IndexedDB 'audit' store and sync cross-device via the
// Sync V2 engine (append-only — each has a unique id, so devices never collide
// and nothing is overwritten).
//
// Writes are fire-and-forget: auditing must NEVER delay or break the real
// action. A dropped audit write is acceptable (the action still happened; only
// its history line is lost).
const Audit = (function () {
  'use strict';

  // Short code → human template. {placeholders} are filled from the record's
  // params at render time. Keep codes stable; add new ones, don't repurpose.
  var AUDIT_TEMPLATES = {
    // Members
    MC: 'Member added — {name}',
    MU: 'Member updated — {name}',
    MD: 'Member deleted — {name}',
    MR: 'Member reactivated — {name}',
    // Monthly fees / contributions
    FA: 'Monthly fee applied — {name}, ₹{amount}',
    EN: 'Enrolled in monthly — {name}, ₹{amount}/mo',
    EU: 'Enrollment updated — {name}, ₹{amount}/mo',
    ED: 'Enrollment removed — {name}',
    // Payments
    PM: 'Monthly payment collected — {name}, ₹{amount}',
    PG: 'Guest fee collected — {name}, ₹{amount}',
    // Guest sessions
    GC: 'Guest session added — {name}, ₹{amount}',
    GD: 'Guest session removed — {name}',
    // Attendance
    AT: 'Attendance saved — {date}, {present} present',
    AQ: 'Attendance via QR — {name}, {date}',
    // Expenses
    XC: 'Expense added — {category}, ₹{amount}',
    XU: 'Expense updated — {category}, ₹{amount}',
    XD: 'Expense deleted — {category}, ₹{amount}',
    // System
    BK: 'Backup created',
    RS: 'Backup restored',
    LA: 'License activated',
    LD: 'License deactivated'
  };

  // Category each code rolls up into for the day-wise counts/charts.
  var AUDIT_CATEGORY = {
    MC: 'member',  MU: 'member',  MD: 'member',  MR: 'member',
    FA: 'fee',     EN: 'fee',     EU: 'fee',     ED: 'fee',
    PM: 'payment', PG: 'payment',
    GC: 'session', GD: 'session',
    AT: 'attendance', AQ: 'attendance',
    XC: 'expense', XU: 'expense', XD: 'expense',
    BK: 'system',  RS: 'system',  LA: 'system',  LD: 'system'
  };

  // Category list used by the report (summary chips / chart series), in order.
  var AUDIT_CATEGORIES = ['member', 'fee', 'payment', 'session', 'attendance', 'expense', 'system'];
  var CATEGORY_LABELS = {
    member: 'Members', fee: 'Fees', payment: 'Payments', session: 'Guest',
    attendance: 'Attendance', expense: 'Expenses', system: 'System'
  };
  var CATEGORY_COLORS = {
    member: '#4caf50', fee: '#2196f3', payment: '#ff9800', session: '#9c27b0',
    attendance: '#00bcd4', expense: '#e91e63', system: '#9e9e9e'
  };

  // Local day key 'YYYY-MM-DD' (device local time — matches how dates are stored
  // elsewhere in the app, which uses local date pickers).
  function dayKey(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function _genId() {
    if (typeof DB !== 'undefined' && DB.generateId) return DB.generateId();
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'a-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  // Fire-and-forget audit write. `params` carries only the variable fields
  // (name, amount, date, category, present, …). Never throws into the caller.
  function writeAudit(code, params) {
    try {
      if (!AUDIT_TEMPLATES[code]) return;           // unknown code — never write junk
      if (typeof DB === 'undefined' || !DB.addAuditRecord) return;
      var now = Date.now();
      var rec = { id: _genId(), t: now, c: code, p: params || {}, day: dayKey(now) };
      // Not awaited: a failed audit write must not affect the real action.
      DB.addAuditRecord(rec).catch(function () {});
    } catch (e) { /* auditing must never break the action */ }
  }

  // Expand a stored record into display text using the template map.
  function expandAuditRecord(rec) {
    if (!rec) return '';
    var tpl = AUDIT_TEMPLATES[rec.c] || rec.c;
    var prm = rec.p || {};
    return tpl.replace(/\{(\w+)\}/g, function (m, key) {
      var v = prm[key];
      return (v === undefined || v === null) ? '' : String(v);
    }).replace(/,\s*$/, '').replace(/—\s*$/, '').trim();
  }

  // ─── Retention: keep audit records to a bounded window (default 90 days) ───
  var RETENTION_DAYS = 90;
  function esc(s) {
    return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
  }
  async function pruneOldRecords() {
    try {
      if (typeof DB === 'undefined' || !DB.getAllAuditRecords) return;
      var cutoff = dayKey(Date.now() - RETENTION_DAYS * 86400000);
      var all = await DB.getAllAuditRecords();
      for (var i = 0; i < all.length; i++) {
        if ((all[i].day || '') < cutoff) { try { await DB.deleteAuditRecord(all[i].id); } catch (e) {} }
      }
    } catch (e) { /* best-effort */ }
  }

  // ─── Chart.js lazy loader (CDN, with graceful offline fallback) ───
  var _chartLoading = null;
  function loadChartJs() {
    if (typeof Chart !== 'undefined') return Promise.resolve(true);
    if (_chartLoading) return _chartLoading;
    _chartLoading = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
      var to = setTimeout(function () { resolve(false); }, 12000);
      s.onload = function () { clearTimeout(to); resolve(true); };
      s.onerror = function () { clearTimeout(to); resolve(false); };
      document.head.appendChild(s);
    });
    return _chartLoading;
  }

  // ─── Report state ───
  var _chartInstances = [];
  var _reportData = null;   // { records, dayKeys } for the fetched window
  var _reportBound = false;

  function _todayKey() { return dayKey(Date.now()); }
  function _keyToInput(k) { return k; }              // day keys are already YYYY-MM-DD
  function _inputToKey(v) { return (v || '').trim(); }

  // Build last-N day keys oldest→newest (local time).
  function _recentDayKeys(n) {
    var keys = [];
    for (var i = n - 1; i >= 0; i--) keys.push(dayKey(Date.now() - i * 86400000));
    return keys;
  }

  function _destroyCharts() {
    _chartInstances.forEach(function (c) { try { c.destroy(); } catch (e) {} });
    _chartInstances = [];
  }

  function closeReport() {
    _destroyCharts();
    var m = document.getElementById('activity-report-modal');
    if (m) m.setAttribute('hidden', '');
  }

  async function openReport() {
    var m = document.getElementById('activity-report-modal');
    if (!m) return;
    m.removeAttribute('hidden');
    var loading = document.getElementById('ar-loading');
    var content = document.getElementById('ar-content');
    var errEl   = document.getElementById('ar-error');
    if (loading) loading.style.display = '';
    if (content) content.setAttribute('hidden', '');
    if (errEl)   errEl.setAttribute('hidden', '');

    try {
      // Fetch the last 30 days as the default window (filter can narrow within).
      var dayKeys = _recentDayKeys(30);
      var fromKey = dayKeys[0], toKey = dayKeys[dayKeys.length - 1];
      var records = (DB.getAuditByDateRange)
        ? await DB.getAuditByDateRange(fromKey, toKey)
        : (await DB.getAllAuditRecords()).filter(function (r) { return r.day >= fromKey && r.day <= toKey; });

      _reportData = { records: records || [], dayKeys: dayKeys };

      // Init From/To inputs to the full window, bounded.
      var fromEl = document.getElementById('ar-from');
      var toEl   = document.getElementById('ar-to');
      if (fromEl) { fromEl.min = fromKey; fromEl.max = toKey; fromEl.value = fromKey; if (typeof syncDatePicker === 'function') syncDatePicker('ar-from'); }
      if (toEl)   { toEl.min = fromKey;   toEl.max = toKey;   toEl.value = toKey;     if (typeof syncDatePicker === 'function') syncDatePicker('ar-to'); }

      if (loading) loading.style.display = 'none';
      if (content) content.removeAttribute('hidden');

      await applyFilter();

      // Retention runs after the report opens (best-effort, non-blocking).
      pruneOldRecords();
    } catch (e) {
      if (loading) loading.style.display = 'none';
      if (errEl) { errEl.removeAttribute('hidden'); errEl.textContent = 'Could not load activity: ' + (e && e.message ? e.message : e); }
    }
  }

  // Re-aggregate + re-render for the selected [from,to] range (client-side).
  async function applyFilter() {
    if (!_reportData) return;
    var dayKeys = _reportData.dayKeys;
    var fromEl = document.getElementById('ar-from');
    var toEl   = document.getElementById('ar-to');
    var fromKey = fromEl && fromEl.value ? _inputToKey(fromEl.value) : dayKeys[0];
    var toKey   = toEl   && toEl.value   ? _inputToKey(toEl.value)   : dayKeys[dayKeys.length - 1];
    var minKey = dayKeys[0], maxKey = dayKeys[dayKeys.length - 1];
    if (fromKey < minKey) fromKey = minKey;
    if (toKey > maxKey) toKey = maxKey;
    if (fromKey > toKey) { var t = fromKey; fromKey = toKey; toKey = t; }

    var rangeKeys = dayKeys.filter(function (k) { return k >= fromKey && k <= toKey; });

    var perDay = {};
    rangeKeys.forEach(function (k) {
      perDay[k] = {};
      AUDIT_CATEGORIES.forEach(function (c) { perDay[k][c] = 0; });
    });
    var totals = {};
    AUDIT_CATEGORIES.forEach(function (c) { totals[c] = 0; });

    var events = [];
    _reportData.records.forEach(function (rec) {
      if (!rec || !rec.c) return;
      if (rec.day < fromKey || rec.day > toKey) return;
      var cat = AUDIT_CATEGORY[rec.c] || 'system';
      if (perDay[rec.day] && perDay[rec.day][cat] !== undefined) perDay[rec.day][cat]++;
      if (totals[cat] !== undefined) totals[cat]++;
      events.push({ t: rec.t || 0, text: expandAuditRecord(rec) });
    });

    renderSummary(totals);
    renderTable(rangeKeys, perDay);
    renderEvents(events);
    await renderCharts(rangeKeys, perDay, totals);
  }

  function resetFilter() {
    if (!_reportData) return;
    var dayKeys = _reportData.dayKeys;
    var fromEl = document.getElementById('ar-from');
    var toEl   = document.getElementById('ar-to');
    if (fromEl) { fromEl.value = dayKeys[0]; if (typeof syncDatePicker === 'function') syncDatePicker('ar-from'); }
    if (toEl)   { toEl.value = dayKeys[dayKeys.length - 1]; if (typeof syncDatePicker === 'function') syncDatePicker('ar-to'); }
    applyFilter();
  }

  function renderSummary(totals) {
    var el = document.getElementById('ar-summary');
    if (!el) return;
    el.innerHTML = AUDIT_CATEGORIES.map(function (c) {
      return '<div class="ar-chip"><span class="ar-chip-num">' + (totals[c] || 0) + '</span>' +
        '<span class="ar-chip-lbl">' + esc(CATEGORY_LABELS[c] || c) + '</span></div>';
    }).join('');
  }

  function _dayLabel(k) {
    var parts = (k || '').split('-');
    if (parts.length !== 3) return k;
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function renderTable(dayKeys, perDay) {
    var el = document.getElementById('ar-table');
    if (!el) return;
    var head = '<thead><tr><th>Date</th>' +
      AUDIT_CATEGORIES.map(function (c) { return '<th>' + esc(CATEGORY_LABELS[c] || c) + '</th>'; }).join('') +
      '<th>Total</th></tr></thead>';
    var sum = {}; AUDIT_CATEGORIES.forEach(function (c) { sum[c] = 0; }); var grand = 0;
    var rows = dayKeys.slice().reverse().map(function (k) {
      var d = perDay[k]; var dayTotal = 0;
      AUDIT_CATEGORIES.forEach(function (c) { dayTotal += d[c]; sum[c] += d[c]; });
      grand += dayTotal;
      if (dayTotal === 0) return '';
      return '<tr><td>' + esc(_dayLabel(k)) + '</td>' +
        AUDIT_CATEGORIES.map(function (c) { return '<td>' + d[c] + '</td>'; }).join('') +
        '<td><strong>' + dayTotal + '</strong></td></tr>';
    }).join('');
    var totalRow = '<tr class="report-total-row"><td><strong>Total</strong></td>' +
      AUDIT_CATEGORIES.map(function (c) { return '<td><strong>' + sum[c] + '</strong></td>'; }).join('') +
      '<td><strong>' + grand + '</strong></td></tr>';
    var body = '<tbody>' + (rows || ('<tr><td colspan="' + (AUDIT_CATEGORIES.length + 2) + '" style="color:var(--text3)">No activity in range</td></tr>')) + totalRow + '</tbody>';
    el.innerHTML = '<table class="report-table">' + head + body + '</table>';
  }

  function renderEvents(events) {
    var el = document.getElementById('ar-events');
    if (!el) return;
    events.sort(function (a, b) { return b.t - a.t; });
    var recent = events.slice(0, 40);
    if (!recent.length) { el.innerHTML = '<span style="color:var(--text3)">No events</span>'; return; }
    el.innerHTML = recent.map(function (ev) {
      var d = new Date(ev.t);
      var when = isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return '<div><span class="ar-ev-time">' + esc(when) + '</span> — ' + esc(ev.text) + '</div>';
    }).join('');
  }

  async function renderCharts(dayKeys, perDay, totals) {
    _destroyCharts();
    var fallback = document.getElementById('ar-chart-fallback');
    var ok = await loadChartJs();
    if (!ok || typeof Chart === 'undefined') {
      if (fallback) { fallback.removeAttribute('hidden'); fallback.textContent = 'Charts need an internet connection (Chart.js). The table below has the full breakdown.'; }
      return;
    }
    if (fallback) fallback.setAttribute('hidden', '');

    var labels = dayKeys.map(_dayLabel);
    var cats = AUDIT_CATEGORIES;
    var series = function (c) { return dayKeys.map(function (k) { return perDay[k][c]; }); };

    var barEl = document.getElementById('ar-bar-chart');
    if (barEl) _chartInstances.push(new Chart(barEl, {
      type: 'bar',
      data: { labels: labels, datasets: cats.map(function (c) { return { label: CATEGORY_LABELS[c] || c, data: series(c), backgroundColor: CATEGORY_COLORS[c], stack: 'a' }; }) },
      options: { responsive: true, maintainAspectRatio: false,
        scales: { x: { stacked: true, ticks: { maxRotation: 0, autoSkip: true } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } },
        plugins: { legend: { labels: { boxWidth: 10, font: { size: 10 } } } } }
    }));

    var totalsPerDay = dayKeys.map(function (k) { var s = 0; cats.forEach(function (c) { s += perDay[k][c]; }); return s; });
    var lineEl = document.getElementById('ar-line-chart');
    if (lineEl) _chartInstances.push(new Chart(lineEl, {
      type: 'line',
      data: { labels: labels, datasets: [{ label: 'Total', data: totalsPerDay, borderColor: '#2196f3', backgroundColor: 'rgba(33,150,243,.15)', fill: true, tension: .3, pointRadius: 2 }] },
      options: { responsive: true, maintainAspectRatio: false,
        scales: { x: { ticks: { maxRotation: 0, autoSkip: true } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
        plugins: { legend: { display: false } } }
    }));

    var donutEl = document.getElementById('ar-donut-chart');
    if (donutEl) _chartInstances.push(new Chart(donutEl, {
      type: 'doughnut',
      data: { labels: cats.map(function (c) { return CATEGORY_LABELS[c] || c; }), datasets: [{ data: cats.map(function (c) { return totals[c]; }), backgroundColor: cats.map(function (c) { return CATEGORY_COLORS[c]; }) }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10 } } } } }
    }));
  }

  // Wire the Settings button + modal controls once.
  function initReport() {
    if (_reportBound) return;
    var openBtn = document.getElementById('activity-report-btn');
    var closeBtn = document.getElementById('ar-close-btn');
    var resetBtn = document.getElementById('ar-reset-btn');
    var fromEl = document.getElementById('ar-from');
    var toEl = document.getElementById('ar-to');
    var overlay = document.getElementById('activity-report-modal');
    if (openBtn) openBtn.addEventListener('click', openReport);
    if (closeBtn) closeBtn.addEventListener('click', closeReport);
    if (resetBtn) resetBtn.addEventListener('click', resetFilter);
    if (fromEl) fromEl.addEventListener('change', applyFilter);
    if (toEl) toEl.addEventListener('change', applyFilter);
    if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) closeReport(); });
    _reportBound = true;
  }

  return {
    writeAudit: writeAudit,
    expandAuditRecord: expandAuditRecord,
    dayKey: dayKey,
    initReport: initReport,
    openReport: openReport,
    closeReport: closeReport,
    AUDIT_TEMPLATES: AUDIT_TEMPLATES,
    AUDIT_CATEGORY: AUDIT_CATEGORY,
    AUDIT_CATEGORIES: AUDIT_CATEGORIES,
    CATEGORY_LABELS: CATEGORY_LABELS,
    CATEGORY_COLORS: CATEGORY_COLORS
  };
})();
