const Members = (function () {
  'use strict';

  var editingMemberId = null;
  var currentMemberPhoto = null; // holds base64 data URL of captured/selected photo

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
    var photoBtn   = document.getElementById('member-photo-btn');
    var photoInput = document.getElementById('member-photo-input');

    if (addBtn)     addBtn.addEventListener('click', showAddForm);
    var typeSelect = document.getElementById('member-type');
    var typeCustom = document.getElementById('member-type-custom');
    if (typeSelect) {
      typeSelect.addEventListener('change', function () {
        if (typeCustom) typeCustom.hidden = (typeSelect.value !== 'Other');
      });
    }
    if (form)       form.addEventListener('submit', function (e) { e.preventDefault(); handleFormSubmit(); });
    if (cancelBtn)  cancelBtn.addEventListener('click', hideForm);
    if (searchInput)searchInput.addEventListener('input', function () { renderMemberList(searchInput.value.trim()); });
    if (exportBtn)  exportBtn.addEventListener('click', exportMembers);
    if (importBtn)  importBtn.addEventListener('click', function () { if (importFile) importFile.click(); });
    if (importFile) importFile.addEventListener('change', handleImportFile);

    // Photo capture
    if (photoBtn)   photoBtn.addEventListener('click', function () { if (photoInput) photoInput.click(); });
    if (photoInput) photoInput.addEventListener('change', function () {
      var file = photoInput.files[0];
      if (!file) return;
      compressPhoto(file, function (dataUrl) {
        currentMemberPhoto = dataUrl;
        showPhotoPreview(dataUrl);
      });
      photoInput.value = '';
    });

    renderMemberList();
  }

  function compressPhoto(file, callback) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        var size = 200;
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        // Crop to square from center
        var sx = 0, sy = 0, sw = img.width, sh = img.height;
        if (sw > sh) { sx = (sw - sh) / 2; sw = sh; }
        else { sy = (sh - sw) / 2; sh = sw; }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.5);
        callback(dataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function showPhotoPreview(dataUrl) {
    var preview = document.getElementById('member-photo-preview');
    if (preview) {
      preview.innerHTML = '<img src="' + dataUrl + '" style="width:100%;height:100%;object-fit:cover;">';
    }
  }

  function clearPhotoPreview() {
    currentMemberPhoto = null;
    var preview = document.getElementById('member-photo-preview');
    if (preview) {
      preview.innerHTML = '<span style="font-size:2rem;color:var(--text3);">👤</span>';
    }
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
        members = members.filter(function (m) {
          return m.name.toLowerCase().indexOf(lower) !== -1 ||
            (m.memberType && m.memberType.toLowerCase().indexOf(lower) !== -1) ||
            (m.notes && m.notes.toLowerCase().indexOf(lower) !== -1);
        });
      }
      if (members.length === 0) { container.innerHTML = '<p class="empty-message">No members match your search.</p>'; return; }

      members.sort(function (a, b) { return a.name.localeCompare(b.name); });

      var html = '';
      members.forEach(function (m) {
        var contrib = contribMap[m.id];
        var statusClass = m.status === 'inactive' ? ' member-inactive' : '';

        var avatar = m.photo
          ? '<img src="' + esc(m.photo) + '" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;">'
          : '<span style="width:32px;height:32px;border-radius:50%;background:var(--bg3);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-size:0.9rem;">👤</span>';

        html += '<div class="member-card' + statusClass + '">';
        html += '<div class="client-header">';
        html += '<div class="client-info" style="display:flex;gap:8px;align-items:center;">';
        html += avatar;
        html += '<div>';
        html += '<div class="client-name">' + esc(m.name) + '</div>';
        html += '<div class="client-mobile">' + esc(m.mobile) + '</div>';
        html += '<div class="member-meta">';
        if (m.memberType && m.memberType !== 'Regular') {
          html += '<span class="loan-type-badge badge-guest">' + esc(m.memberType) + '</span> ';
        }
        if (contrib) {
          html += '<span class="loan-type-badge badge-monthly">₹' + (contrib.monthlyFee||0).toFixed(0) + '/mo</span>';
          if (contrib.activationDate) html += ' <span class="member-fee">from ' + fmtDate(contrib.activationDate) + '</span>';
        } else {
          html += '<span class="loan-type-badge badge-guest">No contribution set</span>';
        }
        if (m.notes) html += ' <span class="loan-notes">' + esc(m.notes) + '</span>';
        if (m.validTill) {
          var isExpired = m.validTill < new Date().toISOString().split('T')[0];
          html += ' <span class="loan-notes" style="color:' + (isExpired ? 'var(--danger)' : 'var(--success)') + ';">Valid: ' + fmtDate(m.validTill) + '</span>';
        }
        html += '</div></div></div>';
        html += '<div class="client-actions">';
        html += '<button class="btn-icon btn-print-id" data-id="' + m.id + '" title="Print ID">🪪</button>';
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
      container.querySelectorAll('.btn-print-id').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var member = await DB.getMember(btn.dataset.id);
          if (member && typeof IdCard !== 'undefined') IdCard.generate(member);
        });
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
    var typeSelect2 = document.getElementById('member-type');
    var typeCustom2 = document.getElementById('member-type-custom');
    if (typeSelect2) typeSelect2.value = 'Regular';
    if (typeCustom2) { typeCustom2.value = ''; typeCustom2.hidden = true; }
    document.getElementById('member-valid-till').value = '';
    if (title) title.textContent = 'Add member';
    if (container) container.removeAttribute('hidden');
    clearPhotoPreview();
    clearErrors();
  }

  async function showEditForm(memberId) {
    var m = await DB.getMember(memberId);
    if (!m) { alert('Member not found.'); return; }
    editingMemberId = memberId;
    document.getElementById('member-name').value   = m.name;
    document.getElementById('member-mobile').value = m.mobile;
    document.getElementById('member-notes').value  = m.notes || '';
    var typeSelect3 = document.getElementById('member-type');
    var typeCustom3 = document.getElementById('member-type-custom');
    var storedType = m.memberType || 'Regular';
    if (typeSelect3) {
      // Check if storedType is one of the select options
      var isStandard = (storedType === 'Regular' || storedType === 'Coaching' || storedType === 'Other');
      if (isStandard) { typeSelect3.value = storedType; if (typeCustom3) { typeCustom3.value = ''; typeCustom3.hidden = true; } }
      else { typeSelect3.value = 'Other'; if (typeCustom3) { typeCustom3.value = storedType; typeCustom3.hidden = false; } }
    }
    document.getElementById('member-valid-till').value = m.validTill || '';
    // Show existing photo or clear
    if (m.photo) {
      currentMemberPhoto = m.photo;
      showPhotoPreview(m.photo);
    } else {
      clearPhotoPreview();
    }
    document.getElementById('member-form-title').textContent = 'Edit member';
    document.getElementById('member-form-container').removeAttribute('hidden');
    clearErrors();
  }

  async function handleFormSubmit() {
    clearErrors();
    var name   = (document.getElementById('member-name').value   || '').trim();
    var mobile = (document.getElementById('member-mobile').value || '').trim();
    var notes  = (document.getElementById('member-notes').value  || '').trim();
    var typeSelectVal = document.getElementById('member-type') ? document.getElementById('member-type').value : 'Regular';
    var typeCustomVal = document.getElementById('member-type-custom') ? document.getElementById('member-type-custom').value.trim() : '';
    var memberType = (typeSelectVal === 'Other' && typeCustomVal) ? typeCustomVal : typeSelectVal;

    var errors = [];
    if (!name)                               errors.push({ field: 'member-name',   msg: 'Name is required.' });
    if (!mobile || !/^\d{10}$/.test(mobile)) errors.push({ field: 'member-mobile', msg: 'Mobile must be 10 digits.' });
    if (errors.length > 0) { showErrors(errors); return; }

    var validTill = (document.getElementById('member-valid-till').value || '').trim();

    var member = {
      id: editingMemberId || DB.generateId(),
      name: name, mobile: mobile, notes: notes,
      memberType: memberType,
      validTill: validTill || '',
      photo: currentMemberPhoto || null,
      status: 'active',
      createdAt: editingMemberId ? undefined : new Date().toISOString()
    };

    try {
      if (editingMemberId) {
        var existing = await DB.getMember(editingMemberId);
        if (existing) {
          member.createdAt = existing.createdAt;
          member.status = existing.status;
          // Preserve existing photo if no new one was captured
          if (!member.photo && existing.photo) member.photo = existing.photo;
          // Preserve validTill if not explicitly set in form
          if (!member.validTill && existing.validTill) member.validTill = existing.validTill;
        }
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
    clearPhotoPreview();
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

      var header = ['name','mobile','notes','status','memberType',
                    'monthlyFee','guestFee','activationDate','dueDay'];
      var rows   = [header];

      members.forEach(function (m) {
        var c = contribMap[m.id] || {};
        rows.push([
          m.name,
          m.mobile,
          m.notes    || '',
          m.status   || 'active',
          m.memberType || 'Regular',
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
            memberType: (cols[idx('membertype')] || 'Regular').trim(),
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
