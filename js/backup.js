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
      var attendance        = await DB.getAllAttendance();
      var settings         = Settings.getAllSettings();

      // Include Firebase/sync config
      var firestoreConfig = null;
      if (typeof FirestoreConfig !== 'undefined' && FirestoreConfig.hasConfig()) {
        firestoreConfig = {
          config: FirestoreConfig.getConfig(),
          collectionName: FirestoreConfig.getCollectionName(),
          syncEnabled: FirestoreConfig.isSyncEnabled()
        };
      }

      var backupData = {
        version:   6,
        appName:   Settings.getAppName(),
        createdAt: new Date().toISOString(),
        data: {
          members,
          contributions,
          payments,
          expenses,
          guestSessions,
          monthlyFeeRecs,
          attendance,
          settings,
          firestoreConfig
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
      if (typeof Audit !== 'undefined') Audit.writeAudit('BK', {});

      var counts = members.length + ' members, ' +
        contributions.length + ' contributions, ' +
        payments.length + ' payments, ' +
        expenses.length + ' expenses, ' +
        guestSessions.length + ' guest sessions, ' +
        monthlyFeeRecs.length + ' fee records, ' +
        attendance.length + ' attendance records';
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

        // Hard lock: restoring data requires a valid license. (Normally the
        // app is blocked before reaching here, but guard explicitly so an
        // unlicensed restore can never partially overwrite data.)
        if (typeof License !== 'undefined' && !License.isLicensed()) {
          alert('A valid license is required to restore a backup.\nPlease activate a license and try again.');
          return;
        }

        var {
          members        = [],
          contributions  = [],
          payments       = [],
          expenses       = [],
          guestSessions  = [],
          monthlyFeeRecs = [],
          attendance     = [],
          settings       = {},
          firestoreConfig = null
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

        var remainingAtt = await DB.getAllAttendance();
        for (var at of remainingAtt) await DB.deleteAttendance(at.id);

        // ── Restore in dependency order ──
        // Licensed users get a faithful, unclamped restore (hard-lock model:
        // either fully licensed with no limits, or blocked entirely).
        for (var member of members) {
          await DB.addMember(member);
        }

        for (var contrib of contributions) {
          await DB.addContribution(contrib);
        }

        for (var payment of payments) {
          await DB.addPayment(payment);
        }

        for (var expense  of expenses)      await DB.addExpense(expense);

        for (var gs of guestSessions) {
          await DB.addGuestSession(gs);
        }

        for (var mfr of monthlyFeeRecs) {
          await DB.addMonthlyFeeRecord(mfr);
        }

        // Restore attendance records
        for (var att of attendance) {
          try { await DB.addAttendance(att); } catch (ea) {}
        }

        // Restore Firestore/DB config if present, then reconnect so the app
        // uses the restored database going forward (no reload required).
        if (firestoreConfig && typeof FirestoreConfig !== 'undefined') {
          if (firestoreConfig.config) FirestoreConfig.setConfig(firestoreConfig.config);
          if (firestoreConfig.collectionName) FirestoreConfig.setCollectionName(firestoreConfig.collectionName);
          if (firestoreConfig.syncEnabled !== undefined) FirestoreConfig.setSyncEnabled(firestoreConfig.syncEnabled);

          // Re-init the sync engine with the restored config so it connects now.
          if (typeof SyncEngine !== 'undefined' && SyncEngine.reinitialize) {
            try { SyncEngine.reinitialize(); } catch (e) {}
          }
          // Refresh the Settings Cloud Sync fields + status if that module is loaded.
          if (typeof Settings !== 'undefined' && Settings.initSyncSettings) {
            try { Settings.initSyncSettings(); } catch (e) {}
          }
        }

        // ── Restore settings ──
        Settings.restoreSettings(settings);
        Settings.applyTheme();
        Settings.updateAppNameDisplay();

        Settings.setLastBackup(getTodayISO());
        displayLastBackupInfo();

        // Audit the restore. Awaited (not fire-and-forget) because the reload
        // below would otherwise race the async write before it commits.
        if (typeof Audit !== 'undefined' && typeof DB !== 'undefined' && DB.addAuditRecord) {
          try {
            var _rsNow = Date.now();
            await DB.addAuditRecord({ id: DB.generateId(), t: _rsNow, c: 'RS', p: {}, day: Audit.dayKey(_rsNow) });
          } catch (e) { /* non-fatal */ }
        }

        alert('Restore complete!\n\n' +
          '  Members:        ' + members.length        + '\n' +
          '  Contributions:  ' + contributions.length  + '\n' +
          '  Payments:       ' + payments.length       + '\n' +
          '  Expenses:       ' + expenses.length       + '\n' +
          '  Guest sessions: ' + guestSessions.length  + '\n' +
          '  Fee records:    ' + monthlyFeeRecs.length + '\n' +
          '  Attendance:     ' + attendance.length     + '\n' +
          '  Firestore config: ' + (firestoreConfig ? 'Yes' : 'No') + '\n\n' +
          'The app will now reload to apply restored settings & license.');

        // Reload so the restored localStorage (app name, UPI, default guest fee,
        // license key, theme, etc.) is reflected everywhere: the index.html
        // license IIFE recomputes window._isLicensed, and License.init /
        // Settings.init repopulate the banner and all Settings form fields.
        // A plain screen refresh is NOT enough — it leaves the license state and
        // Settings form showing pre-restore values until the next load.
        window.location.reload();

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
