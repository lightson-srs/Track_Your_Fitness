const Expenses = (function () {
  'use strict';

  var editingExpenseId = null;

  function esc(s) {
    return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
  }
  function getTodayISO() { return new Date().toISOString().split('T')[0]; }

  function init() {
    var addBtn      = document.getElementById('add-expense-btn');
    var form        = document.getElementById('expense-form');
    var cancelBtn   = document.getElementById('expense-cancel-btn');
    var startInput  = document.getElementById('expense-filter-start');
    var endInput    = document.getElementById('expense-filter-end');
    var searchInput = document.getElementById('expense-search');

    var today = getTodayISO();
    var monthStart = today.substring(0, 8) + '01';
    if (startInput && !startInput.value) { startInput.value = monthStart; syncDatePicker('expense-filter-start'); }
    if (endInput   && !endInput.value)   { endInput.value   = today;       syncDatePicker('expense-filter-end');   }

    if (addBtn)     addBtn.addEventListener('click', showAddForm);
    if (form)       form.addEventListener('submit', function (e) { e.preventDefault(); handleFormSubmit(); });
    if (cancelBtn)  cancelBtn.addEventListener('click', hideForm);
    if (startInput) startInput.addEventListener('change', renderExpenseList);
    if (endInput)   endInput.addEventListener('change', renderExpenseList);
    if (searchInput)searchInput.addEventListener('input', renderExpenseList);

    renderExpenseList();
  }

  async function renderExpenseList() {
    var container   = document.getElementById('expense-list');
    if (!container) return;
    var startInput  = document.getElementById('expense-filter-start');
    var endInput    = document.getElementById('expense-filter-end');
    var searchInput = document.getElementById('expense-search');
    var start       = startInput  ? startInput.value  : '';
    var end         = endInput    ? endInput.value    : '';
    var searchTerm  = searchInput ? searchInput.value.trim().toLowerCase() : '';

    container.innerHTML = '<p class="empty-message">Loading…</p>';

    try {
      var expenses = start && end
        ? await DB.getExpensesByDateRange(start, end)
        : await DB.getAllExpenses();

      if (searchTerm) {
        expenses = expenses.filter(function (ex) {
          return (ex.notes  || '').toLowerCase().indexOf(searchTerm) !== -1 ||
                 (ex.category || '').toLowerCase().indexOf(searchTerm) !== -1;
        });
      }

      expenses.sort(function (a, b) { return b.date.localeCompare(a.date); });

      if (expenses.length === 0) {
        container.innerHTML = '<p class="empty-message">No expenses found.</p>'; return;
      }

      var total = expenses.reduce(function (s, ex) { return s + (ex.amount || 0); }, 0);
      var html = '<div class="history-summary">Total expenses: <strong class="amount-due">₹' + total.toFixed(2) + '</strong> · ' + expenses.length + ' record(s)</div>';

      expenses.forEach(function (ex) {
        html += '<div class="client-card">';
        html += '<div class="client-header">';
        html += '<div class="client-info">';
        html += '<div class="client-name">₹' + (ex.amount || 0).toFixed(2) + '</div>';
        html += '<div class="client-mobile">' + fmtDate(ex.date) + '</div>';
        if (ex.category) html += '<div class="member-meta"><span class="loan-type-badge badge-expense">' + esc(ex.category) + '</span></div>';
        if (ex.notes)    html += '<div class="loan-notes" style="margin-top:4px;">' + esc(ex.notes) + '</div>';
        html += '</div>';
        html += '<div class="client-actions">';
        html += '<button class="btn-icon btn-edit-expense" data-id="' + ex.id + '" title="Edit">✏️</button>';
        html += '<button class="btn-icon btn-delete-expense" data-id="' + ex.id + '" title="Delete">🗑️</button>';
        html += '</div></div></div>';
      });

      container.innerHTML = html;

      container.querySelectorAll('.btn-edit-expense').forEach(function (btn) {
        btn.addEventListener('click', function () { showEditForm(btn.dataset.id); });
      });
      container.querySelectorAll('.btn-delete-expense').forEach(function (btn) {
        btn.addEventListener('click', function () { deleteExpense(btn.dataset.id); });
      });
    } catch (e) {
      container.innerHTML = '<p class="empty-message">Could not load expenses.</p>';
      console.error(e);
    }
  }

  function showAddForm() {
    editingExpenseId = null;
    var form      = document.getElementById('expense-form');
    var title     = document.getElementById('expense-form-title');
    var container = document.getElementById('expense-form-container');
    var dateInput = document.getElementById('expense-date');
    if (form)      form.reset();
    if (title)     title.textContent = 'Add expense';
    if (dateInput) { dateInput.value = getTodayISO(); syncDatePicker('expense-date'); }
    clearErrors();
    if (container) container.removeAttribute('hidden');
    var amtInput = document.getElementById('expense-amount');
    if (amtInput) amtInput.focus();
  }

  async function showEditForm(expenseId) {
    var ex = await DB.getExpense(expenseId);
    if (!ex) { alert('Expense not found.'); return; }
    editingExpenseId = expenseId;
    document.getElementById('expense-amount').value   = ex.amount || '';
    var _ed = document.getElementById('expense-date'); if (_ed) { _ed.value = ex.date || getTodayISO(); syncDatePicker('expense-date'); }
    document.getElementById('expense-category').value = ex.category || '';
    document.getElementById('expense-notes').value    = ex.notes  || '';
    document.getElementById('expense-form-title').textContent = 'Edit expense';
    clearErrors();
    document.getElementById('expense-form-container').removeAttribute('hidden');
  }

  async function handleFormSubmit() {
    clearErrors();
    var amount   = parseFloat((document.getElementById('expense-amount').value   || ''));
    var date     = (document.getElementById('expense-date').value     || '').trim();
    var category = (document.getElementById('expense-category').value || '').trim();
    var notes    = (document.getElementById('expense-notes').value    || '').trim();

    var errors = [];
    if (isNaN(amount) || amount <= 0) errors.push({ field: 'expense-amount', msg: 'Amount must be greater than zero.' });
    if (!date)                        errors.push({ field: 'expense-date',   msg: 'Date is required.' });
    if (errors.length > 0) { showErrors(errors); return; }

    var expense = {
      id:        editingExpenseId || DB.generateId(),
      amount:    amount,
      date:      date,
      category:  category,
      notes:     notes,
      createdAt: editingExpenseId ? undefined : new Date().toISOString()
    };

    try {
      if (editingExpenseId) {
        var existing = await DB.getExpense(editingExpenseId);
        if (existing) expense.createdAt = existing.createdAt;
        await DB.updateExpense(expense);
      } else {
        await DB.addExpense(expense);
      }
      hideForm();
      renderExpenseList();
    } catch (e) { alert('Could not save expense: ' + e.message); }
  }

  async function deleteExpense(expenseId) {
    if (!confirm('Delete this expense?')) return;
    try { await DB.deleteExpense(expenseId); renderExpenseList(); }
    catch (e) { alert('Could not delete: ' + e.message); }
  }

  function hideForm() {
    var container = document.getElementById('expense-form-container');
    if (container) container.setAttribute('hidden', '');
    editingExpenseId = null;
  }

  function clearErrors() {
    document.querySelectorAll('#expense-form .error-message').forEach(function (el) { el.textContent = ''; });
  }
  function showErrors(errors) {
    errors.forEach(function (e) {
      var el = document.getElementById(e.field + '-error');
      if (el) el.textContent = e.msg;
    });
  }

  return { init, renderExpenseList };
})();
