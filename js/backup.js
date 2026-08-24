const Backup = (function () {
  'use strict';

  function getTodayISO() { return new Date().toISOString().split('T')[0]; }

  function init() {
    var backupBtn   = document.getElementById('backup-btn');
    var restoreBtn  = document.getElementById('restore-btn');
    var restoreFile = document.getElementById('restore-file');
    if (backupBtn)   backupBtn.addEventListener('click', createBackup);
    if (restoreBtn)  restoreBtn.addEventListener('click', function () { if (restoreFile) restoreFile.click(); });
    if (restoreFile) restoreFile.addEventListener('change', handleRestoreFile);
    displayLastBackupInfo();
  }

  function displayLastBackupInfo() {
    var el = document.getElementById('backup-last-info');
    if (!el) return;
    var last = Settings.getLastBackup();
    el.textContent = last ? 'Last backup: ' + fmtDate(last) : 'No backups yet.';
  }

  // ─── Create backup ─────────────────────────────────
  async function createBackup() {
    try {
      var members          = await DB.getAllMembers();
      var contributions    = await DB.getAllContributions();
      var payments         = await DB.getAllPayments();
      var expenses         = await DB.getAllExpenses();
      var guestSessions    = await DB.getAllGuestSessions();
      var monthlyFeeRecs   = await DB.getAllMonthlyFeeRecords();
      var settings         = Settings.getAllSettings();

      var backupData = {
        version:   5,
        appName:   Settings.getAppName(),
        createdAt: new Date().toISOString(),
        data: {
          members,
          contributions,
          payments,
          expenses,
          guestSessions,
          monthlyFeeRecs,
          settings
        }
      };

      var json = JSON.stringify(backupData, null, 2);
      var blob = new Blob([json], { type: 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href = url;
      a.download = 'TrackYourFitness_Backup_' + getTodayISO() + '.json';
      a.click();
      URL.revokeObjectURL(url);

      Settings.setLastBackup(getTodayISO());
      displayLastBackupInfo();

      var counts = members.length + ' members, ' +
        contributions.length + ' contributions, ' +
        payments.length + ' payments, ' +
        expenses.length + ' expenses, ' +
        guestSessions.length + ' guest sessions, ' +
        monthlyFeeRecs.length + ' fee records';
      console.log('Backup created:', counts);
    } catch (e) {
      alert('Backup failed: ' + e.message);
    }
  }

  // ─── Restore ───────────────────────────────────────
  async function handleRestoreFile(e) {
    var file = e.target.files[0];
    if (!file) return;
    if (!confirm('Restoring will replace ALL current data. This cannot be undone. Continue?')) {
      e.target.value = ''; return;
    }

    var reader = new FileReader();
    reader.onload = async function (ev) {
      try {
        var data = JSON.parse(ev.target.result);
        if (!data || !data.data) { alert('Invalid backup file.'); return; }

        var {
          members       = [],
          contributions = [],
          payments      = [],
          expenses      = [],
          guestSessions = [],
          monthlyFeeRecs= [],
          settings      = {}
        } = data.data;

        // ── Clear all stores ──
        // Use cascade for members (handles payments, guest_sessions,
        // monthly_fee_records, contributions in one shot)
        var allMembers = await DB.getAllMembers();
        for (var m of allMembers) await DB.deleteMemberCascade(m.id);

        // Clear any orphaned records not linked to members
        // (e.g. expenses, or records from deleted members)
        var remainingGs  = await DB.getAllGuestSessions();
        for (var g  of remainingGs)  await DB.deleteGuestSession(g.id);

        var remainingMfr = await DB.getAllMonthlyFeeRecords();
        for (var mf of remainingMfr) await DB.deleteMonthlyFeeRecord(mf.id);

        var remainingExp = await DB.getAllExpenses();
        for (var ex of remainingExp) await DB.deleteExpense(ex.id);

        var remainingPay = await DB.getAllPayments();
        for (var p  of remainingPay) await DB.deletePayment(p.id);

        var remainingCon = await DB.getAllContributions();
        for (var c  of remainingCon) await DB.deleteContribution(c.id);

        // ── Restore in dependency order — enforce license limits ──
        var maxMembers   = License.getMaxMembers();
        var activeCount  = 0;
        var skippedMembers = 0;

        for (var member of members) {
          if (member.status !== 'inactive') {
            if (activeCount >= maxMembers) { skippedMembers++; continue; }
            activeCount++;
          }
          await DB.addMember(member);
        }

        // Clamp fees on contributions to license limits
        for (var contrib of contributions) {
          if (License.checkMonthlyFee(contrib.monthlyFee || 0))
            contrib.monthlyFee = License.LIMITS.MAX_MONTHLY_FEE;
          if (License.checkGuestFee(contrib.guestFee || 0))
            contrib.guestFee   = License.LIMITS.MAX_GUEST_FEE;
          await DB.addContribution(contrib);
        }

        // Clamp payment/session amounts
        for (var payment of payments) {
          if (payment.type === 'monthly'    && License.checkMonthlyFee(payment.amount || 0))
            payment.amount = License.LIMITS.MAX_MONTHLY_FEE;
          if (payment.type === 'guest_play' && License.checkGuestFee(payment.amount || 0))
            payment.amount = License.LIMITS.MAX_GUEST_FEE;
          await DB.addPayment(payment);
        }

        for (var expense  of expenses)      await DB.addExpense(expense);

        for (var gs of guestSessions) {
          if (License.checkGuestFee(gs.fee || 0)) gs.fee = License.LIMITS.MAX_GUEST_FEE;
          await DB.addGuestSession(gs);
        }

        for (var mfr of monthlyFeeRecs) {
          if (License.checkMonthlyFee(mfr.fee || 0)) mfr.fee = License.LIMITS.MAX_MONTHLY_FEE;
          await DB.addMonthlyFeeRecord(mfr);
        }

        if (skippedMembers > 0) {
          alert('Note: ' + skippedMembers + ' member(s) were skipped — unlicensed limit of ' + maxMembers + ' active members reached. Fees above limits were capped automatically.');
        }

        // ── Restore settings ──
        Settings.restoreSettings(settings);
        Settings.applyTheme();
        Settings.updateAppNameDisplay();

        if (!skippedMembers) {
          alert('Restore complete!\n\n' +
            '  Members:        ' + members.length        + '\n' +
            '  Contributions:  ' + contributions.length  + '\n' +
            '  Payments:       ' + payments.length       + '\n' +
            '  Expenses:       ' + expenses.length       + '\n' +
            '  Guest sessions: ' + guestSessions.length  + '\n' +
            '  Fee records:    ' + monthlyFeeRecs.length);
        }

        Settings.setLastBackup(getTodayISO());
        displayLastBackupInfo();

        // Refresh current screen
        if (typeof App !== 'undefined') App.navigateToScreen('members-screen');

      } catch (ex) {
        alert('Restore failed: ' + ex.message);
        console.error(ex);
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  }

  // ─── Backup reminder ───────────────────────────────
  function checkBackupReminder() {
    var freq = Settings.getBackupFrequency();
    if (!freq) return;
    var last = Settings.getLastBackup();
    if (!last) return;
    var diff = Math.floor((new Date() - new Date(last + 'T00:00:00')) / 86400000);
    if (diff >= freq) {
      setTimeout(function () {
        alert('Reminder: Your last backup was ' + diff + ' day(s) ago.\nCreate a new backup in Settings → Backup & restore.');
      }, 1500);
    }
  }

  return { init, createBackup, checkBackupReminder };
})();
