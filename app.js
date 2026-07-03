// ================================================================
// मल्लविद्या कुस्ती केंद्र — V2 Application Script
// Feature 11: Safe V1→V2 Data Migration + IndexedDB Primary Storage
// ================================================================

// ================================================================
// LOCALFORAGE INSTANCE CONFIGURATION (IndexedDB via localforage)
// ================================================================
localforage.config({
  driver: [localforage.INDEXEDDB, localforage.WEBSQL, localforage.LOCALSTORAGE],
  name: 'MallavidyaKustiKendra',
  version: 2.0,
  storeName: 'mkk_data',
  description: 'मल्लविद्या कुस्ती केंद्र — V2 Data Store'
});

// ================================================================
// IN-MEMORY CACHE (enables sync reads throughout app)
// IndexedDB is async; we load everything into this cache at startup,
// then all reads are instant sync from cache, all writes go to both.
// ================================================================
const _cache = {
  wrestlers: [],
  attendance: {},
  settings: {},
  ready: false
};

// ================================================================
// DB — PRIMARY DATABASE INTERFACE (IndexedDB + cache)
// Auth flags stay in localStorage (tiny, safe, fast).
// ================================================================
const DB = {
  // ---- SYNC READS (from in-memory cache) ----
  getWrestlers: () => _cache.wrestlers,
  getAttendance: () => _cache.attendance,
  getSettings: () => _cache.settings,

  // ---- ASYNC WRITES (cache + IndexedDB) ----
  saveWrestlers: (data) => {
    _cache.wrestlers = data;
    return localforage.setItem('m_wrestlers', data)
      .catch(e => console.error('[DB] saveWrestlers error:', e));
  },
  saveAttendance: (data) => {
    _cache.attendance = data;
    return localforage.setItem('m_attendance', data)
      .catch(e => console.error('[DB] saveAttendance error:', e));
  },
  saveSettings: (data) => {
    _cache.settings = data;
    return localforage.setItem('m_settings', data)
      .catch(e => console.error('[DB] saveSettings error:', e));
  },

  // ---- AUTH (localStorage — persistent device flag) ----
  isAuthenticated: () => localStorage.getItem('m_app_authenticated') === 'true',
  setAuthenticated: () => localStorage.setItem('m_app_authenticated', 'true'),
  clearAuthentication: () => localStorage.removeItem('m_app_authenticated'),

  // ---- LOAD ALL DATA INTO CACHE (called once on startup) ----
  hydrateCache: async () => {
    const [wrestlers, attendance, settings] = await Promise.all([
      localforage.getItem('m_wrestlers'),
      localforage.getItem('m_attendance'),
      localforage.getItem('m_settings')
    ]);
    _cache.wrestlers  = wrestlers  || [];
    _cache.attendance = attendance || {};
    _cache.settings   = settings  || {};
    _cache.ready = true;
  }
};

// ================================================================
// FEATURE 11: V1 → V2 SAFE DATA MIGRATION SYSTEM
// ================================================================
// Strategy:
//  1. Check if migration has already been done (idempotent).
//  2. If not, scan localStorage for ALL V1 keys.
//  3. Parse and validate each key before touching IndexedDB.
//  4. If IndexedDB already has data → MERGE (never overwrite).
//  5. On conflict: V2/IndexedDB data wins (newer is authoritative).
//  6. On success: set migration flag. NEVER delete V1 localStorage data.
//  7. All steps logged with timestamps to localStorage for debugging.
// ================================================================

const MIGRATION_FLAG_KEY = 'm_v2_migration_done';
const MIGRATION_LOG_KEY  = 'm_v2_migration_log';

// V1 localStorage keys to migrate
const V1_KEYS = {
  wrestlers : 'm_wrestlers',
  attendance: 'm_attendance',
  settings  : 'm_settings'
};

function updateMigrationUI(message, progressPercent) {
  const msg = document.getElementById('migration-status-msg');
  const bar = document.getElementById('migration-progress-bar');
  const logList = document.getElementById('migration-log-list');

  if (msg) msg.textContent = message;
  if (bar) bar.style.width = `${progressPercent}%`;
  if (logList && message) {
    const item = document.createElement('p');
    item.className = 'text-xs text-green-400 font-medium';
    item.textContent = message;
    logList.appendChild(item);
  }
}

/**
 * Deep-merges two wrestler arrays.
 * V2 data wins for same id. V1-only wrestlers are appended.
 * @param {Array} v2Array - existing IndexedDB data (authoritative)
 * @param {Array} v1Array - V1 localStorage data (donor)
 * @returns {Array} merged array
 */
function mergeWrestlers(v2Array, v1Array) {
  const merged = [...v2Array];
  const existingIds = new Set(v2Array.map(w => w.id));

  v1Array.forEach(v1Wrestler => {
    if (!existingIds.has(v1Wrestler.id)) {
      // V1 wrestler not in V2 → add it (zero data loss)
      merged.push(v1Wrestler);
      existingIds.add(v1Wrestler.id);
    }
    // else: V2 version is authoritative (newer edits preserved)
  });

  return merged;
}

/**
 * Deep-merges two attendance objects.
 * For the same date+shift+wrestler combination:
 *   V2 data wins (authoritative). V1 fills in missing dates.
 * @param {Object} v2Obj - existing IndexedDB data
 * @param {Object} v1Obj - V1 localStorage data
 * @returns {Object} merged object
 */
function mergeAttendance(v2Obj, v1Obj) {
  const merged = { ...v1Obj }; // Start with V1 as base

  // Overlay V2 on top (V2 wins on conflict)
  Object.keys(v2Obj).forEach(date => {
    if (!merged[date]) {
      merged[date] = v2Obj[date];
    } else {
      // Merge shifts within the same date
      merged[date] = {
        morning: { ...(merged[date].morning || {}), ...(v2Obj[date].morning || {}) },
        evening: { ...(merged[date].evening || {}), ...(v2Obj[date].evening || {}) }
      };
    }
  });

  return merged;
}

/**
 * Merges two settings objects. V2 wins on conflict.
 */
function mergeSettings(v2Obj, v1Obj) {
  return { ...v1Obj, ...v2Obj }; // V2 overwrites V1 on conflict
}

/**
 * Main migration entry point.
 * Safe, idempotent, non-destructive.
 * Returns: { success: Boolean, log: String[], migrated: Boolean }
 */
async function runV1toV2Migration() {
  const log = [];
  const timestamp = new Date().toISOString();

  log.push(`[${timestamp}] V1→V2 Migration started`);
  updateMigrationUI('V1 माहिती तपासत आहे...', 10);

  // Show migration overlay if this takes time
  const overlay = document.getElementById('migration-overlay');
  if (overlay) overlay.style.display = 'flex';

  let anyDataFound = false;

  try {
    // ---- STEP 1: Read V1 wrestler data ----
    updateMigrationUI('मल्ल माहिती तपासत आहे...', 20);
    const v1WrestlersRaw = localStorage.getItem(V1_KEYS.wrestlers);
    let v1Wrestlers = null;

    if (v1WrestlersRaw) {
      try {
        const parsed = JSON.parse(v1WrestlersRaw);
        if (Array.isArray(parsed)) {
          v1Wrestlers = parsed;
          anyDataFound = true;
          log.push(`[V1] ${parsed.length} मल्ल सापडले localStorage मध्ये.`);
        }
      } catch(e) {
        log.push(`[WARNING] m_wrestlers JSON parse error: ${e.message}`);
      }
    } else {
      log.push('[V1] मल्ल माहिती localStorage मध्ये नाही (नवीन इन्स्टॉल).');
    }

    // ---- STEP 2: Read V1 attendance data ----
    updateMigrationUI('हजेरी माहिती तपासत आहे...', 35);
    const v1AttendanceRaw = localStorage.getItem(V1_KEYS.attendance);
    let v1Attendance = null;

    if (v1AttendanceRaw) {
      try {
        const parsed = JSON.parse(v1AttendanceRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          v1Attendance = parsed;
          anyDataFound = true;
          const dayCount = Object.keys(parsed).length;
          log.push(`[V1] ${dayCount} दिवसांची हजेरी सापडली localStorage मध्ये.`);
        }
      } catch(e) {
        log.push(`[WARNING] m_attendance JSON parse error: ${e.message}`);
      }
    } else {
      log.push('[V1] हजेरी माहिती localStorage मध्ये नाही.');
    }

    // ---- STEP 3: Read V1 settings data ----
    updateMigrationUI('सेटिंग्ज तपासत आहे...', 50);
    const v1SettingsRaw = localStorage.getItem(V1_KEYS.settings);
    let v1Settings = null;

    if (v1SettingsRaw) {
      try {
        const parsed = JSON.parse(v1SettingsRaw);
        if (parsed && typeof parsed === 'object') {
          v1Settings = parsed;
          anyDataFound = true;
          log.push('[V1] सेटिंग्ज सापडल्या localStorage मध्ये.');
        }
      } catch(e) {
        log.push(`[WARNING] m_settings JSON parse error: ${e.message}`);
      }
    } else {
      log.push('[V1] सेटिंग्ज localStorage मध्ये नाहीत.');
    }

    // ---- STEP 4: Read existing V2 IndexedDB data ----
    updateMigrationUI('IndexedDB तपासत आहे...', 60);
    const [idbWrestlers, idbAttendance, idbSettings] = await Promise.all([
      localforage.getItem('m_wrestlers').catch(() => null),
      localforage.getItem('m_attendance').catch(() => null),
      localforage.getItem('m_settings').catch(() => null)
    ]);

    // ---- STEP 5: Migrate/Merge Wrestlers ----
    updateMigrationUI('मल्ल माहिती migrate करत आहे...', 70);
    if (v1Wrestlers) {
      if (!idbWrestlers || idbWrestlers.length === 0) {
        // IndexedDB is empty → copy V1 directly
        await localforage.setItem('m_wrestlers', v1Wrestlers);
        log.push(`✅ ${v1Wrestlers.length} मल्लांचे प्रोफाइल IndexedDB मध्ये migrate केले.`);
      } else {
        // Both have data → merge (V2 wins on conflict)
        const merged = mergeWrestlers(idbWrestlers, v1Wrestlers);
        const added = merged.length - idbWrestlers.length;
        await localforage.setItem('m_wrestlers', merged);
        log.push(`✅ मल्ल माहिती merge केली. नवीन जोडलेले: ${added}, एकूण: ${merged.length}.`);
      }
    }

    // ---- STEP 6: Migrate/Merge Attendance ----
    updateMigrationUI('हजेरी माहिती migrate करत आहे...', 82);
    if (v1Attendance) {
      const v1Days = Object.keys(v1Attendance).length;
      if (!idbAttendance || Object.keys(idbAttendance).length === 0) {
        await localforage.setItem('m_attendance', v1Attendance);
        log.push(`✅ ${v1Days} दिवसांची हजेरी IndexedDB मध्ये migrate केली.`);
      } else {
        const merged = mergeAttendance(idbAttendance, v1Attendance);
        const mergedDays = Object.keys(merged).length;
        await localforage.setItem('m_attendance', merged);
        log.push(`✅ हजेरी माहिती merge केली. एकूण ${mergedDays} दिवस सुरक्षित.`);
      }
    }

    // ---- STEP 7: Migrate/Merge Settings ----
    updateMigrationUI('सेटिंग्ज migrate करत आहे...', 92);
    if (v1Settings) {
      if (!idbSettings) {
        await localforage.setItem('m_settings', v1Settings);
        log.push('✅ सेटिंग्ज IndexedDB मध्ये migrate केल्या.');
      } else {
        const merged = mergeSettings(idbSettings, v1Settings);
        await localforage.setItem('m_settings', merged);
        log.push('✅ सेटिंग्ज merge केल्या (V2 सेटिंग्ज प्राधान्य).');
      }
    }

    // ---- STEP 8: Mark migration complete ----
    updateMigrationUI('Migration पूर्ण झाली ✅', 100);
    const completionTimestamp = new Date().toISOString();
    log.push(`[${completionTimestamp}] Migration पूर्ण.`);

    // CRITICAL: Do NOT delete V1 localStorage data — kept as backup
    // Instead, tag it so we know it's been migrated
    localStorage.setItem(MIGRATION_FLAG_KEY, completionTimestamp);
    localStorage.setItem(MIGRATION_LOG_KEY, JSON.stringify(log));
    // Keep V1 data with a backup tag
    if (v1Wrestlers) localStorage.setItem('m_v1_backup_wrestlers_migrated', 'true');
    if (v1Attendance) localStorage.setItem('m_v1_backup_attendance_migrated', 'true');
    if (v1Settings) localStorage.setItem('m_v1_backup_settings_migrated', 'true');

    console.log('[Migration] ✅ Complete:', log);

    // Hide overlay after brief delay
    setTimeout(() => {
      if (overlay) overlay.style.display = 'none';
    }, 800);

    return { success: true, log, migrated: anyDataFound };

  } catch(err) {
    const errorMsg = `[CRITICAL] Migration failed: ${err.message}`;
    log.push(errorMsg);
    console.error('[Migration] ❌ Error:', err);
    localStorage.setItem(MIGRATION_LOG_KEY, JSON.stringify(log));

    if (overlay) overlay.style.display = 'none';
    return { success: false, log, migrated: false };
  }
}

/**
 * Master DB initialization function.
 * Called once at app startup. Handles migration + cache hydration.
 */
async function initializeDatabase() {
  const migrationDone = localStorage.getItem(MIGRATION_FLAG_KEY);

  if (!migrationDone) {
    // First time running V2 on this device → run migration
    console.log('[DB] First V2 load detected — running migration...');
    const result = await runV1toV2Migration();
    if (!result.success) {
      console.warn('[DB] Migration had errors but continuing. Logs saved.');
    }
  } else {
    console.log(`[DB] Migration already done on ${migrationDone}. Skipping.`);
    updateMigrationUI('', 0);
  }

  // Load IndexedDB into in-memory cache for sync reads
  await DB.hydrateCache();
  console.log('[DB] Cache hydrated ✅ Wrestlers:', _cache.wrestlers.length, '| Attendance days:', Object.keys(_cache.attendance).length);
}

// ================================================================
// STATE MANAGEMENT
// ================================================================
let currentView = 'dashboard';
let currentShift = 'morning';
let currentSelectedDate = new Date().toISOString().split('T')[0];
let activeWrestlers = [];
let attendanceData = {};
let currentUploadedPhotoBase64 = '';

// ================================================================
// V2: DARK / LIGHT THEME TOGGLE
// ================================================================
function applyTheme(isDark) {
  const html = document.documentElement;
  const icon = document.getElementById('theme-icon');
  if (isDark) {
    html.classList.add('dark');
    if (icon) icon.textContent = 'dark_mode';
  } else {
    html.classList.remove('dark');
    if (icon) icon.textContent = 'light_mode';
  }
}

function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  const newDark = !isDark;
  applyTheme(newDark);
  const settings = DB.getSettings();
  settings.darkMode = newDark;
  DB.saveSettings(settings);
}

function initTheme() {
  // Read from localStorage for instant theme (before IndexedDB loads)
  const rawSettings = localStorage.getItem('m_settings');
  let isDark = false;
  if (rawSettings) {
    try { isDark = JSON.parse(rawSettings).darkMode === true; } catch(e) {}
  }
  applyTheme(isDark);
}

// ================================================================
// PHOTO PREVIEW
// ================================================================
function previewWrestlerPhoto(event) {
  const file = event.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = function(e) {
      currentUploadedPhotoBase64 = e.target.result;
      const previewImg = document.getElementById('form-photo-preview');
      const placeholderIcon = document.getElementById('photo-placeholder-icon');
      if (previewImg && placeholderIcon) {
        previewImg.src = currentUploadedPhotoBase64;
        previewImg.classList.remove('hidden');
        placeholderIcon.classList.add('hidden');
      }
    };
    reader.readAsDataURL(file);
  }
}

// ================================================================
// CUSTOM NATIVE CONFIRMATION MODAL
// ================================================================
function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const msgEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');

    msgEl.innerText = message;
    modal.classList.remove('pointer-events-none', 'opacity-0');
    modal.firstElementChild.classList.remove('scale-95');

    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }

    function cleanup() {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.classList.add('pointer-events-none', 'opacity-0');
      modal.firstElementChild.classList.add('scale-95');
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// ================================================================
// V2: EXIT WARNING MODAL
// ================================================================
function showExitModal() {
  const modal = document.getElementById('exit-modal');
  if (modal) {
    modal.classList.remove('pointer-events-none', 'opacity-0');
    modal.firstElementChild.classList.remove('scale-90');
  }
}

function dismissExitModal() {
  const modal = document.getElementById('exit-modal');
  if (modal) {
    modal.classList.add('pointer-events-none', 'opacity-0');
    modal.firstElementChild.classList.add('scale-90');
  }
  history.pushState({ view: 'dashboard' }, '', window.location.href);
}

function confirmExit() {
  dismissExitModal();
  window.history.go(-2);
}

// ================================================================
// V2: iOS INSTALL MODAL
// ================================================================
function showIOSInstallModal() {
  const modal = document.getElementById('ios-install-modal');
  if (modal) {
    modal.classList.remove('pointer-events-none', 'opacity-0');
    modal.firstElementChild.classList.remove('translate-y-full');
  }
}

function closeIOSInstallModal() {
  const modal = document.getElementById('ios-install-modal');
  if (modal) {
    modal.classList.add('pointer-events-none', 'opacity-0');
    modal.firstElementChild.classList.add('translate-y-full');
  }
  localStorage.setItem('m_ios_install_dismissed', 'true');
}

// ================================================================
// PWA INSTALL EVENT MANAGEMENT
// ================================================================
let deferredPrompt;
const isInStandaloneMode = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

function isIOSSafari() {
  const ua = window.navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(ua) && /safari/.test(ua)
    && !/chrome/.test(ua) && !/crios/.test(ua);
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;

  if (!isInStandaloneMode && !localStorage.getItem('m_install_dismissed')) {
    setTimeout(() => {
      const banner = document.getElementById('install-banner');
      if (banner) banner.classList.remove('translate-y-32', 'opacity-0');
    }, 5000);
  }
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.add('translate-y-32', 'opacity-0');
});

function triggerPWAInstall() {
  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.add('translate-y-32', 'opacity-0');

  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then((choiceResult) => {
      if (choiceResult.outcome === 'accepted') {
        localStorage.setItem('m_install_dismissed', 'true');
      }
      deferredPrompt = null;
    });
  } else if (isIOSSafari()) {
    showIOSInstallModal();
  } else {
    alert('होम स्क्रीनवर जोडण्यासाठी ब्राउझरच्या मेन्यूमधून "Add to Home Screen" निवडा.');
  }
}

function dismissInstallBanner() {
  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.add('translate-y-32', 'opacity-0');
  localStorage.setItem('m_install_dismissed', 'true');
}

// ================================================================
// V2: BACK BUTTON INTERCEPT
// ================================================================
window.addEventListener('load', () => {
  history.pushState({ view: 'dashboard' }, '', window.location.href);
});

window.addEventListener('popstate', () => {
  const wrestlerModal = document.getElementById('wrestler-modal');
  if (wrestlerModal && !wrestlerModal.classList.contains('opacity-0')) {
    showCustomConfirm('माहिती जतन न करता बाहेर पडायचे आहे का?').then((confirmed) => {
      if (confirmed) closeWrestlerModal();
      else history.pushState(null, '', window.location.href);
    });
    return;
  }

  if (currentView === 'dashboard') {
    showExitModal();
    history.pushState({ view: 'dashboard' }, '', window.location.href);
    return;
  }

  history.pushState(null, '', window.location.href);
  switchTab('dashboard');
});

// ================================================================
// MAIN INITIALIZATION (async — awaits DB + migration)
// ================================================================
document.addEventListener('DOMContentLoaded', async () => {

  // Step 1: Apply theme instantly from localStorage (no IndexedDB wait)
  initTheme();

  // Step 2: Run DB init (migration if needed + cache hydration)
  // This runs during the 2.5s splash — usually completes well within that time
  await initializeDatabase();

  // Step 3: Load active data from cache into app state
  activeWrestlers = DB.getWrestlers();
  attendanceData  = DB.getAttendance();

  // Step 4: Seed sample data if the app is truly brand new
  if (activeWrestlers.length === 0) {
    activeWrestlers = [
      {
        id: 'w_1', name: 'अभिजीत सावंत', age: 19, weightClass: '७४ किलो',
        parentName: 'राजेंद्र सावंत', whatsapp: '9876543210',
        weightHistory: [{ date: '2026-05', weight: 72 }, { date: '2026-06', weight: 74 }]
      },
      {
        id: 'w_2', name: 'विशाल शिंदे', age: 21, weightClass: '८६ किलो',
        parentName: 'दत्तात्रय शिंदे', whatsapp: '9123456780',
        weightHistory: [{ date: '2026-05', weight: 85 }, { date: '2026-06', weight: 85.5 }]
      },
      {
        id: 'w_3', name: 'प्रथमेश पाटील', age: 17, weightClass: '६५ किलो',
        parentName: 'संजय पाटील', whatsapp: '9890123456',
        weightHistory: [{ date: '2026-05', weight: 63 }, { date: '2026-06', weight: 64.2 }]
      }
    ];
    await DB.saveWrestlers(activeWrestlers);
  }

  if (Object.keys(attendanceData).length === 0) {
    const today     = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    attendanceData[yesterday] = {
      morning: { 'w_1': { present: true, reason: '' }, 'w_2': { present: true, reason: '' }, 'w_3': { present: false, reason: 'परीक्षा' } },
      evening: { 'w_1': { present: true, reason: '' }, 'w_2': { present: false, reason: 'आजारी' }, 'w_3': { present: true, reason: '' } }
    };
    attendanceData[today] = {
      morning: { 'w_1': { present: true, reason: '' }, 'w_2': { present: true, reason: '' }, 'w_3': { present: true, reason: '' } },
      evening: { 'w_1': { present: true, reason: '' }, 'w_2': { present: true, reason: '' }, 'w_3': { present: false, reason: 'गावी' } }
    };
    await DB.saveAttendance(attendanceData);
  }

  // Step 5: Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js')
      .then(() => console.log('Service Worker Registered ✅'))
      .catch(err => console.log('Service Worker Failed', err));
  }

  // Step 6: Set default form dates
  document.getElementById('attendance-date').value = currentSelectedDate;
  document.getElementById('report-month-select').value = currentSelectedDate.substring(0, 7);

  // Step 7: Render initial UI
  renderDashboard();
  renderWrestlerSelectOptions();
  loadSettingsUI();

  // Step 8: V2 State Persistence — restore last active view
  const savedView = localStorage.getItem('activeView') || 'dashboard';
  switchTab(savedView);

  // Step 9: Dashboard date
  const dateEl = document.getElementById('dashboard-date');
  if (dateEl) {
    const dateObj = new Date();
    dateEl.innerText = dateObj.toLocaleDateString('mr-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
  }

  // Step 10: Splash screen dismiss (2.5s total from page load)
  const splash = document.getElementById('splash-screen');
  const lockScreen = document.getElementById('lock-screen');
  const splashDelay = 2500;

  setTimeout(() => {
    if (splash) {
      splash.style.opacity = '0';
      splash.style.transition = 'opacity 0.7s ease';
      setTimeout(() => splash.remove(), 750);
    }

    if (DB.isAuthenticated()) {
      if (lockScreen) lockScreen.style.display = 'none';
    } else {
      if (lockScreen) {
        lockScreen.classList.remove('pointer-events-none', 'opacity-0');
        lockScreen.style.opacity = '1';
      }
    }
  }, splashDelay);

  // Step 11: iOS install prompt
  if (isIOSSafari() && !isInStandaloneMode && !localStorage.getItem('m_ios_install_dismissed')) {
    setTimeout(() => showIOSInstallModal(), 3500);
  }
});

// ================================================================
// ROUTING & VIEW NAVIGATION
// ================================================================
function switchTab(viewId) {
  currentView = viewId;
  localStorage.setItem('activeView', viewId);

  document.querySelectorAll('.view-panel').forEach(panel => panel.classList.add('hidden'));
  const viewEl = document.getElementById(`view-${viewId}`);
  if (viewEl) viewEl.classList.remove('hidden');

  const navIds = ['dashboard', 'wrestlers', 'attendance', 'reports', 'settings'];
  navIds.forEach(key => {
    const btn = document.getElementById(`nav-${key}`);
    if (!btn) return;
    if (key === viewId) {
      btn.classList.add('text-clay-900', 'font-bold');
      btn.classList.remove('text-gray-400');
    } else {
      btn.classList.remove('text-clay-900', 'font-bold');
      btn.classList.add('text-gray-400');
    }
  });

  if (viewId === 'dashboard')  renderDashboard();
  if (viewId === 'wrestlers')  renderWrestlersList();
  if (viewId === 'attendance') loadAttendanceForConfig();
  if (viewId === 'reports')    renderWrestlerSelectOptions();
  if (viewId === 'settings')   loadSettingsUI();
}

// ================================================================
// SYNC BUTTON
// ================================================================
function syncData() {
  const migrationTimestamp = localStorage.getItem(MIGRATION_FLAG_KEY);
  const migrationInfo = migrationTimestamp
    ? `\nV1→V2 Migration: ${new Date(migrationTimestamp).toLocaleString('mr-IN')}`
    : '\nV1→V2 Migration: अद्याप केली नाही.';

  alert(`माहिती IndexedDB मध्ये यशस्वीरित्या सुरक्षित आहे! ✅\n\n१००% ऑफलाइन मोड — कोणत्याही सर्व्हरशिवाय काम करते.${migrationInfo}`);
}

// ================================================================
// WRESTLER MANAGEMENT MODULE
// ================================================================
function openWrestlerModal(wrestlerId = '') {
  const modal = document.getElementById('wrestler-modal');
  const title = document.getElementById('wrestler-modal-title');
  const form  = document.getElementById('wrestler-form');

  form.reset();
  document.getElementById('form-wrestler-id').value = '';
  currentUploadedPhotoBase64 = '';
  document.getElementById('form-photo').value = '';

  const previewImg = document.getElementById('form-photo-preview');
  const placeholderIcon = document.getElementById('photo-placeholder-icon');
  if (previewImg && placeholderIcon) {
    previewImg.src = '';
    previewImg.classList.add('hidden');
    placeholderIcon.classList.remove('hidden');
  }

  if (wrestlerId) {
    title.innerText = 'माहिती दुरुस्त करा';
    const w = activeWrestlers.find(x => x.id === wrestlerId);
    if (w) {
      document.getElementById('form-wrestler-id').value = w.id;
      document.getElementById('form-name').value = w.name;
      document.getElementById('form-age').value = w.age;
      document.getElementById('form-weight-class').value = w.weightClass;
      document.getElementById('form-parent-name').value = w.parentName;
      document.getElementById('form-whatsapp').value = w.whatsapp;
      if (w.photo && previewImg && placeholderIcon) {
        currentUploadedPhotoBase64 = w.photo;
        previewImg.src = w.photo;
        previewImg.classList.remove('hidden');
        placeholderIcon.classList.add('hidden');
      }
    }
  } else {
    title.innerText = 'नवीन मल्ल नोंदणी';
  }

  modal.classList.remove('pointer-events-none', 'opacity-0');
  modal.firstElementChild.classList.remove('translate-y-full');
  history.pushState({ modal: 'wrestler' }, '', window.location.href);
}

function closeWrestlerModal() {
  const modal = document.getElementById('wrestler-modal');
  modal.classList.add('pointer-events-none', 'opacity-0');
  modal.firstElementChild.classList.add('translate-y-full');
}

function saveWrestler(e) {
  e.preventDefault();
  showCustomConfirm('तुम्हाला ही मल्ल माहिती जतन करायची आहे का?').then((confirmed) => {
    if (!confirmed) return;

    const id = document.getElementById('form-wrestler-id').value;
    const name = document.getElementById('form-name').value.trim();
    const age = parseInt(document.getElementById('form-age').value);
    const weightClass = document.getElementById('form-weight-class').value.trim();
    const parentName = document.getElementById('form-parent-name').value.trim();
    const whatsapp = document.getElementById('form-whatsapp').value.trim();
    const photo = currentUploadedPhotoBase64;

    if (id) {
      const index = activeWrestlers.findIndex(x => x.id === id);
      if (index !== -1) {
        activeWrestlers[index] = { ...activeWrestlers[index], name, age, weightClass, parentName, whatsapp, photo };
      }
    } else {
      activeWrestlers.push({
        id: 'w_' + Date.now(), name, age, weightClass, parentName, whatsapp, photo,
        weightHistory: [{ date: new Date().toISOString().substring(0, 7), weight: 0 }]
      });
    }

    DB.saveWrestlers(activeWrestlers);
    closeWrestlerModal();
    renderWrestlersList();
    renderWrestlerSelectOptions();
    renderDashboard();
  });
}

function deleteWrestler(id) {
  showCustomConfirm('तुम्हाला या मल्लाची संपूर्ण माहिती डिलीट करायची आहे का?').then((confirmed) => {
    if (confirmed) {
      activeWrestlers = activeWrestlers.filter(x => x.id !== id);
      DB.saveWrestlers(activeWrestlers);
      renderWrestlersList();
      renderWrestlerSelectOptions();
      renderDashboard();
    }
  });
}

function renderWrestlersList() {
  const container = document.getElementById('wrestlers-container');
  container.innerHTML = '';

  if (activeWrestlers.length === 0) {
    container.innerHTML = `<p class="text-xs text-gray-400 text-center py-8 bg-white dark:bg-gray-800 rounded-2xl border border-clay-50 dark:border-gray-700 border-dashed">अद्याप कोणतेही मल्ल जोडलेले नाहीत.</p>`;
    return;
  }

  activeWrestlers.forEach(w => {
    const latestWeightObj = w.weightHistory && w.weightHistory.length > 0
      ? w.weightHistory[w.weightHistory.length - 1] : null;
    const latestWeight = latestWeightObj && latestWeightObj.weight > 0
      ? `${latestWeightObj.weight} kg` : 'नोंद नाही';

    let photoHtml = `<div class="w-12 h-12 bg-clay-700 text-white rounded-full flex items-center justify-center font-bold text-lg shrink-0">${w.name.charAt(0)}</div>`;
    if (w.photo) {
      photoHtml = `<img src="${w.photo}" class="w-12 h-12 rounded-full object-cover border border-clay-100 dark:border-gray-600 shrink-0">`;
    }

    container.innerHTML += `
      <div class="bg-white dark:bg-gray-800 p-4 rounded-2xl border border-clay-100 dark:border-gray-700 shadow-sm flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          ${photoHtml}
          <div class="space-y-1">
            <h4 class="font-bold text-gray-800 dark:text-gray-100 text-base">${w.name}</h4>
            <div class="flex flex-wrap gap-1.5 text-[10px] font-semibold">
              <span class="bg-orange-50 dark:bg-clay-900/50 px-2 py-0.5 rounded-full text-clay-800 dark:text-clay-200">वय: ${w.age} वर्ष</span>
              <span class="bg-orange-50 dark:bg-clay-900/50 px-2 py-0.5 rounded-full text-clay-800 dark:text-clay-200">गट: ${w.weightClass}</span>
              <span class="bg-yellow-500/10 dark:bg-yellow-900/30 px-2 py-0.5 rounded-full text-yellow-800 dark:text-yellow-400">वजन: ${latestWeight}</span>
            </div>
            <p class="text-[11px] text-gray-400 dark:text-gray-500">पालक: ${w.parentName} (+91 ${w.whatsapp})</p>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button onclick="openWrestlerModal('${w.id}')" class="p-2 text-clay-800 dark:text-yellow-500 rounded-full hover:bg-orange-50 dark:hover:bg-gray-700 active:scale-90 transition-transform">
            <span class="material-icons text-lg">edit</span>
          </button>
          <button onclick="deleteWrestler('${w.id}')" class="p-2 text-red-600 rounded-full hover:bg-red-50 dark:hover:bg-red-900/20 active:scale-90 transition-transform">
            <span class="material-icons text-lg">delete</span>
          </button>
        </div>
      </div>`;
  });
}

function filterWrestlers() {
  const query = document.getElementById('wrestler-search').value.toLowerCase().trim();
  const cards = document.getElementById('wrestlers-container').children;
  Array.from(cards).forEach((card, index) => {
    if (activeWrestlers[index]) {
      card.classList.toggle('hidden', !activeWrestlers[index].name.toLowerCase().includes(query));
    }
  });
}

// ================================================================
// ATTENDANCE MODULE
// ================================================================
function setShift(shift) {
  currentShift = shift;
  const morningBtn = document.getElementById('shift-morning');
  const eveningBtn = document.getElementById('shift-evening');
  const active   = 'px-3 py-1.5 rounded-lg text-xs font-bold transition-all bg-clay-900 text-white shadow';
  const inactive = 'px-3 py-1.5 rounded-lg text-xs font-bold transition-all text-gray-600 dark:text-gray-300';
  morningBtn.className = shift === 'morning' ? active : inactive;
  eveningBtn.className = shift === 'evening' ? active : inactive;
  loadAttendanceForConfig();
}

function loadAttendanceForConfig() {
  currentSelectedDate = document.getElementById('attendance-date').value;
  const container = document.getElementById('attendance-list-container');
  container.innerHTML = '';

  if (activeWrestlers.length === 0) {
    container.innerHTML = `<p class="text-xs text-gray-400 dark:text-gray-500 text-center py-8">कृपया आधी 'मल्ल' स्क्रीनवर जाऊन मल्लांची नोंदणी करा.</p>`;
    return;
  }

  const dayRecords = attendanceData[currentSelectedDate] || { morning: {}, evening: {} };
  const shiftRecords = dayRecords[currentShift] || {};

  activeWrestlers.forEach(w => {
    const record = shiftRecords[w.id] || { present: true, reason: '' };
    const isPresent = record.present;

    container.innerHTML += `
      <div class="p-3.5 flex flex-col gap-2 dark:bg-gray-800">
        <div class="flex items-center justify-between">
          <span class="font-bold text-gray-800 dark:text-gray-100 text-sm">${w.name}</span>
          <label class="relative inline-flex items-center cursor-pointer select-none">
            <input type="checkbox" id="att-chk-${w.id}" onchange="toggleAbsentReasonField('${w.id}')" ${isPresent ? 'checked' : ''} class="sr-only peer">
            <div class="w-11 h-6 bg-gray-200 dark:bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
          </label>
        </div>
        <div id="reason-box-${w.id}" class="${isPresent ? 'hidden' : 'block'} transition-all">
          <label class="block text-[10px] font-bold text-red-700 dark:text-red-400 mb-1">अनुपस्थितीचे कारण निवडा:</label>
          <select id="reason-sel-${w.id}" class="w-full bg-red-50 dark:bg-red-900/20 text-red-900 dark:text-red-300 border border-red-200 dark:border-red-800 rounded-xl py-2 px-3 text-xs focus:ring-1 focus:ring-red-600">
            <option value="आजारी" ${record.reason === 'आजारी' ? 'selected' : ''}>आजारी (Sick)</option>
            <option value="गावी" ${record.reason === 'गावी' ? 'selected' : ''}>गावी (Out of town)</option>
            <option value="परीक्षा" ${record.reason === 'परीक्षा' ? 'selected' : ''}>परीक्षा (Exams)</option>
            <option value="इतर" ${record.reason === 'इतर' ? 'selected' : ''}>इतर (Other / Personal)</option>
          </select>
        </div>
      </div>`;
  });
}

function toggleAbsentReasonField(wrestlerId) {
  const checkbox = document.getElementById(`att-chk-${wrestlerId}`);
  const reasonBox = document.getElementById(`reason-box-${wrestlerId}`);
  if (checkbox.checked) reasonBox.classList.replace('block', 'hidden');
  else reasonBox.classList.replace('hidden', 'block');
}

function saveTodayAttendance() {
  showCustomConfirm('तुम्हाला आजची हजेरी जतन करायची आहे का?').then((confirmed) => {
    if (!confirmed) return;

    if (!attendanceData[currentSelectedDate]) attendanceData[currentSelectedDate] = { morning: {}, evening: {} };
    if (!attendanceData[currentSelectedDate][currentShift]) attendanceData[currentSelectedDate][currentShift] = {};

    activeWrestlers.forEach(w => {
      const isPresent = document.getElementById(`att-chk-${w.id}`).checked;
      const reason = isPresent ? '' : document.getElementById(`reason-sel-${w.id}`).value;
      attendanceData[currentSelectedDate][currentShift][w.id] = { present: isPresent, reason };
    });

    DB.saveAttendance(attendanceData);
    alert('हजेरी यशस्वीरित्या जतन करण्यात आली आहे! ✅');
    renderDashboard();
  });
}

// ================================================================
// REPORTS & PROGRESS CARD MODULE
// ================================================================
function renderWrestlerSelectOptions() {
  const select = document.getElementById('report-wrestler-select');
  select.innerHTML = '<option value="">-- मल्ल निवडा --</option>';
  activeWrestlers.forEach(w => { select.innerHTML += `<option value="${w.id}">${w.name}</option>`; });
}

function loadWrestlerReportOverview() {
  const wrestlerId = document.getElementById('report-wrestler-select').value;
  const monthStr   = document.getElementById('report-month-select').value;
  const previewCard = document.getElementById('report-preview-card');

  if (!wrestlerId || !monthStr) { previewCard.classList.add('hidden'); return; }

  const w = activeWrestlers.find(x => x.id === wrestlerId);
  if (!w) return;

  let totalSessions = 0, presentSessions = 0, absentSessions = 0;
  const reasonsCount = {};

  // Collect per-date data for both sessions
  const [year, month] = monthStr.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const dateRows = []; // { date, mPresent, mReason, ePresent, eReason }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayData = attendanceData[dateStr];
    if (!dayData) continue; // Skip days with no records at all

    const mRec = dayData.morning && dayData.morning[wrestlerId];
    const eRec = dayData.evening && dayData.evening[wrestlerId];
    if (!mRec && !eRec) continue; // No record for this wrestler on this day

    const row = {
      date: dateStr,
      mPresent: mRec ? mRec.present : null,
      mReason:  mRec ? (mRec.reason || '') : '',
      ePresent: eRec ? eRec.present : null,
      eReason:  eRec ? (eRec.reason || '') : ''
    };
    dateRows.push(row);

    if (mRec) { totalSessions++; if (mRec.present) presentSessions++; else { absentSessions++; const r = mRec.reason || 'इतर'; reasonsCount[r] = (reasonsCount[r]||0)+1; } }
    if (eRec) { totalSessions++; if (eRec.present) presentSessions++; else { absentSessions++; const r = eRec.reason || 'इतर'; reasonsCount[r] = (reasonsCount[r]||0)+1; } }
  }

  const attendancePercent = totalSessions > 0 ? Math.round((presentSessions / totalSessions) * 100) : 100;
  let remarks = '';
  if (totalSessions === 0) remarks = 'या महिन्याची हजेरी नोंदवलेली नाही. कृपया नियमित सराव करा आणि हजेरी नोंदवा.';
  else if (attendancePercent >= 90) remarks = 'उत्कृष्ट हजेरी! याच सातत्याने सराव केल्यास कुस्तीत मोठी प्रगती होईल.';
  else if (attendancePercent >= 75) remarks = 'चांगली हजेरी. सरावात अजून एकाग्रता ठेवावी. दम आणि ताकद वाढवणे गरजेचे आहे.';
  else remarks = 'हजेरी अत्यंत कमी आहे. सरावात सातत्य ठेवणे खूप गरजेचे आहे. कृपया सुट्ट्या कमी कराव्या.';

  document.getElementById('report-avatar').innerText = w.name.charAt(0);
  document.getElementById('report-wrestler-name').innerText = w.name;
  document.getElementById('report-wrestler-meta').innerText = `वय: ${w.age} वर्ष | गट: ${w.weightClass}`;
  document.getElementById('report-present-count').innerText = presentSessions;
  document.getElementById('report-absent-count').innerText = absentSessions;
  document.getElementById('report-percentage').innerText = `${attendancePercent}%`;
  document.getElementById('report-ai-remarks').innerText = remarks;

  const reasonsList = document.getElementById('report-reasons-list');
  reasonsList.innerHTML = '';
  if (Object.keys(reasonsCount).length === 0) {
    reasonsList.innerHTML = '<li>कोणत्याही सुट्ट्या नाहीत (१००% हजेरी) 🏆</li>';
  } else {
    Object.keys(reasonsCount).forEach(r => { reasonsList.innerHTML += `<li>• ${r}: ${reasonsCount[r]} वेळा</li>`; });
  }

  // FEATURE 12: Render per-date dual-session table in UI
  const sessionTable = document.getElementById('report-session-table');
  if (sessionTable) {
    if (dateRows.length === 0) {
      sessionTable.innerHTML = `<div class="py-4 text-center text-gray-400 text-[10px]">या महिन्यात कोणतीही हजेरी नोंदवलेली नाही.</div>`;
    } else {
      const weekdays = ['रवि','सोम','मंगळ','बुध','गुरू','शुक्र','शनि'];
      sessionTable.innerHTML = dateRows.map(row => {
        const d = new Date(row.date);
        const dayLabel = `${String(d.getDate()).padStart(2,'0')} ${weekdays[d.getDay()]}`;
        const mCell = row.mPresent === null
          ? `<span class="text-gray-300 dark:text-gray-600">—</span>`
          : row.mPresent
            ? `<span class="inline-block w-5 h-5 rounded-full bg-emerald-500 text-white text-[9px] font-bold leading-5">✓</span>`
            : `<span class="inline-block w-5 h-5 rounded-full bg-red-500 text-white text-[9px] font-bold leading-5">✗</span>`;
        const eCell = row.ePresent === null
          ? `<span class="text-gray-300 dark:text-gray-600">—</span>`
          : row.ePresent
            ? `<span class="inline-block w-5 h-5 rounded-full bg-emerald-500 text-white text-[9px] font-bold leading-5">✓</span>`
            : `<span class="inline-block w-5 h-5 rounded-full bg-red-500 text-white text-[9px] font-bold leading-5">✗</span>`;
        const reasons = [row.mReason, row.eReason].filter(Boolean).join(', ');
        const rowBg = (!row.mPresent || !row.ePresent) && (row.mPresent !== null || row.ePresent !== null)
          ? 'bg-red-50/50 dark:bg-red-900/10' : 'bg-white dark:bg-gray-800';
        return `<div class="grid grid-cols-4 gap-1 py-1.5 px-2 ${rowBg} items-center">
          <span class="text-left font-semibold text-gray-700 dark:text-gray-300">${dayLabel}</span>
          <span class="flex justify-center">${mCell}</span>
          <span class="flex justify-center">${eCell}</span>
          <span class="text-gray-500 dark:text-gray-400 truncate">${reasons || '—'}</span>
        </div>`;
      }).join('');
    }
  }

  const currentWeightObj = w.weightHistory ? w.weightHistory.find(h => h.date === monthStr) : null;
  document.getElementById('report-weight-input').value = currentWeightObj ? currentWeightObj.weight : '';
  previewCard.classList.remove('hidden');

  // Store dateRows for PDF use
  window._lastReportDateRows = dateRows;
}

function updateWrestlerWeight() {
  const wrestlerId = document.getElementById('report-wrestler-select').value;
  const monthStr   = document.getElementById('report-month-select').value;
  const weightVal  = parseFloat(document.getElementById('report-weight-input').value);

  if (!wrestlerId || !monthStr || isNaN(weightVal)) { alert('कृपया वजन अचूक टाकावे.'); return; }

  const wIndex = activeWrestlers.findIndex(x => x.id === wrestlerId);
  if (wIndex !== -1) {
    if (!activeWrestlers[wIndex].weightHistory) activeWrestlers[wIndex].weightHistory = [];
    const histIdx = activeWrestlers[wIndex].weightHistory.findIndex(h => h.date === monthStr);
    if (histIdx !== -1) activeWrestlers[wIndex].weightHistory[histIdx].weight = weightVal;
    else activeWrestlers[wIndex].weightHistory.push({ date: monthStr, weight: weightVal });
    DB.saveWrestlers(activeWrestlers);
    alert('मल्लाचे वजन यशस्वीरित्या अपडेट केले! ✅');
    loadWrestlerReportOverview();
    renderDashboard();
  }
}

// ================================================================
// PDF GENERATION — Returns { pdf, filename, wrestler, canvas }
// FEATURE 12: Includes full dual-session month table in PDF
// ================================================================
async function generateMonthlyPDF() {
  const wrestlerId = document.getElementById('report-wrestler-select').value;
  const monthStr   = document.getElementById('report-month-select').value;

  if (!wrestlerId || !monthStr) { alert('कृपया मल्ल आणि महिना निवडा.'); return null; }

  // Refresh overview first (to ensure _lastReportDateRows is current)
  loadWrestlerReportOverview();

  const w = activeWrestlers.find(x => x.id === wrestlerId);
  if (!w) return null;

  const presentVal  = document.getElementById('report-present-count').innerText;
  const absentVal   = document.getElementById('report-absent-count').innerText;
  const percentVal  = document.getElementById('report-percentage').innerText;
  const remarkText  = document.getElementById('report-ai-remarks').innerText;

  const monthsMarathi = { '01':'जानेवारी','02':'फेब्रुवारी','03':'मार्च','04':'एप्रिल','05':'मे','06':'जून','07':'जुलै','08':'ऑगस्ट','09':'सप्टेंबर','10':'ऑक्टोबर','11':'नोव्हेंबर','12':'डिसेंबर' };
  const parts = monthStr.split('-');
  const displayMonth = `${monthsMarathi[parts[1]]} ${parts[0]}`;

  const canvas = document.createElement('canvas');
  canvas.width = 1200; canvas.height = 2000;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1200, 2000);
  ctx.strokeStyle = '#a3331b'; ctx.lineWidth = 12; ctx.strokeRect(20, 20, 1160, 1960);
  ctx.strokeStyle = '#ea580c'; ctx.lineWidth = 4; ctx.strokeRect(35, 35, 1130, 1930);

  const logoImg = new Image();
  logoImg.src = 'logo.jpg';
  await new Promise(res => { logoImg.onload = res; logoImg.onerror = res; setTimeout(res, 3000); });

  let wrestlerImg = null;
  if (w.photo) {
    wrestlerImg = new Image(); wrestlerImg.src = w.photo;
    await new Promise(res => { wrestlerImg.onload = res; wrestlerImg.onerror = res; setTimeout(res, 3000); });
  }

  // Logo circle
  ctx.save();
  ctx.beginPath(); ctx.arc(600, 160, 70, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
  if (logoImg.complete && logoImg.naturalWidth > 0) ctx.drawImage(logoImg, 530, 90, 140, 140);
  else { ctx.fillStyle = '#7c2d12'; ctx.fill(); }
  ctx.restore();
  ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(600, 160, 70, 0, Math.PI * 2); ctx.stroke();

  ctx.fillStyle = '#7c2d12'; ctx.font = 'bold 44px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('मल्लविद्या कुस्ती केंद्र', 600, 280);
  ctx.fillStyle = '#ea580c'; ctx.font = 'bold 26px sans-serif';
  ctx.fillText('तालीम व मल्ल विकास प्रगतीपत्रक', 600, 322);
  ctx.fillStyle = '#4b5563'; ctx.font = '22px sans-serif';
  ctx.fillText(`महिन्याचा अहवाल: ${displayMonth}`, 600, 358);

  ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(100, 390); ctx.lineTo(1100, 390); ctx.stroke();

  ctx.textAlign = 'left'; ctx.fillStyle = '#111827';
  ctx.font = 'bold 28px sans-serif'; ctx.fillText(`मल्लाचे नाव: ${w.name}`, 120, 440);
  ctx.font = '22px sans-serif';
  ctx.fillText(`वय: ${w.age} वर्ष`, 120, 488);
  ctx.fillText(`वजन गट: ${w.weightClass}`, 120, 534);
  ctx.fillText(`पालकांचे नाव: ${w.parentName}`, 600, 488);
  ctx.fillText(`WhatsApp: +91 ${w.whatsapp}`, 600, 534);

  if (wrestlerImg && wrestlerImg.complete && wrestlerImg.naturalWidth > 0) {
    ctx.save(); ctx.beginPath(); ctx.arc(1010, 490, 55, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
    ctx.drawImage(wrestlerImg, 955, 435, 110, 110); ctx.restore();
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(1010, 490, 56, 0, Math.PI * 2); ctx.stroke();
  } else {
    ctx.fillStyle = '#7c2d12'; ctx.beginPath(); ctx.arc(1010, 490, 55, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 44px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(w.name.charAt(0), 1010, 505); ctx.textAlign = 'left';
  }

  ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(100, 580); ctx.lineTo(1100, 580); ctx.stroke();

  // Stat boxes
  [
    { x: 120, bg: '#ecfdf5', stroke: '#10b981', fg: '#065f46', label: 'एकूण उपस्थित', val: presentVal, cx: 260 },
    { x: 460, bg: '#fef2f2', stroke: '#ef4444', fg: '#991b1b', label: 'एकूण अनुपस्थित', val: absentVal, cx: 600 },
    { x: 800, bg: '#fffbeb', stroke: '#f59e0b', fg: '#92400e', label: 'हजेरी टक्केवारी', val: percentVal, cx: 940 }
  ].forEach(box => {
    ctx.fillStyle = box.bg; roundRect(ctx, box.x, 620, 280, 120, 12); ctx.fill();
    ctx.strokeStyle = box.stroke; ctx.lineWidth = 1.5; roundRect(ctx, box.x, 620, 280, 120, 12); ctx.stroke();
    ctx.fillStyle = box.fg; ctx.font = 'bold 22px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(box.label, box.cx, 655);
    ctx.font = 'bold 36px sans-serif'; ctx.fillText(box.val, box.cx, 710);
  });

  // FEATURE 12: Dual-Session Attendance Table (2 Columns)
  ctx.textAlign = 'left'; ctx.fillStyle = '#111827';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('दिनांकनिहाय हजेरी (सकाळ व संध्याकाळ):', 120, 790);

  const drawRow = (x, y, dText, mText, mColor, eText, eColor, rText) => {
    ctx.fillStyle = '#f3f4f6'; ctx.fillRect(x, y, 460, 32);
    ctx.fillStyle = '#111827'; ctx.font = '16px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(dText, x + 10, y + 22);
    ctx.fillStyle = mColor; ctx.textAlign = 'center'; ctx.fillText(mText, x + 110, y + 22);
    ctx.fillStyle = eColor; ctx.textAlign = 'center'; ctx.fillText(eText, x + 190, y + 22);
    ctx.fillStyle = '#4b5563'; ctx.textAlign = 'left'; ctx.font = '14px sans-serif';
    ctx.fillText(rText.substring(0, 22), x + 250, y + 21);
  };

  // Table Headers
  const drawHeader = (x, y) => {
    ctx.fillStyle = '#1f2937'; roundRect(ctx, x, y, 460, 36, 6); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('तारीख', x + 10, y + 24);
    ctx.textAlign = 'center'; ctx.fillText('सकाळ', x + 110, y + 24);
    ctx.fillText('संध्याकाळ', x + 190, y + 24);
    ctx.textAlign = 'left'; ctx.fillText('कारण', x + 250, y + 24);
  };

  drawHeader(120, 810);
  drawHeader(620, 810);

  const dateRows = window._lastReportDateRows || [];
  let leftY = 850;
  let rightY = 850;

  dateRows.forEach((row, i) => {
    const dObj = new Date(row.date);
    const dateLabel = `${String(dObj.getDate()).padStart(2,'0')}/${String(dObj.getMonth()+1).padStart(2,'0')}`;
    const mStr = row.mPresent === null ? '-' : (row.mPresent ? '✓' : '✗');
    const mCol = row.mPresent === null ? '#9ca3af' : (row.mPresent ? '#10b981' : '#ef4444');
    const eStr = row.ePresent === null ? '-' : (row.ePresent ? '✓' : '✗');
    const eCol = row.ePresent === null ? '#9ca3af' : (row.ePresent ? '#10b981' : '#ef4444');
    const reasons = [row.mReason, row.eReason].filter(Boolean).join(', ');

    if (i < 16) {
      drawRow(120, leftY, dateLabel, mStr, mCol, eStr, eCol, reasons || '-');
      leftY += 36;
    } else {
      drawRow(620, rightY, dateLabel, mStr, mCol, eStr, eCol, reasons || '-');
      rightY += 36;
    }
  });

  // Reasons box (moved down to y=1450)
  const contentY = 1450;
  ctx.textAlign = 'left'; ctx.fillStyle = '#f9fafb';
  roundRect(ctx, 120, contentY, 960, 160, 12); ctx.fill();
  ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1.5; roundRect(ctx, 120, contentY, 960, 160, 12); ctx.stroke();
  ctx.fillStyle = '#374151'; ctx.font = 'bold 22px sans-serif';
  ctx.fillText('गैरहजेरीची कारणे (Absence Summary):', 150, contentY + 35);
  ctx.font = '18px sans-serif';
  let reasonY = contentY + 70;
  Array.from(document.getElementById('report-reasons-list').children).forEach(li => {
    ctx.fillText(li.innerText, 160, reasonY); reasonY += 28;
  });

  // Remarks box
  ctx.fillStyle = '#fffbeb'; roundRect(ctx, 120, contentY + 180, 960, 140, 12); ctx.fill();
  ctx.strokeStyle = '#fcd34d'; ctx.lineWidth = 2; roundRect(ctx, 120, contentY + 180, 960, 140, 12); ctx.stroke();
  ctx.fillStyle = '#92400e'; ctx.font = 'bold 22px sans-serif';
  ctx.fillText('प्रगतीपुस्तक शेरा (Progress Evaluation):', 150, contentY + 220);
  ctx.fillStyle = '#1f2937'; ctx.font = 'italic 20px sans-serif';
  wrapText(ctx, remarkText, 150, contentY + 260, 900, 30);

  ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(100, 1820); ctx.lineTo(1100, 1820); ctx.stroke();
  ctx.fillStyle = '#374151'; ctx.font = 'bold 24px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('वस्ताद: राहुल नारायण जाधव', 600, 1880);
  ctx.strokeStyle = '#9ca3af';
  ctx.beginPath(); ctx.moveTo(420, 1850); ctx.lineTo(780, 1850); ctx.stroke();
  ctx.fillStyle = '#9ca3af'; ctx.font = '18px sans-serif';
  ctx.fillText('(सही / स्वाक्षरी)', 600, 1910);
  ctx.fillStyle = '#7c2d12'; ctx.font = '20px sans-serif';
  ctx.fillText('मल्लविद्या कुस्ती केंद्र - अखंड परंपरा, आधुनिक तंत्रज्ञान', 600, 1960);

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p', 'mm', 'a4');
  const imgData = canvas.toDataURL('image/jpeg', 0.95);
  pdf.addImage(imgData, 'JPEG', 0, 0, 210, 297);
  const filename = `${w.name}_${monthStr}_रिपोर्ट.pdf`;
  pdf.save(filename);

  return { pdf, filename, wrestler: w, canvas }; // ← canvas returned (bug fix)
}

// Rounded rectangle path helper
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' '); let line = '';
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    if (ctx.measureText(testLine).width > maxWidth && n > 0) {
      ctx.fillText(line, x, y); line = words[n] + ' '; y += lineHeight;
    } else line = testLine;
  }
  ctx.fillText(line, x, y);
}

// ================================================================
// WHATSAPP SHARING — Fixed wa.me URL + canvas usage
// ================================================================
async function shareReportWhatsApp() {
  const wrestlerId = document.getElementById('report-wrestler-select').value;
  const monthStr   = document.getElementById('report-month-select').value;

  if (!wrestlerId || !monthStr) { alert('कृपया मल्ल आणि महिना निवडा.'); return; }

  const w = activeWrestlers.find(x => x.id === wrestlerId);
  if (!w) return;

  const monthsMarathi = { '01':'जानेवारी','02':'फेब्रुवारी','03':'मार्च','04':'एप्रिल','05':'मे','06':'जून','07':'जुलै','08':'ऑगस्ट','09':'सप्टेंबर','10':'ऑक्टोबर','11':'नोव्हेंबर','12':'डिसेंबर' };
  const parts = monthStr.split('-');
  const displayMonth = `${monthsMarathi[parts[1]]} ${parts[0]}`;

  const messageText = `🏆 नमस्कार ${w.parentName} जी!\n\n*${w.name}* ची *${displayMonth}* हजेरी अहवाल:\n\nहजेरी: ${document.getElementById('report-percentage').innerText}\nउपस्थित: ${document.getElementById('report-present-count').innerText} सत्रे\nअनुपस्थित: ${document.getElementById('report-absent-count').innerText} सत्रे\n\n- मल्लविद्या कुस्ती केंद्र 🤼`;

  const phoneClean = w.whatsapp.replace(/\D/g, '');
  const whatsappUrl = `https://wa.me/91${phoneClean}?text=${encodeURIComponent(messageText)}`;

  let reportRes = null;
  try { reportRes = await generateMonthlyPDF(); }
  catch (err) { console.error('PDF generation error:', err); window.open(whatsappUrl, '_blank'); return; }

  if (!reportRes) { window.open(whatsappUrl, '_blank'); return; }

  // Attempt 1: Share PDF via Web Share API
  try {
    const pdfBlob = reportRes.pdf.output('blob');
    const pdfFile = new File([pdfBlob], reportRes.filename, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
      await navigator.share({ files: [pdfFile], title: `${w.name} - प्रगती अहवाल`, text: messageText });
      return;
    }
  } catch(e) { console.log('PDF share failed, trying image...', e); }

  // Attempt 2: Share as PNG image (uses returned canvas — bug fixed)
  try {
    const pngBlob = await new Promise(resolve => reportRes.canvas.toBlob(resolve, 'image/png'));
    const imageFile = new File([pngBlob], reportRes.filename.replace('.pdf', '.png'), { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [imageFile] })) {
      await navigator.share({ files: [imageFile], title: `${w.name} - प्रगती अहवाल`, text: messageText });
      return;
    }
  } catch(e) { console.log('Image share failed, using wa.me fallback...', e); }

  // Attempt 3: Direct wa.me link fallback
  alert('पीडीएफ डाऊनलोड झाली आहे. WhatsApp चॅट उघडत आहे — डाऊनलोड केलेली फाईल मॅन्युअली पाठवा.');
  window.open(whatsappUrl, '_blank');
}

// ================================================================
// V2: PRACTICE TIME SETTINGS
// ================================================================
function savePracticeTime() {
  const morningTime = document.getElementById('setting-morning-time').value.trim();
  const eveningTime = document.getElementById('setting-evening-time').value.trim();
  const settings = DB.getSettings();
  settings.practiceTime = { morning: morningTime, evening: eveningTime };
  DB.saveSettings(settings);
  renderPracticeTimeOnDashboard(settings.practiceTime);
  alert('सराव वेळ यशस्वीरित्या जतन केली! ✅');
}

function renderPracticeTimeOnDashboard(practiceTime) {
  const card = document.getElementById('practice-time-card');
  const display = document.getElementById('practice-time-display');
  if (!card || !display) return;

  if (practiceTime && (practiceTime.morning || practiceTime.evening)) {
    let text = '';
    if (practiceTime.morning) text += practiceTime.morning;
    if (practiceTime.morning && practiceTime.evening) text += '  |  ';
    if (practiceTime.evening) text += practiceTime.evening;
    display.innerText = text;
    card.classList.remove('hidden');
  } else {
    card.classList.add('hidden');
  }
}

function loadSettingsUI() {
  const settings = DB.getSettings();
  if (settings.practiceTime) {
    const mInput = document.getElementById('setting-morning-time');
    const eInput = document.getElementById('setting-evening-time');
    if (mInput) mInput.value = settings.practiceTime.morning || '';
    if (eInput) eInput.value = settings.practiceTime.evening || '';
  }
  renderPracticeTimeOnDashboard(settings.practiceTime);
  // Sync theme icon
  const isDark = document.documentElement.classList.contains('dark');
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = isDark ? 'dark_mode' : 'light_mode';
}

// ================================================================
// DASHBOARD ANALYTICS MODULE
// ================================================================
function renderDashboard() {
  document.getElementById('stat-total-wrestlers').innerText = activeWrestlers.length;

  const todayStr = new Date().toISOString().split('T')[0];
  const dayRecords = attendanceData[todayStr] || { morning: {}, evening: {} };

  let mTotal = activeWrestlers.length, mPresent = 0;
  let eTotal = activeWrestlers.length, ePresent = 0;

  activeWrestlers.forEach(w => {
    if (dayRecords.morning && dayRecords.morning[w.id] && dayRecords.morning[w.id].present) mPresent++;
    if (dayRecords.evening && dayRecords.evening[w.id] && dayRecords.evening[w.id].present) ePresent++;
  });

  const totalSlots = mTotal + eTotal;
  const presentSlots = mPresent + ePresent;
  document.getElementById('stat-today-attendance').innerText = `${totalSlots > 0 ? Math.round((presentSlots / totalSlots) * 100) : 0}%`;
  document.getElementById('morning-shift-stats').innerText = `${mPresent}/${mTotal} उपस्थित`;
  document.getElementById('morning-shift-progress').style.width = `${mTotal > 0 ? Math.round((mPresent / mTotal) * 100) : 0}%`;
  document.getElementById('evening-shift-stats').innerText = `${ePresent}/${eTotal} उपस्थित`;
  document.getElementById('evening-shift-progress').style.width = `${eTotal > 0 ? Math.round((ePresent / eTotal) * 100) : 0}%`;

  const recentContainer = document.getElementById('recent-wrestlers-list');
  recentContainer.innerHTML = '';

  if (activeWrestlers.length === 0) {
    recentContainer.innerHTML = `<p class="text-xs text-gray-400 text-center py-4 bg-white dark:bg-gray-800 rounded-2xl border border-clay-50 dark:border-gray-700 border-dashed">अद्याप कोणतेही मल्ल जोडलेले नाहीत.</p>`;
  } else {
    [...activeWrestlers].reverse().slice(0, 3).forEach(w => {
      recentContainer.innerHTML += `
        <div class="bg-white dark:bg-gray-800 p-3 rounded-xl border border-clay-100 dark:border-gray-700 shadow-sm flex justify-between items-center" onclick="switchTab('wrestlers')">
          <div>
            <p class="text-sm font-bold text-gray-800 dark:text-gray-100">${w.name}</p>
            <p class="text-[10px] text-gray-500 dark:text-gray-400 font-semibold">वय: ${w.age} वर्ष | गट: ${w.weightClass}</p>
          </div>
          <span class="material-icons text-clay-700 dark:text-yellow-500 text-lg">arrow_forward_ios</span>
        </div>`;
    });
  }

  renderPracticeTimeOnDashboard(DB.getSettings().practiceTime);
}

// ================================================================
// PASSCODE LOCK SCREEN (V2: Persistent Auth via localStorage)
// ================================================================
let enteredPin = '';

function pressPinKey(digit) {
  if (enteredPin.length >= 4) return;
  enteredPin += digit;
  updatePinIndicators();
  if (enteredPin.length === 4) validatePin();
}

function clearPinKey() { enteredPin = ''; updatePinIndicators(); }

function backspacePinKey() { enteredPin = enteredPin.slice(0, -1); updatePinIndicators(); }

function updatePinIndicators() {
  for (let i = 1; i <= 4; i++) {
    const dot = document.getElementById(`pin-dot-${i}`);
    if (dot) {
      dot.classList.toggle('bg-yellow-500', enteredPin.length >= i);
      dot.classList.toggle('bg-transparent', enteredPin.length < i);
    }
  }
  const errorMsg = document.getElementById('pin-error-msg');
  if (errorMsg) errorMsg.classList.add('opacity-0');
}

function validatePin() {
  if (enteredPin === '3232') {
    DB.setAuthenticated(); // ← localStorage (persistent across sessions)
    const lockScreen = document.getElementById('lock-screen');
    if (lockScreen) {
      lockScreen.classList.add('opacity-0', 'pointer-events-none');
      setTimeout(() => { lockScreen.style.display = 'none'; }, 500);
    }
  } else {
    enteredPin = '';
    updatePinIndicators();
    const errorMsg = document.getElementById('pin-error-msg');
    if (errorMsg) errorMsg.classList.remove('opacity-0');
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  }
}
