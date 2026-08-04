// SPDX-License-Identifier: GPL-3.0-or-later
// Debug mode - a single user-facing switch (Settings > About) that turns the app
// into "tell me everything" mode and lets the user hand us a clean bundle.
//
// When ON it: (a) un-gates DEBUG-level log lines (logger.setDebug), (b) enables
// the raw feed/player debug_*.json dumps (innertube.setDebugDumps), and (c) makes
// the renderer forward its console + uncaught errors to the log (renderer-side).
// The flag is GLOBAL (not per-account) and persisted to Data/debug_settings.json
// so it survives a restart. The CATHODE_DEBUG env var forces it on.
//
// exportBundle() gathers cathode.log (+ .old), the debug_*.json dumps and a
// system snapshot into a single zip the user can send us. Everything written into
// the bundle is run through redact() first so OAuth tokens, PO tokens and email
// addresses never leave the machine.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, shell } = require('electron');
const { execFile } = require('child_process');
const logger = require('./logger');

let ytRef = null;          // innertube module (setDebugDumps + account summary)
let snapshotProvider = null; // optional extra snapshot data injected by index.js

function setInnertube(yt) { ytRef = yt; }
function setSnapshotProvider(fn) { snapshotProvider = fn; }

function settingsFile() { return path.join(app.getPath('userData'), 'debug_settings.json'); }

let enabled = false;

function envForced() { return process.env.CATHODE_DEBUG === '1'; }

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    enabled = !!(j && j.enabled);
  } catch { enabled = false; }
  if (envForced()) enabled = true;
  return enabled;
}

function persist() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify({ enabled }, null, 2)); }
  catch (e) { logger.error('debug: could not persist flag:', e && e.message); }
}

function apply() {
  logger.setDebug(enabled);
  try { if (ytRef && ytRef.setDebugDumps) ytRef.setDebugDumps(enabled); } catch {}
}

function init() {
  load();
  apply();
  logger.info('[debug] mode', enabled ? 'ON' : 'off');
}

function isEnabled() { return enabled; }

function setEnabled(on) {
  enabled = !!on || envForced();
  persist();
  apply();
  logger.info('[debug] mode set to', enabled ? 'ON' : 'off');
  return enabled;
}

// ---- redaction ----
// Best-effort scrub of secrets from any text before it enters the shareable
// bundle. Not a security boundary (the raw log on disk is unredacted); it just
// keeps tokens / emails out of files the user sends us.
function redact(text) {
  if (text == null) return text;
  let s = String(text);
  // Emails.
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
  // JWT-shaped tokens (OAuth id/access tokens, some PO tokens).
  s = s.replace(/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '<jwt>');
  // Known secret-bearing keys followed by a value (JSON, query-string or header).
  s = s.replace(/("?(?:access_token|refresh_token|id_token|token|poToken|po_token|potoken|visitorData|authorization|cookie|sapisid|apisid|hsid|ssid)"?\s*[:=]\s*"?)([A-Za-z0-9._~+/=%-]{6,})/gi,
    (_m, k) => k + '<redacted>');
  // Bearer headers.
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer <redacted>');
  return s;
}

function safe(fn, dflt) { try { const v = fn(); return v === undefined ? dflt : v; } catch { return dflt; } }

function sanitizedSettings() {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'ui_settings.json'), 'utf8');
    const obj = JSON.parse(redact(raw));
    return obj;
  } catch { return null; }
}

async function systemSnapshot() {
  const snap = {
    generatedAt: new Date().toISOString(),
    app: {
      name: 'Cathode',
      version: safe(() => app.getVersion(), '?'),
      packaged: safe(() => app.isPackaged, null),
      debugMode: enabled,
      logPath: safe(() => logger.logPath(), null),
      userData: safe(() => app.getPath('userData'), null)
    },
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8
    },
    os: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      version: safe(() => os.version(), null),
      totalMemMB: Math.round(os.totalmem() / 1048576),
      freeMemMB: Math.round(os.freemem() / 1048576),
      cpuCount: safe(() => os.cpus().length, null),
      cpuModel: safe(() => (os.cpus()[0] || {}).model, null),
      uptimeSec: Math.round(os.uptime())
    },
    locale: safe(() => app.getLocale(), null),
    gpu: safe(() => app.getGPUFeatureStatus(), null),
    settings: sanitizedSettings()
  };
  try { if (snapshotProvider) snap.accounts = await snapshotProvider(); }
  catch (e) { snap.accounts = { error: String(e && e.message) }; }
  return snap;
}

// YYYYMMDD-HHMMSS local time (mirrors backup.js).
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function copyRedacted(srcPath, dstPath) {
  try {
    if (!fs.existsSync(srcPath)) return false;
    fs.writeFileSync(dstPath, redact(fs.readFileSync(srcPath, 'utf8')));
    return true;
  } catch (e) { logger.error('debug: copy failed', srcPath, e && e.message); return false; }
}

function zipDir(srcDir, zipPath) {
  return new Promise((resolve, reject) => {
    // Windows PowerShell Compress-Archive - no extra dependency. The bundle is
    // tiny (a couple of MB at most), so the one-shot API is fine here.
    const ps = `Compress-Archive -Path '${srcDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true }, (err, _out, stderr) => {
        if (err) return reject(new Error('Compress-Archive failed: ' + (stderr || err.message)));
        resolve();
      });
  });
}

async function exportBundle() {
  const stagingRoot = path.join(app.getPath('userData'), 'debug_export_tmp');
  try {
    // Fresh staging dir.
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(stagingRoot, { recursive: true });

    // 1) The live log + every rotated backup (cathode.log.1..N, legacy .old),
    // each redacted.
    const lp = logger.logPath();
    const logBase = path.basename(lp);
    const logDir = logger.logDir();
    try {
      for (const f of fs.readdirSync(logDir)) {
        if (f === logBase || f.startsWith(logBase + '.')) {
          copyRedacted(path.join(logDir, f), path.join(stagingRoot, f));
        }
      }
    } catch { copyRedacted(lp, path.join(stagingRoot, logBase)); }

    // 2) Raw diagnostic dumps (debug_*.json), redacted.
    const dd = app.getPath('userData');
    let dumpCount = 0;
    try {
      for (const f of fs.readdirSync(dd)) {
        if (/^debug_.*\.json$/i.test(f)) {
          if (copyRedacted(path.join(dd, f), path.join(stagingRoot, f))) dumpCount++;
        }
      }
    } catch {}

    // 3) System snapshot (already sanitized).
    const snap = await systemSnapshot();
    fs.writeFileSync(path.join(stagingRoot, 'system-snapshot.json'), redact(JSON.stringify(snap, null, 2)));

    // 4) Zip it up next to the app data.
    const name = `cathode-debug-${stamp()}.zip`;
    const zipPath = path.join(app.getPath('userData'), name);
    try { fs.unlinkSync(zipPath); } catch {}
    await zipDir(stagingRoot, zipPath);
    if (!fs.existsSync(zipPath)) throw new Error('archive was not created');

    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch {}
    logger.info('[debug] exported bundle', name, '(dumps:', dumpCount + ')');
    try { shell.showItemInFolder(zipPath); } catch {}
    return { ok: true, path: zipPath, name };
  } catch (e) {
    logger.error('debug: exportBundle failed:', e && e.message);
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch {}
    return { ok: false, error: e && e.message };
  }
}

module.exports = {
  init, isEnabled, setEnabled, systemSnapshot, exportBundle,
  redact, setInnertube, setSnapshotProvider
};
