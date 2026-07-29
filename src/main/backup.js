// SPDX-License-Identifier: GPL-3.0-or-later
// Local Backup & Restore (Windows). Zips the portable Data folder into a sibling
// 'CouchTube-Backups' folder using PowerShell's Compress-Archive, and restores
// via Expand-Archive. No npm dependencies - Node built-ins + PowerShell 5.1
// (ships with Windows 10). Backups live OUTSIDE the Data dir so a backup never
// contains previous backups.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

// Reuse the app logger when present; fall back to console.
let logger = null;
try { logger = require('./logger'); } catch { logger = null; }
function log(...a) { if (logger && logger.info) logger.info(...a); else console.log('[backup]', ...a); }
function logErr(...a) { if (logger && logger.error) logger.error(...a); else console.error('[backup]', ...a); }

// The portable Data dir (index.js redirects userData here at boot).
function dataDir() { return app.getPath('userData'); }

// Backups sit next to Data, not inside it.
function backupsDir() {
  const d = path.join(path.dirname(dataDir()), 'CouchTube-Backups');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { logErr('mkdir backupsDir failed:', e.message); }
  return d;
}

function configPath() { return path.join(backupsDir(), 'backup-config.json'); }

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return { cadence: c.cadence || 'off', lastAuto: Number(c.lastAuto) || 0 };
  } catch { return { cadence: 'off', lastAuto: 0 }; }
}

function writeConfig(c) {
  try { fs.writeFileSync(configPath(), JSON.stringify(c)); }
  catch (e) { logErr('writeConfig failed:', e.message); }
}

// PowerShell single-quoted literal (safe for spaces; escape embedded quotes).
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

// Run a PowerShell command; resolve on exit 0, reject otherwise.
function runPs(command) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { err.message += stderr ? (' | ' + String(stderr).trim()) : ''; reject(err); }
        else resolve({ stdout, stderr });
      }
    );
  });
}

// Streaming zip via .NET ZipArchive. Compress-Archive (PS 5.1) buffers whole
// files in memory and silently fails / OOMs on large folders (300MB+) -- it can
// even exit 0 without producing a zip. This script streams each file straight
// into the archive (low memory, no practical size limit). It backs up ONLY our
// own data via an allowlist (accounts/, yt_accounts*.json, snapshot_*.json, and
// 'Local State') so the Chromium engine caches (Cache/ alone can be 300MB+, plus
// GPUCache, Code Cache, Network, etc.) are never included; also skips
// debug_*.json. NOTE: 'Local State' is ESSENTIAL -- Electron safeStorage on
// Windows is Chromium OSCrypt ("v10" blobs), and the AES master key lives
// DPAPI-wrapped in Local State (os_crypt.encrypted_key). Without it a restored
// yt_accounts.json can't be decrypted (new install = new key) and the user is
// wrongly asked to re-login -- even on the same machine. Same machine/user =
// the key unwraps and login survives; other machine = DPAPI can't unwrap it, so
// decrypt fails and the sidecar recovery flags re-login (the intended behavior).
// Forces
// $ErrorActionPreference='Stop' so any failure is a non-zero exit (not a silent
// success), and writes progress lines to stdout
// (TOTAL <n> / PROG <i> / DONE) which the Node side parses for the progress bar.
// Paths come in as -Src / -Dst ARGS (never interpolated into the script text).
const PS_BACKUP_SCRIPT = `param([Parameter(Mandatory=$true)][string]$Src,[Parameter(Mandatory=$true)][string]$Dst)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
$base=(Resolve-Path -LiteralPath $Src).Path.TrimEnd('\\','/')
$keepDirs=@('accounts')
$keepFiles=@('yt_accounts.json','yt_accounts_index.json','Local State')
$files=New-Object System.Collections.ArrayList
foreach ($d in $keepDirs) {
  $p=Join-Path $base $d
  if (Test-Path -LiteralPath $p) { Get-ChildItem -LiteralPath $p -Recurse -File | Where-Object { $_.Name -notlike 'debug_*.json' } | ForEach-Object { [void]$files.Add($_) } }
}
foreach ($kf in $keepFiles) {
  $p=Join-Path $base $kf
  if (Test-Path -LiteralPath $p) { [void]$files.Add((Get-Item -LiteralPath $p)) }
}
Get-ChildItem -LiteralPath $base -File -Filter 'snapshot_*.json' -ErrorAction SilentlyContinue | ForEach-Object { [void]$files.Add($_) }
$total=$files.Count
Write-Output "TOTAL $total"
if (Test-Path -LiteralPath $Dst) { Remove-Item -LiteralPath $Dst -Force }
$zip=[System.IO.Compression.ZipFile]::Open($Dst,[System.IO.Compression.ZipArchiveMode]::Create)
try {
  $i=0
  foreach ($f in $files) {
    $rel=$f.FullName.Substring($base.Length).TrimStart('\\','/').Replace('\\','/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$f.FullName,$rel,[System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $i++
    if (($i % 5) -eq 0 -or $i -eq $total) { Write-Output "PROG $i" }
  }
} finally { $zip.Dispose() }
Write-Output "DONE"`;

// Run the streaming backup script, forwarding progress to onProgress({phase,
// done, total}). Resolves on exit 0; rejects with captured stderr otherwise.
function runBackupScript(src, dst, onProgress) {
  return new Promise((resolve, reject) => {
    let scriptPath;
    try {
      scriptPath = path.join(os.tmpdir(), 'couchtube-backup.ps1');
      fs.writeFileSync(scriptPath, PS_BACKUP_SCRIPT, 'utf8');
    } catch (e) { return reject(new Error('could not write backup script: ' + e.message)); }
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Src', src, '-Dst', dst], { windowsHide: true });
    let total = 0, errText = '', buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        if (line.indexOf('TOTAL ') === 0) { total = parseInt(line.slice(6), 10) || 0; log('backup:', total, 'files to archive'); if (onProgress) onProgress({ phase: 'start', done: 0, total }); }
        else if (line.indexOf('PROG ') === 0) { const done = parseInt(line.slice(5), 10) || 0; if (onProgress) onProgress({ phase: 'progress', done, total }); }
        else if (line === 'DONE') { if (onProgress) onProgress({ phase: 'done', done: total, total }); }
      }
    });
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, total });
      else reject(new Error('PowerShell exited ' + code + (errText ? ' | ' + errText.trim() : '')));
    });
  });
}

// YYYYMMDD-HHMMSS in local time.
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Zip the CONTENTS of the Data dir (not the folder itself) into a timestamped
// zip via the streaming ZipArchive script (see runBackupScript). onProgress is
// optional and receives { phase, done, total } as the archive is built.
async function createBackup(auto = false, onProgress = null) {
  try {
    const dir = dataDir();
    const out = backupsDir();
    const name = `couchtube-backup-${stamp()}${auto ? '-auto' : ''}.zip`;
    const zipPath = path.join(out, name);
    log('backup start ->', name);
    await runBackupScript(dir, zipPath, onProgress);
    if (!fs.existsSync(zipPath)) throw new Error('archive was not created');
    const mb = (fs.statSync(zipPath).size / 1048576).toFixed(1);
    log('created backup', name, '(' + mb + ' MB)');
    return { ok: true, path: zipPath, name };
  } catch (e) {
    logErr('createBackup failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Every *.zip in the backups dir, newest first.
function listBackups() {
  const out = backupsDir();
  let names = [];
  try { names = fs.readdirSync(out); } catch { return []; }
  const res = [];
  for (const f of names) {
    if (!/\.zip$/i.test(f)) continue;
    const full = path.join(out, f);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      res.push({ name: f, path: full, size: st.size, mtime: st.mtimeMs, auto: /-auto\.zip$/i.test(f) });
    } catch { /* skip unreadable entries */ }
  }
  res.sort((a, b) => b.mtime - a.mtime);
  return res;
}

// Restore is done in TWO phases so we NEVER mutate the live Data dir. Chromium
// and our caches hold Data open while the app runs, so renaming/replacing it
// mid-run fails with EPERM and leaves a half-written yt_accounts.json that won't
// decrypt on next boot -> the account falls through to sidecar recovery and the
// user is wrongly asked to sign in again (the s84 restore bug). Instead:
//   Phase 1 stageRestore()      -- validate + extract the zip to a staging dir
//                                  OUTSIDE Data; the IPC layer then relaunches.
//   Phase 2 applyPendingRestore -- on the NEXT launch, BEFORE the app opens the
//                                  profile, swap staging in as the new Data.
const stagingDir = () => path.join(backupsDir(), '.restore-staging');

// Phase 1: extract + validate into the staging dir. Does NOT touch Data.
async function stageRestore(zipPath) {
  try {
    if (!zipPath || !fs.existsSync(zipPath)) return { ok: false, error: 'Backup file not found' };
    if (!/\.zip$/i.test(String(zipPath))) return { ok: false, error: 'Not a .zip file' };
    const staging = stagingDir();
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* nothing to clear */ }
    // ExtractToDirectory (memory-light; creates the dir) with Stop so failures surface.
    await runPs(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null; [System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(zipPath)}, ${psQuote(staging)})`);
    let top = [];
    try { top = fs.readdirSync(staging); } catch { top = []; }
    const looksOurs =
      top.includes('accounts') ||
      top.includes('yt_accounts.json') ||
      top.some((n) => /\.json$/i.test(n));
    if (!looksOurs) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, error: 'Not a CouchTube backup' };
    }
    log('restore staged from', path.basename(String(zipPath)), '-- applies on relaunch');
    return { ok: true };
  } catch (e) {
    logErr('stageRestore failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Phase 2: run ONCE at boot, before anything opens the Data dir. If a staging
// dir is present, move the current Data aside (now unlocked -- the app is not
// ready and the previous instance has exited) and swap staging in as Data.
// Synchronous + best-effort; a no-op when nothing is staged. Returns true if a
// restore was applied.
function applyPendingRestore() {
  const staging = stagingDir();
  let has = false;
  try { has = fs.existsSync(staging) && fs.readdirSync(staging).length > 0; } catch { has = false; }
  if (!has) return false;
  const dir = dataDir();
  try {
    if (fs.existsSync(dir)) {
      const old = dir + '.old-' + Date.now();
      try {
        fs.renameSync(dir, old); // unlocked at process start -> should succeed
      } catch (e) {
        logErr('restore: could not move Data aside, clearing in place:', e.message);
        try { for (const n of fs.readdirSync(dir)) { try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch { /* locked: skip */ } } } catch { /* ignore */ }
      }
    }
    if (!fs.existsSync(dir)) {
      try { fs.renameSync(staging, dir); log('restore applied at boot (staging -> Data)'); return true; }
      catch (e) { logErr('restore: rename staging->Data failed, copying:', e.message); fs.mkdirSync(dir, { recursive: true }); }
    }
    // Fallback: Data still present (rename-aside blocked) -> move items in.
    for (const n of fs.readdirSync(staging)) {
      const src = path.join(staging, n), dst = path.join(dir, n);
      try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* may not exist */ }
      try { fs.renameSync(src, dst); }
      catch { try { fs.cpSync(src, dst, { recursive: true, force: true }); } catch (e) { logErr('restore apply copy failed for', n, e.message); } }
    }
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    log('restore applied at boot (merged staging into Data)');
    return true;
  } catch (e) {
    logErr('applyPendingRestore failed:', e.message);
    return false;
  }
}

// Keep only the newest `keep` auto backups; delete the rest.
function pruneAuto(keep = 5) {
  try {
    const autos = listBackups().filter((b) => b.auto); // newest first
    for (const b of autos.slice(keep)) {
      try { fs.unlinkSync(b.path); log('pruned auto backup', b.name); }
      catch (e) { logErr('prune failed for', b.name, e.message); }
    }
  } catch (e) { logErr('pruneAuto failed:', e.message); }
}

const CADENCE_MS = { daily: 86400000, weekly: 7 * 86400000, monthly: 30 * 86400000 };
let schedulerTimer = null;
let schedulerRunning = false;

async function checkAndRun() {
  if (schedulerRunning) return; // guard against overlap
  const cfg = readConfig();
  if (cfg.cadence === 'off') return;
  const interval = CADENCE_MS[cfg.cadence];
  if (!interval) return;
  if (Date.now() - (cfg.lastAuto || 0) < interval) return;
  schedulerRunning = true;
  try {
    const r = await createBackup(true);
    if (r.ok) {
      pruneAuto();
      const c = readConfig();
      c.lastAuto = Date.now();
      writeConfig(c);
    }
  } catch (e) {
    logErr('scheduled backup failed:', e.message);
  } finally {
    schedulerRunning = false;
  }
}

function initScheduler() {
  checkAndRun();
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(checkAndRun, 6 * 60 * 60 * 1000); // re-check every 6h
}

function getCadence() { return readConfig().cadence; }

function setCadence(v) {
  const allowed = ['off', 'daily', 'weekly', 'monthly'];
  const cad = allowed.includes(v) ? v : 'off';
  const c = readConfig();
  c.cadence = cad;
  writeConfig(c);
  return cad;
}

module.exports = {
  readConfig,
  writeConfig,
  createBackup,
  listBackups,
  stageRestore,
  applyPendingRestore,
  pruneAuto,
  initScheduler,
  getCadence,
  setCadence
};
