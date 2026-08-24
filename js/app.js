var App = (function () {
  'use strict';
  var currentScreen = 'members-screen';
  var moreScreens   = ['history-screen','contributions-screen','expenses-screen','reports-screen','settings-screen'];

  async function initApp() {
    try {
      Settings.applyTheme();
      // Clear any stale/invalid license key from previous versions
      try {
        var storedKey = localStorage.getItem('tyf_license_key');
        if (storedKey) {
          // Validate format — must be base64 JSON with { n, h } where h is 64 chars
          var valid = false;
          var cleanKey = storedKey.replace(/[\s\r\n]+/g, '');
          try { var d = JSON.parse(atob(cleanKey)); valid = !!(d && d.n && d.h && d.h.length === 64); } catch(e) {}
          if (!valid) { localStorage.removeItem('tyf_license_key'); console.log('Cleared invalid license key'); }
          else if (cleanKey !== storedKey) { localStorage.setItem('tyf_license_key', cleanKey); console.log('Cleaned whitespace from license key'); }
        }
      } catch(e) {}
      await DB.init();
      if (typeof SetupWizard !== 'undefined') SetupWizard.init();
      if (typeof SyncEngine !== 'undefined') SyncEngine.init();
      if (typeof LicenseRegistry !== 'undefined') LicenseRegistry.report();
      Settings.init();
      if (typeof License !== 'undefined') License.init();
      Members.init();
      Contributions.init();
      Monthly.init();
      GuestPlay.init();
      Expenses.init();
      PaymentHistory.init();
      Reports.init();
      WhatsApp.init();
      Backup.init();
      setupTabNavigation();
      Settings.updateAppNameDisplay();
      initDatePickers();
      registerServiceWorker();
      Backup.checkBackupReminder();

      // Listen for remote sync updates
      document.addEventListener('tyf-sync-update', function () {
        refreshScreenData(currentScreen);
      });

      // Sync button in header
      initSyncButton();
    } catch (e) {
      console.error('App init failed:', e);
      alert('Could not initialize app: ' + e.message);
    }
  }

  function navigateToScreen(screenId) {
    document.querySelectorAll('.screen').forEach(function (s) { s.setAttribute('hidden', ''); });
    var target = document.getElementById(screenId);
    if (target) target.removeAttribute('hidden');
    document.querySelectorAll('.nav-tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-screen') === screenId);
    });
    currentScreen = screenId;
    refreshScreenData(screenId);
    initDatePickers();
  }

  function refreshScreenData(screenId) {
    switch (screenId) {
      case 'monthly-screen':       if (typeof Monthly       !== 'undefined') Monthly.renderMonthlyList();       break;
      case 'guest-screen':         if (typeof GuestPlay     !== 'undefined') GuestPlay.renderGuestList();       break;
      case 'members-screen':       if (typeof Members       !== 'undefined') Members.renderMemberList();        break;
      case 'contributions-screen': if (typeof Contributions !== 'undefined') Contributions.renderContribList(); break;
      case 'expenses-screen':      if (typeof Expenses      !== 'undefined') Expenses.renderExpenseList();      break;
      case 'history-screen':       if (typeof PaymentHistory!== 'undefined') PaymentHistory.renderHistory();    break;
      case 'reports-screen':       if (typeof Reports       !== 'undefined') Reports.renderActiveReport();      break;
    }
  }

  function openMoreMenu() {
    var menu     = document.getElementById('more-menu');
    var backdrop = document.getElementById('more-menu-backdrop');
    if (menu)     menu.removeAttribute('hidden');
    if (backdrop) backdrop.removeAttribute('hidden');
  }

  function closeMoreMenu() {
    var menu     = document.getElementById('more-menu');
    var backdrop = document.getElementById('more-menu-backdrop');
    if (menu)     menu.setAttribute('hidden', '');
    if (backdrop) backdrop.setAttribute('hidden', '');
  }

  function setupTabNavigation() {
    // Main nav tabs
    document.querySelectorAll('.nav-tab[data-screen]').forEach(function (tab) {
      tab.addEventListener('click', function (e) {
        e.preventDefault();
        navigateToScreen(tab.getAttribute('data-screen'));
      });
    });

    // More button
    var moreBtn = document.getElementById('more-btn');
    if (moreBtn) {
      moreBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var menu = document.getElementById('more-menu');
        if (menu && !menu.hasAttribute('hidden')) closeMoreMenu();
        else openMoreMenu();
      });
    }

    // More menu items
    document.querySelectorAll('.more-menu-item').forEach(function (item) {
      item.addEventListener('click', function () {
        navigateToScreen(item.getAttribute('data-screen'));
      });
    });

    // Backdrop closes menu
    var backdrop = document.getElementById('more-menu-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeMoreMenu);

    navigateToScreen(currentScreen);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('sw.js')
      .then(function (reg) {
        console.log('SW registered:', reg.scope);

        // Poll for new SW waiting to activate
        reg.addEventListener('updatefound', function () {
          var newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', function () {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New SW installed — it will self-activate via skipWaiting
              console.log('SW update found, waiting for activation...');
            }
          });
        });
      })
      .catch(function (err) { console.log('SW failed:', err); });

    // Listen for SW_UPDATED message — reload to get new files
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'SW_UPDATED') {
        console.log('New version available — reloading...');
        window.location.reload();
      }
    });

    // Also handle controller change (SW took control)
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }

  // --- Sync button in header ---
  function initSyncButton() {
    var syncBtn = document.getElementById('sync-btn');
    if (!syncBtn) return;

    // Show button only if sync is configured
    if (typeof FirestoreConfig !== 'undefined' && FirestoreConfig.hasConfig()) {
      syncBtn.removeAttribute('hidden');
    }

    syncBtn.addEventListener('click', async function () {
      if (typeof SyncEngine === 'undefined') return;

      // Spinning animation
      syncBtn.style.animation = 'spin 1s linear infinite';
      syncBtn.disabled = true;

      try {
        if (SyncEngine.getStatus() === 'connected') {
          await SyncEngine.flushQueue();
        } else {
          await SyncEngine.reinitialize();
        }
      } catch (e) {
        console.error('Manual sync failed:', e);
      }

      syncBtn.disabled = false;
      syncBtn.style.animation = '';

      // Update settings sync status if visible
      if (typeof Settings !== 'undefined' && Settings.updateSyncStatus) {
        Settings.updateSyncStatus();
      }
    });

    // Also show/hide based on sync config changes
    document.addEventListener('tyf-sync-update', function () {
      if (typeof FirestoreConfig !== 'undefined' && FirestoreConfig.hasConfig()) {
        syncBtn.removeAttribute('hidden');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', initApp);
  return { initApp, navigateToScreen, refreshScreenData };
})();
