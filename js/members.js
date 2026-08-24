const Members = (function () {
  'use strict';

  var editingMemberId = null;

  function esc(s) {
    return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
  }

  function init() {
    var addBtn     = document.getElementById('add-member-btn');
    var form       = document.getElementById('member-form');
    var cancelBtn  = document.getElementById('member-cancel-btn');
    var searchInput= document.getElementById('member-search');
    var exportBtn  = document.getElementById('members-export-btn');
    var importBtn  = document.getElementById('members-import-btn');
    var importFile = document.getElementById('members-import-file');

    if (addBtn)     addBtn.addEventListener('click', showAddForm);
    if (form)       form.addEventListener('submit', function (e) { e.preventDefault(); handleFormSubmit(); });
    if (cancelBtn)  cancelBtn.addEventListener('click', hideForm);
    if (searchInput)searchInput.addEventListener('input', function () { renderMemberList(searchInput.value.trim()); });
    if (exportBtn)  exportBtn.addEventListener('click', exportMembers);
    if (importBtn)  importBtn.addEventListener('click', function () { if (importFile) importFile.click(); });
    if (importFile) importFile.addEventListener('change', handleImportFile);

    renderMemberList();
  }

  async function renderMemberList(searchTerm) {
    var container = document.getElementById('member-list');
    if (!container) return;

    try {
      var members = await DB.getAllMembers();
      var contribs = await DB.getAllContributions();
      var contribMap = {};
      contribs.forEach(function (c) { contribMap[c.memberId] = c; });

      if (!members || members.length === 0) {
        container.innerHTML = '<p class="empty-message">No members yet. Tap + to add one.</p>'; return;
      }
      if (searchTerm) {
        var lower = searchTerm.toLowerCase();
        members = members.filter(function (m) { return m.name.toLowerCase().indexOf(lower) !== -1; });
      }
      if (members.length === 0) { container.innerHTML = '<p class="empty-message">No members match your search.</p>'; return; }

      members.sort(function (a, b) { return a.name.localeCompare(b.name); });

      var html = '';
      members.forEach(function (m) {
        var contrib = contribMap[m.id];
        var statusClass = m.status === 'inactive' ? ' member-inactive' : '';

        html += '<div class="member-card' + statusClass + '">';
        html += '<div class="client-header">';
        html += '<div class="client-info">';
        html += '<div class="client-name">' + esc(m.name) + '</div>';
        html += '<div class="client-mobile">' + esc(m.mobile) + '</div>';
        html += '<div class="member-meta">';
        if (contrib) {
          html += '<span class="loan-type-badge badge-monthly">₹' + (contrib.monthlyFee||0).toFixed(0) + '/mo</span>';
          if (contrib.activationDate) html += ' <span class="member-fee">from ' + fmtDate(contrib.activationDate) + '</span>';
        } else {
          html += '<span class="loan-type-badge badge-guest">No contribution set</span>';
        }
        if (m.notes) html += ' <span class="loan-notes">' + esc(m.notes) + '</span>';
        html += '</div></div>';
        html += '<div class="client-actions">';
        html += '<button class="btn-icon btn-edit-member" data-id="' + m.id + '" title="Edit">✏️</button>';
        html += '<button class="btn-icon btn-toggle-member" data-id="' + m.id + '" data-status="' + (m.status||'active') + '" title="' + (m.status==='inactive'?'Activate':'Deactivate') + '">' + (m.status==='inactive'?'▶️':'⏸️') + '</button>';
        html += '<button class="btn-icon btn-delete-member" data-id="' + m.id + '" title="Delete">🗑️</button>';
        html += '</div></div></div>';
      });

      container.innerHTML = html;
      container.querySelectorAll('.btn-edit-member').forEach(function (btn) {
        btn.addEventListener('click', function () { showEditForm(btn.dataset.id); });
      });
      container.querySelectorAll('.btn-delete-member').forEach(function (btn) {
        btn.addEventListener('click', function () { deleteMember(btn.dataset.id); });
      });
      container.querySelectorAll('.btn-toggle-member').forEach(function (btn) {
        btn.addEventListener('click', function () { toggleStatus(btn.dataset.id, btn.dataset.status); });
      });
    } catch (e) {
      container.innerHTML = '<p class="empty-message">Could not load members.</p>';
      console.error(e);
    }
  }

  function showAddForm() {
    editingMemberId = null;
    var form = document.getElementById('member-form');
    var title = document.getElementById('member-form-title');
    var container = document.getElementById('member-form-container');
    if (form) form.reset();
    if (title) title.textContent = 'Add member';
    if (container) container.removeAttribute('hidden');
    clearErrors();
  }

  async function showEditForm(memberId) {
    var m = await DB.getMember(memberId);
    if (!m) { alert('Member not found.'); return; }
    editingMemberId = memberId;
    document.getElementById('member-name').value   = m.name;
    document.getElementById('member-mobile').value = m.mobile;
    document.getElementById('member-notes').value  = m.notes || '';
    document.getElementById('member-form-title').textContent = 'Edit member';
    document.getElementById('member-form-container').removeAttribute('hidden');
    clearErrors();
  }

  async function handleFormSubmit() {
    clearErrors();
    var name   = (document.getElementById('member-name').value   || '').trim();
    var mobile = (document.getElementById('member-mobile').value || '').trim();
    var notes  = (document.getElementById('member-notes').value  || '').trim();

    var errors = [];
    if (!name)                               errors.push({ field: 'member-name',   msg: 'Name is required.' });
    if (!mobile || !/^\d{10}$/.test(mobile)) errors.push({ field: 'member-mobile', msg: 'Mobile must be 10 digits.' });
    if (errors.length > 0) { showErrors(errors); return; }

    var member = {
      id: editingMemberId || DB.generateId(),
      name: name, mobile: mobile, notes: notes,
      status: 'active',
      createdAt: editingMemberId ? undefined : new Date().toISOString()
    };

    try {
      if (editingMemberId) {
        var existing = await DB.getMember(editingMemberId);
        if (existing) { member.createdAt = existing.createdAt; member.status = existing.status; }
        await DB.updateMember(member);
      } else {
        // License member limit — uses inline global from index.html
        if (window._checkMemberLimit) {
          var _mLimitErr = await window._checkMemberLimit();
          if (_mLimitErr) { showErrors([{ field: 'member-name', msg: _mLimitErr }]); return; }
        }
        await DB.addMember(member);
      }
      hideForm();
      renderMemberList();
    } catch (e) {
      if (e.message && e.message.toLowerCase().includes('unique')) {
        showErrors([{ field: 'member-name', msg: 'A member with this name already exists.' }]);
      } else {
        alert('Could not save member: ' + e.message);
      }
    }
  }

  async function deleteMember(memberId) {
    if (!confirm('Delete this member and all their payment records?')) return;
    try { await DB.deleteMemberCascade(memberId); renderMemberList(); }
    catch (e) { alert('Could not delete member: ' + e.message); }
  }

  async function toggleStatus(memberId, currentStatus) {
    var newStatus = currentStatus === 'inactive' ? 'active' : 'inactive';
    try {
      var m = await DB.getMember(memberId);
      if (m) { m.status = newStatus; await DB.updateMember(m); }
      renderMemberList();
    } catch (e) { alert('Could not update status: ' + e.message); }
  }

  function hideForm() {
    var container = document.getElementById('member-form-container');
    if (container) container.setAttribute('hidden', '');
    editingMemberId = null;
  }

  function clearErrors() {
    document.querySelectorAll('#member-form .error-message').forEach(function (el) { el.textContent = ''; });
  }
  function showErrors(errors) {
    errors.forEach(function (e) {
      var el = document.getElementById(e.field + '-error');
      if (el) el.textContent = e.msg;
    });
  }

  async function exportMembers() {
    try {
      var members  = await DB.getAllMembers();
      var contribs = await DB.getAllContributions();
      var contribMap = {};
      contribs.forEach(function (c) { contribMap[c.memberId] = c; });

      var header = ['name','mobile','notes','status',
                    'monthlyFee','guestFee','activationDate','dueDay'];
      var rows   = [header];

      members.forEach(function (m) {
        var c = contribMap[m.id] || {};
        rows.push([
          m.name,
          m.mobile,
          m.notes    || '',
          m.status   || 'active',
          c.monthlyFee     != null ? c.monthlyFee     : '',
          c.guestFee       != null ? c.guestFee       : '',
          c.activationDate || '',
          c.dueDay         != null ? c.dueDay         : ''
        ]);
      });

      var csv = rows.map(function (r) {
        return r.map(function (v) { return '"' + String(v).replace(/"/g,'""') + '"'; }).join(',');
      }).join('\n');

      var blob = new Blob([csv], { type: 'text/csv' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href = url;
      a.download = 'TrackYourFitness_Members_' + new Date().toISOString().split('T')[0] + '.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert('Export failed: ' + e.message); }
  }

  // ── Robust CSV row parser (handles quoted fields with commas/newlines) ──
  function parseCSVRow(line) {
    var result = [], cur = '', inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQuote) {
        if (ch === '"') {
          if (line[i+1] === '"') { cur += '"'; i++; } // escaped quote
          else inQuote = false;
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') { inQuote = true; }
        else if (ch === ',') { result.push(cur.trim()); cur = ''; }
        else { cur += ch; }
      }
    }
    result.push(cur.trim());
    return result;
  }

  async function handleImportFile(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function (ev) {
      try {
        var lines = ev.target.result.split(/\r?\n/).filter(function (l) { return l.trim(); });
        if (lines.length < 2) { alert('CSV has no data rows.'); return; }

        var header = parseCSVRow(lines[0]).map(function (h) { return h.toLowerCase(); });
        var idx    = function (col) { return header.indexOf(col); };

        var addedMembers = 0, addedContribs = 0, skipped = 0;

        for (var i = 1; i < lines.length; i++) {
          var cols   = parseCSVRow(lines[i]);
          var name   = (cols[idx('name')]   || '').trim();
          var mobile = (cols[idx('mobile')] || '').trim();
          if (!name || !mobile) { skipped++; continue; }

          // Check member limit before each add
          var memberLimitErr = await License.checkMemberLimit();
          if (memberLimitErr) {
            skipped += (lines.length - i);
            alert('Import stopped at row ' + (i + 1) + ': ' + memberLimitErr);
            break;
          }

          var member = {
            id:        DB.generateId(),
            name:      name,
            mobile:    mobile,
            notes:     (cols[idx('notes')]  || '').trim(),
            status:    (cols[idx('status')] || 'active').trim(),
            createdAt: new Date().toISOString()
          };

          try {
            await DB.addMember(member);
            addedMembers++;

            // Import contribution if fee columns present
            var monthlyFee     = parseFloat(cols[idx('monthlyfee')])     || null;
            var guestFee       = parseFloat(cols[idx('guestfee')])       || null;
            var activationDate = (cols[idx('activationdate')] || '').trim() || null;
            var dueDay         = parseInt(cols[idx('dueday')], 10)        || null;

            // Clamp fees to license limits
            if (monthlyFee && License.checkMonthlyFee(monthlyFee)) {
              monthlyFee = License.LIMITS.MAX_MONTHLY_FEE;
            }
            if (guestFee && License.checkGuestFee(guestFee)) {
              guestFee = License.LIMITS.MAX_GUEST_FEE;
            }

            if (monthlyFee || guestFee || activationDate) {
              var contrib = {
                id:             DB.generateId(),
                memberId:       member.id,
                monthlyFee:     monthlyFee,
                guestFee:       guestFee || Settings.getDefaultGuestFee(),
                activationDate: activationDate,
                dueDay:         dueDay || 1,
                notes:          '',
                status:         'active',
                createdAt:      new Date().toISOString()
              };
              try { await DB.addContribution(contrib); addedContribs++; } catch (ex) { /* skip duplicate */ }
            }
          } catch (ex) { skipped++; }
        }

        var msg = 'Import complete!\n' +
          addedMembers + ' member(s) added' +
          (addedContribs > 0 ? ', ' + addedContribs + ' with contribution details' : '') +
          (skipped > 0 ? '\n' + skipped + ' row(s) skipped (duplicate name or invalid data)' : '');
        alert(msg);
        renderMemberList();
      } catch (ex) { alert('Import failed: ' + ex.message); }
      e.target.value = '';
    };
    reader.readAsText(file);
  }

  return { init, renderMemberList, showAddForm, showEditForm, hideForm };
})();
