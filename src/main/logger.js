// SPDX-License-Identifier: GPL-3.0-or-later
// File logger - couchtube.log
//
// Location strategy (first WRITABLE wins):
//   1. Portable exe folder (electron-builder portable sets PORTABLE_EXECUTABLE_DIR)
//   2. Packaged: the folder containing the .exe
//   3. Dev (npm start): the project root
//   4. Fallback: Electron userData (always writable; covers the
//      installed-under-Program-Files case where the exe folder is read-only)
//
// Rotates at ~1 MB (keeps one .old file).

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Rotation budget depends on mode. Normal runs stay tidy (routine chatter is at
// DEBUG and dropped, so 1 MB + 1 backup is plenty). Debug runs need room to hold
// a whole reproduction, so the per-file cap and backup count both grow. Rotated
// files are numbered couchtube.log.1 (newest) .. .N (oldest).
const MB = 1024 * 1024;
function limits() {
  return debugEnabled
    ? { maxBytes: 5 * MB, keep: 4 }   // ~25 MB across 5 files while debugging
    : { maxBytes: 1 * MB, keep: 1 };  // ~2 MB across 2 files normally
}

function isWritable(dir) {
  try {
    const probe = path.join(dir, '.couchtube-write-test');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

let cachedDir = null;

function logDir() {
  if (cachedDir) return cachedDir;

  const candidates = [
    process.env.PORTABLE_EXECUTABLE_DIR,                 // portable build
    app.isPackaged ? path.dirname(app.getPath('exe')) : null, // installed/unpacked build
    !app.isPackaged ? app.getAppPath() : null            // dev: project root
  ].filter(Boolean);

  for (const dir of candidates) {
    if (isWritable(dir)) { cachedDir = dir; return cachedDir; }
  }

  cachedDir = app.getPath('userData'); // e.g. exe folder is read-only (Program Files)
  return cachedDir;
}

function logPath() {
  return path.join(logDir(), 'couchtube.log');
}

function rotateIfNeeded() {
  try {
    const p = logPath();
    const { maxBytes, keep } = limits();
    if (!fs.existsSync(p) || fs.statSync(p).size <= maxBytes) return;
    // Drop the oldest, shift the rest down (.N-1 -> .N ... .1 -> .2), then the
    // live file becomes .1.
    try { fs.unlinkSync(p + '.' + keep); } catch {}
    for (let i = keep - 1; i >= 1; i--) {
      try { fs.renameSync(p + '.' + i, p + '.' + (i + 1)); } catch {}
    }
    try { fs.renameSync(p, p + '.1'); } catch {}
    // Prune stragglers left over from a previous (larger) debug budget, plus the
    // legacy single ".old" backup from before numbered rotation.
    for (let i = keep + 1; i <= keep + 8; i++) { try { fs.unlinkSync(p + '.' + i); } catch {} }
    try { fs.unlinkSync(p + '.old'); } catch {}
  } catch {}
}

// Local timestamp (was toISOString(), which is UTC and read ~hours off local
// time). Same sortable YYYY-MM-DDTHH:MM:SS.mmm shape, no trailing Z now that
// it's local.
function localStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    + '.' + p(d.getMilliseconds(), 3);
}

// Debug gate. DEBUG-level lines are dropped unless debug mode is on (toggled in
// Settings > About, or the COUCHTUBE_DEBUG env var). Kept cheap so debug() calls
// scattered in hot paths cost nothing when off.
let debugEnabled = process.env.COUCHTUBE_DEBUG === '1';
function setDebug(on) { debugEnabled = !!on; }
function isDebug() { return debugEnabled; }

function log(level, ...args) {
  if (level === 'DEBUG' && !debugEnabled) return;
  const line = `[${localStamp()}] [${level}] ` + args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ') + '\n';

  try {
    rotateIfNeeded();
    fs.appendFileSync(logPath(), line);
  } catch {}

  // Mirror to console for dev runs.
  (level === 'ERROR' ? console.error : console.log)(line.trimEnd());
}

const info = (...a) => log('INFO', ...a);
const error = (...a) => log('ERROR', ...a);
const debug = (...a) => log('DEBUG', ...a);

module.exports = { log, info, error, debug, setDebug, isDebug, logPath, logDir };
