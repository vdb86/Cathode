// SPDX-License-Identifier: GPL-3.0-or-later
// Global (machine-level, account-INDEPENDENT) system preferences: run-in-tray +
// launch-on-startup. Stored at Data/system_settings.json (userData root), NOT in
// a per-account folder -- these describe how the app PROCESS behaves on this
// machine, not which YouTube account is active, so they must survive an account
// switch and apply before any account is even selected.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DEFAULTS = { exitToTray: false, launchOnStartup: false, startMinimized: false, companionEnabled: false, companionPort: 8878, companionName: '' };
let prefs = null;

function file() { return path.join(app.getPath('userData'), 'system_settings.json'); }

function load() {
  if (prefs) return prefs;
  try { prefs = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(file(), 'utf8'))); }
  catch { prefs = Object.assign({}, DEFAULTS); }
  return prefs;
}

function save() {
  try { fs.writeFileSync(file(), JSON.stringify(prefs)); }
  catch (e) { logger.error('system_settings write failed:', e && e.message); }
}

// Reflect launchOnStartup into the OS login-item registration. openAtLogin
// registers the CURRENT exe (electron.exe in dev, the packaged exe in a build),
// so this is correct in both without extra path handling.
function applyLoginItem() {
  try {
    const p = load();
    // When "start minimized" is on, register the login item with a --hidden flag
    // the app detects at boot to open hidden in the tray. It is only carried on a
    // login launch, so a manual double-click (no flag) always opens on screen.
    app.setLoginItemSettings({
      openAtLogin: !!p.launchOnStartup,
      args: (p.launchOnStartup && p.startMinimized) ? ['--hidden'] : []
    });
  }
  catch (e) { logger.error('setLoginItemSettings failed:', e && e.message); }
}

function get() { return Object.assign({}, load()); }

function set(patch) {
  load();
  Object.assign(prefs, patch || {});
  save();
  if (patch && ('launchOnStartup' in patch || 'startMinimized' in patch)) applyLoginItem();
  return get();
}

// Called once at boot: make the OS login-item match the stored pref (covers a
// pref changed while the app was closed, and re-asserts it after an update).
function init() { load(); applyLoginItem(); }

module.exports = { init, get, set, exitToTray: () => !!load().exitToTray };
