// ─── Global utilities ────────────────────────────────
// fmtDate: ISO YYYY-MM-DD → DD MMM YYYY for display
function fmtDate(iso) {
  if (!iso || typeof iso !== 'string') return iso || '';
  var parts = iso.split('-');
  if (parts.length !== 3) return iso;
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var d = parseInt(parts[2], 10);
  var m = parseInt(parts[1], 10) - 1;
  var y = parts[0];
  if (isNaN(d) || isNaN(m) || m < 0 || m > 11) return iso;
  return d + ' ' + months[m] + ' ' + y;
}

// fmtPeriod: YYYY-MM → "Jun 2026"
function fmtPeriod(period) {
  if (!period || typeof period !== 'string') return period || '';
  var parts = period.split('-');
  if (parts.length < 2) return period;
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var m = parseInt(parts[1], 10) - 1;
  return (m >= 0 && m <= 11 ? months[m] : parts[1]) + ' ' + parts[0];
}

// ─── Custom date picker ───────────────────────────────
// Wraps every .date-picker-hidden input with a DD MMM YYYY display label.
// The hidden input stores YYYY-MM-DD; the display div shows DD MMM YYYY.
// Clicking the display opens the native calendar picker.

function initDatePickers() {
  document.querySelectorAll('.date-picker-hidden').forEach(function (input) {
    var display = document.querySelector('.date-picker-display[data-for="' + input.id + '"]');
    if (!display) return;

    function syncDisplay() {
      display.textContent = input.value ? fmtDate(input.value) : 'Select date';
      display.classList.toggle('date-picker-empty', !input.value);
    }

    // Bind only once
    if (!input._datepickerInit) {
      input._datepickerInit = true;
      display.addEventListener('click', function () {
        try { input.showPicker(); } catch(e) { input.focus(); input.click(); }
      });
      input.addEventListener('change', syncDisplay);
      input.addEventListener('input', syncDisplay);
    }
    syncDisplay();
  });
}

// Re-sync a single date picker by id (call after programmatically setting .value)
function syncDatePicker(id) {
  var input = document.getElementById(id);
  if (!input) return;
  var display = document.querySelector('.date-picker-display[data-for="' + id + '"]');
  if (!display) return;
  display.textContent = input.value ? fmtDate(input.value) : 'Select date';
  display.classList.toggle('date-picker-empty', !input.value);
}
